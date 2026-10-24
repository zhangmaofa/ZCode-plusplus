'use strict';
// Per-tweak JSON key/value storage: <userRoot>/tweak-data/<id>/storage.json
// Used by the main process directly and by the renderer through IPC.
const fs = require('fs');
const path = require('path');

const caches = new Map();

function open(tweakDataDir, id) {
  const file = path.join(tweakDataDir, id, 'storage.json');
  let data;
  if (caches.has(file)) {
    data = caches.get(file);
  } else {
    try {
      data = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (e) {
      data = {};
    }
    caches.set(file, data);
  }
  return {
    get(key, def) {
      return key in data ? data[key] : def;
    },
    set(key, value) {
      data[key] = value;
      flush();
    },
    all() {
      return { ...data };
    },
    file,
  };

  function flush() {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const tmp = file + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
      fs.renameSync(tmp, file);
    } catch (e) {
      /* storage failures are non-fatal */
    }
  }
}

module.exports = { open };
