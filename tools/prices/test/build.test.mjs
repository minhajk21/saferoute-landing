// node --test tools/prices/test/
// The orchestrator end to end, with a FAKE source module in a temp dir and a
// local HTTP server standing in for the publisher, writing to a temp output
// (never prices/data). What it proves:
//   - a first build writes tiles + index.json that verify-prices passes;
//   - a source that throws re-emits its snapshot byte-identical, with the
//     meta it was published with (status snapshot-after-failure);
//   - an unchanged upstream (same ETag) is not even downloaded; a changed one
//     is refetched; a new ETag over identical bytes keeps the snapshot;
//   - a contract violation exits 1 and writes nothing;
//   - a fetch that empties a city, keeps nothing in scope (swapped lng/lat)
//     or quietly loses a tenth of the areas is refused like a failure, and
//     --refresh accepts the loss but never the emptied city;
//   - a changed module (its inputs) is rebuilt with upstream unchanged; a
//     static source is never asked; a speculative fetch that fails keeps
//     plain `snapshot`; a killed build's staging directory is cleaned up;
//   - verify-prices fails a lost source or colour scale even under --refresh.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { decisionProblems, PRICE_REGIONS, SCALE_NAMES, SEAM_NAME_MAX, scalesFor } from '../regions.mjs';
import { FIELDS } from '../lib/schema.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const BUILD = join(ROOT, 'tools', 'build-prices.mjs');
const VERIFY = join(ROOT, 'tools', 'verify-prices.mjs');
const COVERAGE = JSON.parse(readFileSync(join(ROOT, 'tools', 'data', 'coverage.json'), 'utf8'));

// The fake source: a grid of "tracts" over New York (with a dense block that
// forces tile splits, one area crossing many cells, one with a hole, and one
// of every flag), a few in Chicago, and two that R2 must drop.
const ACS_CITIES = Object.entries(PRICE_REGIONS).filter(([, d]) => (d.sources || []).includes('acs-tract')).map(([id]) => id);
const FAKE = String.raw`
const V = process.env.FAKE_VARIANT === 'b' ? 1.02 : 1;
const sq = (s, w, d) => [[w, s], [w + d, s], [w + d, s + d], [w, s + d], [w, s]];
export default {
  id: 'acs-tract',
  // Every city regions.mjs gives acs-tract (the build refuses a city a source
  // does not serve); this fake has areas for two of them.
  regions: __REGIONS__,
  cadence: process.env.FAKE_CADENCE || 'annual',
  meta: {
    name: 'Fake survey', publisher: 'Test Bureau', url: 'https://example.org/data',
    licence: 'Public domain', licenceUrl: 'https://example.org/licence',
    attribution: ['Source: Test Bureau, fake data.'], metric: 'Median home value (owners’ estimate)',
    unitNoun: 'owner-occupied homes', currency: 'USD', period: '2020–2024 (5-year survey)',
    notes: ['Fake.'], areaNoun: 'census tract', colourMinN: 10,
  },
  async fetch(ctx) {
    if (process.env.FAKE_FAIL) throw new Error('table is missing column "B25077_E001" — the schema changed');
    if (process.env.FAKE_URL) await ctx.download('fake-upstream.txt', process.env.FAKE_URL, { maxAgeH: 0 });
    const areas = [];
    let k = 0;
    const tract = (s, w, d, extra = {}) => {
      k++;
      const value = Math.round((300000 + 4000 * ((k * 37) % 97)) * V);
      areas.push({ id: '36' + String(k).padStart(9, '0'), name: 'Census Tract ' + k + ', Test County, NY', region: 'nyc', juris: 'US-NY',
        scale: 'nyc', value, moe: Math.round(value * 0.1), n: 100 + k, flags: [], context: null, polys: [[sq(s, w, d)]], extra: 'stripped', ...extra });
      return areas[areas.length - 1];
    };
    for (let i = 0; i < 20; i++) for (let j = 0; j < 25; j++) {
      const a = tract(40.50 + i * 0.02, -74.25 + j * 0.02, 0.02);
      if (k % 17 === 0) a.n = 5;                                          // under colourMinN: the build flags it few
      if (k % 23 === 0) { a.moe = Math.round(a.value * 0.8); a.flags = ['uncertain']; }
      if (k === 50) Object.assign(a, { value: null, moe: null, n: null, flags: ['suppressed'] });
      if (k === 60) Object.assign(a, { value: 2000001, moe: null, flags: ['topcoded'] });
      if (k === 70) a.context = { label: 'Wider area, 2025', value: 410000, n: 300 };
      if (k === 71) a.polys = [[sq(40.50 + i * 0.02, -74.25 + j * 0.02, 0.02), sq(40.505 + i * 0.02, -74.245 + j * 0.02, 0.01).reverse()]];
    }
    for (let i = 0; i < 20; i++) for (let j = 0; j < 20; j++) tract(40.751 + i * 0.002, -73.999 + j * 0.002, 0.0018);
    tract(40.52, -74.2, 0.4);                                              // crosses many cells
    tract(40.7, -74.2, 0.01, { juris: 'US-NJ' });                          // New Jersey: R2 drops it
    tract(41.5, -74.0, 0.01);                                              // outside the rectangle: R2 drops it
    for (let i = 0; i < 6; i++) for (let j = 0; j < 6; j++) {
      areas.push({ id: '17' + String(i * 6 + j).padStart(9, '0'), name: 'Census Tract ' + (i * 6 + j), region: 'chicago', juris: 'US-IL', scale: 'chicago',
        value: 200000 + 10000 * (i * 6 + j), moe: null, n: 50, flags: [], context: null, polys: [[sq(41.8 + i * 0.02, -87.7 + j * 0.02, 0.02)]] });
    }
    if (process.env.FAKE_BAD) areas[3].value = -5;
    let out = areas;
    if (process.env.FAKE_DROP) out = out.filter(a => a.region !== process.env.FAKE_DROP);
    if (process.env.FAKE_THIN) out = out.filter((a, i) => a.region !== 'nyc' || i % 5);
    if (process.env.FAKE_SWAP) for (const a of out) a.polys = a.polys.map(p => p.map(r => r.map(([x, y]) => [y, x])));
    return { vintage: '2020-2024', areas: out };
  },
};
`;

