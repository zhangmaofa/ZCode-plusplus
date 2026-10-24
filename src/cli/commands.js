'use strict';
const fs = require('fs');
const path = require('path');
const { spawn, execFileSync } = require('child_process');

const { readJsonFile, writeJsonFile, ensureDir, copyFileSyncSafe } = require('../common/util');
const { userRootPaths } = require('../common/paths');
const detect = require('../installer/detect');
const installer = require('../installer/install');
const watcher = require('../installer/watcher');
const fuses = require('../installer/fuses');
const { discoverTweaks, validateManifest } = require('../../runtime-src/lib/discovery.cjs');

function ctx(opts = {}) {
  const userRoot = opts.userRoot || userRootPaths().userRoot;
  return { userRoot, P: userRootPaths(userRoot), state: readJsonFile(path.join(userRoot, 'state.json'), null) };
}

// ---------------------------------------------------------------------------
async function cmdInstall(opts) {
  const res = await installer.install(opts);
  console.log('');
  console.log('ZCode++ installed.');
  console.log('  app:        ' + res.installInfo.exePath + ' (ZCode ' + res.installInfo.version + ')');
  console.log('  user root:  ' + res.userRoot);
  console.log('  patched:    ' + (res.alreadyPatched ? 'already patched (refreshed runtime)' : 'yes, backup saved'));
  console.log('  watcher:    ' + (res.watcherInstalled.length ? res.watcherInstalled.join(', ') : 'not installed'));
  console.log('');
  console.log('Start ZCode normally. Look for the "Z++" floating button, and');
  console.log('log/zcodepp activity under ' + path.join(res.userRoot, 'log'));
  console.log('If ZCode updates itself, run `zcodepp repair` (the hourly watcher does this too).');
  if (opts.start) {
    try {
      spawn(res.installInfo.exePath, [], { detached: true, stdio: 'ignore' }).unref();
      console.log('ZCode started.');
    } catch (e) {
      console.log('could not start ZCode automatically: ' + e.message);
    }
  }
}

async function cmdUninstall(opts) {
  const res = await installer.uninstall(opts);
  console.log('Original app.asar restored (' + (res.restored.ok ? 'verified' : 'FAILED') + ').');
  console.log(res.purged ? 'User data removed (tweaks, config, logs).' : 'Tweaks/config kept; re-run with --purge to delete them.');
}

async function cmdRepair(opts) {
  const res = await installer.repair(opts);
  if (!opts.quiet) {
    console.log('repair done: asar=' + res.classification + (res.alreadyPatched === false ? ' (re-patched)' : ' (already patched)'));
  }
}

async function cmdStatus() {
  const { userRoot, P, state } = ctx();
  console.log('ZCode++ status');
  console.log('  user root:     ' + userRoot);
  if (!state) {
    console.log('  state:         not installed');
  } else {
    const info = state.exePath && detect.inspectInstall(state.exePath);
    let cls = 'unknown (app not found)';
    if (info) {
      const patcher = require('../installer/patch');
      cls = await patcher.classifyCurrentAsar({ exePath: state.exePath, state });
    }
    console.log('  installed:     ' + !!state.installed);
    console.log('  app:           ' + state.exePath + ' (ZCode ' + (info ? info.version : '?') + ')');
    console.log('  runtime:       ' + state.runtimeVersion + ' (installed ' + state.installedAt + ')');
    console.log('  asar:          ' + cls);
    console.log('  backup:        ' + (fs.existsSync(state.backupPath || '') ? state.backupPath : 'MISSING'));
    const w = watcher.watcherStatus();
    console.log('  watcher:       ' + (w[watcher.TASK_HOURLY] || w[watcher.TASK_LOGON] ? 'installed' : 'not installed'));
  }
  const config = readJsonFile(P.configFile, null);
  console.log('  safe mode:     ' + (config ? !!config.safeMode : false));
  const tweaks = discoverTweaks(P.tweaksDir);
  console.log('  tweaks:');
  if (!tweaks.length) console.log('    (none)');
  for (const t of tweaks) {
    const enabled = config && config.tweaks && config.tweaks[t.manifest.id];
    const flag = enabled && enabled.enabled === false ? ' [disabled]' : ' [enabled]';
    const bad = t.invalid ? ' [INVALID: ' + t.error + ']' : '';
    console.log('    ' + t.manifest.id + ' v' + t.manifest.version + ' (' + t.manifest.scope + ')' + flag + bad);
  }
}

