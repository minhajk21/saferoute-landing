// node --test tools/prices/test/*.test.mjs
// Denver recorded sales (tools/prices/parked/denver-sales.mjs): which rows of
// the City's sales table count as a home sale, that every row is counted
// exactly once, and the completeness cutoff it hands the build. The module is
// PARKED (not in sources/, so not in the build) until the City confirms the
// licence (tools/prices/regions.mjs); these tests keep it working meanwhile.
// Hand-made rows only; nothing here touches the network.
import test from 'node:test';
import assert from 'node:assert/strict';
import src, {
  classify, reduceSales, multiParcelReceptions, normalise, completeThrough, readFrom, whereFrom,
  saleDate, receptionDate, schedNum, className, homeType, HOME_CLASSES, OTHER_RESIDENTIAL, DROP_REASONS,
} from '../parked/denver-sales.mjs';
import { saleWindow, ORCH_DROPS } from '../lib/sales.mjs';
import { metaProblems } from '../lib/schema.mjs';

const parcels = new Map([
  ['0005123010000', [39.7392, -104.9903]],   // a house
  ['0002345067067', [39.7520, -104.9990]],   // a condominium unit, at its building
  ['0007001001000', [39.6800, -105.0200]],   // a garage lot sold with a house
]);
// One row as normalise() returns it: a warranty-deed sale of a house.
const row = (over = {}) => ({
  parid: '0005123010000', reception: '2026064653', instrument: 'WD', date: '2026-05-15', recorded: '2026-05-18',
  price: 650_000, cls: 'SFR Grade C', ...over,
});
const lookups = (rows = [row()]) => ({ multi: multiParcelReceptions(rows), parcels });
const reason = over => classify(row(over), lookups()).drop;

test('a warranty-deed sale of a house is kept, at its parcel, with only the five build-time fields', () => {
  assert.deepEqual(classify(row(), lookups()), { sale: { lat: 39.7392, lng: -104.9903, price: 650_000, date: '2026-05-15', type: 'single-family' } });
  assert.equal(classify(row({ instrument: 'SW' }), lookups()).sale.type, 'single-family', 'a special warranty deed counts too');
  assert.equal(classify(row({ parid: '0002345067067', cls: 'RESIDENTIAL-CONDOMINIUM' }), lookups()).sale.type, 'condo');
  assert.equal(classify(row({ cls: 'RESIDENTIAL-ROWHOUSE' }), lookups()).sale.type, 'rowhouse');
  assert.equal(classify(row({ cls: 'RESIDENTIAL-TRIPLEX' }), lookups()).sale.type, '2-3 unit');
  assert.equal(classify(row({ cls: 'SFR Grade C, D, or E, w/RK' }), lookups()).sale.type, 'single-family');
});

test('only warranty and special warranty deeds: Denver has no arm’s-length flag', () => {
  for (const d of ['QC', 'PR', 'BF', 'TR', 'PT', 'AF', 'CD', '']) assert.equal(reason({ instrument: d }), 'notWarrantyDeed', d || '(blank)');
});

test('transfers under $10,000, or with no price, are nominal', () => {
  assert.equal(reason({ price: 10 }), 'nominal');
  assert.equal(reason({ price: 0 }), 'nominal');
  assert.equal(reason({ price: null }), 'nominal');
  assert.equal(reason({ price: 9_999 }), 'nominal');
  assert.equal(classify(row({ price: 10_000 }), lookups()).sale.price, 10_000);
});

