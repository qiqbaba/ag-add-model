/**
 * Model Configuration Manager for Antigravity Proxy.
 *
 * Provides CRUD operations, schema validation, safeStorage encryption,
 * masking, backup creation, and live reloading for custom_models.json.
 */

import * as fs from 'fs';
import * as path from 'path';
import { validateCustomModel, validateCustomModels } from '../schemaValidator';
import { detectModelCapabilities } from './modelUtils';

import * as cryptoStore from '../cryptoStore';

export interface CustomModel {
  name: string;
  displayName: string;
  description: string;
  provider: string;
  apiKey: string;
  apiUrl: string;
  externalModelName: string;
  allowUnauthorized?: boolean;
  encrypted?: boolean;
  _slug?: string;
  _placeholderId?: string;
  timeout?: number;
  maxRetries?: number;
}

export interface ModelViewModel {
  name: string;
  displayName: string;
  description: string;
  provider: string;
  apiUrl: string;
  externalModelName: string;
  apiKeyMasked: string;
  apiKey?: string;
  hasKey: boolean;
  encrypted: boolean;
  allowUnauthorized?: boolean;
  timeout?: number;
  maxRetries?: number;
  slug: string;
  placeholderId: string;
  capabilities: {
    isThinking: boolean;
    supportsImages: boolean;
    maxTokens: number;
    maxOutputTokens: number;
  };
  validation: {
    valid: boolean;
    error?: string;
  };
}

/**
 * Returns the path to custom_models.json with safe fallback for testing environments.
 */
export function getCustomModelsPath(): string {
  let homeDir = '';
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { app } = require('electron');
    if (app && typeof app.getPath === 'function') {
      homeDir = app.getPath('home');
    }
  } catch (_e) {
    // Electron not available or in test environment
  }
  if (!homeDir) {
    homeDir = process.env.USERPROFILE || process.env.HOME || '.';
  }
  return path.join(homeDir, '.gemini', 'antigravity', 'custom_models.json');
}

/**
 * Masks an API key for safe visual display (e.g. sk-••••••••W1aB).
 */
export function maskApiKey(key: string | undefined): string {
  if (!key || key === 'none' || key.trim() === '') return '(none)';
  const trimmed = key.trim();
  if (trimmed.length <= 8) {
    return '••••••••';
  }
  const start = trimmed.slice(0, Math.min(4, Math.floor(trimmed.length / 4)));
  const end = trimmed.slice(-Math.min(4, Math.floor(trimmed.length / 4)));
  return `${start}••••••••${end}`;
}

/**
 * Generates a unique placeholder ID for the model (e.g. MODEL_PLACEHOLDER_M456).
 */
export function generatePlaceholderId(model: CustomModel): string {
  if (model._placeholderId) return model._placeholderId;
  const input = (model.displayName || model.name || 'custom-model').toLowerCase();
  let hash = 5381;
  for (let i = 0; i < input.length; i++) {
    hash = (hash << 5) + hash + input.charCodeAt(i);
    hash = hash | 0;
  }
  const placeholderNum = 400 + (Math.abs(hash) % 200);
  return `MODEL_PLACEHOLDER_M${placeholderNum}`;
}

/**
 * Generates a URL-safe slug for the model (e.g. extm-deepseek-v3).
 */
export function generateSlug(model: CustomModel): string {
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

/**
 * Atomically writes content to a file (write temp + rename) so a crash or
 * power loss mid-write can never leave a truncated/corrupt config file.
 */
function writeFileAtomic(filePath: string, content: string): void {
  const tmpPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmpPath, content, 'utf-8');
  fs.renameSync(tmpPath, filePath);
}

interface ReadModelsResult {
  models: CustomModel[];
  /** Set when the on-disk file exists but could not be read/parsed. */
  parseError?: string;
}

/**
 * Reads and decrypts models, distinguishing "no file" from "corrupt file".
 * Write paths MUST check parseError and abort — treating corruption as an
 * empty list would overwrite and destroy the user's entire configuration.
 */
function readModelsFile(): ReadModelsResult {
  const filePath = getCustomModelsPath();
  if (!fs.existsSync(filePath)) {
    return { models: [] };
  }
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    const parsed = JSON.parse(content) as { models?: CustomModel[] };
    const rawModels = parsed.models || [];
    return { models: cryptoStore.decryptModels<CustomModel>(rawModels) };
  } catch (err) {
    console.error('[ModelConfigManager] Failed to read/parse custom_models.json:', err);
    return { models: [], parseError: (err as Error).message };
  }
}

