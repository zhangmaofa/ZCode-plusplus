'use strict';
// Auto-repair watcher: two Windows scheduled tasks (hourly + at logon) that run
// `node <userRoot>/cli/bin/zcodepp.js repair --quiet`. Repair is idempotent and
// refuses to touch the asar while ZCode is running, so running it often is safe.
const { execSync } = require('child_process');
const path = require('path');

const TASK_HOURLY = 'ZCodePlusPlusRepair-Hourly';
const TASK_LOGON = 'ZCodePlusPlusRepair-OnLogon';

function taskCommand(nodeExe, cliEntry, taskName, schedule) {
  const tr = `"${nodeExe}" "${cliEntry}" repair --quiet`;
  return `schtasks /Create /F /TN "${taskName}" /TR "${tr}" /SC ${schedule}`;
}

function installWatcher(nodeExe, cliEntry) {
  const out = [];
  for (const [name, schedule] of [
    [TASK_HOURLY, 'HOURLY'],
    [TASK_LOGON, 'ONLOGON'],
  ]) {
    execSync(taskCommand(nodeExe, cliEntry, name, schedule), { stdio: 'pipe' });
    out.push(name);
  }
  return out;
}

function removeWatcher() {
  const removed = [];
  for (const name of [TASK_HOURLY, TASK_LOGON]) {
    try {
      execSync(`schtasks /Delete /F /TN "${name}"`, { stdio: 'pipe' });
      removed.push(name);
    } catch (e) {
      /* task may not exist */
    }
  }
  return removed;
}

function watcherStatus() {
  const status = {};
  for (const name of [TASK_HOURLY, TASK_LOGON]) {
    try {
      execSync(`schtasks /Query /TN "${name}"`, { stdio: 'pipe' });
      status[name] = true;
    } catch (e) {
      status[name] = false;
    }
  }
  return status;
}

function watcherEntryHint() {
  return {
    hourly: TASK_HOURLY,
    logon: TASK_LOGON,
    entry: 'node <userRoot>\\cli\\bin\\zcodepp.js repair --quiet',
  };
}

module.exports = { installWatcher, removeWatcher, watcherStatus, watcherEntryHint, TASK_HOURLY, TASK_LOGON };
