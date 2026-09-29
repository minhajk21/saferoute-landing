// node --test tools/prices/test/*.test.mjs
// The Maryland SDAT sales filter on hand-made rows: which sales segments count
// as an arm's-length residential sale in the window, and the reason every
// other one is dropped. No network.
import test from 'node:test';
import assert from 'node:assert/strict';
import src, {
  windowFor, periodOf, vintageOf, conveyance, landUse, dwellingType, isoDate,
  segmentsOf, classify, dropSharedDeeds, whereClause, JURISDICTIONS,
} from '../sources/md-sdat-sales.mjs';
import { saleWindow, ORCH_DROPS } from '../lib/sales.mjs';

const C1 = 'Private arms-length transfer, Improved (1)';
const C2 = 'Private arms-length transfer, Vacant at time of sale (2)';
const C3 = 'Private arms-length transfer, multiple parcel (3)';
const C4 = 'Private non-arms-length transfer such as a foreclosure, gift or auction (4)';
const EXTRACT = '2026-09-03';
const W = windowFor('20260903');
// One account row as the query returns it (aliases), segment 1 a kept sale.
const row = over => ({
  j: 'BACI', lat: '39.3288', lng: '-76.6205', lu: 'Residential (R)', bt: 'DWEL Center Unit (0003)', du: '1',
  d1: '2026.03.14', p1: '215000', c1: C1, l1: '24514', f1: '0123',
  d2: '2019.06.01', p2: '120000', c2: C1, l2: '18000', f2: '0456',
  d3: '0000.00.00', p3: '0', c3: 'No Data', l3: '00000', f3: '0000',
  u: '20260903', ...over,
});
// Segment 1 of a row, classified.
const one = over => { const r = row(over); return classify(r, segmentsOf(r, W.from)[0], EXTRACT); };

test('windowFor: through the month before the extract, window pushed back one month for posting lag', () => {
  assert.deepEqual(W, { through: '2026-08', from: '2025-08-01', to: '2026-07-31' });
  assert.deepEqual(windowFor('20260103'), { through: '2025-12', from: '2024-12-01', to: '2025-11-30' });   // across a year end
  assert.deepEqual(windowFor('20240405', 12, 1), { through: '2024-03', from: '2023-03-01', to: '2024-02-29' });   // leap February
  assert.deepEqual(windowFor('20260903', 24, 1), { through: '2026-08', from: '2024-08-01', to: '2026-07-31' });
  assert.deepEqual(windowFor('20260903', 12, 0), { through: '2026-08', from: '2025-09-01', to: '2026-08-31' });
  assert.throws(() => windowFor('2026-09-03'), /not YYYYMMDD/);
  assert.equal(periodOf(W), 'Sales recorded Aug 2025 – Jul 2026');
  assert.equal(vintageOf(W), '2025-08..2026-07');
});

test('the build, given `through`, takes the same window the query asked for', () => {
  const { months, lagMonths } = src.meta.window;
  const same = (latest, extract) => {
    const w = windowFor(extract, months, lagMonths);
    assert.deepEqual(saleWindow({ latest, months, lagMonths, through: w.through }), { from: w.from.slice(0, 7), to: w.to.slice(0, 7), span: periodOf(w).replace('Sales recorded ', '') });
  };
  same('2026-08-26', '20260903');   // the Sep 2026 extract: newest transfer 26 Aug
  same('2026-08-31', '20260903');   // a stray transfer on August's last day changes nothing
  // Without `through` the window would hang on the newest date: 26 Aug makes
  // August incomplete and the lag is taken again (June, a complete month
  // lost), while one stray 31 Aug transfer would move it to July.
  assert.equal(saleWindow({ latest: '2026-08-26', months: 12, lagMonths: 1 }).to, '2026-06');
  assert.equal(saleWindow({ latest: '2026-08-31', months: 12, lagMonths: 1 }).to, '2026-07');
});

test('SDAT codes are read from the "(X)" SDAT prints, and unknown wording throws', () => {
  assert.equal(conveyance(C1), 1);
  assert.equal(conveyance(C2), 2);
  assert.equal(conveyance(C3), 3);
  assert.equal(conveyance(C4), 4);
  assert.equal(conveyance('No Data'), null);
  assert.equal(conveyance(''), null);
  assert.throws(() => conveyance('Sheriff sale (5)'), /format changed/);
  assert.equal(landUse('Residential (R)'), 'R');
  assert.equal(landUse('Residential Condominium (U)'), 'U');
  assert.equal(landUse('Town House (TH)'), 'TH');
  assert.equal(landUse('Apartments (M)'), 'M');
  assert.equal(landUse(''), null);
  assert.throws(() => landUse('Spaceport (SP)'), /format changed/);
  assert.equal(dwellingType('DWEL Parking Space (0014)'), '0014');
  assert.equal(dwellingType('OFFICE Building (C138)'), '');
  assert.equal(dwellingType(''), '');
});

