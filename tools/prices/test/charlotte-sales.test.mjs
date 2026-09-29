// node --test tools/prices/test/*.test.mjs
// Charlotte recorded sales (sources/charlotte-sales.mjs): which rows of the
// City's Parcel Look Up table count as a home sale, that every row is counted
// exactly once, how its odd date encoding is read, the completeness cutoff it
// hands the build, the point placed inside each parcel, and the fetch against
// a fake server (a lost answer, a partial parcels batch, a Price that is not a
// number, the upstream records). Hand-made rows only; nothing here touches
// the network.
import test from 'node:test';
import assert from 'node:assert/strict';
import src, {
  saleDate, completeThrough, readFrom, classify, reduceSales, interiorPoint, pidBatches,
  RESIDENTIAL, NON_RESIDENTIAL, DROP_REASONS, SPLIT_MIN,
} from '../sources/charlotte-sales.mjs';
import { metaProblems } from '../lib/schema.mjs';
import { saleWindow, ORCH_DROPS } from '../lib/sales.mjs';

// One normalised row: a house sold on a warranty deed. Each account has its
// own deed reference unless a test gives one.
const row = (over = {}) => {
  const r = { account: '23125860', pid: '23125860', date: '2026-06-08', price: 410_000, use: 'Single-Family', deed: 'WD', units: 1, ...over };
  return 'ref' in over ? r : { ...r, ref: `R-${r.account}` };
};
const reason = over => classify(row(over)).drop;
const points = new Map([['23125860', { lat: 35.07, lng: -80.73 }], ['23109C99', { lat: 35.06, lng: -80.72 }], ['11111111', { lat: 35.2, lng: -80.8 }],
  ['22222222', { lat: 35.3, lng: -80.9 }], ['33333333', { lat: 35.1, lng: -80.85 }], ['44444444', { lat: 35.15, lng: -80.75 }]]);

test('Sales_Date: midday Eastern on the day before is the sale day; a fixed encoding reads the same', () => {
  assert.equal(saleDate(Date.parse('2026-09-13T16:00:00Z')), '2026-09-14', 'EDT: stored 16:00 UTC the day before (a Monday sale)');
  assert.equal(saleDate(Date.parse('2026-11-23T17:00:00Z')), '2026-11-24', 'EST: 17:00 UTC the day before');
  assert.equal(saleDate(Date.parse('2026-09-14T00:00:00Z')), '2026-09-14', 'the day’s own UTC midnight');
  assert.equal(saleDate(Date.parse('2026-09-14T04:00:00Z')), '2026-09-14', 'the day’s own Eastern midnight (EDT)');
  assert.equal(saleDate(Date.parse('2026-01-05T05:00:00Z')), '2026-01-05', 'the day’s own Eastern midnight (EST)');
  assert.equal(saleDate(Date.parse('2026-09-14T12:00:00Z')), null, 'noon UTC could be either day: no date');
  assert.equal(saleDate(null), null);
  assert.equal(saleDate(NaN), null);
});

test('complete through: the last month that ended 45 days before the newest sale', () => {
  assert.equal(completeThrough('2026-09-23'), '2026-07', 'the 29 Sep 2026 read: August is still filling');
  assert.equal(completeThrough('2026-10-29'), '2026-08', 'a November build (newest sale late October) ends on August');
  assert.equal(completeThrough('2026-10-15'), '2026-08', 'August ended 45 days before');
  assert.equal(completeThrough('2026-10-14'), '2026-07', 'August ended only 44 days before');
  assert.equal(completeThrough('2026-02-14'), '2025-12', 'across a year');
  assert.throws(() => completeThrough('23/09/2026'));
});

test('rows are read from the first day the build’s window can reach', () => {
  assert.equal(readFrom('2026-07'), '2025-08-01');
  assert.equal(readFrom('2026-07', 24), '2024-08-01');
  assert.equal(readFrom('2026-01'), '2025-02-01');
});

