'use strict';
// Tweak discovery + manifest validation.
// A tweak is a folder under <userRoot>/tweaks containing:
//   manifest.json { id, name, version, scope: renderer|main|both, main, description? }
//   <main> exporting { start(api) -> ctx?, stop(api, ctx)? }

const fs = require('fs');
const path = require('path');

const ID_RE = /^[a-z0-9][a-z0-9.-]{1,120}$/i;

function validateManifest(m, dir) {
  const problems = [];
  if (!m || typeof m !== 'object') problems.push('manifest is not an object');
  else {
    if (typeof m.id !== 'string' || !ID_RE.test(m.id)) problems.push(`bad id: ${JSON.stringify(m.id)}`);
    if (typeof m.name !== 'string' || !m.name.trim()) problems.push('missing name');
    if (typeof m.version !== 'string') problems.push('missing version');
    if (!['renderer', 'main', 'both'].includes(m.scope)) problems.push(`bad scope: ${JSON.stringify(m.scope)}`);
    if (typeof m.main !== 'string' || m.main.includes('..') || path.isAbsolute(m.main)) {
      problems.push(`bad main: ${JSON.stringify(m.main)}`);
    } else if (!fs.existsSync(path.join(dir, m.main))) {
      problems.push(`entry not found: ${m.main}`);
    }
  }
  return problems;
}

function discoverTweaks(tweaksDir) {
  const found = [];
  let entries = [];
  try {
    entries = fs.readdirSync(tweaksDir, { withFileTypes: true });
  } catch (e) {
    return found;
  }
  for (const ent of entries) {
    if (!ent.isDirectory()) continue;
    const dir = path.join(tweaksDir, ent.name);
    const mf = path.join(dir, 'manifest.json');
    let manifest = null;
    let error = null;
    try {
      manifest = JSON.parse(fs.readFileSync(mf, 'utf8'));
    } catch (e) {
      error = `manifest.json unreadable: ${e.message}`;
    }
    if (manifest) {
      const problems = validateManifest(manifest, dir);
      if (problems.length) error = problems.join('; ');
    }
    if (error) {
      found.push({ dir, manifest: { id: ent.name, name: ent.name, scope: 'renderer' }, invalid: true, error });
    } else {
      found.push({ dir, manifest });
    }
  }
  return found;
}

function isEnabled(config, id) {
  const entry = config.tweaks && config.tweaks[id];
  return entry ? entry.enabled !== false : true; // enabled by default
}

module.exports = { discoverTweaks, isEnabled, validateManifest };
