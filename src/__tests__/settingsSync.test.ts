import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  buildCloudCodeUrl,
  resolveSettingsPath,
  getActivePortPath,
  syncActivePort,
  syncSettingsJsonTo,
} from '../proxy/settingsSync';

vi.mock('electron-log', () => ({
  default: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  return {
    ...actual,
    homedir: vi.fn(() => actual.homedir()),
  };
});

const KEY = 'jetski.cloudCodeUrl';
const REAL_HOME = os.homedir();

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'agy-test-'));
}

// String-aware comment stripper: preserves "//" inside string literals (e.g. URLs).
function stripComments(text: string): string {
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

describe('buildCloudCodeUrl', () => {
  it('builds the LS proxy URL for the given port', () => {
    expect(buildCloudCodeUrl(50999)).toBe('http://127.0.0.1:50999/v1internal/xxxxxxx');
    expect(buildCloudCodeUrl(54321)).toBe('http://127.0.0.1:54321/v1internal/xxxxxxx');
  });
});

describe('resolveSettingsPath (cross-platform)', () => {
  it('resolves Windows %APPDATA% path', () => {
    const p = resolveSettingsPath('win32', { APPDATA: 'C:\\Users\\test\\AppData\\Roaming' }, 'C:\\Users\\test');
    expect(p).toBe(path.join('C:\\Users\\test\\AppData\\Roaming', 'Antigravity IDE', 'User', 'settings.json'));
  });

  it('falls back to home AppData/Roaming on Windows when APPDATA is missing', () => {
    const p = resolveSettingsPath('win32', {}, 'C:\\Users\\test');
    expect(p).toBe(path.join('C:\\Users\\test', 'AppData', 'Roaming', 'Antigravity IDE', 'User', 'settings.json'));
  });

  it('resolves macOS Application Support path', () => {
    const p = resolveSettingsPath('darwin', {}, '/Users/test');
    expect(p).toBe(
      path.join('/Users/test', 'Library', 'Application Support', 'Antigravity IDE', 'User', 'settings.json'),
    );
  });

  it('resolves Linux XDG_CONFIG_HOME path', () => {
    const p = resolveSettingsPath('linux', { XDG_CONFIG_HOME: '/home/test/.config' }, '/home/test');
    expect(p).toBe(path.join('/home/test/.config', 'Antigravity IDE', 'User', 'settings.json'));
  });

  it('falls back to ~/.config on Linux when XDG_CONFIG_HOME is missing', () => {
    const p = resolveSettingsPath('linux', {}, '/home/test');
    expect(p).toBe(path.join('/home/test', '.config', 'Antigravity IDE', 'User', 'settings.json'));
  });
});

describe('syncSettingsJsonTo', () => {
  it('creates a new settings.json when the file does not exist', () => {
    const dir = makeTempDir();
    const settingsPath = path.join(dir, 'settings.json');
    const wrote = syncSettingsJsonTo(settingsPath, 50999);
    expect(wrote).toBe(true);
    const parsed = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
    expect(parsed[KEY]).toBe('http://127.0.0.1:50999/v1internal/xxxxxxx');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('updates the port when it changes (50999 -> 54321 -> 50999)', () => {
    const dir = makeTempDir();
    const settingsPath = path.join(dir, 'settings.json');
    syncSettingsJsonTo(settingsPath, 50999);

    expect(syncSettingsJsonTo(settingsPath, 54321)).toBe(true);
    let parsed = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
    expect(parsed[KEY]).toBe('http://127.0.0.1:54321/v1internal/xxxxxxx');

    expect(syncSettingsJsonTo(settingsPath, 50999)).toBe(true);
    parsed = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
    expect(parsed[KEY]).toBe('http://127.0.0.1:50999/v1internal/xxxxxxx');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('is idempotent (returns false and skips write) when the port already matches', () => {
    const dir = makeTempDir();
    const settingsPath = path.join(dir, 'settings.json');
    syncSettingsJsonTo(settingsPath, 54321);
    const before = fs.readFileSync(settingsPath, 'utf-8');

    const wrote = syncSettingsJsonTo(settingsPath, 54321);
    expect(wrote).toBe(false);
    expect(fs.readFileSync(settingsPath, 'utf-8')).toBe(before);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('preserves comments and trailing commas when inserting a missing key', () => {
    const dir = makeTempDir();
    const settingsPath = path.join(dir, 'settings.json');
    fs.writeFileSync(
      settingsPath,
      `{
  // user preference
  "window.zoomLevel": 1,
  "editor.fontSize": 14,   // trailing comment
  "workbench.colorTheme": "Default Dark+",
}
`,
      'utf-8',
    );

    const wrote = syncSettingsJsonTo(settingsPath, 50999);
    expect(wrote).toBe(true);

    const content = fs.readFileSync(settingsPath, 'utf-8');
    expect(content).toContain('// user preference');
    expect(content).toContain('"window.zoomLevel": 1,');
    expect(content).toContain('// trailing comment');
    expect(content).toContain('"workbench.colorTheme": "Default Dark+",');
    expect(content).toContain(`"${KEY}": "http://127.0.0.1:50999/v1internal/xxxxxxx"`);

    // Remaining content must still parse as valid JSON after stripping comments
    const parsed = JSON.parse(stripComments(content));
    expect(parsed[KEY]).toBe('http://127.0.0.1:50999/v1internal/xxxxxxx');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('preserves comments and sibling props when updating an existing value', () => {
    const dir = makeTempDir();
    const settingsPath = path.join(dir, 'settings.json');
    fs.writeFileSync(
      settingsPath,
      `{
  "editor.fontSize": 14,
  // endpoint override
  "${KEY}": "http://127.0.0.1:50999/v1internal/xxxxxxx",
  "window.zoomLevel": 1
}
`,
      'utf-8',
    );

    const wrote = syncSettingsJsonTo(settingsPath, 54321);
    expect(wrote).toBe(true);

    const content = fs.readFileSync(settingsPath, 'utf-8');
    expect(content).toContain('// endpoint override');
    expect(content).toContain('"editor.fontSize": 14');
    expect(content).toContain('"window.zoomLevel": 1');
    expect(content).toContain(`"${KEY}": "http://127.0.0.1:54321/v1internal/xxxxxxx"`);

    const parsed = JSON.parse(stripComments(content));
    expect(parsed[KEY]).toBe('http://127.0.0.1:54321/v1internal/xxxxxxx');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('does not corrupt content when the value already matches inside a JSONC file', () => {
    const dir = makeTempDir();
    const settingsPath = path.join(dir, 'settings.json');
    const original = `{
  // endpoint override
  "${KEY}": "http://127.0.0.1:50999/v1internal/xxxxxxx",
  "window.zoomLevel": 1,
}
`;
    fs.writeFileSync(settingsPath, original, 'utf-8');

    const wrote = syncSettingsJsonTo(settingsPath, 50999);
    expect(wrote).toBe(false);
    expect(fs.readFileSync(settingsPath, 'utf-8')).toBe(original);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('getActivePortPath / getDashboardUrlPath / syncActivePort', () => {
  beforeEach(() => {
    vi.mocked(os.homedir).mockReturnValue(fs.mkdtempSync(path.join(os.tmpdir(), 'agy-home-')));
  });

  afterEach(() => {
    vi.mocked(os.homedir).mockReturnValue(REAL_HOME);
  });

  it('resolves to ~/.gemini/antigravity/active_port and dashboard_url', () => {
    expect(getActivePortPath()).toBe(path.join(os.homedir(), '.gemini', 'antigravity', 'active_port'));
  });

  it('writes and reads back the active port and dashboard_url', () => {
    const portPath = getActivePortPath();
    const dashPath = path.join(os.homedir(), '.gemini', 'antigravity', 'dashboard_url');
    syncActivePort(54321);
    expect(fs.existsSync(portPath)).toBe(true);
    expect(fs.readFileSync(portPath, 'utf-8')).toBe('54321');
    expect(fs.existsSync(dashPath)).toBe(true);
    expect(fs.readFileSync(dashPath, 'utf-8')).toBe('http://127.0.0.1:54321/');

    syncActivePort(50999);
    expect(fs.readFileSync(portPath, 'utf-8')).toBe('50999');
    expect(fs.readFileSync(dashPath, 'utf-8')).toBe('http://127.0.0.1:50999/');
  });
});
