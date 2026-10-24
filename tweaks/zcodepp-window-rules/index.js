// ZCode++ builtin reference tweak (main scope). Full Electron access via
// api.electron; everything guarded so a failure never harms the host app.
'use strict';

const SHORTCUT = 'CommandOrControl+Alt+Shift+D';

module.exports = {
  start(api) {
    api.log('window-rules started');

    const off = api.windows.onCreated((win) => {
      try {
        const url = win.webContents ? win.webContents.getURL() : '';
        api.log('window created: ' + (url || '(no url yet)'));
      } catch (e) {
        api.warn('window created (url unavailable)');
      }
    });

    let shortcutOk = false;
    try {
      const { globalShortcut } = api.electron;
      shortcutOk = globalShortcut.register(SHORTCUT, () => {
        try {
          const win = api.electron.BrowserWindow.getFocusedWindow();
          if (win) win.webContents.toggleDevTools();
        } catch (e) {
          api.warn('devtools toggle failed');
        }
      });
      api.log('shortcut ' + SHORTCUT + ' registered: ' + shortcutOk);
    } catch (e) {
      api.warn('shortcut registration failed: ' + e.message);
    }

    const boots = (api.storage.get('boots', 0) || 0) + 1;
    api.storage.set('boots', boots);
    api.log('ZCode++ has booted ' + boots + ' time(s) with this tweak');

    return { off, shortcutOk };
  },

  stop(api, ctx) {
    if (ctx && ctx.off) ctx.off();
    if (ctx && ctx.shortcutOk) {
      try {
        api.electron.globalShortcut.unregister(SHORTCUT);
      } catch (e) {
        /* ignore */
      }
    }
  },
};
