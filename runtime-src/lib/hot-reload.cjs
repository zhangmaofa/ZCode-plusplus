'use strict';
// Main-side tweak directory watcher. Windows supports recursive fs.watch.
function watchTweaks(tweaksDir, onTweakChanged) {
  let timer = null;
  const pending = new Set();
  try {
    const w = fs.watch(tweaksDir, { recursive: true }, (_eventType, filename) => {
      if (!filename) return;
      const id = String(filename).split(/[\\/]/)[0];
      if (!id) return;
      pending.add(id);
      clearTimeout(timer);
      timer = setTimeout(() => {
        const ids = [...pending];
        pending.clear();
        for (const id2 of ids) onTweakChanged(id2);
      }, 300);
    });
    return {
      close() {
        clearTimeout(timer);
        try {
          w.close();
        } catch (e) {
          /* ignore */
        }
      },
    };
  } catch (e) {
    return { close() {} };
  }
}

module.exports = { watchTweaks };
