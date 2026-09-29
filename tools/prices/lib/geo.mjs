// Polygon geometry for the home-prices tiles, zero-dependency.
//
// Coordinates arrive from sources as GeoJSON-style [lng, lat] pairs, WGS84,
// full precision: a polygon is [outer, hole, ...], an area is a list of
// polygons (a MultiPolygon). What ships is much smaller:
//
//   1. SIMPLIFY each ring with Douglas-Peucker at 8 m, measured in local
//      metres (an equirectangular frame at the ring's first point; the page's
//      own crime-hex maths uses the same 111,320 m a degree). 8 m is below
//      what a z11–z16 map shows at a boundary, and it drops the survey-grade
//      vertex runs that make raw census polygons 5–20x the size.
//   2. DROP a ring left with fewer than 4 points (closed: 3 corners + the
//      first again) or under 200 m². A dropped outer ring takes its holes with
//      it; a dropped hole just goes. Slivers and specks, never real areas.
//   3. ORIENT outer rings counter-clockwise and holes clockwise (RFC 7946), so
//      output does not depend on how a publisher wound its rings.
//   4. QUANTIZE to 1e-5 degrees (about 1.1 m), then ENCODE each ring as ONE
//      flat integer array: the first point absolute [lat*1e5, lng*1e5], then
//      [dlat, dlng] deltas. Rings are stored OPEN (the closing point is not
//      repeated; a decoder closes them). Note the order flips to lat, lng.
//
//   decodeRing(ints) -> [[lng, lat], ...] (open), in degrees
//   pointInPolygon(lat, lng, polys) -> boolean (holes respected; even-odd)
//
// The page decodes the same format (check/index.html); tools/prices/README.md
// documents it for any other reader.

export const Q = 1e5;                 // quantum: 1e-5 degrees
export const TOL_M = 8;               // Douglas-Peucker tolerance, metres
export const MIN_RING_M2 = 200;       // smaller rings are dropped
const M_PER_DEG = 111320;
const RAD = Math.PI / 180;

const closed = r => r.length > 1 && r[0][0] === r[r.length - 1][0] && r[0][1] === r[r.length - 1][1];
const close = r => (r.length && !closed(r) ? [...r, r[0]] : r);

// Local metre frame anchored at (lat0, lng0).
function frame(lat0, lng0) {
  const kx = M_PER_DEG * Math.cos(lat0 * RAD);
  return ([lng, lat]) => [(lng - lng0) * kx, (lat - lat0) * M_PER_DEG];
}

// Signed area in the ring's own units (shoelace): > 0 counter-clockwise when
// x is east and y is north. Works on open or closed rings.
function shoelace(pts) {
  let a = 0;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) a += (pts[j][0] - pts[i][0]) * (pts[j][1] + pts[i][1]);
  return a / 2;
}
export const signedAreaDeg = ring => shoelace(ring);   // [lng, lat] pairs
export function ringAreaM2(ring) {
  if (ring.length < 3) return 0;
  const f = frame(ring[0][1], ring[0][0]);
  return Math.abs(shoelace(ring.map(f)));
}

// Squared distance from p to segment ab (all in metres).
function segDist2(p, a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const len2 = dx * dx + dy * dy;
  let t = len2 ? ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const ex = a[0] + t * dx - p[0], ey = a[1] + t * dy - p[1];
  return ex * ex + ey * ey;
}

// Douglas-Peucker keep-mask over pts[lo..hi] (metres), iterative so a
// 100k-vertex coastline cannot overflow the stack.
function dpMask(m, lo, hi, tol2, keep) {
  const stack = [[lo, hi]];
  while (stack.length) {
    const [a, b] = stack.pop();
    let worst = -1, at = -1;
    for (let i = a + 1; i < b; i++) {
      const d = segDist2(m[i], m[a], m[b]);
      if (d > worst) { worst = d; at = i; }
    }
    if (at >= 0 && worst > tol2) { keep[at] = 1; stack.push([a, at], [at, b]); }
  }
}

// Simplify one ring ([lng, lat] pairs, open or closed). Returns a CLOSED ring,
// possibly degenerate (fewer than 4 points) — the caller decides to drop it.
// A closed ring is split at the vertex farthest from its first point, so both
// halves are ordinary polylines with distinct ends.
export function simplifyRing(ring, tolM = TOL_M) {
  const r = close(ring.filter(p => Number.isFinite(p[0]) && Number.isFinite(p[1])));
  if (r.length < 4) return r;
  const m = r.map(frame(r[0][1], r[0][0]));
  const n = r.length - 1;                 // r[n] === r[0]
  let far = 0, fd = -1;
  for (let i = 1; i < n; i++) {
    const d = (m[i][0] - m[0][0]) ** 2 + (m[i][1] - m[0][1]) ** 2;
    if (d > fd) { fd = d; far = i; }
  }
  const keep = new Uint8Array(r.length);
  keep[0] = keep[far] = keep[n] = 1;
  dpMask(m, 0, far, tolM * tolM, keep);
  dpMask(m, far, n, tolM * tolM, keep);
  return r.filter((_, i) => keep[i]);
}

