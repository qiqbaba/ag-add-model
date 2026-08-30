/**
 * Connection Test Engine for Antigravity Custom Models.
 *
 * Tests upstream model provider connectivity, latency, and credentials
 * for OpenAI, Anthropic, Google AI Studio, Ollama, and OpenAI-compatible providers.
 */

import * as http from 'http';
import * as https from 'https';
import { URL } from 'url';

export interface TestConnectionParams {
  name?: string;
  displayName?: string;
  provider: string;
  apiUrl: string;
  apiKey?: string;
  externalModelName?: string;
  allowUnauthorized?: boolean;
  timeout?: number;
}

export interface TestConnectionResult {
  success: boolean;
  statusCode?: number;
  latencyMs: number;
  message: string;
  reply?: string;
  modelUsed?: string;
  error?: string;
  details?: string;
  suggestion?: string;
  timestamp: string;
}

/**
 * Normalizes OpenAI-compatible URLs to ensure they point to the chat completions endpoint.
 */
function normalizeOpenAiUrl(apiUrl: string, isOllama = false): string {
  let url = apiUrl.trim();
  if (isOllama && url.match(/^https?:\/\/localhost\/?$/i)) {
    url = 'http://localhost:11434';
  }
  const urlLower = url.toLowerCase();
  if (!urlLower.includes('/chat/completions') && !urlLower.includes('/completions')) {
    if (url.endsWith('/v1')) {
      url += '/chat/completions';
    } else if (url.endsWith('/')) {
      url += 'v1/chat/completions';
    } else {
      url += '/v1/chat/completions';
    }
  }
  return url;
}

/**
 * Executes a network request with timeout and error handling.
 */
function makeHttpRequest(
  targetUrl: string,
  options: https.RequestOptions,
  bodyData: string | null,
  timeoutMs: number,
  allowUnauthorized = false,
): Promise<{ statusCode: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(targetUrl);
    const isHttps = parsed.protocol === 'https:';
    const client = isHttps ? https : http;

    const reqOptions: https.RequestOptions = {
      ...options,
      hostname: parsed.hostname,
      port: parsed.port || (isHttps ? 443 : 80),
      path: parsed.pathname + parsed.search,
      timeout: timeoutMs,
    };

    if (allowUnauthorized && isHttps) {
      (reqOptions as Record<string, unknown>).rejectUnauthorized = false;
    }

    const req = client.request(reqOptions, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => {
        const fullBody = Buffer.concat(chunks).toString('utf-8');
        resolve({
          statusCode: res.statusCode || 0,
          headers: res.headers,
          body: fullBody,
        });
      });
    });

    req.on('timeout', () => {
      req.destroy(new Error(`Request timed out after ${timeoutMs}ms`));
    });

    req.on('error', (err) => {
      reject(err);
    });

    if (bodyData) {
      req.write(bodyData);
    }
    req.end();
  });
}

/**
 * Diagnoses error responses and provides helpful troubleshooting suggestions in Chinese.
 */
function diagnoseError(
  statusCode: number | undefined,
  errMessage: string,
  responseBody: string,
  provider: string,
): { error: string; details: string; suggestion: string } {
  const bodyText = responseBody ? responseBody.slice(0, 500) : '';

  if (statusCode === 401) {
    return {
      error: '鉴权失败 (401 Unauthorized)',
      details: bodyText || errMessage,
      suggestion: 'API Key 无效、已过期或未填写。请检查 API Key 是否正确，且该账户未欠费或被停用。',
    };
  }

  if (statusCode === 403) {
    return {
      error: '访问被拒绝 (403 Forbidden)',
      details: bodyText || errMessage,
      suggestion: '当前 API Key 无权访问该模型，或存在 IP 白名单/国家地区访问限制。',
    };
  }

  if (statusCode === 404) {
    return {
      error: '端点或模型不存在 (404 Not Found)',
      details: bodyText || errMessage,
      suggestion:
        '请检查 API URL 路径是否正确（如缺少 /v1/chat/completions），或 externalModelName（外部模型名称）是否拼写有误。',
    };
  }

  if (statusCode === 429) {
    return {
      error: '请求过于频繁或额度超限 (429 Too Many Requests / Quota Exceeded)',
      details: bodyText || errMessage,
      suggestion: '上游 API 账户额度已耗尽或触发了频率限制 (Rate Limit)，请充值或稍后重试。',
    };
  }

  if (statusCode && statusCode >= 500) {
    return {
      error: `上游服务故障 (${statusCode} Server Error)`,
      details: bodyText || errMessage,
      suggestion: '提供商服务器内部错误或负载过高，通常为暂时性故障，请稍后重试。',
    };
  }

  if (errMessage.includes('ECONNREFUSED')) {
    return {
      error: '连接被拒绝 (ECONNREFUSED)',
      details: errMessage,
      suggestion:
        provider === 'ollama'
          ? '本地 Ollama 服务未启动或端口不正确。请在终端执行 `ollama serve` 启动服务。'
          : '目标服务器拒绝连接，请检查 apiUrl 中的 IP / 端口是否正确或服务是否处于运行状态。',
    };
  }

  if (errMessage.includes('ENOTFOUND')) {
    return {
      error: '无法解析域名 (ENOTFOUND)',
      details: errMessage,
      suggestion: '域名解析失败，请检查 apiUrl 中的主机名拼写是否正确，以及本地 DNS / 网络是否正常。',
    };
  }

  if (errMessage.includes('timed out')) {
    return {
      error: '请求超时 (Timeout)',
      details: errMessage,
      suggestion: '上游连接在规定时间内未响应。可尝试检查网络代理或调大该模型的 timeout 设置。',
    };
  }

  if (errMessage.includes('CERT') || errMessage.includes('certificate') || errMessage.includes('SSL')) {
    return {
      error: 'SSL 证书校验失败 (Certificate Error)',
      details: errMessage,
      suggestion:
        '目标使用了自签名证书或企业代理证书。若确信网络安全，可在高级设置中勾选【允许自签名证书 (SSL bypass)】。',
    };
  }

  return {
    error: errMessage || `HTTP ${statusCode || 'Unknown'} 错误`,
    details: bodyText,
    suggestion: '请核对 apiUrl、externalModelName 及 API Key 配置。',
  };
}

