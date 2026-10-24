// Type definitions for ZCode++ tweaks.
// Usage (JS + JSDoc):  /** @type {import('zcode-plusplus/sdk').RendererTweak} */
// Usage (TS): copy this file or reference it via "paths".

/** tweak manifest — tweaks/<id>/manifest.json */
export interface TweakManifest {
  id: string;
  name: string;
  version: string;
  description?: string;
  scope: 'renderer' | 'main' | 'both';
  main: string;
  [key: string]: unknown;
}

/** A page shown in the ZCode++ panel (floating Z++ launcher / Settings tab when integrated). */
export interface SettingsPage {
  id: string;
  title: string;
  render(root: HTMLElement): void;
}

export interface TweakStorage {
  get<T = unknown>(key: string, defaultValue?: T): Promise<T | undefined>;
  set(key: string, value: unknown): Promise<boolean>;
}

/** API passed to renderer-scope tweaks (runs in the preload world of each window). */
export interface RendererApi {
  manifest: TweakManifest;
  version: string;
  settings: {
    registerPage(page: SettingsPage): void;
  };
  storage: TweakStorage;
  log(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
}

/** API passed to main-scope tweaks (runs in ZCode's main process). */
export interface MainApi {
  manifest: TweakManifest;
  /** The full electron module: BrowserWindow, globalShortcut, Tray, ... */
  electron: typeof import('electron');
  /** Per-tweak data directory (created for you). */
  dataDir: string;
  storage: TweakStorage & {
    get<T = unknown>(key: string, defaultValue?: T): T | undefined;
    set(key: string, value: unknown): void;
    all(): Record<string, unknown>;
  };
  log: {
    info(...args: unknown[]): void;
    warn(...args: unknown[]): void;
    error(...args: unknown[]): void;
  };
  windows: {
    onCreated(cb: (win: import('electron').BrowserWindow) => void): () => void;
    getAll(): import('electron').BrowserWindow[];
  };
  /** Ask all open windows to reload a renderer-scope tweak by id. */
  reloadRendererTweak(tweakId: string): void;
}

export interface TweakContext {
  [key: string]: unknown;
}

export interface TweakModule<TApi, TCtx> {
  start(api: TApi): TCtx | void | Promise<TCtx | void>;
  stop?(api: TApi, ctx: TCtx): void | Promise<void>;
}

export type RendererTweak = TweakModule<RendererApi, TweakContext>;
export type MainTweak = TweakModule<MainApi, TweakContext>;