function run(script, args, env = {}) {
  return new Promise(res => {
    execFile(process.execPath, [script, ...args], { env: { ...process.env, ...env }, maxBuffer: 64e6 }, (err, stdout, stderr) =>
      res({ code: err ? err.code ?? 1 : 0, out: stdout, err: stderr }));
  });
}
const readTiles = dir => Object.fromEntries(readdirSync(join(dir, 'tiles')).sort().map(f => [f, readFileSync(join(dir, 'tiles', f), 'utf8')]));
const readIndex = dir => JSON.parse(readFileSync(join(dir, 'index.json'), 'utf8'));
const allRows = dir => {
  const seen = new Map();
  for (const text of Object.values(readTiles(dir))) { const t = JSON.parse(text); for (const r of t.a) seen.set(r[1], { r, c: r[9] == null ? null : t.c[r[9]] }); }
  return seen;
};

test('regions.mjs: every coverage region has a prices decision; a missing one is caught', () => {
  const cov = JSON.parse(readFileSync(join(ROOT, 'tools', 'data', 'coverage.json'), 'utf8')).regions.map(r => r.id);
  assert.deepEqual(decisionProblems(cov), []);
  assert.match(decisionProblems([...cov, 'atlantis']).join(), /atlantis: no prices decision/);
  assert.match(decisionProblems(['x'], { x: { sources: ['a'], none: 'why', currency: 'USD' } }).join(), /exactly one/);
  assert.match(decisionProblems(['x'], { x: { sources: ['a'] } }).join(), /currency/);
  assert.equal(PRICE_REGIONS.mexicocity.none, 'No open data gives home prices for areas smaller than the whole city.');
});

