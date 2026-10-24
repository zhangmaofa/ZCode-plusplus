// ZCode++ builtin reference tweak (renderer scope).
// Runs in every ZCode window's preload world: full DOM access, while the
// page's own JS context stays untouched (contextIsolation intact).
'use strict';

module.exports = {
  async start(api) {
    api.log('hello from zcodepp.hello');

    api.settings.registerPage({
      id: 'hello',
      title: 'Hello',
      render(root) {
        root.innerHTML = '';
        const h = document.createElement('h3');
        h.textContent = 'Hello from ZCode++';
        h.style.margin = '0 0 8px';
        const p = document.createElement('p');
        p.style.opacity = '0.75';
        p.textContent = 'This page is rendered by a tweak. Your tweaks live in ~/.zcode/zcode-plusplus/tweaks.';
        const btn = document.createElement('button');
        btn.textContent = 'count a click';
        btn.style.cssText =
          'padding:6px 12px;border-radius:7px;border:1px solid rgba(255,255,255,.2);' +
          'background:rgba(90,130,255,.25);color:#e8eaf0;cursor:pointer';
        btn.addEventListener('click', async () => {
          const n = (await api.storage.get('clicks', 0)) + 1;
          await api.storage.set('clicks', n);
          p.textContent = 'stored clicks: ' + n + ' (persisted via the zcodepp storage API)';
        });
        root.append(h, p, btn);
      },
    });

    const badge = document.createElement('div');
    badge.id = 'zcodepp-hello-badge';
    badge.textContent = 'ZCode++ ✓';
    badge.style.cssText =
      'position:fixed;left:10px;bottom:10px;z-index:2147483000;pointer-events:none;' +
      'background:rgba(30,32,38,.85);color:#9fc3ff;padding:3px 8px;border-radius:6px;' +
      'font:11px system-ui,sans-serif;border:1px solid rgba(159,195,255,.35)';
    document.body.appendChild(badge);

    return { badge };
  },

  async stop(api, ctx) {
    if (ctx && ctx.badge) ctx.badge.remove();
  },
};