test('homes only, by the class in the table; an unknown residential class throws', () => {
  for (const c of ['RESIDENTIAL-4 TO 8 UNITS', 'RESIDENTIAL-APARTMENT', 'RESIDENTIAL GRACE YEAR', 'RESIDENTIAL CONDOMINIUM', 'RESIDENTIAL', 'RESIDENTIAL-MISC IMPS']) {
    assert.equal(reason({ cls: c }), 'nonResidential', c);
  }
  for (const c of ['VACANT LAND', 'COMMERCIAL-CONDOMINIUM', 'RETAIL W/MIXED USE', 'MH / Minor Structures', '']) assert.equal(reason({ cls: c }), 'nonResidential', c || '(blank)');
  // The table writes this one with two spaces and truncated.
  assert.equal(className('RESIDENTIAL  LAND FOR LAND/ IM'), 'RESIDENTIAL LAND FOR LAND/ IM');
  assert.equal(reason({ cls: 'RESIDENTIAL  LAND FOR LAND/ IM' }), 'nonResidential');
  assert.throws(() => homeType('SFR Grade Z'), /property class "SFR Grade Z"/);
  assert.throws(() => homeType('RESIDENTIAL-QUADPLEX'), /the format changed/);
  for (const c of Object.keys(HOME_CLASSES)) assert.ok(!OTHER_RESIDENTIAL.has(c), c);
});

test('a date that is not real, or a deed recorded before its sale or under another year’s number, is a bad date', () => {
  assert.equal(reason({ date: null }), 'badDate');
  assert.equal(reason({ recorded: null }), 'badDate');
  assert.equal(reason({ recorded: '2026-05-14' }), 'badDate', 'recorded the day before the sale');
  assert.equal(classify(row({ recorded: '2026-05-15' }), lookups()).sale.date, '2026-05-15', 'recorded the same day');
  // A sale dated 30 Dec 2026, recorded "20261230" under a 2025 reception number.
  assert.equal(reason({ date: '2026-12-30', recorded: '2026-12-30', reception: '2025131095' }), 'badDate');
  assert.equal(classify(row({ reception: null }), lookups()).sale.date, '2026-05-15', 'no reception number: nothing to check');
});

test('the table’s date fields: SALE_YEAR + SALE_MONTHDAY, RECEPTION_DATE, and PARID as a schedule number', () => {
  assert.equal(saleDate(2026, 515), '2026-05-15');
  assert.equal(saleDate(2026, 1230), '2026-12-30');
  assert.equal(saleDate(2026, 101), '2026-01-01');
  assert.equal(saleDate(2026, 230), null, '30 February');
  assert.equal(saleDate(2024, 229), '2024-02-29');
  assert.equal(saleDate(2025, 229), null);
  assert.equal(saleDate(2026, 1301), null);
  assert.equal(saleDate(2026, 0), null);
  assert.equal(saleDate(null, 515), null);
  assert.equal(receptionDate(20260518), '2026-05-18');
  assert.equal(receptionDate(50250305), '5025-03-05', 'a real date, if an absurd one: the recorded-before-sale check sees the rest');
  assert.equal(receptionDate(20261332), null);
  assert.equal(receptionDate(null), null);
  assert.equal(schedNum(3122043000), '0003122043000');
  assert.equal(schedNum(227804157157), '0227804157157');
  assert.equal(schedNum(0), null);
  assert.equal(schedNum(1.5), null);
  assert.equal(schedNum(null), null);
});

test('normalise keeps only the fields the filter reads', () => {
  const r = normalise({ OBJECTID: 7, PARID: 5123010000, RECEPTION_NUM: 2026064653, INSTRUMENT: ' wd ', SALE_YEAR: 2026, SALE_MONTHDAY: 515,
    RECEPTION_DATE: 20260518, SALE_PRICE: 650000, D_CLASS_N: 'SFR Grade C', GRANTOR: 'never read', GRANTEE: 'never read' });
  assert.deepEqual(r, { parid: '0005123010000', reception: '2026064653', instrument: 'WD', date: '2026-05-15', recorded: '2026-05-18', price: 650000, cls: 'SFR Grade C' });
});