test('the build, given `through`, takes the window the rows were read for', () => {
  const { months, lagMonths } = src.meta.window;
  const through = completeThrough('2026-09-23');
  const w = saleWindow({ latest: '2026-09-23', months, lagMonths, through });
  assert.deepEqual(w, { from: '2025-08', to: '2026-07', span: 'Aug 2025 – Jul 2026' });
  assert.equal(`${w.from}-01`, readFrom(through, months, lagMonths));
  // A stray sale on September's last day makes neither September nor a
  // still-filling August complete.
  assert.equal(saleWindow({ latest: '2026-09-30', months, lagMonths, through: completeThrough('2026-09-30') }).to, '2026-07');
});

test('a warranty-deed sale of a home is kept, typed by its property use', () => {
  assert.deepEqual(classify(row()), { keep: 'single-family' });
  assert.deepEqual(classify(row({ use: 'Condo/Townhome', deed: 'SW' })), { keep: 'condo/townhome' });
  assert.deepEqual(classify(row({ use: 'Manufactured' })), { keep: 'manufactured' });
  assert.deepEqual(classify(row({ deed: ' wd ' })), { keep: 'single-family' }, 'case and spaces in the deed code');
  assert.deepEqual(classify(row({ units: 4 })), { keep: 'single-family' }, 'a quadraplex is a home');
  assert.deepEqual(classify(row({ price: 10_000 })), { keep: 'single-family' });
});

test('property use: blank is its own reason, a known non-home use is dropped, an unknown one throws', () => {
  for (const use of [null, undefined, '', ' ']) assert.equal(reason({ use }), 'noPropertyUse', JSON.stringify(use));
  for (const use of NON_RESIDENTIAL) assert.equal(reason({ use }), 'nonResidential', use);
  assert.ok(NON_RESIDENTIAL.has('Multi-Family'), 'apartment buildings are not a home sale');
  for (const use of Object.keys(RESIDENTIAL)) assert.ok(!NON_RESIDENTIAL.has(use), use);
  assert.throws(() => classify(row({ use: 'Mixed Use' })), /property use "Mixed Use"/);
  assert.equal(reason({ units: 5 }), 'fivePlusHomes');
});

test('deeds: only warranty and special warranty deeds; the county’s multiple-lots deed is a multi-parcel sale', () => {
  for (const deed of ['QC', 'NW', 'TD', 'COMD', 'FOR', 'SHF/D', 'CD', 'DECL', 'ID', 'AF', 'R/W', 'XYZ']) assert.equal(reason({ deed }), 'otherDeed', deed);
  assert.equal(reason({ deed: 'ML' }), 'multiParcel');
  assert.equal(reason({ deed: null }), 'noDeedType');
  assert.equal(reason({ deed: '' }), 'noDeedType');
});

test('prices under $10,000 are nominal; a row with no date is dropped first', () => {
  assert.equal(reason({ price: 9_999 }), 'nominal');
  assert.equal(reason({ price: 0 }), 'nominal');
  assert.equal(reason({ price: null }), 'nominal');
  assert.equal(reason({ date: null, use: 'Office' }), 'noDate');
});