/**
 * Tests connectivity for a given model configuration.
 */
export async function testModelConnection(params: TestConnectionParams): Promise<TestConnectionResult> {
  const startTime = Date.now();
  const timeoutMs = params.timeout && params.timeout > 0 ? Math.min(params.timeout, 60_000) : 15_000;
  const provider = (params.provider || 'openai').toLowerCase().trim();
  const apiKey = (params.apiKey || '').trim();
  const rawUrl = (params.apiUrl || '').trim();
  const externalModel = (params.externalModelName || '').trim();

  const timestamp = new Date().toISOString();

  if (!rawUrl) {
    return {
      success: false,
      latencyMs: 0,
      message: '测试失败：未提供 apiUrl',
      error: 'Missing apiUrl',
      suggestion: '请输入有效的 API URL (如 https://api.openai.com/v1/chat/completions)',
      timestamp,
    };
  }

  try {
    // ── 1. Anthropic ────────────────────────────────────────────────────────
    if (provider === 'anthropic') {
      const targetUrl = rawUrl.endsWith('/messages') ? rawUrl : rawUrl.replace(/\/+$/, '') + '/messages';
      const modelName = externalModel || 'claude-3-5-haiku-20241022';
      const body = JSON.stringify({
        model: modelName,
        max_tokens: 10,
        messages: [{ role: 'user', content: 'Hi' }],
      });

      const headers: Record<string, string> = {
        'content-type': 'application/json',
        'anthropic-version': '2023-06-01',
      };
      if (apiKey && apiKey !== 'none') {
        headers['x-api-key'] = apiKey;
      }

      const res = await makeHttpRequest(
        targetUrl,
        { method: 'POST', headers },
        body,
        timeoutMs,
        params.allowUnauthorized,
      );
      const latencyMs = Date.now() - startTime;

      if (res.statusCode >= 200 && res.statusCode < 300) {
        let reply = '';
        try {
          const parsed = JSON.parse(res.body) as { content?: { text?: string }[] };
          reply = parsed.content?.[0]?.text || 'OK';
        } catch (_e) {
          reply = 'OK';
        }
        return {
          success: true,
          statusCode: res.statusCode,
          latencyMs,
          message: '连通性测试通过',
          reply: reply.trim(),
          modelUsed: modelName,
          timestamp,
        };
      } else {
        const diag = diagnoseError(res.statusCode, `HTTP ${res.statusCode}`, res.body, provider);
        return {
          success: false,
          statusCode: res.statusCode,
          latencyMs,
          message: `测试失败: ${diag.error}`,
          error: diag.error,
          details: diag.details,
          suggestion: diag.suggestion,
          modelUsed: modelName,
          timestamp,
        };
      }
    }

    // ── 2. Google AI Studio ────────────────────────────────────────────────
    if (provider === 'google') {
      const modelName = externalModel || 'gemini-2.0-flash';
      let targetUrl = rawUrl;
      if (!targetUrl.includes(':generateContent')) {
        const cleanBase = targetUrl.replace(/\/+$/, '');
        targetUrl = cleanBase.includes('/models/')
          ? `${cleanBase}:generateContent`
          : `${cleanBase}/models/${modelName}:generateContent`;
      }
      if (apiKey && apiKey !== 'none' && !targetUrl.includes('key=')) {
        const joiner = targetUrl.includes('?') ? '&' : '?';
        targetUrl += `${joiner}key=${encodeURIComponent(apiKey)}`;
      }

      const body = JSON.stringify({
        contents: [{ parts: [{ text: 'Hi' }] }],
        generationConfig: { maxOutputTokens: 10 },
      });

      const headers: Record<string, string> = {
        'content-type': 'application/json',
      };
      if (apiKey && apiKey !== 'none') {
        headers['x-goog-api-key'] = apiKey;
      }

      const res = await makeHttpRequest(
        targetUrl,
        { method: 'POST', headers },
        body,
        timeoutMs,
        params.allowUnauthorized,
      );
      const latencyMs = Date.now() - startTime;

      if (res.statusCode >= 200 && res.statusCode < 300) {
        let reply = '';
        try {
          const parsed = JSON.parse(res.body) as {
            candidates?: { content?: { parts?: { text?: string }[] } }[];
          };
          reply = parsed.candidates?.[0]?.content?.parts?.[0]?.text || 'OK';
        } catch (_e) {
          reply = 'OK';
        }
        return {
          success: true,
          statusCode: res.statusCode,
          latencyMs,
          message: '连通性测试通过',
          reply: reply.trim(),
          modelUsed: modelName,
          timestamp,
        };
      } else {
        const diag = diagnoseError(res.statusCode, `HTTP ${res.statusCode}`, res.body, provider);
        return {
          success: false,
          statusCode: res.statusCode,
          latencyMs,
          message: `测试失败: ${diag.error}`,
          error: diag.error,
          details: diag.details,
          suggestion: diag.suggestion,
          modelUsed: modelName,
          timestamp,
        };
      }
    }

    // ── 3. Ollama ──────────────────────────────────────────────────────────
    if (provider === 'ollama') {
      const modelName = externalModel || 'llama3';
      const targetUrl = normalizeOpenAiUrl(rawUrl, true);
      const body = JSON.stringify({
        model: modelName,
        messages: [{ role: 'user', content: 'Hi' }],
        max_tokens: 10,
        stream: false,
      });

      const headers: Record<string, string> = {
        'content-type': 'application/json',
      };

      const res = await makeHttpRequest(
        targetUrl,
        { method: 'POST', headers },
        body,
        timeoutMs,
        params.allowUnauthorized,
      );
      const latencyMs = Date.now() - startTime;

      if (res.statusCode >= 200 && res.statusCode < 300) {
        let reply = '';
        try {
          const parsed = JSON.parse(res.body) as {
            choices?: { message?: { content?: string } }[];
          };
          reply = parsed.choices?.[0]?.message?.content || 'OK';
        } catch (_e) {
          reply = 'OK';
        }
        return {
          success: true,
          statusCode: res.statusCode,
          latencyMs,
          message: '连通性测试通过',
          reply: reply.trim(),
          modelUsed: modelName,
          timestamp,
        };
      } else {
        const diag = diagnoseError(res.statusCode, `HTTP ${res.statusCode}`, res.body, provider);
        return {
          success: false,
          statusCode: res.statusCode,
          latencyMs,
          message: `测试失败: ${diag.error}`,
          error: diag.error,
          details: diag.details,
          suggestion: diag.suggestion,
          modelUsed: modelName,
          timestamp,
        };
      }
    }

    // ── 4. OpenAI & Standard OpenAI-compatible Providers ──────────────────
    // Includes: OpenAI, DeepSeek, OpenRouter, SiliconFlow, SenseNova, Moonshot, Custom, etc.
    const targetUrl = normalizeOpenAiUrl(rawUrl);
    const modelName = externalModel || 'gpt-4o-mini';
    const body = JSON.stringify({
      model: modelName,
      messages: [{ role: 'user', content: 'Hi' }],
      max_tokens: 10,
      stream: false,
    });

    const headers: Record<string, string> = {
      'content-type': 'application/json',
    };
    if (apiKey && apiKey !== 'none') {
      headers['authorization'] = `Bearer ${apiKey}`;
    }
    if (targetUrl.includes('openrouter.ai')) {
      headers['HTTP-Referer'] = 'https://antigravity.google';
      headers['X-Title'] = 'Antigravity IDE';
    }

    const res = await makeHttpRequest(
      targetUrl,
      { method: 'POST', headers },
      body,
      timeoutMs,
      params.allowUnauthorized,
    );
    const latencyMs = Date.now() - startTime;

    if (res.statusCode >= 200 && res.statusCode < 300) {
      let reply = '';
      try {
        const parsed = JSON.parse(res.body) as {
          choices?: { message?: { content?: string } }[];
        };
        reply = parsed.choices?.[0]?.message?.content || 'OK';
      } catch (_e) {
        reply = 'OK';
      }
      return {
        success: true,
        statusCode: res.statusCode,
        latencyMs,
        message: '连通性测试通过',
        reply: reply.trim(),
        modelUsed: modelName,
        timestamp,
      };
    } else {
      const diag = diagnoseError(res.statusCode, `HTTP ${res.statusCode}`, res.body, provider);
      return {
        success: false,
        statusCode: res.statusCode,
        latencyMs,
        message: `测试失败: ${diag.error}`,
        error: diag.error,
        details: diag.details,
        suggestion: diag.suggestion,
        modelUsed: modelName,
        timestamp,
      };
    }
  } catch (err) {
    const latencyMs = Date.now() - startTime;
    const errMsg = (err as Error).message || String(err);
    const diag = diagnoseError(undefined, errMsg, '', provider);
    return {
      success: false,
      latencyMs,
      message: `网络错误: ${diag.error}`,
      error: diag.error,
      details: diag.details,
      suggestion: diag.suggestion,
      modelUsed: externalModel || undefined,
      timestamp,
    };
  }
}
