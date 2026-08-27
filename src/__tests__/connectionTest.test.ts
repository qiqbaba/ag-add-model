import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as http from 'http';
import { testModelConnection } from '../proxy/connectionTest';

describe('connectionTest with local mock servers', () => {
  let mockServer: http.Server | null = null;
  let mockPort = 0;

  afterEach(async () => {
    if (mockServer) {
      await new Promise<void>((resolve) => mockServer!.close(() => resolve()));
      mockServer = null;
    }
  });

  it('should return error when apiUrl is missing', async () => {
    const res = await testModelConnection({
      provider: 'openai',
      apiUrl: '',
      apiKey: 'test-key',
    });
    expect(res.success).toBe(false);
    expect(res.message).toContain('未提供 apiUrl');
  });

  it('should test OpenAI connection successfully on 200 response', async () => {
    mockServer = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        expect(req.headers['authorization']).toBe('Bearer sk-test');
        const parsed = JSON.parse(body);
        expect(parsed.model).toBe('gpt-4o-mini');

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            choices: [{ message: { content: 'Hello from mock OpenAI' } }],
          }),
        );
      });
    });

    await new Promise<void>((resolve) => {
      mockServer!.listen(0, '127.0.0.1', () => {
        mockPort = (mockServer!.address() as any).port;
        resolve();
      });
    });

    const res = await testModelConnection({
      provider: 'openai',
      apiUrl: `http://127.0.0.1:${mockPort}/v1/chat/completions`,
      apiKey: 'sk-test',
      externalModelName: 'gpt-4o-mini',
    });

    expect(res.success).toBe(true);
    expect(res.statusCode).toBe(200);
    expect(res.reply).toBe('Hello from mock OpenAI');
    expect(res.latencyMs).toBeGreaterThanOrEqual(0);
    expect(res.modelUsed).toBe('gpt-4o-mini');
  });

  it('should handle 401 Unauthorized with helpful diagnostics', async () => {
    mockServer = http.createServer((_req, res) => {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          error: { message: 'Incorrect API key provided' },
        }),
      );
    });

    await new Promise<void>((resolve) => {
      mockServer!.listen(0, '127.0.0.1', () => {
        mockPort = (mockServer!.address() as any).port;
        resolve();
      });
    });

    const res = await testModelConnection({
      provider: 'openai',
      apiUrl: `http://127.0.0.1:${mockPort}/v1`,
      apiKey: 'invalid-key',
      externalModelName: 'gpt-4o',
    });

    expect(res.success).toBe(false);
    expect(res.statusCode).toBe(401);
    expect(res.error).toContain('鉴权失败');
    expect(res.suggestion).toContain('API Key');
  });

  it('should test Anthropic connection format and headers', async () => {
    mockServer = http.createServer((req, res) => {
      expect(req.headers['x-api-key']).toBe('sk-ant-test');
      expect(req.headers['anthropic-version']).toBe('2023-06-01');

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          content: [{ type: 'text', text: 'Hello from Claude' }],
        }),
      );
    });

    await new Promise<void>((resolve) => {
      mockServer!.listen(0, '127.0.0.1', () => {
        mockPort = (mockServer!.address() as any).port;
        resolve();
      });
    });

    const res = await testModelConnection({
      provider: 'anthropic',
      apiUrl: `http://127.0.0.1:${mockPort}/v1/messages`,
      apiKey: 'sk-ant-test',
      externalModelName: 'claude-3-5-sonnet-20241022',
    });

    expect(res.success).toBe(true);
    expect(res.statusCode).toBe(200);
    expect(res.reply).toBe('Hello from Claude');
    expect(res.modelUsed).toBe('claude-3-5-sonnet-20241022');
  });

  it('should test Google AI Studio connection successfully', async () => {
    mockServer = http.createServer((req, res) => {
      expect(req.headers['x-goog-api-key']).toBe('ai-studio-key');

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          candidates: [{ content: { parts: [{ text: 'Hello from Gemini' }] } }],
        }),
      );
    });

    await new Promise<void>((resolve) => {
      mockServer!.listen(0, '127.0.0.1', () => {
        mockPort = (mockServer!.address() as any).port;
        resolve();
      });
    });

    const res = await testModelConnection({
      provider: 'google',
      apiUrl: `http://127.0.0.1:${mockPort}/v1beta`,
      apiKey: 'ai-studio-key',
      externalModelName: 'gemini-2.0-flash',
    });

    expect(res.success).toBe(true);
    expect(res.statusCode).toBe(200);
    expect(res.reply).toBe('Hello from Gemini');
  });

  it('should test Ollama connection successfully over HTTP', async () => {
    mockServer = http.createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          choices: [{ message: { content: 'Hello from Ollama llama3' } }],
        }),
      );
    });

    await new Promise<void>((resolve) => {
      mockServer!.listen(0, '127.0.0.1', () => {
        mockPort = (mockServer!.address() as any).port;
        resolve();
      });
    });

    const res = await testModelConnection({
      provider: 'ollama',
      apiUrl: `http://127.0.0.1:${mockPort}/v1/chat/completions`,
      externalModelName: 'llama3',
    });

    expect(res.success).toBe(true);
    expect(res.statusCode).toBe(200);
    expect(res.reply).toBe('Hello from Ollama llama3');
  });

  it('should handle network connection refused (ECONNREFUSED)', async () => {
    const res = await testModelConnection({
      provider: 'ollama',
      apiUrl: 'http://127.0.0.1:49999/v1/chat/completions',
      externalModelName: 'llama3',
    });

    expect(res.success).toBe(false);
    expect(res.error).toContain('ECONNREFUSED');
    expect(res.suggestion).toContain('ollama serve');
  });
});
