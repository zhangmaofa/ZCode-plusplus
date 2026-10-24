'use strict';
// Minimal asar archive reader / patcher with zero dependencies.
//
// Header layout, verified byte-for-byte against @zcode/desktop 3.16.3 app.asar:
//   [u32 =4][u32 pickleSize][u32 payloadSize][u32 jsonLen][json bytes][zero pad to 4]
//   payloadSize = 4 + align4(jsonLen);  pickleSize = 4 + payloadSize
//   file data starts at baseOffset = 8 + pickleSize = 16 + align4(jsonLen)
// Entry offsets are decimal STRINGS relative to baseOffset; sizes are numbers.
// Entries with `unpacked: true` live in app.asar.unpacked and have no offset.
// Entries may carry `integrity` (only enforced when the asar-integrity fuse is
// on, which is off for ZCode); we strip it on modified/added entries.

const fs = require('fs');
const crypto = require('crypto');

const PREFIX_LEN = 16;
const CHUNK = 8 * 1024 * 1024;

function align4(n) {
  return (n + 3) & ~3;
}

function readMeta(asarPath) {
  const fd = fs.openSync(asarPath, 'r');
  try {
    const pre = Buffer.alloc(PREFIX_LEN);
    fs.readSync(fd, pre, 0, PREFIX_LEN, 0);
    const pickleSize = pre.readUInt32LE(4);
    const payloadSize = pre.readUInt32LE(8);
    const jsonLen = pre.readUInt32LE(12);
    if (pickleSize !== payloadSize + 4 || payloadSize !== align4(jsonLen) + 4) {
      throw new Error(
        `unexpected asar prefix in ${asarPath} (pickleSize=${pickleSize} payloadSize=${payloadSize} jsonLen=${jsonLen})`
      );
    }
    const jsonBuf = Buffer.alloc(jsonLen);
    fs.readSync(fd, jsonBuf, 0, jsonLen, 16);
    const totalSize = fs.fstatSync(fd).size;
    const header = JSON.parse(jsonBuf.toString('utf8'));
    if (!header || typeof header.files !== 'object') {
      throw new Error(`asar header has no files map: ${asarPath}`);
    }
    return {
      header,
      pickleSize,
      payloadSize,
      jsonLength: jsonLen,
      baseOffset: 8 + pickleSize,
      totalSize,
    };
  } finally {
    fs.closeSync(fd);
  }
}

function encodeHeader(header) {
  const json = Buffer.from(JSON.stringify(header), 'utf8');
  const padded = align4(json.length);
  const payloadSize = 4 + padded;
  const pickleSize = 4 + payloadSize;
  const pre = Buffer.alloc(PREFIX_LEN);
  pre.writeUInt32LE(4, 0);
  pre.writeUInt32LE(pickleSize, 4);
  pre.writeUInt32LE(payloadSize, 8);
  pre.writeUInt32LE(json.length, 12);
  return {
    buf: Buffer.concat([pre, json, Buffer.alloc(padded - json.length, 0)]),
    baseOffset: 8 + pickleSize,
  };
}

/** Iterate every packed (non-directory, non-unpacked) file entry. */
function* walkFiles(dirNode, prefix) {
  for (const [name, node] of Object.entries(dirNode.files || {})) {
    const p = prefix ? `${prefix}/${name}` : name;
    if (node.files) {
      yield* walkFiles(node, p);
    } else if (!node.unpacked && node.offset !== undefined) {
      yield [p, node];
    }
  }
}

function readEntryBuf(fd, baseOffset, entry) {
  const buf = Buffer.alloc(entry.size);
  const read = fs.readSync(fd, buf, 0, entry.size, baseOffset + parseInt(entry.offset, 10));
  if (read !== entry.size) throw new Error('short read from asar');
  return buf;
}

function extractFile(asarPath, name) {
  const meta = readMeta(asarPath);
  const node = meta.header.files[name];
  if (!node) throw new Error(`file not found in asar: ${name}`);
  if (node.files) throw new Error(`asar entry is a directory: ${name}`);
  if (node.unpacked) {
    return fs.readFileSync(asarPath + '.unpacked' + pathSep(name));
  }
  const fd = fs.openSync(asarPath, 'r');
  try {
    return readEntryBuf(fd, meta.baseOffset, node);
  } finally {
    fs.closeSync(fd);
  }
}

function pathSep(name) {
  return '/' + name.split('/').join('\\');
}

/**
 * Rebuild the archive with a new header, copying the original data region
 * verbatim and appending modified/added file contents at the end.
 *
 * Because entry offsets are relative to the end of the header and the data
 * region is copied as one contiguous block, every untouched entry stays valid
 * without re-locating it. Only the changed entries point into the appended
 * region. Cost: one sequential pass over the file (~341 MB for ZCode).
 *
 * @param {object} opts
 * @param {string} opts.asarPath   original archive (left untouched)
 * @param {string} opts.outPath    destination for the patched archive
 * @param {Object<string,string>} [opts.modify]  path -> new content (must exist, must be packed)
 * @param {Object<string,string>} [opts.add]     path -> content (must not exist)
 */
