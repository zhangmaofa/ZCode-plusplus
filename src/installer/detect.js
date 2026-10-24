'use strict';
const fs = require('fs');
const { execSync } = require('child_process');
const asar = require('./asar');
const { findZCodeExe, asarPathFromExe } = require('../common/paths');

/**
 * Validate an install: exe exists, app.asar readable and is @zcode/desktop.
 * @returns {{exePath, asarPath, version, productName, packageJson}|null}
 */
function inspectInstall(exePath) {
  if (!exePath || !fs.existsSync(exePath)) return null;
  const asarPath = asarPathFromExe(exePath);
  if (!fs.existsSync(asarPath)) return null;
  let pkg;
  try {
    pkg = JSON.parse(asar.extractFile(asarPath, 'package.json').toString('utf8'));
  } catch (e) {
    return null;
  }
  if (pkg.name !== '@zcode/desktop') return null;
  return {
    exePath,
    asarPath,
    version: pkg.version,
    productName: pkg.productName || 'ZCode',
    packageJson: pkg,
    alreadyPatched: pkg.main === 'zcodepp-loader.mjs',
    originalMain: (pkg.__zcodepp && pkg.__zcodepp.originalMain) || pkg.main,
  };
}

function detectInstall(explicit) {
  const exe = findZCodeExe(explicit);
  if (!exe) return null;
  return inspectInstall(exe);
}

/** True if any ZCode.exe process is running (patching requires the app closed). */
function isZCodeRunning() {
  try {
    const out = execSync('tasklist /FI "IMAGENAME eq ZCode.exe" /FO CSV /NH', {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return /^"ZCode\.exe"/m.test(out);
  } catch (e) {
    return false;
  }
}

/** Block until no ZCode.exe remains, polling. Returns false on timeout. */
function waitForZCodeExit(timeoutMs = 30 * 60 * 1000, pollMs = 2000) {
  const start = Date.now();
  let ticks = 0;
  for (;;) {
    if (!isZCodeRunning()) return true;
    if (Date.now() - start > timeoutMs) return false;
    if (++ticks % 8 === 0) {
      try {
        process.stdout.write('still waiting for ZCode to exit...\n');
      } catch (e) {
        /* stdout may be closed */
      }
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, pollMs);
  }
}

module.exports = { detectInstall, inspectInstall, isZCodeRunning, waitForZCodeExit };