test('a deed conveying several properties is one price for all of them: every row goes', () => {
  const rows = [
    row(),                                                                                   // the house …
    row({ parid: '0007001001000', cls: 'RESIDENTIAL LAND CONTIGUOUS' }),                     // … and the lot next door, one deed
    row({ reception: '2026070001', parid: '0002345067067', cls: 'RESIDENTIAL-CONDOMINIUM' }),
    row({ reception: '2026070001', parid: '0002345067067', cls: 'RESIDENTIAL-CONDOMINIUM' }), // the same unit twice: a duplicate, not two properties
  ];
  assert.deepEqual([...multiParcelReceptions(rows)], ['2026064653']);
  const { sales, dropped } = reduceSales(rows, { parcels });
  assert.equal(dropped.multiParcel, 1);
  assert.equal(dropped.nonResidential, 1, 'the lot is not a home whatever the deed');
  assert.equal(dropped.duplicate, 1);
  assert.equal(sales.length, 1);
  assert.equal(sales[0].type, 'condo');
});

test('a double closing: the first of two counted sales of one home within 30 days goes, the later stays', () => {
  const rows = [
    row({ reception: '2026050001', date: '2026-05-15', price: 400_000 }),                          // seller → middleman
    row({ reception: '2026050002', date: '2026-05-15', price: 452_000 }),                          // middleman → buyer, same day
    row({ parid: '0002345067067', cls: 'RESIDENTIAL-CONDOMINIUM', reception: '2026020001', date: '2026-02-01', recorded: '2026-02-03', price: 300_000 }),
    row({ parid: '0002345067067', cls: 'RESIDENTIAL-CONDOMINIUM', reception: '2026030001', date: '2026-03-02', recorded: '2026-03-04', price: 320_000 }),   // 29 days on
    row({ parid: '0007001001000', cls: 'SFR Grade B', reception: '2026010001', date: '2026-01-10', recorded: '2026-01-12', price: 500_000 }),
    row({ parid: '0007001001000', cls: 'SFR Grade B', reception: '2026040001', date: '2026-04-10', recorded: '2026-04-12', price: 560_000 }),           // 90 days on: two sales
  ];
  const { sales, dropped } = reduceSales(rows, { parcels });
  assert.equal(dropped.quickResale, 2);
  assert.deepEqual(sales.map(s => s.price), [452_000, 320_000, 500_000, 560_000]);
  // A later deed that is not itself counted (a quitclaim, a nominal price)
  // leaves the sale before it alone.
  const qc = reduceSales([row(), row({ reception: '2026064999', instrument: 'QC', price: 0 })], { parcels });
  assert.equal(qc.dropped.quickResale, 0);
  assert.equal(qc.sales.length, 1);
  // Two same-day sales with no reception number cannot be ordered: both stay.
  const unordered = reduceSales([row({ reception: null, price: 400_000 }), row({ reception: null, price: 452_000 })], { parcels });
  assert.equal(unordered.dropped.quickResale, 0);
});

test('location is the parcel join or nothing', () => {
  assert.equal(reason({ parid: '0009999999000' }), 'noLocation', 'a parcel no longer on the map');
  assert.equal(reason({ parid: null }), 'noLocation');
  assert.equal(classify(row({ parid: '0002345067067', cls: 'RESIDENTIAL-CONDOMINIUM' }), lookups()).sale.lat, 39.752, 'a unit at its building');
});

test('windowing and future dates are left to the build', () => {
  assert.equal(classify(row({ date: '2027-01-02', recorded: '2027-01-05', reception: '2027000123' }), lookups()).sale.date, '2027-01-02', 'the build counts it as futureDate');
  assert.equal(classify(row({ date: '2019-05-01', recorded: '2019-05-03', reception: '2019000123' }), lookups()).sale.date, '2019-05-01', 'the build counts it as outOfWindow');
});