function patchAsarArchive(opts) {
  const { asarPath, outPath } = opts;
  const meta = readMeta(asarPath);
  const header = meta.header;
  const files = header.files;

  const changes = [];
  for (const [name, content] of Object.entries(opts.modify || {})) {
    const node = files[name];
    if (!node || node.files) throw new Error(`modify target missing or is a directory: ${name}`);
    if (node.unpacked) throw new Error(`modify target is unpacked (not supported): ${name}`);
    changes.push({ name, content: Buffer.from(content, 'utf8') });
  }
  for (const [name, content] of Object.entries(opts.add || {})) {
    if (files[name]) throw new Error(`add target already exists: ${name}`);
    changes.push({ name, content: Buffer.from(content, 'utf8') });
  }

  const copyLen = meta.totalSize - meta.baseOffset;
  let pos = 0;
  for (const ch of changes) {
    ch.newOffset = copyLen + pos;
    pos += ch.content.length;
  }
  for (const ch of changes) {
    const node = files[ch.name] || (files[ch.name] = {});
    node.size = ch.content.length;
    node.offset = String(ch.newOffset);
    delete node.integrity; // only enforced with the (disabled) integrity fuse
  }

  const { buf: headerBuf } = encodeHeader(header);
  const out = fs.openSync(outPath, 'w');
  try {
    fs.writeSync(out, headerBuf);
    const inp = fs.openSync(asarPath, 'r');
    try {
      const b = Buffer.alloc(CHUNK);
      let remaining = copyLen;
      while (remaining > 0) {
        const n = Math.min(CHUNK, remaining);
        const r = fs.readSync(inp, b, 0, n, meta.baseOffset + (copyLen - remaining));
        if (r < n) throw new Error('short read while copying data region');
        fs.writeSync(out, b, 0, r);
        remaining -= r;
      }
    } finally {
      fs.closeSync(inp);
    }
    for (const ch of changes) fs.writeSync(out, ch.content);
  } finally {
    fs.closeSync(out);
  }

  return {
    outPath,
    baseOffset: 8 + 4 + align4(Buffer.byteLength(JSON.stringify(header), 'utf8')) + 4,
    changes: changes.map((c) => ({ name: c.name, offset: c.newOffset, size: c.content.length })),
  };
}

/**
 * Verify a patched archive against its original:
 *  - data region of the original is byte-identical inside the patched file
 *  - every changed entry extracts to the expected content
 *  - a sample of untouched entries still extracts identically
 */
async function verifyAgainst(originalPath, patchedPath, expectedChanges, sampleCount = 5) {
  const issues = [];
  const metaO = readMeta(originalPath);
  const metaP = readMeta(patchedPath);

  const dataLen = metaO.totalSize - metaO.baseOffset;
  let appended = 0;
  for (const ch of Object.values(expectedChanges)) appended += Buffer.byteLength(ch, 'utf8');
  const expectedTotal = metaP.baseOffset + dataLen + appended;
  if (metaP.totalSize !== expectedTotal) {
    issues.push(`total size ${metaP.totalSize} != expected ${expectedTotal}`);
  }

  // byte-compare the copied data region
  const fdO = fs.openSync(originalPath, 'r');
  const fdP = fs.openSync(patchedPath, 'r');
  try {
    const bo = Buffer.alloc(CHUNK);
    const bp = Buffer.alloc(CHUNK);
    let remaining = dataLen;
    let pos = 0;
    while (remaining > 0) {
      const n = Math.min(CHUNK, remaining);
      const ro = fs.readSync(fdO, bo, 0, n, metaO.baseOffset + pos);
      const rp = fs.readSync(fdP, bp, 0, n, metaP.baseOffset + pos);
      if (ro !== n || rp !== n) {
        issues.push(`short read during data compare at ${pos}`);
        break;
      }
      if (!bo.subarray(0, n).equals(bp.subarray(0, n))) {
        issues.push(`data region diverges at offset ${pos}`);
        break;
      }
      pos += n;
      remaining -= n;
    }
  } finally {
    fs.closeSync(fdO);
    fs.closeSync(fdP);
  }

  // changed entries carry the expected content
  const patchedHeader = metaP.header.files;
  for (const [name, expected] of Object.entries(expectedChanges)) {
    const node = patchedHeader[name];
    if (!node || node.size !== Buffer.byteLength(expected, 'utf8')) {
      issues.push(`changed entry header wrong: ${name}`);
      continue;
    }
    const fd = fs.openSync(patchedPath, 'r');
    try {
      const got = readEntryBuf(fd, metaP.baseOffset, node).toString('utf8');
      if (got !== expected) issues.push(`changed entry content wrong: ${name}`);
    } finally {
      fs.closeSync(fd);
    }
  }

  // sample untouched entries
  const untouched = [];
  for (const [p, node] of walkFiles(metaO.header, '')) {
    if (expectedChanges[p] === undefined) untouched.push([p, node]);
  }
  const step = Math.max(1, Math.floor(untouched.length / sampleCount));
  const samples = untouched.filter((_, i) => i % step === 0).slice(0, sampleCount);
  const a = fs.openSync(originalPath, 'r');
  const b = fs.openSync(patchedPath, 'r');
  try {
    for (const [p, node] of samples) {
      const ha = crypto.createHash('sha256').update(readEntryBuf(a, metaO.baseOffset, node)).digest('hex');
      const nodeP = findNode(metaP.header, p);
      if (!nodeP) {
        issues.push(`entry vanished from patched header: ${p}`);
        continue;
      }
      const hb = crypto.createHash('sha256').update(readEntryBuf(b, metaP.baseOffset, nodeP)).digest('hex');
      if (ha !== hb) issues.push(`sample entry content changed: ${p}`);
    }
  } finally {
    fs.closeSync(a);
    fs.closeSync(b);
  }

  return { ok: issues.length === 0, issues, samplesChecked: samples.length };
}

function findNode(header, slashPath) {
  let node = header;
  for (const part of slashPath.split('/')) {
    if (!node || !node.files) return null;
    node = node.files[part];
  }
  return node && !node.files ? node : null;
}

module.exports = {
  readMeta,
  encodeHeader,
  walkFiles,
  extractFile,
  patchAsarArchive,
  verifyAgainst,
};