// Quantize a ring to integer [lat*Q, lng*Q] pairs, dropping consecutive
// repeats (two vertices that fell on the same 1e-5 cell) and the closing
// point: the result is an OPEN integer ring.
export function quantizeRing(ring) {
  const out = [];
  for (const [lng, lat] of ring) {
    const q = [Math.round(lat * Q), Math.round(lng * Q)];
    const last = out[out.length - 1];
    if (!last || last[0] !== q[0] || last[1] !== q[1]) out.push(q);
  }
  while (out.length > 1 && out[0][0] === out[out.length - 1][0] && out[0][1] === out[out.length - 1][1]) out.pop();
  return out;
}

// Integer ring [[latQ, lngQ], ...] (open) -> flat delta array.
export function encodeRing(qring) {
  const out = new Array(qring.length * 2);
  let pl = 0, pg = 0;
  for (let i = 0; i < qring.length; i++) {
    const [la, lg] = qring[i];
    out[2 * i] = la - pl; out[2 * i + 1] = lg - pg;
    pl = la; pg = lg;
  }
  return out;
}

// Flat delta array -> [[lng, lat], ...] (open), in degrees.
export function decodeRing(ints) {
  const out = [];
  let la = 0, lg = 0;
  for (let i = 0; i + 1 < ints.length; i += 2) {
    la += ints[i]; lg += ints[i + 1];
    out.push([lg / Q, la / Q]);
  }
  return out;
}

// [[outerInts, holeInts...], ...] -> [[[ [lng, lat], ...] ...] ...]
export const decodePolys = enc => enc.map(poly => poly.map(decodeRing));

// [s, w, n, e] of a list of polygons ([lng, lat] rings).
export function bboxOf(polys) {
  let s = Infinity, w = Infinity, n = -Infinity, e = -Infinity;
  for (const poly of polys) for (const ring of poly) for (const [lng, lat] of ring) {
    if (lat < s) s = lat; if (lat > n) n = lat;
    if (lng < w) w = lng; if (lng > e) e = lng;
  }
  return [s, w, n, e];
}
export const bboxIntersects = (a, b) => a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1];

// Even-odd ray cast over every ring of each polygon, so a hole (or a hole's
// island) is handled without knowing which ring is which. Open or closed.
function inRing(lat, lng, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > lat) !== (yj > lat) && lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
export function pointInPolygon(lat, lng, polys) {
  for (const poly of polys) {
    let inside = false;
    for (const ring of poly) if (inRing(lat, lng, ring)) inside = !inside;
    if (inside) return true;
  }
  return false;
}

// The whole geometry step for one area (see the header). Returns the encoded
// polygons, their bbox (from the quantized points), and what was dropped.
// enc is [] when nothing survives; the caller drops the area.
export function processPolys(polys, { tolM = TOL_M, minAreaM2 = MIN_RING_M2 } = {}) {
  const enc = [];
  const st = { rings: 0, ringsDropped: 0, pointsIn: 0, pointsOut: 0 };
  let s = Infinity, w = Infinity, n = -Infinity, e = -Infinity;
  const ring1 = (ring, outer) => {
    st.rings++; st.pointsIn += ring.length;
    const simple = simplifyRing(ring, tolM);
    const q = quantizeRing(simple);
    // Validity is judged on what ships: >= 3 distinct corners (4 closed) and
    // the minimum area, measured on the quantized ring.
    const deg = q.map(([la, lg]) => [lg / Q, la / Q]);
    if (q.length < 3 || ringAreaM2(deg) < minAreaM2) { st.ringsDropped++; return null; }
    const ccw = signedAreaDeg(deg) > 0;
    if (ccw !== outer) q.reverse();
    st.pointsOut += q.length;
    for (const [la, lg] of q) {
      if (la < s) s = la; if (la > n) n = la;
      if (lg < w) w = lg; if (lg > e) e = lg;
    }
    return encodeRing(q);
  };
  for (const poly of polys) {
    const outer = ring1(poly[0], true);
    if (!outer) { st.ringsDropped += poly.length - 1; st.rings += poly.length - 1; continue; }
    const out = [outer];
    for (const hole of poly.slice(1)) { const h = ring1(hole, false); if (h) out.push(h); }
    enc.push(out);
  }
  return { enc, bbox: enc.length ? [s / Q, w / Q, n / Q, e / Q] : null, stats: st };
}

// bbox of already-encoded polygons (a snapshot area).
export const bboxOfEncoded = enc => bboxOf(decodePolys(enc));
