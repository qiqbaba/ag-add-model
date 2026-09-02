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
} from '../shared';

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

  const tcOpens = (text.match(/<tool_call[>\s]/g) || []).length;
  const tcCloses = (text.match(/<\/tool_call>/g) || []).length;
  if (tcOpens > tcCloses) return true;

  const fcOpens = (text.match(/<function_call[>\s]/g) || []).length;
  const fcCloses = (text.match(/<\/function_call>/g) || []).length;
  if (fcOpens > fcCloses) return true;

  // An opening "<call:" with no closing ">" yet (checked relative to the LAST
  // occurrence — the old !text.includes('>') condition was virtually never true).
  const callIdx = text.lastIndexOf('<call:');
  if (callIdx !== -1 && text.indexOf('>', callIdx) === -1) return true;
  if (text.includes('```tool_call') && (text.match(/```/g) || []).length % 2 !== 0) return true;

  return false;
}

/**
 * Returns true when `text` contains an unclosed bare lean tool tag
 * (e.g. `<run_command>` without its `</run_command>`) for any known tool name.
 */
function hasUnclosedBareToolBlock(text: string, toolNames: string[]): boolean {
  for (const name of toolNames) {
    const open = `<${name}>`;
    const close = `</${name}>`;
    let opens = 0;
    let idx = text.indexOf(open);
    while (idx !== -1) {
      opens++;
      idx = text.indexOf(open, idx + open.length);
    }
    if (opens === 0) continue;
    let closes = 0;
    idx = text.indexOf(close);
    while (idx !== -1) {
      closes++;
      idx = text.indexOf(close, idx + close.length);
    }
    if (opens > closes) return true;
  }
  return false;
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
              const callId =
                p.functionCall.id ||
                `call_${itemIdx}_${partIdx}_${p.functionCall.name || 'func'}`;
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
          item.parts.forEach((p, partIdx) => {
            if (p.functionResponse) {
              const funcName = p.functionResponse.name || '';
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
                  `call_${itemIdx}_${partIdx}_${funcName || 'func'}`;
              }

              const responseData = p.functionResponse.response;
              let contentStr = '';
              const translatedInfo = translatedToolCalls.get(toolCallId);
              if (translatedInfo) {
                contentStr = formatTranslatedResponse(translatedInfo, responseData);
              } else {
                contentStr = typeof responseData === 'string' ? responseData : JSON.stringify(responseData || {});
              }
              messages.push({ role: 'tool', content: contentStr, tool_call_id: toolCallId });
            }
          });
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
  }

  return payload;
}

// ─── RESPONSE: OpenAI → Gemini ─────────────────────────────────────────────

/** DSML / Tool metadata keys embedded in the JSON body that must not be forwarded as tool args. */
const TOOL_METADATA_KEYS = ['toolSummary', 'toolAction', 'WaitMsBeforeAsync', 'waitMsBeforeAsync'];

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
    const end = i + 1 < matches.length ? matches[i + 1].matchStart : block.length;
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
      for (const key of TOOL_METADATA_KEYS) delete args[key];
      if (validate && !validate(name, args)) return;
      if (blockFullText) consumedBlocks.push(blockFullText);
      functionCalls.push({ name, args });
    };

    // Pass 1: DSML invoke / tool_call tags
    const dsmlCallRegex = /<DSML\|(?:invoke|tool_call)\s+name="([^"]+)">([\s\S]*?)<\/DSML\|(?:invoke|tool_call)>/g;
    let match: RegExpExecArray | null;
    while ((match = dsmlCallRegex.exec(text)) !== null) {
      if (match[0]) pushCall(match[1], match[2], match[0]);
    }

    // Pass 2: XML tool call tags with name attribute: <tool_call name="...">, <function_call name="...">, <tool name="...">, <action name="...">
    const xmlNamedRegex =
      /<(?:tool_call|function_call|tool|action)\s+name="([^"]+)"[^>]*>([\s\S]*?)<\/(?:tool_call|function_call|tool|action)>/g;
    while ((match = xmlNamedRegex.exec(text)) !== null) {
      if (match[0]) pushCall(match[1], match[2], match[0]);
    }

    // Pass 3: Tag name contains the function name: <DSML|_command>{...}</DSML|_command> or <tool_call:funcName>{...}</tool_call:funcName>
    const tagNamedRegex =
      /<(?:DSML\||tool_call:|function_call:)((?!tool_calls|tool_call|invoke|parameter)[A-Za-z_][\w]*)>([\s\S]*?)<\/(?:DSML\||tool_call:|function_call:)\1>/g;
    while ((match = tagNamedRegex.exec(text)) !== null) {
      if (match[0]) pushCall(match[1], match[2], match[0]);
    }

    // Pass 3b: Asymmetric close — the closing tag repeats only the function name,
    // NOT the full prefix: <tool_call:list_dir>{...}</list_dir> (GLM / SenseNova).
    // The symmetric requirement in Pass 3 above misses this, causing the whole
    // block to leak as visible text (see image 2).
    const asymTagNamedRegex =
      /<(?:DSML\||tool_call:|function_call:)((?!tool_calls|tool_call|invoke|parameter)[A-Za-z_][\w]*)>([\s\S]*?)<\/\1>/g;
    while ((match = asymTagNamedRegex.exec(text)) !== null) {
      if (match[0]) pushCall(match[1], match[2], match[0]);
    }

    // Pass 4: Tag without name attribute: <tool_call>...</tool_call> or <function_call>...</function_call>
    const genericBlockRegex = /<(?:tool_call|function_call)>([\s\S]*?)<\/(?:tool_call|function_call)>/g;
    while ((match = genericBlockRegex.exec(text)) !== null) {
      const full = match[0];
      const body = match[1].trim();
      const jsonObj = extractJsonObject(body);
      if (jsonObj && (jsonObj.name || jsonObj.function || jsonObj.tool)) {
        const rawName = (jsonObj.name || jsonObj.function || jsonObj.tool) as string;
        pushCall(rawName, body, full);
      } else {
        const split = splitToolNameAndArgs(body);
        if (split) {
          pushCall(split.name, split.argsBlock, full);
        }
      }
    }

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

    // Pass 4b: Antigravity lean bare tags: <run_command>{...}</run_command> or
    // <view_file>\nParam>value\n</view_file> — matched against known tool names.
    // Must run BEFORE the unclosed-block passes so a closed bare tag is not
    // double-counted by the greedy unclosed-bare fallback below.
    if (toolNames && toolNames.length > 0) {
      const namesAlt = toolNames.map(escapeRegExp).join('|');
      const bareTagRegex = new RegExp(`<(${namesAlt})>([\\s\\S]*?)<\\/\\1>`, 'g');
      while ((match = bareTagRegex.exec(text)) !== null) {
        if (match[0] && atBlockBoundary(match.index) && !insideCodeFence(match.index)) {
          pushCall(match[1], match[2], match[0], validateBareArgs);
        }
      }
    }

    // Pass 5: Unclosed <tool_call> / <function_call> (only when explicitly allowed, e.g. stream finish or completed args)
    if (allowUnclosed && functionCalls.length === 0) {
      const unclosedRegex = /<(?:tool_call|function_call)>([\s\S]+)$/g;
      while ((match = unclosedRegex.exec(text)) !== null) {
        const full = match[0];
        const body = match[1].trim();
        const jsonObj = extractJsonObject(body);
        if (jsonObj && (jsonObj.name || jsonObj.function || jsonObj.tool)) {
          const rawName = (jsonObj.name || jsonObj.function || jsonObj.tool) as string;
          pushCall(rawName, body, full);
        } else {
          const split = splitToolNameAndArgs(body);
          if (split && split.argsBlock) {
            pushCall(split.name, split.argsBlock, full);
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
            pushCall(match[1], body, full, validateBareArgs);
          }
        }
      }
    }

    // Pass 6: Antigravity-style call tags: <call:default_api:funcName{...}> or <call:funcName{...}>
    const agyCallRegex = /<call:(?:default_api:)?([a-zA-Z0-9_-]+)([\s\S]*?)>/g;
    while ((match = agyCallRegex.exec(text)) !== null) {
      if (match[0]) pushCall(match[1], match[2], match[0]);
    }

    // Pass 7: Markdown code block: ```tool_call\nfunc\n{...}\n```
    const codeBlockRegex = /```(?:tool_call|function_call)\s*\n(?:([a-zA-Z0-9_-]+)\s*\n)?([\s\S]*?)```/g;
    while ((match = codeBlockRegex.exec(text)) !== null) {
      const full = match[0];
      const explicitName = match[1];
      const blockContent = match[2].trim();
      if (explicitName) {
        pushCall(explicitName, blockContent, full);
      } else {
        const jsonObj = extractJsonObject(blockContent);
        if (jsonObj && jsonObj.name) {
          pushCall(jsonObj.name as string, blockContent, full);
        } else {
          const split = splitToolNameAndArgs(blockContent);
          if (split) {
            pushCall(split.name, split.argsBlock, full);
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
      cleanText = cleanText.replace(new RegExp(`<\\/?(?:${namesAlt})>`, 'g'), '');
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
      let args: ToolCallArgs;
      try {
        args =
          typeof tc.function.arguments === 'string'
            ? JSON.parse(tc.function.arguments)
            : (tc.function.arguments as unknown as ToolCallArgs);
      } catch (e) {
        log.debug('[OpenAI] Tool call args parse fallback:', (e as Error).message);
        args = {};
      }
      args = normalizeToolArgs(tc.function.name, args) as ToolCallArgs;
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
      parts.push({
        functionCall: { name: translated.name, args: translated.args as Record<string, unknown>, id: tc.id },
      });
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

  const text = choice?.message?.content || '';
  const dsml = parseDSMLToolCalls(text, true, getLeanToolNames(stateKeyStr), modelToolSchemas.get(stateKeyStr) ?? null);
  if (dsml && dsml.functionCalls.length > 0) {
    const parts: GeminiPart[] = [];
    if (reasoningFromMessage) parts.push({ text: reasoningFromMessage, thought: true });
    dsml.functionCalls.forEach((fc, i) => {
      const na = normalizeToolArgs(fc.name, fc.args);
      const tr = translateToolCallToNative(fc.name, na);
      const callId = 'call_' + i + '_' + fc.name;
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
      parts.push({ functionCall: { name: tr.name, args: tr.args as Record<string, unknown>, id: callId } });
    });
    if (dsml.cleanText) parts.unshift({ text: dsml.cleanText });
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

  const text = delta?.content || '';
  const reasoning = delta?.reasoning_content || delta?.reasoning || '';
  if (reasoning) context.accumulatedReasoning += reasoning;
  if (text) context.accumulatedText += text;

  // While a tool-call block is only partially streamed, hold its raw markup
  // back so tool call tags never flash as visible text. A lead-in sentence
  // that precedes the first tool-call marker is still emitted immediately.
  const leanToolNames = getLeanToolNames(stateKeyStr);
  const leanParamSchemas = modelToolSchemas.get(stateKeyStr) ?? null;
  const prevAcc = context.accumulatedText.slice(0, context.accumulatedText.length - text.length);
  const alreadyInsideToolBlock = hasUnclosedToolCallBlock(prevAcc);
  const emitParts: GeminiPart[] = [];
  if (reasoning) emitParts.push({ text: reasoning, thought: true });
  if (text) {
    if (alreadyInsideToolBlock) {
      // Entire delta is inside an in-flight tool block: hold it entirely.
    } else {
      let earliestIdx = -1;
      for (const marker of TOOL_CALL_START_MARKERS) {
        const idx = text.indexOf(marker);
        if (idx >= 0 && (earliestIdx === -1 || idx < earliestIdx)) {
          earliestIdx = idx;
        }
      }
      let safePrefix = earliestIdx >= 0 ? text.slice(0, earliestIdx) : text;
      if (earliestIdx === -1) {
        // A tool-call marker may be split across chunk boundaries (e.g. chunk
        // ends with "<tool_" and the next chunk starts with "call>"). Hold back
        // the trailing partial-marker suffix so it never leaks as visible text;
        // it stays in accumulatedText and is re-evaluated with the next delta.
        let holdLen = 0;
        for (const marker of TOOL_CALL_START_MARKERS) {
          const maxCheck = Math.min(marker.length - 1, text.length);
          for (let len = maxCheck; len > holdLen; len--) {
            if (text.endsWith(marker.slice(0, len))) {
              holdLen = len;
              break;
            }
          }
        }
        if (holdLen > 0) {
          safePrefix = safePrefix.slice(0, safePrefix.length - holdLen);
          context.pendingHeldSuffix = text.slice(text.length - holdLen);
        } else {
          delete context.pendingHeldSuffix;
        }
      }
      if (safePrefix) emitParts.push({ text: safePrefix });
    }
  }

  // If this stream already emitted a TOOL_CALL, suppress subsequent STOP/OTHER chunks so tool call is not cancelled
  if (context.hasEmittedToolCall) {
    if (choice.finish_reason === 'stop' || choice.finish_reason === 'length' || choice.finish_reason === 'tool_calls') {
      activeStreamContexts.delete(streamId);
    }
    return null;
  }

  // Intermediate closed-block parsing (only closed tool call blocks)
  const dsml = parseDSMLToolCalls(context.accumulatedText, false, leanToolNames, leanParamSchemas);
  if (dsml && dsml.functionCalls.length > 0) {
    const parts: GeminiPart[] = [];
    if (reasoning) parts.push({ text: reasoning, thought: true });
    dsml.functionCalls.forEach((fc, i) => {
      const na = normalizeToolArgs(fc.name, fc.args);
      const tr = translateToolCallToNative(fc.name, na);
      const callId = 'call_' + i + '_' + fc.name;
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
      parts.push({ functionCall: { name: tr.name, args: tr.args as Record<string, unknown>, id: callId } });
    });
    context.accumulatedText = '';
    context.hasEmittedToolCall = true;
    return { content: { parts, role: 'model' }, finishReason: 'STOP', index: 0 };
  }

  const finishReason = choice.finish_reason;
  if (finishReason === 'stop' || finishReason === 'length') {
    // Check for pending native tool_calls before closing stream
    // A tool call with empty arguments ("{}"/"") is still a valid no-arg call —
    // don't filter it out (JSON.parse falls back to {} below).
    const pendingToolCalls = Object.values(context.toolCalls).filter((tc) => tc.name);
    if (pendingToolCalls.length > 0) {
      const parts: GeminiPart[] = emitParts.slice();
      for (const tc of pendingToolCalls) {
        let args: ToolCallArgs = {};
        try {
          args = JSON.parse(tc.arguments);
        } catch (_e) {
          args = {};
        }
        args = normalizeToolArgs(tc.name, args) as ToolCallArgs;
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
        parts.push({
          functionCall: { name: translated.name, args: translated.args as Record<string, unknown>, id: tc.id },
        });
      }
      context.hasEmittedToolCall = true;
      activeStreamContexts.delete(streamId);
      return { content: { parts, role: 'model' }, finishReason: 'STOP', index: 0 };
    }
    // Check for accumulated text/DSML/GLM tool calls at stream finish (allowUnclosed=true)
    if (context.accumulatedText) {
      const dsml2 = parseDSMLToolCalls(context.accumulatedText, true, leanToolNames, leanParamSchemas);
      if (dsml2 && dsml2.functionCalls.length > 0) {
        const parts: GeminiPart[] = emitParts.slice();
        dsml2.functionCalls.forEach((fc, i) => {
          const na = normalizeToolArgs(fc.name, fc.args);
          const tr = translateToolCallToNative(fc.name, na);
          const callId = 'call_' + i + '_' + fc.name;
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
          parts.push({ functionCall: { name: tr.name, args: tr.args as Record<string, unknown>, id: callId } });
        });
        context.hasEmittedToolCall = true;
        activeStreamContexts.delete(streamId);
        return { content: { parts, role: 'model' }, finishReason: 'STOP', index: 0 };
      }
    }
    // Flush any held-back partial marker that turned out to be plain text
    // (it was withheld only to prevent markup leakage, not to be dropped).
    if (context.pendingHeldSuffix) {
      emitParts.push({ text: context.pendingHeldSuffix });
      delete context.pendingHeldSuffix;
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
    const parts: GeminiPart[] = emitParts.slice();
    for (const tc of Object.values(context.toolCalls)) {
      let args: ToolCallArgs = {};
      try {
        args = JSON.parse(tc.arguments);
      } catch (e) {
        log.debug('[OpenAI] Stream tool args parse fallback:', (e as Error).message);
        args = {};
      }
      args = normalizeToolArgs(tc.name, args) as ToolCallArgs;
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
      parts.push({
        functionCall: { name: translated.name, args: translated.args as Record<string, unknown>, id: tc.id },
      });
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