test('isoDate: only real dates', () => {
  assert.equal(isoDate('2026.03.14'), '2026-03-14');
  assert.equal(isoDate('2024.02.29'), '2024-02-29');
  assert.equal(isoDate('2026.02.29'), null);
  assert.equal(isoDate('2026.13.01'), null);
  assert.equal(isoDate('0000.00.00'), null);
  assert.equal(isoDate('..'), null);
});

test('an arm\'s-length residential sale is kept, with only lat, lng, price, date and type', () => {
  const r = one();
  assert.deepEqual(r.sale, { lat: 39.3288, lng: -76.6205, price: 215000, date: '2026-03-14', type: 'townhouse' });
  assert.equal(one({ bt: 'DWEL Standard Unit (0001)' }).sale.type, 'house');
  assert.equal(one({ lu: 'Residential Condominium (U)', bt: 'DWEL Condominium High Rise (0009)' }).sale.type, 'condo');
  assert.equal(one({ lu: 'Town House (TH)' }).sale.type, 'townhouse');
  assert.equal(one({ bt: '' }).sale.type, 'house');
  assert.equal(one({ p1: '10000' }).sale.price, 10000);   // the floor is inclusive
});

test('segments: only those dated from the window start; a repeat within the account is one sale', () => {
  const r = row({ d2: '2025.10.02', p2: '180000' });
  const segs = segmentsOf(r, W.from);
  assert.deepEqual(segs.map(s => s.seg), [1, 2]);          // segment 3 is '0000.00.00'
  assert.ok(classify(r, segs[1], EXTRACT).sale);            // sold twice in the window: both count
  const rep = row({ d2: '2026.03.14', p2: '215000' });
  const s2 = segmentsOf(rep, W.from);
  assert.equal(classify(rep, s2[1], EXTRACT).drop, 'duplicate');
  assert.ok(classify(rep, s2[0], EXTRACT).sale);
});

test('every other sale is dropped with its reason', () => {
  const cases = [
    [{ d1: '2026.10.25' }, 'badDate'],                      // after the extract: a typo
    [{ d1: '2026.02.30' }, 'badDate'],
    [{ lu: 'Apartments (M)' }, 'nonResidential'],
    [{ lu: 'Commercial Residential (CR)' }, 'nonResidential'],
    [{ lu: '' }, 'nonResidential'],
    [{ lu: 'Residential Condominium (U)', bt: 'DWEL Parking Space (0014)' }, 'notAHome'],
    [{ lu: 'Residential Condominium (U)', bt: 'DWEL Storage Unit (0015)' }, 'notAHome'],
    [{ lu: 'Residential Condominium (U)', bt: 'DWEL Boat Slip (0012)' }, 'notAHome'],
    [{ du: '5' }, 'fivePlusHomes'],
    [{ c1: C2 }, 'vacantAtSale'],
    [{ c1: C3 }, 'multiParcel'],
    [{ c1: C4 }, 'nonArmsLength'],
    [{ c1: 'No Data' }, 'noConveyanceCode'],
    [{ c1: '' }, 'noConveyanceCode'],
    [{ p1: '0' }, 'nominal'],
    [{ p1: '9999' }, 'nominal'],
    [{ p1: '300000000' }, 'implausiblePrice'],
    [{ lat: '', lng: '' }, 'noLocation'],
  ];
  for (const [over, why] of cases) assert.equal(one(over).drop, why, JSON.stringify(over));
  // The lag month is passed on: the build finds the window and counts it out.
  assert.equal(one({ d1: '2026.08.20' }).sale.date, '2026-08-20');
  // No drop reason is one the build counts itself.
  for (const [, why] of cases) assert.ok(!ORCH_DROPS.includes(why), why);
  // Before the window start a segment is the account's history, not a candidate
  // (the query asks only for later ones), so it is never counted.
  assert.deepEqual(segmentsOf(row({ d1: '2025.07.31' }), W.from), []);
  // Residential is decided before the code: an arm's-length office sale is nonResidential.
  assert.equal(one({ lu: 'Commercial (C)', c1: C4 }).drop, 'nonResidential');
  // A land-use code this module does not know is a format change.
  assert.throws(() => one({ lu: 'Spaceport (SP)' }), /format changed/);
});

