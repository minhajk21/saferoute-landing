// node --test tools/app-packs/test/*.test.mjs
// The same landing data gives byte-identical packs: two CLI runs; a run from
// git (--commit) against one from the working tree; and --commit HEAD (or
// any later commit that changed no input) against --commit <the data commit>.
// No time goes into the .bin, and `generated` is the landing commit's date.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { REPO, INPUT_PATHS, RULE_PATHS } from '../lib/landing.mjs';
import { packSchools } from '../lib/schools.mjs';
import { packPrices } from '../lib/prices.mjs';
import { sha256 } from '../lib/container.mjs';
import { realSchools, realPrices } from './helpers.mjs';

const CLI = join(REPO, 'tools', 'build-app-packs.mjs');
const run = (out, ...args) => {
  const r = spawnSync(process.execPath, [CLI, '--out', out, '--json', ...args], { encoding: 'utf8', maxBuffer: 1 << 26 });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
};
const hashes = dir => Object.fromEntries(readdirSync(dir).sort().map(f => [f, sha256(readFileSync(join(dir, f)))]));
const git = (...a) => execFileSync('git', ['-C', REPO, ...a], { encoding: 'utf8' }).trim();
const clean = () => git('status', '--porcelain', '--', ...INPUT_PATHS, ...RULE_PATHS) === '';
const tmp = p => mkdtempSync(join(tmpdir(), p));
const rm = (...d) => d.forEach(x => rmSync(x, { recursive: true, force: true }));

test('two builds of the same commit are byte-identical (sha256 of all four files)', { skip: !clean() && 'inputs differ from HEAD' }, () => {
  const a = tmp('packs-a-'), b = tmp('packs-b-');
  try {
    const ra = run(a), rb = run(b);
    const ha = hashes(a), hb = hashes(b);
    assert.deepEqual(Object.keys(ha), ['prices-pack.bin', 'prices-pack.json', 'schools-pack.bin', 'schools-pack.json']);
    assert.deepEqual(ha, hb);
    for (const p of ra.packs) {
      assert.equal(ha[`${p.layer}-pack.bin`], p.sha256, 'pack.sha256 is the .bin file\'s');
      const pack = JSON.parse(readFileSync(join(a, `${p.layer}-pack.json`), 'utf8')).pack;
      assert.equal(pack.sha256, p.sha256);
      assert.equal(pack.encoder.zlib, process.versions.zlib, 'the zlib that made the bytes is recorded');
      assert.equal(pack.rulesCommit, git('log', '-1', '--format=%H', 'HEAD', '--', ...RULE_PATHS));
    }
    assert.deepEqual(rb.packs.map(p => p.sha256), ra.packs.map(p => p.sha256));
    // `generated` is the landing commit's date in UTC, not the time of the run.
    const ct = Number(git('show', '-s', '--format=%ct', ra.landing.landingCommit));
    assert.equal(ra.landing.generated, new Date(ct * 1000).toISOString().replace('.000Z', 'Z'));
    assert.equal(ra.toolchain.zlib, process.versions.zlib);
  } finally { rm(a, b); }
});

test('--commit HEAD, --commit <last input change> and the working tree give the same four files', { skip: !clean() && 'inputs differ from HEAD' }, () => {
  const a = tmp('packs-wt-'), b = tmp('packs-head-'), c = tmp('packs-data-');
  try {
    const ra = run(a), rb = run(b, '--commit', 'HEAD');
    const data = git('log', '-1', '--format=%H', 'HEAD', '--', ...INPUT_PATHS);
    const rc = run(c, '--commit', data);
    for (const r of [ra, rb, rc]) assert.equal(r.landing.landingCommit, data, 'the commit recorded is the last one that changed an input');
    assert.deepEqual(hashes(b), hashes(a));
    assert.deepEqual(hashes(c), hashes(a));
  } finally { rm(a, b, c); }
});

test('no time in the .bin: a different date or commit changes only the JSON', async () => {
  const s = await realSchools(), p = await realPrices();
  const L1 = { landingCommit: 'a'.repeat(40), generated: '2026-10-05T12:42:20Z', rulesCommit: 'c'.repeat(40) };
  const L2 = { landingCommit: 'b'.repeat(40), generated: '2031-01-01T00:00:00Z', rulesCommit: 'c'.repeat(40) };
  for (const [pack, { input, rules }] of [[packSchools, s], [packPrices, p]]) {
    const x = pack(input, rules, L1), y = pack(input, rules, L2);
    assert.deepEqual(x.bin, y.bin);
    assert.notEqual(x.json, y.json);
    assert.equal(x.json.replace(L1.landingCommit, '').replace(L1.generated, ''), y.json.replace(L2.landingCommit, '').replace(L2.generated, ''));
  }
});
