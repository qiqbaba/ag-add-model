/**
 * OpenAI/Ollama provider translator.
 * Handles Gemini ↔ OpenAI/Ollama request/response mapping and streaming chunks.
 */
import * as path from 'path';
import * as fs from 'fs';

import log from 'electron-log';
import {
  fixParamTypes,
  translateToolCallToNative,
  formatTranslatedResponse,
  normalizeToolArgs,
  ToolCallArgs,
} from './utils';
import {
  modelToolCallIds,
  modelReasoningContent,
  activeStreamContexts,
  translatedToolCalls,
  modelToolNames,
  modelToolSchemas,
  stateTimestamps,
  touchStateTimestamp,
  stateKey,
  generateSyntheticCallId,
} from '../shared';
// 坑 25：prompt-based 工具调用交付层——LS 对自定义模型只解析响应文本中的
// <tool_name>{json}</tool_name> 块（详见 prompt-xml.ts 头注）。
import { serializeToolCallsAsPromptXml } from './prompt-xml';

// ─── Types ────────────────────────────────────────────────────────────────

interface GeminiTool {
  functionDeclarations?: GeminiFunctionDeclaration[];
}

interface GeminiFunctionDeclaration {
  name: string;
  description?: string;
  parameters?: GeminiParameters;
}

interface GeminiParameters {
  type: string;
  properties?: Record<string, unknown>;
}

