/**
 * Token usage accounting for the local proxy.
 *
 * The proxy observes every LLM round-trip -- both the official Gemini
 * pass-through and the translated custom-model traffic -- so it is the only
 * place in the IDE that can produce token numbers at all. This module keeps a
 * tiny in-memory snapshot that the companion VS Code extension polls over
 * `GET /api/token-stats` and renders in the status bar.
 *
 * Two sources feed the snapshot:
 *
 *  1. **Request-side estimate** (`recordRequestEstimate`): the outgoing request
 *     body size is converted to an approximate prompt-token count. This is what
 *     makes the indicator usable at all -- OpenAI-compatible streaming responses
 *     only report `usage` when the caller opts in via
 *     `stream_options.include_usage`, which this proxy does not send (and some
 *     upstreams ignore anyway).
 *  2. **Response-side truth** (`recordTokenUsage` with `authoritative: true`):
 *     whenever an upstream does return `usageMetadata` (non-streaming
 *     completions, Gemini streams), the real numbers replace the estimate.
 *
 * The caller also supplies the model's context window (see `modelWindow.ts`);
 * this module stores it verbatim and never tries to guess.
 *
 * Nothing is persisted: the counters live and die with the proxy process, i.e.
 * they reset when the IDE restarts.
 */

export interface TokenUsageInput {
  /** Internal identifier of the model that served the turn. */
  model: string;
  displayName?: string;
  provider?: string;
  promptTokenCount?: number;
  candidatesTokenCount?: number;
  thoughtsTokenCount?: number;
  cachedContentTokenCount?: number;
  totalTokenCount?: number;
  /** True when the numbers come from an upstream `usage` payload. */
  authoritative?: boolean;
  /** Resolved context window of the model, in tokens (0 = unknown). */
  contextWindow?: number;
  /** How the context window was resolved (explicit / catalog / official / ...). */
  contextWindowSource?: string;
}

export interface TurnTokenStats {
  model: string;
  displayName: string;
  provider: string;
  promptTokenCount: number;
  candidatesTokenCount: number;
  thoughtsTokenCount: number;
  cachedContentTokenCount: number;
  totalTokenCount: number;
  /** prompt + candidates -- the approximate context size for the next turn. */
  contextTokenCount: number;
  /** False while the value is still a request-side estimate. */
  authoritative: boolean;
  contextWindow: number;
  contextWindowSource: string;
  updatedAt: string;
}

export interface ModelTokenTotals {
  model: string;
  displayName: string;
  provider: string;
  turns: number;
  promptTokenCount: number;
  candidatesTokenCount: number;
  totalTokenCount: number;
  lastSeenAt: string;
}

export interface TokenStatsSnapshot {
  startedAt: string;
  updatedAt: string;
  turns: number;
  current: TurnTokenStats | null;
  totals: {
    turns: number;
    promptTokenCount: number;
    candidatesTokenCount: number;
    totalTokenCount: number;
  };
  perModel: ModelTokenTotals[];
}

const startedAt = new Date().toISOString();

let updatedAt = startedAt;
let turnCount = 0;
let current: TurnTokenStats | null = null;
const totals = { promptTokenCount: 0, candidatesTokenCount: 0, totalTokenCount: 0 };
const perModel = new Map<string, ModelTokenTotals>();

function toCount(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.round(value) : 0;
}

/**
 * Records a usage observation. Non-authoritative (estimate) observations only
 * update the "current turn" gauge; authoritative ones also advance the
 * cumulative counters, so running totals stay meaningful.
 */
export function recordTokenUsage(input: TokenUsageInput): void {
  const prompt = toCount(input.promptTokenCount);
  const candidates = toCount(input.candidatesTokenCount);
  const thoughts = toCount(input.thoughtsTokenCount);
  const cached = toCount(input.cachedContentTokenCount);
  const total = toCount(input.totalTokenCount) || prompt + candidates;

  // Upstreams that return nothing useful must not blank out the gauge.
  if (prompt === 0 && candidates === 0 && total === 0) return;

  const key = input.model || 'unknown';
  const displayName = input.displayName || key;
  const provider = input.provider || '';
  const authoritative = input.authoritative === true;
  const now = new Date().toISOString();

  // A window of 0 means "caller did not resolve one" -- keep the previous value
  // rather than flashing a broken percentage.
  const contextWindow = toCount(input.contextWindow) || current?.contextWindow || 0;
  const contextWindowSource = input.contextWindowSource || current?.contextWindowSource || '';

  current = {
    model: key,
    displayName,
    provider,
    promptTokenCount: prompt,
    candidatesTokenCount: candidates,
    thoughtsTokenCount: thoughts,
    cachedContentTokenCount: cached,
    totalTokenCount: total,
    contextTokenCount: prompt + candidates,
    authoritative,
    contextWindow,
    contextWindowSource,
    updatedAt: now,
  };
  updatedAt = now;

  if (!authoritative) return;

  turnCount += 1;
  totals.promptTokenCount += prompt;
  totals.candidatesTokenCount += candidates;
  totals.totalTokenCount += total;

  const entry = perModel.get(key);
  if (entry) {
    entry.turns += 1;
    entry.promptTokenCount += prompt;
    entry.candidatesTokenCount += candidates;
    entry.totalTokenCount += total;
    entry.lastSeenAt = now;
    if (input.displayName) entry.displayName = displayName;
    if (provider) entry.provider = provider;
  } else {
    perModel.set(key, {
      model: key,
      displayName,
      provider,
      turns: 1,
      promptTokenCount: prompt,
      candidatesTokenCount: candidates,
      totalTokenCount: total,
      lastSeenAt: now,
    });
  }
}

/**
 * Estimates the prompt size of an outgoing request from its serialized byte
 * length. `bytes / 4` is the usual rule of thumb for mixed prose + JSON; it is
 * deliberately slightly conservative so the gauge does not over-promise
 * remaining context.
 */
export function recordRequestEstimate(input: {
  model: string;
  displayName?: string;
  provider?: string;
  requestBytes: number;
  contextWindow?: number;
  contextWindowSource?: string;
}): void {
  if (!(input.requestBytes > 0)) return;
  const estimate = Math.max(1, Math.round(input.requestBytes / 4));
  recordTokenUsage({
    model: input.model,
    displayName: input.displayName,
    provider: input.provider,
    promptTokenCount: estimate,
    totalTokenCount: estimate,
    authoritative: false,
    contextWindow: input.contextWindow,
    contextWindowSource: input.contextWindowSource,
  });
}

export function getTokenStatsSnapshot(): TokenStatsSnapshot {
  return {
    startedAt,
    updatedAt,
    turns: turnCount,
    current,
    totals: { turns: turnCount, ...totals },
    perModel: Array.from(perModel.values()).sort((a, b) => b.totalTokenCount - a.totalTokenCount),
  };
}

export function resetTokenStats(): void {
  turnCount = 0;
  current = null;
  totals.promptTokenCount = 0;
  totals.candidatesTokenCount = 0;
  totals.totalTokenCount = 0;
  perModel.clear();
  updatedAt = new Date().toISOString();
}
