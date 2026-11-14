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
type StreamReader = (offset: number, length: number, signal: AbortSignal) => Promise<Uint8Array>;
type StreamOptions = { size: number; mimeType: string };
type DirectoryHandle = { id: string; name: string };
type DirectoryEntry = DirectoryHandle & { directory: boolean; mimeType: string; size: number };
type MiniLocale = { preferred: 'en' | 'ru' };
type SaveTextOptions = { suggestedName: string; mimeType: string; text: string; extensions?: string[] };
type SaveBase64Options = { suggestedName: string; mimeType: string; base64: string; extensions?: string[] };
type ShareFileOptions = {
  title?: string; text?: string; suggestedName: string; mimeType: string;
  content: { encoding: "text" | "base64"; data: string };
};

declare const mini: {
  locale: { get(): Promise<MiniLocale> };
  app: {
    getInfo(): Promise<any>;
    close(): Promise<void>;
    getRuntimeVersion(): Promise<string>;
    getLaunchParams(): Promise<{ reason: string; notificationId?: string; payload?: object; locale: MiniLocale }>;
    onBackRequested(handler: () => boolean): void;
  };
  runtime: { getCapabilities(): Promise<any>; supports(name: string): Promise<boolean> };
  logs: { write(event: string, fields?: Record<string, string | number | boolean | null>): Promise<{ path: string }> };
  modules: { load(id: string): Promise<void> };
  streams: {
    open(options: StreamOptions, read: StreamReader): Promise<{ url: string; close(): Promise<void> }>;
    save(options: StreamOptions & { suggestedName: string; directoryId?: string; folders?: string[] }, read: StreamReader, signal?: AbortSignal): Promise<SavedFileResult | null>;
  };
  functions: { call(method: string, params?: Record<string, unknown>): Promise<unknown> };
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
    pickDirectory(): Promise<DirectoryHandle>;
    listDirectory(id: string, options?: { limit?: number; cursor?: number }): Promise<{ entries: DirectoryEntry[]; nextCursor: number | null }>;
    releaseDirectory(id: string): Promise<void>;
    /** Windows-only. Check files.writeChecked support before calling. */
    writeChecked(id: string, options: { path: string; base64: string; expectedSha256: string | null }): Promise<void>;
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
