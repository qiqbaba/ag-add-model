/**
 * Ambient type declarations for Antigravity Custom Model Proxy.
 */

declare namespace NodeJS {
  interface Process {
    resourcesPath: string;
  }
}

declare module 'electron' {
  export const app: {
    getPath(name: string): string;
    getAppPath(): string;
    getVersion(): string;
    isPackaged: boolean;
    whenReady(): Promise<void>;
    quit(): void;
    on(event: string, listener: (...args: unknown[]) => void): void;
  };

  export const safeStorage: {
    isEncryptionAvailable(): boolean;
    encryptString(plainText: string): Buffer;
    decryptString(encrypted: Buffer): string;
  };
}
