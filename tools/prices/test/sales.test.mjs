// node --test tools/prices/test/*.test.mjs
// Kind 'point-sales' (tools/prices/lib/sales.mjs and the orchestrator's
// PRECEDENCE), with a FAKE geometry source (acs-tract) and a FAKE sale source
// (nyc-dof-sales) in a temp dir, writing to a temp output (never prices/data).
// What it proves:
//   - the window: the latest complete month, `through`, the recording lag;
//   - figures: n, the median and the middle half, rounded to the 1,000; no
//     figure under 3 sales; no middle half under colourMinN; few under it;
//   - placing: point-in-polygon with holes; every sale dropped is counted
//     (future-dated, out of the window, in no tract, outside covers);
//   - precedence: inside covers the sale tracts replace the geometry
//     source's, the rest move to the region's second scale key, and a region
//     with leftovers but no second key stops the build;
//   - the context line is the geometry source's own figure, with its margin
//     of error and its top code; a tract with no sales and no context line is
//     not drawn;
//   - nothing of a single sale reaches a tile (no location, date or price);
//   - a monthly refetch over a snapshot geometry source gives byte-identical
//     tiles; a failed or swapped fetch keeps the snapshot; a new geometry
//     vintage re-aggregates; verify passes, and catches tampering.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, cpSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { PRICE_REGIONS } from '../regions.mjs';
import { FIELDS, entryProblems } from '../lib/schema.mjs';
import { processPolys } from '../lib/geo.mjs';
import { percentile } from '../lib/scale.mjs';
import { saleWindow, figuresOf, tractLocator, isCovered, saleProblem, isIsoDate, buildSaleAreas, contextOf, privacyNote, ORCH_DROPS } from '../lib/sales.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const BUILD = join(ROOT, 'tools', 'build-prices.mjs');
const VERIFY = join(ROOT, 'tools', 'verify-prices.mjs');
const run = (script, args, env = {}) => new Promise(res => {
  execFile(process.execPath, [script, ...args], { env: { ...process.env, ...env }, maxBuffer: 64e6 }, (err, stdout, stderr) => res({ code: err ? err.code ?? 1 : 0, out: stdout, err: stderr }));
});
const sq = (s, w, d) => [[w, s], [w + d, s], [w + d, s + d], [w, s + d], [w, s]];
const r1000 = v => Math.round(v / 1000) * 1000;

// ── the pure parts ──────────────────────────────────────────────────────────
test('the window: latest complete month, the publisher\'s `through`, the recording lag', () => {
  // The newest sale mid-September: September is still filling.
  assert.deepEqual(saleWindow({ latest: '2026-09-12', months: 12 }), { from: '2025-09', to: '2026-08', span: 'Sep 2025 – Aug 2026' });
  // A sale on the month's last day: that month is complete.
  assert.deepEqual(saleWindow({ latest: '2026-08-31', months: 12 }).to, '2026-08');
  assert.deepEqual(saleWindow({ latest: '2026-08-30', months: 12 }).to, '2026-07');
  assert.equal(saleWindow({ latest: '2024-02-29', months: 12 }).to, '2024-02', 'a leap day ends February');
  // The publisher says August is complete though its last sale was the 29th.
  assert.equal(saleWindow({ latest: '2026-08-29', months: 12, through: '2026-08' }).to, '2026-08');
  // A `through` past the newest sale's month says nothing about that month
  // (the data stops short of the claim): the data decides, and mid-June is
  // not a complete June.
  assert.equal(saleWindow({ latest: '2026-06-15', months: 12, through: '2026-08' }).to, '2026-05');
  assert.equal(saleWindow({ latest: '2026-08-20', months: 12, through: '2026-09' }).to, '2026-07');
  assert.equal(saleWindow({ latest: '2026-06-30', months: 12, through: '2026-08' }).to, '2026-06', 'unless the data itself shows the month complete');
  // An earlier `through` ends the window there, whatever the data holds.
  assert.equal(saleWindow({ latest: '2026-09-12', months: 12, through: '2026-07' }).to, '2026-07');
  // The recording lag pushes it back; 24 months span two years.
  assert.deepEqual(saleWindow({ latest: '2026-09-12', months: 24, lagMonths: 1 }), { from: '2024-08', to: '2026-07', span: 'Aug 2024 – Jul 2026' });
  assert.equal(saleWindow({ latest: '2026-01-05', months: 12 }).span, 'Jan 2025 – Dec 2025', 'across a year end');
});

test('figures: no figure under 3 sales, no middle half under colourMinN, rounded to the 1,000', () => {
  assert.deepEqual(figuresOf([], 10), { n: 0, value: null, iqr: null });
  assert.deepEqual(figuresOf([512345, 498765], 10), { n: 2, value: null, iqr: null }, 'two sales: a "median" would be their average, near enough each');
  assert.deepEqual(figuresOf([300400, 512345, 498765], 10), { n: 3, value: 499000, iqr: null });
  const ten = [100, 200, 300, 400, 500, 600, 700, 800, 900, 1000].map(v => v * 1000 + 123);
  const f = figuresOf([...ten].reverse(), 10);
  assert.equal(f.n, 10);
  assert.equal(f.value, r1000(percentile(ten, 0.5)));
  assert.deepEqual(f.iqr, [r1000(percentile(ten, 0.25)), r1000(percentile(ten, 0.75))]);
  assert.ok(f.iqr[0] <= f.value && f.value <= f.iqr[1]);
  assert.equal(figuresOf(ten.slice(0, 9), 10).iqr, null, 'nine sales: the middle half would be single sales');
});

