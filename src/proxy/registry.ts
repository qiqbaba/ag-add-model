/**
 * Provider Translator Registry.
 * Auto-discovers translator modules and provides a unified interface for request/response mapping.
 *
 * To add a new provider:
 *   1. Create a file in ./translators/ named <provider>.ts
 *   2. Export: mapGeminiTo<Provider>, map<Provider>ToGemini, map<Provider>ChunkToGemini
 *   3. The registry detects it automatically — no config changes needed.
 */

import * as path from 'path';
import * as fs from 'fs';
import log from 'electron-log';

// ─── Types ────────────────────────────────────────────────────────────────

export interface TranslatorModule {
  mapGeminiToOpenAI?: (body: unknown, modelName: string, sessionId?: string) => unknown;
  mapOpenAIToGemini?: (res: unknown, modelName: string, sessionId?: string) => unknown;
  mapOpenAIChunkToGemini?: (chunk: unknown, modelName: string, sessionId?: string, streamKey?: string) => unknown | null;
  mapGeminiToAnthropic?: (body: unknown, modelName: string, sessionId?: string) => unknown;
  mapAnthropicToGemini?: (res: unknown, modelName: string, sessionId?: string) => unknown;
  mapAnthropicChunkToGemini?: (chunk: unknown, modelName: string, sessionId?: string, streamKey?: string) => unknown | null;
  mapGeminiToGoogle?: (body: unknown, modelName: string, sessionId?: string) => unknown;
  mapGoogleToGemini?: (res: unknown, modelName: string, sessionId?: string) => unknown;
  mapGoogleChunkToGemini?: (chunk: unknown, modelName: string, sessionId?: string, streamKey?: string) => unknown | null;
  getGoogleApiUrl?: (baseUrl: string, modelName: string, isStream: boolean) => string;
  [key: string]: unknown;
}

export interface ProviderHeaders {
  'Content-Type': string;
  Authorization?: string;
  'x-api-key'?: string;
  'anthropic-version'?: string;
  'x-goog-api-key'?: string;
  'HTTP-Referer'?: string;
  'X-Title'?: string;
  [key: string]: string | undefined;
}

import * as openaiTranslator from './translators/openai';
import * as anthropicTranslator from './translators/anthropic';
import * as googleTranslator from './translators/google';
import * as ollamaTranslator from './translators/ollama';

// ─── Registry State ───────────────────────────────────────────────────────

const translators = new Map<string, TranslatorModule>();

// Pre-register static translators for guaranteed runtime availability in all environments
translators.set('openai', openaiTranslator as TranslatorModule);
translators.set('anthropic', anthropicTranslator as TranslatorModule);
translators.set('google', googleTranslator as TranslatorModule);
translators.set('ollama', ollamaTranslator as TranslatorModule);

// ─── Auto-Discovery ───────────────────────────────────────────────────────

function loadTranslators(): void {
  const translatorDir = path.join(__dirname, 'translators');

  try {
    if (fs.existsSync(translatorDir)) {
      const files = fs
        .readdirSync(translatorDir)
        .filter(
          (f) =>
            (f.endsWith('.js') || f.endsWith('.ts')) &&
            !f.endsWith('.d.ts') &&
            !f.startsWith('utils.'),
        );

      for (const file of files) {
        const provider = file.replace(/\.(js|ts)$/, '');
        try {
          // eslint-disable-next-line @typescript-eslint/no-var-requires
          const mod = require(path.join(translatorDir, file)) as TranslatorModule;
          translators.set(provider, mod);
          log.info(`[TranslatorRegistry] Loaded provider translator: "${provider}"`);
        } catch (err) {
          log.debug(`[TranslatorRegistry] Dynamic load for "${provider}" skipped:`, (err as Error).message);
        }
      }
    }
  } catch (err) {
    log.debug('[TranslatorRegistry] Dynamic discovery note:', (err as Error).message);
  }

  log.info(
    `[TranslatorRegistry] ${translators.size} provider translator(s) active: ${[...translators.keys()].join(', ')}`,
  );
}

// Providers grouped by transport compatibility
const OPENAI_COMPAT = new Set([
  'openai',
  'ollama',
  'openrouter',
  'custom',
  'groq',
  'mistral',
  'cerebras',
  'nvidia',
  'opencode',
  'codestral',
]);
const ANTHROPIC_COMPAT = new Set([
  'anthropic',
  'deepseek',
  'kimi',
  'fireworks',
  'lmstudio',
  'llamacpp',
  'wafer',
  'zai',
]);

// ─── Public API ───────────────────────────────────────────────────────────

export function getTranslator(provider: string): TranslatorModule | null {
  if (OPENAI_COMPAT.has(provider)) return translators.get('openai') || null;
  if (ANTHROPIC_COMPAT.has(provider)) return translators.get('anthropic') || null;
  if (provider === 'google') return translators.get('google') || null;
  return translators.get('openai') || null;
}

