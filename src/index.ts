/**
 * Antigravity Custom Model Proxy - Core Entrypoint
 *
 * This module is loaded into the Antigravity IDE (VS Code Fork) main process
 * to inject custom model support into the Google Cloud Code Language Server pipeline.
 */

export { startProxy, stopProxy, getProxyPort, type CustomModel } from './proxy';

export {
  validateCustomModel,
  validateCustomModels,
  validateGenerateContentResponse,
  validateGenerateContentRequest,
  validateOpenAiChunk,
  validateAnthropicEvent,
} from './schemaValidator';

export {
  encryptString,
  decryptString,
  encryptModels,
  decryptModels,
  isEncryptionAvailable,
  backupFile,
} from './cryptoStore';

export { detectModelCapabilities, detectModelCapabilitiesByName, type ModelCapabilities } from './proxy/modelUtils';

export {
  syncSettingsJson,
  syncActivePort,
  getSettingsPath,
  getActivePortPath,
  getDashboardUrlPath,
  buildCloudCodeUrl,
} from './proxy/settingsSync';

export { renderDashboardHtml } from './proxy/dashboardHtml';

export {
  getModelsViewModel,
  saveCustomModel,
  deleteCustomModel,
  getRawConfig,
  saveRawConfig,
  getSystemInfo,
  readDecryptedModels,
  maskApiKey,
  generateSlug,
  generatePlaceholderId,
  type ModelViewModel,
} from './proxy/modelConfigManager';

export { testModelConnection, type TestConnectionParams, type TestConnectionResult } from './proxy/connectionTest';

export * from './proxy/registry';
