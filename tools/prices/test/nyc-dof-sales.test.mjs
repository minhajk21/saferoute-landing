// node --test tools/prices/test/*.test.mjs
// nyc-dof-sales: which DOF rows become sales, and why each other row is
// dropped, on hand-made rows (no network). The filter is the honesty of the
// NYC layer: a $0 family transfer, a rental building, a deed that repeats one
// price over several lots, or a sale no official table can place must never
// reach a tract median, and every drop must be counted. (The window is the
// build's: lib/sales.mjs, tested with the orchestrator.)
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  saleType, bblOf, normBbl, addMonths, windowFor, excelDate, saleRow,
  multiPropertyRows, filterSales, readWorkbook, WINDOW_MONTHS, LAG_MONTHS,
} from '../sources/nyc-dof-sales.mjs';
import src from '../sources/nyc-dof-sales.mjs';
import { sheetRecords } from '../../schools/ratings/_us.mjs';

// A sale row as the filter reads it; block/date/price vary per case.
const row = (o = {}) => ({ boro: 3, block: 100, lot: 1, cls: 'A1', price: 750000, date: '2026-03-02', ...o });
const at = () => [40.68, -73.95];

test('building classes: the DOF codes that make a home sale, and those that do not', () => {
  for (const c of ['A0', 'A5', 'A9', 'S0', 'S1', 'B1', 'B9', 'S2', 'C0']) assert.equal(saleType(c), '1-3 family', c);
  for (const c of ['R1', 'R2', 'R3', 'R4', 'R6', ' r4 ']) assert.equal(saleType(c), 'condo', c);
  for (const c of ['C6', 'C8', 'D0', 'D4', 'R9']) assert.equal(saleType(c), 'coop', c);
  // Rentals, 4+ family, commercial condo units, condo billing/parking/storage, land, offices.
  for (const c of ['C1', 'C3', 'D1', 'S3', 'S4', 'R7', 'R8', 'RR', 'RG', 'RS', 'R5', 'V0', 'O4', '', null]) assert.equal(saleType(c), null, String(c));
});

test('BBLs, month arithmetic, the window and Excel dates', () => {
  assert.equal(bblOf(1, 372, 9), '1003720009');
  assert.equal(bblOf('4', '11431', '7501'), '4114317501');
  assert.equal(bblOf(6, 1, 1), null);
  assert.equal(normBbl('4114317501.00000000'), '4114317501');
  assert.equal(normBbl('1000010010'), '1000010010');
  assert.equal(normBbl(''), null);
  assert.equal(normBbl('6000010001'), null);
  assert.equal(addMonths('2026-01', -1), '2025-12');
  assert.equal(addMonths('2025-12', 1), '2026-01');
  assert.equal(addMonths('2026-08', -24), '2024-08');
  // DOF's rolling file of Sep 2026 ends in Aug 2026, which is still being
  // recorded: the window ends a month earlier.
  assert.deepEqual(windowFor('2026-08', 24, 1), { from: '2024-08', to: '2026-07' });
  assert.deepEqual(windowFor('2026-08', 12, 0), { from: '2025-09', to: '2026-08' });
  assert.deepEqual(windowFor('2026-08'), windowFor('2026-08', WINDOW_MONTHS, LAG_MONTHS));
  assert.equal(excelDate(45658), '2025-01-01');
  assert.equal(excelDate('45900'), '2025-08-31');
});

test('saleRow reads both parts and refuses a row it cannot read', () => {
  assert.deepEqual(saleRow({ borough: '1', block: '376', lot: '41', cls: 'c4 ', price: '540000', date: '2025-12-17T00:00:00.000' }, 't'),
    { boro: 1, block: 376, lot: 41, cls: 'C4', price: 540000, date: '2025-12-17' });
  assert.throws(() => saleRow({ borough: '1', block: '376', lot: '41', cls: 'A1', price: '540000', date: '' }, 't'), /not a sale row/);
  assert.throws(() => saleRow({ borough: '9', block: '376', lot: '41', cls: 'A1', price: '1', date: '2025-01-01' }, 't'), /not a sale row/);
  assert.throws(() => saleRow({ borough: '1', block: '376', lot: '41', cls: 'A1', price: '', date: '2025-01-01' }, 't'), /not a sale row/);
});