export function translateRequest(
  provider: string,
  geminiBody: unknown,
  modelName: string,
  sessionId?: string,
): unknown {
  const t = getTranslator(provider);

  if (provider === 'google') return geminiBody;
  if (OPENAI_COMPAT.has(provider))
    return t?.mapGeminiToOpenAI ? t.mapGeminiToOpenAI(geminiBody, modelName, sessionId) : geminiBody;
  if (ANTHROPIC_COMPAT.has(provider))
    return t?.mapGeminiToAnthropic ? t.mapGeminiToAnthropic(geminiBody, modelName, sessionId) : geminiBody;

  // Generic: try mapGeminiTo<Provider> convention
  const fnName = `mapGeminiTo${provider.charAt(0).toUpperCase() + provider.slice(1)}`;
  if (t && typeof t[fnName] === 'function') {
    return (t[fnName] as (...args: unknown[]) => unknown)(geminiBody, modelName, sessionId);
  }

  log.warn(`[TranslatorRegistry] No request translator for provider "${provider}", passing through`);
  return geminiBody;
}

export function translateResponse(
  provider: string,
  providerRes: unknown,
  modelName: string,
  sessionId?: string,
): unknown {
  const t = getTranslator(provider);

  if (provider === 'google') return providerRes;
  if (OPENAI_COMPAT.has(provider))
    return t?.mapOpenAIToGemini ? t.mapOpenAIToGemini(providerRes, modelName, sessionId) : providerRes;
  if (ANTHROPIC_COMPAT.has(provider))
    return t?.mapAnthropicToGemini ? t.mapAnthropicToGemini(providerRes, modelName, sessionId) : providerRes;

  const fnName = `map${provider.charAt(0).toUpperCase() + provider.slice(1)}ToGemini`;
  if (t && typeof t[fnName] === 'function') {
    return (t[fnName] as (...args: unknown[]) => unknown)(providerRes, modelName, sessionId);
  }

  log.warn(`[TranslatorRegistry] No response translator for provider "${provider}", passing through`);
  return providerRes;
}

export function translateStreamChunk(
  provider: string,
  chunk: unknown,
  modelName: string,
  sessionId?: string,
  streamKey?: string,
): unknown {
  const t = getTranslator(provider);

  if (provider === 'google')
    return t?.mapGoogleChunkToGemini ? t.mapGoogleChunkToGemini(chunk, modelName, sessionId, streamKey) : null;
  if (OPENAI_COMPAT.has(provider))
    return t?.mapOpenAIChunkToGemini ? t.mapOpenAIChunkToGemini(chunk, modelName, sessionId, streamKey) : null;
  if (ANTHROPIC_COMPAT.has(provider))
    return t?.mapAnthropicChunkToGemini ? t.mapAnthropicChunkToGemini(chunk, modelName, sessionId, streamKey) : null;

  const fnName = `map${provider.charAt(0).toUpperCase() + provider.slice(1)}ChunkToGemini`;
  if (t && typeof t[fnName] === 'function') {
    return (t[fnName] as (...args: unknown[]) => unknown)(chunk, modelName, sessionId, streamKey);
  }

  return null;
}

export function getProviderHeaders(provider: string, apiKey: string): ProviderHeaders {
  const headers: ProviderHeaders = { 'Content-Type': 'application/json' };
  if (!apiKey || apiKey === 'none') return headers;

  if (provider === 'anthropic' || ANTHROPIC_COMPAT.has(provider)) {
    headers['x-api-key'] = apiKey;
    headers['anthropic-version'] = '2023-06-01';
  } else if (provider === 'google') {
    headers['x-goog-api-key'] = apiKey;
  } else if (provider === 'openrouter') {
    headers['Authorization'] = `Bearer ${apiKey}`;
    headers['HTTP-Referer'] = 'https://antigravity.google';
    headers['X-Title'] = 'Antigravity';
  } else if (provider !== 'ollama') {
    headers['Authorization'] = `Bearer ${apiKey}`;
  }
  return headers;
}

export function supportsStreaming(provider: string): boolean {
  return OPENAI_COMPAT.has(provider) || ANTHROPIC_COMPAT.has(provider) || provider === 'google';
}

// ─── URL Helpers ──────────────────────────────────────────────────────────

export function getProviderUrl(
  baseUrl: string,
  modelName: string,
  isStream: boolean,
  translator: TranslatorModule | null,
): string {
  // Google AI Studio: dynamic streaming vs non-streaming URL
  if (translator && typeof translator['getGoogleApiUrl'] === 'function') {
    return (translator['getGoogleApiUrl'] as (...args: unknown[]) => string)(baseUrl, modelName, isStream);
  }
  // Ollama: normalize to standard /v1/chat/completions endpoint
  if (translator && typeof translator['getOllamaApiUrl'] === 'function') {
    return (translator['getOllamaApiUrl'] as (...args: unknown[]) => string)(baseUrl);
  }
  return baseUrl;
}

// ─── Boot ─────────────────────────────────────────────────────────────────

loadTranslators();
