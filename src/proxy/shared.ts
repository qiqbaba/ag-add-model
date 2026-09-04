/**
 * Shared state module for proxy orchestration.
 * Extracted from proxy.js to decouple translators from main orchestration.
 */

// ─── Types ────────────────────────────────────────────────────────────────

export interface StreamContext {
  accumulatedText: string;
  accumulatedReasoning: string;
  toolCalls: Record<number, { id: string; name: string; arguments: string }>;
  hasEmittedToolCall?: boolean;
  terminalFinishReason?: string;
  /** Trailing partial tool-call marker held back to avoid leaking markup; flushed at stream end if it turns out to be plain text. */
  pendingHeldSuffix?: string;
  /** Body text withheld by the emitter (inside an in-flight tool block, or a truncated marker remainder). Flushed verbatim at stream end so it is never duplicated or dropped. */
  withheldText?: string;
  /**
   * Text-tag tool calls parsed from closed blocks mid-stream, held until the
   * upstream finish frame so they can be delivered as ONE candidate message
   * (multiple functionCall parts + a single STOP). Emitting each call as its
   * own STOP-terminated message made the IDE treat the first STOP as turn end
   * and fall back to its built-in model, silently dropping the rest.
   */
  pendingFunctionCallParts?: GeminiPartLite[];
  /**
   * 坑 16：标记 pendingHeldSuffix 是"从 accumulatedText 中移出"的半截标签
   * （块解析消费后残留的孤立 `<` 等），而非"仍在 accumulatedText 尾部"的
   * 老式部分标记。下一帧重拼前需先把 heldSuffix 补回 accumulatedText，
   * 使 prevAcc/workBase 映射与 work 保持一致。
   */
  heldSuffixDetached?: boolean;
}

/** Minimal shape of a Gemini part pending delivery (kept structural to avoid import cycles). */
export interface GeminiPartLite {
  functionCall?: { name: string; args: Record<string, unknown>; id?: string };
  text?: string;
  thought?: boolean;
}

export interface StateTimestamps {
  /** keyed by streamId */
  streamCtx: Map<string, number>;
  /** keyed by stateKey(modelName, sessionId) */
  toolCallIds: Map<string, number>;
  /** keyed by tool_call_id */
  translatedCalls: Map<string, number>;
  /** keyed by stateKey(modelName, sessionId) */
  reasoning: Map<string, number>;
  /** keyed by stateKey(modelName, sessionId) */
  toolNames: Map<string, number>;
  /** keyed by stateKey(modelName, sessionId) */
  toolSchemas: Map<string, number>;
}

export interface TranslatedCallInfo {
  originalName: string;
  translatedName: string;
  cmd: string;
  cwd: string;
}

// ─── State ────────────────────────────────────────────────────────────────

/**
 * Computes the cross-turn state key for a given model.
 *
 * Tool-call / reasoning state is scoped per SESSION (conversation), not just per
 * model. Multiple IDE windows or subagents running the SAME model concurrently
 * would otherwise overwrite each other's `tool_call_id`/reasoning and cause
 * upstream 400 Bad Request (e.g. `tool_use_id not found`).
 *
 * When a `sessionId` is available the key becomes `model|sessionId`, so
 * concurrent conversations are isolated. When it is absent the key degrades to
 * just the model name (safe, but not session-safe — callers must pass a session
 * id in multi-conversation contexts).
 */
export function stateKey(modelName: string, sessionId?: string): string {
  return sessionId ? `${modelName}|${sessionId}` : modelName;
}

/** stateKey(modelName, sessionId) → { "functionName": "original_tool_call_id" } */
export const modelToolCallIds = new Map<string, Record<string, string>>();

/**
 * 生成与原生 Gemini（Antigravity LS）兼容的工具调用 id：`call_` + 纯数字。
 *
 * 实测对照（2026-09-04 10:15 会话）：LS 会话轨迹中成功执行的调用 id 均为
 * `call_` + 纯数字（如 call_717295，由 Google 官方后端下发）；此前代理在
 * 文本标签路径合成的 `call_0_view_file` 形态会导致 LS 丢弃整个 functionCall
 * （帧已送达但工具不执行、会话库无该调用记录、随后回退内置模型）。
 * 回程映射（functionResponse → tool_call_id）依赖 modelToolCallIds /
 * pendingCallsQueue 兜底，与 id 字面格式无关，纯数字格式是安全的。
 */
