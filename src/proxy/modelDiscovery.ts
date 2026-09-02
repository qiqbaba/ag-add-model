/**
 * Model Discovery Engine for Antigravity Custom Models.
 *
 * Probes a provider standard "list models" endpoint and returns available model
 * ids so the Web Dashboard can auto-fill the model form.
 *
 * Zero-dependency: reuses makeHttpRequest from ./connectionTest.
 */

import { makeHttpRequest } from './connectionTest';

export interface DiscoverParams {
  apiUrl: string;
  apiKey?: string;
  provider: string;
  allowUnauthorized?: boolean;
  timeout?: number;
}

export interface DiscoveredModel {
  id: string;
  displayName: string;
  /** Whether this upstream model id is already configured locally (dedup hint). */
  exists?: boolean;
}

export interface DiscoverResult {
  success: boolean;
  models: DiscoveredModel[];
  error?: string;
  details?: string;
  suggestion?: string;
  statusCode?: number;
  provider?: string;
  endpointUsed?: string;
  timestamp: string;
}

export type HeaderMap = { [key: string]: string };

function deriveModelsEndpoint(provider: string, apiUrl: string): string {
  const url = (apiUrl || '').trim();
  const p = (provider || 'openai').toLowerCase().trim();

  if (p === 'ollama') {
    const base = url.replace(/\/+$/, '').replace(/\/v1(\/chat\/completions)?$/, '');
    return (base || 'http://localhost:11434') + '/api/tags';
  }

  if (p === 'anthropic') {
    const base = url.replace(/\/+$/, '').replace(/\/v1(\/messages)?$/, '');
    return (base || 'https://api.anthropic.com') + '/v1/models';
  }

  if (p === 'google') {
    // Strip any existing /v1beta... or /models... suffix BEFORE appending,
    // otherwise ".../v1beta/models/x:generateContent" became ".../v1beta/v1beta/models".
    const base = url
      .replace(/\/+$/, '')
      .replace(/\/v1beta(\/.*)?$/, '')
      .replace(/\/models(\/.*)?$/, '');
    return (base || 'https://generativelanguage.googleapis.com') + '/v1beta/models';
  }

  const base = url.replace(/\/+$/, '').replace(/\/chat\/completions$/, '').replace(/\/completions$/, '');
  return (base || 'https://api.openai.com/v1') + '/models';
}

