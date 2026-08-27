/**
 * Antigravity Custom Model Proxy - Core Entrypoint
 *
 * This module is loaded into the Antigravity IDE (VS Code Fork) main process
 * to inject custom model support into the Google Cloud Code Language Server pipeline.
 */
export { startProxy, stopProxy, getProxyPort, type CustomModel, } from './proxy';
export { validateCustomModel, validateCustomModels, validateGenerateContentResponse, validateGenerateContentRequest, validateOpenAiChunk, validateAnthropicEvent, } from './schemaValidator';
export { encryptString, decryptString, encryptModels, decryptModels, isEncryptionAvailable, backupFile, } from './cryptoStore';
export { detectModelCapabilities, detectModelCapabilitiesByName, type ModelCapabilities, } from './proxy/modelUtils';
export * from './proxy/registry';
//# sourceMappingURL=index.d.ts.map