interface OpenAITool {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

interface GeminiContent {
  role?: string;
  parts?: GeminiPart[];
}

interface GeminiPart {
  text?: string;
  thought?: boolean;
  thoughtSignature?: string;
  functionCall?: GeminiFunctionCall;
  functionResponse?: GeminiFunctionResponse;
  fileData?: { mimeType: string; fileUri: string };
  inlineData?: { mimeType: string; data: string };
}

interface GeminiFunctionCall {
  name: string;
  args: Record<string, unknown>;
  id?: string;
}

interface GeminiFunctionResponse {
  name: string;
  response: unknown;
  id?: string;
}

interface GeminiRequestBody {
  systemInstruction?: { parts: GeminiPart[] };
  contents?: GeminiContent[];
  tools?: GeminiTool[];
  generationConfig?: {
    temperature?: number;
    maxOutputTokens?: number;
  };
}

interface OpenAIContentPart {
  type: 'text';
  text: string;
}
interface OpenAIImageContentPart {
  type: 'image_url';
  image_url: { url: string };
}
type OpenAIUserContentPart = OpenAIContentPart | OpenAIImageContentPart;

interface OpenAIMessage {
  role: string;
  content: string | OpenAIUserContentPart[] | null;
  tool_calls?: OpenAIToolCall[];
  tool_call_id?: string;
  reasoning_content?: string;
}

interface OpenAIToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

interface OpenAIRequestBody {
  model: string;
  messages: OpenAIMessage[];
  temperature?: number;
  max_tokens?: number;
  max_completion_tokens?: number;
  tools?: OpenAITool[];
  tool_choice?: string;
  stream?: boolean;
}

interface OpenAIResponse {
  choices?: OpenAIChoice[];
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

interface OpenAIChoice {
  message?: {
    content: string;
    reasoning_content?: string;
    reasoning?: string;
    tool_calls?: OpenAIToolCall[];
  };
  finish_reason?: string;
  delta?: {
    content?: string;
    reasoning_content?: string;
    reasoning?: string;
    tool_calls?: OpenAIToolCallDelta[];
  };
}

interface OpenAIToolCallDelta {
  index?: number;
  id?: string;
  function?: {
    name?: string;
    arguments?: string;
  };
}

interface GeminiGenerateContentResponse {
  candidates: GeminiCandidate[];
  usageMetadata?: GeminiUsageMetadata;
}

interface GeminiCandidate {
  content: {
    parts: GeminiPart[];
    role: string;
  };
  finishReason: string;
  index: number;
}

interface GeminiUsageMetadata {
  promptTokenCount: number;
  candidatesTokenCount: number;
  totalTokenCount: number;
}

interface DSMLParsedResult {
  functionCalls: { name: string; args: Record<string, unknown> }[];
  cleanText: string;
}

/**
 * 坑 17：上游（商汤 V4 Flash 等）会随机把 DSML 标记的竖线输出为全角 ｜（U+FF5C），
 * 形如 `<｜DSML｜tool name="view_file">`。现有解析器只认 ASCII `|`，导致整段
 * 标记泄漏为正文、工具调用全部丢失（"提前结束"的又一根因）。
 * 在文本进入解析/holdback 链路前统一归一化。模式要求 `<｜DSML｜` / `</｜DSML｜`
 * 连续序列，正文误含概率几乎为零。
 */
function normalizeDSMLPipes(text: string): string {
  return text.replace(/<｜DSML｜/g, '<DSML|').replace(/<\/｜DSML｜/g, '</DSML|');
}

/**
 * Markers that indicate a tool call block has started in text.
 */
const TOOL_CALL_START_MARKERS = [
  '<DSML|',
  '<tool_call',
  '<function_call',
  '<tool>',
  '<tool ',
  '<action>',
  '<action ',
  '<call:',
  '```tool_call',
  '```function_call',
];

/**
 * Returns true when `text` contains a tool-call marker that has been opened
 * but not yet closed (e.g. `<DSML|...>`, `<tool_call>`, `<function_call>`).
 * Used to hold partial markup back so it never leaks as visible text while in flight.
 */
function hasUnclosedToolCallBlock(text: string): boolean {
  const dsmlOpens = (text.match(/<DSML\|/g) || []).length;
  const dsmlCloses = (text.match(/<\/DSML\|/g) || []).length;
  if (dsmlOpens > dsmlCloses) return true;

  // Symmetric <tool_call> / <function_call> opens vs closes.
  const symOpens = (text.match(/<(?:tool_call|function_call)[>\s]/g) || []).length;
  const symCloses = (text.match(/<\/(?:tool_call|function_call)>/g) || []).length;
  if (symOpens > symCloses) return true;

  // Asymmetric colon form <tool_call:name> ... </name> / </tool_call:name>.
  // The symmetric count above deliberately ignores the colon form (':' is not in
  // [>\s]), so pair each colon-open with a matching named close here. An
  // outstanding colon-open means the block is still open. Without this pairing,
  // a properly-closed <tool_call:name>...</name> would read as opens>closes and
  // hold the stream forever.
  const colonOpenRegex = /<(?:tool_call|function_call):([A-Za-z_]\w*)[>\s]/g;
  let cm: RegExpExecArray | null;
  let colonOpen = 0;
  while ((cm = colonOpenRegex.exec(text)) !== null) {
    const name = cm[1];
    const namedClose = new RegExp(`</(?:${name}|tool_call:${name}|function_call:${name})>`);
    if (!namedClose.test(text)) colonOpen++;
  }
  if (colonOpen > 0) return true;

  // An opening "<call:" with no closing ">" yet (checked relative to the LAST
  // occurrence — the old !text.includes('>') condition was virtually never true).
  const callIdx = text.lastIndexOf('<call:');
  if (callIdx !== -1 && text.indexOf('>', callIdx) === -1) return true;
  if (text.includes('```tool_call') && (text.match(/```/g) || []).length % 2 !== 0) return true;

  return false;
}

/**
 * Returns true when `text` contains an unclosed bare lean tool tag
 * (e.g. `<run_command>` without its `</run_command>`) for any known tool name,
 * but only counting a bare tag that sits at a block boundary (start of text or
 * first non-whitespace on its own line) and outside a markdown code fence.
 * An inline `<view_file>` in prose is quoted text, not a tool-call start.
 */
function hasUnclosedBareToolBlock(text: string, toolNames: string[]): boolean {
  for (const name of toolNames) {
    const open = `<${name}>`;
    let boundaryOpens = 0;
    let idx = text.indexOf(open);
    while (idx !== -1) {
      if (isBlockBoundaryAndNotFenced(text, idx)) boundaryOpens++;
      idx = text.indexOf(open, idx + open.length);
    }
    if (boundaryOpens === 0) continue;
    let closes = 0;
    const close = `</${name}>`;
    idx = text.indexOf(close);
    while (idx !== -1) {
      closes++;
      idx = text.indexOf(close, idx + close.length);
    }
    if (boundaryOpens > closes) return true;
  }
  return false;
}

/**
 * Finds the earliest index in the current delta `text` at which a bare tool
 * open tag (`<name>`) sits at a block boundary and outside a code fence.
 * `combined` is the accumulated stream text (prevAcc + text); `prevLen` is the
 * length of prevAcc, so a bare tag position is expressed in `combined` coords.
 * Returns -1 when no boundary-gated bare open tag is present in this delta.
 */
function findEarliestBareMarkerIdx(combined: string, text: string, prevLen: number, toolNames: string[]): number {
  let earliest = -1;
  for (const name of toolNames) {
    const open = `<${name}>`;
    let idx = text.indexOf(open);
    while (idx !== -1) {
      if (isBlockBoundaryAndNotFenced(combined, prevLen + idx)) {
        if (earliest === -1 || idx < earliest) earliest = idx;
        break;
      }
      idx = text.indexOf(open, idx + open.length);
    }
  }
  return earliest;
}

/**
 * Whether withheld text begins with tool-call markup (a marker truncation
 * remainder or an in-flight block) rather than plain body text. Used at native
 * close branches: markup-led withheld text is an abandoned call block (the
 * native delta.tool_calls call supersedes it) and must not leak as visible
 * text; plain-led withheld text is body content that was only held back to
 * prevent mid-stream flicker and must be re-emitted with the closing frame.
 */
function withheldStartsWithMarkup(held: string): boolean {
  for (const marker of TOOL_CALL_START_MARKERS) {
    if (held.startsWith(marker)) return true;
  }
  return false;
}

/**
 * Salvage plain body text from a markup-led withheld buffer at a native close
 * branch. The buffer is an abandoned text-tag call block superseded by a native
 * delta.tool_calls call, so the call markup itself must never leak — but any
 * trailing plain text that followed the block is real body content and must not
 * be silently dropped. Strategy: if the buffer parses as (text-tag) tool call(s),
 * reuse the parser's cleanText (call blocks removed); otherwise strip any
 * remaining tag-like tokens. Returns '' when nothing worth emitting remains.
 */
function salvagePlainTextFromMarkupLedHeld(held: string, toolNames: string[], schemas: Record<string, string[]> | null): string {
  const parsed = parseDSMLToolCalls(held, true, toolNames, schemas);
  if (parsed && parsed.functionCalls.length > 0) {
    // Only trust the parser when every recovered call name is a known tool —
    // otherwise (e.g. it mistook {"name":"x"} for a call to tool "x") fall
    // through to tag-stripping so trailing body text is not eaten.
    const known = new Set(toolNames);
    if (parsed.functionCalls.every((fc) => known.has(fc.name))) {
      return parsed.cleanText.trim() ? parsed.cleanText : '';
    }
  }
  const stripped = held.replace(/<\/?[A-Za-z_][\w:.-]*(?:\|[^>]*)?>/g, '');
  return stripped.trim() ? stripped : '';
}

/**
 * A bare tool tag only counts as a tool-call start when it sits at a block
 * boundary (start of text or first non-whitespace on its own line) and outside
 * a markdown code fence. An inline `<view_file>` in prose is just text.
 */
function isBlockBoundaryAndNotFenced(text: string, idx: number): boolean {
  for (let i = idx - 1; i >= 0; i--) {
    const ch = text[i];
    if (ch === '\n') break;
    if (!/\s/.test(ch)) return false;
  }
  return (text.slice(0, idx).match(/```/g) || []).length % 2 === 0;
}

// ─── REQUEST: Gemini → OpenAI ──────────────────────────────────────────────

function mapGeminiToolsToOpenAI(geminiTools: GeminiTool[]): OpenAITool[] {
  if (!geminiTools || !Array.isArray(geminiTools)) return [];
  const openaiTools: OpenAITool[] = [];
  for (const toolGroup of geminiTools) {
    if (toolGroup.functionDeclarations && Array.isArray(toolGroup.functionDeclarations)) {
      for (const func of toolGroup.functionDeclarations) {
        const params = func.parameters
          ? (JSON.parse(JSON.stringify(func.parameters)) as Record<string, unknown>)
          : { type: 'object', properties: {} };
        if (params.type && typeof params.type === 'string') {
          (params as Record<string, string>).type = (params.type as string).toLowerCase();
        }
        if (params.properties) {
          fixParamTypes(params.properties as Record<string, unknown>);
        }
        openaiTools.push({
          type: 'function',
          function: {
            name: func.name,
            description: func.description || '',
            parameters: params,
          },
        });
      }
    }
  }
  return openaiTools;
}

export function mapGeminiToOpenAI(
  geminiBody: GeminiRequestBody,
  modelName: string,
  sessionId?: string,
): OpenAIRequestBody {
  const messages: OpenAIMessage[] = [];
  // Queue and index-aware tracking to resolve functionResponses even when multiple
  // tool calls of the same name are executed in parallel (e.g. 3 list_dir calls).
  const pendingCallsQueue: { id: string; name: string }[] = [];
  const allCallsById: Map<string, { name: string }> = new Map();
  const lastCallIdByName: Record<string, string> = {};
  const stateKeyStr = stateKey(modelName, sessionId);

  if (geminiBody.systemInstruction && geminiBody.systemInstruction.parts) {
    let systemText = geminiBody.systemInstruction.parts.map((p) => p.text || '').join('');
    if (systemText) {
      if (geminiBody.tools && geminiBody.tools.length > 0) {
        systemText +=
          '\n\n[Tool Calling Directive]: You have access to tools. When inspecting code, analyzing projects, listing directories, reading files, searching, or running commands, invoke the appropriate function directly rather than only explaining your intended plan in text.';
      }
      messages.push({ role: 'system', content: systemText });
    }
  }

  if (geminiBody.contents) {
    geminiBody.contents.forEach((item, itemIdx) => {
      if (item.parts) {
        const hasFunctionCall = item.parts.some((p) => p.functionCall);
        const hasFunctionResponse = item.parts.some((p) => p.functionResponse);

        if (hasFunctionCall && item.role === 'model') {
          const toolCalls: OpenAIToolCall[] = [];
          const textParts: string[] = [];
          let reasoning_content = '';
          item.parts.forEach((p, partIdx) => {
            if (p.functionCall) {
              const callId = p.functionCall.id || generateSyntheticCallId();
              if (p.functionCall.name) {
                lastCallIdByName[p.functionCall.name] = callId;
              }
              pendingCallsQueue.push({ id: callId, name: p.functionCall.name || '' });
              allCallsById.set(callId, { name: p.functionCall.name || '' });

              let originalName = p.functionCall.name;
              let originalArgs = p.functionCall.args;
              const translatedInfo = translatedToolCalls.get(callId);
              if (translatedInfo) {
                originalName = translatedInfo.originalName;
                originalArgs = { CommandLine: translatedInfo.cmd, Cwd: translatedInfo.cwd };
              }
              toolCalls.push({
                id: callId,
                type: 'function',
                function: {
                  name: originalName,
                  arguments: typeof originalArgs === 'string' ? originalArgs : JSON.stringify(originalArgs || {}),
                },
              });
            } else if (p.thought) {
              if (p.text) reasoning_content += p.text;
            } else if (p.text) {
              textParts.push(p.text);
            }
          });
          const content = textParts.length > 0 ? textParts.join('') : null;
          const msg: OpenAIMessage = { role: 'assistant', content, tool_calls: toolCalls };
          if (reasoning_content) msg.reasoning_content = reasoning_content;
          messages.push(msg);
        } else if (hasFunctionResponse) {
          // 坑 25：prompt-XML 模式下，上游模型从未发出过 tool_calls（它以文本
          // 标记表达调用），此时把 functionResponse 转为【文本】并入 user 消息
          // ——与 LS system prompt 的约定一致："After each tool use, the user
          // will respond with the result of that tool use"。仅当本次会话历史
          // 中确实存在上游原生 tool_calls（pendingCallsQueue 非空，即 model 轮
          // 已生成 tool 消息）时才走 tool role 通道。
          const useToolRole = pendingCallsQueue.length > 0;
          const frChunks: string[] = [];
          item.parts.forEach((p) => {
            if (!p.functionResponse) return;
            const funcName = p.functionResponse.name || '';
            const responseData = p.functionResponse.response;
            let contentStr = '';
            if (useToolRole) {
              const modelTCIds = modelToolCallIds.get(stateKeyStr) || {};
              let toolCallId: string | undefined = undefined;

              // 1. If explicit ID matches a known tool call in this conversation, use it
              if (p.functionResponse.id && allCallsById.has(p.functionResponse.id)) {
                toolCallId = p.functionResponse.id;
                const qIdx = pendingCallsQueue.findIndex((c) => c.id === toolCallId);
                if (qIdx >= 0) pendingCallsQueue.splice(qIdx, 1);
              }

              // 2. Look for the first matching tool call in pending queue by name
              if (!toolCallId && funcName) {
                const qIdx = pendingCallsQueue.findIndex((c) => c.name === funcName);
                if (qIdx >= 0) {
                  toolCallId = pendingCallsQueue[qIdx].id;
                  pendingCallsQueue.splice(qIdx, 1);
                }
              }

              // 3. FIFO fallback from pending queue
              if (!toolCallId && pendingCallsQueue.length > 0) {
                toolCallId = pendingCallsQueue.shift()!.id;
              }

              // 4. Fallback to explicit ID or recorded ID or deterministic ID
              if (!toolCallId) {
                toolCallId =
                  p.functionResponse.id ||
                  lastCallIdByName[funcName] ||
                  modelTCIds[funcName] ||
                  generateSyntheticCallId();
              }

              const translatedInfo = translatedToolCalls.get(toolCallId);
              if (translatedInfo) {
                contentStr = formatTranslatedResponse(translatedInfo, responseData);
              } else {
                contentStr = typeof responseData === 'string' ? responseData : JSON.stringify(responseData || {});
              }
              messages.push({ role: 'tool', content: contentStr, tool_call_id: toolCallId });
            } else {
              const translatedInfo = p.functionResponse.id ? translatedToolCalls.get(p.functionResponse.id) : undefined;
              let body =
                typeof responseData === 'string' ? responseData : JSON.stringify(responseData || {});
              if (translatedInfo) body = formatTranslatedResponse(translatedInfo, responseData);
              frChunks.push(`[Tool result for ${funcName}]\n${body}`);
            }
          });
          if (frChunks.length > 0) {
            messages.push({ role: 'user', content: frChunks.join('\n\n') });
          }
        } else {
          const role = item.role === 'model' ? 'assistant' : item.role || 'user';
          let content: string | OpenAIUserContentPart[] = '';
          let reasoning_content = '';
          if (role === 'assistant') {
            const regularParts = (item.parts || []).filter((p) => !p.thought);
            const thoughtParts = (item.parts || []).filter((p) => p.thought);
            content = regularParts.map((p) => p.text || '').join('');
            reasoning_content = thoughtParts.map((p) => p.text || '').join('');
            if (!content && reasoning_content) {
              content = reasoning_content;
            }
          } else {
            const parts = item.parts || [];
            const contentParts: OpenAIUserContentPart[] = [];
            const textParts: string[] = [];
            const hasImage = parts.some((p) => p.inlineData && p.inlineData.mimeType?.startsWith('image/'));
            for (const p of parts) {
              if (p.text) {
                textParts.push(p.text);
                if (hasImage) contentParts.push({ type: 'text', text: p.text });
              } else if (p.fileData) {
                const fd = p.fileData as { mimeType: string; fileUri: string };
                // Try to read local files directly
                let textContent: string;
                try {
                  const url = new URL(fd.fileUri);
                  if (url.protocol === 'file:') {
                    const fileContent = fs.readFileSync(
                      url.pathname.replace(/^\//, '').replace(/\//g, path.sep),
                      'utf-8',
                    );
                    textContent = `[File content from ${fd.fileUri}]:\n${fileContent}`;
                  } else {
                    textContent = `[File reference: ${fd.fileUri} (${fd.mimeType})]`;
                  }
                } catch {
                  textContent = `[File reference: ${fd.fileUri} (${fd.mimeType})]`;
                }
                textParts.push(textContent);
                if (hasImage) contentParts.push({ type: 'text', text: textContent });
              } else if (p.inlineData) {
                const id = p.inlineData as { mimeType: string; data: string };
                if (id.mimeType && id.mimeType.startsWith('image/')) {
                  contentParts.push({ type: 'image_url', image_url: { url: `data:${id.mimeType};base64,${id.data}` } });
                } else {
                  const textContent = `[Inline data: ${id.mimeType}, length: ${(id.data || '').length} chars]`;
                  textParts.push(textContent);
                  if (hasImage) contentParts.push({ type: 'text', text: textContent });
                }
              }
            }
            content = hasImage ? (contentParts as OpenAIUserContentPart[]) : textParts.join('\n');
          }
          const msg: OpenAIMessage = { role, content };
          if (reasoning_content) msg.reasoning_content = reasoning_content;
          messages.push(msg);
        }
      }
    });
  }

  // Inject reasoning_content into assistant messages missing it
  let lastAssistantIdx = -1;
  for (let i = 0; i < messages.length; i++) {
    if (messages[i].role === 'assistant') lastAssistantIdx = i;
  }
  for (let i = 0; i < messages.length; i++) {
    if (messages[i].role === 'assistant' && !(messages[i] as OpenAIMessage).reasoning_content) {
      const preservedReasoning = modelReasoningContent.get(stateKeyStr) || '';
      messages[i].reasoning_content = i === lastAssistantIdx && preservedReasoning ? preservedReasoning : '';
    }
  }

  // Models requiring max_completion_tokens instead of max_tokens:
  const lowerName = modelName.toLowerCase();
  const isThinkingModel = /thinking|reasoning|r1|glm|sensenova|deepseek/i.test(lowerName);
  const isReasoningModel = /(^|\/|^openai\/)(o1|o3|o4)(-|$|mini|pro)/i.test(lowerName);
  const is41Model = /(^|\/|^openai\/)(gpt-)?4\.1(-|mini|nano)/i.test(lowerName);
  const is5Pro = /(^|\/|^openai\/)(gpt-)?5\.5-pro/i.test(lowerName);
  const is5Thinking = /(^|\/|^openai\/)(gpt-)?5\.4/i.test(lowerName);
  const needsCompletionTokens = isThinkingModel || isReasoningModel || is41Model || is5Pro || is5Thinking;
  const needsNoTemperature = isReasoningModel || /(^|\/|^openai\/)(o1|o3|o4)/i.test(lowerName);

  const requestedMaxTokens = geminiBody.generationConfig?.maxOutputTokens;
  const maxTokens =
    requestedMaxTokens && requestedMaxTokens > 4096
      ? requestedMaxTokens
      : isThinkingModel || isReasoningModel || is5Thinking
      ? 16384
      : (requestedMaxTokens ?? 4000);

  const payload: OpenAIRequestBody = {
    model: modelName,
    messages,
    ...(needsNoTemperature ? {} : { temperature: geminiBody.generationConfig?.temperature ?? 0.7 }),
    ...(needsCompletionTokens ? { max_completion_tokens: maxTokens } : { max_tokens: maxTokens }),
  };

  if (geminiBody.tools && Array.isArray(geminiBody.tools)) {
    const openaiTools = mapGeminiToolsToOpenAI(geminiBody.tools);
    if (openaiTools.length > 0) {
      payload.tools = openaiTools;
      payload.tool_choice = 'auto';
      // Remember the declared tool names so the response parser can recognize
      // bare-tag text tool calls (<run_command>...</run_command>) for this session.
      modelToolNames.set(stateKeyStr, new Set(openaiTools.map((t) => t.function.name)));
      touchStateTimestamp(stateTimestamps.toolNames, stateKeyStr);
      // Also remember each tool's parameter names so bare-tag parsing can verify
      // extracted args against the schema — prose that merely MENTIONS a tool
      // tag (e.g. quoting `<view_file>` while explaining the IDE) must not be
      // misparsed into a bogus tool call that makes the IDE abort the turn.
      const schemaRecord: Record<string, string[]> = {};
      for (const t of openaiTools) {
        const props = t.function.parameters?.properties as Record<string, unknown> | undefined;
        schemaRecord[t.function.name] = props ? Object.keys(props) : [];
      }
      modelToolSchemas.set(stateKeyStr, schemaRecord);
      touchStateTimestamp(stateTimestamps.toolSchemas, stateKeyStr);
    }
  } else {
    // 坑 25（prompt-based 工具调用）：LS 对自定义模型不发 tools 字段——工具
    // 定义以 "<tool_name>:\n<tool_name>\n{\"$schema\":...}" 段落形式写在
    // systemInstruction 文本里（实测 dump：90KB system prompt）。从该文本提取
    // 工具名与参数键并注册，保证响应侧解析器（getLeanToolNames / 参数校验）
    // 在无 tools 请求时仍有完整名称表，裸标签/DSML 各 Pass 才能命中。
    const systemText = messages.find((m) => m.role === 'system')?.content;
    if (typeof systemText === 'string' && systemText) {
      const names = new Set<string>();
      const schemaRecord: Record<string, string[]> = {};
      const defRe = /^([a-z_][a-z0-9_]*):\n<\1>\n/gm;
      let m: RegExpExecArray | null;
      while ((m = defRe.exec(systemText)) !== null) {
        const nm = m[1];
        names.add(nm);
        // 提取定义块内的 JSON（从 "{\n{"$schema"" 起到闭合 "}"），取 properties 键
        const jsonStart = systemText.indexOf('{', m.index + m[0].length);
        if (jsonStart < 0) continue;
        // 平衡花括号（粗扫：schema JSON 内字符串不含未转义花括号的概率极高）
        let depth = 0;
        let end = -1;
        for (let i = jsonStart; i < systemText.length && i < jsonStart + 20000; i++) {
          if (systemText[i] === '{') depth++;
          else if (systemText[i] === '}') {
            depth--;
            if (depth === 0) {
              end = i;
              break;
            }
          }
        }
        if (end < 0) continue;
        try {
          const schema = JSON.parse(systemText.slice(jsonStart, end + 1)) as {
            properties?: Record<string, unknown>;
          };
          schemaRecord[nm] = schema.properties ? Object.keys(schema.properties) : [];
        } catch {
          schemaRecord[nm] = [];
        }
      }
      if (names.size > 0) {
        modelToolNames.set(stateKeyStr, names);
        touchStateTimestamp(stateTimestamps.toolNames, stateKeyStr);
        modelToolSchemas.set(stateKeyStr, schemaRecord);
        touchStateTimestamp(stateTimestamps.toolSchemas, stateKeyStr);
      }
    }
  }

  return payload;
}

// ─── RESPONSE: OpenAI → Gemini ─────────────────────────────────────────────

/**
 * Well-known Antigravity tool names used as a fallback for detecting bare-tag
 * text tool calls (`<run_command>...</run_command>`) when the declared tool
 * list for the session is unavailable. Names are distinctive snake_case, so
 * false positives in normal prose are extremely unlikely.
 */
const BUILTIN_LEAN_TOOL_NAMES = [
  'run_command',
  'view_file',
  'view_file_outline',
  'view_content_chunk',
  'list_dir',
  'grep_search',
  'find_by_name',
  'write_to_file',
  'replace_file_content',
  'multi_replace_file_content',
  'read_terminal',
  'command_status',
  'send_command_input',
  'browser_subagent',
  'web_search',
  'save_memory',
  'edit_file',
  'create_file',
];

/**
 * Returns the tool names usable for bare-tag text tool call detection.
 *
 * STRICT: when the session's declared tools are known, ONLY those names are
 * used — matching a name the IDE cannot execute would produce an invalid tool
 * call and abort the whole conversation. The built-in fallback list is used
 * exclusively when no declared tools were registered (e.g. proxy restarted
 * mid-session), where the previous behavior (no bare-tag parsing at all) is
 * worse than a best-effort attempt.
 */
function getLeanToolNames(stateKeyStr: string): string[] {
  const declared = modelToolNames.get(stateKeyStr);
  if (declared && declared.size > 0) return [...declared];
  return [...BUILTIN_LEAN_TOOL_NAMES];
}

/**
 * 返回 text 末尾与任一工具标签前缀（`<name>` / `</name>` / 标准标记，不含完整
 * 匹配）一致的最长尾部长度；无匹配返回 0。
 *
 * 用于块解析后仍悬在 cleanText 段尾的"半截标签"（上游把 `<run_command>` 跨
 * chunk 拆成 `<` + `run_command>` 发送）。这类尾巴必须移入 pendingHeldSuffix
 * 与下一帧重拼，否则会破坏后续裸标签的行首边界检测（坑 16）。
 */
function trailingPartialMarkerLen(text: string, toolNames: string[]): number {
  const markers = [
    ...TOOL_CALL_START_MARKERS,
    ...toolNames.map((n) => `<${n}>`),
    ...toolNames.map((n) => `</${n}>`),
  ];
  let hold = 0;
  for (const marker of markers) {
    const maxCheck = Math.min(marker.length - 1, text.length);
    for (let len = maxCheck; len > hold; len--) {
      if (text.endsWith(marker.slice(0, len))) {
        hold = len;
        break;
      }
    }
  }
  return hold;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Extracts the first JSON object found inside `body` (surrounding text tolerated, handles unescaped Windows paths). */
function extractJsonObject(body: string): Record<string, unknown> | null {
  const start = body.indexOf('{');
  if (start === -1) return null;
  const end = body.lastIndexOf('}');
  if (end <= start) return null;
  const slice = body.slice(start, end + 1);
  try {
    const value = JSON.parse(slice);
    return value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch (_e) {
    try {
      // Recovery branch: the raw slice failed JSON.parse, so unescaped Windows
      // paths (e.g. "\src\translators") are present. Because a real JSON escape
      // (`\t` -> tab, `\n` -> newline) would have PARSED fine, any backslash here
      // is a Windows path separator. Escape every remaining `\x` literally.
      const sanitized = slice.replace(/\\([^"\\])/g, '\\\\$1');
      const value = JSON.parse(sanitized);
      return value && typeof value === 'object' && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : null;
    } catch (e) {
      log.debug('[OpenAI] JSON param parse failed:', (e as Error).message);
      return null;
    }
  }
}

/** Extracts key-value pairs from concatenated or malformed JSON (e.g. key":"val"key2":"val2"}). */
function extractConcatenatedKeyValues(raw: string): Record<string, unknown> | null {
  const args: Record<string, unknown> = {};
  const kvRegex =
    /(?:["']?([a-zA-Z0-9_.]+)["']?\s*:\s*)("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|true|false|null|-?\d+(?:\.\d+)?|\[[\s\S]*?\]|\{[\s\S]*?\})/g;
  let match: RegExpExecArray | null;
  let matchCount = 0;
  while ((match = kvRegex.exec(raw)) !== null) {
    const key = match[1];
    const valStr = match[2];
    let val: unknown = valStr;
    if ((valStr.startsWith('"') && valStr.endsWith('"')) || (valStr.startsWith("'") && valStr.endsWith("'"))) {
      const inner = valStr.slice(1, -1);
      val = inner.replace(/\\"/g, '"').replace(/\\'/g, "'");
    } else if (valStr === 'true') {
      val = true;
    } else if (valStr === 'false') {
      val = false;
    } else if (valStr === 'null') {
      val = null;
    } else if (/^-?\d+(?:\.\d+)?$/.test(valStr)) {
      val = Number(valStr);
    } else {
      try {
        val = JSON.parse(valStr);
      } catch {
        val = valStr;
      }
    }
    args[key] = val;
    matchCount++;
  }
  return matchCount > 0 ? args : null;
}

function cleanToolName(rawName: string): string {
  let name = rawName.trim().replace(/^["'`]|["'`]$/g, '');
  name = name.replace(/^(?:default_api:|custom_api:|functions\.)/, '');
  name = name.replace(/^_+/, '');
  return name;
}

function splitToolNameAndArgs(body: string): { name: string; argsBlock: string } | null {
  // Case A: Separated by whitespace, newline, colon, or opening brace
  const cleanMatch = /^\s*(?:(?:default_api:|custom_api:)?([a-zA-Z0-9_-]+))(?:\s*[:\n\s]\s*|(?=\s*\{))([\s\S]*)$/.exec(
    body,
  );
  if (cleanMatch && cleanMatch[1]) {
    return { name: cleanMatch[1], argsBlock: cleanMatch[2] };
  }

  // Case B: Concatenated tool name directly followed by PascalCase / camelCase parameter name + quote-colon
  // e.g. "list_dirDirectoryPath":"..." or "view_fileAbsolutePath":"..."
  const concatMatch =
    /^\s*(?:(?:default_api:|custom_api:)?([a-zA-Z0-9_:-]+?))(?=[A-Z][a-zA-Z0-9_]*["']?\s*:)((?:[A-Z][a-zA-Z0-9_]*["']?\s*:)[\s\S]*)$/.exec(
      body,
    );
  if (concatMatch && concatMatch[1] && concatMatch[2]) {
    return { name: concatMatch[1], argsBlock: concatMatch[2] };
  }

  // Case C: Single tool name with no args
  const singleMatch = /^\s*(?:(?:default_api:|custom_api:)?([a-zA-Z0-9_-]+))\s*$/.exec(body);
  if (singleMatch && singleMatch[1]) {
    return { name: singleMatch[1], argsBlock: '' };
  }

  return null;
}

function parseArgsFromBlock(block: string): Record<string, unknown> | null {
  // 1. Check for <parameter> or <DSML|parameter>
  const paramRegex = /<(?:DSML\|)?parameter\s+name="([^"]+)"(?:\s+string="([^"]+)")?>([\s\S]*?)<\/(?:DSML\|)?parameter>/g;
  let paramMatch: RegExpExecArray | null;
  const paramArgs: Record<string, unknown> = {};
  let hasParams = false;
  while ((paramMatch = paramRegex.exec(block)) !== null) {
    const paramName = paramMatch[1];
    let paramValue: unknown = paramMatch[3].trim();
    const isString = paramMatch[2] === 'true';
    if (!isString) {
      try {
        paramValue = JSON.parse(paramValue as string);
      } catch (e) {
        log.debug('[OpenAI] Parameter parse fallback:', (e as Error).message);
      }
    }
    paramArgs[paramName] = paramValue;
    hasParams = true;
  }
  if (hasParams) return paramArgs;

  // 2. Check for extractJsonObject
  const jsonObj = extractJsonObject(block);
  if (jsonObj) {
    if (jsonObj.name && (jsonObj.arguments || jsonObj.parameters || jsonObj.input)) {
      let inner = jsonObj.arguments ?? jsonObj.parameters ?? jsonObj.input;
      if (typeof inner === 'string') {
        const rawInner = inner;
        try {
          inner = JSON.parse(rawInner);
        } catch {
          try {
            inner = JSON.parse(rawInner.replace(/\\([^"\\/bfnrtu])/g, '\\\\$1'));
          } catch {}
        }
      }
      if (inner && typeof inner === 'object' && !Array.isArray(inner)) {
        return inner as Record<string, unknown>;
      }
    }
    return jsonObj;
  }

  // 3. Check for concatenated key-values (GLM / SenseNova missing-bracket format)
  const kvArgs = extractConcatenatedKeyValues(block);
  if (kvArgs) return kvArgs;

  // 4. Check for Antigravity lean `Param>value` pairs (one per line or inline-separated),
  // e.g. "CommandLine>git status -s\nCwd>d:\\project" or "IsSkillFile>true toolSummary>Reading file"
  const leanArgs = extractLeanKeyValues(block);
  if (leanArgs) return leanArgs;

  // 5. Check for XML-inner `<Param>value</Param>` tags used by SenseNova / GLM /
  // BAI bare tool calls, e.g. "<view_file>\n<AbsolutePath>d:\\x\\README.md</AbsolutePath>\n</view_file>".
  const xmlInnerArgs = extractXmlInnerArgs(block);
  if (xmlInnerArgs) return xmlInnerArgs;

  return null;
}

/**
 * Extracts `<Param>value</Param>` key-value pairs inside a tool-call body.
 * SenseNova / GLM / BAI models render bare-tag args as XML tags rather than JSON
 * (e.g. `<AbsolutePath>d:\x\README.md</AbsolutePath>`). Values up to the matching
 * closing tag are coerced to boolean/number when they look like primitives so the
 * resulting args match the IDE's declared schema.
 */
function extractXmlInnerArgs(block: string): Record<string, unknown> | null {
  const tagRegex = /<([A-Za-z_][A-Za-z0-9_]*)>([\s\S]*?)<\/\1>/g;
  const args: Record<string, unknown> = {};
  let m: RegExpExecArray | null;
  let found = false;
  while ((m = tagRegex.exec(block)) !== null) {
    if (!m[0]) continue;
    const rawVal = m[2].trim();
    let val: unknown = rawVal;
    if (rawVal === 'true') val = true;
    else if (rawVal === 'false') val = false;
    else if (/^-?\d+(?:\.\d+)?$/.test(rawVal)) val = Number(rawVal);
    args[m[1]] = val;
    found = true;
  }
  return found ? args : null;
}

/**
 * Extracts Antigravity lean-format key-value pairs (`Key>value`) from a tool
 * call body. Values run until the next `Key>` token or end of block. Only
 * used when the block contains no JSON object and no colon-style key-values.
 */
function extractLeanKeyValues(block: string): Record<string, unknown> | null {
  const keyRegex = /(?:^|[\s\n])([A-Za-z_][A-Za-z0-9_]*)>/g;
  const matches: { key: string; valueStart: number; matchStart: number }[] = [];
  let m: RegExpExecArray | null;
  while ((m = keyRegex.exec(block)) !== null) {
    matches.push({ key: m[1], valueStart: m.index + m[0].length, matchStart: m.index });
  }
  if (matches.length === 0) return null;
  // Any text before the first key must be whitespace, otherwise this is prose, not lean args.
  if (block.slice(0, matches[0].matchStart).trim() !== '') return null;

  const args: Record<string, unknown> = {};
  for (let i = 0; i < matches.length; i++) {
    let end = i + 1 < matches.length ? matches[i + 1].matchStart : block.length;
    // A value may be followed by an adjacent XML tag in mixed-format bodies
    // (e.g. `CommandLine>git status</Cwd>\n<Cwd>...`). Stop at the tag so the
    // markup isn't swallowed into the value; the XML tags are extracted by a
    // separate pass (extractXmlInnerArgs) and merged by parseNativeToolArgs.
    const tail = block.slice(matches[i].valueStart, end);
    const xmlTagIdx = tail.search(/<\/?[A-Za-z_]/);
    if (xmlTagIdx !== -1) end = matches[i].valueStart + xmlTagIdx;
    const rawVal = block.slice(matches[i].valueStart, end).trim();
    let val: unknown = rawVal;
    if (rawVal === 'true') val = true;
    else if (rawVal === 'false') val = false;
    else if (/^-?\d+(?:\.\d+)?$/.test(rawVal)) val = Number(rawVal);
    args[matches[i].key] = val;
  }
  return args;
}

/**
 * Parses the raw `arguments` field of a native OpenAI `tool_calls` entry into a
 * plain args object.
 *
 * Upstream gateways are inconsistent: some emit a proper JSON object
 * (`{"CommandLine":"ls -la"}`), while others (e.g. the SenseNova gateway serving
 * GLM-style models) stuff raw lean/XML tool-call text into the field — either as
 * a JSON string (`"\nCommandLine>git status..."`) or as unquoted markup
 * (`\nCommandLine>...`). If a non-object leaks through as `functionCall.args`,
 * the Go language server serializes it as `arguments_json`, fails to JSON-parse
 * it, and aborts the whole turn with `invalid tool call error (invalid_json)`
 * (the "premature termination" symptom). This helper guarantees an object.
 */
function parseNativeToolArgs(name: string, raw: string): Record<string, unknown> {
  if (!raw) return {};
  let text = raw;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    // JSON-string-wrapped markup → unwrap to the inner text for the parsers below.
    if (typeof parsed === 'string') text = parsed;
  } catch {
    // Not JSON → keep the raw text.
  }
  // Raw lean/XML markup: merge both extraction styles so a mixed body
  // (`CommandLine>git status</Cwd>\n<Cwd>...`) yields all its keys. Lean wins
  // on collision because its values are already trimmed at the XML boundary.
   const merged: Record<string, unknown> = {};
  const xml = extractXmlInnerArgs(text);
  const lean = extractLeanKeyValues(text);
  if (xml) Object.assign(merged, xml);
  if (lean) Object.assign(merged, lean);
  if (Object.keys(merged).length > 0) return merged;
  // Bare command line as last resort (only for run_command, and only when the
  // text does not look like a broken JSON object/array — a JSON fragment that
  // failed to parse is unrecoverable and must not be run as a shell command).
  if (name === 'run_command') {
    const trimmed = text.trim();
    if (trimmed && trimmed[0] !== '{' && trimmed[0] !== '[') {
      return { CommandLine: trimmed };
    }
  }
  return {};
}

/**
 * Universal text-based tool call parser supporting DSML, XML, GLM, SenseNova, Hermes, Qwen, and Antigravity formats.
 */
function parseDSMLToolCalls(
  text: string,
  allowUnclosed = true,
  toolNames?: string[],
  paramSchemas?: Record<string, string[]> | null,
): DSMLParsedResult | null {
  try {
    const functionCalls: { name: string; args: Record<string, unknown> }[] = [];
    const consumedBlocks: string[] = [];

    /**
     * Validates a bare-tag candidate against the session's declared tool
     * schemas. Prose that merely mentions a tag (`...use <view_file> to read`)
     * must be rejected, otherwise a bogus tool call reaches the IDE and aborts
     * the whole turn with "invalid tool call". Null schema = unknown, accept.
     */
    const validateBareArgs = (name: string, args: Record<string, unknown>): boolean => {
      if (!paramSchemas) return true;
      const declared = paramSchemas[name];
      if (!declared) return false; // tool name not declared → not executable
      const keys = Object.keys(args);
      if (keys.length === 0) return false;
      // Accept when AT LEAST ONE declared param is present. Real models often
      // attach extra metadata (IsSkillFile / toolAction / StartLine / EndLine)
      // beyond the declared schema; rejecting on those would drop valid calls.
      // Only reject when NONE of the extracted keys are declared params (prose
      // quoting a tag with unrelated param names).
      return keys.some((k) => declared.includes(k));
    };

    const pushCall = (
      rawName: string,
      argsBlock: string,
      blockFullText?: string,
      validate?: (name: string, args: Record<string, unknown>) => boolean,
    ): void => {
      const args = parseArgsFromBlock(argsBlock);
      if (!args || Object.keys(args).length === 0) return;
      let name = cleanToolName(rawName);
      if (name === 'command' || args.CommandLine !== undefined || args.Cwd !== undefined) {
        name = 'run_command';
      }
      // 坑 15：toolSummary / toolAction / WaitMsBeforeAsync 不是"代理私有元数据"，
      // 而是 IDE 工具 schema 的必填参数（LS 报错串 "missing or invalid toolSummary
      // in arguments" 直接校验 args；官方 gemini 的 functionCall.args 也始终携带）。
      // 此前在此剥除导致 LS 丢弃整个 functionCall → 回退内置模型。
      if (validate && !validate(name, args)) return;
      if (blockFullText) consumedBlocks.push(blockFullText);
      functionCalls.push({ name, args });
    };

    /**
     * Validates a tool-call candidate for the boundary passes, also accepting a
     * translatable native name (run_command) that maps to a declared tool. The
     * session schema records declared names (e.g. list_dir); a model that emits a
     * bare <run_command> with a CommandLine should still be accepted when it maps
     * to a declared tool, otherwise a legit call is wrongly rejected.
     */
    const validateForPass = (name: string, args: Record<string, unknown>): boolean => {
      if (!paramSchemas) return true;
      if (validateBareArgs(name, args)) return true;
      if (name === 'run_command' && args.CommandLine !== undefined) {
        const tr = translateToolCallToNative(name, args as ToolCallArgs);
        return !!paramSchemas[tr.name];
      }
      return false;
    };

    /**
     * A bare tag counts as a REAL tool call only when it sits at a block
     * boundary: start of text or first non-whitespace on its own line. Inline
     * occurrences (`use <view_file> to read a file`) are prose quoting the tag.
     */
    const atBlockBoundary = (idx: number): boolean => {
      for (let i = idx - 1; i >= 0; i--) {
        const ch = text[i];
        if (ch === '\n') return true;
        if (!/\s/.test(ch)) return false;
      }
      return true;
    };

    /** True when `idx` lies inside an unclosed ``` code fence (quoted example). */
    const insideCodeFence = (idx: number): boolean => {
      const before = text.slice(0, idx);
      return (before.match(/```/g) || []).length % 2 !== 0;
    };

    // Pass 1: DSML invoke / tool_call tags
    const dsmlCallRegex = /<DSML\|(?:invoke|tool_call)\s+name="([^"]+)">([\s\S]*?)<\/DSML\|(?:invoke|tool_call)>/g;
    let match: RegExpExecArray | null;
    while ((match = dsmlCallRegex.exec(text)) !== null) {
      if (match[0] && !insideCodeFence(match.index)) pushCall(match[1], match[2], match[0], validateForPass);
    }

    // Pass 1b: 坑 17 变体——开标签用 `tool name="X"`，闭标签用 `invoke` 甚至
    // 重复 `tool_call`（真实商汤流：`<DSML|tool name="view_file">…</DSML|invoke>`
    // 外层还套了两个多余的 `</DSML|tool_call>`）。按开标签名捕获到最近的
    // `</DSML|invoke>` 或 `</DSML|tool name=...>` 为止。
    const dsmlToolNameRegex = /<DSML\|tool\s+name="([^"]+)"[^>]*>([\s\S]*?)<\/DSML\|(?:invoke|tool\s+name="\1")>/g;
    while ((match = dsmlToolNameRegex.exec(text)) !== null) {
      if (match[0] && !insideCodeFence(match.index)) pushCall(match[1], match[2], match[0], validateForPass);
    }

    // Pass 2: XML tool call tags with name attribute: <tool_call name="...">, <function_call name="...">, <tool name="...">, <action name="...">
    const xmlNamedRegex =
      /<(?:tool_call|function_call|tool|action)\s+name="([^"]+)"[^>]*>([\s\S]*?)<\/(?:tool_call|function_call|tool|action)>/g;
    while ((match = xmlNamedRegex.exec(text)) !== null) {
      if (match[0] && !insideCodeFence(match.index)) pushCall(match[1], match[2], match[0], validateForPass);
    }

    // Pass 3: Tag name contains the function name: <DSML|_command>{...}</DSML|_command> or <tool_call:funcName>{...}</tool_call:funcName>
    const tagNamedRegex =
      /<(?:DSML\||tool_call:|function_call:)((?!tool_calls|tool_call|invoke|parameter)[A-Za-z_][\w]*)>([\s\S]*?)<\/(?:DSML\||tool_call:|function_call:)\1>/g;
    while ((match = tagNamedRegex.exec(text)) !== null) {
      if (match[0] && !insideCodeFence(match.index)) pushCall(match[1], match[2], match[0], validateForPass);
    }

    // Pass 3b: Asymmetric close — the closing tag repeats only the function name,
    // NOT the full prefix: <tool_call:list_dir>{...}</list_dir> (GLM / SenseNova).
    // The symmetric requirement in Pass 3 above misses this, causing the whole
    // block to leak as visible text (see image 2).
    const asymTagNamedRegex =
      /<(?:DSML\||tool_call:|function_call:)((?!tool_calls|tool_call|invoke|parameter)[A-Za-z_][\w]*)>([\s\S]*?)<\/\1>/g;
    while ((match = asymTagNamedRegex.exec(text)) !== null) {
      if (match[0] && !insideCodeFence(match.index)) pushCall(match[1], match[2], match[0], validateForPass);
    }

    // Pass 4: Tag without name attribute: <tool_call>...</tool_call> or <function_call>...</function_call>
    const genericBlockRegex = /<(?:tool_call|function_call)>([\s\S]*?)<\/(?:tool_call|function_call)>/g;
    while ((match = genericBlockRegex.exec(text)) !== null) {
      if (insideCodeFence(match.index)) continue;
      const full = match[0];
      const body = match[1].trim();
      const jsonObj = extractJsonObject(body);
      if (jsonObj && (jsonObj.name || jsonObj.function || jsonObj.tool)) {
        const rawName = (jsonObj.name || jsonObj.function || jsonObj.tool) as string;
        pushCall(rawName, body, full, validateForPass);
      } else {
        const split = splitToolNameAndArgs(body);
        if (split) {
          pushCall(split.name, split.argsBlock, full, validateForPass);
        }
      }
    }

    // Pass 4b: Antigravity lean bare tags: <run_command>{...}</run_command> or
    // <view_file>\nParam>value\n</view_file> — matched against known tool names.
    // Must run BEFORE the unclosed-block passes so a closed bare tag is not
    // double-counted by the greedy unclosed-bare fallback below.
    if (toolNames && toolNames.length > 0) {
      const namesAlt = toolNames.map(escapeRegExp).join('|');
      const bareTagRegex = new RegExp(`<(${namesAlt})>([\\s\\S]*?)<\\/\\1>`, 'g');
      while ((match = bareTagRegex.exec(text)) !== null) {
        if (match[0] && atBlockBoundary(match.index) && !insideCodeFence(match.index)) {
          pushCall(match[1], match[2], match[0], validateForPass);
        }
      }
    }

    // Pass 5: Unclosed <tool_call> / <function_call> (only when explicitly allowed, e.g. stream finish or completed args)
    if (allowUnclosed && functionCalls.length === 0) {
      // Both unclosed <tool_call>{...} and <tool_call:name>{...} are recovered
      // here. The optional name group (match[1]) is preferred over the JSON body.
      const unclosedRegex = /<(?:tool_call|function_call)(?::([A-Za-z_]\w*))?>([\s\S]+)$/g;
      while ((match = unclosedRegex.exec(text)) !== null) {
        if (insideCodeFence(match.index)) continue;
        const full = match[0];
        const tagName = match[1];
        const body = match[2].trim();
        const jsonObj = extractJsonObject(body);
        if (tagName && !(jsonObj && jsonObj.name)) {
          pushCall(tagName, body, full, validateForPass);
        } else if (jsonObj && (jsonObj.name || jsonObj.function || jsonObj.tool)) {
          pushCall((jsonObj.name || jsonObj.function || jsonObj.tool) as string, body, full, validateForPass);
        } else {
          const split = splitToolNameAndArgs(body);
          if (split && split.argsBlock) {
            pushCall(split.name, split.argsBlock, full, validateForPass);
          }
        }
      }
      // Unclosed bare lean tag at end of stream: <run_command>{...} (no closing tag)
      if (toolNames && toolNames.length > 0) {
        const namesAlt = toolNames.map(escapeRegExp).join('|');
        const unclosedBareRegex = new RegExp(`<(${namesAlt})>([\\s\\S]+)$`, 'g');
        while ((match = unclosedBareRegex.exec(text)) !== null) {
          const full = match[0];
          const body = match[2].trim();
          if (body && atBlockBoundary(match.index) && !insideCodeFence(match.index)) {
            pushCall(match[1], body, full, validateForPass);
          }
        }
      }
    }

    // Pass 6: Antigravity-style call tags: <call:default_api:funcName{...}> or <call:funcName{...}>
    const agyCallRegex = /<call:(?:default_api:)?([a-zA-Z0-9_-]+)([\s\S]*?)>/g;
    while ((match = agyCallRegex.exec(text)) !== null) {
      if (match[0] && !insideCodeFence(match.index)) pushCall(match[1], match[2], match[0], validateForPass);
    }

    // Pass 7: Markdown code block: ```tool_call\nfunc\n{...}\n```
    const codeBlockRegex = /```(?:tool_call|function_call)\s*\n(?:([a-zA-Z0-9_-]+)\s*\n)?([\s\S]*?)```/g;
    while ((match = codeBlockRegex.exec(text)) !== null) {
      const full = match[0];
      const explicitName = match[1];
      const blockContent = match[2].trim();
      if (explicitName) {
        pushCall(explicitName, blockContent, full, validateForPass);
      } else {
        const jsonObj = extractJsonObject(blockContent);
        if (jsonObj && jsonObj.name) {
          pushCall(jsonObj.name as string, blockContent, full, validateForPass);
        } else {
          const split = splitToolNameAndArgs(blockContent);
          if (split) {
            pushCall(split.name, split.argsBlock, full, validateForPass);
          }
        }
      }
    }

    if (functionCalls.length === 0) return null;
    log.info(
      `[Proxy] Detected ${functionCalls.length} text tool call(s): ${functionCalls.map((f) => f.name).join(', ')}`,
    );
    let cleanText = text;
    for (const block of consumedBlocks) cleanText = cleanText.split(block).join('');
    cleanText = cleanText.replace(/<DSML\|tool_calls>[\s\S]*?<\/DSML\|tool_calls>/g, '');
    cleanText = cleanText.replace(/<DSML\|parameter[^>]*>[\s\S]*?<\/DSML\|parameter>/g, '');
    cleanText = cleanText.replace(/<\/?DSML\|[^>]*>/g, '');
    cleanText = cleanText.replace(/<\/?(?:tool_call|function_call|tool|action)[^>]*>/g, '');
    if (toolNames && toolNames.length > 0) {
      const namesAlt = toolNames.map(escapeRegExp).join('|');
      // 坑 21：只删除【闭合】的裸标签对与孤立的【闭】标签残余。未闭合的开标签
      // `<run_command>`（下一个在途块的起点）必须保留——它是后续帧
      // alreadyInsideToolBlock / bare 边界检测的依据，删掉后下一帧起整块参数会
      // 作为正文泄漏（12:51 真实流）。半截开标签尾由 trailingPartialMarkerLen
      // / pendingHeldSuffix 通道处理，与此处无关。
      cleanText = cleanText.replace(new RegExp(`<(?:${namesAlt})>[\\s\\S]*?</(?:${namesAlt})>`, 'g'), '');
      cleanText = cleanText.replace(new RegExp(`</(?:${namesAlt})>`, 'g'), '');
    }
    cleanText = cleanText.trim();
    return { functionCalls, cleanText };
  } catch (e) {
    log.error('[Proxy] Failed to parse tool calls from text:', e);
    return null;
  }
}

export function mapOpenAIToGemini(
  openAiRes: OpenAIResponse,
  modelName: string,
  sessionId?: string,
): GeminiGenerateContentResponse {
  const stateKeyStr = stateKey(modelName, sessionId);
  const choice = openAiRes.choices?.[0];

  const reasoningFromMessage = choice?.message?.reasoning_content || choice?.message?.reasoning || '';

  if (choice?.message?.tool_calls && choice.message.tool_calls.length > 0) {
    const parts: GeminiPart[] = [];
    if (reasoningFromMessage) parts.push({ text: reasoningFromMessage, thought: true });
    for (const tc of choice.message.tool_calls) {
      const rawArgs =
        typeof tc.function.arguments === 'string'
          ? tc.function.arguments
          : JSON.stringify(tc.function.arguments ?? {});
      const args = normalizeToolArgs(
        tc.function.name,
        parseNativeToolArgs(tc.function.name, rawArgs),
      ) as ToolCallArgs;
      // 坑 18：非流式 native tool_calls 路径同样保证 metadata 合法
      sanitizeToolMetadata(tc.function.name, args as Record<string, unknown>);
      const modelTCIds = modelToolCallIds.get(stateKeyStr) || {};
      modelTCIds[tc.function.name] = tc.id;
      modelToolCallIds.set(stateKeyStr, modelTCIds);
      touchStateTimestamp(stateTimestamps.toolCallIds, stateKeyStr);
      const translated = translateToolCallToNative(tc.function.name, args);
      if (translated.name !== tc.function.name) {
        translated.args = normalizeToolArgs(translated.name, translated.args) as Record<string, unknown>;
        translatedToolCalls.set(tc.id, {
          originalName: tc.function.name,
          translatedName: translated.name,
          cmd: args.CommandLine || '',
          cwd: args.Cwd || '',
        });
        touchStateTimestamp(stateTimestamps.translatedCalls, tc.id);
      }
      // 坑 25：非流式 native tool_calls 同样统一走 buildFunctionCallParts
      parts.push(...buildFunctionCallParts([{ name: translated.name, args: translated.args as Record<string, unknown> }], stateKeyStr));
    }
    return {
      candidates: [{ content: { parts, role: 'model' }, finishReason: 'STOP', index: 0 }],
      usageMetadata: {
        promptTokenCount: openAiRes.usage?.prompt_tokens || 0,
        candidatesTokenCount: openAiRes.usage?.completion_tokens || 0,
        totalTokenCount: openAiRes.usage?.total_tokens || 0,
      },
    };
  }

  // 坑 17：非流式入口同样归一化全角竖线 DSML
  const text = normalizeDSMLPipes(choice?.message?.content || '');
  const dsml = parseDSMLToolCalls(text, true, getLeanToolNames(stateKeyStr), modelToolSchemas.get(stateKeyStr) ?? null);
  if (dsml && dsml.functionCalls.length > 0) {
    const parts: GeminiPart[] = [];
    if (reasoningFromMessage) parts.push({ text: reasoningFromMessage, thought: true });
    // 坑 25：非流式同样走 prompt-XML 文本交付（LS 只解析文本标记）；
    // 经 buildFunctionCallParts 统一做翻译/注册/序列化。
    if (dsml.cleanText) parts.push({ text: dsml.cleanText });
    parts.push(...buildFunctionCallParts(dsml.functionCalls, stateKeyStr));
    return {
      candidates: [{ content: { parts, role: 'model' }, finishReason: 'STOP', index: 0 }],
      usageMetadata: {
        promptTokenCount: openAiRes.usage?.prompt_tokens || 0,
        candidatesTokenCount: openAiRes.usage?.completion_tokens || 0,
        totalTokenCount: openAiRes.usage?.total_tokens || 0,
      },
    };
  }

  const parts: GeminiPart[] = [];
  if (reasoningFromMessage) parts.push({ text: reasoningFromMessage, thought: true });
  if (text) parts.push({ text });
  const finishReasonMap: Record<string, string> = {
    stop: 'STOP',
    tool_calls: 'STOP',
    function_call: 'STOP',
    length: 'MAX_TOKENS',
    content_filter: 'SAFETY',
  };
  const finishReason = finishReasonMap[choice?.finish_reason || ''] || 'OTHER';
  return {
    candidates: [{ content: { parts, role: 'model' }, finishReason, index: 0 }],
    usageMetadata: {
      promptTokenCount: openAiRes.usage?.prompt_tokens || 0,
      candidatesTokenCount: openAiRes.usage?.completion_tokens || 0,
      totalTokenCount: openAiRes.usage?.total_tokens || 0,
    },
  };
}

// ─── STREAM CHUNK: OpenAI → Gemini ────────────────────────────────────────

/**
 * 坑 20 → 反证修正（坑 23）：官方对第三方模型（claude-sonnet-4-6）的调用帧
 * 【没有 thoughtSignature】照样执行 —— LS 对缺失签名不做校验；而携带签名时
 * LS 会验签，伪造的 Base64 串解不出合法结构 → 整个 part 判非法 → 调用丢弃
 * （13:08/13:29 实测）。结论：签名宁缺勿假，彻底不注入。
 * （原 withThoughtSignature/SYNTHETIC_THOUGHT_SIGNATURE 已移除。）
 */

/**
 * 坑 18：IDE 工具 schema 将 toolSummary / toolAction 列为必填（LS 报错串
 * "missing or invalid toolSummary in arguments"），官方 Gemini 帧的 args 也
 * 始终携带（透传日志证实）。但第三方上游有两种失格形态：
 *   ① 压根不输出（lean 裸标签格式，11:16 流）→ args 缺 required → LS 丢弃；
 *   ② 输出了但值是乱码（商汤服务端对参数区中文做 GBK 双重编码，11:31 流，
 *      "查看" → "鏌ョ湅"，甚至含 U+FFFD 截断符）→ "invalid" → LS 丢弃。
 * 交付前统一保证两键存在且值合法；缺失或含乱码特征（U+FFFD / 假名 / 全角
 * 拉丁 / GBK 双重解码高频字）时用官方风格英文短描述合成。
 */
const METADATA_MOJIBAKE_RE =
  /[\uFFFD\u3040-\u30FF\uFF01-\uFF5E\u20AC]|^[\u93cc\u92b6\u59dd\u8be9\u9473\u93de\u6d0b\u93c2\u6d5a\u946b]/;

const METADATA_DEFAULT_SUMMARY: Record<string, string> = {
  run_command: 'Running command',
  view_file: 'Viewing file',
  list_dir: 'Listing directory',
  grep_search: 'Searching code',
  write_to_file: 'Writing file',
  replace_file_content: 'Editing file',
  web_search: 'Searching web',
  find_by_name: 'Finding files',
};

export function sanitizeToolMetadata(name: string, args: Record<string, unknown>): void {
  const isBad = (v: unknown): boolean => typeof v !== 'string' || !v.trim() || METADATA_MOJIBAKE_RE.test(v);
  if (isBad(args.toolSummary)) {
    args.toolSummary = METADATA_DEFAULT_SUMMARY[name] ?? `Calling ${name}`;
  }
  if (isBad(args.toolAction)) {
    args.toolAction = METADATA_DEFAULT_SUMMARY[name] ?? `Calling ${name}`;
  }
  // WaitMsBeforeAsync：官方 run_command 帧带数值（观察值 5000）；缺失或类型不符时补齐
  if (name === 'run_command' && typeof args.WaitMsBeforeAsync !== 'number') {
    args.WaitMsBeforeAsync = 5000;
  }
}

/**
 * 坑 25（范式修正）：将解析出的文本工具调用交付为【prompt-XML 文本 part】，
 * 而非 functionCall part。LS 对自定义模型（占位符）一律走 prompt-based 工具
 * 调用：工具定义在 systemInstruction 文本里，响应侧 LS 只解析
 * <tool_name>{json}</tool_name> 文本块，functionCall part 会被忽略（这正是
 * 此前 supportsToolCalls/拆帧/签名全链修复均无效的根因）。
 *
 * 反向映射状态（translatedToolCalls / modelToolCallIds）照常注册，保证下游
 * 兼容；文本块按 prompt 要求分组置于消息末尾（由收口帧统一 flush）。
 */
function buildFunctionCallParts(
  fcs: { name: string; args: Record<string, unknown> }[],
  stateKeyStr: string,
): GeminiPart[] {
  const pairs: { name: string; args: Record<string, unknown> }[] = [];
  fcs.forEach((fc) => {
    const na = normalizeToolArgs(fc.name, fc.args);
    // 坑 18：toolSummary/toolAction 缺失或乱码时合成合法值（LS 必填校验）
    sanitizeToolMetadata(fc.name, na);
    const tr = translateToolCallToNative(fc.name, na);
    const callId = generateSyntheticCallId();
    if (tr.name !== fc.name) {
      tr.args = normalizeToolArgs(tr.name, tr.args) as Record<string, unknown>;
      translatedToolCalls.set(callId, {
        originalName: fc.name,
        translatedName: tr.name,
        cmd: (na.CommandLine as string) || '',
        cwd: (na.Cwd as string) || '',
      });
      touchStateTimestamp(stateTimestamps.translatedCalls, callId);
    }
    const modelTCIds = modelToolCallIds.get(stateKeyStr) || {};
    modelTCIds[fc.name] = callId;
    modelToolCallIds.set(stateKeyStr, modelTCIds);
    touchStateTimestamp(stateTimestamps.toolCallIds, stateKeyStr);
    pairs.push({ name: tr.name, args: tr.args as Record<string, unknown> });
  });
  if (pairs.length === 0) return [];
  return [{ text: serializeToolCallsAsPromptXml(pairs) }];
}

export function mapOpenAIChunkToGemini(
  chunk: OpenAIResponse,
  modelName: string,
  sessionId?: string,
  streamKey?: string,
): GeminiCandidate | null {
  const stateKeyStr = stateKey(modelName, sessionId);
  const choice = chunk.choices?.[0];
  if (!choice) return null;
  const delta = choice.delta;
  // Prefer the per-request streamKey so concurrent streams of the same model
  // never share one accumulated-text/tool-call context (the old
  // 'default_stream' fallback collapsed them together).
  const streamId = streamKey || ((chunk as Record<string, unknown>).id as string) || `${stateKeyStr}|stream`;

  if (!activeStreamContexts.has(streamId)) {
    activeStreamContexts.set(streamId, { accumulatedText: '', accumulatedReasoning: '', toolCalls: {} });
    touchStateTimestamp(stateTimestamps.streamCtx, streamId);
  }
  const context = activeStreamContexts.get(streamId)!;

  if (delta?.tool_calls && Array.isArray(delta.tool_calls)) {
    for (const tc of delta.tool_calls) {
      const idx = tc.index ?? 0;
      if (!context.toolCalls[idx]) context.toolCalls[idx] = { id: '', name: '', arguments: '' };
      if (tc.id) context.toolCalls[idx].id = tc.id;
      if (tc.function?.name) context.toolCalls[idx].name += tc.function.name;
      if (tc.function?.arguments) context.toolCalls[idx].arguments += tc.function.arguments;
    }
  }

  // 坑 17：帧文本入口即归一化全角竖线 DSML（`<｜DSML｜…>` → `<DSML|…>`），
  // 保证 accumulatedText、holdback、块解析整条链路只处理 ASCII 形态。
  const text = normalizeDSMLPipes(delta?.content || '');
  const reasoning = delta?.reasoning_content || delta?.reasoning || '';
  if (reasoning) context.accumulatedReasoning += reasoning;
  // 坑 16：块解析消费后移出的半截标签（heldSuffixDetached）不在 accumulatedText
  // 里，必须先补回再拼接本帧 text——后续 alreadyInsideToolBlock / bare 边界检测
  // 都基于 accumulatedText，缺了这个 `<` 就会把下一块整段当纯文本泄漏。
  if (text && context.pendingHeldSuffix && context.heldSuffixDetached) {
    context.accumulatedText += context.pendingHeldSuffix;
    delete context.heldSuffixDetached;
  }
  if (text) context.accumulatedText += text;

  // While a tool-call block is only partially streamed, hold its raw markup
  // back so tool call tags never flash as visible text. A lead-in sentence
  // that precedes the first tool-call marker is still emitted immediately.
  const leanToolNames = getLeanToolNames(stateKeyStr);
  const leanParamSchemas = modelToolSchemas.get(stateKeyStr) ?? null;
  const prevAcc = context.accumulatedText.slice(0, context.accumulatedText.length - text.length);
  // A stream that has already produced native delta.tool_calls is a native model
  // (e.g. SenseNova). Bare text-tag detection only makes sense for the text-tag
  // models, so disable it once native tool_calls have appeared — otherwise a
  // line-leading bare tag in a native model's body is wrongly treated as a
  // tool-call start and the rest of its body text gets swallowed.
  const nativeSeen = Object.keys(context.toolCalls).length > 0;
  const alreadyInsideToolBlock =
    hasUnclosedToolCallBlock(prevAcc) || (!nativeSeen && hasUnclosedBareToolBlock(prevAcc, leanToolNames));
  const emitParts: GeminiPart[] = [];
  if (reasoning) emitParts.push({ text: reasoning, thought: true });
  if (text) {
    if (alreadyInsideToolBlock) {
      // Entire delta is inside an in-flight tool block: hold it into the withheld
      // buffer so it is re-emitted verbatim at stream end (never duplicated or dropped).
      context.withheldText = (context.withheldText ?? '') + text;
    } else {
      // Re-combine any partial marker suffix held from the previous chunk with
      // this delta BEFORE marker detection. Otherwise a marker split across
      // chunk boundaries (e.g. prev chunk ends with "<view", this chunk is
      // "_file>") never matches a full marker and the remainder ("_file>")
      // leaks as visible text — the old code searched only the current delta.
      const heldSuffix = context.pendingHeldSuffix ?? '';
      if (heldSuffix) {
        // The held suffix was already buffered into withheldText; pull it back
        // out so it is re-processed exactly once below (never duplicated).
        const w = context.withheldText ?? '';
        context.withheldText = w.slice(0, w.length - heldSuffix.length);
        delete context.pendingHeldSuffix;
      }
      const work = heldSuffix + text;
      // Position of work[0] within accumulatedText: the held suffix is the
      // tail of prevAcc, so work starts heldSuffix.length earlier than text.
      const workBase = prevAcc.length - heldSuffix.length;

      let earliestIdx = -1;
      for (const marker of TOOL_CALL_START_MARKERS) {
        const idx = work.indexOf(marker);
        if (idx >= 0 && (earliestIdx === -1 || idx < earliestIdx)) {
          earliestIdx = idx;
        }
      }
      // Bare open tags (<run_command> etc.) are also tool-call starts, but only
      // when they sit at a block boundary & outside a code fence. Match them
      // against the accumulated text so the boundary test sees the whole stream
      // so far (prevAcc + this delta).
      const bareIdx = nativeSeen ? -1 : findEarliestBareMarkerIdx(context.accumulatedText, work, workBase, leanToolNames);
      if (bareIdx >= 0 && (earliestIdx === -1 || bareIdx < earliestIdx)) earliestIdx = bareIdx;

      let safePrefix = earliestIdx >= 0 ? work.slice(0, earliestIdx) : work;
      if (earliestIdx === -1) {
        // A tool-call marker may be split across chunk boundaries (e.g. chunk
        // ends with "<tool_" and the next chunk starts with "call>"). Hold back
        // the trailing partial-marker suffix (standard markers + bare open AND
        // closing tags — a lone "</view" tail would leak the same way) so it
        // never leaks as visible text; it is re-combined with the next delta
        // via the heldSuffix path above.
        const markers = [
          ...TOOL_CALL_START_MARKERS,
          ...leanToolNames.map((n) => `<${n}>`),
          ...leanToolNames.map((n) => `</${n}>`),
        ];
        let holdLen = 0;
        for (const marker of markers) {
          const maxCheck = Math.min(marker.length - 1, work.length);
          for (let len = maxCheck; len > holdLen; len--) {
            if (work.endsWith(marker.slice(0, len))) {
              holdLen = len;
              break;
            }
          }
        }
        if (holdLen > 0) {
          safePrefix = safePrefix.slice(0, safePrefix.length - holdLen);
          context.pendingHeldSuffix = work.slice(work.length - holdLen);
          context.withheldText = (context.withheldText ?? '') + context.pendingHeldSuffix;
        } else {
          delete context.pendingHeldSuffix;
        }
      } else {
        // Truncated at a bare/standard tool-call marker: the remainder after the
        // marker was never emitted, so buffer it for verbatim re-emission.
        context.withheldText = (context.withheldText ?? '') + work.slice(earliestIdx);
      }
      // 坑 17 后续：已被消费的块遗留的孤儿 DSML 结构标签（真实 11:25 流收口后
      // 又来了两个多余的 `</DSML|tool_call>`）在后续帧走 safePrefix 路径。工具
      // 调用标记任何情况下不得作为可见正文发出，发射前过滤。
      const visiblePrefix = safePrefix.replace(/<\/?DSML\|[^>]*>/g, '');
      if (visiblePrefix) emitParts.push({ text: visiblePrefix });
    }
  }

  // Intermediate closed-block parsing (only closed tool call blocks). Parsed
  // calls are STASHED into context.pendingFunctionCallParts instead of being
  // emitted immediately: delivering each call as its own STOP-terminated
  // message made the IDE treat the first STOP as end-of-turn and fall back to
  // its built-in model, silently dropping every later call (real-world
  // deepseek-v4-flash: view_file then run_command in one stream). All pending
  // calls are flushed together on the terminal frame below — one candidate,
  // multiple functionCall parts, a single STOP.
  const dsml = parseDSMLToolCalls(context.accumulatedText, false, leanToolNames, leanParamSchemas);
  if (dsml && dsml.functionCalls.length > 0) {
    context.pendingFunctionCallParts = [
      ...(context.pendingFunctionCallParts ?? []),
      ...buildFunctionCallParts(dsml.functionCalls, stateKeyStr),
    ];
    // Keep the unparsed remainder (e.g. a partially-streamed NEXT call block)
    // instead of wiping everything — a second call may already be in flight.
    // The trailing newline is required: cleanText strips the newlines adjacent
    // to the consumed block, and a following bare tag must still sit at a
    // line-start boundary to be recognised (real-world regression: view_file
    // then run_command in one stream, the second call silently dropped).
    //
    // 坑 16：上游可能把下一个块的开标签拆成 `<` + `run_command>` 跨 chunk 发送
    // （真实 10:52 流：`</`+`view_file>`+`\n<` | `run_command>`）。块解析消费后，
    // cleanText 尾部会残留孤立 `<`，补 \n 后变成 `<\n`，下一帧 `run_command>`
    // 拼不回 `<run_command>`，行首 bare 检测失败 → 整块泄漏为可见文本且第二个
    // 调用丢失。把这种"半截标签"尾从 cleanText 移入 pendingHeldSuffix，走下方
    // 既有 heldSuffix 重拼通道与下一帧重拼。
    let cleanTail = dsml.cleanText ?? '';
    const tailHold = trailingPartialMarkerLen(cleanTail, leanToolNames);
    if (tailHold > 0) {
      context.pendingHeldSuffix = cleanTail.slice(cleanTail.length - tailHold);
      cleanTail = cleanTail.slice(0, cleanTail.length - tailHold);
      // 坑 16：这个 heldSuffix 已从 accumulatedText 移出（不是老式"原地扣留"），
      // 打上分离标记，下一帧重拼前先补回 accumulatedText。
      context.heldSuffixDetached = true;
      // 与 1385-1391 的重拼约定一致：heldSuffix 已计入 withheldText，下一帧从
      // withheldText 拉回后正好消费一次。
      context.withheldText = context.pendingHeldSuffix;
    } else {
      delete context.pendingHeldSuffix;
      delete context.heldSuffixDetached;
      context.withheldText = '';
    }
    context.accumulatedText = cleanTail && !cleanTail.endsWith('\n') ? cleanTail + '\n' : cleanTail;
    context.hasEmittedToolCall = true;
  }

  const finishReason = choice.finish_reason;
  const isTerminal = finishReason === 'stop' || finishReason === 'length' || finishReason === 'function_call';
  if (isTerminal) {
    // Check for pending native tool_calls before closing stream
    // A tool call with empty arguments ("{}"/"") is still a valid no-arg call —
    // don't filter it out (JSON.parse falls back to {} below).
    const pendingToolCalls = Object.values(context.toolCalls).filter((tc) => tc.name);
    if (pendingToolCalls.length > 0) {
      // Text-tag calls stashed earlier in this stream are delivered together
      // with the native ones — one candidate, single STOP.
      const parts: GeminiPart[] = [...emitParts, ...(context.pendingFunctionCallParts ?? [])];
      // 补丁2（细化）：原生收口的调用来自 delta.tool_calls，与被扣留文本无关。
      // 纯文本开头的扣留是误扣正文 → 随本帧原样补发，不再丢失（回归 A 收口丢失面）；
      // 标记开头的扣留是被原生调用取代的废弃调用块 → 标记本身不泄漏（d2 语义），
      // 但块后的残余正文经 salvage 抢救补发，不再整体丢弃（h4/h5 语义）。
      const held = context.withheldText;
      if (held) {
        if (!withheldStartsWithMarkup(held)) {
          parts.unshift({ text: held });
        } else {
          const salvaged = salvagePlainTextFromMarkupLedHeld(held, leanToolNames, leanParamSchemas);
          if (salvaged) parts.unshift({ text: salvaged });
        }
      }
      for (const tc of pendingToolCalls) {
        const args = normalizeToolArgs(
          tc.name,
          parseNativeToolArgs(tc.name, tc.arguments),
        ) as ToolCallArgs;
        // 坑 18：流式 native tool_calls 收口路径同样保证 metadata 合法
        sanitizeToolMetadata(tc.name, args as Record<string, unknown>);
        const modelTCIds = modelToolCallIds.get(stateKeyStr) || {};
        modelTCIds[tc.name] = tc.id;
        modelToolCallIds.set(stateKeyStr, modelTCIds);
        touchStateTimestamp(stateTimestamps.toolCallIds, stateKeyStr);
        const translated = translateToolCallToNative(tc.name, args);
        if (translated.name !== tc.name) {
          translatedToolCalls.set(tc.id, {
            originalName: tc.name,
            translatedName: translated.name,
            cmd: args.CommandLine || '',
            cwd: args.Cwd || '',
          });
          touchStateTimestamp(stateTimestamps.translatedCalls, tc.id);
        }
        // 坑 25：流式 native 收口统一走 buildFunctionCallParts
        parts.push(...buildFunctionCallParts([{ name: translated.name, args: translated.args as Record<string, unknown> }], stateKeyStr));
      }
      context.hasEmittedToolCall = true;
      activeStreamContexts.delete(streamId);
      return { content: { parts, role: 'model' }, finishReason: 'STOP', index: 0 };
    }
    // Check for accumulated text/DSML/GLM tool calls at stream finish (allowUnclosed=true)
    if (context.accumulatedText) {
      const dsml2 = parseDSMLToolCalls(context.accumulatedText, true, leanToolNames, leanParamSchemas);
      if (dsml2 && dsml2.functionCalls.length > 0) {
        const parts: GeminiPart[] = [...emitParts, ...(context.pendingFunctionCallParts ?? [])];
        parts.push(...buildFunctionCallParts(dsml2.functionCalls, stateKeyStr));
        context.hasEmittedToolCall = true;
        activeStreamContexts.delete(streamId);
        return { content: { parts, role: 'model' }, finishReason: 'STOP', index: 0 };
      }
    }
    // Flush any withheld body/partial-marker text that turned out to be plain
    // text (it was withheld only to prevent markup leakage, not to be dropped).
    // withheldText tracks exactly the un-emitted remainder, so re-emitting it
    // verbatim can never duplicate already-emitted text (unlike a prefix-length
    // counter, which mis-aligns once a marker is split across chunk boundaries).
    const held = context.withheldText;
    if (held) emitParts.push({ text: held });
    delete context.pendingHeldSuffix;
    context.withheldText = '';
    // Deliver any stashed text-tag calls even when the final frame carries none
    // (e.g. all calls already closed mid-stream): one candidate, single STOP.
    const pendingNow = context.pendingFunctionCallParts ?? [];
    if (pendingNow.length > 0) {
      const parts: GeminiPart[] = [...emitParts, ...pendingNow];
      activeStreamContexts.delete(streamId);
      return { content: { parts, role: 'model' }, finishReason: 'STOP', index: 0 };
    }
    activeStreamContexts.delete(streamId);
    return {
      content: { parts: emitParts, role: 'model' },
      finishReason: finishReason === 'length' ? 'MAX_TOKENS' : 'STOP',
      index: 0,
    };
  }

  // Only emit tool calls when finishReason signals completion (args are fully accumulated)
  if (finishReason === 'tool_calls') {
    const parts: GeminiPart[] = [...emitParts, ...(context.pendingFunctionCallParts ?? [])];
    // 补丁2（细化）：同上，纯文本开头的扣留随调用帧补发；标记开头的废弃块不泄漏，
    // 但其残余正文经 salvage 抢救补发。
    const held = context.withheldText;
    if (held) {
      if (!withheldStartsWithMarkup(held)) {
        parts.unshift({ text: held });
      } else {
        const salvaged = salvagePlainTextFromMarkupLedHeld(held, leanToolNames, leanParamSchemas);
        if (salvaged) parts.unshift({ text: salvaged });
      }
    }
    for (const tc of Object.values(context.toolCalls)) {
      const args = normalizeToolArgs(
        tc.name,
        parseNativeToolArgs(tc.name, tc.arguments),
      ) as ToolCallArgs;
      // 坑 18：流式 native 收口路径（无文本调用）同样保证 metadata 合法
      sanitizeToolMetadata(tc.name, args as Record<string, unknown>);
      const modelTCIds = modelToolCallIds.get(stateKeyStr) || {};
      modelTCIds[tc.name] = tc.id;
      modelToolCallIds.set(stateKeyStr, modelTCIds);
      touchStateTimestamp(stateTimestamps.toolCallIds, stateKeyStr);
      const translated = translateToolCallToNative(tc.name, args);
      if (translated.name !== tc.name) {
        translated.args = normalizeToolArgs(translated.name, translated.args) as Record<string, unknown>;
        translatedToolCalls.set(tc.id, {
          originalName: tc.name,
          translatedName: translated.name,
          cmd: args.CommandLine || '',
          cwd: args.Cwd || '',
        });
        touchStateTimestamp(stateTimestamps.translatedCalls, tc.id);
      }
      // 坑 25：finishReason=tool_calls 收口统一走 buildFunctionCallParts
      parts.push(...buildFunctionCallParts([{ name: translated.name, args: translated.args as Record<string, unknown> }], stateKeyStr));
    }
    context.hasEmittedToolCall = true;
    activeStreamContexts.delete(streamId);
    return { content: { parts, role: 'model' }, finishReason: 'STOP', index: 0 };
  }

  if (emitParts.length > 0) {
    return { content: { parts: emitParts, role: 'model' }, finishReason: 'OTHER', index: 0 };
  }

  return null;
}

export { mapGeminiToolsToOpenAI };
