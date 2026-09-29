// node --test tools/prices/test/*.test.mjs
// Hennepin County recorded sales (sources/hennepin-sales.mjs): which parcel
// rows count as a home sale, that every row is counted exactly once, the
// month arithmetic, the completeness cutoff it hands the build, and the fetch
// against a fake layer (a read cut short, a transient error, the upstream
// record). Hand-made rows only; nothing here touches the network.
import test from 'node:test';
import assert from 'node:assert/strict';
import src, {
  classify, reduceSales, completeThrough, readFrom, isYm, isoOf, thisMonth,
  HOME, NON_RESIDENTIAL, SALE_CODES, DROP_REASONS,
} from '../sources/hennepin-sales.mjs';
import { saleWindow, ORCH_DROPS } from '../lib/sales.mjs';
import { metaProblems, entryProblems } from '../lib/schema.mjs';

// One parcel row as the query returns it: a house sold by warranty deed.
let pid = 0;
const row = over => ({
  OBJECTID: ++pid, PID: String(2702924110000 + pid), SALE_DATE: '202605', SALE_PRICE: 385000,
  SALE_CODE: 'W', SALE_CODE_NAME: 'WARRANTY DEED', PR_TYP_CD1: 'R', PR_TYP_CD2: ' ', PR_TYP_CD3: null, PR_TYP_CD4: null,
  CO_OP_IND: ' ', LAT: 44.9483, LON: -93.2871, ...over,
});
const reason = over => classify(row(over)).drop;

test('a warranty-deed or contract-for-deed home sale is kept, with only the five build-time fields', () => {
  assert.deepEqual(classify(row()), { sale: { lat: 44.9483, lng: -93.2871, price: 385000, date: '2026-05-01', type: 'house' } });
  assert.equal(classify(row({ SALE_CODE: 'C' })).sale.price, 385000, 'contract for deed');
  // The layer pads some codes to two characters.
  assert.equal(classify(row({ PR_TYP_CD1: 'X ' })).sale.type, 'condo');
  assert.equal(classify(row({ PR_TYP_CD1: 'Y' })).sale.type, 'townhouse');
  assert.equal(classify(row({ PR_TYP_CD1: 'DB' })).sale.type, '2-3 unit');
  assert.equal(classify(row({ PR_TYP_CD1: 'TP' })).sale.type, '2-3 unit');
  for (const c of ['RL', 'D ', 'RM', 'B', 'RZ']) assert.equal(classify(row({ PR_TYP_CD1: c })).sale.type, 'house', c);
  // A side lot, a garage stall or common area in another subrecord is still a home sale.
  for (const c of ['LR', 'XM', 'K', 'R']) assert.ok(classify(row({ PR_TYP_CD2: c })).sale, c);
});

test('only the county’s home property types; an unknown code throws (format drift)', () => {
  for (const c of ['A', 'C', 'C ', 'I', 'LR', 'LL', 'S', 'HL', 'HR', 'HT', 'F', 'K', '', null]) assert.equal(reason({ PR_TYP_CD1: c }), 'nonResidential', String(c));
  assert.equal(reason({ PR_TYP_CD1: 'XM' }), 'notAHome', 'condo garage/miscellaneous');
  assert.equal(reason({ PR_TYP_CD1: 'XC' }), 'cooperative');
  assert.equal(reason({ CO_OP_IND: 'U' }), 'cooperative', 'a co-op unit, whatever its type');
  assert.equal(reason({ CO_OP_IND: 'M' }), 'cooperative', 'a co-op master parcel');
  assert.throws(() => classify(row({ PR_TYP_CD1: 'ZZ' })), /property type code "ZZ"/);
  for (const c of Object.keys(HOME)) assert.ok(!NON_RESIDENTIAL.has(c), c);
});

