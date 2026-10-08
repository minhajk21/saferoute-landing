// node --test tools/app-packs/test/
// The same landing commit gives byte-identical packs: two CLI runs, and a run
// from the pinned commit (git archive) against one from the working tree. No
// time goes into the .bin, and `generated` is the landing commit's date.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { REPO, INPUT_PATHS } from '../lib/landing.mjs';
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
const clean = () => execFileSync('git', ['-C', REPO, 'status', '--porcelain', '--', ...INPUT_PATHS], { encoding: 'utf8' }).trim() === '';

test('two builds of the same commit are byte-identical (sha256 of all four files)', () => {
  const a = mkdtempSync(join(tmpdir(), 'packs-a-')), b = mkdtempSync(join(tmpdir(), 'packs-b-'));
  try {
    const ra = run(a, '--allow-dirty'), rb = run(b, '--allow-dirty');
    const ha = hashes(a), hb = hashes(b);
    assert.deepEqual(Object.keys(ha), ['prices-pack.bin', 'prices-pack.json', 'schools-pack.bin', 'schools-pack.json']);
    assert.deepEqual(ha, hb);
    for (const p of ra.packs) {
      assert.equal(ha[`${p.layer}-pack.bin`], p.sha256, 'pack.sha256 is the .bin file\'s');
      assert.equal(JSON.parse(readFileSync(join(a, `${p.layer}-pack.json`), 'utf8')).pack.sha256, p.sha256);
    }
    assert.deepEqual(rb.packs.map(p => p.sha256), ra.packs.map(p => p.sha256));
    // `generated` is the landing commit's date, not the time of the run.
    const sha = ra.landing.landingCommit.replace(/\+dirty$/, '');
    assert.equal(ra.landing.generated, execFileSync('git', ['-C', REPO, 'show', '-s', '--format=%cI', sha], { encoding: 'utf8' }).trim());
  } finally { rmSync(a, { recursive: true, force: true }); rmSync(b, { recursive: true, force: true }); }
});

test('a build from the pinned commit (--commit) equals the build from the working tree', { skip: !clean() && 'inputs differ from HEAD' }, () => {
  const a = mkdtempSync(join(tmpdir(), 'packs-wt-')), b = mkdtempSync(join(tmpdir(), 'packs-commit-'));
  try {
    const ra = run(a);
    const rb = run(b, '--commit', ra.landing.landingCommit);
    assert.equal(rb.landing.landingCommit, ra.landing.landingCommit);
    assert.deepEqual(hashes(a), hashes(b));
  } finally { rmSync(a, { recursive: true, force: true }); rmSync(b, { recursive: true, force: true }); }
});

test('no time in the .bin: a different date or commit changes only the JSON', async () => {
  const s = await realSchools(), p = await realPrices();
  const L1 = { landingCommit: 'a'.repeat(40), generated: '2026-10-05T12:42:20Z' };
  const L2 = { landingCommit: 'b'.repeat(40), generated: '2031-01-01T00:00:00Z' };
  for (const [pack, { input, rules }] of [[packSchools, s], [packPrices, p]]) {
    const x = pack(input, rules, L1), y = pack(input, rules, L2);
    assert.deepEqual(x.bin, y.bin);
    assert.notEqual(x.json, y.json);
    assert.equal(x.json.replace(L1.landingCommit, '').replace(L1.generated, ''), y.json.replace(L2.landingCommit, '').replace(L2.generated, ''));
  }
});
