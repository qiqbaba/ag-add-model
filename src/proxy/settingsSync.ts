/**
 * Runtime port ↔ settings.json synchronization.
 *
 * Background: the proxy defaults to port 50999, but when that port is already
 * taken it falls back to a dynamically allocated port (port: 0). The Antigravity
 * IDE's Language Server reads its Cloud Code endpoint from the user's VS Code
 * settings.json via the `jetski.cloudCodeUrl` key. If that key is hardcoded to
 * 50999 while the proxy is actually listening on a fallback port, the LS will
 * time out connecting to the dead 50999 endpoint and custom models won't work.
 *
 * This module keeps `jetski.cloudCodeUrl` (and `~/.gemini/antigravity/active_port`)
 * in sync with whatever port the proxy actually bound, using a safe, lossless
 * JSONC/JSON read-write that preserves user formatting, comments, and trailing
 * commas.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import log from 'electron-log';

const CLOUD_CODE_URL_KEY = 'jetski.cloudCodeUrl';
const USER_DATA_DIR_NAME = 'Antigravity IDE';

// ─── URL construction ───────────────────────────────────────────────────────

/**
 * Builds the Cloud Code proxy URL that the LS should be pointed at for a given
 * actual proxy port.
 */
export function buildCloudCodeUrl(port: number): string {
  return `http://127.0.0.1:${port}/v1internal/xxxxxxx`;
}

// ─── Path resolution ────────────────────────────────────────────────────────

/**
 * Resolves the Electron `app.getPath('userData')` value, returning null when
 * not running inside Electron (e.g. CLI / unit tests).
 */
function getElectronUserData(): string | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const electron = require('electron') as { app?: { getPath?: (key: string) => string } };
    if (electron && electron.app && typeof electron.app.getPath === 'function') {
      const p = electron.app.getPath('userData');
      if (p) return p;
    }
  } catch {
    // Not inside Electron — fall through to the platform-based fallback.
  }
  return null;
}

/**
 * Cross-platform fallback for the Antigravity IDE user settings.json path.
 * Extracted as a pure function so it can be unit-tested with any platform/env.
 */
export function resolveSettingsPath(
  platform: NodeJS.Platform,
  env: Record<string, string | undefined>,
  homedir: string,
): string {
  if (platform === 'darwin') {
    return path.join(homedir, 'Library', 'Application Support', USER_DATA_DIR_NAME, 'User', 'settings.json');
  }
  if (platform === 'win32') {
    const appData = env.APPDATA;
    if (appData) return path.join(appData, USER_DATA_DIR_NAME, 'User', 'settings.json');
    return path.join(homedir, 'AppData', 'Roaming', USER_DATA_DIR_NAME, 'User', 'settings.json');
  }
  const xdgConfig = env.XDG_CONFIG_HOME || path.join(homedir, '.config');
  return path.join(xdgConfig, USER_DATA_DIR_NAME, 'User', 'settings.json');
}

/**
 * Resolves the IDE user settings.json path. Prefers Electron's `userData` dir,
 * falling back to a platform-specific path (Windows %APPDATA% / macOS
 * Application Support / Linux XDG_CONFIG_HOME) for CLI & tests.
 */
export function getSettingsPath(): string {
  const userData = getElectronUserData();
  if (userData) return path.join(userData, 'User', 'settings.json');
  return resolveSettingsPath(process.platform, process.env, os.homedir());
}

/**
 * Resolves the proxy runtime-port marker file path (~/.gemini/antigravity/active_port).
 */
export function getActivePortPath(): string {
  return path.join(os.homedir(), '.gemini', 'antigravity', 'active_port');
}

/**
 * Resolves the dashboard URL marker file path (~/.gemini/antigravity/dashboard_url).
 */
export function getDashboardUrlPath(): string {
  return path.join(os.homedir(), '.gemini', 'antigravity', 'dashboard_url');
}

// ─── active_port & dashboard_url sync ────────────────────────────────────────

/**
 * Persists the actually-bound proxy port to ~/.gemini/antigravity/active_port and
 * the dashboard URL to ~/.gemini/antigravity/dashboard_url.
 */
export function syncActivePort(port: number): void {
  try {
    const filePath = getActivePortPath();
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, String(port), 'utf-8');

    const dashPath = getDashboardUrlPath();
    fs.writeFileSync(dashPath, `http://127.0.0.1:${port}/`, 'utf-8');

    log.info(`[Proxy] Synced active_port => ${port} (${filePath}), dashboard => http://127.0.0.1:${port}/`);
  } catch (e) {
    log.error('[Proxy] Failed to sync active_port:', e);
  }
}

// ─── JSONC helpers (comment / trailing-comma aware) ─────────────────────────

/**
 * Removes line and block comments, leaving strings intact. Used to validate the
 * on-disk object structure without corrupting comment-bearing JSONC.
 */
