// node --test tools/prices/test/
// Colour breaks: city-relative quintiles, 2 significant figures, strictly
// increasing whatever the data, and only from areas that are coloured.
import test from 'node:test';
import assert from 'node:assert/strict';
import { computeBreaks, sig2, percentile, classOf, increasing, MIN_COLOURED } from '../lib/scale.mjs';
import { isColoured } from '../lib/schema.mjs';

test('sig2 rounds to two significant figures', () => {
  assert.equal(sig2(412345), 410000);
  assert.equal(sig2(415000), 420000);
  assert.equal(sig2(1234567), 1200000);
  assert.equal(sig2(98765), 99000);
  assert.equal(sig2(99600), 100000);
  assert.throws(() => sig2(0));
});

test('percentile interpolates linearly', () => {
  assert.equal(percentile([1, 2, 3, 4, 5], 0.5), 3);
  assert.equal(percentile([10, 20], 0.25), 12.5);
});

test('breaks are the 20/40/60/80th percentiles, rounded, strictly increasing', () => {
  const vals = Array.from({ length: 101 }, (_, i) => 200_000 + i * 10_000);   // 200k .. 1.2M
  const b = computeBreaks(vals);
  assert.deepEqual(b.breaks, [400_000, 600_000, 800_000, 1_000_000]);
  assert.equal(b.areas, 101);
  assert.equal(b.min, 200_000);
  assert.equal(b.max, 1_200_000);
  assert.equal(b.median, 700_000);
  assert.ok(increasing(b.breaks));
});

test('breaks stay strictly increasing when rounding collides', () => {
  // Heavy ties: most areas at the same value.
  const flat = [...Array(50).fill(400_000), 401_000, 402_000, 405_000];
  const b = computeBreaks(flat);
  assert.ok(increasing(b.breaks), JSON.stringify(b.breaks));
  assert.deepEqual(b.breaks, [400_000, 410_000, 420_000, 430_000]);
  // Near a power of ten, a step up changes the unit.
  const b2 = computeBreaks([99_000, 99_000, 99_100, 99_200, 99_300, 99_400]);
  assert.ok(increasing(b2.breaks), JSON.stringify(b2.breaks));
  assert.deepEqual(b2.breaks, [99_000, 100_000, 110_000, 120_000]);
  // Random data never breaks the rule.
  let seed = 7;
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  for (let t = 0; t < 200; t++) {
    const n = 5 + Math.floor(rnd() * 60);
    // Values from 10k to 10M, with runs of ties.
    const vs = Array.from({ length: n }, () => (rnd() < 0.3 ? 450_000 : Math.round(10 ** (4 + 3 * rnd()))));
    const bb = computeBreaks(vs).breaks;
    assert.equal(bb.length, 4);
    assert.ok(increasing(bb), `${JSON.stringify(vs)} -> ${JSON.stringify(bb)}`);
    for (const x of bb) assert.equal(sig2(x), x, `${x} is not 2 significant figures`);
  }
});

test('too few coloured areas cannot form quintiles', () => {
  assert.throws(() => computeBreaks(Array(MIN_COLOURED - 1).fill(500_000)), /at least/);
  assert.throws(() => computeBreaks([0, -1, NaN, 100, 200]), /at least/);
});

test('only coloured areas vote; top-coded ones do, in the top class', () => {
  const area = (value, flags = []) => ({ value, flags });
  assert.equal(isColoured(area(500_000)), true);
  assert.equal(isColoured(area(2_000_001, ['topcoded'])), true);
  assert.equal(isColoured(area(500_000, ['few'])), false);
  assert.equal(isColoured(area(500_000, ['uncertain'])), false);
  assert.equal(isColoured(area(null, ['suppressed'])), false);
  assert.equal(isColoured(area(null)), false);
  const b = computeBreaks([300_000, 400_000, 500_000, 600_000, 700_000, 2_000_001]);
  assert.equal(classOf(2_000_001, b.breaks), 4);
});

test('classOf: 0 below the first break, 4 at or above the last', () => {
  const b = [400_000, 600_000, 800_000, 1_000_000];
  assert.equal(classOf(100, b), 0);
  assert.equal(classOf(400_000, b), 1);
  assert.equal(classOf(599_999, b), 1);
  assert.equal(classOf(800_000, b), 3);
  assert.equal(classOf(1_000_000, b), 4);
});
