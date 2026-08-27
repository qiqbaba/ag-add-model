"use strict";
/**
 * Antigravity Custom Model Proxy - Core Entrypoint
 *
 * This module is loaded into the Antigravity IDE (VS Code Fork) main process
 * to inject custom model support into the Google Cloud Code Language Server pipeline.
 */
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __exportStar = (this && this.__exportStar) || function(m, exports) {
    for (var p in m) if (p !== "default" && !Object.prototype.hasOwnProperty.call(exports, p)) __createBinding(exports, m, p);
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.detectModelCapabilitiesByName = exports.detectModelCapabilities = exports.backupFile = exports.isEncryptionAvailable = exports.decryptModels = exports.encryptModels = exports.decryptString = exports.encryptString = exports.validateAnthropicEvent = exports.validateOpenAiChunk = exports.validateGenerateContentRequest = exports.validateGenerateContentResponse = exports.validateCustomModels = exports.validateCustomModel = exports.getProxyPort = exports.stopProxy = exports.startProxy = void 0;
var proxy_1 = require("./proxy");
Object.defineProperty(exports, "startProxy", { enumerable: true, get: function () { return proxy_1.startProxy; } });
Object.defineProperty(exports, "stopProxy", { enumerable: true, get: function () { return proxy_1.stopProxy; } });
Object.defineProperty(exports, "getProxyPort", { enumerable: true, get: function () { return proxy_1.getProxyPort; } });
var schemaValidator_1 = require("./schemaValidator");
Object.defineProperty(exports, "validateCustomModel", { enumerable: true, get: function () { return schemaValidator_1.validateCustomModel; } });
Object.defineProperty(exports, "validateCustomModels", { enumerable: true, get: function () { return schemaValidator_1.validateCustomModels; } });
Object.defineProperty(exports, "validateGenerateContentResponse", { enumerable: true, get: function () { return schemaValidator_1.validateGenerateContentResponse; } });
Object.defineProperty(exports, "validateGenerateContentRequest", { enumerable: true, get: function () { return schemaValidator_1.validateGenerateContentRequest; } });
Object.defineProperty(exports, "validateOpenAiChunk", { enumerable: true, get: function () { return schemaValidator_1.validateOpenAiChunk; } });
Object.defineProperty(exports, "validateAnthropicEvent", { enumerable: true, get: function () { return schemaValidator_1.validateAnthropicEvent; } });
var cryptoStore_1 = require("./cryptoStore");
Object.defineProperty(exports, "encryptString", { enumerable: true, get: function () { return cryptoStore_1.encryptString; } });
Object.defineProperty(exports, "decryptString", { enumerable: true, get: function () { return cryptoStore_1.decryptString; } });
Object.defineProperty(exports, "encryptModels", { enumerable: true, get: function () { return cryptoStore_1.encryptModels; } });
Object.defineProperty(exports, "decryptModels", { enumerable: true, get: function () { return cryptoStore_1.decryptModels; } });
Object.defineProperty(exports, "isEncryptionAvailable", { enumerable: true, get: function () { return cryptoStore_1.isEncryptionAvailable; } });
Object.defineProperty(exports, "backupFile", { enumerable: true, get: function () { return cryptoStore_1.backupFile; } });
var modelUtils_1 = require("./proxy/modelUtils");
Object.defineProperty(exports, "detectModelCapabilities", { enumerable: true, get: function () { return modelUtils_1.detectModelCapabilities; } });
Object.defineProperty(exports, "detectModelCapabilitiesByName", { enumerable: true, get: function () { return modelUtils_1.detectModelCapabilitiesByName; } });
__exportStar(require("./proxy/registry"), exports);
//# sourceMappingURL=index.js.map