test('filter: nominal prices, DOF\'s house floor, non-homes and missing locations', () => {
  const rows = [
    row({ price: 0 }),                                   // $0: a transfer without consideration
    row({ cls: 'D4', price: 9999, block: 101 }),         // nominal
    row({ cls: 'D4', price: 10000, block: 102 }),        // a $10,000 co-op apartment is a sale
    row({ price: 199999, block: 105 }),                  // a house under DOF's $200,000 floor for 1-3 family homes
    row({ cls: 'B1', price: 25000, block: 106 }),        // a two-family house at $25,000: not a market sale
    row({ price: 200000, block: 110 }),                  // DOF's floor itself is kept
    row({ cls: 'C1', price: 2400000, block: 103 }),      // a rental building
    row({ cls: 'R8', price: 900000, block: 104 }),       // a commercial condo unit
    row({ block: 107, lot: 99 }),                        // no official location
    row({ cls: 'D4', price: 425000, block: 108 }),       // a co-op apartment
    row({ cls: 'R4', price: 1250000, block: 109, lot: 1005 }),
  ];
  const { sales, dropped } = filterSales(rows, { locate: r => (r.lot === 99 ? null : at()) });
  assert.deepEqual(dropped, { nonResidential: 2, nominalPrice: 2, houseUnderDofFloor: 2, multiProperty: 0, noLocation: 1 });
  assert.deepEqual(sales.map(s => [s.price, s.type]), [[10000, 'coop'], [200000, '1-3 family'], [425000, 'coop'], [1250000, 'condo']]);
  assert.equal(sales.length + Object.values(dropped).reduce((a, b) => a + b, 0), rows.length, 'every row is kept or counted once');
  // A sale carries nothing that could identify the lot: no BBL, block, lot or address.
  for (const s of sales) assert.deepEqual(Object.keys(s).sort(), ['date', 'lat', 'lng', 'price', 'type']);
});

test('filter: one price on one date for several properties is dropped, chance coincidences are not', () => {
  const rows = [
    // Two condo units in one tax block, one deed: the total price on both rows.
    row({ cls: 'R4', block: 392, lot: 1033, price: 1700000, date: '2026-06-23' }),
    row({ cls: 'R4', block: 392, lot: 1034, price: 1700000, date: '2026-06-23' }),
    // A condo sold with its parking unit: the home's row is dropped (the price
    // is not its own); the parking row is not a home at all.
    row({ cls: 'R4', block: 794, lot: 1101, price: 2825000, date: '2026-01-22' }),
    row({ cls: 'RG', block: 794, lot: 1146, price: 2825000, date: '2026-01-22' }),
    // Two co-op apartments in one building: same lot, same date, same price.
    row({ cls: 'C6', block: 401, lot: 12, price: 700000, date: '2026-03-02' }),
    row({ cls: 'C6', block: 401, lot: 12, price: 700000, date: '2026-03-02' }),
    // A co-op portfolio over several blocks at an odd price.
    row({ cls: 'C6', block: 742, lot: 60, price: 1056750, date: '2026-06-29' }),
    row({ cls: 'D4', block: 622, lot: 41, price: 1056750, date: '2026-06-29' }),
    // Unrelated houses in different blocks at a round price on one day: kept.
    row({ block: 500, price: 650000, date: '2026-04-15' }),
    row({ block: 900, price: 650000, date: '2026-04-15' }),
    // The same odd price on one day in two different boroughs: kept.
    row({ boro: 3, block: 1200, price: 812345, date: '2026-05-05' }),
    row({ boro: 4, block: 1200, price: 812345, date: '2026-05-05' }),
    // Two $0 transfers on one block and day are nominal, not a multi-property sale.
    row({ block: 77, lot: 1, price: 0, date: '2026-02-02' }),
    row({ block: 77, lot: 2, price: 0, date: '2026-02-02' }),
    // One price, one block, different days: two sales.
    row({ block: 1300, lot: 1, price: 999000, date: '2026-02-02' }),
    row({ block: 1300, lot: 2, price: 999000, date: '2026-02-03' }),
  ];
  const multi = multiPropertyRows(rows);
  assert.equal(multi.size, 8, 'the four same-deed groups, all their rows');
  const { sales, dropped } = filterSales(rows, { locate: at });
  assert.deepEqual(dropped, { nonResidential: 1, nominalPrice: 2, houseUnderDofFloor: 0, multiProperty: 7, noLocation: 0 });
  assert.deepEqual(sales.map(s => s.price).sort(), [650000, 650000, 812345, 812345, 999000, 999000]);
});

