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
  /** Number of chars of accumulatedText already emitted as visible text (emission is strictly prefix-based). */
  emittedLen?: number;
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
