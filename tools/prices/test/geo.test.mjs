// node --test tools/prices/test/
// The polygon pipeline every area goes through: what is encoded must decode
// to the same points, simplification must not wreck a shape, and the
// point-in-polygon the address report relies on must respect holes.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  Q, simplifyRing, quantizeRing, encodeRing, decodeRing, decodePolys, processPolys,
  pointInPolygon, ringAreaM2, signedAreaDeg, bboxOf, bboxOfEncoded,
} from '../lib/geo.mjs';

// A ring of k points on an ellipse around (lat, lng), rx/ry in degrees.
const ellipse = (lat, lng, rx, ry, k = 400, reverse = false) => {
  const r = [];
  for (let i = 0; i < k; i++) { const t = 2 * Math.PI * i / k; r.push([lng + rx * Math.cos(t), lat + ry * Math.sin(t)]); }
  if (reverse) r.reverse();
  return [...r, r[0]];
};
const square = (s, w, d) => [[w, s], [w + d, s], [w + d, s + d], [w, s + d], [w, s]];
const M = 111320;   // metres per degree of latitude, as lib/geo.mjs

// Distance in metres from p to segment ab ([lng, lat]), in a local frame.
function distM(p, a, b) {
  const k = Math.cos(p[1] * Math.PI / 180) * M;
  const P = [p[0] * k, p[1] * M], A = [a[0] * k, a[1] * M], B = [b[0] * k, b[1] * M];
  const dx = B[0] - A[0], dy = B[1] - A[1], l2 = dx * dx + dy * dy;
  const t = l2 ? Math.max(0, Math.min(1, ((P[0] - A[0]) * dx + (P[1] - A[1]) * dy) / l2)) : 0;
  return Math.hypot(A[0] + t * dx - P[0], A[1] + t * dy - P[1]);
}
const segsCross = (a, b, c, d) => {
  const o = (p, q, r) => Math.sign((q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]));
  return o(a, b, c) * o(a, b, d) < 0 && o(c, d, a) * o(c, d, b) < 0;
};

test('encode/decode: round trip is exact at 1e-5 degrees', () => {
  const ring = [[-0.127758, 51.507351], [-0.12, 51.507351], [-0.119999, 51.51], [-0.127758, 51.510004]];
  const q = quantizeRing(ring);
  const enc = encodeRing(q);
  assert.deepEqual(enc.slice(0, 2), [5150735, -12776], 'first point absolute, lat then lng');
  assert.deepEqual(enc.slice(2, 4), [0, 776], 'then deltas');
  assert.ok(enc.every(Number.isInteger));
  const back = decodeRing(enc);
  assert.equal(back.length, 4, 'open ring: the closing point is not stored');
  for (let i = 0; i < ring.length; i++) {
    assert.ok(Math.abs(back[i][0] - ring[i][0]) <= 0.5 / Q + 1e-12 && Math.abs(back[i][1] - ring[i][1]) <= 0.5 / Q + 1e-12);
    assert.deepEqual(quantizeRing([back[i]]), [q[i]], 'decode then quantize gives the same integers');
  }
  // Negative coordinates on both axes, and a closed input ring.
  const sw = quantizeRing([[-122.41941, -33.86882], [-122.4, -33.86882], [-122.4, -33.85], [-122.41941, -33.86882]]);
  assert.equal(sw.length, 3);
  assert.deepEqual(quantizeRing(decodeRing(encodeRing(sw))), sw);
});

test('quantize drops repeated vertices and the closing point', () => {
  const q = quantizeRing([[0, 0], [0.000001, 0.000001], [0.001, 0], [0.001, 0.001], [0, 0]]);
  assert.deepEqual(q, [[0, 0], [0, 100], [100, 100]]);
});

test('simplify: keeps the shape within tolerance, closed, from original vertices', () => {
  const ring = ellipse(51.5, -0.1, 0.008, 0.005, 2000);   // ~550 m x 555 m
  const out = simplifyRing(ring, 8);
  assert.ok(out.length < ring.length / 10, `${out.length} of ${ring.length} points kept`);
  assert.deepEqual(out[0], out[out.length - 1], 'still closed');
  const orig = new Set(ring.map(p => p.join(',')));
  assert.ok(out.every(p => orig.has(p.join(','))), 'every kept point is an original vertex');
  // Hausdorff-style bound: every original vertex is within 8 m of the result.
  let worst = 0;
  for (const p of ring) {
    let d = Infinity;
    for (let i = 1; i < out.length; i++) d = Math.min(d, distM(p, out[i - 1], out[i]));
    worst = Math.max(worst, d);
  }
  assert.ok(worst <= 8 + 1e-6, `worst deviation ${worst.toFixed(2)} m`);
  const a0 = ringAreaM2(ring), a1 = ringAreaM2(out);
  assert.ok(Math.abs(a1 - a0) / a0 < 0.02, `area ${a0.toFixed(0)} -> ${a1.toFixed(0)} m²`);
});

