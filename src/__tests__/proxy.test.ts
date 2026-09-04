import { describe, it, expect, vi } from 'vitest';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import * as zlib from 'zlib';
import { pathToFileURL } from 'url';
import { resolveFileData, decompressResponseBody } from '../proxy';

// We need to mock the external dependencies that proxy.ts imports at module level
vi.mock('electron', () => ({
  app: {
    getPath: vi.fn((name: string) => {
      if (name === 'home') return '/mock/home';
      return '/mock/' + name;
    }),
  },
}));

vi.mock('electron-log', () => ({
  default: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

// ─── Test: generateModelPlaceholderId (via concept) ────────────────────────

function generateModelPlaceholderId(model: { displayName?: string; name?: string }): string {
  const input = (model.displayName || model.name || 'custom-model').toLowerCase();
  let hash = 5381;
  for (let i = 0; i < input.length; i++) {
    hash = (hash << 5) + hash + input.charCodeAt(i);
    hash = hash & hash; // Force 32-bit integer
  }
  const placeholderNum = 400 + (Math.abs(hash) % 200);
  return `MODEL_PLACEHOLDER_M${placeholderNum}`;
}

// ─── Test: toSlug (via concept) ───────────────────────────────────────────

function toSlug(model: { displayName?: string; externalModelName?: string; name?: string }): string {
  const rawName = model.displayName || model.externalModelName || model.name || 'custom-model';
  return (
    'extm-' +
    rawName
      .replace(/^models\//, '')
      .replace(/[^a-zA-Z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .toLowerCase()
  );
}

// ─── Test: parseRetryAfter (via concept) ──────────────────────────────────

function parseRetryAfter(headers: Record<string, string | string[] | undefined>): number {
  const val = headers['retry-after'];
  if (!val) return 0;

  const raw = Array.isArray(val) ? val[0] : val;
  if (!raw) return 0;

  const seconds = parseInt(raw.trim(), 10);
  if (!isNaN(seconds) && seconds >= 0) {
    return seconds * 1000;
  }

  const date = new Date(raw);
  if (!isNaN(date.getTime())) {
    const delay = date.getTime() - Date.now();
    return delay > 0 ? delay : 0;
  }

  return 0;
}

// ─── Tests ────────────────────────────────────────────────────────────────

describe('generateModelPlaceholderId', () => {
  it('generates deterministic IDs for the same input', () => {
    const id1 = generateModelPlaceholderId({ name: 'gpt-4o', displayName: 'GPT-4o' });
    const id2 = generateModelPlaceholderId({ name: 'gpt-4o', displayName: 'GPT-4o' });
    expect(id1).toBe(id2);
  });

  it('produces IDs in the MODEL_PLACEHOLDER_M format', () => {
    const id = generateModelPlaceholderId({ name: 'gpt-4o' });
    expect(id).toMatch(/^MODEL_PLACEHOLDER_M\d+$/);
  });

  it('produces different IDs for different models', () => {
    const id1 = generateModelPlaceholderId({ name: 'gpt-4o' });
    const id2 = generateModelPlaceholderId({ name: 'claude-3-5-sonnet' });
    expect(id1).not.toBe(id2);
  });

  it('uses displayName over name', () => {
    const id1 = generateModelPlaceholderId({ name: 'models/gpt-4o', displayName: 'My GPT-4o' });
    const id2 = generateModelPlaceholderId({ name: 'models/gpt-4o', displayName: 'Different Name' });
    expect(id1).not.toBe(id2);
  });

  it('falls back to name when displayName is missing', () => {
    const id = generateModelPlaceholderId({ name: 'gpt-4o' });
    expect(id).toBeTruthy();
  });

  it('falls back to "custom-model" when both name and displayName missing', () => {
    const id = generateModelPlaceholderId({});
    expect(id).toBeTruthy();
  });

  it('placeholder number is within range [400, 599]', () => {
    const id = generateModelPlaceholderId({ name: 'gpt-4o' });
    const num = parseInt(id.replace('MODEL_PLACEHOLDER_M', ''), 10);
    expect(num).toBeGreaterThanOrEqual(400);
    expect(num).toBeLessThanOrEqual(599);
  });

  it('lowercases the input before hashing', () => {
    const id1 = generateModelPlaceholderId({ name: 'GPT-4O' });
    const id2 = generateModelPlaceholderId({ name: 'gpt-4o' });
    expect(id1).toBe(id2);
  });
});

describe('toSlug', () => {
  it('prefixes with "extm-"', () => {
    const slug = toSlug({ name: 'gpt-4o' });
    expect(slug).toMatch(/^extm-/);
  });

  it('removes "models/" prefix from externalModelName', () => {
    const slug = toSlug({ externalModelName: 'models/gpt-4o' });
    expect(slug).toBe('extm-gpt-4o');
  });

  it('replaces non-alphanumeric chars with hyphens', () => {
    const slug = toSlug({ name: 'GPT 4o (Latest)' });
    expect(slug).toBe('extm-gpt-4o-latest');
  });

  it('removes leading and trailing hyphens', () => {
    const slug = toSlug({ name: '--test--' });
    expect(slug).toBe('extm-test');
  });

  it('lowercases the result', () => {
    const slug = toSlug({ name: 'GPT-4O' });
    expect(slug).toBe('extm-gpt-4o');
  });

  it('uses externalModelName over name', () => {
    const slug = toSlug({ name: 'gpt-4o', externalModelName: 'openai/gpt-4o' });
    expect(slug).toBe('extm-openai-gpt-4o');
  });

  it('handles OpenRouter model format (provider/model)', () => {
    const slug = toSlug({ externalModelName: 'openai/gpt-4o' });
    expect(slug).toBe('extm-openai-gpt-4o');
  });

  it('preserves tier-family keywords verbatim (no mutation)', () => {
    expect(toSlug({ name: 'gpt-4o', displayName: 'DeepSeek-V3 Pro' })).toBe('extm-deepseek-v3-pro');
    expect(toSlug({ name: 'gpt-4o', displayName: 'Gemini 1.5 Flash' })).toBe('extm-gemini-1-5-flash');
    expect(toSlug({ name: 'gpt-4o', displayName: 'Claude 3.5 Sonnet (High Temp)' })).toBe(
      'extm-claude-3-5-sonnet-high-temp',
    );
    expect(toSlug({ name: 'gpt-4o', displayName: 'Llama 3 Lite' })).toBe('extm-llama-3-lite');
  });
});

describe('parseRetryAfter', () => {
  it('returns 0 when no Retry-After header', () => {
    expect(parseRetryAfter({})).toBe(0);
  });

  it('parses delta-seconds format (integer)', () => {
    expect(parseRetryAfter({ 'retry-after': '120' })).toBe(120_000);
  });

  it('parses delta-seconds with whitespace', () => {
    expect(parseRetryAfter({ 'retry-after': '  60  ' })).toBe(60_000);
  });

  it('returns 0 for negative delta-seconds', () => {
    expect(parseRetryAfter({ 'retry-after': '-5' })).toBe(0);
  });

  it('parses HTTP-date format for future date', () => {
    const futureDate = new Date(Date.now() + 60_000).toUTCString();
    const result = parseRetryAfter({ 'retry-after': futureDate });
    expect(result).toBeGreaterThan(0);
    expect(result).toBeLessThanOrEqual(61_000); // allow 1s tolerance
  });

  it('returns 0 for past HTTP-date', () => {
    const pastDate = new Date(Date.now() - 60_000).toUTCString();
    expect(parseRetryAfter({ 'retry-after': pastDate })).toBe(0);
  });

  it('handles array value (takes first element)', () => {
    expect(parseRetryAfter({ 'retry-after': ['30', '60'] })).toBe(30_000);
  });

  it('returns 0 for invalid string', () => {
    expect(parseRetryAfter({ 'retry-after': 'not-a-number' })).toBe(0);
  });

  it('returns 0 for empty string', () => {
    expect(parseRetryAfter({ 'retry-after': '' })).toBe(0);
  });
});

describe('multi-model agentModelSorts merge logic', () => {
  it('preserves natural user-defined configuration order for large numbers of models', () => {
    const customModels = Array.from({ length: 15 }, (_, i) => ({
      name: `models/custom-model-${i + 1}`,
      displayName: `Custom Model ${i + 1}`,
      externalModelName: `custom-model-${i + 1}`,
      _slug: `custom-custom-model-${i + 1}`,
    }));

    const googleJson = {
      models: {
        'gemini-3.7-flash-high': { displayName: 'Gemini 3.7 Flash (High)' },
      },
      agentModelSorts: [
        {
          displayName: 'Recommended',
          groups: [{ modelIds: ['gemini-3.7-flash-high'] }],
        },
      ],
    };

    const customSlugs = customModels.map((m) => m._slug || toSlug(m)).filter(Boolean) as string[];

    // Ensure order is not reversed and all 15 models are preserved
    if (customSlugs.length > 0 && googleJson.agentModelSorts && Array.isArray(googleJson.agentModelSorts)) {
      googleJson.agentModelSorts.forEach((sort) => {
        if (sort.groups && Array.isArray(sort.groups) && sort.groups.length > 0) {
          const g0 = sort.groups[0];
          if (Array.isArray(g0.modelIds)) {
            customSlugs.forEach((slug) => {
              if (!g0.modelIds.includes(slug)) {
                g0.modelIds.push(slug);
              }
            });
          }
        }
      });
    }

    const g0ModelIds = googleJson.agentModelSorts[0].groups[0].modelIds;
    expect(g0ModelIds.length).toBe(16); // 1 official + 15 custom
    expect(g0ModelIds[0]).toBe('gemini-3.7-flash-high');
    expect(g0ModelIds[1]).toBe('custom-custom-model-1');
    expect(g0ModelIds[2]).toBe('custom-custom-model-2');
    expect(g0ModelIds[15]).toBe('custom-custom-model-15');
  });

  it('appends per-platform custom groups and keeps groups[0] as flat fallback', () => {
    // 与 src/proxy.ts 中 agentModelSorts 注入逻辑保持一致的回归规格：
    // 1) groups[0] 仍保留全部自定义 slug（前端未打补丁时扁平展示）
    // 2) 额外追加按平台命名的分组（v1internal.ModelGroup: displayName + modelIds）
    // 3) 重复执行幂等：旧的自定义平台分组与 groups[0] 中的自定义 slug 会先被清除
    const customModels = [
      { name: 'models/deepseek-v4-pro', displayName: 'Deepseek V4 Pro', apiUrl: 'https://token.sensenova.cn/v1/chat/completions', _slug: 'extm-deepseek-v4-pro' },
      { name: 'models/kimi-k3', displayName: 'Kimi K3', apiUrl: 'https://token.sensenova.cn/v1/chat/completions', _slug: 'extm-kimi-k3' },
      { name: 'models/hy3', displayName: 'Hy3', apiUrl: 'https://api.b.ai/v1/chat/completions', _slug: 'extm-hy3' },
      { name: 'models/my-local', displayName: 'My Local', apiUrl: '', group: '我的分组', _slug: 'extm-my-local' },
    ];

    const googleJson = {
      agentModelSorts: [
        {
          displayName: 'Recommended',
          groups: [
            { modelIds: ['gemini-3.7-flash-high', 'extm-deepseek-v4-pro'] },
            { displayName: '商汤 SenseNova', modelIds: ['extm-deepseek-v4-pro', 'extm-kimi-k3'] }, // 旧注入, 应被清除重建
          ],
        },
      ],
    };

    const customSlugs = customModels.map((m) => m._slug).filter(Boolean) as string[];
    const resolveGroupName = (m: (typeof customModels)[number]): string => {
      if (m.group && m.group.trim()) return m.group.trim();
      const url = m.apiUrl || '';
      const known: [RegExp, string][] = [
        [/sensenova/i, '商汤 SenseNova'],
        [/api\.b\.ai/i, 'B.AI'],
      ];
      for (const [re, name] of known) {
        if (re.test(url)) return name;
      }
      return '自定义模型';
    };
    const groupedSlugs = new Map<string, string[]>();
    customModels.forEach((m) => {
      const g = resolveGroupName(m);
      if (!groupedSlugs.has(g)) groupedSlugs.set(g, []);
      groupedSlugs.get(g)!.push(m._slug);
    });
    googleJson.agentModelSorts.forEach((sort) => {
      sort.groups = sort.groups.filter((g, idx) => {
        if (idx === 0) return true;
        const ids = g.modelIds || [];
        return !(ids.length > 0 && ids.every((id) => customSlugs.includes(id)));
      });
      const g0 = sort.groups[0];
      g0.modelIds = g0.modelIds.filter((id) => !customSlugs.includes(id));
      customSlugs.forEach((slug) => g0.modelIds.push(slug));
      groupedSlugs.forEach((ids, name) => {
        sort.groups.push({ displayName: name, modelIds: ids });
      });
    });

    const groups = googleJson.agentModelSorts[0].groups;
    expect(groups.length).toBe(4); // g0 + 商汤 + B.AI + 我的分组
    expect(groups[0].modelIds).toEqual([
      'gemini-3.7-flash-high',
      'extm-deepseek-v4-pro',
      'extm-kimi-k3',
      'extm-hy3',
      'extm-my-local',
    ]);
    expect(groups[1]).toEqual({ displayName: '商汤 SenseNova', modelIds: ['extm-deepseek-v4-pro', 'extm-kimi-k3'] });
    expect(groups[2]).toEqual({ displayName: 'B.AI', modelIds: ['extm-hy3'] });
    expect(groups[3]).toEqual({ displayName: '我的分组', modelIds: ['extm-my-local'] });
  });

  it('generates distinct slugs for models sharing the same externalModelName but different displayName', () => {
    function toSlugUpdated(model: {
      displayName?: string;
      externalModelName?: string;
      name?: string;
      _slug?: string;
    }): string {
      if (model._slug) return model._slug;
      const rawName = model.displayName || model.externalModelName || model.name || 'custom-model';
      return (
        'extm-' +
        rawName
          .replace(/^models\//, '')
          .replace(/[^a-zA-Z0-9]+/g, '-')
          .replace(/^-+|-+$/g, '')
          .toLowerCase()
      );
    }

    const modelA = {
      name: 'models/deepseek-v4-flash',
      displayName: 'DeepSeek V4 Flash',
      externalModelName: 'deepseek-v4-flash',
    };
    const modelB = {
      name: 'models/deepseek-v4-flash',
      displayName: 'DeepSeek V4 Flash 0731',
      externalModelName: 'deepseek-v4-flash',
    };

    const slugA = toSlugUpdated(modelA);
    const slugB = toSlugUpdated(modelB);

    expect(slugA).not.toBe(slugB);
    expect(slugA).toBe('extm-deepseek-v4-flash');
    expect(slugB).toBe('extm-deepseek-v4-flash-0731');
  });
});

describe('resolveFileData', () => {
  it('correctly resolves local file:// URI and replaces parts element with text content', async () => {
    const tmpDir = path.join(os.tmpdir(), 'proxy_filedata_test_' + Date.now());
    fs.mkdirSync(tmpDir, { recursive: true });
    const tmpFile = path.join(tmpDir, 'sample.txt');
    fs.writeFileSync(tmpFile, 'Hello World from fileData', 'utf-8');

    const fileUri = pathToFileURL(tmpFile).href;
    const body = {
      contents: [
        {
          parts: [
            {
              fileData: {
                mimeType: 'text/plain',
                fileUri: fileUri,
              },
            },
          ],
        },
      ],
    };

    await resolveFileData(body, {});

    expect(body.contents![0].parts![0]).toEqual({
      text: '[File content]:\n\nHello World from fileData',
    });

    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  });

  it('gracefully handles missing local file without crashing', async () => {
    const fakeUri = 'file:///non/existent/path/never_existed_' + Date.now() + '.txt';
    const body = {
      contents: [
        {
          parts: [
            {
              fileData: {
                mimeType: 'text/plain',
                fileUri: fakeUri,
              },
            },
          ],
        },
      ],
    };

    await resolveFileData(body, {});
    // Should remain fileData since resolving failed
    expect(body.contents![0].parts![0]).toHaveProperty('fileData');
  });
});

describe('decompressResponseBody', () => {
  it('decompresses gzip payloads', () => {
    const original = 'Hello, this is compressed via gzip!';
    const compressed = zlib.gzipSync(Buffer.from(original, 'utf-8'));
    const result = decompressResponseBody(compressed, 'gzip');
    expect(result.decompressed).toBe(true);
    expect(result.text).toBe(original);
  });

  it('decompresses brotli (br) payloads', () => {
    const original = 'Hello, this is compressed via brotli!';
    const compressed = zlib.brotliCompressSync(Buffer.from(original, 'utf-8'));
    const result = decompressResponseBody(compressed, 'br');
    expect(result.decompressed).toBe(true);
    expect(result.text).toBe(original);
  });

  it('decompresses deflate payloads', () => {
    const original = 'Hello, this is compressed via deflate!';
    const compressed = zlib.deflateSync(Buffer.from(original, 'utf-8'));
    const result = decompressResponseBody(compressed, 'deflate');
    expect(result.decompressed).toBe(true);
    expect(result.text).toBe(original);
  });

  it('handles identity or uncompressed payload', () => {
    const original = 'Plain text response';
    const buffer = Buffer.from(original, 'utf-8');
    const result = decompressResponseBody(buffer, undefined);
    expect(result.decompressed).toBe(true);
    expect(result.text).toBe(original);
  });

  it('returns decompressed: false on corrupted compressed payload', () => {
    const corruptBuffer = Buffer.from([0x1f, 0x8b, 0x00, 0x00, 0xff, 0xff]);
    const result = decompressResponseBody(corruptBuffer, 'gzip');
    expect(result.decompressed).toBe(false);
  });
});

describe('URL rewrite regex', () => {
  it('only strips /dummy_path_padding as a leading prefix', () => {
    const urlWithPrefix = '/dummy_path_padding/v1internal:fetchAvailableModels';
    const rewritten = urlWithPrefix.replace(/^\/dummy_path_padding/, '');
    expect(rewritten).toBe('/v1internal:fetchAvailableModels');

    const urlWithQueryParam = '/v1internal:fetchAvailableModels?redirect=/dummy_path_padding/test';
    const untouched = urlWithQueryParam.replace(/^\/dummy_path_padding/, '');
    expect(untouched).toBe(urlWithQueryParam);
  });
});
