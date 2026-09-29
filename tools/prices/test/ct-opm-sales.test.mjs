// node --test tools/prices/test/*.test.mjs
// The Connecticut OPM sales filter on hand-made rows: which rows count as an
// arm's-length residential sale in the window, and the reason each other row
// is dropped. No network: the own-town check is a stand-in.
import test from 'node:test';
import assert from 'node:assert/strict';
import src, { classify, windowFor, periodOf, vintageOf, nonUseCode } from '../sources/ct-opm-sales.mjs';

const W = windowFor(2024, 12);
// Hartford's own-town stand-in: anything east of the river (lng > -72.66) is
// "East Hartford", so a Hartford row placed there is outside its own town.
const inTown = (town, lat, lng) => (town === 'Hartford' ? lng <= -72.66 : lng > -72.66);
const row = over => ({
  serialnumber: 240001, listyear: '2024', daterecorded: '2025-03-14T00:00:00.000', town: 'Hartford',
  saleamount: '312000.00', propertytype: 'Residential', residentialtype: 'Two Family', nonusecode: null,
  geo_coordinates: { type: 'Point', coordinates: [-72.6851, 41.7637] }, ...over,
});

test('windowFor: a grand-list year runs 1 Oct to 30 Sep, by date recorded', () => {
  assert.deepEqual(windowFor(2024, 12), { years: [2024], from: '2024-10-01', to: '2025-09-30' });
  assert.deepEqual(windowFor(2024, 24), { years: [2023, 2024], from: '2023-10-01', to: '2025-09-30' });
  assert.throws(() => windowFor(2024, 18), /whole grand-list years/);
  assert.equal(periodOf(W), 'Sales recorded Oct 2024 – Sep 2025');
  assert.equal(vintageOf(W), '2024-10..2025-09');
});

test('a usable residential sale is kept, with only lat, lng, price, date and type', () => {
  const r = classify(row(), W, inTown);
  assert.deepEqual(r, { sale: { lat: 41.7637, lng: -72.6851, price: 312000, date: '2025-03-14', type: '2-4 family' } });
  assert.equal(classify(row({ residentialtype: 'Single Family' }), W, inTown).sale.type, 'single family');
  assert.equal(classify(row({ residentialtype: 'Condo', saleamount: 95000 }), W, inTown).sale.type, 'condo');
  assert.equal(classify(row({ residentialtype: 'Four Family' }), W, inTown).sale.type, '2-4 family');
  // A blank code may come as '' or whitespace as well as null.
  assert.ok(classify(row({ nonusecode: '  ' }), W, inTown).sale);
});

test('the list year is inclusive at both ends; a typo year or an impossible day is a bad date, never repaired', () => {
  assert.ok(classify(row({ daterecorded: '2024-10-01T00:00:00.000' }), W, inTown).sale);
  assert.ok(classify(row({ daterecorded: '2025-09-30T00:00:00.000' }), W, inTown).sale);
  // Filed under GL2024 but recorded outside it.
  assert.equal(classify(row({ daterecorded: '2024-09-30T00:00:00.000' }), W, inTown).drop, 'outsideListYear');
  assert.equal(classify(row({ daterecorded: '2025-10-01T00:00:00.000' }), W, inTown).drop, 'outsideListYear');
  assert.equal(classify(row({ daterecorded: '0025-06-23T00:00:00.000' }), W, inTown).drop, 'badDate');
  assert.equal(classify(row({ daterecorded: '2025-02-30T00:00:00.000' }), W, inTown).drop, 'badDate');
  assert.equal(classify(row({ daterecorded: undefined }), W, inTown).drop, 'badDate');
});

test('non-residential types are dropped; an unknown type throws (format drift)', () => {
  for (const pt of ['Apartments', 'Commercial', 'Industrial', 'Vacant Land', 'Public Utility']) {
    assert.equal(classify(row({ propertytype: pt, residentialtype: undefined }), W, inTown).drop, 'nonResidential', pt);
  }
  assert.throws(() => classify(row({ propertytype: 'Mixed Use' }), W, inTown), /property type "Mixed Use"/);
  assert.throws(() => classify(row({ residentialtype: 'Five Family' }), W, inTown), /residential type "Five Family"/);
  assert.throws(() => classify(row({ residentialtype: undefined }), W, inTown), /residential type/);
});

test('any non-use code excludes a sale; party and price codes count as non-arm\'s-length', () => {
  assert.deepEqual(classify(row({ nonusecode: '01 - Family' }), W, inTown), { drop: 'nonArmsLength', code: '01' });
  assert.deepEqual(classify(row({ nonusecode: '25 - Other' }), W, inTown), { drop: 'nonArmsLength', code: '25' });
  assert.deepEqual(classify(row({ nonusecode: '14 - Foreclosure' }), W, inTown), { drop: 'nonArmsLength', code: '14' });
  // Codes that describe the assessment, not the parties, are excluded too,
  // but counted apart: they do not say the sale was not at arm's length.
  assert.deepEqual(classify(row({ nonusecode: '07 - Change in Property' }), W, inTown), { drop: 'assessmentCode', code: '07' });
  assert.deepEqual(classify(row({ nonusecode: '27 - CRUMBLING FOUNDATION ASSESSMENT REDUCTION' }), W, inTown), { drop: 'assessmentCode', code: '27' });
  assert.equal(nonUseCode('13 - Bankrupcy'), '13');
  assert.equal(nonUseCode('7'), '07');
  assert.equal(nonUseCode('see remarks'), 'other');
  assert.equal(nonUseCode(null), '');
});

test('location: the published point only; none, or one outside the sale\'s own town, is dropped', () => {
  assert.equal(classify(row({ geo_coordinates: undefined }), W, inTown).drop, 'noLocation');
  assert.equal(classify(row({ geo_coordinates: { type: 'Point', coordinates: [] } }), W, inTown).drop, 'noLocation');
  // A Hartford sale geocoded onto the same-named street in East Hartford.
  assert.equal(classify(row({ geo_coordinates: { type: 'Point', coordinates: [-72.599, 41.7486] } }), W, inTown).drop, 'outsideOwnTown');
});

test('a price below OPM\'s own $2,000 floor, or not a number, is a broken row', () => {
  assert.equal(classify(row({ saleamount: '1500' }), W, inTown).drop, 'badPrice');
  assert.equal(classify(row({ saleamount: 'n/a' }), W, inTown).drop, 'badPrice');
  assert.ok(classify(row({ saleamount: '2000' }), W, inTown).sale);
});

test('the module declares a point-sales source for Hartford on acs-tract tracts', () => {
  assert.equal(src.id, 'ct-opm-sales');
  assert.equal(src.kind, 'point-sales');
  assert.deepEqual(src.regions, ['hartford']);
  assert.equal(src.geometry, 'acs-tract');
  assert.equal(src.meta.metric, 'Median sale price');
  assert.equal(src.meta.colourMinN, 10);
  assert.deepEqual(src.meta.window, { months: 12, by: 'recording' });
  assert.equal(src.meta.period, undefined, 'the build states the period from the window it finds');
});
