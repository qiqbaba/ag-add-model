import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn((name: string) => {
      if (name === 'home') return process.env.USERPROFILE || '/mock/home';
      return '/mock/' + name;
    }),
  },
  safeStorage: {
    isEncryptionAvailable: vi.fn(() => false),
    encryptString: vi.fn((str: string) => Buffer.from(str)),
    decryptString: vi.fn((buf: Buffer) => buf.toString()),
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

import {
  maskApiKey,
  generateSlug,
  generatePlaceholderId,
  saveCustomModel,
  deleteCustomModel,
  getModelsViewModel,
  getRawConfig,
  saveRawConfig,
  getSystemInfo,
  readDecryptedModels,
} from '../proxy/modelConfigManager';

describe('modelConfigManager', () => {
  const tempDir = path.join(os.tmpdir(), 'agy_mcm_test_' + Date.now());
  const tempConfigFile = path.join(tempDir, '.gemini', 'antigravity', 'custom_models.json');

  beforeEach(() => {
    process.env.USERPROFILE = tempDir;
    process.env.HOME = tempDir;
    fs.mkdirSync(path.dirname(tempConfigFile), { recursive: true });
    fs.writeFileSync(
      tempConfigFile,
      JSON.stringify(
        {
          models: [
            {
              name: 'models/gpt-4o',
              displayName: 'GPT-4o',
              description: 'OpenAI model',
              provider: 'openai',
              apiUrl: 'https://api.openai.com/v1/chat/completions',
              apiKey: 'sk-proj-1234567890abcdef',
              externalModelName: 'gpt-4o',
            },
          ],
        },
        null,
        2,
      ),
      'utf-8',
    );
  });

  afterEach(() => {
    try {
      if (fs.existsSync(tempDir)) {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    } catch (_e) {
      // ignore
    }
  });

  it('should mask API keys properly', () => {
    expect(maskApiKey('')).toBe('(none)');
    expect(maskApiKey('none')).toBe('(none)');
    expect(maskApiKey('12345678')).toBe('••••••••');
    expect(maskApiKey('sk-proj-1234567890abcdef')).toMatch(/^sk-p.*••••••••.*cdef$/);
  });

  it('should generate consistent slugs and placeholder IDs', () => {
    const model = {
      name: 'models/deepseek-v3',
      displayName: 'DeepSeek V3',
      description: '',
      provider: 'openai',
      apiUrl: 'https://api.deepseek.com/v1/chat/completions',
      apiKey: 'sk-test',
      externalModelName: 'deepseek-chat',
    };
    const slug = generateSlug(model);
    expect(slug).toBe('extm-deepseek-v3');

    const pid = generatePlaceholderId(model);
    expect(pid).toMatch(/^MODEL_PLACEHOLDER_M\d+$/);
  });

  it('should get models view model with masked keys by default', () => {
    const vms = getModelsViewModel(false);
    expect(vms.length).toBe(1);
    expect(vms[0].name).toBe('models/gpt-4o');
    expect(vms[0].apiKey).toBeUndefined();
    expect(vms[0].hasKey).toBe(true);
    expect(vms[0].apiKeyMasked).toContain('••••');
    expect(vms[0].validation.valid).toBe(true);
  });

  it('should get models view model with full keys when includeKeys is true', () => {
    const vms = getModelsViewModel(true);
    expect(vms.length).toBe(1);
    expect(vms[0].apiKey).toBe('sk-proj-1234567890abcdef');
  });

  it('should save a new model and auto-prepend models/ prefix', () => {
    const res = saveCustomModel({
      name: 'claude-3-5',
      displayName: 'Claude 3.5 Sonnet',
      provider: 'anthropic',
      apiUrl: 'https://api.anthropic.com/v1/messages',
      apiKey: 'sk-ant-test',
      externalModelName: 'claude-3-5-sonnet-20241022',
    });

    expect(res.success).toBe(true);
    expect(res.model?.name).toBe('models/claude-3-5');

    const updated = readDecryptedModels();
    expect(updated.length).toBe(2);
    expect(updated.find((m) => m.name === 'models/claude-3-5')).toBeDefined();
  });

  it('should update an existing model and preserve key when key is masked', () => {
    const res = saveCustomModel({
      name: 'models/gpt-4o',
      displayName: 'GPT-4o Updated Name',
      provider: 'openai',
      apiUrl: 'https://api.openai.com/v1/chat/completions',
      apiKey: 'sk-••••••••cdef', // masked key
      externalModelName: 'gpt-4o',
    });

    expect(res.success).toBe(true);
    expect(res.model?.displayName).toBe('GPT-4o Updated Name');

    const updated = readDecryptedModels();
    const gpt = updated.find((m) => m.name === 'models/gpt-4o');
    expect(gpt?.apiKey).toBe('sk-proj-1234567890abcdef'); // preserved original
  });

  it('should reject saving invalid model without required fields', () => {
    const res = saveCustomModel({
      name: 'invalid',
      apiUrl: 'not-a-url',
    });
    expect(res.success).toBe(false);
    expect(res.error).toBeDefined();
  });

  it('should delete an existing custom model', () => {
    const res = deleteCustomModel('models/gpt-4o');
    expect(res.success).toBe(true);
    expect(res.remainingCount).toBe(0);

    const after = readDecryptedModels();
    expect(after.length).toBe(0);
  });

  it('should return error when deleting non-existent model', () => {
    const res = deleteCustomModel('models/non-existent');
    expect(res.success).toBe(false);
    expect(res.error).toContain('未找到模型');
  });

  it('should read and save raw JSON config', () => {
    const raw = getRawConfig();
    expect(raw).toContain('models/gpt-4o');

    const newRaw = JSON.stringify({
      models: [
        {
          name: 'models/deepseek-v3',
          displayName: 'DeepSeek V3',
          description: 'DeepSeek model',
          provider: 'openai',
          apiUrl: 'https://api.deepseek.com/v1/chat/completions',
          apiKey: 'sk-ds-test',
          externalModelName: 'deepseek-chat',
        },
      ],
    });

    const saveRes = saveRawConfig(newRaw);
    expect(saveRes.success).toBe(true);
    expect(saveRes.count).toBe(1);

    const models = readDecryptedModels();
    expect(models.length).toBe(1);
    expect(models[0].name).toBe('models/deepseek-v3');
  });

  it('should reject invalid raw JSON config structure', () => {
    const res = saveRawConfig('{"invalid": true}');
    expect(res.success).toBe(false);
    expect(res.error).toContain('models');
  });

  it('should return diagnostic system info', () => {
    const info = getSystemInfo(50999);
    expect(info.proxyPort).toBe(50999);
    expect(info.customModelsPath).toContain('custom_models.json');
    expect(info.modelsCount).toBeGreaterThanOrEqual(1);
  });
});