test('a home with a shop, office, apartment or farm subrecord is a mixed use', () => {
  assert.equal(reason({ PR_TYP_CD2: 'C' }), 'mixedUse');
  assert.equal(reason({ PR_TYP_CD3: 'A' }), 'mixedUse');
  assert.equal(reason({ PR_TYP_CD4: 'F ' }), 'mixedUse');
  assert.throws(() => classify(row({ PR_TYP_CD2: 'QQ' })), /property type code "QQ"/, 'an unknown secondary code throws too');
});

test('the county’s sale codes: only warranty deeds and contracts for deed are sales here', () => {
  assert.equal(reason({ SALE_CODE: 'R' }), 'excludedFromRatioStudy');
  assert.equal(reason({ SALE_CODE: 'M' }), 'multiParcel');
  assert.equal(reason({ SALE_CODE: 'L' }), 'vacantLand');
  assert.equal(reason({ SALE_CODE: 'Q' }), 'quitClaim');
  assert.equal(reason({ SALE_CODE: 'P' }), 'probate');
  assert.equal(reason({ SALE_CODE: 'O' }), 'otherDeed');
  assert.equal(reason({ SALE_CODE: ' ' }), 'noSaleCode');
  assert.equal(reason({ SALE_CODE: null }), 'noSaleCode');
  assert.throws(() => classify(row({ SALE_CODE: 'X', SALE_CODE_NAME: 'SHERIFF' })), /sale code "X" \(SHERIFF\)/);
  // A non-home is dropped for its type before its sale code is read.
  assert.equal(reason({ PR_TYP_CD1: 'A', SALE_CODE: 'R' }), 'nonResidential');
  assert.deepEqual(Object.keys(SALE_CODES).filter(k => SALE_CODES[k] === null).sort(), ['C', 'W']);
});

test('prices: under $10,000 is nominal, $20 million or more a recording error', () => {
  assert.equal(reason({ SALE_PRICE: 9999 }), 'nominal');
  assert.equal(reason({ SALE_PRICE: 0 }), 'nominal');
  assert.equal(reason({ SALE_PRICE: null }), 'nominal');
  assert.equal(classify(row({ SALE_PRICE: 10000 })).sale.price, 10000);
  assert.equal(reason({ SALE_PRICE: 20_000_000 }), 'implausiblePrice');
  assert.equal(classify(row({ SALE_PRICE: 19_999_999 })).sale.price, 19_999_999);
});

test('location: the county’s published parcel centroid, inside the county’s extent, or nothing', () => {
  assert.equal(reason({ LAT: null }), 'noLocation');
  assert.equal(reason({ LON: 0, LAT: 0 }), 'noLocation');
  assert.equal(reason({ LAT: 44.95, LON: 93.29 }), 'noLocation', 'a lost minus sign');
  assert.equal(reason({ LAT: -93.29, LON: 44.95 }), 'noLocation', 'swapped');
  assert.equal(reason({ LAT: 44.95, LON: -92.3 }), 'noLocation', 'east of the county (Wisconsin)');
});

test('month precision: a sale is dated the 1st of its month; a malformed month is a bad date', () => {
  assert.equal(isoOf('202607'), '2026-07-01');
  assert.equal(classify(row({ SALE_DATE: '202512' })).sale.date, '2025-12-01');
  for (const d of ['2026', '202613', '202600', '2026-07', '', null, '1899-12']) assert.equal(reason({ SALE_DATE: d }), 'badDate', String(d));
  assert.ok(isYm('190001') && !isYm('189912'));
  // Future months are the build's to drop (futureDate), not the source's.
  assert.equal(classify(row({ SALE_DATE: '202712' })).sale.date, '2027-12-01');
  // This month is Minneapolis's: 03:00 UTC on 1 Oct is still 30 Sep there.
  assert.equal(thisMonth(Date.parse('2026-10-01T03:00:00Z')), '202609');
  assert.equal(thisMonth(Date.parse('2026-10-01T06:00:00Z')), '202610');
});