test('reduceSales counts every row exactly once', () => {
  const rows = [
    row(), row(),                                                                  // one account's two building cards
    row({ account: '23109175', pid: '23109C99', use: 'Condo/Townhome', ref: '38260-937', price: 470_000 }),   // a condo unit, placed at its building
    // One deed conveying a house and the vacant lot beside it: both go.
    row({ account: '11111111', pid: '11111111', ref: '40001-001', price: 650_000 }),
    row({ account: '11111112', pid: '11111112', ref: '40001-001', price: 650_000, use: null }),
    // A split portfolio: three homes, one day, one uneven price.
    row({ account: '22222222', pid: '22222222', date: '2026-03-02', price: 166_666, ref: 'a' }),
    row({ account: '22222223', pid: '22222222', date: '2026-03-02', price: 166_666, ref: 'b' }),
    row({ account: '22222224', pid: '22222222', date: '2026-03-02', price: 166_666, ref: 'c' }),
    // Two homes on one day at one ROUND price, different deeds: a coincidence, kept.
    row({ account: '33333333', pid: '33333333', date: '2026-03-02', price: 300_000, ref: 'd' }),
    row({ account: '44444444', pid: '44444444', date: '2026-03-02', price: 300_000, ref: 'e' }),
    row({ account: '55555555', pid: '55555555' }),                                  // no parcel polygon
    row({ deed: 'QC', price: 0, account: '66666666' }), row({ use: 'Office', account: '77777777' }), row({ date: null, account: '88888888' }),
    row({ deed: 'ML', account: '99999999' }), row({ price: 5_000, account: '12121212' }), row({ units: 6, account: '13131313' }),
    row({ deed: null, account: '14141414' }), row({ use: '', account: '15151515' }),
  ];
  const { sales, dropped } = reduceSales(rows, points);
  assert.deepEqual(Object.keys(dropped), DROP_REASONS);
  assert.deepEqual(dropped, { noDate: 1, duplicate: 1, noPropertyUse: 2, nonResidential: 1, fivePlusHomes: 1, noDeedType: 1, otherDeed: 1,
    multiParcel: 2, nominal: 1, splitPortfolio: SPLIT_MIN, noLocation: 1 });
  assert.equal(sales.length, 4);
  assert.equal(sales.length + Object.values(dropped).reduce((a, b) => a + b, 0), rows.length);
  assert.deepEqual(sales.find(s => s.type === 'condo/townhome'), { lat: 35.06, lng: -80.72, price: 470_000, date: '2026-06-08', type: 'condo/townhome' });
  // The build counts these itself and refuses a source that does too.
  for (const k of ORCH_DROPS) assert.ok(!(k in dropped), k);
  // Nothing that identifies a property survives into a sale.
  for (const s of sales) assert.deepEqual(Object.keys(s).sort(), ['date', 'lat', 'lng', 'price', 'type']);
});

test('the same deed reference on two accounts is one conveyance only on the same day at the same price', () => {
  const rows = [
    row({ account: '11111111', pid: '11111111', ref: '40001-001', date: '2026-01-05' }),
    row({ account: '33333333', pid: '33333333', ref: '40001-001', date: '2026-02-05' }),   // another day
    row({ account: '44444444', pid: '44444444', ref: '40001-001', date: '2026-01-05', price: 420_000 }),   // another price
  ];
  const { sales, dropped } = reduceSales(rows, points);
  assert.equal(sales.length, 3);
  assert.equal(dropped.multiParcel, 0);
  // A blank reference never groups.
  const blank = reduceSales([row({ ref: '' }), row({ account: '11111111', pid: '11111111', ref: '' })], points);
  assert.equal(blank.sales.length, 2);
});

test('interiorPoint: the centroid when it is inside, else a point that is', () => {
  const inside = (p, rings) => {
    let c = false;
    for (const r of rings) for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
      const [xi, yi] = r[i], [xj, yj] = r[j];
      if ((yi > p.lat) !== (yj > p.lat) && p.lng < ((xj - xi) * (p.lat - yi)) / (yj - yi) + xi) c = !c;
    }
    return c;
  };
  const square = [[[-80.8, 35.2], [-80.8, 35.21], [-80.79, 35.21], [-80.79, 35.2], [-80.8, 35.2]]];
  const sq = interiorPoint(square);
  assert.ok(Math.abs(sq.lat - 35.205) < 1e-9 && Math.abs(sq.lng + 80.795) < 1e-9);
  // A U: its centroid lies in the notch, outside the parcel.
  const u = [[[0, 0], [0, 3], [1, 3], [1, 1], [2, 1], [2, 3], [3, 3], [3, 0], [0, 0]]];
  const pu = interiorPoint(u);
  assert.ok(inside(pu, u), JSON.stringify(pu));
  // A ring with a hole where the centroid is.
  const holed = [[[0, 0], [0, 4], [4, 4], [4, 0], [0, 0]], [[1, 1], [3, 1], [3, 3], [1, 3], [1, 1]]];
  const ph = interiorPoint(holed);
  assert.ok(inside(ph, holed), JSON.stringify(ph));
  assert.equal(interiorPoint([[[0, 0], [1, 1], [2, 2], [0, 0]]]), null, 'no area');
  assert.equal(interiorPoint([]), null);
  assert.equal(interiorPoint(null), null);
});

