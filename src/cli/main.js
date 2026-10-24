'use strict';
const commands = require('./commands');

const VERSION = require('../../package.json').version;

const HELP = `zcodepp ${VERSION} — tweak framework for the ZCode desktop app

Usage: node zcodepp.js <command> [options]

Commands:
  install [--app <ZCode.exe>] [--no-watcher] [--user-root <dir>]
          Patch app.asar (with backup) and deploy runtime + builtin tweaks.
  uninstall [--purge]
          Restore the original app.asar. --purge also deletes tweaks/config/logs.
  status  Show install state, watcher state and tweak list.
  repair  Re-patch after a ZCode update; refresh runtime/cli/builtin tweaks.
          Idempotent; skips while ZCode is running.
  doctor  Health checks (fuses, backup, runtime syntax, tweaks, watcher).
  safe-mode [on|off]
          Toggle loading of all tweaks (runtime keeps running).
  debug [--port 9223]
          Start ZCode with a CDP remote-debugging port for tweak development.
  new-tweak <name> [--scope renderer|main|both]
          Scaffold a new tweak in the current directory.
  validate-tweak <dir>
          Validate manifest + entry syntax.
  dev <dir>
          Deploy a tweak in dev mode: watch + redeploy + log tailing.
  tweaks [list|enable <id>|disable <id>]
          Manage tweak enable/disable state.

Environment:
  ZCODEPP_APP     default ZCode.exe path for install/detect
`;

function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-q' || a === '--quiet') flags.quiet = true;
    else if (a === '--no-watcher') flags.noWatcher = true;
    else if (a === '--purge') flags.purge = true;
    else if (a === '--app') flags.app = argv[++i];
    else if (a === '--user-root') flags.userRoot = argv[++i];
    else if (a === '--port') flags.port = parseInt(argv[++i], 10);
    else if (a === '--scope') flags.scope = argv[++i];
    else if (a === '--version' || a === '-v') flags.version = true;
    else if (a === 'help' || a === '--help' || a === '-h') flags.help = true;
    else positional.push(a);
  }
  return { positional, flags };
}

async function run(argv) {
  const args = parseArgs(argv.slice(2));
  const [cmd, sub] = args.positional;
  const f = args.flags;

  if (f.version || cmd === 'version') return console.log(VERSION);
  if (!cmd || f.help) return console.log(HELP);

  switch (cmd) {
    case 'install':
      return commands.cmdInstall(f);
    case 'uninstall':
      return commands.cmdUninstall(f);
    case 'repair':
      return commands.cmdRepair(f);
    case 'status':
      return commands.cmdStatus();
    case 'doctor':
      return commands.cmdDoctor();
    case 'safe-mode':
      return commands.cmdSafeMode(sub);
    case 'debug':
      return commands.cmdDebug(f);
    case 'new-tweak':
      return commands.cmdNewTweak(f, sub, f.scope);
    case 'validate-tweak':
      return commands.cmdValidateTweak(sub);
    case 'dev':
      return commands.cmdDev(sub);
    case 'tweaks':
      return commands.cmdTweaks(sub || 'list', args.positional[2]);
    default:
      console.error('unknown command: ' + cmd + '\n');
      console.log(HELP);
      process.exitCode = 1;
  }
}

module.exports = { run };