test('reduceSales counts every row exactly once and drops a parcel read twice', () => {
  const dup = row();
  const rows = [
    row(), dup, { ...dup, OBJECTID: 9999 }, row({ SALE_CODE: 'C', PR_TYP_CD1: 'Y' }),
    row({ SALE_DATE: 'x' }), row({ PR_TYP_CD1: 'A' }), row({ PR_TYP_CD1: 'XM' }), row({ PR_TYP_CD1: 'XC' }), row({ PR_TYP_CD2: 'C' }),
    row({ SALE_CODE: 'R' }), row({ SALE_CODE: 'M' }), row({ SALE_CODE: 'L' }), row({ SALE_CODE: 'Q' }), row({ SALE_CODE: 'P' }),
    row({ SALE_CODE: 'O' }), row({ SALE_CODE: '' }), row({ SALE_PRICE: 500 }), row({ SALE_PRICE: 3e8 }), row({ LAT: null }),
  ];
  const { sales, dropped, count } = reduceSales(rows);
  assert.deepEqual(Object.keys(dropped), DROP_REASONS);
  assert.equal(sales.length, 3);
  assert.deepEqual(count, { 202605: 3 });
  for (const k of DROP_REASONS) assert.equal(dropped[k], 1, k);
  assert.equal(sales.length + Object.values(dropped).reduce((a, b) => a + b, 0), rows.length);
  // The build counts these itself and refuses a source that does too.
  for (const k of ORCH_DROPS) assert.ok(!(k in dropped), k);
  // Nothing that identifies a parcel survives into a sale: no PID, no owner, no address.
  for (const s of sales) assert.deepEqual(Object.keys(s).sort(), ['date', 'lat', 'lng', 'price', 'type']);
});

test('rows are read from far enough back for the window and for the year-earlier months the completeness test needs', () => {
  assert.equal(readFrom('202608'), '202505');
  assert.equal(readFrom('202608', 24), '202405');
  assert.equal(readFrom('202602'), '202411', 'across a year');
});

test('complete through: the month before the newest, stepped back while it holds under 80% of a year earlier', () => {
  const count = { 202507: 1188, 202506: 1355, 202505: 1225, 202607: 1388, 202606: 1621, 202605: 1302, 202608: 682 };
  assert.deepEqual(completeThrough('202608', count), { through: '2026-07', steps: 0 });
  assert.deepEqual(completeThrough('202608', { ...count, 202607: 900 }), { through: '2026-06', steps: 1 }, '900 of 1,188 is 76%');
  assert.deepEqual(completeThrough('202608', { ...count, 202607: 951 }), { through: '2026-07', steps: 0 }, '951 of 1,188 is 80%');
  assert.deepEqual(completeThrough('202608', { ...count, 202607: 10, 202606: 10 }), { through: '2026-05', steps: 2 });
  assert.throws(() => completeThrough('202608', { ...count, 202607: 10, 202606: 10, 202605: 10 }), /looks incomplete/);
  assert.throws(() => completeThrough('202608', { 202607: 1388 }), /no kept sales in 202507/);
  assert.deepEqual(completeThrough('202601', { 202412: 786, 202512: 921 }), { through: '2025-12', steps: 0 }, 'across a year');
});

test('the build, given `through`, ends the window there, whatever the part-recorded newest month holds', () => {
  const { months, lagMonths } = src.meta.window;
  // The Sept 2026 extract: newest sales dated 2026-08-01, complete through July.
  assert.deepEqual(saleWindow({ latest: '2026-08-01', months, lagMonths, through: '2026-07' }), { from: '2025-08', to: '2026-07', span: 'Aug 2025 – Jul 2026' });
  // Without `through` a month dated the 1st is never complete on its own date:
  // the same window, and the same when a sale is dated in the current month.
  assert.equal(saleWindow({ latest: '2026-08-01', months, lagMonths }).to, '2026-07');
  assert.equal(saleWindow({ latest: '2026-09-01', months, lagMonths, through: '2026-07' }).to, '2026-07');
  // A stepped-back `through` moves the window back.
  assert.equal(saleWindow({ latest: '2026-08-01', months, lagMonths, through: '2026-06' }).from, '2025-07');
});

