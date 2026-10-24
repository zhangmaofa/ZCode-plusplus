'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
  return p;
}

function hashFile(p, algo = 'sha256') {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash(algo);
    const s = fs.createReadStream(p, { highWaterMark: 4 * 1024 * 1024 });
    s.on('data', (c) => h.update(c));
    s.on('error', reject);
    s.on('end', () => resolve(h.digest('hex')));
  });
}

function hashFileSync(p, algo = 'sha256') {
  const h = crypto.createHash(algo);
  h.update(fs.readFileSync(p));
  return h.digest('hex');
}

function copyFileSyncSafe(src, dst) {
  ensureDir(path.dirname(dst));
  const tmp = dst + '.zcodepp-tmp';
  fs.copyFileSync(src, tmp);
  try {
    fs.unlinkSync(dst);
  } catch (e) {
    /* destination may not exist yet */
  }
  fs.renameSync(tmp, dst);
  return dst;
}

function readJsonFile(p, fallback) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (e) {
    if (e.code === 'ENOENT') return fallback;
    return fallback;
  }
}

function writeJsonFile(p, obj) {
  ensureDir(path.dirname(p));
  const tmp = p + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf8');
  fs.renameSync(tmp, p);
  return p;
}

function logLine(level, tag, args) {
  const ts = new Date().toISOString();
  const body = args
    .map((a) => {
      if (typeof a === 'string') return a;
      try {
        return JSON.stringify(a);
      } catch (e) {
        return String(a);
      }
    })
    .join(' ');
  return `${ts} [${level}] [${tag}] ${body}`;
}

module.exports = {
  ensureDir,
  hashFile,
  hashFileSync,
  copyFileSyncSafe,
  readJsonFile,
  writeJsonFile,
  logLine,
};