test('one price from one seller\'s deed on one day is several properties: all dropped', () => {
  const k = over => { const r = row(over); return { ...classify(r, segmentsOf(r, W.from)[0], EXTRACT), j: r.j }; };
  const a = k({}), b = k({ lat: '39.3290' }), c = k({ l1: '24999' }), d = k({ p1: '216000' });
  const blank1 = k({ l1: '00000', f1: '0000' }), blank2 = k({ l1: '00000', f1: '0000', lat: '39.3300' });
  const res = dropSharedDeeds([a, b, c, d, blank1, blank2]);
  assert.equal(res.dropped, 2);                             // a and b share day, price and deed
  assert.equal(res.split, 0);
  assert.deepEqual(res.kept, [c, d, blank1, blank2]);       // a blank deed reference groups nothing
});

test('a portfolio split evenly over properties bought separately: 3+ sales, one day, one uneven price', () => {
  const k = over => { const r = row(over); return { ...classify(r, segmentsOf(r, W.from)[0], EXTRACT), j: r.j }; };
  // $166,666 x 3 on one day, each seller's deed different: one price split three ways.
  const p = [k({ p1: '166666', l1: '30001' }), k({ p1: '166666', l1: '30002', lat: '39.3300' }), k({ p1: '166666', l1: '30003', lat: '39.3310' })];
  // A pair at an uneven list price (two new-build houses): not enough to say.
  const pair = [k({ p1: '284900', l1: '30004' }), k({ p1: '284900', l1: '30005' })];
  // Three at a round price on one day: ordinary coincidence in a big city.
  const round = [k({ p1: '300000', l1: '30006' }), k({ p1: '300000', l1: '30007' }), k({ p1: '300000', l1: '30008' })];
  // The same uneven price on another day, or in another jurisdiction: not grouped.
  const apart = [k({ p1: '166666', l1: '30009', d1: '2026.03.15' }), k({ p1: '166666', l1: '30010', j: 'BACO' })];
  const res = dropSharedDeeds([...p, ...pair, ...round, ...apart]);
  assert.equal(res.split, 3);
  assert.equal(res.dropped, 0);
  assert.deepEqual(res.kept, [...pair, ...round, ...apart]);
});

test('the query uses only IN, comparisons, AND and OR (the portal\'s firewall blocks "is null")', () => {
  const w = whereClause({ codes: ['ANNE', 'BACI'], whole: ['BACI'], box: [39.1522, -76.7485, 39.3733, -76.5137], from: '2025-08-01' });
  assert.match(w, /^jurisdiction_code_mdp_field_jurscode IN \('ANNE', 'BACI'\) AND \(jurisdiction_code_mdp_field_jurscode IN \('BACI'\) OR \(/);
  assert.match(w, /mdp_latitude_mdp_field_digycord_converted_to_wgs84 >= 39.1522 AND/);
  assert.equal((w.match(/>= '2025\.08\.01'/g) || []).length, 3);
  assert.doesNotMatch(w, /\bnull\b|\bnot\b|;|--/i);
  assert.doesNotMatch(whereClause({ codes: ['BACO'], box: [1, 2, 3, 4], from: '2025-08-01' }), /BACI/);
});

test('module: point-sales for Baltimore, every Maryland jurisdiction mapped, honest meta', () => {
  assert.equal(src.kind, 'point-sales');
  assert.deepEqual(src.regions, ['baltimore']);
  assert.equal(src.geometry, 'acs-tract');
  assert.equal(Object.keys(JURISDICTIONS).length, 24);
  assert.equal(JURISDICTIONS['24510'], 'BACI');
  assert.equal(src.meta.metric, 'Median sale price');
  assert.equal(src.meta.colourMinN, 10);
  assert.ok([12, 24].includes(src.meta.window.months));
  assert.equal(src.meta.window.by, 'recording');
  assert.equal(src.meta.period, undefined);                 // the build writes it from the window
  assert.match(src.meta.licenceUrl, /^https:\/\//);
  assert.ok(src.meta.attribution.some(l => /State of Maryland/.test(l)), 'MD iMAP terms: derived data acknowledges the State of Maryland');
});
