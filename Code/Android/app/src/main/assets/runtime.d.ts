type MiniStorage = {
  get(key: string): Promise<any>;
  set(key: string, value: any): Promise<void>;
  remove(key: string): Promise<void>;
  clear(): Promise<void>;
  keys(): Promise<string[]>;
  getMany(keys: string[]): Promise<Record<string, any>>;
  setMany(values: Record<string, any>): Promise<void>;
  getSchemaVersion(): Promise<number>;
  setSchemaVersion(value: number): Promise<void>;
  getUsage(): Promise<{ usedBytes: number; limitBytes: number }>;
};

type SavedFileResult = { name: string; mimeType: string; sizeBytes: number };
type SaveTextOptions = { suggestedName: string; mimeType: string; text: string; extensions?: string[] };
type SaveBase64Options = { suggestedName: string; mimeType: string; base64: string; extensions?: string[] };
type ShareFileOptions = {
  title?: string; text?: string; suggestedName: string; mimeType: string;
  content: { encoding: "text" | "base64"; data: string };
};

declare const mini: {
  app: {
    getInfo(): Promise<any>;
    close(): Promise<void>;
    getRuntimeVersion(): Promise<string>;
    onBackRequested(handler: () => boolean): void;
  };
  runtime: { getCapabilities(): Promise<any>; supports(name: string): Promise<boolean> };
  navigation: { setBackEnabled(enabled: boolean): Promise<{ backEnabled: boolean }>; getState(): Promise<{ backEnabled: boolean }> };
  storage: MiniStorage & {
    private: MiniStorage;
    public: MiniStorage;
    getPublic(key: string): Promise<any>;
    setPublic(key: string, value: any): Promise<void>;
    removePublic(key: string): Promise<void>;
    clearPublic(): Promise<void>;
    publicKeys(): Promise<string[]>;
    getMany(keys: string[]): Promise<Record<string, any>>;
    setMany(values: Record<string, any>): Promise<void>;
    transaction(transaction: { scope: 'private' | 'public'; operations: Array<{ type: 'set' | 'remove' | 'clear' | 'setSchemaVersion'; key?: string; value?: any }> }): Promise<void>;
  };
  permissions: { query(permission: string): Promise<'granted' | 'denied' | 'prompt' | 'not_declared' | 'unsupported'>; request(permission: string): Promise<string>; openSettings(): Promise<void> };
  secureStorage: MiniStorage;
  device: { getInfo(): Promise<any> };
  clipboard: { write(text: string): Promise<void> };
  files: {
    pick(options?: { mimeTypes?: string[] }): Promise<any>;
    readText(id: string): Promise<string>;
    readBase64(id: string): Promise<string>;
    release(id: string): Promise<void>;
    saveText(options: SaveTextOptions): Promise<SavedFileResult | null>;
    saveBase64(options: SaveBase64Options): Promise<SavedFileResult | null>;
  };
  share: {
    text(text: string, options?: { title?: string }): Promise<void>;
    file(options: ShareFileOptions): Promise<void>;
  };
  events: { on(name: string, handler: () => void): () => void };
};