function toDisplayName(id: string): string {
  return id
    .replace(/^models\//, '')
    .replace(/[-_]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .map((w) => (w ? w.charAt(0).toUpperCase() + w.slice(1) : w))
    .join(' ');
}

async function fetchJson(endpoint: string, params: DiscoverParams, headers: HeaderMap) {
  const timeoutMs = params.timeout && params.timeout > 0 ? Math.min(params.timeout, 30000) : 10000;
  const res = await makeHttpRequest(endpoint, { method: 'GET', headers }, null, timeoutMs, params.allowUnauthorized);
  return { statusCode: res.statusCode, body: res.body };
}

function parseOpenAiCompatible(body: string): DiscoveredModel[] {
  try {
    const parsed = JSON.parse(body);
    return (parsed.data || []).map((m) => m.id || '').filter(Boolean).map((id) => ({ id, displayName: toDisplayName(id) }));
  } catch (_e) { return []; }
}

function parseOllama(body: string): DiscoveredModel[] {
  try {
    const parsed = JSON.parse(body);
    return (parsed.models || []).map((m) => m.name || '').filter(Boolean).map((id) => ({ id, displayName: toDisplayName(id) }));
  } catch (_e) { return []; }
}

function parseAnthropic(body: string): DiscoveredModel[] {
  try {
    const parsed = JSON.parse(body);
    return (parsed.data || []).map((m) => ({ id: m.id || '', displayName: m.display_name || toDisplayName(m.id || '') })).filter((m) => m.id);
  } catch (_e) { return []; }
}

function parseGoogle(body: string): DiscoveredModel[] {
  try {
    const parsed = JSON.parse(body);
    return (parsed.models || []).map((m) => ({ id: m.name || '', displayName: m.displayName || toDisplayName(m.name || '') })).filter((m) => m.id);
  } catch (_e) { return []; }
}

function diagnoseDiscoverError(statusCode, errMessage, provider) {
  if (statusCode === 401) return { error: '鉴权失败 (401 Unauthorized)', suggestion: 'API Key 无效、已过期或未填写。请检查模型表单中的 API Key 是否正确。' };
  if (statusCode === 403) return { error: '访问被拒绝 (403 Forbidden)', suggestion: '当前 API Key 无权访问该模型列表接口，或存在 IP/地区限制。' };
  if (statusCode === 404) return { error: '端点或模型不存在 (404 Not Found)', suggestion: '该端点可能不支持 /models 列表接口，或 apiUrl 拼写有误。可改用手动填写 externalModelName。' };
  if (statusCode && statusCode >= 500) return { error: '上游服务故障 (' + statusCode + ' Server Error)', suggestion: '提供商服务器暂时性故障，请稍后重试。' };
  if (errMessage.includes('ECONNREFUSED')) return { error: '连接被拒绝 (ECONNREFUSED)', suggestion: (provider === 'ollama' ? '本地 Ollama 服务未启动或端口不正确。请在终端执行 ollama serve 启动服务。' : '目标服务器拒绝连接，请检查 apiUrl 中的 IP/端口是否正确。') };
  if (errMessage.includes('ENOTFOUND')) return { error: '无法解析域名 (ENOTFOUND)', suggestion: '域名解析失败，请检查 apiUrl 主机名拼写与本地网络。' };
  if (errMessage.includes('timed out')) return { error: '请求超时 (Timeout)', suggestion: '上游连接超时，可尝试检查网络/代理或调大 timeout。' };
  if (errMessage.includes('CERT') || errMessage.includes('certificate') || errMessage.includes('SSL')) return { error: 'SSL 证书校验失败 (Certificate Error)', suggestion: '目标使用自签名证书。若确信安全，可在高级设置中勾选【允许自签名证书】。' };
  return { error: errMessage || ('HTTP ' + (statusCode || 'Unknown') + ' 错误'), suggestion: '请核对 apiUrl、provider 与 API Key 配置。' };
}

export async function discoverModels(params: DiscoverParams): Promise<DiscoverResult> {
  const timestamp = new Date().toISOString();
  const provider = (params.provider || 'openai').toLowerCase().trim();
  const apiKey = (params.apiKey || '').trim();

  if (!params.apiUrl || !params.apiUrl.trim()) {
    return { success: false, models: [], error: 'Missing apiUrl', suggestion: '请先填写完整 API URL 再点击【自动获取模型】。', provider, timestamp };
  }

  const endpoint = deriveModelsEndpoint(provider, params.apiUrl);

  try {
    const headers: HeaderMap = { 'content-type': 'application/json' };
    if (apiKey && apiKey !== 'none') {
      if (provider === 'anthropic') { headers['x-api-key'] = apiKey; headers['anthropic-version'] = '2023-06-01'; }
      else if (provider === 'google') { headers['x-goog-api-key'] = apiKey; }
      else { headers['authorization'] = 'Bearer ' + apiKey; }
    }

    const { statusCode, body } = await fetchJson(endpoint, params, headers);
    const models = parseForProvider(provider, body);

    if (statusCode >= 200 && statusCode < 300) {
      return { success: true, models, statusCode, provider, endpointUsed: endpoint, timestamp };
    }

    const diag = diagnoseDiscoverError(statusCode, 'HTTP ' + statusCode, provider);
    return { success: false, models: [], error: diag.error, suggestion: diag.suggestion, details: body.slice(0, 300), statusCode, provider, endpointUsed: endpoint, timestamp };
  } catch (err) {
    const errMsg = (err as Error).message || String(err);
    const diag = diagnoseDiscoverError(undefined, errMsg, provider);
    return { success: false, models: [], error: diag.error, suggestion: diag.suggestion, details: errMsg, provider, endpointUsed: endpoint, timestamp };
  }
}

function parseForProvider(provider: string, body: string): DiscoveredModel[] {
  const p = (provider || 'openai').toLowerCase().trim();
  if (p === 'ollama') return parseOllama(body);
  if (p === 'anthropic') return parseAnthropic(body);
  if (p === 'google') return parseGoogle(body);
  return parseOpenAiCompatible(body);
}