test('the module declares a point-sales source for Minneapolis whose meta meets the contract', () => {
  assert.equal(src.id, 'hennepin-sales');
  assert.equal(src.kind, 'point-sales');
  assert.deepEqual(src.regions, ['minneapolis']);
  assert.equal(src.geometry, 'acs-tract');
  assert.equal(src.cadence, 'monthly');
  assert.deepEqual(src.meta.window, { months: 12, by: 'sale', lagMonths: 0 });
  assert.equal(src.meta.colourMinN, 10);
  assert.equal(src.meta.metric, 'Median sale price');
  assert.equal(src.meta.period, undefined, 'the build states the period from the window it finds');
  assert.deepEqual(metaProblems(src.meta, 'point-sales'), []);
  // No note or attribution line reads like a single sale's detail.
  assert.deepEqual(entryProblems(src.id, { ...src.meta, kind: 'point-sales' }), []);
  assert.ok(src.meta.notes.some(n => /most recent sale of each property/.test(n)), 'the last-sale limit is stated');
  assert.ok(src.meta.notes.some(n => /month of each sale/.test(n)), 'month precision is stated');
});

// ── the fetch, against a fake gis.hennepin.us (no network) ─────────────────
// Findings of the Sept 2026 review: a read cut short (empty pages from row
// 20,000 on) passed the fetch, the build and verify with 12,514 of 17,100
// sales, and one transient error cost the month.
import { fetchSales, saleRows, timing } from '../sources/hennepin-sales.mjs';

const LAYER = 'https://gis.hennepin.us/arcgis/rest/services/HennepinData/LAND_PROPERTY/MapServer/1';
// 600 kept house sales a month from May 2025 to Jul 2026, and a part-recorded
// Aug 2026 (300): what the county's extract looked like in Sept 2026.
const months = [];
for (let y = 2025, m = 5; y * 100 + m <= 202608; m === 12 ? (y++, m = 1) : m++) months.push(`${y}${String(m).padStart(2, '0')}`);
const LAYER_ROWS = months.flatMap((ym, k) => Array.from({ length: ym === '202608' ? 300 : 600 }, (_, i) => row({
  OBJECTID: k * 1000 + i + 1, PID: String(2702924100000 + k * 1000 + i), SALE_DATE: ym, SALE_PRICE: 300_000 + (i % 200) * 1000,
})));

