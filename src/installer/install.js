'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const { ensureDir, readJsonFile, writeJsonFile, copyFileSyncSafe } = require('../common/util');
const { userRootPaths, PROJECT_ROOT } = require('../common/paths');
const detect = require('./detect');
const patcher = require('./patch');
const fuses = require('./fuses');
const watcher = require('./watcher');

const VERSION = require('../../package.json').version;

/** Recursive copy; symlinks not expected. overwriteBuiltin: only replace when target missing or builtin. */
function deployTree(srcDir, dstDir, { force } = {}) {
  ensureDir(dstDir);
  for (const ent of fs.readdirSync(srcDir, { withFileTypes: true })) {
    const s = path.join(srcDir, ent.name);
    const d = path.join(dstDir, ent.name);
    if (ent.isDirectory()) {
      deployTree(s, d, { force });
    } else if (ent.isFile()) {
      if (!force && fs.existsSync(d)) continue;
      copyFileSyncSafe(s, d);
    }
  }
}

function deployRuntime(userRoot, { force } = {}) {
  const P = userRootPaths(userRoot);
  ensureDir(P.userRoot);
  // runtime always refreshed wholesale (it is ours)
  fs.rmSync(P.runtimeDir, { recursive: true, force: true });
  deployTree(path.join(PROJECT_ROOT, 'runtime-src'), P.runtimeDir, { force: true });
  // builtin tweaks only (ids under zcodepp.*); user tweaks never touched
  const builtinSrc = path.join(PROJECT_ROOT, 'tweaks');
  if (fs.existsSync(builtinSrc)) {
    for (const ent of fs.readdirSync(builtinSrc, { withFileTypes: true })) {
      if (!ent.isDirectory()) continue;
      const src = path.join(builtinSrc, ent.name);
      let id = ent.name;
      try {
        id = JSON.parse(fs.readFileSync(path.join(src, 'manifest.json'), 'utf8')).id || id;
      } catch (e) {
        /* keep dirname */
      }
      fs.rmSync(path.join(P.tweaksDir, id), { recursive: true, force: true });
      deployTree(src, path.join(P.tweaksDir, id), { force: true });
    }
  }
}

function deployCli(userRoot) {
  const P = userRootPaths(userRoot);
  fs.rmSync(P.cliDir, { recursive: true, force: true });
  for (const name of ['bin', 'src', 'runtime-src', 'tweaks']) {
    deployTree(path.join(PROJECT_ROOT, name), path.join(P.cliDir, name), { force: true });
  }
  copyFileSyncSafe(path.join(PROJECT_ROOT, 'package.json'), path.join(P.cliDir, 'package.json'));
  return path.join(P.cliDir, 'bin', 'zcodepp.js');
}

function guardNotRunning(quiet) {
  if (!detect.isZCodeRunning()) return;
  throw new Error('ZCode is currently running. Close it first (this includes the window hosting agent sessions), then retry.');
}

function guardFuses(exePath) {
  const r = fuses.asarIntegrityBlocksPatching(exePath);
  if (r.known && r.blocks) {
    throw new Error(
      'This ZCode build has the embedded asar-integrity fuse ENABLED; patching app.asar would break startup. Aborting.'
    );
  }
  return r;
}

async function install(opts = {}) {
  const userRoot = opts.userRoot || userRootPaths().userRoot;
  const P = userRootPaths(userRoot);
  const installInfo = detect.detectInstall(opts.app);
  if (!installInfo) {
    throw new Error('ZCode install not found. Pass --app <path-to-ZCode.exe> or set ZCODEPP_APP.');
  }
  if (opts.wait && detect.isZCodeRunning()) {
    if (!opts.quiet) console.log('ZCode is running — waiting for it to exit (close all ZCode windows)...');
    const exited = detect.waitForZCodeExit(opts.waitTimeoutMs);
    if (!exited) throw new Error('timed out waiting for ZCode to exit; close it and run install again');
    if (!opts.quiet) console.log('ZCode exited, continuing.');
  }
  guardNotRunning(opts.quiet);
  const fuseInfo = guardFuses(installInfo.exePath);

  deployRuntime(userRoot, { force: true });
  const cliEntry = deployCli(userRoot);

  const result = await patcher.patchZCodeApp({
    exePath: installInfo.exePath,
    userRoot,
    backupDir: P.backupDir,
    quiet: opts.quiet,
  });

  const state = readJsonFile(P.stateFile, {});
  const newState = {
    version: 1,
    installed: true,
    exePath: installInfo.exePath,
    zcodeVersion: installInfo.version,
    runtimeVersion: VERSION,
    originalMain: result.originalMain || state.originalMain,
    patchedAsarHash: result.patchedAsarHash || state.patchedAsarHash,
    originalAsarHash: result.originalAsarHash || state.originalAsarHash,
    backupPath: result.backupPath || state.backupPath || path.join(P.backupDir, 'app.asar.orig'),
    installedAt: new Date().toISOString(),
    cliEntry,
  };
  writeJsonFile(P.stateFile, newState);
  if (!fs.existsSync(P.configFile)) {
    writeJsonFile(P.configFile, { version: 1, safeMode: false, tweaks: {}, dev: {} });
  }

  let watcherInstalled = [];
  if (!opts.noWatcher) {
    watcherInstalled = watcher.installWatcher(process.execPath, cliEntry);
  }

  return {
    installInfo,
    alreadyPatched: result.alreadyPatched,
    fuseInfo,
    watcherInstalled,
    userRoot,
  };
}