async function cmdDoctor() {
  const problems = [];
  const notes = [];
  const { userRoot, P, state } = ctx();

  console.log('ZCode++ doctor');
  console.log('  node:          ' + process.version + (process.version.startsWith('v18') || parseInt(process.version.slice(1)) >= 18 ? '' : ''));

  const info = detect.detectInstall();
  if (!info) {
    problems.push('ZCode install not found (pass --app / set ZCODEPP_APP for CLI commands)');
    console.log('  app:           NOT FOUND');
  } else {
    console.log('  app:           ' + info.exePath + ' (ZCode ' + info.version + ')');
    const fuseInfo = fuses.asarIntegrityBlocksPatching(info.exePath);
    if (fuseInfo.known && fuseInfo.blocks) problems.push('asar integrity fuse is ENABLED — patching impossible');
    else console.log('  fuses:         integrity=' + (fuseInfo.known ? fuseInfo.integrity : 'unknown') + ' onlyAsar=' + (fuseInfo.known ? fuseInfo.onlyLoadAppFromAsar : 'unknown'));
  }

  if (!state) {
    problems.push('not installed (state.json missing)');
  } else {
    const patcher = require('../installer/patch');
    const cls = await patcher.classifyCurrentAsar({ exePath: state.exePath, state });
    console.log('  asar:          ' + cls);
    if (cls === 'unknown') problems.push('app.asar matches neither patched nor original hash — ZCode probably updated; run repair');
    if (!fs.existsSync(state.backupPath || '')) problems.push('backup missing: ' + state.backupPath);

    for (const rel of ['runtime/main.mjs', 'runtime/preload.cjs', 'runtime/config.json', 'runtime/lib/discovery.cjs', 'runtime/lib/logger.cjs', 'runtime/lib/storage.cjs', 'runtime/lib/hot-reload.cjs']) {
      const f = path.join(userRoot, rel);
      if (!fs.existsSync(f)) {
        problems.push('runtime file missing: ' + rel);
        continue;
      }
      if (rel.endsWith('.cjs') || rel.endsWith('.mjs')) {
        try {
          execFileSync(process.execPath, ['--check', f], { stdio: 'pipe' });
        } catch (e) {
          problems.push('runtime file has syntax errors: ' + rel);
        }
      }
    }

    const w = watcher.watcherStatus();
    console.log('  watcher:       ' + (w[watcher.TASK_HOURLY] && w[watcher.TASK_LOGON] ? 'ok' : 'missing/partial'));
    if (state.installed && !(w[watcher.TASK_HOURLY] || w[watcher.TASK_LOGON])) notes.push('watcher not installed — ZCode updates will silently remove the patch (repair manually)');

    const logMain = path.join(P.logDir, 'main.log');
    if (fs.existsSync(logMain)) {
      const tail = fs.readFileSync(logFileSafe(logMain), 'utf8').slice(-4000);
      const booted = tail.includes('runtime booted') || tail.includes('preload registered');
      console.log('  last boot log: ' + (booted ? 'runtime seen active' : 'no recent runtime activity — start ZCode once'));
    } else {
      notes.push('no main.log yet — ZCode has not run since install');
    }
  }

  const config = readJsonFile(P.configFile, null);
  if (config && config.safeMode) notes.push('safe mode is ON — tweaks are skipped');
  for (const t of discoverTweaks(P.tweaksDir)) {
    if (t.invalid) problems.push('invalid tweak ' + t.manifest.id + ': ' + t.error);
  }

  console.log('');
  for (const n of notes) console.log('  note: ' + n);
  if (problems.length) {
    for (const p of problems) console.log('  PROBLEM: ' + p);
    process.exitCode = 1;
  } else {
    console.log('All checks passed.');
  }
}