test('simplify keeps topology sane: no self-crossing, holes stay inside, shared edges agree', () => {
  // A wiggly star (the kind of outline DP can fold) with a hole.
  const star = [];
  for (let i = 0; i < 720; i++) {
    const t = 2 * Math.PI * i / 720, r = 0.01 * (1 + 0.35 * Math.sin(9 * t) + 0.02 * Math.sin(97 * t));
    star.push([-73.98 + r * Math.cos(t) * 1.3, 40.75 + r * Math.sin(t)]);
  }
  star.push(star[0]);
  const hole = ellipse(40.75, -73.98, 0.002, 0.0015, 300, true);
  const { enc, stats } = processPolys([[star, hole]]);
  assert.equal(enc.length, 1);
  assert.equal(enc[0].length, 2, 'the hole survives');
  assert.equal(stats.ringsDropped, 0);
  const [outer, h] = decodePolys(enc)[0];
  const ringSegs = r => r.map((p, i) => [p, r[(i + 1) % r.length]]);
  const so = ringSegs(outer);
  for (let i = 0; i < so.length; i++) for (let j = i + 2; j < so.length; j++) {
    if (i === 0 && j === so.length - 1) continue;   // neighbours through the closing point
    assert.ok(!segsCross(...so[i], ...so[j]), `outer ring crosses itself at segments ${i}/${j}`);
  }
  for (const p of h) assert.ok(pointInPolygon(p[1], p[0], [[outer]]), 'hole vertex outside its outer ring');
  for (const [a, b] of ringSegs(h)) for (const [c, d] of so) assert.ok(!segsCross(a, b, c, d), 'hole crosses the outer ring');

  // Two squares sharing an edge: both keep the shared corners, so no gap opens.
  const [A] = decodePolys(processPolys([[square(40.7, -74, 0.01)]]).enc);
  const [B] = decodePolys(processPolys([[square(40.7, -73.99, 0.01)]]).enc);
  const key = p => p.map(v => v.toFixed(5)).join(',');
  const shared = A[0].map(key).filter(k => B[0].map(key).includes(k));
  assert.equal(shared.length, 2, 'the two shared corners are identical in both');
});

test('processPolys: orientation normalised, specks and slivers dropped', () => {
  // Outer given clockwise, hole given counter-clockwise: both flipped.
  const outer = square(51.5, -0.1, 0.01).reverse();
  const hole = square(51.503, -0.097, 0.003);
  const { enc, bbox } = processPolys([[outer, hole]]);
  const [o, h] = decodePolys(enc)[0];
  assert.ok(signedAreaDeg(o) > 0, 'outer counter-clockwise');
  assert.ok(signedAreaDeg(h) < 0, 'hole clockwise');
  assert.deepEqual(bbox, [51.5, -0.1, 51.51, -0.09]);
  assert.deepEqual(bboxOfEncoded(enc), bbox);

  // A 10 m square (100 m²) is a speck: dropped. A 20 m square (400 m²) stays.
  const d10 = 10 / M, d20 = 20 / M;
  assert.equal(processPolys([[square(51.5, -0.1, d10)]]).enc.length, 0);
  assert.equal(processPolys([[square(51.5, -0.1, d20 * 1.6)]]).enc.length, 1);
  // A dropped outer ring takes its holes with it; a speck hole just goes.
  const r = processPolys([[square(51.5, -0.1, d10), square(51.5, -0.1, d10 / 2)], [square(51.6, -0.1, 0.01), square(51.604, -0.096, d10 / 3)]]);
  assert.equal(r.enc.length, 1);
  assert.equal(r.enc[0].length, 1);
  assert.equal(r.stats.ringsDropped, 3);
  // A sliver: 1 km long, 5 cm wide, collapses under simplification.
  const sliver = [[-0.1, 51.5], [-0.086, 51.5], [-0.086, 51.5000005], [-0.1, 51.5000005], [-0.1, 51.5]];
  assert.equal(processPolys([[sliver]]).enc.length, 0);
});

test('pointInPolygon: holes, islands in holes, multipolygons, open or closed rings', () => {
  const outer = square(0, 0, 10), hole = square(3, 3, 4), island = square(4, 4, 2), other = square(20, 20, 2);
  const polys = [[outer, hole], [island], [other]];
  assert.equal(pointInPolygon(1, 1, polys), true, 'in the outer ring');
  assert.equal(pointInPolygon(3.5, 3.5, polys), false, 'in the hole');
  assert.equal(pointInPolygon(5, 5, polys), true, 'on the island in the hole');
  assert.equal(pointInPolygon(21, 21, polys), true, 'in the second polygon');
  assert.equal(pointInPolygon(15, 15, polys), false, 'between polygons');
  assert.equal(pointInPolygon(-1, 5, polys), false, 'outside');
  // The encoded (open) form gives the same answers.
  const dec = decodePolys(processPolys([[square(51.5, -0.1, 0.01), square(51.503, -0.097, 0.003)]]).enc);
  assert.equal(pointInPolygon(51.501, -0.099, dec), true);
  assert.equal(pointInPolygon(51.5045, -0.0955, dec), false);
  assert.deepEqual(bboxOf(dec), [51.5, -0.1, 51.51, -0.09]);
});