test('PID batches keep every URL under the host’s firewall limit and cover every PID once', () => {
  const pids = Array.from({ length: 1234 }, (_, i) => String(23100000 + i * 7).padStart(8, '0'));
  pids.push('23109C99');
  const base = 'https://gis.charlottenc.gov/arcgis/rest/services/CLT_Ex/CLTEx_PopUps/MapServer/3/query?';
  const b = pidBatches(new Set(pids));
  assert.deepEqual(b.flat().sort(), [...pids].sort());
  for (const batch of b) {
    const url = base + new URLSearchParams({ where: `PID IN (${batch.map(p => `'${p}'`).join(',')})`, outFields: 'PID', returnGeometry: 'true', outSR: '4326', geometryPrecision: '6', f: 'json' });
    assert.ok(url.length <= 1900, `${url.length}`);
  }
  assert.ok(b.length >= 12 && b.length <= 14, `${b.length} batches`);
  assert.throws(() => pidBatches(['2312586']), /not an 8-character parcel id/);
  assert.throws(() => pidBatches(["2312586'"]), /not an 8-character parcel id/);
});

test('the module declares a point-sales source whose meta meets the contract', () => {
  assert.equal(src.id, 'charlotte-sales');
  assert.equal(src.kind, 'point-sales');
  assert.deepEqual(src.regions, ['charlotte']);
  assert.equal(src.geometry, 'acs-tract');
  assert.equal(src.cadence, 'monthly');
  assert.deepEqual(src.meta.window, { months: 12, by: 'sale', lagMonths: 0 });
  assert.equal(src.meta.colourMinN, 10);
  assert.equal(src.meta.metric, 'Median sale price');
  assert.equal(src.meta.period, undefined, 'the build states the period from the window it finds');
  assert.equal(src.meta.licenceUrl, 'https://creativecommons.org/licenses/by/4.0/');
  assert.ok(src.meta.notes.some(n => /latest transfer of each property/.test(n)), 'the last-sale-per-parcel bias is stated');
  assert.deepEqual(metaProblems(src.meta, 'point-sales'), []);
});

// ── the fetch, against a fake gis.charlottenc.gov (no network) ─────────────
// A ctx whose download() answers from `serve(url, n)` (n: how many times that
// URL was asked before), recording provenance as the real downloader does.
// Findings of the Sept 2026 review: a lost answer cost the month, a partial
// parcels batch took tracts off the map unseen, a numeric-string Price
// stopped every city's build, and un-merged parcel queries would have
// published every parcel id looked up.
import { fetchSales, timing, BATCH_MIN_SHARE, normalise } from '../sources/charlotte-sales.mjs';
import { entryProblems } from '../lib/schema.mjs';

const LOOKUP = 'https://gis.charlottenc.gov/arcgis/rest/services/CLT_Ex/CLTEx_MoreInfo/MapServer/4';
const PARCELS = 'https://gis.charlottenc.gov/arcgis/rest/services/CLT_Ex/CLTEx_PopUps/MapServer/3';
const FIELDS = ['OBJECTID', 'Tax_ID', 'PID', 'Card_No', 'Property_Use', 'Units', 'Sales_Date', 'Price', 'TypeOfDeed', 'Legal_Reference'];
const pidOf = i => `9${String(i).padStart(7, '0')}`;
// 10,000 houses sold Aug 2025 – Sep 2026, 16:00 UTC the day before each sale
// (the table's encoding), whole-thousand prices, one deed each.
const TABLE = Array.from({ length: 10_000 }, (_, i) => {
  const day = new Date(Date.UTC(2025, 7, 1) + (i % 419) * 864e5);
  return { OBJECTID: i + 1, Tax_ID: pidOf(i), PID: pidOf(i), Card_No: 1, Property_Use: 'Single-Family', Units: 1,
    Sales_Date: day.getTime() - 8 * 36e5, Price: 250_000 + (i % 300) * 1000, TypeOfDeed: 'WD', Legal_Reference: `B${i}` };
});
const square = i => { const lat = 35.1 + (i % 100) * 0.002, lng = -80.9 + Math.floor(i / 100) * 0.002; return [[[lng, lat], [lng + 0.001, lat], [lng + 0.001, lat + 0.001], [lng, lat + 0.001], [lng, lat]]]; };