/**
 * Reads and decrypts models from custom_models.json.
 * Read-only view: corrupt files degrade to an empty list (UI stays usable).
 */
export function readDecryptedModels(): CustomModel[] {
  return readModelsFile().models;
}

/**
 * Guards a write path: returns an error message when persisting `models`
 * would destroy data (corrupt source file, or credentials that failed to
 * decrypt and must not be re-encrypted over their intact on-disk ciphertext).
 */
function getWriteBlocker(models: CustomModel[], parseError?: string): string | null {
  if (parseError) {
    return `配置文件 custom_models.json 解析失败（${parseError}），已中止写入以避免清空全部模型配置。请修复文件或从 .bak 备份恢复后重试。`;
  }
  const bad = models.find((m) => cryptoStore.isDecryptionFailure(m.apiKey));
  if (bad) {
    return `模型 "${bad.name}" 的 API Key 解密失败（可能因跨机器迁移或系统密钥环不可用）。已中止写入以保护磁盘上的原始加密凭据。请重新填写该模型的 API Key 后再保存。`;
  }
  return null;
}

/**
 * Returns models formatted for the UI view (with masked keys and capability metadata).
 */
export function getModelsViewModel(includeKeys = false): ModelViewModel[] {
  const models = readDecryptedModels();
  const usedSlugs = new Set<string>();

  return models.map((m, _index) => {
    const baseSlug = generateSlug(m);
    let slug = baseSlug;
    let counter = 2;
    while (usedSlugs.has(slug)) {
      slug = `${baseSlug}-${counter}`;
      counter++;
    }
    usedSlugs.add(slug);

    const placeholderId = generatePlaceholderId(m);
    const cap = detectModelCapabilities(m, true);
    const validation = validateCustomModel(m);

    const hasKey = !!(m.apiKey && m.apiKey !== 'none' && m.apiKey.trim() !== '');

    const vm: ModelViewModel = {
      name: m.name,
      displayName: m.displayName || m.name,
      description: m.description || '',
      provider: m.provider,
      apiUrl: m.apiUrl,
      externalModelName: m.externalModelName || '',
      apiKeyMasked: maskApiKey(m.apiKey),
      hasKey,
      encrypted: !!m.encrypted || hasKey,
      allowUnauthorized: m.allowUnauthorized,
      timeout: m.timeout,
      maxRetries: m.maxRetries,
      slug,
      placeholderId,
      capabilities: {
        isThinking: cap.isThinking,
        supportsImages: cap.supportsImages,
        maxTokens: cap.maxTokens,
        maxOutputTokens: cap.maxOutputTokens,
      },
      validation: {
        valid: validation.valid,
        error: validation.error,
      },
    };

    if (includeKeys) {
      vm.apiKey = m.apiKey || '';
    }

    return vm;
  });
}

/**
 * Saves or updates a custom model.
 */