let syntheticCallIdCounter = 0;
export function generateSyntheticCallId(): string {
  syntheticCallIdCounter = (syntheticCallIdCounter + 1) % 1000;
  return 'call_' + (Date.now() % 1000000000).toString() + String(syntheticCallIdCounter).padStart(3, '0');
}

/** stateKey(modelName, sessionId) → preserved reasoning_content from previous turn */
export const modelReasoningContent = new Map<string, string>();

/** streamId → { accumulatedText, accumulatedReasoning, toolCalls } */
export const activeStreamContexts = new Map<string, StreamContext>();

/** toolCallId → { originalName, translatedName, cmd, cwd } */
export const translatedToolCalls = new Map<string, TranslatedCallInfo>();

/** stateKey(modelName, sessionId) → declared tool names for this conversation (used to detect bare-tag text tool calls) */
export const modelToolNames = new Map<string, Set<string>>();

/** stateKey(modelName, sessionId) → declared tool parameter names: toolName → [paramName, ...] */
export const modelToolSchemas = new Map<string, Record<string, string[]>>();

/** State entry timestamps for periodic cleanup */
export const stateTimestamps: StateTimestamps = {
  streamCtx: new Map(),
  toolCallIds: new Map(),
  translatedCalls: new Map(),
  reasoning: new Map(),
  toolNames: new Map(),
  toolSchemas: new Map(),
};

// ─── Helpers ──────────────────────────────────────────────────────────────

export function touchStateTimestamp(map: Map<string, number>, key: string): void {
  map.set(key, Date.now());
}

// ─── Periodic Cleanup (managed lifecycle) ─────────────────────────────────

let cleanupInterval: ReturnType<typeof setInterval> | null = null;

export function startCleanupInterval(): void {
  if (cleanupInterval) return; // already running
  cleanupInterval = setInterval(() => {
    const now = Date.now();
    const STREAM_TTL = 600_000; // 10 minutes for active stream contexts
    const TOOL_TTL = 1_800_000; // 30 minutes for tool call IDs & reasoning

    for (const [key, ts] of stateTimestamps.streamCtx) {
      if (now - ts > STREAM_TTL) {
        activeStreamContexts.delete(key);
        stateTimestamps.streamCtx.delete(key);
      }
    }
    for (const [key, ts] of stateTimestamps.toolCallIds) {
      if (now - ts > TOOL_TTL) {
        modelToolCallIds.delete(key);
        stateTimestamps.toolCallIds.delete(key);
      }
    }
    for (const [key, ts] of stateTimestamps.translatedCalls) {
      if (now - ts > TOOL_TTL) {
        translatedToolCalls.delete(key);
        stateTimestamps.translatedCalls.delete(key);
      }
    }
    for (const [key, ts] of stateTimestamps.reasoning) {
      if (now - ts > TOOL_TTL) {
        modelReasoningContent.delete(key);
        stateTimestamps.reasoning.delete(key);
      }
    }
    for (const [key, ts] of stateTimestamps.toolNames) {
      if (now - ts > TOOL_TTL) {
        modelToolNames.delete(key);
        stateTimestamps.toolNames.delete(key);
      }
    }
    for (const [key, ts] of stateTimestamps.toolSchemas) {
      if (now - ts > TOOL_TTL) {
        modelToolSchemas.delete(key);
        stateTimestamps.toolSchemas.delete(key);
      }
    }
  }, 300_000);
}

export function stopCleanupInterval(): void {
  if (cleanupInterval) {
    clearInterval(cleanupInterval);
    cleanupInterval = null;
  }
}

// Auto-start for backward compatibility (will be replaced by proxy.ts lifecycle)
startCleanupInterval();
