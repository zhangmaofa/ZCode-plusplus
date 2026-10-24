'use strict';
// Runtime file logger with naive size-based rotation. Never throws.
const fs = require('fs');
const path = require('path');

const MAX_BYTES = 5 * 1024 * 1024;

function create(tag, logDir) {
  let file = null;
  try {
    fs.mkdirSync(logDir, { recursive: true });
    file = path.join(logDir, tag + '.log');
    try {
      if (fs.statSync(file).size > MAX_BYTES) fs.renameSync(file, file + '.old');
    } catch (e) {
      /* no existing log */
    }
  } catch (e) {
    file = null;
  }

  function write(level, args) {
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
    const line = `${ts} [${level}] ${body}\n`;
    try {
      if (file) fs.appendFileSync(file, line);
    } catch (e) {
      /* disk issues must never break the app */
    }
    try {
      console.log(`[zcodepp:${tag}] ${line.trimEnd()}`);
    } catch (e) {
      /* console may be unavailable in some contexts */
    }
  }

  return {
    info: (...a) => write('info', a),
    warn: (...a) => write('warn', a),
    error: (...a) => write('error', a),
  };
}

module.exports = { create };