test('reduceSales counts every row exactly once, under the reasons it lists', () => {
  const rows = [
    row(), row({ instrument: 'QC' }), row({ price: 10 }), row({ cls: 'VACANT LAND' }), row({ recorded: '2026-01-01' }),
    row({ parid: '0009999999000', reception: '2026000002' }), row({ parid: '0002345067067', reception: '2026000003', cls: 'RESIDENTIAL-CONDOMINIUM' }),
  ];
  const { sales, dropped } = reduceSales(rows, { parcels });
  assert.deepEqual(Object.keys(dropped), DROP_REASONS);
  assert.deepEqual(dropped, { badDate: 1, notWarrantyDeed: 1, nominal: 1, nonResidential: 1, multiParcel: 0, duplicate: 0, quickResale: 0, noLocation: 1 });
  assert.equal(sales.length, 2);
  assert.equal(sales.length + Object.values(dropped).reduce((a, b) => a + b, 0), rows.length);
  for (const k of ORCH_DROPS) assert.ok(!(k in dropped), `${k} is the build's to count`);
  for (const s of sales) assert.deepEqual(Object.keys(s).sort(), ['date', 'lat', 'lng', 'price', 'type']);
});

test('complete through: the last month that ended at least 75 days before the newest sale', () => {
  assert.equal(completeThrough('2026-09-15'), '2026-06', 'the table of 24 Sep 2026');
  assert.equal(completeThrough('2026-09-13'), '2026-06', '30 June is exactly 75 days before');
  assert.equal(completeThrough('2026-09-12'), '2026-05', 'June ended only 74 days before');
  assert.equal(completeThrough('2026-03-16'), '2025-12', 'across a year');
  assert.equal(completeThrough('2024-05-13'), '2024-01', 'leap year: 28 Feb is not February’s last day');
  assert.equal(completeThrough('2024-05-14'), '2024-02');
  assert.equal(completeThrough('2023-05-14'), '2023-02');
  assert.throws(() => completeThrough('15/09/2026'));
});

test('the build, given `through`, takes the window the module read for', () => {
  const { months, lagMonths } = src.meta.window;
  assert.deepEqual(saleWindow({ latest: '2026-09-15', months, lagMonths, through: completeThrough('2026-09-15') }), { from: '2025-07', to: '2026-06', span: 'Jul 2025 – Jun 2026' });
  // Without it the window would end on August, 60% posted.
  assert.equal(saleWindow({ latest: '2026-09-15', months, lagMonths }).to, '2026-08');
  // Rows are read from two months before the earliest window today allows.
  assert.equal(readFrom('2026-09-29'), '2025-05-01');
  assert.equal(readFrom('2026-09-29', 24), '2024-05-01');
  // 5 Jan 2026: complete through Sep 2025 at best, a window from Oct 2024.
  assert.equal(readFrom('2026-01-05'), '2024-08-01');
  assert.ok(`${saleWindow({ latest: '2026-09-15', months, lagMonths, through: '2026-06' }).from}-01` >= readFrom('2026-09-29'));
  assert.equal(whereFrom('2025-05-01'), 'SALE_YEAR > 2025 OR (SALE_YEAR = 2025 AND SALE_MONTHDAY >= 501)');
  assert.equal(whereFrom('2024-11-01'), 'SALE_YEAR > 2024 OR (SALE_YEAR = 2024 AND SALE_MONTHDAY >= 1101)');
});

test('the module declares a point-sales source for Denver whose meta meets the contract', () => {
  assert.equal(src.id, 'denver-sales');
  assert.equal(src.kind, 'point-sales');
  assert.deepEqual(src.regions, ['denver']);
  assert.equal(src.geometry, 'acs-tract');
  assert.equal(src.cadence, 'monthly');
  assert.deepEqual(src.meta.window, { months: 12, by: 'sale', lagMonths: 0 });
  assert.equal(src.meta.colourMinN, 10);
  assert.equal(src.meta.metric, 'Median sale price');
  assert.equal(src.meta.period, undefined, 'the build states the period from the window it finds');
  assert.equal(src.meta.licenceUrl, 'https://creativecommons.org/licenses/by/3.0/');
  assert.ok(src.meta.attribution[0].includes('City of Denver Open Data Catalog') && src.meta.attribution[0].includes('CC BY 3.0'), 'the credit the catalog asks for');
  assert.deepEqual(metaProblems(src.meta, 'point-sales'), []);
});