function fakeCtx(serve, { frozen = false } = {}) {
  const seen = new Map();
  const ctx = {
    frozen, log: () => {}, warn: () => {}, provenance: [], discarded: [], asked: [],
    regions: { charlotte: { juris: ['US-NC'] } },
    readers: { columns: (header, need, what) => { const miss = need.filter(n => !header.includes(n)); if (miss.length) throw new Error(`${what} is missing column(s) ${miss}`); } },
    async download(file, url) {
      const n = seen.get(url) || 0; seen.set(url, n + 1); ctx.asked.push(url);
      const body = serve(url, n);
      if (body instanceof Error) throw body;
      const buf = Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
      ctx.provenance.push({ file, url, status: 200, bytes: buf.length, sha256: '0', fetchedAt: '2026-09-29T12:00:00.000Z', cached: false });
      return buf;
    },
    discard(file) { ctx.discarded.push(file); return true; },
  };
  return ctx;
}
const q = url => Object.fromEntries(new URL(url).searchParams);
// The honest server; `tweak(url, n, answer)` may change any answer.
const server = (table = TABLE, tweak = (u, n, a) => a) => (url, n) => {
  let a;
  if (url.startsWith('https://www.arcgis.com/sharing/rest/content/items/')) {
    const key = url.includes('859c7065') ? 'parcels' : 'lookup';
    a = { title: key, owner: 'CharlotteNC', access: 'public', licenseInfo: '<a href="https://creativecommons.org/licenses/by/4.0/">CC BY 4.0</a>', url: key === 'parcels' ? PARCELS : LOOKUP };
  } else if (url.startsWith(`${LOOKUP}/query`)) {
    const p = q(url);
    if (p.returnCountOnly) a = { count: table.length };
    else if (p.orderByFields === 'Sales_Date DESC') a = { fields: [{ name: 'Sales_Date' }], features: [{ attributes: { Sales_Date: Math.max(...table.map(r => r.Sales_Date)) } }] };
    else {
      const off = +p.resultOffset, k = +p.resultRecordCount, page = table.slice(off, off + k);
      a = { fields: FIELDS.map(name => ({ name })), features: page.map(attributes => ({ attributes })), exceededTransferLimit: off + k < table.length };
    }
  } else if (url.startsWith(`${PARCELS}/query`)) {
    const pids = [...q(url).where.matchAll(/'([0-9A-Z]{8})'/g)].map(m => m[1]);
    a = { fields: [{ name: 'PID' }], features: pids.map(pid => ({ attributes: { PID: pid }, geometry: { rings: square(+pid.slice(1)) } })) };
  } else throw new Error(`unexpected URL ${url}`);
  return tweak(url, n, a);
};
const quick = t => { const was = { ...timing }; timing.retryMs = 0; t.after(() => Object.assign(timing, was)); };

test('fetch: every row read, a Mecklenburg-sized year kept, and exactly two upstream records, one per layer, naming no parcel', async t => {
  quick(t);
  const ctx = fakeCtx(server());
  const r = await fetchSales(ctx, { today: '2026-09-29' });
  assert.equal(r.sales.length + Object.values(r.dropped).reduce((a, b) => a + b, 0), TABLE.length);
  assert.equal(r.through, '2026-07');
  assert.deepEqual(r.covers, { juris: ['US-NC'], counties: ['37119'] });
  assert.equal(ctx.provenance.length, 2, 'the sales table and Parcels, one merged record each');
  assert.deepEqual(ctx.provenance.map(p => p.url).sort(), [LOOKUP, PARCELS]);
  assert.ok(ctx.provenance.find(p => p.url === PARCELS).queries > 50, 'the parcel lookups were merged, not dropped');
  // The published entry's check passes; an un-merged batch record would not.
  const entry = { kind: 'point-sales', ...src.meta, upstream: ctx.provenance.map(({ cached, ...p }) => p) };
  assert.deepEqual(entryProblems('charlotte-sales', entry), []);
  const batch = ctx.asked.find(u => u.startsWith(`${PARCELS}/query`));
  assert.match(entryProblems('charlotte-sales', { ...entry, upstream: [...entry.upstream, { file: 'charlotte-sales-parcels-0.json', url: batch }] }).join(), /names a property/);
});