test('regions.mjs: every second scale key is named, short enough for the legend seam note', () => {
  for (const id of Object.keys(PRICE_REGIONS)) {
    const outer = scalesFor(id)[1];
    if (!outer || PRICE_REGIONS[id].sources?.[1] !== 'acs-tract') continue;
    assert.ok(SCALE_NAMES[outer], `${id}: ${outer} has no name in SCALE_NAMES`);
    assert.ok(SCALE_NAMES[outer].length <= SEAM_NAME_MAX, `${outer}: "${SCALE_NAMES[outer]}" is ${SCALE_NAMES[outer].length} characters (max ${SEAM_NAME_MAX})`);
  }
});

test('orchestrator end to end with a fake source: build, verify, snapshot on failure, cadence, violations', async t => {
  const tmp = mkdtempSync(join(tmpdir(), 'prices-build-test-'));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  const sources = join(tmp, 'sources'), out = join(tmp, 'out'), raw = join(tmp, 'raw');
  mkdirSync(sources);
  writeFileSync(join(sources, 'acs-tract.mjs'), FAKE.replace('__REGIONS__', JSON.stringify(ACS_CITIES)));
  writeFileSync(join(sources, '_helper.mjs'), 'throw new Error("files starting with _ must never be loaded");\n');

  // The "publisher": one file whose ETag we control, counting what is asked of it.
  // mode: '' answers as a good host does; 'noHead' refuses HEAD (403, as
  // OpenDataNI's signed storage does) but honours a ranged GET; 'bare' sends
  // no ETag or Last-Modified at all (as NISRA's PxStat metadata).
  const up = { etag: '"v1"', body: 'release one', gets: 0, heads: 0, ranged: 0, broken: false, mode: '' };
  const server = createServer((req, res) => {
    req.method === 'HEAD' ? up.heads++ : up.gets++;
    if (up.broken) { res.writeHead(500); return res.end(); }
    if (up.mode === 'noHead' && req.method === 'HEAD') { res.writeHead(403); return res.end(); }
    const validators = up.mode === 'bare' ? {} : { etag: up.etag, 'last-modified': 'Mon, 01 Sep 2026 00:00:00 GMT' };
    if (req.headers.range === 'bytes=0-0' && req.method === 'GET') {
      up.ranged++;
      res.writeHead(206, { ...validators, 'content-range': `bytes 0-0/${up.body.length}` });
      return res.end(up.body.slice(0, 1));
    }
    res.writeHead(200, { ...validators, 'content-type': 'text/plain' });
    res.end(req.method === 'HEAD' ? undefined : up.body);
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  const FAKE_URL = `http://127.0.0.1:${server.address().port}/fake-upstream.txt`;
  // --partial: this fake directory holds acs-tract only, and regions.mjs
  // names ons-msoa, ni-ward, statcan-ct and the sale sources too.
  const build = (args = [], env = {}) => run(BUILD, ['--sources', sources, '--out', out, '--raw-dir', raw, '--partial', ...args], { FAKE_URL, ...env });

  // ── 0: without --partial, a source regions.mjs names but has no module
  // fails the build, loudly, and writes nothing ─────────────────────────────
  const z = await run(BUILD, ['--sources', sources, '--out', out, '--raw-dir', raw], { FAKE_URL });
  assert.equal(z.code, 1, z.out);
  assert.match(z.err, /regions\.mjs gives uk the source "ons-msoa", but there is no ons-msoa\.mjs in .*: write the module, or take ons-msoa out of regions\.mjs/);
  assert.match(z.err, /gives nyc the source "nyc-dof-sales", but there is no nyc-dof-sales\.mjs/);
  assert.ok(!readdirSync(tmp).includes('out'), 'nothing written');

  // ── A: first build ────────────────────────────────────────────────────────
  const a = await build();
  assert.equal(a.code, 0, a.err + a.out);
  assert.match(a.out, /^    acs-tract +[\d,]+  fetched$/m, 'the per-source line the workflow greps');
  assert.match(a.out, /::warning::tools\/prices\/regions\.mjs gives nyc the source "nyc-dof-sales", but there is no nyc-dof-sales\.mjs .* \(--partial\)/);
  const ia = readIndex(out), ta = readTiles(out);
  const src = ia.sources['acs-tract'];
  assert.equal(src.status, 'fetched');
  assert.equal(src.vintage, '2020-2024');
  assert.equal(src.upstream.length, 1);
  assert.equal(src.upstream[0].etag, '"v1"');
  assert.equal(src.stats.dropped.outsideScope, 2, 'New Jersey and the out-of-rectangle area');
  assert.equal(src.stats.areas, 500 + 400 + 1 + 36);
  assert.equal(src.stats.coloured + src.stats.neutral, src.stats.areas);
  assert.ok(src.stats.unpublished >= 0 && src.stats.unpublished <= src.stats.neutral);
  assert.deepEqual(src.attribution, ['Source: Test Bureau, fake data.']);
  assert.deepEqual(ia.fields, FIELDS);
  assert.equal(ia.version, 1);
  assert.equal(ia.minZoom, 11);
  assert.deepEqual(ia.regions.map(r => [r.id, r.currency, r.sources, r.juris]), [['nyc', 'USD', ['acs-tract'], ['US-NY']], ['chicago', 'USD', ['acs-tract'], ['US-IL']]]);
  assert.deepEqual(ia.regions[0].outside, ['New Jersey'], 'the R2 note travels with the region');
  assert.deepEqual(ia.missing.map(({ tz, ...m }) => m), [{ region: 'mexicocity', name: 'Mexico City', reason: PRICE_REGIONS.mexicocity.none, bbox: COVERAGE.regions.find(r => r.id === 'mexicocity').bbox }], 'with its rectangle, so the page can name the city it is over');
  assert.ok(new RegExp(ia.missing[0].tz).test('America/Mexico_City'), 'and its time zones, so a visitor from there is told why the map starts elsewhere');
  assert.deepEqual(ia.regions.map(r => r.areas), [500 + 400 + 1, 36], 'area counts per city (verify-prices compares them build to build)');
  assert.deepEqual(ia.juris, { 'US-IL': { name: 'Illinois' }, 'US-NY': { name: 'New York', area: 'New York State' } });
  assert.match(src.inputs, /^[0-9a-f]{16}$/, 'the inputs fingerprint');
  assert.equal(ia.where, 'New York City and Chicago');
  // No sale source in this build: acs-tract keeps all of NYC on its first key.
  assert.deepEqual(ia.scales.map(s => [s.key, s.name, s.source, s.currency]), [['nyc', 'New York City', 'acs-tract', 'USD'], ['chicago', 'Chicago', 'acs-tract', 'USD']]);
  assert.equal(src.kind, 'areas');
  for (const s of ia.scales) assert.ok(s.breaks.length === 4 && s.breaks.every((b, i) => !i || b > s.breaks[i - 1]));
  assert.ok(ia.tiles.cells.some(k => k.startsWith('q')), 'the dense block split its cell');
  assert.deepEqual(Object.keys(ta).sort(), ia.tiles.cells.map(k => `${k}.json`).sort());

  const rows = allRows(out), F = Object.fromEntries(FIELDS.map((f, i) => [f, i]));
  const row = id => rows.get(id).r;
  assert.equal(row('36000000017')[F.flags], 8, 'n=5 under colourMinN=10: flagged few by the build');
  assert.equal(row('36000000023')[F.flags], 2, 'uncertain');
  assert.equal(row('36000000050')[F.flags], 1, 'suppressed');
  assert.equal(row('36000000050')[F.value], null);
  assert.equal(row('36000000060')[F.flags], 4, 'top-coded');
  assert.deepEqual(rows.get('36000000070').c, { label: 'Wider area, 2025', value: 410000, n: 300 });
  assert.equal(row('36000000071')[F.polys][0].length, 2, 'the hole survives');
  assert.equal(row('36000000001')[F.name], 'Census Tract 1, Test County, NY');
  assert.ok(!Object.values(ta).some(t => t.includes('stripped')), 'fields outside the contract never reach a tile');
  const big = row('36000000901');
  assert.ok(Object.values(ta).filter(t => t.includes('"36000000901"')).length >= 4, 'the big area is in every leaf it crosses');
  assert.equal(big[F.region], 0);

  const v = await run(VERIFY, ['--dir', out, '--no-spot']);
  assert.equal(v.code, 0, v.out + v.err);
  assert.match(v.out, /PASS — \d+ passed, 0 failed/);

  // ── B: the source throws -> snapshot, byte-identical, published meta kept ─
  const b = await build(['--refresh', 'acs-tract'], { FAKE_FAIL: '1' });
  assert.equal(b.code, 0, b.err + b.out);
  assert.match(b.out, /::warning::acs-tract: fetch failed \(table is missing column/);
  assert.match(b.out, /^    acs-tract +[\d,]+  snapshot-after-failure$/m);
  const ib = readIndex(out);
  assert.deepEqual(readTiles(out), ta, 'tiles byte-identical after a failed fetch');
  assert.equal(ib.sources['acs-tract'].status, 'snapshot-after-failure');
  assert.deepEqual({ ...ib.sources['acs-tract'], status: 'fetched' }, src, 'the published meta, provenance and stats are kept');
  assert.deepEqual(ib.scales, ia.scales);
  const vb = await run(VERIFY, ['--dir', out, '--no-spot']);
  assert.equal(vb.code, 0, vb.out);
  assert.match(vb.out, /WARN  stale acs-tract/);

  // ── C: upstream unchanged (same ETag) -> not downloaded, snapshot ─────────
  const gets = up.gets;
  const c = await build();
  assert.equal(c.code, 0, c.err + c.out);
  assert.match(c.out, /reusing its snapshot: all 1 upstream file\(s\) unchanged/);
  assert.equal(up.gets, gets, 'nothing downloaded');
  assert.ok(up.heads >= 1, 'one HEAD asked');
  assert.equal(readIndex(out).sources['acs-tract'].status, 'snapshot');
  assert.deepEqual(readTiles(out), ta, 'tiles byte-identical when upstream is unchanged');

  // ── C2: nothing changed again -> index.json byte-identical too (no churn:
  // the workflow must not commit a new `generated` date and nothing else) ───
  const stale = JSON.stringify({ ...readIndex(out), generated: '2000-01-01' });
  writeFileSync(join(out, 'index.json'), stale);
  const c2 = await build();
  assert.equal(c2.code, 0, c2.err + c2.out);
  assert.match(c2.out, /nothing changed: index\.json and all \d+ tiles are as published \(generated 2000-01-01\)/);
  assert.equal(readFileSync(join(out, 'index.json'), 'utf8'), stale, 'index.json byte-identical, generated date kept');
  assert.deepEqual(readTiles(out), ta);

  // ── C3: a host that refuses HEAD is asked by a one-byte ranged GET; one
  // with no validators at all, by the (small) file's own bytes ─────────────
  up.mode = 'noHead';
  const c3 = await build();
  assert.match(c3.out, /reusing its snapshot: all 1 upstream file\(s\) unchanged/);
  assert.equal(up.ranged, 1, 'one ranged GET');
  up.mode = 'bare';
  const g3 = up.gets;
  const c4 = await build();
  assert.match(c4.out, /reusing its snapshot: all 1 upstream file\(s\) unchanged/);
  assert.equal(up.gets - g3, 2, 'a ranged GET, then the small file itself, compared by sha256');
  up.body = 'release one, corrected';
  // Into a scratch output, reading this one as its snapshot: `out` stays as it was.
  const c5 = await run(BUILD, ['--sources', sources, '--out', join(tmp, 'scratch-out'), '--snapshot', out, '--raw-dir', raw, '--partial'], { FAKE_URL });
  assert.match(c5.out, /fetching: fake-upstream\.txt content changed/);
  Object.assign(up, { mode: '', body: 'release one' });
  rmSync(join(tmp, 'scratch-out'), { recursive: true, force: true });

  // ── D: upstream changed -> refetched, new values ──────────────────────────
  writeFileSync(join(tmp, 'prev-a.json'), JSON.stringify(ia));
  Object.assign(up, { etag: '"v2"', body: 'release two' });
  const d = await build([], { FAKE_VARIANT: 'b' });
  assert.equal(d.code, 0, d.err + d.out);
  assert.match(d.out, /fetching: fake-upstream\.txt ETag changed/);
  const id_ = readIndex(out), td = readTiles(out);
  assert.equal(id_.sources['acs-tract'].status, 'fetched');
  assert.equal(id_.sources['acs-tract'].upstream[0].etag, '"v2"');
  assert.notDeepEqual(td, ta, 'new values reached the tiles');
  const vd = await run(VERIFY, ['--dir', out, '--no-spot', '--prev', join(tmp, 'prev-a.json')]);
  assert.equal(vd.code, 0, vd.out + vd.err);
  assert.match(vd.out, /PASS  drift/);

  // ── E: a new ETag over identical bytes -> fetched, compared, snapshot kept ─
  up.etag = '"v3"';
  const e = await build([], { FAKE_VARIANT: 'a' });
  assert.equal(e.code, 0, e.err + e.out);
  assert.match(e.out, /byte-identical to the published build's — keeping the snapshot/);
  assert.equal(readIndex(out).sources['acs-tract'].status, 'snapshot');
  assert.deepEqual(readTiles(out), td, 'tiles byte-identical: identical upstream bytes');

  // ── F: a contract violation -> exit 1, nothing written ───────────────────
  const before = readFileSync(join(out, 'index.json'), 'utf8');
  const f = await build(['--refresh', 'acs-tract'], { FAKE_BAD: '1', FAKE_VARIANT: 'b' });
  assert.equal(f.code, 1, f.out);
  assert.match(f.err, /contract violation\(s\); nothing written[\s\S]*36000000004: value -5 <= 0/);
  assert.equal(readFileSync(join(out, 'index.json'), 'utf8'), before);
  assert.deepEqual(readTiles(out), td);
  assert.ok(!readdirSync(tmp).some(n => /staging|\.old-/.test(n)), 'no staging directory left behind');

  // ── H: upstream changed, but the fetch empties Chicago -> refused ────────
  Object.assign(up, { etag: '"v4"', body: 'release four' });
  const h = await build([], { FAKE_DROP: 'chicago' });
  assert.equal(h.code, 0, h.err + h.out);
  assert.match(h.out, /::warning::acs-tract: the fetch looks wrong: it has no areas for chicago, which had 36 published/);
  assert.equal(readIndex(out).sources['acs-tract'].status, 'snapshot-after-failure', 'something newer was out and could not be used');
  assert.deepEqual(readTiles(out), td, 'the snapshot, byte-identical');
  const h2 = await build(['--refresh', 'acs-tract'], { FAKE_DROP: 'chicago' });
  assert.match(h2.out, /it has no areas for chicago/, '--refresh never accepts an emptied city');
  assert.deepEqual(readTiles(out), td);

  // ── I: lng/lat swapped -> nothing in scope -> refused, even with --refresh ─
  const i = await build(['--refresh', 'acs-tract'], { FAKE_SWAP: '1' });
  assert.equal(i.code, 0, i.err + i.out);
  assert.match(i.out, /the fetch looks wrong: none of its areas is in scope/);
  assert.deepEqual(readTiles(out), td);

  // ── J: a fifth of NYC gone -> refused unasked; --refresh accepts it ───────
  const j = await build([], { FAKE_THIN: '1', FAKE_VARIANT: 'b' });
  assert.match(j.out, /the fetch looks wrong: [\d,]+ areas, 1\d\.\d% fewer than the 937 published \(--refresh acs-tract accepts that\)/);
  assert.deepEqual(readTiles(out), td);
  const j2 = await build(['--refresh', 'acs-tract'], { FAKE_THIN: '1', FAKE_VARIANT: 'b' });
  assert.equal(j2.code, 0, j2.err + j2.out);
  assert.equal(readIndex(out).sources['acs-tract'].status, 'fetched');
  assert.ok(readIndex(out).sources['acs-tract'].stats.areas < 900);

  // ── K: the module changed, upstream did not -> rebuilt from its inputs ────
  const inputsBefore = readIndex(out).sources['acs-tract'].inputs;
  writeFileSync(join(sources, 'acs-tract.mjs'), FAKE.replace('__REGIONS__', JSON.stringify(ACS_CITIES)) + '\n// a flag rule changed\n');
  const k = await build([], { FAKE_VARIANT: 'b' });
  assert.equal(k.code, 0, k.err + k.out);
  assert.match(k.out, /fetching: its inputs changed/);
  const ik = readIndex(out).sources['acs-tract'];
  assert.equal(ik.status, 'fetched');
  assert.notEqual(ik.inputs, inputsBefore);
  const k2 = await build([], { FAKE_VARIANT: 'b' });
  assert.match(k2.out, /reusing its snapshot: all 1 upstream file\(s\) unchanged/, 'and not again next month');

  // ── L: a static source is never asked ─────────────────────────────────────
  up.etag = '"v5"';
  const heads = up.heads;
  const l = await build([], { FAKE_CADENCE: 'static', FAKE_VARIANT: 'b' });
  assert.match(l.out, /reusing its snapshot: static data: upstream not checked/);
  assert.equal(up.heads, heads, 'no HEAD for a static source');

  // ── M: upstream cannot say (HTTP 500) and the fetch fails -> plain snapshot ─
  up.broken = true;
  const tm = readTiles(out);
  const m = await build([], { FAKE_VARIANT: 'b' });
  assert.equal(m.code, 0, m.err + m.out);
  assert.match(m.out, /fetching: 1 of 1 upstream file\(s\) could not say whether they changed/);
  assert.match(m.out, /::warning::acs-tract: fetch failed .*\(nothing newer was known to be out\)/);
  assert.equal(readIndex(out).sources['acs-tract'].status, 'snapshot', 'no "could not be fetched" note on the page for a speculative fetch');
  assert.deepEqual(readTiles(out), tm);
  up.broken = false;

  // ── N: a killed build's staging directory is removed by the next build ────
  mkdirSync(`${out}.staging-2147483646`);
  writeFileSync(join(`${out}.staging-2147483646`, 'junk.json'), '{}');
  const n = await build(['--frozen'], { FAKE_VARIANT: 'b' });
  assert.equal(n.code, 0, n.err + n.out);
  assert.match(n.out, /removed out\.staging-2147483646/);
  assert.ok(!readdirSync(tmp).some(x => /staging|\.old-/.test(x)));

  // ── O: verify fails a source and a colour scale the last build had, even
  // under --refresh all (regions.mjs still gives ons-msoa to the UK) ─────────
  const cur = readIndex(out);
  writeFileSync(join(tmp, 'prev-o.json'), JSON.stringify({ ...cur, sources: { ...cur.sources, 'ons-msoa': { stats: { areas: 7264 } } },
    scales: [...cur.scales, { key: 'TLI', name: 'London', source: 'ons-msoa', median: 520000 }] }));
  const vo = await run(VERIFY, ['--dir', out, '--no-spot', '--prev', join(tmp, 'prev-o.json'), '--refresh', 'all']);
  assert.equal(vo.code, 1, vo.out);
  assert.match(vo.out, /FAIL  nothing lost .*ons-msoa: 7,264 areas last build, absent now.*colour scale TLI \(London\) existed last build, is gone now/);

  // An unknown source id is refused before anything runs.
  const g = await build(['--refresh', 'no-such-source']);
  assert.equal(g.code, 1);
  assert.match(g.err, /no source "no-such-source"/);

  // A city regions.mjs gives the source, but the module does not serve: the
  // build refuses (that city would otherwise silently get nothing).
  const narrow = join(tmp, 'sources-narrow');
  mkdirSync(narrow);
  writeFileSync(join(narrow, 'acs-tract.mjs'), FAKE.replace('__REGIONS__', JSON.stringify(['nyc', 'chicago'])));
  const q = await run(BUILD, ['--sources', narrow, '--out', join(tmp, 'narrow-out'), '--raw-dir', raw, '--partial'], { FAKE_URL });
  assert.equal(q.code, 1, q.out);
  assert.match(q.err, /regions\.mjs gives "sf" the source acs-tract, but sources\/acs-tract\.mjs does not serve it/);
});
