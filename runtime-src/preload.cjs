// ZCode++ renderer preload. Deployed to <userRoot>/runtime/preload.cjs and
// registered additively on every session. Self-contained on purpose: a
// sandboxed preload cannot `require` sibling files, so the bridge, the tweak
// loader and the settings UI all live in this single file. Everything is
// wrapped in try/catch — a failure here must never affect the host app.
(function () {
  'use strict';

  // ---------------------------------------------------------------------
  // Electron bootstrap
  // ---------------------------------------------------------------------
  let electron = null;
  try {
    electron = require('electron');
  } catch (e) {
    return; // not an electron renderer we can hook
  }
  const { ipcRenderer, contextBridge } = electron || {};
  if (!ipcRenderer || !ipcRenderer.invoke) return;

  window.addEventListener('unhandledrejection', (e) => {
    try {
      console.warn('[zcodepp] unhandled rejection', e && e.reason);
    } catch (e2) {
      /* ignore */
    }
  });

  async function call(channel, payload) {
    try {
      return await ipcRenderer.invoke(channel, payload);
    } catch (e) {
      return { ok: false, error: String(e) };
    }
  }

  const bridge = {
    getState: () => call('zcodepp:get-state', {}),
    readBundle: async (id) => {
      const r = await call('zcodepp:read-bundle', { id });
      return r && r.ok ? r.value : null;
    },
    storageGet: async (id, key, def) => {
      const r = await call('zcodepp:storage-get', { id, key, def });
      return r && r.ok ? r.value : def;
    },
    storageSet: async (id, key, value) => {
      const r = await call('zcodepp:storage-set', { id, key, value });
      return !!(r && r.ok);
    },
    sendLog: (id, level, args) => {
      try {
        ipcRenderer.send('zcodepp:renderer-log', { id, level, args });
      } catch (e) {
        /* ignore */
      }
    },
    onReloadTweak: (cb) => {
      try {
        ipcRenderer.on('zcodepp:reload-tweak', (_e, id) => cb(id));
      } catch (e) {
        /* ignore */
      }
    },
  };

  // Expose to the page world too (handy for debugging from DevTools); tweaks
  // themselves live in the preload world and use the closure directly.
  try {
    if (contextBridge && contextBridge.exposeInMainWorld) {
      contextBridge.exposeInMainWorld('__zcodepp', bridge);
    }
  } catch (e) {
    /* contextIsolation may be off; that's fine */
  }

  // Real CommonJS require (non-sandboxed preload) — lets tweaks require node
  // builtins. Sandboxed preloads fall back to the in-memory bundle loader.
  const nodeRequire = (function () {
    try {
      const p = require('node:path');
      if (p && typeof p.join === 'function') return require;
    } catch (e) {
      /* sandboxed */
    }
    return null;
  })();

  // ---------------------------------------------------------------------
  // In-memory CommonJS loader over a pre-fetched bundle (sandboxed mode)
  // ---------------------------------------------------------------------
  function loadFromBundle(files, tweakId, entryFile) {
    const cache = new Map();
    const loading = new Set();

    function normalize(base, request) {
      const stack = base === '__entry__' ? [] : base.split('/').slice(0, -1);
      for (const part of request.split('/')) {
        if (part === '' || part === '.') continue;
        if (part === '..') stack.pop();
        else stack.push(part);
      }
      return stack.join('/');
    }

    function tryCandidates(p) {
      const candidates = [p, p + '.js', p + '.json', p + '/index.js'];
      for (const c of candidates) {
        if (Object.prototype.hasOwnProperty.call(files, c)) return { path: c };
      }
      return null;
    }

    function requireFrom(base, request) {
      if (typeof request !== 'string' || !request.startsWith('.')) {
        throw new Error(
          'sandboxed tweaks can only require relative files (got ' +
            JSON.stringify(request) +
            '); node builtins need a non-sandboxed preload'
        );
      }
      const resolved = normalize(base, request);
      if (loading.has(resolved)) throw new Error('circular require: ' + resolved);
      if (cache.has(resolved)) return cache.get(resolved);
      const hit = tryCandidates(resolved);
      if (!hit) throw new Error('cannot resolve ' + JSON.stringify(request) + ' from ' + JSON.stringify(base));
      if (hit.path.endsWith('.json')) {
        const value = JSON.parse(files[hit.path]);
        cache.set(resolved, value);
        return value;
      }
      const module = { exports: {} };
      cache.set(resolved, module.exports);
      loading.add(resolved);
      try {
        const fn = new Function(
          'module',
          'exports',
          'require',
          '__filename',
          '__dirname',
          files[hit.path] + '\n//# sourceURL=zcodepp-tweak:///' + tweakId + '/' + hit.path
        );
        fn(
          module,
          module.exports,
          (r) => requireFrom(hit.path, r),
          hit.path,
          hit.path.split('/').slice(0, -1).join('/')
        );
      } finally {
        loading.delete(resolved);
      }
      cache.set(resolved, module.exports);
      return module.exports;
    }

    return requireFrom('__entry__', './' + String(entryFile).replace(/^\.?\//, ''));
  }

  function bustNodeCache(rootDir) {
    try {
      for (const key of Object.keys(nodeRequire.cache || {})) {
        if (key.startsWith(rootDir)) delete nodeRequire.cache[key];
      }
    } catch (e) {
      /* ignore */
    }
  }

  // ---------------------------------------------------------------------
  // Settings pages registry + renderer tweak API
  // ---------------------------------------------------------------------
  const registry = []; // { tweakId, id, title, render }
  let refreshUI = function () {};

  function makeApi(t, st) {
    const id = t.manifest.id;
    return {
      manifest: t.manifest,
      version: st.version,
      settings: {
        registerPage(page) {
          if (!page || typeof page.render !== 'function') return;
          registry.push({
            tweakId: id,
            id: page.id || 'page',
            title: page.title || t.manifest.name || id,
            render: page.render,
          });
          refreshUI();
        },
      },
      storage: {
        get: (k, d) => bridge.storageGet(id, k, d),
        set: (k, v) => bridge.storageSet(id, k, v),
      },
      log: (...a) => bridge.sendLog(id, 'info', a),
      warn: (...a) => bridge.sendLog(id, 'warn', a),
      error: (...a) => bridge.sendLog(id, 'error', a),
    };
  }

  // ---------------------------------------------------------------------
  // Tweak lifecycle (renderer scope)
  // ---------------------------------------------------------------------
  const running = new Map(); // id -> { mod, api, ctx }

  async function stopTweak(id) {
    const r = running.get(id);
    if (!r) return;
    running.delete(id);
    try {
      if (r.mod && typeof r.mod.stop === 'function') r.mod.stop(r.api, r.ctx);
    } catch (e) {
      console.warn('[zcodepp] tweak stop() failed:', id, e);
    }
  }

  async function startTweak(t, st) {
    const id = t.manifest.id;
    await stopTweak(id);
    let mod;
    if (nodeRequire) {
      const pathMod = nodeRequire('node:path');
      const tweakDir = pathMod.join(st.userRoot, 'tweaks', id);
      bustNodeCache(tweakDir);
      mod = nodeRequire(pathMod.join(tweakDir, t.manifest.main));
    } else {
      const files = await bridge.readBundle(id);
      if (!files) throw new Error('bundle unavailable (is the main runtime running?)');
      mod = loadFromBundle(files, id, t.manifest.main);
    }
    if (!mod || typeof mod.start !== 'function') throw new Error('entry does not export start(api)');
    const api = makeApi(t, st);
    const ctx = mod.start(api);
    running.set(id, { mod, api, ctx });
    bridge.sendLog(id, 'info', ['renderer tweak started']);
  }

  // ---------------------------------------------------------------------
  // UI: shared panel, native settings integration, overlay launcher
  // ---------------------------------------------------------------------
  const CSS_ID = 'zcodepp-style';
  const CSS = `
#zcodepp-launcher{position:fixed;right:16px;bottom:16px;z-index:2147483000;width:38px;height:38px;border-radius:50%;
  border:1px solid rgba(255,255,255,.18);background:rgba(30,32,38,.92);color:#e8eaf0;font-size:12px;font-weight:600;
  cursor:pointer;box-shadow:0 4px 14px rgba(0,0,0,.35);display:flex;align-items:center;justify-content:center;user-select:none}
#zcodepp-launcher:hover{background:rgba(48,52,62,.95)}
#zcodepp-panel{position:fixed;right:16px;bottom:62px;z-index:2147483000;width:440px;max-width:calc(100vw - 32px);
  height:520px;max-height:calc(100vh - 90px);display:none;flex-direction:column;border-radius:12px;overflow:hidden;
  background:#1c1e24;color:#e8eaf0;border:1px solid rgba(255,255,255,.12);box-shadow:0 12px 40px rgba(0,0,0,.5);
  font:13px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
#zcodepp-panel.zcodepp-open{display:flex}
.zcodepp-head{display:flex;align-items:center;justify-content:space-between;padding:10px 14px;
  border-bottom:1px solid rgba(255,255,255,.1);font-weight:600}
.zcodepp-close{cursor:pointer;opacity:.6;padding:2px 6px}.zcodepp-close:hover{opacity:1}
.zcodepp-body{flex:1;display:flex;min-height:0}
.zcodepp-nav{width:170px;overflow-y:auto;border-right:1px solid rgba(255,255,255,.08);padding:6px}
.zcodepp-nav-item{padding:7px 10px;border-radius:7px;cursor:pointer;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.zcodepp-nav-item:hover{background:rgba(255,255,255,.07)}
.zcodepp-nav-item.zcodepp-active{background:rgba(90,130,255,.25)}
.zcodepp-content{flex:1;overflow-y:auto;padding:14px}
.zcodepp-empty{opacity:.55;padding:10px 4px}
.zcodepp-tab-panel{display:none}.zcodepp-tab-panel.zcodepp-open{display:block}
`;

  function ensureStyles() {
    if (document.getElementById(CSS_ID)) return;
    const style = document.createElement('style');
    style.id = CSS_ID;
    style.textContent = CSS;
    (document.head || document.documentElement).appendChild(style);
  }

  function renderPanelContent(navEl, contentEl) {
    navEl.textContent = '';
    if (!registry.length) {
      contentEl.innerHTML = '';
      const empty = document.createElement('div');
      empty.className = 'zcodepp-empty';
      empty.textContent = 'No tweak pages registered yet.';
      contentEl.appendChild(empty);
      return;
    }
    registry.forEach((page, i) => {
      const item = document.createElement('div');
      item.className = 'zcodepp-nav-item' + (i === 0 ? ' zcodepp-active' : '');
      item.textContent = page.title;
      item.title = page.tweakId + ' / ' + page.id;
      item.addEventListener('click', () => {
        for (const el of navEl.children) el.classList.remove('zcodepp-active');
        item.classList.add('zcodepp-active');
        showPage(page, contentEl);
      });
      navEl.appendChild(item);
      if (i === 0) showPage(page, contentEl);
    });
  }

  function showPage(page, contentEl) {
    contentEl.textContent = '';
    try {
      page.render(contentEl);
    } catch (e) {
      const pre = document.createElement('pre');
      pre.style.whiteSpace = 'pre-wrap';
      pre.style.color = '#ff9c9c';
      pre.textContent = 'page render error: ' + ((e && e.stack) || e);
      contentEl.appendChild(pre);
    }
  }

  function buildPanel(idSuffix) {
    const panel = document.createElement('div');
    panel.id = 'zcodepp-panel' + (idSuffix ? '-' + idSuffix : '');
    panel.className = 'zcodepp-tab-panel zcodepp-open';
    panel.style.cssText = 'position:static;display:flex;width:auto;height:auto;max-height:none;flex:1;min-height:0';
    const head = document.createElement('div');
    head.className = 'zcodepp-head';
    head.textContent = 'ZCode++';
    const body = document.createElement('div');
    body.className = 'zcodepp-body';
    const nav = document.createElement('div');
    nav.className = 'zcodepp-nav';
    const content = document.createElement('div');
    content.className = 'zcodepp-content';
    body.appendChild(nav);
    body.appendChild(content);
    panel.appendChild(head);
    panel.appendChild(body);
    renderPanelContent(nav, content);
    return panel;
  }

  // ---- overlay launcher (always available; independent of ZCode DOM) ----
  function mountOverlay() {
    if (document.getElementById('zcodepp-launcher')) return;
    ensureStyles();
    const launcher = document.createElement('div');
    launcher.id = 'zcodepp-launcher';
    launcher.title = 'ZCode++ tweaks';
    launcher.textContent = 'Z++';
    const panel = document.createElement('div');
    panel.id = 'zcodepp-panel';
    panel.innerHTML =
      '<div class="zcodepp-head">ZCode++ <span class="zcodepp-close" title="close">✕</span></div>';
    const body = document.createElement('div');
    body.className = 'zcodepp-body';
    const nav = document.createElement('div');
    nav.className = 'zcodepp-nav';
    const content = document.createElement('div');
    content.className = 'zcodepp-content';
    body.appendChild(nav);
    body.appendChild(content);
    panel.appendChild(body);
    launcher.addEventListener('click', () => {
      const open = panel.classList.toggle('zcodepp-open');
      if (open) renderPanelContent(nav, content);
    });
    panel.querySelector('.zcodepp-close').addEventListener('click', () => panel.classList.remove('zcodepp-open'));
    document.body.appendChild(launcher);
    document.body.appendChild(panel);
  }

  // ---- native settings dialog integration (selector-driven, self-healing) ----
  const DEFAULT_SELECTORS = {
    dialogSelector: '[role="dialog"]',
    tabListSelector: '[role="tablist"]',
    tabSelector: '[role="tab"]',
    panelContainerSelector: null,
  };

  function watchNativeSettings(selectors) {
    const sel = Object.assign({}, DEFAULT_SELECTORS, selectors || {});
    if (!sel.dialogSelector || !sel.tabListSelector) return;
    let injectedDialog = null;
    let injectedTab = null;
    let injectedPanel = null;

    function cleanup() {
      injectedDialog = null;
      injectedTab = null;
      injectedPanel = null;
    }

    function injectTab(dlg) {
      const tablist = dlg.querySelector(sel.tabListSelector);
      if (!tablist) return false;
      const tabs = tablist.querySelectorAll(sel.tabSelector);
      if (!tabs || !tabs.length) return false;
      const proto = tabs[tabs.length - 1];

      const tab = document.createElement(proto.tagName === 'BUTTON' ? 'button' : 'div');
      tab.setAttribute('data-zcodepp', 'tab');
      tab.setAttribute('role', 'tab');
      tab.setAttribute('aria-selected', 'false');
      if (proto.className && typeof proto.className === 'string') tab.className = proto.className;
      tab.style.cursor = 'pointer';
      tab.textContent = 'ZCode++';

      const container = (sel.panelContainerSelector && dlg.querySelector(sel.panelContainerSelector)) || dlg;
      const panel = buildPanel('native');
      panel.style.display = 'none';

      function activate() {
        panel.style.display = 'block';
        tab.setAttribute('aria-selected', 'true');
        // re-render in case pages registered since last open
        const nav = panel.querySelector('.zcodepp-nav');
        const content = panel.querySelector('.zcodepp-content');
        renderPanelContent(nav, content);
      }
      function deactivate() {
        panel.style.display = 'none';
        tab.setAttribute('aria-selected', 'false');
      }
      tab.addEventListener('click', (ev) => {
        ev.stopPropagation();
        activate();
      });
      // hide our panel whenever a native tab inside the tablist is clicked
      tablist.addEventListener('click', (ev) => {
        if (ev.target && ev.target.closest && ev.target.closest('[data-zcodepp="tab"]')) return;
        deactivate();
      });

      proto.parentElement.appendChild(tab);
      container.appendChild(panel);
      injectedDialog = dlg;
      injectedTab = tab;
      injectedPanel = panel;
      return true;
    }

    function scan() {
      if (!registry.length) return;
      if (injectedDialog) {
        if (!document.contains(injectedDialog) || !document.contains(injectedTab)) {
          if (injectedPanel && injectedPanel.parentNode) injectedPanel.parentNode.removeChild(injectedPanel);
          cleanup();
        } else {
          return; // healthy
        }
      }
      const dialogs = document.querySelectorAll(sel.dialogSelector);
      for (const dlg of dialogs) {
        if (injectTab(dlg)) break;
      }
    }

    const mo = new MutationObserver(() => scan());
    mo.observe(document.documentElement, { childList: true, subtree: true });
  }

  // ---------------------------------------------------------------------
  // Boot
  // ---------------------------------------------------------------------
  function domReady() {
    return new Promise((resolve) => {
      if (document.readyState === 'complete' || document.readyState === 'interactive') return resolve();
      document.addEventListener('DOMContentLoaded', () => resolve(), { once: true });
    });
  }

  function passesWindowFilter(overlayCfg) {
    try {
      const re = overlayCfg && overlayCfg.includeRegex;
      if (!re) return true;
      return new RegExp(re).test(location.href);
    } catch (e) {
      return true;
    }
  }

  (async function boot() {
    try {
      const r = await bridge.getState();
      const st = r && r.ok ? r.value : null;
      if (!st) {
        console.warn('[zcodepp] main runtime unreachable; tweaks disabled');
        return;
      }
      const overlayOk = passesWindowFilter(st.overlay);
      await domReady();
      try {
        if (overlayOk && (!st.overlay || st.overlay.launcher !== false)) mountOverlay();
      } catch (e) {
        console.warn('[zcodepp] overlay mount failed', e);
      }
      refreshUI = function () {
        // panels re-render lazily on open; overlay re-render if open
        try {
          const panel = document.getElementById('zcodepp-panel');
          if (panel && panel.classList.contains('zcodepp-open')) {
            const nav = panel.querySelector('.zcodepp-nav');
            const content = panel.querySelector('.zcodepp-content');
            if (nav && content) renderPanelContent(nav, content);
          }
        } catch (e) {
          /* ignore */
        }
      };
      try {
        if (overlayOk) watchNativeSettings(st.selectors);
      } catch (e) {
        console.warn('[zcodepp] settings integration failed', e);
      }

      if (!st.safeMode) {
        const tweaks = st.tweaks || [];
        for (const t of tweaks) {
          if (!t || t.invalid || t.enabled === false || !t.manifest) continue;
          if (t.manifest.scope === 'main') continue;
          startTweak(t, st).catch((err) => {
            console.warn('[zcodepp] tweak failed:', t.manifest.id, err);
            bridge.sendLog(t.manifest.id, 'error', [String((err && err.stack) || err)]);
          });
        }
        bridge.onReloadTweak((id) => {
          const t = tweaks.find((x) => x.manifest && x.manifest.id === id);
          if (t && !t.invalid && t.enabled !== false && t.manifest.scope !== 'main') {
            startTweak(t, st).catch(() => {});
          } else {
            stopTweak(id).catch(() => {});
          }
        });
      }
      bridge.sendLog('runtime', 'info', ['preload active, sandboxed=' + !nodeRequire]);
    } catch (e) {
      try {
        console.warn('[zcodepp] preload boot failed', e);
      } catch (e2) {
        /* ignore */
      }
    }
  })();
})();