function logFileSafe(p) {
  return fs.existsSync(p) ? p : p + '.old';
}

function cmdSafeMode(arg) {
  const { P } = ctx();
  const config = readJsonFile(P.configFile, { version: 1, tweaks: {}, dev: {} });
  if (arg === 'on' || arg === 'off') {
    config.safeMode = arg === 'on';
    writeJsonFile(P.configFile, config);
    console.log('safe mode ' + arg + ' (takes effect on next ZCode start)');
  } else {
    console.log('safe mode is ' + (config.safeMode ? 'ON' : 'OFF'));
  }
}

async function cmdDebug(opts) {
  const { state } = ctx();
  if (!state || !state.exePath) throw new Error('Not installed. Run install first.');
  const port = opts.port || 9223;
  console.log('launching ZCode with --remote-debugging-port=' + port + ' ...');
  const child = spawn(state.exePath, ['--remote-debugging-port=' + port], { detached: true, stdio: 'ignore' });
  child.unref();
  const url = 'http://127.0.0.1:' + port + '/json/version';
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 500));
    try {
      const res = await fetch(url);
      if (res.ok) {
        const j = await res.json();
        console.log('CDP endpoint: ' + url);
        console.log('browser:     ' + (j.Browser || '?'));
        console.log('open ' + url.replace('/json/version', '/json/list') + ' to see pages (inspect in Chrome/Edge via the webSocketDebuggerUrl).');
        return;
      }
    } catch (e) {
      /* retry */
    }
  }
  throw new Error('debug port did not come up within 15s (is ZCode already running without the flag?). Close it first.');
}

function cmdNewTweak(opts, name, scope) {
  if (!name || !/^[a-z0-9][a-z0-9-]{1,60}$/i.test(name)) throw new Error('usage: new-tweak <name> (letters, digits, dashes)');
  scope = scope || 'renderer';
  if (!['renderer', 'main', 'both'].includes(scope)) throw new Error('scope must be renderer, main or both');
  const dir = path.resolve(process.cwd(), name);
  if (fs.existsSync(dir)) throw new Error('directory already exists: ' + dir);
  ensureDir(dir);
  const id = 'tweak.' + name.toLowerCase();
  const manifest = {
    id,
    name,
    version: '0.1.0',
    description: 'A ZCode++ tweak.',
    scope,
    main: 'index.js',
  };
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', 'utf8');
  const index =
    scope === 'renderer'
      ? RENDERER_TEMPLATE
      : scope === 'main'
        ? MAIN_TEMPLATE
        : BOTH_TEMPLATE;
  fs.writeFileSync(path.join(dir, 'index.js'), index.replace(/__TWEAK_ID__/g, id), 'utf8');
  console.log('created ' + dir);
  console.log('next: node <zcodepp>/bin/zcodepp.js validate-tweak ' + dir);
  console.log('     node <zcodepp>/bin/zcodepp.js dev ' + dir);
}

function cmdValidateTweak(dirArg) {
  if (!dirArg) throw new Error('usage: validate-tweak <dir>');
  const dir = path.resolve(process.cwd(), dirArg);
  let manifest = null;
  try {
    manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
  } catch (e) {
    throw new Error('manifest.json unreadable: ' + e.message);
  }
  const problems = validateManifest(manifest, dir);
  if (problems.length) {
    for (const p of problems) console.log('PROBLEM: ' + p);
    process.exitCode = 1;
    return;
  }
  try {
    execFileSync(process.execPath, ['--check', path.join(dir, manifest.main)], { stdio: 'pipe' });
  } catch (e) {
    console.log('PROBLEM: entry has syntax errors');
    process.exitCode = 1;
    return;
  }
  console.log('OK: ' + manifest.id + ' v' + manifest.version + ' (' + manifest.scope + ')');
}

