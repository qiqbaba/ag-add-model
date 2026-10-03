/**
 * Context-window resolution for the token meter.
 *
 * The status-bar gauge is only meaningful when it knows how large the window
 * actually is. Sources are consulted in priority order:
 *
 *  1. **explicit** -- an optional `contextWindow` field on the model entry in
 *     `custom_models.json`.
 *  2. **catalog** -- a local model catalog. Agents installed on the same machine
 *     (e.g. `~/.dsh/settings.yaml`) already keep a `<model id> -> contextWindow`
 *     table covering exactly the third-party models configured here. Scanned
 *     with a tolerant reader so no YAML dependency is pulled in.
 *  3. **official** -- the proxy intercepts `v1internal:fetchAvailableModels`,
 *     whose entries carry `maxTokens` (the real window for Gemini models).
 *  4. **heuristic** -- a small built-in family table.
 *
 * The resolved value is what the companion status-bar extension renders; it is
 * never written back into the injected model list, so IDE behaviour is
 * untouched.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import log from 'electron-log';

export type ContextWindowSource = 'explicit' | 'catalog' | 'official' | 'heuristic' | 'default';

export interface ResolvedContextWindow {
  contextWindow: number;
  source: ContextWindowSource;
}

export const DEFAULT_CONTEXT_WINDOW = 200_000;

const CATALOG_TTL_MS = 60_000;
const MIN_SANE_WINDOW = 1_000;

// ─── Local catalog ──────────────────────────────────────────────────────────

/**
 * Files scanned for `<model id> -> contextWindow` pairs. `~/.dsh/settings.yaml`
 * is the catalog observed on this machine; extra paths can be appended with the
 * `AGY_WINDOW_CATALOGS` environment variable (path-delimiter separated).
 */
function catalogPaths(): string[] {
  const paths = [path.join(os.homedir(), '.dsh', 'settings.yaml')];
  const extra = process.env.AGY_WINDOW_CATALOGS;
  if (extra) {
    for (const candidate of extra.split(path.delimiter)) {
      const trimmed = candidate.trim();
      if (trimmed) paths.push(trimmed);
    }
  }
  return paths;
}

const WINDOW_KEYS = new Set([
  'contextwindow',
  'context_window',
  'maxtokens',
  'max_input_tokens',
  'maxinputtokens',
  'inputtokenlimit',
]);
const ID_KEYS = new Set(['id', 'model', 'name']);