function fakeCtx(serve, { frozen = false } = {}) {
  const seen = new Map();
  const ctx = {
    frozen, log: () => {}, warn: () => {}, provenance: [], discarded: [], asked: [],
    regions: { minneapolis: { juris: ['US-MN'] } },
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
const params = url => Object.fromEntries(new URL(url).searchParams);
// The honest layer (2,000 rows a page); `tweak(url, n, answer)` may change any answer.
const layer = (rows = LAYER_ROWS, tweak = (u, n, a) => a) => (url, n) => {
  if (!url.startsWith(`${LAYER}/query`)) throw new Error(`unexpected URL ${url}`);
  const p = params(url);
  const from = (p.where.match(/SALE_DATE >= '(\d{6})'/) || [])[1];
  const hit = rows.filter(r => !from || r.SALE_DATE >= from);
  let a;
  if (p.outStatistics) a = { features: [{ attributes: { newest: rows.reduce((m, r) => (r.SALE_DATE > m ? r.SALE_DATE : m), '') } }] };
  else if (p.returnCountOnly) a = { count: hit.length };
  else { const off = +p.resultOffset, k = +p.resultRecordCount; a = { features: hit.slice(off, off + k).map(attributes => ({ attributes })), exceededTransferLimit: off + k < hit.length }; }
  return tweak(url, n, a);
};
const quick = t => { const was = { ...timing }; timing.retryMs = 0; t.after(() => Object.assign(timing, was)); };
// The first `times` reads (each starts with the count) end with an empty
// page at row 4,000.
const cutShort = times => { let reads = 0; return (url, n, a) => {
  if (params(url).returnCountOnly) reads++;
  return +params(url).resultOffset >= 4000 && reads <= times ? { ...a, features: [], exceededTransferLimit: false } : a;
}; };

test('fetch: every row the layer counts is read, and the layer is one upstream record naming no parcel', async t => {
  quick(t);
  const ctx = fakeCtx(layer());
  const r = await fetchSales(ctx, { today: '202609' });
  assert.equal(r.through, '2026-07');
  assert.equal(r.sales.length + Object.values(r.dropped).reduce((a, b) => a + b, 0), LAYER_ROWS.length);
  assert.equal(ctx.provenance.length, 1);
  assert.equal(ctx.provenance[0].url, LAYER);
  assert.equal(ctx.provenance[0].where, "SALE_DATE >= '202505'");
  const entry = { kind: 'point-sales', ...src.meta, upstream: ctx.provenance.map(({ cached, ...p }) => p) };
  assert.deepEqual(entryProblems('hennepin-sales', entry), []);
});

test('fetch: a read cut short is caught against the layer’s own count, read once more, then fails the source', async t => {
  quick(t);
  // Once: the second read is whole.
  const once = fakeCtx(layer(LAYER_ROWS, cutShort(1)));
  const rows = await saleRows(once, '202505');
  assert.equal(rows.length, LAYER_ROWS.length);
  assert.ok(once.discarded.some(f => f.startsWith('hennepin-sales-count-')), 'the count is asked afresh too');
  assert.equal(once.provenance.length, 1, 'one record, for the read that was whole');
  // Every time: the source fails (and its build keeps the published tiles).
  const always = fakeCtx(layer(LAYER_ROWS, cutShort(9)));
  await assert.rejects(fetchSales(always, { today: '202609' }), /read 4000 rows \(4000 distinct\) but the layer counts 9300/);
  // Under --frozen it is not read again: the cache cannot change.
  const frozen = fakeCtx(layer(LAYER_ROWS, cutShort(1)), { frozen: true });
  await assert.rejects(saleRows(frozen, '202505'), /but the layer counts/);
  assert.equal(frozen.asked.filter(u => params(u).returnCountOnly).length, 1);
  // Overlapping pages (a server ignoring the offset) are caught the same way.
  const overlap = fakeCtx(layer(LAYER_ROWS, (u, n, a) => (params(u).resultOffset === '2000' ? layer()(u.replace('resultOffset=2000', 'resultOffset=0'), n) : a)));
  await assert.rejects(saleRows(overlap, '202505'), /distinct/);
});

test('fetch: one error answer or failed request is asked once more after a pause', async t => {
  quick(t);
  const err = fakeCtx(layer(LAYER_ROWS, (u, n, a) => (params(u).resultOffset === '6000' && n === 0 ? { error: { code: 500, message: 'Unable to complete operation.' } } : a)));
  const r = await fetchSales(err, { today: '202609' });
  assert.ok(r.sales.length > 6000);
  assert.equal(err.discarded.length, 1);
  const net = fakeCtx(layer(LAYER_ROWS, (u, n, a) => (params(u).outStatistics && n === 0 ? new Error('hennepin-sales-newest.json: no URL answered (query: HTTP 502)') : a)));
  assert.ok((await fetchSales(net, { today: '202609' })).sales.length > 6000);
  const twice = fakeCtx(layer(LAYER_ROWS, (u, n, a) => (params(u).resultOffset === '6000' ? '<html>blocked</html>' : a)));
  await assert.rejects(fetchSales(twice, { today: '202609' }), /not JSON/);
});