test('fetch: one lost answer is asked once more after a pause, and the bad copy is discarded', async t => {
  quick(t);
  let errors = 0;
  const ctx = fakeCtx(server(TABLE, (url, n, a) => (q(url).resultOffset === '5000' && n === 0 ? (errors++, { error: { code: 500, message: 'Cannot perform query. Invalid query parameters.' } }) : a)));
  const r = await fetchSales(ctx, { today: '2026-09-29' });
  assert.equal(errors, 1);
  assert.equal(ctx.discarded.length, 1);
  assert.ok(r.sales.length > 8400);
  const pages = new Set(ctx.asked.filter(u => u.startsWith(`${LOOKUP}/query`) && q(u).outFields?.includes('Price'))).size;
  assert.equal(ctx.provenance.find(p => p.url === LOOKUP).queries, pages, 'the failed answer is not counted as a page read');
  // Twice in a row, or under --frozen, it fails the source.
  const again = fakeCtx(server(TABLE, (url, n, a) => (q(url).resultOffset === '5000' ? { error: { code: 500, message: 'Cannot perform query.' } } : a)));
  await assert.rejects(fetchSales(again, { today: '2026-09-29' }), /Cannot perform query/);
  const frozen = fakeCtx(server(TABLE, (url, n, a) => (q(url).resultOffset === '5000' && n === 0 ? { error: { code: 500, message: 'Cannot perform query.' } } : a)), { frozen: true });
  await assert.rejects(fetchSales(frozen, { today: '2026-09-29' }), /Cannot perform query/);
  // The firewall's rejection of an over-long URL is not asked again.
  const fw = fakeCtx(server(TABLE, (url, n, a) => (url.startsWith(`${PARCELS}/query`) ? '<html><title>Request Rejected</title></html>' : a)));
  await assert.rejects(fetchSales(fw, { today: '2026-09-29' }), /firewall rejected/);
  assert.equal(fw.asked.filter(u => u.startsWith(`${PARCELS}/query`)).length, 1);
});

test(`fetch: a parcels batch that answers under ${BATCH_MIN_SHARE * 100}% of its PIDs is asked again, then fails the source`, async t => {
  quick(t);
  const half = (url, n, a, times) => (url.startsWith(`${PARCELS}/query`) && url.includes(pidOf(4200)) && n < times ? { ...a, features: a.features.slice(0, a.features.length >> 1) } : a);
  const once = fakeCtx(server(TABLE, (u, n, a) => half(u, n, a, 1)));
  const r = await fetchSales(once, { today: '2026-09-29' });
  assert.equal(r.dropped.noLocation, 0, 'the second answer was whole');
  assert.ok(once.discarded.length >= 1);
  const always = fakeCtx(server(TABLE, (u, n, a) => half(u, n, a, 9)));
  await assert.rejects(fetchSales(always, { today: '2026-09-29' }), /answered \d+ of the \d+ PIDs/);
});

test('a Price that is not a number is format drift: this source throws, it never reaches the build', async t => {
  quick(t);
  assert.throws(() => normalise({ PID: '11111111', Price: '358000' }), /Price reads "358000"/);
  assert.equal(normalise({ PID: '11111111', Price: null }).price, null, 'no price is a nominal transfer, counted');
  const ctx = fakeCtx(server(TABLE.map(r => ({ ...r, Price: String(r.Price) }))));
  await assert.rejects(fetchSales(ctx, { today: '2026-09-29' }), /not a number/);
});
