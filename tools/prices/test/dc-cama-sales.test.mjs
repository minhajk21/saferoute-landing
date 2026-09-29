// node --test tools/prices/test/*.test.mjs
// DC recorded sales (sources/dc-cama-sales.mjs): which rows count as a home
// sale, that every row is counted exactly once, and the completeness cutoff
// it hands the build. Hand-made rows only; nothing here touches the network.
import test from 'node:test';
import assert from 'node:assert/strict';
import src, { classify, reduceSales, completeThrough, readFrom, localDate, addressIdsOf, RESIDENTIAL, DROP_REASONS } from '../sources/dc-cama-sales.mjs';
import { metaProblems } from '../lib/schema.mjs';

const roll = new Map([
  ['0013    2083', { use: '017', addressIds: ['226143'] }],             // vertical condo
  ['5688    0807', { use: '012', addressIds: ['47878'] }],              // detached house
  ['5215    0034', { use: '024', addressIds: ['288706'] }],             // conversion, fewer than 5 units
  ['0100    0010', { use: '022', addressIds: ['111'] }],                // elevator apartment building
  ['0100    2001', { use: '018', addressIds: ['111'] }],                // condo garage space
  ['0200    0020', { use: '011', addressIds: [] }],                     // row house with no MAR address
  ['0300    0030', { use: '011', addressIds: ['999', '47878'] }],       // first address has no point
  ['0400    0040', { use: '013', addressIds: ['424242'] }],             // address id with no point
]);
const points = new Map([['226143', { lat: 38.9, lng: -77.03 }], ['47878', { lat: 38.95, lng: -77.08 }], ['288706', { lat: 38.88, lng: -76.99 }], ['111', { lat: 38.91, lng: -77.02 }]]);
const lookups = { roll, points };
const row = (over = {}) => ({ ssl: '5688    0807', date: '2026-03-15', price: 850_000, qualified: 'Q', code: '01', ...over });
const reason = over => classify(row(over), lookups).drop;

test('a qualified arm’s-length sale of a house is kept, at its address point, with only the five build-time fields', () => {
  const c = classify(row(), lookups);
  assert.deepEqual(c, { sale: { lat: 38.95, lng: -77.08, price: 850_000, date: '2026-03-15', type: 'single-family' } });
  assert.equal(classify(row({ ssl: '0013    2083' }), lookups).sale.type, 'condo');
  assert.equal(classify(row({ ssl: '5215    0034' }), lookups).sale.type, '2-4 unit');
  assert.equal(classify(row({ code: '1' }), lookups).sale.type, 'single-family', 'code "1" and "01" are the same code');
});

test('only the assessors’ QUALIFIED flag admits a sale', () => {
  assert.equal(reason({ qualified: 'U' }), 'notQualified');
  assert.equal(reason({ qualified: 'U', code: 'M1' }), 'notQualified', 'multi-parcel sales are never qualified');
  assert.equal(reason({ qualified: null }), 'notQualified');
  assert.equal(reason({ qualified: 'q' }), 'notQualified', 'no case folding: the flag is exactly "Q"');
});

test('qualified but not a home sale: a vacant lot, or a code the metadata does not allow', () => {
  assert.equal(reason({ code: '09' }), 'vacantLot');
  assert.equal(reason({ code: '9' }), 'vacantLot');
  assert.equal(reason({ code: '03' }), 'otherCode');
  assert.equal(reason({ code: null }), 'otherCode');
});

test('prices under $10,000 are nominal', () => {
  assert.equal(reason({ price: 9_000 }), 'nominal');
  assert.equal(reason({ price: 0 }), 'nominal');
  assert.equal(reason({ price: null }), 'nominal');
  assert.equal(classify(row({ price: 10_000 }), lookups).sale.price, 10_000);
});

test('residential by the roll’s current use code only', () => {
  assert.equal(reason({ ssl: '0100    0010' }), 'nonResidential', 'apartment building');
  assert.equal(reason({ ssl: '0100    2001' }), 'nonResidential', 'parking space');
  assert.equal(reason({ ssl: '9999    9999' }), 'notOnTaxRoll');
  for (const c of ['014', '015', '018', '021', '022', '025', '026', '027', '028', '029', '091', '092', '416', '417']) assert.ok(!RESIDENTIAL[c], c);
  for (const c of ['011', '012', '013', '016', '017', '023', '024']) assert.ok(RESIDENTIAL[c], c);
});