function normalizeModelKey(value: string): string {
  return value.trim().replace(/^["']|["']$/g, '').toLowerCase();
}

function toWindow(value: string): number | null {
  const parsed = Number.parseInt(value.replace(/[_,]/g, ''), 10);
  return Number.isFinite(parsed) && parsed >= MIN_SANE_WINDOW ? parsed : null;
}

/**
 * Tolerant scanner for the flat `- id: X` / `name: X` / `contextWindow: N`
 * shape used by local agent catalogs. Deliberately not a YAML parser: it only
 * has to survive indentation, comments and unrelated sibling keys, and it must
 * never throw on a file that happens to be malformed.
 */
export function parseCatalogText(text: string): Map<string, number> {
  const found = new Map<string, number>();
  let entry: { ids: string[]; window: number | null } | null = null;

  const flush = (): void => {
    if (entry && entry.window !== null) {
      for (const id of entry.ids) found.set(normalizeModelKey(id), entry.window);
    }
    entry = null;
  };

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;

    const isListItem = line.startsWith('- ');
    if (isListItem) flush();

    const body = isListItem ? line.slice(2).trim() : line;
    const sep = body.indexOf(':');
    if (sep < 0) continue;

    const key = body.slice(0, sep).trim().toLowerCase();
    const value = body
      .slice(sep + 1)
      .trim()
      .replace(/^["']|["']$/g, '');
    if (!value) continue;

    if (!isListItem) {
      // Indented continuation lines only matter once a list entry started.
      if (!entry) continue;
    } else if (!ID_KEYS.has(key) && !WINDOW_KEYS.has(key)) {
      continue;
    }

    if (!entry) entry = { ids: [], window: null };

    if (WINDOW_KEYS.has(key)) {
      const window = toWindow(value);
      if (window !== null) entry.window = window;
    } else if (ID_KEYS.has(key)) {
      entry.ids.push(value);
    }
  }

  flush();
  return found;
}

let catalogCache: { at: number; map: Map<string, number> } | null = null;

/** Reads (and caches for a minute) the local model catalogs. */
export function getLocalCatalog(): Map<string, number> {
  if (catalogCache && Date.now() - catalogCache.at < CATALOG_TTL_MS) return catalogCache.map;

  const map = new Map<string, number>();
  for (const file of catalogPaths()) {
    try {
      if (!fs.existsSync(file)) continue;
      const parsed = parseCatalogText(fs.readFileSync(file, 'utf-8'));
      for (const [key, value] of parsed) if (!map.has(key)) map.set(key, value);
      log.info(`[Proxy][Window] catalog ${file} => ${parsed.size} entries`);
    } catch (e) {
      log.debug(`[Proxy][Window] catalog read failed (${file}):`, (e as Error).message);
    }
  }

  catalogCache = { at: Date.now(), map };
  return map;
}

export function invalidateCatalogCache(): void {
  catalogCache = null;
}

// ─── Official model list ────────────────────────────────────────────────────

const officialWindows = new Map<string, number>();

/**
 * Records `maxTokens` from an intercepted `fetchAvailableModels` response.
 * Entries tagged `Custom` are skipped: the proxy injects a placeholder window
 * for them, so their value carries no information.
 */
export function registerOfficialContextWindows(
  models: Record<string, { maxTokens?: unknown; tagTitle?: unknown }> | undefined,
): number {
  if (!models || typeof models !== 'object') return 0;
  let captured = 0;
  for (const [slug, entry] of Object.entries(models)) {
    if (!entry || typeof entry !== 'object') continue;
    if (entry.tagTitle === 'Custom') continue;
    const value = entry.maxTokens;
    if (typeof value !== 'number' || !Number.isFinite(value) || value < MIN_SANE_WINDOW) continue;
    officialWindows.set(normalizeModelKey(slug), Math.round(value));
    captured += 1;
  }
  return captured;
}

export function getOfficialContextWindows(): Map<string, number> {
  return new Map(officialWindows);
}

// ─── Heuristic fallback ─────────────────────────────────────────────────────

/**
 * Family table used only when neither the local catalog nor the official model
 * list knows the model. Deliberately conservative: it prefers the commonly
 * published window rather than the theoretical maximum.
 */
const HEURISTIC_FAMILIES: [RegExp, number][] = [
  [/gemini|gemma/i, 1_048_576],
  [/claude|sonnet|opus|haiku/i, 200_000],
  [/kimi|moonshot/i, 262_144],
  [/glm|chatglm|zhipu|bigmodel/i, 131_072],
  [/qwen|tongyi|qwq/i, 131_072],
  [/mimo/i, 131_072],
  [/hunyuan|hy3/i, 131_072],
  [/deepseek/i, 131_072],
  [/gpt-|o[34]-|\bo[34]\b/i, 128_000],
  [/llama|mistral|mixtral|phi/i, 131_072],
];

// ─── Resolution ─────────────────────────────────────────────────────────────

export interface ContextWindowCandidates {
  explicit?: number;
  externalModelName?: string;
  name?: string;
  displayName?: string;
  slug?: string;
}

function normalizeCandidateList(candidates: ContextWindowCandidates): string[] {
  const raw = [candidates.externalModelName, candidates.name, candidates.displayName, candidates.slug];
  const keys: string[] = [];
  for (const value of raw) {
    if (!value) continue;
    const key = normalizeModelKey(value);
    if (key && !keys.includes(key)) keys.push(key);
    const bare = key.replace(/^models\//, '');
    if (bare && bare !== key && !keys.includes(bare)) keys.push(bare);
  }
  return keys;
}

export function resolveContextWindow(candidates: ContextWindowCandidates): ResolvedContextWindow {
  const explicit = candidates.explicit;
  if (typeof explicit === 'number' && Number.isFinite(explicit) && explicit >= MIN_SANE_WINDOW) {
    return { contextWindow: Math.round(explicit), source: 'explicit' };
  }

  const keys = normalizeCandidateList(candidates);

  const catalog = getLocalCatalog();
  for (const key of keys) {
    const hit = catalog.get(key);
    if (hit) return { contextWindow: hit, source: 'catalog' };
  }

  for (const key of keys) {
    const hit = officialWindows.get(key);
    if (hit) return { contextWindow: hit, source: 'official' };
  }

  const haystack = keys.join(' ');
  for (const [pattern, value] of HEURISTIC_FAMILIES) {
    if (pattern.test(haystack)) return { contextWindow: value, source: 'heuristic' };
  }

  return { contextWindow: DEFAULT_CONTEXT_WINDOW, source: 'default' };
}
