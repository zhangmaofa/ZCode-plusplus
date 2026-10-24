'use strict';
// Round-trip test of the asar patcher against the real ZCode app.asar.
// The original archive is only READ; output goes to a temp directory.

const fs = require('fs');
const path = require('path');
const os = require('os');
const asar = require('../src/installer/asar');

const SRC = process.env.ZCODEPP_TEST_ASAR || 'D:\\ZCode\\resources\\app.asar';

async function main() {
  if (!fs.existsSync(SRC)) {
    console.error(`source asar not found: ${SRC} (set ZCODEPP_TEST_ASAR)`);
    process.exit(2);
  }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'zcodepp-asar-test-'));
  const out = path.join(tmp, 'patched.asar');

  const pkgRaw = asar.extractFile(SRC, 'package.json').toString('utf8');
  const pkg = JSON.parse(pkgRaw);
  const origMain = pkg.main;
  if (!origMain) throw new Error('original package.json has no main');

  const loader = "// test loader\nconsole.log('zcodepp-test');\n";
  const newPkg = JSON.parse(pkgRaw);
  newPkg.main = 'zcodepp-loader.mjs';
  newPkg.__zcodepp = { originalMain: origMain, userRoot: tmp, version: 'test' };
  const newPkgRaw = JSON.stringify(newPkg, null, 2);

  console.log(`source: ${SRC} (${fs.statSync(SRC).size} bytes)`);
  let t = Date.now();
  asar.patchAsarArchive({
    asarPath: SRC,
    outPath: out,
    modify: { 'package.json': newPkgRaw },
    add: { 'zcodepp-loader.mjs': loader },
  });
  console.log(`patched in ${((Date.now() - t) / 1000).toFixed(1)}s -> ${out} (${fs.statSync(out).size} bytes)`);

  t = Date.now();
  const res = await asar.verifyAgainst(SRC, out, {
    'package.json': newPkgRaw,
    'zcodepp-loader.mjs': loader,
  });
  console.log(`verified in ${((Date.now() - t) / 1000).toFixed(1)}s: ok=${res.ok} samplesChecked=${res.samplesChecked}`);
  if (res.issues.length) {
    for (const i of res.issues) console.error('ISSUE:', i);
    process.exit(1);
  }

  // semantic checks
  const meta = asar.readMeta(out);
  const pkgOut = JSON.parse(asar.extractFile(out, 'package.json').toString('utf8'));
  if (pkgOut.main !== 'zcodepp-loader.mjs') throw new Error('main not rewritten');
  if (pkgOut.__zcodepp.originalMain !== origMain) throw new Error('originalMain not preserved');
  if (asar.extractFile(out, 'zcodepp-loader.mjs').toString('utf8') !== loader) throw new Error('loader content wrong');
  let packedCount = 0;
  for (const _ of asar.walkFiles(meta.header, '')) packedCount++;
  console.log(`patched header parses; packed entries: ${packedCount}`);

  console.log('PASS');
  fs.rmSync(tmp, { recursive: true, force: true });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