async function uninstall(opts = {}) {
  const userRoot = opts.userRoot || userRootPaths().userRoot;
  const P = userRootPaths(userRoot);
  const state = readJsonFile(P.stateFile, null);
  if (!state || !state.exePath) throw new Error('No ZCode++ installation found (state.json missing).');
  if (!fs.existsSync(state.exePath)) throw new Error('Saved ZCode.exe path no longer exists: ' + state.exePath);
  guardNotRunning(opts.quiet);

  const res = await patcher.restoreZCodeApp({ exePath: state.exePath, backupDir: path.dirname(state.backupPath || P.backupDir) });
  watcher.removeWatcher();

  if (opts.purge) {
    fs.rmSync(userRoot, { recursive: true, force: true });
  } else {
    writeJsonFile(P.stateFile, { ...state, installed: false, uninstalledAt: new Date().toISOString() });
  }
  return { restored: res, purged: !!opts.purge };
}

async function repair(opts = {}) {
  const userRoot = opts.userRoot || userRootPaths().userRoot;
  const P = userRootPaths(userRoot);
  const state = readJsonFile(P.stateFile, null);
  if (!state || !state.exePath) throw new Error('No ZCode++ installation found. Run install first.');

  if (detect.isZCodeRunning()) {
    if (!opts.quiet) console.log('ZCode is running — skipping repair this round (safe).');
    return { skipped: 'running' };
  }

  const info = detect.inspectInstall(state.exePath);
  if (!info) throw new Error('ZCode install no longer valid at ' + state.exePath);
  guardFuses(info.exePath);

  const cls = await patcher.classifyCurrentAsar({ exePath: info.exePath, state });
  let patchResult = { alreadyPatched: true };

  if (cls === 'original' || cls === 'unknown') {
    // ZCode updated (fresh unpatched asar) or patch lost — re-patch against
    // what's on disk, refreshing the backup when the original changed.
    const backupPath = state.backupPath || path.join(P.backupDir, 'app.asar.orig');
    const { hashFile } = require('../common/util');
    const onDiskOriginal = cls === 'original';
    if (!onDiskOriginal) {
      // current asar is an unknown-but-unpatched build: adopt it as the new backup
      copyFileSyncSafe(info.asarPath, backupPath);
    }
    patchResult = await patcher.patchZCodeApp({
      exePath: info.exePath,
      userRoot,
      backupDir: path.dirname(backupPath),
      quiet: opts.quiet,
    });
  } else if (cls === 'patched-unknown-hash') {
    // already loader-patched (probably by this tool); just record the hash
  }

  // refresh runtime + cli + builtin tweaks (cheap, keeps everything current)
  deployRuntime(userRoot, { force: true });
  const cliEntry = deployCli(userRoot);
  writeJsonFile(P.stateFile, {
    ...state,
    installed: true,
    zcodeVersion: info.version,
    runtimeVersion: VERSION,
    patchedAsarHash: patchResult.patchedAsarHash || (await require('../common/util').hashFile(info.asarPath)),
    originalAsarHash: state.originalAsarHash,
    backupPath: state.backupPath || path.join(P.backupDir, 'app.asar.orig'),
    repairedAt: new Date().toISOString(),
    cliEntry,
  });
  return { classification: cls, alreadyPatched: patchResult.alreadyPatched };
}

module.exports = { install, uninstall, repair, deployRuntime, deployCli };