test('readWorkbook: DOF annualized layout read, a changed layout refused', () => {
  const header = ['BOROUGH', 'NEIGHBORHOOD', 'BUILDING CLASS CATEGORY', 'BLOCK', 'LOT', 'ADDRESS', 'BUILDING CLASS\r\nAT TIME OF SALE', 'SALE PRICE', 'SALE DATE'];
  const sale = (b, blk, cls, price, serial) => [String(b), 'X', '01 ONE FAMILY DWELLINGS', String(blk), '1', '1 MAIN ST', cls, String(price), String(serial)];
  const sheet = (title, rows) => [[title], ['Building Class Category is based on Building Class at Time of Sale.'], [], header, ...rows];
  const ctxOf = rows => ({ readers: { xlsx: () => ({ rows: () => rows }), sheetRecords } });
  const title = 'All Sales From January 2025 - December 2025. Property Tax System (PTS) data as of 05/04/2026.';
  const many = Array.from({ length: 1200 }, (_, i) => sale(5, 1000 + i, 'A1', 700000, 45700));
  const got = readWorkbook(ctxOf(sheet(title, many)), null, 2025, 5, 'f.xlsx');
  assert.equal(got.asOf, '2026-05-04');
  assert.equal(got.rows.length, 1200);
  assert.deepEqual(got.rows[0], { boro: 5, block: 1000, lot: 1, cls: 'A1', price: 700000, date: excelDate(45700) });
  assert.equal(Object.keys(got.rows[0]).includes('address'), false, 'the address is read past, never kept');
  assert.throws(() => readWorkbook(ctxOf(sheet(title.replace(/2025/g, '2024'), many)), null, 2025, 5, 'f.xlsx'), /does not say it holds/);
  assert.throws(() => readWorkbook(ctxOf(sheet(title, [...many, sale(3, 1, 'A1', 1, 45700)])), null, 2025, 5, 'f.xlsx'), /not what its name says/);
  assert.throws(() => readWorkbook(ctxOf(sheet(title, [...many, sale(5, 1, 'A1', 1, 46100)])), null, 2025, 5, 'f.xlsx'), /not what its name says/, 'a 2026 date in the 2025 file');
  assert.throws(() => readWorkbook(ctxOf(sheet(title, many).map(r => (r === header ? r.map(h => h.replace('SALE PRICE', 'PRICE')) : r))), null, 2025, 5, 'f.xlsx'), /header row not found|missing column/);
  assert.throws(() => readWorkbook(ctxOf(sheet(title, many.slice(0, 10))), null, 2025, 5, 'f.xlsx'), /only 10 sales/);
});

test('the module declares what the point-sales orchestrator reads', () => {
  assert.equal(src.id, 'nyc-dof-sales');
  assert.equal(src.kind, 'point-sales');
  assert.deepEqual(src.regions, ['nyc']);
  assert.equal(src.geometry, 'acs-tract');
  assert.equal(src.meta.metric, 'Median sale price');
  assert.equal(src.meta.unitNoun, 'sales');
  assert.equal(src.meta.colourMinN, 10);
  assert.deepEqual(src.meta.window, { months: WINDOW_MONTHS, by: 'sale', lagMonths: LAG_MONTHS });
  assert.equal(src.meta.period, undefined, 'the build writes the period from the window it finds');
  assert.match(src.meta.licenceUrl, /^https:\/\//);
  assert.ok(src.meta.notes.some(n => /under \$10,000/.test(n) && /several properties for one price/.test(n)));
  assert.ok(src.meta.notes.some(n => /one-to-three-family homes sold for under \$200,000/.test(n)), 'DOF\'s house floor is stated');
});
