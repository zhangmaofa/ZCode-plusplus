// ZCode++ main-process runtime. Deployed to <userRoot>/runtime/main.mjs and
// imported by the loader injected into app.asar BEFORE ZCode's own entry.
// Everything here is fail-open: no throw may escape into the host app.
import path from 'node:path';
import fs from 'node:fs';
import { createRequire } from 'node:module';

const g = globalThis.__zcodepp;
if (!g || !g.electron) throw new Error('zcodepp: loader bootstrap context missing');
const electron = g.electron;
const userRoot = process.env.ZCODEPP_USER_ROOT || g.userRoot;
const { app, session, ipcMain } = electron;

const require = createRequire(import.meta.url);
const logger = require('./lib/logger.cjs');
const storage = require('./lib/storage.cjs');
const { discoverTweaks, isEnabled } = require('./lib/discovery.cjs');
const { watchTweaks } = require('./lib/hot-reload.cjs');

const log = logger.create('main', path.join(userRoot, 'log'));

const P = {
  tweaksDir: path.join(userRoot, 'tweaks'),
  tweakDataDir: path.join(userRoot, 'tweak-data'),
  configFile: path.join(userRoot, 'config.json'),
  runtimeConfigFile: path.join(userRoot, 'runtime', 'config.json'),
};

function readJsonSafe(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    return fallback;
  }
}

let config = readJsonSafe(P.configFile, { version: 1, tweaks: {}, dev: {} });
const runtimeConfig = readJsonSafe(P.runtimeConfigFile, {});

function isSafeMode() {
  return process.env.ZCODEPP_SAFE_MODE === '1' || config.safeMode === true;
}

// ---------------------------------------------------------------------------
// Preload registration — additive, never replaces ZCode's own preload.
// ---------------------------------------------------------------------------
const preloadPath = path.join(userRoot, 'runtime', 'preload.cjs');
const seenSessions = new WeakSet();

function registerPreloadFor(ses) {
  try {
    if (!ses || seenSessions.has(ses)) return;
    seenSessions.add(ses);
    if (typeof ses.registerPreloadScript === 'function') {
      ses.registerPreloadScript(preloadPath);
    } else if (typeof ses.setPreloads === 'function') {
      const cur = ses.getPreloads();
      if (!cur.includes(preloadPath)) ses.setPreloads([...cur, preloadPath]);
    } else {
      log.warn('session exposes no preload registration API');
      return;
    }
    log.info('preload registered for a session');
  } catch (e) {
    log.warn('preload registration failed:', e && e.message);
  }
}

try {
  if (session && session.defaultSession) registerPreloadFor(session.defaultSession);
} catch (e) {
  /* accessing sessions pre-ready can throw on some Electron versions */
}
try {
  app.on('session-created', (ses) => registerPreloadFor(ses));
} catch (e) {
  log.warn('session-created hook failed:', e && e.message);
}

const windowCreatedHandlers = new Set();
try {
  app.on('browser-window-created', (_e, win) => {
    try {
      if (win && win.webContents) registerPreloadFor(win.webContents.session);
    } catch (e) {
      /* ignore */
    }
    for (const cb of windowCreatedHandlers) {
      try {
        cb(win);
      } catch (e) {
        log.warn('window-created handler failed:', e && e.message);
      }
    }
  });
} catch (e) {
  log.warn('browser-window-created hook failed:', e && e.message);
}

// ---------------------------------------------------------------------------
// IPC surface for the preload / renderer tweaks
// ---------------------------------------------------------------------------
function ipc(channel, handler) {
  try {
    ipcMain.removeHandler(channel);
  } catch (e) {
    /* not registered yet */
  }
  ipcMain.handle(channel, async (_e, payload) => {
    try {
      return { ok: true, value: await handler(payload || {}) };
    } catch (err) {
      return { ok: false, error: String((err && err.message) || err) };
    }
  });
}

function validTweakId(id) {
  return typeof id === 'string' && /^[a-z0-9][a-z0-9.-]{1,120}$/i.test(id);
}

ipc('zcodepp:get-state', () => ({
  version: g.runtimeVersion || '0.0.0',
  userRoot,
  safeMode: isSafeMode(),
  selectors: runtimeConfig.settingsInjection || {},
  overlay: runtimeConfig.overlay || {},
  tweaks: tweakStates(),
}));

ipc('zcodepp:read-bundle', ({ id }) => {
  if (!validTweakId(id)) throw new Error('bad tweak id');
  const root = path.join(P.tweaksDir, id);
  const files = {};
  let count = 0;
  let total = 0;
  (function walk(dir, rel) {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (e) {
      throw new Error('tweak directory unreadable: ' + id);
    }
    for (const ent of entries) {
      if (ent.name === 'node_modules' || ent.name.startsWith('.')) continue;
      const r = rel ? rel + '/' + ent.name : ent.name;
      const f = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        walk(f, r);
      } else if (ent.isFile()) {
        if (++count > 300) throw new Error('too many files in tweak: ' + id);
        const st = fs.statSync(f);
        if (st.size > 2 * 1024 * 1024) throw new Error('file too large: ' + r);
        total += st.size;
        if (total > 8 * 1024 * 1024) throw new Error('tweak bundle too large: ' + id);
        files[r] = fs.readFileSync(f, 'utf8');
      }
    }
  })(root, '');
  return files;
});

ipc('zcodepp:storage-get', ({ id, key, def }) => {
  if (!validTweakId(id) || typeof key !== 'string') throw new Error('bad args');
  return storage.open(P.tweakDataDir, id).get(key, def);
});