test('location is the official join or nothing', () => {
  assert.equal(reason({ ssl: '0200    0020' }), 'noLocation', 'no MAR address on the roll');
  assert.equal(reason({ ssl: '0400    0040' }), 'noLocation', 'address id without an address point');
  assert.deepEqual(classify(row({ ssl: '0300    0030' }), lookups).sale.lat, 38.95, 'a later address of the same property is used');
  assert.deepEqual(addressIdsOf('237616,306561'), ['237616', '306561']);
  assert.deepEqual(addressIdsOf(null), []);
});

test('a row with no date is dropped; windowing and future dates are left to the build', () => {
  assert.equal(reason({ date: null }), 'noDate');
  assert.equal(classify(row({ date: '2027-01-01' }), lookups).sale.date, '2027-01-01', 'the build counts it as futureDate');
  assert.equal(classify(row({ date: '2019-05-01' }), lookups).sale.date, '2019-05-01', 'the build counts it as outOfWindow');
});

test('reduceSales counts every row exactly once and drops repeated sales', () => {
  const rows = [
    row(), row(),                                   // the same sale twice
    row({ price: 900_000 }),                        // same house, same day, another price: a different row
    row({ qualified: 'U' }), row({ code: '09' }), row({ code: '05' }), row({ price: 1 }),
    row({ ssl: '0100    0010' }), row({ ssl: '0200    0020' }), row({ ssl: 'nope' }), row({ date: null }),
  ];
  const { sales, dropped } = reduceSales(rows, lookups);
  assert.deepEqual(Object.keys(dropped), DROP_REASONS);
  assert.equal(sales.length, 2);
  assert.deepEqual(dropped, { noDate: 1, notQualified: 1, vacantLot: 1, otherCode: 1, nominal: 1, duplicate: 1, notOnTaxRoll: 1, nonResidential: 1, noLocation: 1 });
  // The build counts these itself and refuses a source that does too.
  for (const k of ['outOfWindow', 'futureDate', 'outsideTracts', 'outsideCovers']) assert.ok(!(k in dropped), k);
  assert.equal(sales.length + Object.values(dropped).reduce((a, b) => a + b, 0), rows.length);
  // Nothing that identifies a property survives into a sale.
  for (const s of sales) assert.deepEqual(Object.keys(s).sort(), ['date', 'lat', 'lng', 'price', 'type']);
});

test('complete through: the last month that ended 21 days before the newest sale', () => {
  assert.equal(completeThrough('2026-09-21'), '2026-08');
  assert.equal(completeThrough('2026-09-20'), '2026-07', 'August ended only 20 days before');
  assert.equal(completeThrough('2026-10-01'), '2026-08', 'September has only just ended');
  assert.equal(completeThrough('2026-03-21'), '2026-02');
  assert.equal(completeThrough('2024-03-21'), '2024-02', 'leap year: 29 Feb is 21 days before');
  assert.equal(completeThrough('2026-01-21'), '2025-12', 'across a year');
  assert.throws(() => completeThrough('21/09/2026'));
});

test('rows are read from the first day the build’s window can reach', () => {
  assert.equal(readFrom('2026-08'), '2025-09-01');
  assert.equal(readFrom('2026-08', 24), '2024-09-01');
  assert.equal(readFrom('2026-08', 12, 1), '2025-08-01');
  assert.equal(readFrom('2026-01'), '2025-02-01');
});

test('SALE_DATE is midnight in Washington: the calendar date survives either UTC offset', () => {
  assert.equal(localDate(Date.parse('2026-09-21T04:00:00Z')), '2026-09-21');   // EDT
  assert.equal(localDate(Date.parse('2026-01-05T05:00:00Z')), '2026-01-05');   // EST
  assert.equal(localDate(NaN), null);
});

test('the module declares a point-sales source whose meta meets the contract', () => {
  assert.equal(src.id, 'dc-cama-sales');
  assert.equal(src.kind, 'point-sales');
  assert.deepEqual(src.regions, ['dc']);
  assert.equal(src.geometry, 'acs-tract');
  assert.equal(src.cadence, 'monthly');
  assert.deepEqual(src.meta.window, { months: 12, by: 'recording', lagMonths: 0 });
  assert.equal(src.meta.colourMinN, 10);
  assert.equal(src.meta.metric, 'Median sale price');
  assert.deepEqual(metaProblems(src.meta, 'point-sales'), []);
});