test('placing: in the tract whose rings hold the point (holes respected); covers by jurisdiction and county', () => {
  const mk = (id, polys, juris = 'US-NY') => { const g = processPolys(polys); return { id, juris, enc: g.enc, bbox: g.bbox }; };
  const doughnut = mk('36061000100', [[sq(40.70, -74.00, 0.02), sq(40.705, -73.995, 0.01).reverse()]]);
  const hole = mk('36061000200', [[sq(40.705, -73.995, 0.01)]]);
  const far = mk('36059000300', [[sq(40.80, -73.70, 0.02)]]);
  const at = tractLocator([far, hole, doughnut]);
  assert.equal(at(40.701, -73.999)?.id, '36061000100');
  assert.equal(at(40.71, -73.99)?.id, '36061000200', 'the hole is the other tract, not the doughnut');
  assert.equal(at(40.81, -73.69)?.id, '36059000300');
  assert.equal(at(40.5, -74.5), null);
  const covers = { juris: ['US-NY'], counties: ['36061'] };
  assert.ok(isCovered(covers, doughnut) && !isCovered(covers, far));
  assert.ok(isCovered({ juris: ['US-NY'] }, far) && !isCovered({ juris: ['US-NJ'] }, far));
});

test('a malformed sale is named; only real YYYY-MM-DD dates', () => {
  const ok = { lat: 40.7, lng: -74, price: 500000, date: '2026-03-01', type: 'condo' };
  assert.equal(saleProblem(ok), '');
  assert.match(saleProblem({ ...ok, lat: NaN }), /lat\/lng/);
  assert.match(saleProblem({ ...ok, lng: 200 }), /lat\/lng/);
  assert.match(saleProblem({ ...ok, price: 0 }), /price/);
  assert.match(saleProblem({ ...ok, date: '2026-02-30' }), /date/);
  assert.match(saleProblem({ ...ok, date: '03/01/2026' }), /date/);
  assert.ok(isIsoDate('2024-02-29') && !isIsoDate('2025-02-29'));
});

test('buildSaleAreas: every sale placed or counted; suppression, context, privacy note', () => {
  const g = (id, s, extra = {}) => { const p = processPolys([[sq(s, -74, 0.01)]]); return { id, name: `Census Tract ${id.slice(-3)}, Fake County, NY`, region: 'nyc', juris: 'US-NY', value: 640000, moe: 52300, flags: [], enc: p.enc, bbox: p.bbox, ...extra }; };
  const tracts = [g('36061000001', 40.70), g('36061000002', 40.71, { value: 2000001, moe: null, flags: ['topcoded'] }), g('36061000003', 40.72, { value: null, moe: null }),
    g('36059000004', 40.73), { ...g('36061000005', 40.74), fromSale: true, context: { label: 'Old label', value: 1, moe: null, n: null, flags: [] } }];
  const geoMeta = { metric: 'Median home value (owners’ estimate)', period: '2020–2024 (5-year survey)', contextLabel: 'Owners’ estimate, 2020–24 survey', areaNoun: 'census tract' };
  const src = { id: 'nyc-dof-sales', meta: { metric: 'Median sale price', unitNoun: 'sales', currency: 'USD', window: { months: 12, by: 'sale' }, colourMinN: 10, notes: ['Fake.'] } };
  const sale = (lat, price, date = '2026-05-10') => ({ lat, lng: -73.995, price, date });
  const sales = [
    ...Array.from({ length: 12 }, (_, i) => sale(40.705, 500000 + i * 10000)),   // tract 1: 12 sales
    sale(40.715, 900000), sale(40.715, 950000),                                    // tract 2: 2 sales
    sale(40.735, 700000),                                                          // tract 4: outside covers
    sale(40.5, 700000),                                                            // in no tract
    sale(40.705, 1, '2024-01-01'),                                                 // before the window
    sale(40.705, 1, '2099-01-01'),                                                 // after the data day
    sale(40.705, 500000, '2026-09-03'),                                            // the partial month
  ];
  const b = buildSaleAreas({ src, out: { covers: { juris: ['US-NY'], counties: ['36061'] }, sales, dropped: { nonArmsLength: 4 } },
    tracts, geoMeta, now: '2026-09-28', scaleOf: () => 'nyc' });
  assert.deepEqual(b.violations, []);
  assert.deepEqual(b.window, { from: '2025-09', to: '2026-08', span: 'Sep 2025 – Aug 2026' });
  assert.equal(b.meta.period, 'Sales dated Sep 2025 – Aug 2026', "window.by 'sale'");
  assert.equal(b.meta.areaNoun, 'census tract', 'the geometry source\'s area noun');
  assert.equal(b.vintage, '2025-09..2026-08');
  assert.ok(b.meta.notes.includes(privacyNote(b.meta)) && /always rests on at least 3 sales/.test(privacyNote(b.meta)));
  assert.deepEqual(b.stats, { dropped: { nonArmsLength: 4, futureDate: 1, outOfWindow: 2, outsideTracts: 1, outsideCovers: 1 }, sales: { received: 19, used: 14 } });
  assert.equal(b.stats.sales.received, b.stats.sales.used + ORCH_DROPS.reduce((t, k) => t + b.stats.dropped[k], 0));
  const by = Object.fromEntries(b.areas.map(a => [a.id, a]));
  assert.deepEqual(Object.keys(by).sort(), ['36061000001', '36061000002', '36061000003', '36061000005'], 'every covered tract, and only those');
  assert.deepEqual([by['36061000001'].value, by['36061000001'].n, by['36061000001'].iqr, by['36061000001'].flags], [555000, 12, [528000, 583000], []]);
  assert.deepEqual(by['36061000001'].context, { label: 'Owners’ estimate, 2020–24 survey', value: 640000, moe: 52300, n: null, flags: [] });
  assert.deepEqual([by['36061000002'].value, by['36061000002'].n, by['36061000002'].iqr, by['36061000002'].flags], [null, 2, null, ['suppressed']], 'two sales: withheld entirely');
  assert.deepEqual(by['36061000002'].context.flags, ['topcoded']);
  assert.deepEqual([by['36061000003'].value, by['36061000003'].n, by['36061000003'].flags, by['36061000003'].context], [null, 0, [], null], 'no sales, no ACS figure: nothing published');
  assert.equal(by['36061000005'].context.label, 'Old label', 'a tract read back from the sale source\'s own rows keeps its published context');
  assert.equal(contextOf({ value: null }, geoMeta), null);
  // A source may not count the build's drops, and must return well-formed sales.
  const v1 = buildSaleAreas({ src, out: { covers: { juris: ['US-NY'] }, sales, dropped: { outOfWindow: 3 } }, tracts, geoMeta, now: '2026-09-28', scaleOf: () => 'nyc' });
  assert.match(v1.violations.join(), /dropped\.outOfWindow is counted by the build/);
  const v2 = buildSaleAreas({ src, out: { covers: { juris: ['New York'] }, sales: [{ lat: 1, lng: 2, price: -5, date: 'x' }] }, tracts, geoMeta, now: '2026-09-28', scaleOf: () => 'nyc' });
  assert.match(v2.violations.join(), /covers\.juris must list ISO 3166-2 codes/);
});

