import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as http from 'http';
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

import { startProxy, stopProxy, getProxyPort } from '../proxy';

describe('Dashboard and REST API endpoints', () => {
  const tempDir = path.join(os.tmpdir(), 'agy_dash_test_' + Date.now());
  const tempConfigFile = path.join(tempDir, '.gemini', 'antigravity', 'custom_models.json');
  let port = 0;

  beforeEach(async () => {
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
              apiKey: 'sk-proj-test123456',
              externalModelName: 'gpt-4o',
            },
          ],
        },
        null,
        2,
      ),
      'utf-8',
    );

    port = await startProxy();
  });

  afterEach(async () => {
    await stopProxy();
    try {
      if (fs.existsSync(tempDir)) {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    } catch (_e) {
      // ignore
    }
  });

  function makeRequest(
    method: string,
    reqPath: string,
    body?: string,
  ): Promise<{ statusCode: number; headers: http.IncomingHttpHeaders; body: string }> {
    return new Promise((resolve, reject) => {
      const req = http.request(
        {
          hostname: '127.0.0.1',
          port: port,
          path: reqPath,
          method: method,
          headers: {
            'Content-Type': 'application/json',
            ...(body ? { 'Content-Length': Buffer.byteLength(body, 'utf-8').toString() } : {}),
          },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => {
            resolve({
              statusCode: res.statusCode || 0,
              headers: res.headers,
              body: Buffer.concat(chunks).toString('utf-8'),
            });
          });
        },
      );

      req.on('error', reject);
      if (body) req.write(body);
      req.end();
    });
  }

  it('should serve Dashboard HTML on GET /', async () => {
    const res = await makeRequest('GET', '/');
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
    expect(res.body).toContain('Antigravity Models');
    expect(res.body).toContain('快速预设模板');
  });

  it('should return system status on GET /api/status', async () => {
    const res = await makeRequest('GET', '/api/status');
    expect(res.statusCode).toBe(200);
    const json = JSON.parse(res.body);
    expect(json.proxyPort).toBe(port);
    expect(json.modelsCount).toBeGreaterThanOrEqual(1);
  });

  it('should return models list on GET /api/models', async () => {
    const res = await makeRequest('GET', '/api/models');
    expect(res.statusCode).toBe(200);
    const json = JSON.parse(res.body);
    expect(Array.isArray(json)).toBe(true);
    expect(json.length).toBe(1);
    expect(json[0].name).toBe('models/gpt-4o');
    expect(json[0].apiKeyMasked).toContain('••••');
  });

  it('should save a new model via POST /api/models', async () => {
    const newModel = {
      name: 'models/deepseek-v3',
      displayName: 'DeepSeek V3',
      provider: 'openai',
      apiUrl: 'https://api.deepseek.com/v1/chat/completions',
      apiKey: 'sk-ds-testkey',
      externalModelName: 'deepseek-chat',
    };

    const res = await makeRequest('POST', '/api/models', JSON.stringify(newModel));
    expect(res.statusCode).toBe(200);
    const json = JSON.parse(res.body);
    expect(json.success).toBe(true);
    expect(json.model.name).toBe('models/deepseek-v3');

    // Verify GET /api/models now returns 2 models
    const listRes = await makeRequest('GET', '/api/models');
    const listJson = JSON.parse(listRes.body);
    expect(listJson.length).toBe(2);
  });

  it('should delete a model via DELETE /api/models', async () => {
    const res = await makeRequest('DELETE', '/api/models', JSON.stringify({ name: 'models/gpt-4o' }));
    expect(res.statusCode).toBe(200);
    const json = JSON.parse(res.body);
    expect(json.success).toBe(true);
    expect(json.remainingCount).toBe(0);
  });

  it('should test model connection via POST /api/models/test', async () => {
    const res = await makeRequest(
      'POST',
      '/api/models/test',
      JSON.stringify({
        provider: 'openai',
        apiUrl: '',
      }),
    );
    expect(res.statusCode).toBe(200);
    const json = JSON.parse(res.body);
    expect(json.success).toBe(false);
    expect(json.message).toContain('未提供 apiUrl');
  });

  it('should read and update raw config via /api/models/raw', async () => {
    const getRes = await makeRequest('GET', '/api/models/raw');
    expect(getRes.statusCode).toBe(200);
    expect(getRes.body).toContain('models/gpt-4o');

    const updateRes = await makeRequest(
      'PUT',
      '/api/models/raw',
      JSON.stringify({
        models: [
          {
            name: 'models/claude-3-5',
            displayName: 'Claude 3.5',
            provider: 'anthropic',
            apiUrl: 'https://api.anthropic.com/v1/messages',
            apiKey: 'sk-ant-test',
            externalModelName: 'claude-3-5-sonnet-20241022',
          },
        ],
      }),
    );
    expect(updateRes.statusCode).toBe(200);
    const updateJson = JSON.parse(updateRes.body);
    expect(updateJson.success).toBe(true);
    expect(updateJson.count).toBe(1);
  });
});