ipc('zcodepp:storage-set', ({ id, key, value }) => {
  if (!validTweakId(id) || typeof key !== 'string') throw new Error('bad args');
  if (JSON.stringify(value === undefined ? null : value).length > 256 * 1024) throw new Error('value too large');
  storage.open(P.tweakDataDir, id).set(key, value === undefined ? null : value);
  return true;
});

try {
  ipcMain.removeAllListeners('zcodepp:renderer-log');
  ipcMain.on('zcodepp:renderer-log', (_e, payload) => {
    try {
      if (!payload || !validTweakId(payload.id)) return;
      const args = Array.isArray(payload.args) ? payload.args.slice(0, 20) : [];
      log.info(`[renderer:${payload.id}] (${payload.level || 'info'}) ${args.map(safeStr).join(' ')}`);
    } catch (e) {
      /* ignore */
    }
  });
} catch (e) {
  /* ignore */
}

function safeStr(x) {
  if (typeof x === 'string') return x;
  try {
    return JSON.stringify(x);
  } catch (e) {
    return String(x);
  }
}

// ---------------------------------------------------------------------------
// Main-scope tweak lifecycle
// ---------------------------------------------------------------------------
const runningMain = new Map(); // id -> { tweak, mod, ctx }

function bustRequireCache(dir) {
  for (const key of Object.keys(require.cache || {})) {
    if (key.startsWith(dir)) delete require.cache[key];
  }
}

function makeMainApi(tweak) {
  const id = tweak.manifest.id;
  const dataDir = path.join(P.tweakDataDir, id);
  try {
    fs.mkdirSync(dataDir, { recursive: true });
  } catch (e) {
    /* created lazily by storage too */
  }
  return {
    manifest: tweak.manifest,
    electron,
    dataDir,
    storage: storage.open(P.tweakDataDir, id),
    log: {
      info: (...a) => log.info(`[tweak:${id}]`, ...a),
      warn: (...a) => log.warn(`[tweak:${id}]`, ...a),
      error: (...a) => log.error(`[tweak:${id}]`, ...a),
    },
    windows: {
      onCreated(cb) {
        if (typeof cb === 'function') windowCreatedHandlers.add(cb);
        return () => windowCreatedHandlers.delete(cb);
      },
      getAll() {
        try {
          return electron.BrowserWindow.getAllWindows();
        } catch (e) {
          return [];
        }
      },
    },
    reloadRendererTweak(tweakId) {
      broadcast('zcodepp:reload-tweak', tweakId);
    },
  };
}

function startMainTweak(tweak) {
  const id = tweak.manifest.id;
  stopMainTweak(id);
  bustRequireCache(tweak.dir + path.sep);
  const entryPath = path.join(tweak.dir, tweak.manifest.main);
  const mod = require(entryPath);
  if (!mod || typeof mod.start !== 'function') throw new Error('entry does not export start(api)');
  const ctx = mod.start(makeMainApi(tweak));
  runningMain.set(id, { tweak, mod, ctx });
}

function stopMainTweak(id) {
  const r = runningMain.get(id);
  if (!r) return;
  runningMain.delete(id);
  try {
    if (r.mod && typeof r.mod.stop === 'function') r.mod.stop(makeMainApi(r.tweak), r.ctx);
  } catch (e) {
    log.warn(`main tweak stop() failed: ${id}`, e && e.message);
  }
}

function tweakStates() {
  const tweaks = discoverTweaks(P.tweaksDir);
  return tweaks.map((t) => ({
    manifest: t.manifest,
    invalid: !!t.invalid,
    error: t.error || null,
    enabled: isEnabled(config, t.manifest.id),
    runningMain: runningMain.has(t.manifest.id),
    dev: !!(config.dev && config.dev[t.manifest.id]),
  }));
}

function broadcast(channel, ...args) {
  try {
    for (const win of electron.BrowserWindow.getAllWindows()) {
      try {
        if (!win.isDestroyed()) win.webContents.send(channel, ...args);
      } catch (e) {
        /* ignore per-window failures */
      }
    }
  } catch (e) {
    /* ignore */
  }
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
function startHotReloadIfDev() {
  const devIds = Object.keys((config && config.dev) || {});
  if (!devIds.length) return;
  log.info('dev mode active for: ' + devIds.join(', '));
  watchTweaks(P.tweaksDir, (id) => {
    log.info(`change detected, reloading tweak: ${id}`);
    const t = discoverTweaks(P.tweaksDir).find((x) => x.manifest.id === id);
    if (t && !t.invalid && t.manifest.scope !== 'renderer') {
      try {
        startMainTweak(t);
      } catch (e) {
        log.error(`main tweak reload failed: ${id}`, e && e.message);
      }
    }
    broadcast('zcodepp:reload-tweak', id);
  });
}

function boot() {
  log.info(`runtime ${g.runtimeVersion || '?'} booted (electron ${process.versions.electron}, node ${process.versions.node}, safeMode=${isSafeMode()})`);
  if (isSafeMode()) {
    log.warn('safe mode active: no tweaks will load');
    return;
  }
  for (const t of discoverTweaks(P.tweaksDir)) {
    if (t.invalid) {
      log.warn(`tweak invalid: ${t.manifest.id} — ${t.error}`);
      continue;
    }
    if (!isEnabled(config, t.manifest.id)) continue;
    if (t.manifest.scope === 'renderer') continue;
    try {
      startMainTweak(t);
      log.info(`main tweak started: ${t.manifest.id}`);
    } catch (e) {
      log.error(`main tweak failed: ${t.manifest.id}`, (e && e.stack) || e);
    }
  }
  startHotReloadIfDev();
}

try {
  if (app.isReady()) boot();
  else app.whenReady().then(boot).catch((e) => log.error('boot failed', e));
} catch (e) {
  log.error('whenReady registration failed', e);
}
