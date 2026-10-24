'use strict';
// Minimal Electron fuse-wire reader (zero deps).
// Empirical layout in ZCode.exe (matches @electron/fuses output byte-for-byte):
//   [sentinel 32B ascii][u8 fuse wire version][u8 fuse count][state char per fuse]
// State chars: '0' = DISABLE, '1' = ENABLE, 'r' = REMOVED.
const fs = require('fs');

const SENTINEL = 'dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX';

// Order of the first fuses on the wire (v1, matches @electron/fuses FUSE_V1)
const FUSE_NAMES = [
  'runAsNode',
  'enableCookieEncryption',
  'enableNodeOptionsEnvironmentVariable',
  'enableNodeCliInspectArguments',
  'enableEmbeddedAsarIntegrityValidation',
  'onlyLoadAppFromAsar',
  'loadBrowserProcessSpecificV8Snapshot',
  'grantFileProtocolExtraPrivileges',
  // later Electron builds append more fuses; index beyond this list is unknown
];

function readFuses(exePath) {
  const fh = fs.openSync(exePath, 'r');
  let buf;
  try {
    const stat = fs.fstatSync(fh);
    // The fuse wire lives in the rdata-ish region; scanning the first 256 MB is
    // more than enough and avoids reading very large binaries whole.
    const scanLen = Math.min(stat.size, 256 * 1024 * 1024);
    buf = Buffer.alloc(scanLen);
    fs.readSync(fh, buf, 0, scanLen, 0);
  } finally {
    fs.closeSync(fh);
  }
  const idx = buf.indexOf(Buffer.from(SENTINEL, 'ascii'));
  if (idx === -1) return { found: false, version: null, fuses: null };
  let p = idx + SENTINEL.length;
  const version = buf.readUInt8(p);
  p += 1;
  const count = buf.readUInt8(p);
  p += 1;
  if (count < 1 || count > 32) return { found: false, version, fuses: null };
  const fuses = {};
  for (let i = 0; i < count; i++) {
    const c = String.fromCharCode(buf.readUInt8(p + i));
    const name = FUSE_NAMES[i] || `fuse${i}`;
    fuses[name] = c === '1' ? 'enabled' : c === '0' ? 'disabled' : c === 'r' ? 'removed' : `unknown(${c})`;
  }
  return { found: true, version, fuses };
}

/** Patching app.asar is unsafe while the asar-integrity fuse is ENABLED. */
function asarIntegrityBlocksPatching(exePath) {
  const r = readFuses(exePath);
  if (!r.found) return { known: false, blocks: false, fuses: null };
  const integrity = r.fuses.enableEmbeddedAsarIntegrityValidation;
  return {
    known: true,
    blocks: integrity === 'enabled',
    integrity,
    onlyLoadAppFromAsar: r.fuses.onlyLoadAppFromAsar,
    fuses: r.fuses,
  };
}

module.exports = { readFuses, asarIntegrityBlocksPatching, FUSE_NAMES };