// ── end to end ──────────────────────────────────────────────────────────────
const ACS_CITIES = Object.entries(PRICE_REGIONS).filter(([, d]) => (d.sources || []).includes('acs-tract')).map(([id]) => id);
// A 10x10 grid of NYC "tracts": columns 0-4 Manhattan (36061), 5-7 Brooklyn
// (36047), both covered by the sale source; 8-9 Nassau (36059), left to
// acs-tract on nyc-outer. k=11 is top-coded, k=12 and k=20 publish no ACS
// figure. FAKE_CT adds nine Hartford tracts (for the leftover rule).
const FAKE_ACS = String.raw`
const V = process.env.FAKE_VARIANT === 'b' ? 1.02 : 1;
const sq = (s, w, d) => [[w, s], [w + d, s], [w + d, s + d], [w, s + d], [w, s]];
// The official name's number is the GEOID's tract code (…000005 -> 0.05), as verify checks.
const tn = id => { const t = id.slice(5); return +t.slice(0, 4) + (t.slice(4) === '00' ? '' : '.' + t.slice(4)); };
export default {
  id: 'acs-tract', regions: __REGIONS__, cadence: 'annual',
  meta: {
    name: 'Fake survey', publisher: 'Test Bureau', url: 'https://example.org/data', licence: 'Public domain', licenceUrl: 'https://example.org/licence',
    attribution: ['Source: Test Bureau, fake data.'], metric: 'Median home value (owners’ estimate)', unitNoun: 'owner-occupied homes', currency: 'USD',
    period: '2020–2024 (5-year survey)', notes: ['Fake.'], areaNoun: 'census tract', colourMinN: null, nEstimate: true,
    contextLabel: 'Owners’ estimate, 2020–24 survey',
  },
  async fetch() {
    const areas = [];
    for (let i = 0; i < 10; i++) for (let j = 0; j < 10; j++) {
      const k = i * 10 + j, county = j < 5 ? '36061' : j < 8 ? '36047' : '36059';
      let value = Math.round((300000 + 7000 * ((k * 37) % 89)) * V), moe = Math.round(value * 0.08), flags = [];
      if (k === 11) { value = 2000001; moe = null; flags = ['topcoded']; }
      if (k === 12 || k === 20) { value = null; moe = null; }
      areas.push({ id: county + String(k).padStart(6, '0'), name: 'Census Tract ' + tn(county + String(k).padStart(6, '0')) + ', Fake County, NY', region: 'nyc', juris: 'US-NY', scale: 'nyc',
        value, moe, n: 500, flags, context: null, polys: [[sq(40.60 + i * 0.02, -74.10 + j * 0.02, 0.02)]] });
    }
    for (let k = 0; k < 6; k++) areas.push({ id: '17031' + String(k).padStart(6, '0'), name: 'Census Tract ' + k + ', Cook County, IL', region: 'chicago', juris: 'US-IL', scale: 'chicago',
      value: 200000 + 10000 * k, moe: null, n: 50, flags: [], context: null, polys: [[sq(41.8 + k * 0.02, -87.7, 0.02)]] });
    // A tract new in this vintage, inside the sale source's covers (Manhattan).
    if (process.env.FAKE_EXTRA_TRACT) areas.push({ id: '36061000100', name: 'Census Tract 1, Fake County, NY', region: 'nyc', juris: 'US-NY', scale: 'nyc',
      value: 555000, moe: 20000, n: 400, flags: [], context: null, polys: [[sq(40.80, -74.10, 0.02)]] });
    // Hartford: six tracts in one CT planning region (09110), three in another.
    if (process.env.FAKE_CT) for (let k = 0; k < 9; k++) areas.push({ id: (k < 6 ? '09110' : '09120') + String(k).padStart(6, '0'), name: 'Census Tract ' + tn('09110' + String(k).padStart(6, '0')) + ', Fake Region, CT',
      region: 'hartford', juris: 'US-CT', scale: 'hartford', value: 200000 + 10000 * k, moe: null, n: 50, flags: [], context: null, polys: [[sq(41.73 + (k % 3) * 0.02, -72.71 + Math.floor(k / 3) * 0.02, 0.02)]] });
    return { vintage: process.env.FAKE_VARIANT === 'b' ? '2021-2025' : '2020-2024', areas };
  },
};
`;
// Sales per tract by k % 10: 0, 1, 2 (withheld), 3, 5, 9 (few), 10, 15, 40, 12
// (coloured). Prices end in odd digits, so none survives rounding; dates in
// Jan-Aug 2026. Plus one sale of each kind the build must drop.
const N = [0, 1, 2, 3, 5, 9, 10, 15, 40, 12];
const priceOf = (k, s) => 400123 + 9871 * ((k * 13 + s * 7) % 50);
const FAKE_SALES = String.raw`
const N = ${JSON.stringify(N)};
const priceOf = ${priceOf.toString()};
export default {
  id: __ID__, kind: 'point-sales', regions: [__REGION__], cadence: 'monthly', geometry: 'acs-tract',
  meta: {
    name: 'Fake sales', publisher: 'Test Finance', url: 'https://example.org/sales', licence: 'Public domain', licenceUrl: 'https://example.org/licence',
    attribution: ['Source: Test Finance, fake sales.'], metric: 'Median sale price', unitNoun: 'sales', currency: 'USD',
    window: { months: 12, by: 'recording' }, colourMinN: 10, notes: ['Fake filters, stated plainly.'], credit: 'Test Finance',
  },
  async fetch() {
    if (process.env.FAKE_SALES_FAIL) throw new Error('the rolling file renamed a column');
    const sales = [];
    const at = (i, j, s) => [40.60 + i * 0.02 + 0.002 + ((s * 0.618) % 1) * 0.016, -74.10 + j * 0.02 + 0.002 + ((s * 0.382) % 1) * 0.016];
    for (let i = 0; i < 10; i++) for (let j = 0; j < 8; j++) {
      const k = i * 10 + j;
      for (let s = 0; s < N[k % 10]; s++) { const [lat, lng] = at(i, j, s); sales.push({ lat, lng, price: priceOf(k, s), date: '2026-0' + (1 + (s % 8)) + '-15', type: 'condo' }); }
    }
    const [lat, lng] = at(0, 0, 0);
    sales.push({ lat, lng, price: 1000123, date: '2024-05-01', type: 'condo' });       // before the window
    sales.push({ lat, lng, price: 1000123, date: '2026-09-10', type: 'condo' });       // the month still filling
    sales.push({ lat, lng, price: 1000123, date: '2099-01-01', type: 'condo' });       // after the data day
    sales.push({ lat: 40.3, lng: -74.5, price: 1000123, date: '2026-03-01', type: 'condo' });   // in no tract
    const [nl, ng] = at(3, 8, 1);
    sales.push({ lat: nl, lng: ng, price: 1000123, date: '2026-03-01', type: 'condo' }); // Nassau: outside covers
    if (process.env.FAKE_SALES_SWAP) for (const x of sales) [x.lat, x.lng] = [x.lng, x.lat];
    return { covers: { juris: [__JURIS__], counties: __COUNTIES__ }, sales, dropped: { nonArmsLength: 17, nonResidential: 230 } };
  },
};
`;
const fakeSales = (id = 'nyc-dof-sales', region = 'nyc', juris = 'US-NY', counties = ['36047', '36061']) =>
  FAKE_SALES.replace('__ID__', JSON.stringify(id)).replace('__REGION__', JSON.stringify(region)).replace('__JURIS__', JSON.stringify(juris)).replace('__COUNTIES__', JSON.stringify(counties));

