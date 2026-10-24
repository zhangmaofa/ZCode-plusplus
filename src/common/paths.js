'use strict';
const os = require('os');
const path = require('path');
const fs = require('fs');

const PROJECT_ROOT = path.resolve(__dirname, '..', '..');

function defaultUserRoot() {
  return path.join(os.homedir(), '.zcode', 'zcode-plusplus');
}

function appCandidates() {
  const list = [];
  if (process.env.ZCODEPP_APP) list.push(process.env.ZCODEPP_APP);
  list.push(
    'D:\\ZCode\\ZCode.exe',
    path.join(process.env.LOCALAPPDATA || '', 'Programs', 'ZCode', 'ZCode.exe'),
    'C:\\Program Files\\ZCode\\ZCode.exe',
    'D:\\Program Files\\ZCode\\ZCode.exe',
    'C:\\Program Files (x86)\\ZCode\\ZCode.exe'
  );
  return list.filter(Boolean);
}

function findZCodeExe(explicit) {
  const candidates = explicit ? [explicit] : appCandidates();
  for (const c of candidates) {
    try {
      if (fs.existsSync(c)) return path.resolve(c);
    } catch (e) {
      /* ignore */
    }
  }
  return null;
}

function appDirFromExe(exePath) {
  return path.dirname(exePath);
}

function asarPathFromExe(exePath) {
  return path.join(appDirFromExe(exePath), 'resources', 'app.asar');
}

function userRootPaths(userRoot = defaultUserRoot()) {
  return {
    userRoot,
    runtimeDir: path.join(userRoot, 'runtime'),
    preloadPath: path.join(userRoot, 'runtime', 'preload.cjs'),
    tweaksDir: path.join(userRoot, 'tweaks'),
    tweakDataDir: path.join(userRoot, 'tweak-data'),
    backupDir: path.join(userRoot, 'backup'),
    logDir: path.join(userRoot, 'log'),
    cliDir: path.join(userRoot, 'cli'),
    configFile: path.join(userRoot, 'config.json'),
    stateFile: path.join(userRoot, 'state.json'),
  };
}

module.exports = {
  PROJECT_ROOT,
  defaultUserRoot,
  findZCodeExe,
  appDirFromExe,
  asarPathFromExe,
  userRootPaths,
};
