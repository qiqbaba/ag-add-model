/**
 * Anthropic provider translator.
 * Handles Gemini ↔ Anthropic request/response mapping and streaming SSE events.
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
  activeStreamContexts,
  translatedToolCalls,
  stateTimestamps,
  touchStateTimestamp,
  stateKey,
  generateSyntheticCallId,
} from '../shared';
import { detectModelCapabilitiesByName } from '../modelUtils';

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

interface AnthropicTool {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
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

interface AnthropicImageSource {
  type: 'base64';
  media_type: string;
  data: string;
}

interface AnthropicContentBlock {
  type: 'text' | 'tool_use' | 'tool_result' | 'thinking' | 'image';
  text?: string;
  thinking?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  tool_use_id?: string;
  content?: string | AnthropicContentBlock[];
  source?: AnthropicImageSource;
}

type AnthropicMessageRole = 'user' | 'assistant';

interface AnthropicMessage {
  role: AnthropicMessageRole;
  content: string | AnthropicContentBlock[];
}

interface AnthropicRequestBody {
  model: string;
  messages: AnthropicMessage[];
  system?: string;
  max_tokens: number;
  temperature?: number;
  tools?: AnthropicTool[];
}

interface AnthropicResponse {
  content?: AnthropicContentBlock[];
  usage?: {
    input_tokens: number;
    output_tokens: number;
  };
  stop_reason?: string;
  type?: string;
  message?: { id: string };
  index?: number;
  content_block?: AnthropicContentBlock;
  delta?: {
    type?: string;
    text?: string;
    thinking?: string;
    partial_json?: string;
    stop_reason?: string;
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

// ─── REQUEST: Gemini → Anthropic ──────────────────────────────────────────

function mapGeminiToolsToAnthropic(geminiTools: GeminiTool[]): AnthropicTool[] {
  if (!geminiTools || !Array.isArray(geminiTools)) return [];
  const anthropicTools: AnthropicTool[] = [];
  for (const toolGroup of geminiTools) {
    if (toolGroup.functionDeclarations && Array.isArray(toolGroup.functionDeclarations)) {
      for (const func of toolGroup.functionDeclarations) {
        const params = func.parameters
          ? (JSON.parse(JSON.stringify(func.parameters)) as Record<string, unknown>)
          : { type: 'OBJECT', properties: {} };
        if (params.type && typeof params.type === 'string') {
          (params as Record<string, string>).type = (params.type as string).toLowerCase();
        }
        if (params.properties) {
          fixParamTypes(params.properties as Record<string, unknown>);
        }
        anthropicTools.push({
          name: func.name,
          description: func.description || '',
          input_schema: params,
        });
      }
    }
  }
  return anthropicTools;
}

export function mapGeminiToAnthropic(
  geminiBody: GeminiRequestBody,
  modelName: string,
  sessionId?: string,
): AnthropicRequestBody {
  const messages: AnthropicMessage[] = [];
  // Queue and index-aware tracking to resolve functionResponses even when multiple
  // tool calls of the same name are executed in parallel (e.g. 3 list_dir calls).
  const pendingCallsQueue: { id: string; name: string }[] = [];
  const allCallsById: Map<string, { name: string }> = new Map();
  const lastCallIdByName: Record<string, string> = {};
  const stateKeyStr = stateKey(modelName, sessionId);
  let system: string | undefined = undefined;

  if (geminiBody.systemInstruction && geminiBody.systemInstruction.parts) {
    system = geminiBody.systemInstruction.parts.map((p) => p.text || '').join('');
  }

  if (geminiBody.contents) {
    geminiBody.contents.forEach((item, itemIdx) => {
      if (item.parts) {
        const hasFunctionCall = item.parts.some((p) => p.functionCall);
        const hasFunctionResponse = item.parts.some((p) => p.functionResponse);

        if (hasFunctionCall && item.role === 'model') {
          const contentBlocks: AnthropicContentBlock[] = [];
          item.parts.forEach((p, partIdx) => {
            if (p.text) contentBlocks.push({ type: 'text', text: p.text });
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
              let parsedInput: Record<string, unknown>;
              if (typeof originalArgs === 'string') {
                try {
                  parsedInput = JSON.parse(originalArgs) as Record<string, unknown>;
                } catch (e) {
                  log.warn('[Anthropic] Invalid tool_use args JSON, using {}:', (e as Error).message);
                  parsedInput = {};
                }
              } else {
                parsedInput = originalArgs as Record<string, unknown>;
              }
              contentBlocks.push({
                type: 'tool_use',
                id: callId,
                name: originalName,
                input: parsedInput,
              });
            }
          });
          messages.push({ role: 'assistant', content: contentBlocks });
        } else if (hasFunctionResponse) {
          const contentBlocks: AnthropicContentBlock[] = [];
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
                  generateSyntheticCallId();
              }

              const responseData = p.functionResponse.response;
              let contentStr = '';
              const translatedInfo = translatedToolCalls.get(toolCallId);
              if (translatedInfo) {
                contentStr = formatTranslatedResponse(translatedInfo, responseData);
              } else {
                contentStr = typeof responseData === 'string' ? responseData : JSON.stringify(responseData || {});
              }
              contentBlocks.push({
                type: 'tool_result',
                tool_use_id: toolCallId,
                content: contentStr,
              });
            }
          });
          messages.push({ role: 'user', content: contentBlocks });
        } else {
          const roleStr = item.role === 'model' ? 'assistant' : item.role || 'user';
          const parts = item.parts || [];
          const contentBlocks: AnthropicContentBlock[] = [];
          const textParts: string[] = [];
          const hasImage = parts.some(
            (p) => p.inlineData && p.inlineData.mimeType?.startsWith('image/'),
          );
          for (const p of parts) {
            if (p.text) {
              textParts.push(p.text);
              if (hasImage) contentBlocks.push({ type: 'text', text: p.text });
            } else if (p.fileData) {
              const fd = p.fileData;
              let textContent: string;
              try {
                const url = new URL(fd.fileUri);
                if (url.protocol === 'file:') {
                  textContent = `[File:\n${fs.readFileSync(url.pathname.replace(/^\//, '').replace(/\//g, path.sep), 'utf-8')}\n]`;
                } else {
                  textContent = `[File: ${fd.fileUri} (${fd.mimeType})]`;
                }
              } catch {
                textContent = `[File: ${fd.fileUri} (${fd.mimeType})]`;
              }
              textParts.push(textContent);
              if (hasImage) contentBlocks.push({ type: 'text', text: textContent });
            } else if (p.inlineData) {
              const id = p.inlineData;
              if (id.mimeType && id.mimeType.startsWith('image/')) {
                contentBlocks.push({
                  type: 'image',
                  source: { type: 'base64', media_type: id.mimeType, data: id.data },
                });
              } else {
                const textContent = `[Inline data: ${id.mimeType}, length: ${(id.data || '').length} chars]`;
                textParts.push(textContent);
                if (hasImage) contentBlocks.push({ type: 'text', text: textContent });
              }
            }
          }
          const content: string | AnthropicContentBlock[] = hasImage ? contentBlocks : textParts.join('\n');
          if (roleStr === 'system') {
            const sysContent =
              typeof content === 'string'
                ? content
                : (content as AnthropicContentBlock[]).map((b) => b.text || '').join('\n');
            system = (system || '') + '\n' + sysContent;
          } else {
            messages.push({ role: roleStr as AnthropicMessageRole, content });
          }
        }
      }
    });
  }

  const result: AnthropicRequestBody = {
    model: modelName,
    messages,
    system,
    max_tokens: geminiBody.generationConfig?.maxOutputTokens ?? 16000,
  };

  // Claude thinking models don't support temperature (centralized detection)
  const { isThinkingModel } = detectModelCapabilitiesByName(modelName);
  if (!isThinkingModel) {
    const temp = geminiBody.generationConfig?.temperature;
    if (temp !== undefined && temp !== null) result.temperature = temp;
  }

  if (geminiBody.tools && Array.isArray(geminiBody.tools)) {
    const anthTools = mapGeminiToolsToAnthropic(geminiBody.tools);
    if (anthTools.length > 0) result.tools = anthTools;
  }

  return result;
}

// ─── RESPONSE: Anthropic → Gemini ─────────────────────────────────────────

export function mapAnthropicToGemini(
  anthRes: AnthropicResponse,
  modelName: string,
  sessionId?: string,
): GeminiGenerateContentResponse {
  const stateKeyStr = stateKey(modelName, sessionId);
  const contentBlocks = anthRes.content || [];
  const parts: GeminiPart[] = [];
  const functionCalls: GeminiPart[] = [];

  for (const block of contentBlocks) {
    if (block.type === 'text' && block.text) {
      parts.push({ text: block.text });
    } else if (block.type === 'thinking' && block.thinking) {
      parts.push({ text: block.thinking, thought: true });
    } else if (block.type === 'tool_use') {
      const modelTCIds = modelToolCallIds.get(stateKeyStr) || {};
      modelTCIds[block.name || ''] = block.id || '';
      modelToolCallIds.set(stateKeyStr, modelTCIds);
      touchStateTimestamp(stateTimestamps.toolCallIds, stateKeyStr);

      const normalizedInput = normalizeToolArgs(block.name || '', block.input || {});
      const translated = translateToolCallToNative(block.name || '', normalizedInput);
      if (translated.name !== block.name) {
        translated.args = normalizeToolArgs(translated.name, translated.args) as Record<string, unknown>;
        translatedToolCalls.set(block.id || '', {
          originalName: block.name || '',
          translatedName: translated.name,
          cmd: (normalizedInput.CommandLine as string) || '',
          cwd: (normalizedInput.Cwd as string) || '',
        });
        touchStateTimestamp(stateTimestamps.translatedCalls, block.id || '');
      }

      functionCalls.push({
        functionCall: { name: translated.name, args: translated.args as Record<string, unknown>, id: block.id },
      });
    }
  }

  if (functionCalls.length > 0) {
    return {
      candidates: [
        { content: { parts: [...parts, ...functionCalls], role: 'model' }, finishReason: 'STOP', index: 0 },
      ],
      usageMetadata: {
        promptTokenCount: anthRes.usage?.input_tokens || 0,
        candidatesTokenCount: anthRes.usage?.output_tokens || 0,
        totalTokenCount: (anthRes.usage?.input_tokens || 0) + (anthRes.usage?.output_tokens || 0),
      },
    };
  }

  const finishReason =
    anthRes.stop_reason === 'end_turn' ? 'STOP' : anthRes.stop_reason === 'max_tokens' ? 'MAX_TOKENS' : 'OTHER';

  return {
    candidates: [{ content: { parts, role: 'model' }, finishReason, index: 0 }],
    usageMetadata: {
      promptTokenCount: anthRes.usage?.input_tokens || 0,
      candidatesTokenCount: anthRes.usage?.output_tokens || 0,
      totalTokenCount: (anthRes.usage?.input_tokens || 0) + (anthRes.usage?.output_tokens || 0),
    },
  };
}

// ─── STREAM CHUNK: Anthropic SSE → Gemini ─────────────────────────────────

export function mapAnthropicChunkToGemini(
  chunk: AnthropicResponse,
  modelName: string,
  sessionId?: string,
  streamKey?: string,
): GeminiCandidate | null {
  const stateKeyStr = stateKey(modelName, sessionId);
  const type = chunk.type;
  // Prefer the per-request streamKey (unique per upstream connection) so
  // concurrent streams never share one context. chunk.message?.id only exists
  // on the message_start event, so using it first would split one stream's
  // state across two keys; the previous constant fallback ('anthropic_stream')
  // made ALL concurrent streams share a single context.
  const streamId = streamKey || chunk.message?.id || `${stateKeyStr}|stream`;

  if (!activeStreamContexts.has(streamId)) {
    activeStreamContexts.set(streamId, { accumulatedText: '', accumulatedReasoning: '', toolCalls: {} });
    touchStateTimestamp(stateTimestamps.streamCtx, streamId);
  }
  const context = activeStreamContexts.get(streamId)!;

  if (type === 'content_block_start') {
    const block = chunk.content_block;
    const idx = chunk.index ?? 0;
    if (block?.type === 'tool_use') {
      context.toolCalls[idx] = { id: block.id || '', name: block.name || '', arguments: '' };
    }
  }

  if (type === 'content_block_delta') {
    const delta = chunk.delta;
    const idx = chunk.index ?? 0;
    if (delta?.type === 'text_delta') {
      const text = delta.text || '';
      context.accumulatedText += text;
      return { content: { parts: [{ text }], role: 'model' }, finishReason: 'OTHER', index: 0 };
    } else if (delta?.type === 'thinking_delta') {
      const thinkingText = delta.thinking || '';
      context.accumulatedReasoning += thinkingText;
      return {
        content: { parts: [{ text: thinkingText, thought: true }], role: 'model' },
        finishReason: 'OTHER',
        index: 0,
      };
    } else if (delta?.type === 'input_json_delta' || delta?.type === 'input_delta') {
      // Anthropic's real SSE delta type is 'input_json_delta' ('input_delta' is
      // accepted for tolerance). Using the wrong name silently dropped all
      // streamed tool-call arguments.
      if (context.toolCalls[idx]) {
        context.toolCalls[idx].arguments += delta.partial_json || '';
      }
    }
  }

  if (type === 'message_delta') {
    const delta = chunk.delta;
    if (delta?.stop_reason === 'tool_use') {
      const parts: GeminiPart[] = Object.values(context.toolCalls).map((tc) => {
        let args: ToolCallArgs = {};
        try {
          args = JSON.parse(tc.arguments);
        } catch (e) {
          log.debug('[Anthropic] Stream tool args parse fallback:', (e as Error).message);
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
        return { functionCall: { name: translated.name, args: translated.args as Record<string, unknown>, id: tc.id } };
      });
      context.hasEmittedToolCall = true;
      activeStreamContexts.delete(streamId);
      return { content: { parts, role: 'model' }, finishReason: 'STOP', index: 0 };
    }
  }

  if (type === 'message_stop') {
    const hadToolCall = context.hasEmittedToolCall;
    activeStreamContexts.delete(streamId);
    if (hadToolCall) return null;
    return { content: { parts: [], role: 'model' }, finishReason: 'STOP', index: 0 };
  }

  return null;
}

export { mapGeminiToolsToAnthropic };