function stripJsoncComments(text: string): string {
  let out = '';
  let i = 0;
  let inString = false;
  while (i < text.length) {
    const ch = text[i];
    const next = text[i + 1];
    if (inString) {
      out += ch;
      if (ch === '\\') {
        out += next || '';
        i += 2;
        continue;
      }
      if (ch === '"') inString = false;
      i++;
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
      i++;
      continue;
    }
    if (ch === '/' && next === '/') {
      while (i < text.length && text[i] !== '\n') i++;
      continue;
    }
    if (ch === '/' && next === '*') {
      i += 2;
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++;
      i += 2;
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

/**
 * Finds the indices of the top-level `{` and its matching `}`, skipping strings
 * and comments. Returns null if no robust top-level object is found.
 */
function findTopLevelObjectBounds(content: string): { open: number; close: number } | null {
  let i = 0;
  let inString = false;
  let inLineComment = false;
  let inBlockComment = false;
  let depth = 0;
  let open = -1;
  let close = -1;
  while (i < content.length) {
    const ch = content[i];
    const next = content[i + 1];
    if (inLineComment) {
      if (ch === '\n' || ch === '\r') inLineComment = false;
      i++;
      continue;
    }
    if (inBlockComment) {
      if (ch === '*' && next === '/') {
        inBlockComment = false;
        i += 2;
        continue;
      }
      i++;
      continue;
    }
    if (inString) {
      if (ch === '\\') {
        i += 2;
        continue;
      }
      if (ch === '"') inString = false;
      i++;
      continue;
    }
    if (ch === '"') {
      inString = true;
      i++;
      continue;
    }
    if (ch === '/' && next === '/') {
      inLineComment = true;
      i += 2;
      continue;
    }
    if (ch === '/' && next === '*') {
      inBlockComment = true;
      i += 2;
      continue;
    }
    if (ch === '{') {
      if (open === -1) open = i;
      depth++;
      i++;
      continue;
    }
    if (ch === '}') {
      depth--;
      if (depth === 0) {
        close = i;
        return { open, close };
      }
      i++;
      continue;
    }
    i++;
  }
  return null;
}

/**
 * Finds the index of the last top-level (depth 0) comma inside the object,
 * skipping strings and comments. Returns -1 when there is no top-level comma.
 */
function getLastTopLevelComma(content: string, open: number, close: number): number {
  let depth = 0;
  let inString = false;
  let inLineComment = false;
  let inBlockComment = false;
  let lastComma = -1;
  let i = open + 1;
  while (i < close) {
    const ch = content[i];
    const next = content[i + 1];
    if (inLineComment) {
      if (ch === '\n' || ch === '\r') inLineComment = false;
      i++;
      continue;
    }
    if (inBlockComment) {
      if (ch === '*' && next === '/') {
        inBlockComment = false;
        i += 2;
        continue;
      }
      i++;
      continue;
    }
    if (inString) {
      if (ch === '\\') {
        i += 2;
        continue;
      }
      if (ch === '"') inString = false;
      i++;
      continue;
    }
    if (ch === '"') {
      inString = true;
      i++;
      continue;
    }
    if (ch === '/' && next === '/') {
      inLineComment = true;
      i += 2;
      continue;
    }
    if (ch === '/' && next === '*') {
      inBlockComment = true;
      i += 2;
      continue;
    }
    if (ch === '{' || ch === '[') {
      depth++;
    } else if (ch === '}' || ch === ']') {
      depth--;
    } else if (ch === ',' && depth === 0) {
      lastComma = i;
    }
    i++;
  }
  return lastComma;
}

/**
 * Inserts a new property into a JSONC object body, preserving existing comments,
 * formatting, and any trailing comma. Returns the new content.
 */
function insertProperty(content: string, bounds: { open: number; close: number }, key: string, value: string): string {
  const { open, close } = bounds;
  const body = content.substring(open + 1, close);
  const lastComma = getLastTopLevelComma(content, open, close);

  let trailingComma = false;
  if (lastComma !== -1) {
    // Anything after the last top-level comma that is only whitespace/comments
    // (any number of them) means the comma is a trailing comma. The old regex
    // allowed at most one block + one line comment and produced ",," otherwise.
    const seg = content.substring(lastComma + 1, close);
    trailingComma = stripJsoncComments(seg).trim().length === 0;
  }

  const hasProps = stripJsoncComments(body).trim().length > 0;

  let leading = '';
  if (hasProps && !trailingComma) leading = ',';

  const prop = `${leading}\n    ${JSON.stringify(key)}: ${JSON.stringify(value)}`;
  return content.substring(0, close) + prop + '\n' + content.substring(close);
}

/**
 * Finds a `"key": value` pair at the top level of a JSONC document, skipping
 * comments and string literals. A regex over raw text would happily match a
 * commented-out stale entry (e.g. `// "jetski.cloudCodeUrl": "..."`) and
 * rewrite the comment instead of the live setting.
 */
function findLiveKeyValue(
  content: string,
  key: string,
): { start: number; end: number; prefixEnd: number; current: string } | null {
  const bounds = findTopLevelObjectBounds(content);
  if (!bounds) return null;

  let i = bounds.open + 1;
  let inLineComment = false;
  let inBlockComment = false;
  let depth = 0;
  while (i < bounds.close) {
    const ch = content[i];
    const next = content[i + 1];
    if (inLineComment) {
      if (ch === '\n' || ch === '\r') inLineComment = false;
      i++;
      continue;
    }
    if (inBlockComment) {
      if (ch === '*' && next === '/') {
        inBlockComment = false;
        i += 2;
        continue;
      }
      i++;
      continue;
    }
    if (ch === '/' && next === '/') {
      inLineComment = true;
      i += 2;
      continue;
    }
    if (ch === '/' && next === '*') {
      inBlockComment = true;
      i += 2;
      continue;
    }
    if (ch === '{' || ch === '[') {
      depth++;
      i++;
      continue;
    }
    if (ch === '}' || ch === ']') {
      depth--;
      i++;
      continue;
    }
    if (ch === '"' && depth === 0) {
      // Parse the string token
      let j = i + 1;
      let token = '';
      while (j < bounds.close) {
        if (content[j] === '\\') {
          token += content[j] + (content[j + 1] || '');
          j += 2;
          continue;
        }
        if (content[j] === '"') break;
        token += content[j];
        j++;
      }
      if (token === key) {
        // Expect ":" then a value
        let k = j + 1;
        while (k < bounds.close && /\s/.test(content[k])) k++;
        if (content[k] !== ':') {
          i = j + 1;
          continue;
        }
        k++;
        while (k < bounds.close && /\s/.test(content[k])) k++;
        const prefixEnd = k; // value starts here
        if (content[k] === '"') {
          let v = k + 1;
          let val = '';
          while (v < bounds.close) {
            if (content[v] === '\\') {
              v += 2;
              continue;
            }
            if (content[v] === '"') break;
            val += content[v];
            v++;
          }
          return { start: i, end: v + 1, prefixEnd, current: val };
        }
        // Non-string value: read until , } or whitespace
        let v = k;
        while (v < bounds.close && !/[,\s}]/.test(content[v])) v++;
        return { start: i, end: v, prefixEnd, current: content.substring(k, v) };
      }
      i = j + 1;
      continue;
    }
    i++;
  }
  return null;
}

/**
 * Rewrites a JSONC/JSON string so that `key` resolves to `value`.
 * - If the key exists and already equals value, returns null (idempotent no-op).
 * - If the key exists with a different value, replaces only the value (preserves
 *   key formatting, whitespace, comments, and sibling properties).
 * - If the key is missing, inserts it without breaking comments/trailing commas.
 * - Returns null on malformed input (caller skips the write).
 */
export function rewriteJsoncSetting(content: string, key: string, value: string): string | null {
  const live = findLiveKeyValue(content, key);
  if (live) {
    if (live.current === value) return null; // already matches → skip write
    // Replace only the value span (from prefixEnd to end), preserving the key
    // formatting, whitespace, and all surrounding comments.
    return content.slice(0, live.prefixEnd) + JSON.stringify(value) + content.slice(live.end);
  }

  const bounds = findTopLevelObjectBounds(content);
  if (!bounds) return null;
  return insertProperty(content, bounds, key, value);
}

/**
 * Atomically writes content to a file (write temp + rename) so a crash
 * mid-write cannot leave a truncated settings.json for the running IDE.
 */
function writeFileAtomic(filePath: string, content: string): void {
  const tmpPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmpPath, content, 'utf-8');
  fs.renameSync(tmpPath, filePath);
}

// ─── settings.json sync ─────────────────────────────────────────────────────

/**
 * Core sync routine that writes `jetski.cloudCodeUrl` into a specific file.
 * Returns true when the file was actually written, false when the value already
 * matched (idempotent skip) or an error occurred.
 */
export function syncSettingsJsonTo(settingsPath: string, port: number): boolean {
  try {
    const targetUrl = buildCloudCodeUrl(port);

    if (!fs.existsSync(settingsPath)) {
      fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
      writeFileAtomic(settingsPath, `{\n    "${CLOUD_CODE_URL_KEY}": "${targetUrl}"\n}\n`);
      log.info(`[Proxy] Created ${settingsPath} (${CLOUD_CODE_URL_KEY} => ${targetUrl})`);
      return true;
    }

    const content = fs.readFileSync(settingsPath, 'utf-8');
    const updated = rewriteJsoncSetting(content, CLOUD_CODE_URL_KEY, targetUrl);
    if (updated === null) return false;

    writeFileAtomic(settingsPath, updated);
    log.info(`[Proxy] Synced ${settingsPath} (${CLOUD_CODE_URL_KEY} => ${targetUrl})`);
    return true;
  } catch (e) {
    log.error('[Proxy] Failed to sync settings.json:', e);
    return false;
  }
}

/**
 * Syncs `jetski.cloudCodeUrl` in the resolved IDE user settings.json to the
 * actually-bound proxy port. Called by the proxy on every successful startup.
 */
export function syncSettingsJson(port: number): boolean {
  return syncSettingsJsonTo(getSettingsPath(), port);
}