const readTiles = dir => Object.fromEntries(readdirSync(join(dir, 'tiles')).sort().map(f => [f, readFileSync(join(dir, 'tiles', f), 'utf8')]));
const readIndex = dir => JSON.parse(readFileSync(join(dir, 'index.json'), 'utf8'));
const F = Object.fromEntries(FIELDS.map((f, i) => [f, i]));
function rowsOf(dir) {
  const idx = readIndex(dir), src = Object.keys(idx.sources), out = new Map();
  for (const text of Object.values(readTiles(dir))) {
    const t = JSON.parse(text);
    for (const r of t.a) out.set(`${src[r[F.src]]}:${r[F.id]}`, { r, c: r[F.ctx] == null ? null : t.c[r[F.ctx]], scale: idx.scales[r[F.scale]].key });
  }
  return out;
}

test('point-sales end to end: aggregation, precedence, context, privacy, snapshots, verify', async t => {
  const tmp = mkdtempSync(join(tmpdir(), 'prices-sales-test-'));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  const sources = join(tmp, 'sources'), out = join(tmp, 'out'), raw = join(tmp, 'raw');
  mkdirSync(sources);
  writeFileSync(join(sources, 'acs-tract.mjs'), FAKE_ACS.replace('__REGIONS__', JSON.stringify(ACS_CITIES)));
  writeFileSync(join(sources, 'nyc-dof-sales.mjs'), fakeSales());
  const build = (args = [], env = {}) => run(BUILD, ['--sources', sources, '--out', out, '--raw-dir', raw, '--partial', ...args], env);

  // ── A: first build ────────────────────────────────────────────────────────
  const a = await build();
  assert.equal(a.code, 0, a.err + a.out);
  assert.match(a.out, /── nyc-dof-sales \(point-sales, monthly\) fetching: nothing published yet/);
  assert.match(a.out, /^    nyc-dof-sales +80  fetched$/m, 'the per-source line the workflow greps');
  assert.match(a.out, /acs-tract: 80 tracts shown by nyc-dof-sales, not by it/);
  const ia = readIndex(out), ta = readTiles(out);
  const s = ia.sources['nyc-dof-sales'], g = ia.sources['acs-tract'];
  assert.deepEqual(Object.keys(ia.sources), ['acs-tract', 'nyc-dof-sales'], 'areas sources first: their tile indices never move');
  assert.equal(s.kind, 'point-sales');
  assert.equal(s.geometry, 'acs-tract');
  assert.deepEqual(s.covers, { juris: ['US-NY'], counties: ['36047', '36061'] });
  assert.equal(s.vintage, '2025-09..2026-08');
  assert.equal(s.period, 'Sales recorded Sep 2025 – Aug 2026');
  assert.deepEqual(s.window, { months: 12, by: 'recording', lagMonths: 0, from: '2025-09', to: '2026-08', span: 'Sep 2025 – Aug 2026' });
  assert.equal(s.areaNoun, 'census tract');
  assert.ok(s.notes[0] === 'Fake filters, stated plainly.' && /always rests on at least 3 sales/.test(s.notes[1]), 'the privacy rule is in the source notes');
  const used = Array.from({ length: 80 }, (_, x) => N[(Math.floor(x / 8) * 10 + (x % 8)) % 10]).reduce((t, n) => t + n, 0);
  assert.deepEqual(s.stats.sales, { received: used + 5, used });
  assert.deepEqual(s.stats.dropped, { nonArmsLength: 17, nonResidential: 230, futureDate: 1, outOfWindow: 2, outsideTracts: 1, outsideCovers: 1 });
  assert.equal(s.stats.areas, 80);
  assert.deepEqual(g.stats.replaced, { 'nyc-dof-sales': 80 });
  assert.equal(g.stats.areas, 20 + 6, 'Nassau on nyc-outer, and Chicago');
  assert.deepEqual(ia.regions.find(r => r.id === 'nyc').sources, ['acs-tract', 'nyc-dof-sales']);
  assert.equal(ia.regions.find(r => r.id === 'nyc').areas, 100, 'a city keeps every tract, from one source or the other');
  const nycScale = ia.scales.find(x => x.key === 'nyc'), outer = ia.scales.find(x => x.key === 'nyc-outer');
  assert.deepEqual([nycScale.source, nycScale.metric, nycScale.period, nycScale.name], ['nyc-dof-sales', 'Median sale price', 'Sales recorded Sep 2025 – Aug 2026', 'New York City']);
  assert.deepEqual([outer.source, outer.metric, outer.name], ['acs-tract', 'Median home value (owners’ estimate)', 'Nassau and Westchester']);

  // Each tract, against an independent computation.
  const rows = rowsOf(out);
  for (let i = 0; i < 10; i++) for (let j = 0; j < 10; j++) {
    const k = i * 10 + j, county = j < 5 ? '36061' : j < 8 ? '36047' : '36059', id = county + String(k).padStart(6, '0');
    if (j >= 8) {
      const x = rows.get(`acs-tract:${id}`);
      assert.ok(x && !rows.has(`nyc-dof-sales:${id}`), `${id}: Nassau stays acs-tract`);
      assert.equal(x.scale, 'nyc-outer');
      continue;
    }
    assert.ok(!rows.has(`acs-tract:${id}`), `${id}: replaced, not shown twice`);
    const { r, c, scale } = rows.get(`nyc-dof-sales:${id}`);
    const n = N[k % 10], prices = Array.from({ length: n }, (_, x) => priceOf(k, x)).sort((p, q) => p - q);
    assert.equal(scale, 'nyc');
    assert.equal(r[F.n], n, `${id}: n`);
    assert.equal(r[F.moe], null);
    if (n < 3) {
      assert.equal(r[F.value], null, `${id}: under 3 sales, no figure`);
      assert.equal(r[F.iqr], null);
      assert.equal(r[F.flags], n > 0 || c ? 1 : 0, `${id}: suppressed, or (no sales, no context) nothing published`);
    } else {
      assert.equal(r[F.value], r1000(percentile(prices, 0.5)), `${id}: median`);
      assert.equal(r[F.flags], n < 10 ? 8 : 0, `${id}: few under 10`);
      assert.deepEqual(r[F.iqr], n < 10 ? null : [r1000(percentile(prices, 0.25)), r1000(percentile(prices, 0.75))], `${id}: middle half`);
    }
    // The context line: acs-tract's own figure, never a sale price.
    if (k === 12 || k === 20) assert.equal(c, null);
    else if (k === 11) assert.deepEqual(c, { label: 'Owners’ estimate, 2020–24 survey', value: 2000001, n: null, flags: 4 });
    else assert.deepEqual(c, { label: 'Owners’ estimate, 2020–24 survey', value: 300000 + 7000 * ((k * 37) % 89), n: null, moe: Math.round((300000 + 7000 * ((k * 37) % 89)) * 0.08) });
  }
  assert.equal(rows.get('nyc-dof-sales:36061000020').r[F.flags], 0, 'k=20: no sales, no ACS figure: not drawn');
  assert.equal(rows.get('nyc-dof-sales:36061000012').r[F.flags], 1, 'k=12: 2 sales withheld, drawn as no figure');

  // Nothing of a single sale in any tile: no location or date field, no
  // day-precise date, and no sale's own (unrounded) price.
  const all = Object.values(ta).join('\n');
  assert.ok(!/"(lat|lng|price|date|sales)"\s*:/.test(all));
  assert.ok(!/\d{4}-\d{2}-\d{2}/.test(all));
  for (let k = 0; k < 100; k++) for (let x = 0; x < 40; x++) assert.ok(!all.includes(String(priceOf(k, x))), `a raw sale price ${priceOf(k, x)} reached a tile`);
  assert.ok(!JSON.stringify(ia).includes('"sales":['), 'no list of sales in index.json');

  const v = await run(VERIFY, ['--dir', out, '--no-spot']);
  assert.equal(v.code, 0, v.out + v.err);
  assert.match(v.out, /PASS  sale figures/);
  assert.match(v.out, new RegExp(`PASS  sales counted +nyc-dof-sales ${(used + 5).toLocaleString('en-GB')} received = ${used.toLocaleString('en-GB')} placed \\+ 1 futureDate \\+ 2 outOfWindow \\+ 1 outsideTracts \\+ 1 outsideCovers`));
  assert.match(v.out, /PASS  precedence/);

  // ── B: next month, acs-tract re-emits its snapshot (it no longer holds the
  // covered tracts) and the sales are refetched: same figures, same bytes ───
  const b = await build();
  assert.equal(b.code, 0, b.err + b.out);
  assert.match(b.out, /── acs-tract \(annual\) reusing its snapshot/);
  assert.match(b.out, /── nyc-dof-sales \(point-sales, monthly\) fetching: monthly data: fetched every run/);
  assert.deepEqual(readTiles(out), ta, 'placed in snapshot tracts + its own published tracts: byte-identical');
  assert.equal(readIndex(out).sources['nyc-dof-sales'].status, 'fetched');
  assert.equal(readIndex(out).sources['acs-tract'].status, 'snapshot');
  assert.deepEqual(readIndex(out).sources['acs-tract'].stats.replaced, { 'nyc-dof-sales': 80 });

  // ── C: the sale fetch fails -> its snapshot, byte-identical; stale ───────
  const c = await build([], { FAKE_SALES_FAIL: '1' });
  assert.equal(c.code, 0, c.err + c.out);
  assert.match(c.out, /::warning::nyc-dof-sales: fetch failed \(the rolling file renamed a column\) — re-emitting its 80 areas/);
  assert.deepEqual(readTiles(out), ta);
  const ic = readIndex(out);
  assert.equal(ic.sources['nyc-dof-sales'].status, 'snapshot-after-failure', 'a monthly feed that fails has missed an update');
  assert.deepEqual({ ...ic.sources['nyc-dof-sales'], status: 'fetched' }, { ...s, status: 'fetched' }, 'the published meta, window, covers and stats are kept');
  assert.equal((await run(VERIFY, ['--dir', out, '--no-spot'])).code, 0);

  // ── D: lat/lng swapped -> no sale placed -> refused, even with --refresh ──
  const d = await build(['--refresh', 'nyc-dof-sales'], { FAKE_SALES_SWAP: '1' });
  assert.equal(d.code, 0, d.err + d.out);
  assert.match(d.out, /nyc-dof-sales: the fetch looks wrong: none of its [\d,]+ sales fell in a covered tract/);
  assert.deepEqual(readTiles(out), ta);

  // ── E: a new ACS vintage -> acs-tract refetched (every tract), and the
  // sales re-aggregated onto it with the new context line ──────────────────
  const e = await build(['--refresh', 'acs-tract'], { FAKE_VARIANT: 'b' });
  assert.equal(e.code, 0, e.err + e.out);
  assert.match(e.out, /── nyc-dof-sales \(point-sales, monthly\) fetching: its inputs changed .* or acs-tract's areas\)/);
  const re = rowsOf(out);
  const k1 = re.get('nyc-dof-sales:36061000001');
  assert.equal(k1.c.value, Math.round((300000 + 7000 * ((1 * 37) % 89)) * 1.02), 'the context line is the new vintage');
  assert.equal(k1.r[F.value], rows.get('nyc-dof-sales:36061000001').r[F.value], 'the sale figure is the same');
  assert.equal(re.get('acs-tract:36059000008').r[F.value], Math.round((300000 + 7000 * ((8 * 37) % 89)) * 1.02));
  assert.ok(![...re.keys()].some(k => k.startsWith('acs-tract:36061') || k.startsWith('acs-tract:36047')), 'still no covered tract twice');
  writeFileSync(join(tmp, 'prev-a.json'), JSON.stringify(ia));
  const ve = await run(VERIFY, ['--dir', out, '--no-spot', '--prev', join(tmp, 'prev-a.json'), '--refresh', 'acs-tract']);
  assert.equal(ve.code, 0, ve.out);
  assert.match(ve.out, /PASS  drift/);

  // ── F: verify catches tampering ──────────────────────────────────────────
  const bad = join(tmp, 'bad');
  cpSync(out, bad, { recursive: true });
  const tb = readTiles(bad);
  for (const leaf of Object.keys(tb).filter(f => tb[f].includes('"36047000006"'))) {
    const tile = JSON.parse(tb[leaf]);
    tile.a.find(r => r[F.id] === '36047000006')[F.n] = 5;                 // coloured on 5 sales
    tile.c.push({ label: 'x', value: 1, n: null, lat: 40.7 });           // a sale's location in a context
    writeFileSync(join(bad, 'tiles', leaf), JSON.stringify(tile));
  }
  const vf = await run(VERIFY, ['--dir', bad, '--no-spot']);
  assert.equal(vf.code, 1, vf.out);
  assert.match(vf.out, /FAIL  forbidden fields/);
  assert.match(vf.out, /FAIL  sale figures .*nyc-dof-sales:36047000006: coloured on n=5/);
  assert.match(vf.out, /FAIL  sales counted .*the tracts' n add up to/);
});

test('index.json: a module that adds sales to its meta at fetch time never publishes them', async t => {
  // The allowlist, on its own.
  const clean = { name: 'x', publisher: 'x', url: 'https://x', licence: 'x', licenceUrl: 'https://x', attribution: ['Source: x.'], metric: 'Median sale price',
    unitNoun: 'sales', currency: 'USD', period: 'p', notes: ['Transfers under $10,000 are left out.', 'Rounded to the nearest $1,000.'], areaNoun: 'census tract', colourMinN: 10,
    window: { months: 12, by: 'sale', lagMonths: 0, from: '2025-09', to: '2026-08', span: 's' }, kind: 'point-sales', geometry: 'acs-tract',
    covers: { juris: ['US-NY'] }, cadence: 'monthly', regions: ['nyc'], vintage: 'v', status: 'fetched', fetched: '2026-09-29', inputs: 'i',
    upstream: [{ file: 'f', url: 'https://x', status: 200, lastModified: null, etag: null, fetchedAt: 't', bytes: 1, sha256: 'h', where: "SALE_DATE >= DATE '2025-09-01'" }],
    stats: { areas: 1, coloured: 0, neutral: 1, unpublished: 0, dropped: { nominal: 3 }, sales: { received: 5, used: 2 } } };
  assert.deepEqual(entryProblems('s', clean), []);
  const sale = { lat: 40.6, lng: -74.1, price: 812345, date: '2026-01-02' };
  const cases = [
    [{ examples: [sale] }, /field\(s\) no contract lists: examples/],
    [{ upstream: [{ ...clean.upstream[0], sample: sale }] }, /upstream\[0\] has field\(s\) sample/],
    [{ stats: { ...clean.stats, sales: { received: 5, used: 2, list: [sale] } } }, /stats\.sales must be/],
    [{ notes: [...clean.notes, 'e.g. 1 Main St, BBL 5012340001, $812,345'] }, /reads like a single sale's detail/],
    [{ window: { ...clean.window, first: sale } }, /window may hold only/],
    // Free text and keys a module fills (the Sept 2026 review's mutations):
    // parcels in a query, a merged record under one query's URL, a note with
    // an 8-character PID or a day, a drop reason or a covered county that is
    // really an id.
    [{ upstream: [{ ...clean.upstream[0], url: "https://x/MapServer/3/query?where=PID+IN+('07101234','07101235')&f=json" }] }, /upstream\[0\]\.url reads like it names a property/],
    [{ upstream: [{ ...clean.upstream[0], where: "PID = '0102924110001'" }] }, /upstream\[0\]\.where reads like it names a property/],
    [{ upstream: [{ ...clean.upstream[0], where: "PID = '17332C99'" }] }, /names a property \("'17332C99'"\)/],
    [{ upstream: [{ ...clean.upstream[0], queries: 180, url: 'https://x/MapServer/3/query?where=1%3D1' }] }, /merges 180 queries but its url carries one query/],
    [{ upstream: [{ ...clean.upstream[0], item: '07101234' }] }, /item must be an ArcGIS item id/],
    [{ notes: [...clean.notes, 'Parcel 07101234 sold that month.'] }, /reads like a single sale's detail \("07101234"\)/],
    [{ notes: [...clean.notes, 'One home sold on 15 May 2026.'] }, /a note names a day \("15 May 2026"\)/],
    [{ notes: [...clean.notes, 'Sold 2026-05-15.'] }, /a note names a day/],
    [{ stats: { ...clean.stats, dropped: { nominal: 3, p0102924110001: 1 } } }, /stats\.dropped reason "p0102924110001" is not a camelCase word/],
    [{ covers: { juris: ['US-NY'], counties: ['36047', '07101234'] } }, /covers\.counties 5-digit/],
  ];
  for (const [over, re] of cases) assert.match(entryProblems('s', { ...clean, ...over }).join(' | '), re);
  // What real sources publish passes: Maryland's IN list of county codes,
  // a CT town in a query, a dataset's version date in an attribution line.
  assert.deepEqual(entryProblems('s', { ...clean,
    upstream: [{ ...clean.upstream[0], url: "https://x/resource/ed4q.json?$where=j+IN+('ANNE',+'BACO')" }, { ...clean.upstream[0], url: "https://x/resource/5mzw.json?$where=listyear=2024+AND+town='East+Hartford'" }],
    attribution: ['Source: NYC Open Data usep-8jbt, data as of 2026-09-15.'] }), []);

  // End to end: the build refuses it, and writes nothing.
  const tmp = mkdtempSync(join(tmpdir(), 'prices-sales-leak-'));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  const sources = join(tmp, 'sources');
  mkdirSync(sources);
  writeFileSync(join(sources, 'acs-tract.mjs'), FAKE_ACS.replace('__REGIONS__', JSON.stringify(ACS_CITIES)));
  writeFileSync(join(sources, 'nyc-dof-sales.mjs'), fakeSales().replace("const sales = [];", "const sales = []; this.meta.examples = sales;"));
  const r = await run(BUILD, ['--sources', sources, '--out', join(tmp, 'out'), '--raw-dir', join(tmp, 'raw'), '--partial']);
  assert.equal(r.code, 1, r.out);
  assert.match(r.err, /nyc-dof-sales: field\(s\) no contract lists: examples/);
  assert.ok(!readdirSync(tmp).includes('out'), 'nothing written');
});

test('a sale source down while acs-tract gains a covered tract: the tract waits, the city builds, the stale notice stays', async t => {
  const tmp = mkdtempSync(join(tmpdir(), 'prices-sales-outage-'));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  const sources = join(tmp, 'sources'), out = join(tmp, 'out'), raw = join(tmp, 'raw');
  mkdirSync(sources);
  writeFileSync(join(sources, 'acs-tract.mjs'), FAKE_ACS.replace('__REGIONS__', JSON.stringify(ACS_CITIES)));
  writeFileSync(join(sources, 'nyc-dof-sales.mjs'), fakeSales());
  const build = (args = [], env = {}) => run(BUILD, ['--sources', sources, '--out', out, '--raw-dir', raw, '--partial', ...args], env);
  const verify = () => run(VERIFY, ['--dir', out, '--no-spot']);
  const NEW = '36061000100';
  assert.equal((await build()).code, 0);

  // A new vintage brings a Manhattan tract the sale source's snapshot lacks,
  // in the month the sale feed is down: neither an owners' estimate on the
  // sale-price scale nor a stopped build; the tract waits, counted.
  const a = await build(['--refresh', 'acs-tract'], { FAKE_EXTRA_TRACT: '1', FAKE_SALES_FAIL: '1' });
  assert.equal(a.code, 0, a.err + a.out);
  assert.match(a.out, /::warning::acs-tract: 1 tract\(s\) inside a sale source's covers that its current tiles do not hold \(e\.g\. nyc 36061000100\)/);
  let idx = readIndex(out), rows = rowsOf(out);
  assert.ok(!rows.has(`acs-tract:${NEW}`) && !rows.has(`nyc-dof-sales:${NEW}`), 'not shown by either source yet');
  assert.equal(idx.sources['acs-tract'].stats.dropped.awaitingSaleSource, 1);
  assert.equal(idx.sources['nyc-dof-sales'].status, 'snapshot-after-failure');
  let v = await verify();
  assert.equal(v.code, 0, v.out);

  // The sale module changes while the feed is still down: its inputs changed,
  // but a monthly feed that fails has still missed an update (stale), and
  // acs-tract is fetched again for its waiting tract.
  writeFileSync(join(sources, 'nyc-dof-sales.mjs'), fakeSales() + '\n// edited\n');
  const b = await build([], { FAKE_EXTRA_TRACT: '1', FAKE_SALES_FAIL: '1' });
  assert.equal(b.code, 0, b.err + b.out);
  assert.match(b.out, /── acs-tract \(annual\) fetching: 1 of its tracts are waiting for a sale source to show them/);
  assert.match(b.out, /── nyc-dof-sales \(point-sales, monthly\) fetching: its inputs changed/);
  idx = readIndex(out);
  assert.equal(idx.sources['nyc-dof-sales'].status, 'snapshot-after-failure', 'an inputs change does not hide a failed monthly feed');
  v = await verify();
  assert.equal(v.code, 0, v.out);
  assert.match(v.out, /WARN  stale nyc-dof-sales/);

  // The feed is back: the waiting tract is handed over, a sale tract.
  const c = await build([], { FAKE_EXTRA_TRACT: '1' });
  assert.equal(c.code, 0, c.err + c.out);
  idx = readIndex(out); rows = rowsOf(out);
  assert.ok(rows.has(`nyc-dof-sales:${NEW}`) && !rows.has(`acs-tract:${NEW}`));
  assert.equal(rows.get(`nyc-dof-sales:${NEW}`).c.value, 555000, 'with its ACS context line');
  assert.equal(idx.sources['acs-tract'].stats.dropped.awaitingSaleSource, undefined);
  assert.equal(idx.sources['nyc-dof-sales'].status, 'fetched');
  assert.equal((await verify()).code, 0);
});

test('the first phase-2 build over a phase-1 snapshot, and verify against it', async t => {
  const tmp = mkdtempSync(join(tmpdir(), 'prices-sales-transition-'));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  const p1 = join(tmp, 'sources-p1'), p2 = join(tmp, 'sources-p2'), out = join(tmp, 'out'), fresh = join(tmp, 'fresh'), raw = join(tmp, 'raw');
  mkdirSync(p1); mkdirSync(p2);
  const acs = FAKE_ACS.replace('__REGIONS__', JSON.stringify(ACS_CITIES));
  writeFileSync(join(p1, 'acs-tract.mjs'), acs);
  writeFileSync(join(p2, 'acs-tract.mjs'), acs);
  writeFileSync(join(p2, 'nyc-dof-sales.mjs'), fakeSales());
  // Phase 1: ACS everywhere, NYC on one scale.
  const one = await run(BUILD, ['--sources', p1, '--out', out, '--raw-dir', raw, '--partial']);
  assert.equal(one.code, 0, one.err + one.out);
  const i1 = readIndex(out);
  assert.equal(i1.sources['acs-tract'].stats.areas, 106);
  writeFileSync(join(tmp, 'prev-1.json'), JSON.stringify(i1));
  // Phase 2 over it: acs-tract re-emits its snapshot (every NYC tract), the
  // sales are placed in it, and precedence hands the covered ones over.
  const two = await run(BUILD, ['--sources', p2, '--out', out, '--raw-dir', raw, '--partial']);
  assert.equal(two.code, 0, two.err + two.out);
  assert.match(two.out, /── acs-tract \(annual\) reusing its snapshot/);
  // The same as a build from scratch.
  const scratch = await run(BUILD, ['--sources', p2, '--out', fresh, '--raw-dir', raw, '--partial']);
  assert.equal(scratch.code, 0, scratch.err);
  assert.deepEqual(readTiles(out), readTiles(fresh), 'over a phase-1 snapshot or from scratch: the same tiles');
  // verify against phase 1: the NYC scale changed source (not drift), the
  // acs-tract family kept every tract, nothing is lost.
  const v = await run(VERIFY, ['--dir', out, '--no-spot', '--prev', join(tmp, 'prev-1.json')]);
  assert.equal(v.code, 0, v.out);
  assert.match(v.out, /PASS  nothing lost/);
  assert.match(v.out, /PASS  drift .*not compared, as their source changed: nyc: acs-tract -> nyc-dof-sales/);
});

test('precedence: leftover tracts in a region with no second scale key stop the build', async t => {
  const tmp = mkdtempSync(join(tmpdir(), 'prices-sales-leftover-'));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  const sources = join(tmp, 'sources');
  mkdirSync(sources);
  writeFileSync(join(sources, 'acs-tract.mjs'), FAKE_ACS.replace('__REGIONS__', JSON.stringify(ACS_CITIES)));
  // A Hartford sale source that covers one of the rectangle's two planning
  // regions: the other's tracts would be left to acs-tract, and hartford has
  // one scale key.
  writeFileSync(join(sources, 'ct-opm-sales.mjs'), String.raw`
export default {
  id: 'ct-opm-sales', kind: 'point-sales', regions: ['hartford'], cadence: 'annual', geometry: 'acs-tract',
  meta: { name: 'Fake CT sales', publisher: 'Test OPM', url: 'https://example.org/ct', licence: 'Public domain', licenceUrl: 'https://example.org/licence',
    attribution: ['Source: Test OPM.'], metric: 'Median sale price', unitNoun: 'sales', currency: 'USD', window: { months: 12, by: 'recording' }, colourMinN: 10, notes: ['Fake.'] },
  async fetch() {
    const sales = [];
    for (let k = 0; k < 9; k++) for (let s = 0; s < 12; s++) sales.push({ lat: 41.735 + (k % 3) * 0.02, lng: -72.705 + Math.floor(k / 3) * 0.02, price: 250000 + s * 1000, date: '2026-03-15' });
    return { covers: { juris: ['US-CT'], counties: ['09110'] }, sales, dropped: {}, through: '2026-03' };
  },
};
`);
  const r = await run(BUILD, ['--sources', sources, '--out', join(tmp, 'out'), '--raw-dir', join(tmp, 'raw'), '--partial'], { FAKE_CT: '1' });
  assert.equal(r.code, 1, r.out);
  assert.match(r.err, /hartford: acs-tract tract 09120000006 is outside ct-opm-sales's covers, and tools\/prices\/regions\.mjs gives hartford no second scale key/);
  assert.ok(!readdirSync(tmp).includes('out'), 'nothing written');
});