export function saveCustomModel(modelData: Partial<CustomModel>): {
  success: boolean;
  error?: string;
  model?: ModelViewModel;
} {
  // Ensure name starts with "models/" (validator now enforces this strictly)
  let name = (modelData.name || '').trim();
  if (name && !name.startsWith('models/')) {
    name = 'models/' + name.replace(/^\/+/, '');
  }

  const model: CustomModel = {
    name,
    displayName: (modelData.displayName || modelData.externalModelName || name).trim(),
    description: (modelData.description || '').trim(),
    provider: (modelData.provider || 'openai').trim().toLowerCase(),
    apiKey: modelData.apiKey !== undefined ? modelData.apiKey.trim() : '',
    apiUrl: (modelData.apiUrl || '').trim(),
    externalModelName: (modelData.externalModelName || modelData.name || '').replace(/^models\//, '').trim(),
    allowUnauthorized: !!modelData.allowUnauthorized,
    timeout: modelData.timeout ? Number(modelData.timeout) : undefined,
    maxRetries: modelData.maxRetries !== undefined ? Number(modelData.maxRetries) : undefined,
  };

  const validation = validateCustomModel(model);
  if (!validation.valid) {
    return { success: false, error: validation.error };
  }

  const filePath = getCustomModelsPath();
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const readResult = readModelsFile();
  const currentModels = readResult.models;
  const existingIndex = currentModels.findIndex((m) => m.name === model.name);

  if (existingIndex >= 0) {
    // If apiKey is empty or preserved mask, retain existing key
    if (!model.apiKey || model.apiKey.includes('••••')) {
      model.apiKey = currentModels[existingIndex].apiKey || '';
    }
    currentModels[existingIndex] = model;
  } else {
    currentModels.push(model);
  }

  const blocker = getWriteBlocker(currentModels, readResult.parseError);
  if (blocker) {
    return { success: false, error: blocker };
  }

  try {
    cryptoStore.backupFile(filePath);
    const encrypted = cryptoStore.encryptModels(currentModels);
    writeFileAtomic(filePath, JSON.stringify({ models: encrypted }, null, 2));
    const viewModels = getModelsViewModel();
    const updatedVm = viewModels.find((v) => v.name === model.name);
    return { success: true, model: updatedVm };
  } catch (err) {
    return { success: false, error: `保存失败: ${(err as Error).message}` };
  }
}

/**
 * Batch-saves multiple custom models (used by the discover + batch-add flow).
 *
 * Adds only models that are not already present locally, skipping duplicates
 * (dedup by `name` and by `externalModelName`), and persists all accepted
 * models in a single atomic write. Existing models are never overwritten.
 */
export function saveCustomModels(modelList: Partial<CustomModel>[]): {
  success: boolean;
  addedCount: number;
  skippedCount: number;
  error?: string;
  results: { name: string; externalModelName?: string; success: boolean; skipped?: boolean; error?: string }[];
} {
  const results: { name: string; externalModelName?: string; success: boolean; skipped?: boolean; error?: string }[] = [];
  if (!Array.isArray(modelList) || modelList.length === 0) {
    return { success: false, addedCount: 0, skippedCount: 0, error: '未提供任何待添加的模型', results };
  }

  const readResult = readModelsFile();
  const currentModels = readResult.models;
  const existingNames = new Set<string>(currentModels.map((m) => m.name));
  const existingExternal = new Set<string>(
    currentModels.map((m) => (m.externalModelName || '').toLowerCase()).filter(Boolean),
  );

  const accepted: CustomModel[] = [];
  const acceptedNames = new Set<string>();
  let skippedCount = 0;

  for (const item of modelList) {
    // Normalize name to "models/" prefix (validator enforces this strictly).
    let name = (item.name || '').trim();
    if (name && !name.startsWith('models/')) {
      name = 'models/' + name.replace(/^\/+/, '');
    }

    const externalModelName = (item.externalModelName || '').trim();
    const cleanExternal = externalModelName.toLowerCase();
    const dupByName = !!name && (existingNames.has(name) || acceptedNames.has(name));
    const dupByExternal =
      !!cleanExternal &&
      (existingExternal.has(cleanExternal) || accepted.some((a) => (a.externalModelName || '').toLowerCase() === cleanExternal));

    if (dupByName || dupByExternal) {
      skippedCount++;
      results.push({ name, externalModelName, success: false, skipped: true, error: '已存在于本地配置，已跳过' });
      continue;
    }

    const model: CustomModel = {
      name: name || 'models/' + slugify(externalModelName || 'custom-model'),
      displayName: (item.displayName || externalModelName || name || 'custom-model').trim(),
      description: (item.description || '').trim(),
      provider: (item.provider || 'openai').trim().toLowerCase(),
      apiKey: item.apiKey !== undefined ? item.apiKey.trim() : '',
      apiUrl: (item.apiUrl || '').trim(),
      externalModelName: externalModelName || (item.name || '').replace(/^models\//, ''),
      allowUnauthorized: !!item.allowUnauthorized,
      timeout: item.timeout ? Number(item.timeout) : undefined,
      maxRetries: item.maxRetries !== undefined ? Number(item.maxRetries) : undefined,
    };

    const validation = validateCustomModel(model);
    if (!validation.valid) {
      results.push({ name: model.name, externalModelName: model.externalModelName, success: false, error: validation.error || '校验失败' });
      continue;
    }

    // Ensure a unique name within this batch (append suffix on collision).
    let finalName = model.name;
    let counter = 2;
    while (acceptedNames.has(finalName)) {
      finalName = `${model.name}-${counter}`;
      counter++;
    }
    model.name = finalName;
    acceptedNames.add(finalName);
    accepted.push(model);
    results.push({ name: model.name, externalModelName: model.externalModelName, success: true });
  }

  if (accepted.length === 0) {
    // Distinguish "everything was a duplicate" (successful no-op) from "some
    // models failed validation" (a real error the user should fix/see).
    const hasValidationError = results.some((r) => r.success === false && !r.skipped);
    if (hasValidationError) {
      return { success: false, addedCount: 0, skippedCount, error: '部分模型校验未通过，未新增任何模型', results };
    }
    return { success: true, addedCount: 0, skippedCount, results };
  }

  const blocker = getWriteBlocker([...currentModels, ...accepted], readResult.parseError);
  if (blocker) {
    return { success: false, addedCount: 0, skippedCount, error: blocker, results };
  }

  const filePath = getCustomModelsPath();
  try {
    cryptoStore.backupFile(filePath);
    const allModels = [...currentModels, ...accepted];
    const encrypted = cryptoStore.encryptModels(allModels);
    writeFileAtomic(filePath, JSON.stringify({ models: encrypted }, null, 2));
    return { success: true, addedCount: accepted.length, skippedCount, results };
  } catch (err) {
    return { success: false, addedCount: 0, skippedCount, error: `保存失败: ${(err as Error).message}`, results };
  }
}

/** Slugifies a model id/name into a URL-safe token (e.g. "gpt-4o"). */
function slugify(input: string): string {
  return (
    input
      .replace(/^models\//, '')
      .replace(/[^a-zA-Z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .toLowerCase() || 'custom-model'
  );
}

/**
 * Deletes a custom model by name.
 */
export function deleteCustomModel(modelName: string): { success: boolean; error?: string; remainingCount: number } {
  const filePath = getCustomModelsPath();
  const readResult = readModelsFile();
  const currentModels = readResult.models;
  const cleanTarget = modelName.trim();

  const filtered = currentModels.filter(
    (m) => m.name !== cleanTarget && generateSlug(m) !== cleanTarget && m.name !== `models/${cleanTarget}`,
  );

  if (filtered.length === currentModels.length) {
    return { success: false, error: `未找到模型: ${modelName}`, remainingCount: currentModels.length };
  }

  const delBlocker = getWriteBlocker(filtered, readResult.parseError);
  if (delBlocker) {
    return { success: false, error: delBlocker, remainingCount: currentModels.length };
  }

  try {
    cryptoStore.backupFile(filePath);
    const encrypted = cryptoStore.encryptModels(filtered);
    writeFileAtomic(filePath, JSON.stringify({ models: encrypted }, null, 2));
    return { success: true, remainingCount: filtered.length };
  } catch (err) {
    return { success: false, error: `删除失败: ${(err as Error).message}`, remainingCount: currentModels.length };
  }
}

/**
 * Gets the raw content of custom_models.json.
 */
export function getRawConfig(): string {
  const filePath = getCustomModelsPath();
  if (!fs.existsSync(filePath)) {
    return JSON.stringify({ models: [] }, null, 2);
  }
  return fs.readFileSync(filePath, 'utf-8');
}

/**
 * Replaces the custom_models.json with validated raw JSON.
 */
export function saveRawConfig(rawJson: string): { success: boolean; error?: string; count?: number } {
  let parsed: { models?: unknown[] };
  try {
    parsed = JSON.parse(rawJson) as { models?: unknown[] };
  } catch (err) {
    return { success: false, error: `JSON 语法解析错误: ${(err as Error).message}` };
  }

  if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.models)) {
    return { success: false, error: 'JSON 结构不合法：顶层必须包含 "models" 数组 (即 {"models": [...]})' };
  }

  const validation = validateCustomModels(parsed.models);
  if (!validation.valid) {
    return { success: false, error: `模型校验未通过: ${validation.error}` };
  }

  const filePath = getCustomModelsPath();
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  try {
    cryptoStore.backupFile(filePath);
    // Decrypt then encrypt to ensure consistent safeStorage encryption
    const decrypted = cryptoStore.decryptModels(parsed.models as CustomModel[]);
    const rawBlocker = getWriteBlocker(decrypted);
    if (rawBlocker) {
      return { success: false, error: rawBlocker };
    }
    const encrypted = cryptoStore.encryptModels(decrypted);
    writeFileAtomic(filePath, JSON.stringify({ models: encrypted }, null, 2));
    return { success: true, count: encrypted.length };
  } catch (err) {
    return { success: false, error: `写入文件失败: ${(err as Error).message}` };
  }
}

/**
 * Returns system diagnostic information for the dashboard.
 */
export function getSystemInfo(proxyPort: number): Record<string, unknown> {
  const mem = process.memoryUsage();
  return {
    proxyPort,
    uptimeSeconds: Math.round(process.uptime()),
    customModelsPath: getCustomModelsPath(),
    modelsCount: readDecryptedModels().length,
    encryptionAvailable: cryptoStore.isEncryptionAvailable(),
    nodeVersion: process.version,
    platform: process.platform,
    arch: process.arch,
    memory: {
      rssMB: Math.round(mem.rss / 1024 / 1024),
      heapUsedMB: Math.round(mem.heapUsed / 1024 / 1024),
      heapTotalMB: Math.round(mem.heapTotal / 1024 / 1024),
    },
    timestamp: new Date().toISOString(),
  };
}
