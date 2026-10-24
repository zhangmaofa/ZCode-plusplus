'use strict';
const fs = require('fs');
const path = require('path');
const asar = require('./asar');
const { ensureDir, hashFile, copyFileSyncSafe } = require('../common/util');

const LOADER_NAME = 'zcodepp-loader.mjs';
const RUNTIME_VERSION = require('../../package.json').version;

/** Loader source baked at patch time; must stay tiny and fail-open. */
function buildLoaderSource(userRoot, originalMain) {
  return `// ZCode++ loader — injected into app.asar by zcode-plusplus ${RUNTIME_VERSION}.
// Fail-open: if anything here throws, ZCode still boots its original entry.
const USER_ROOT = ${JSON.stringify(userRoot)};
const ORIGINAL_MAIN = ${JSON.stringify('./' + originalMain)};

async function boot() {
  try { process.env.ZCODEPP_USER_ROOT = USER_ROOT; } catch (e) { /* env is writable in main */ }
  try {
    const electron = await import('electron');
    globalThis.__zcodepp = {
      electron: electron && electron.default ? electron.default : electron,
      userRoot: USER_ROOT,
      runtimeVersion: ${JSON.stringify(RUNTIME_VERSION)},
    };
  } catch (e) {
    console.error('[zcodepp] electron import failed:', e);
  }
  try {
    const pathMod = await import('node:path');
    const urlMod = await import('node:url');
    await import(urlMod.pathToFileURL(pathMod.join(USER_ROOT, 'runtime', 'main.mjs')).href);
  } catch (e) {
    console.error('[zcodepp] runtime failed to load (app continues):', e);
  }
  await import(ORIGINAL_MAIN);
}
boot().catch((e) => {
  console.error('[zcodepp] loader boot failed:', e);
  import(ORIGINAL_MAIN).catch(() => {});
});
`;
}

/**
 * Patch the app so our loader runs first. Verifies the rebuilt archive before
 * swapping it in. Original is backed up first (only once per original bytes).
 */
async function patchZCodeApp({ exePath, userRoot, backupDir, quiet }) {
  const asarPath = path.join(path.dirname(exePath), 'resources', 'app.asar');
  const pkgRaw = asar.extractFile(asarPath, 'package.json').toString('utf8');
  const pkg = JSON.parse(pkgRaw);

  if (pkg.main === LOADER_NAME) {
    return { alreadyPatched: true, originalMain: pkg.__zcodepp && pkg.__zcodepp.originalMain };
  }

  const originalMain = pkg.main;
  if (!originalMain) throw new Error('package.json has no main entry');

  ensureDir(backupDir);
  const backupPath = path.join(backupDir, 'app.asar.orig');
  if (!fs.existsSync(backupPath)) {
    copyFileSyncSafe(asarPath, backupPath);
    if (!quiet) console.log(`backup written: ${backupPath}`);
  }
  const originalAsarHash = await hashFile(backupPath);

  const newPkgRaw = JSON.stringify(
    Object.assign({}, pkg, {
      main: LOADER_NAME,
      __zcodepp: { originalMain, userRoot, version: RUNTIME_VERSION },
    }),
    null,
    2
  );
  const loaderSource = buildLoaderSource(userRoot, originalMain);

  const staging = asarPath + '.zcodepp-new';
  asar.patchAsarArchive({
    asarPath,
    outPath: staging,
    modify: { 'package.json': newPkgRaw },
    add: { [LOADER_NAME]: loaderSource },
  });
  const verify = await asar.verifyAgainst(asarPath, staging, {
    'package.json': newPkgRaw,
    [LOADER_NAME]: loaderSource,
  });
  if (!verify.ok) throw new Error('patched archive failed verification: ' + verify.issues.join('; '));

  fs.unlinkSync(asarPath);
  fs.renameSync(staging, asarPath);
  const patchedAsarHash = await hashFile(asarPath);
  if (!quiet) console.log(`patched: ${asarPath}`);
  return { alreadyPatched: false, originalMain, patchedAsarHash, originalAsarHash, backupPath };
}

/** Restore the original asar from backup. */
async function restoreZCodeApp({ exePath, backupDir }) {
  const asarPath = path.join(path.dirname(exePath), 'resources', 'app.asar');
  const backupPath = path.join(backupDir, 'app.asar.orig');
  if (!fs.existsSync(backupPath)) throw new Error(`backup not found: ${backupPath}`);
  const backupHash = await hashFile(backupPath);
  copyFileSyncSafe(backupPath, asarPath);
  const restoredHash = await hashFile(asarPath);
  if (restoredHash !== backupHash) throw new Error('restore verification failed (hash mismatch)');
  return { ok: true, backupPath, hash: restoredHash };
}

/** Compare the live asar against state hashes. */
async function classifyCurrentAsar({ exePath, state }) {
  const asarPath = path.join(path.dirname(exePath), 'resources', 'app.asar');
  const current = await hashFile(asarPath);
  if (state.patchedAsarHash && current === state.patchedAsarHash) return 'patched';
  if (state.originalAsarHash && current === state.originalAsarHash) return 'original';
  const pkg = JSON.parse(asar.extractFile(asarPath, 'package.json').toString('utf8'));
  if (pkg.main === LOADER_NAME) return 'patched-unknown-hash';
  return 'unknown';
}

module.exports = {
  LOADER_NAME,
  RUNTIME_VERSION,
  buildLoaderSource,
  patchZCodeApp,
  restoreZCodeApp,
  classifyCurrentAsar,
};