function cmdTweaks(sub, id) {
  const { P } = ctx();
  const config = readJsonFile(P.configFile, { version: 1, tweaks: {}, dev: {} });
  const tweaks = discoverTweaks(P.tweaksDir);
  if (sub === 'enable' || sub === 'disable') {
    if (!id) throw new Error('usage: tweaks ' + sub + ' <id>');
    if (!tweaks.some((t) => t.manifest.id === id)) throw new Error('no such tweak: ' + id);
    config.tweaks = config.tweaks || {};
    config.tweaks[id] = { ...(config.tweaks[id] || {}), enabled: sub === 'enable' };
    writeJsonFile(P.configFile, config);
    console.log(id + ' ' + (sub === 'enable' ? 'enabled' : 'disabled') + ' (takes effect on next ZCode start)');
    return;
  }
  for (const t of tweaks) {
    const e = config.tweaks && config.tweaks[t.manifest.id];
    const flag = e && e.enabled === false ? 'disabled' : 'enabled';
    console.log(t.manifest.id.padEnd(28) + (t.invalid ? 'INVALID: ' + t.error : 'v' + t.manifest.version + '  ' + t.manifest.scope + '  ' + flag));
  }
}

async function cmdDev(dirArg) {
  if (!dirArg) throw new Error('usage: dev <tweak-dir>');
  const { userRoot, P, state } = ctx();
  if (!state || !state.installed) throw new Error('ZCode++ must be installed before using dev mode.');
  const srcDir = path.resolve(process.cwd(), dirArg);
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(path.join(srcDir, 'manifest.json'), 'utf8'));
  } catch (e) {
    throw new Error('manifest.json unreadable: ' + e.message);
  }
  const problems = validateManifest(manifest, srcDir);
  if (problems.length) throw new Error('invalid tweak: ' + problems.join('; '));
  const id = manifest.id;
  const dstDir = path.join(P.tweaksDir, id);

  const config = readJsonFile(P.configFile, { version: 1, tweaks: {}, dev: {} });
  config.dev = config.dev || {};
  config.dev[id] = true;
  writeJsonFile(P.configFile, config);

  function push() {
    fs.rmSync(dstDir, { recursive: true, force: true });
    (function copy(s, d) {
      ensureDir(d);
      for (const ent of fs.readdirSync(s, { withFileTypes: true })) {
        if (ent.name === 'node_modules' || ent.name.startsWith('.')) continue;
        const s2 = path.join(s, ent.name);
        const d2 = path.join(d, ent.name);
        if (ent.isDirectory()) copy(s2, d2);
        else if (ent.isFile()) copyFileSyncSafe(s2, d2);
      }
    })(srcDir, dstDir);
    console.log('[' + new Date().toLocaleTimeString() + '] deployed ' + id + ' -> ' + dstDir);
  }
  push();

  console.log('dev mode for ' + id + '. Editing files in ' + srcDir + ' hot-reloads after ZCode restarts');
  console.log('(main-scope tweaks reload automatically; renderer tweaks reload in open windows).');
  console.log('Tailing logs — Ctrl+C to stop dev mode.');
  let timer = null;
  fs.watch(srcDir, { recursive: true }, () => {
    clearTimeout(timer);
    timer = setTimeout(push, 300);
  });

  const logFile = path.join(P.logDir, 'main.log');
  let pos = fs.existsSync(logFile) ? fs.statSync(logFile).size : 0;
  const tail = setInterval(() => {
    try {
      if (!fs.existsSync(logFile)) return;
      const st = fs.statSync(logFile);
      if (st.size < pos) pos = 0; // rotated
      if (st.size > pos) {
        const fh = fs.openSync(logFile, 'r');
        const buf = Buffer.alloc(st.size - pos);
        fs.readSync(fh, buf, 0, buf.length, pos);
        fs.closeSync(fh);
        pos = st.size;
        const lines = buf.toString('utf8').split('\n');
        for (const line of lines) {
          if (line.includes('[tweak:' + id + ']') || line.includes('[renderer:' + id + ']') || line.includes('runtime booted')) {
            console.log(line);
          }
        }
      }
    } catch (e) {
      /* ignore */
    }
  }, 800);

  const stop = () => {
    clearInterval(tail);
    const c = readJsonFile(P.configFile, { version: 1, tweaks: {}, dev: {} });
    if (c.dev) delete c.dev[id];
    writeJsonFile(P.configFile, c);
    console.log('\ndev mode off for ' + id + ' (tweak left installed; disable via `tweaks disable ' + id + '`)');
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

const RENDERER_TEMPLATE = `// ZCode++ renderer tweak. Runs in every ZCode window's preload world:
// full DOM access, no page JS globals (contextIsolation stays intact).
'use strict';

module.exports = {
  async start(api) {
    api.log('hello from ${'__TWEAK_ID__'}');

    // Register a page in the ZCode++ panel (floating Z++ button / Settings tab)
    api.settings.registerPage({
      id: 'main',
      title: 'My Tweak',
      render(root) {
        root.innerHTML = '';
        const h = document.createElement('h3');
        h.textContent = 'Hello from ZCode++';
        const p = document.createElement('p');
        p.textContent = 'Edit index.js and save to iterate (dev mode hot-reloads).';
        const btn = document.createElement('button');
        btn.textContent = 'persist a value';
        btn.addEventListener('click', async () => {
          const n = (await api.storage.get('clicks', 0)) + 1;
          await api.storage.set('clicks', n);
          p.textContent = 'stored clicks: ' + n;
        });
        root.append(h, p, btn);
      },
    });

    // Anything else: plain DOM. Example badge, removed again on stop().
    const badge = document.createElement('div');
    badge.id = 'zcodepp-tweak-badge';
    badge.textContent = 'tweak on';
    badge.style.cssText = 'position:fixed;left:10px;bottom:10px;z-index:2147483000;pointer-events:none;' +
      'background:rgba(30,32,38,.85);color:#9fc3ff;padding:3px 8px;border-radius:6px;font:11px system-ui';
    document.body.appendChild(badge);

    return { badge };
  },

  async stop(api, ctx) {
    if (ctx && ctx.badge) ctx.badge.remove();
  },
};
`;

const MAIN_TEMPLATE = `// ZCode++ main-process tweak: full Electron power, carefully.
'use strict';

module.exports = {
  start(api) {
    api.log('hello from __TWEAK_ID__ (main)');

    // Example: react to windows being created
    const off = api.windows.onCreated((win) => {
      api.log('window created: ' + (win.webContents ? win.webContents.getURL() : '?'));
    });

    // Example: global shortcut toggling DevTools of the focused window
    const { globalShortcut } = api.electron;
    const ok = globalShortcut.register('CommandOrControl+Alt+Shift+D', () => {
      const win = api.electron.BrowserWindow.getFocusedWindow();
      if (win) win.webContents.toggleDevTools();
    });
    api.log('shortcut registered: ' + ok);

    // Persisted per-tweak storage: <userRoot>/tweak-data/__TWEAK_ID__/storage.json
    const boots = (api.storage.get('boots', 0) || 0) + 1;
    api.storage.set('boots', boots);
    api.log('boot #' + boots);

    return { off, registered: ok };
  },

  stop(api, ctx) {
    if (ctx && ctx.off) ctx.off();
    if (ctx && ctx.registered) api.electron.globalShortcut.unregister('CommandOrControl+Alt+Shift+D');
  },
};
`;

const BOTH_TEMPLATE = `// ZCode++ tweak with BOTH scopes. The same file is loaded twice: once in the
// main process and once in each renderer preload. Detect where you are via
// api.manifest (identical) and feature-probe the environment.
'use strict';

const isMain = typeof process !== 'undefined' && !!(process.versions && process.versions.electron) &&
  typeof window === 'undefined';

module.exports = {
  start(api) {
    if (isMain) {
      api.log('running in MAIN process');
      return {};
    }
    api.log('running in RENDERER');
    api.settings.registerPage({
      id: 'main',
      title: 'Both',
      render(root) {
        root.textContent = 'Hello from both scopes (renderer side).';
      },
    });
    return {};
  },
  stop(api, ctx) {
    api.log('stopped');
  },
};
`;

module.exports = {
  cmdInstall,
  cmdUninstall,
  cmdRepair,
  cmdStatus,
  cmdDoctor,
  cmdSafeMode,
  cmdDebug,
  cmdNewTweak,
  cmdValidateTweak,
  cmdTweaks,
  cmdDev,
};
