#!/usr/bin/env node
// tools/build-gazetteer-kansascity.mjs
//
// Kansas City, Missouri: the city's own 246 neighborhood boundaries, grouped by
// the city's own 18 Area Plans. Both layers come from the SAME KCMO ArcGIS org,
// so the second tier is the city's real planning geography rather than one this
// project invented — the Detroit/Seattle pattern, not the New Orleans one.
//
// Boundaries: nbhboundaries_updated (field `nbhname`)
// Districts:  Databook_AreaPlan_Boundaries (field `NAME`, 18 plans)
//
// TWO AREAS ARE DROPPED, for different reasons.
//   "KCI & 2nd Creek" — 135 km² that is Kansas City International Airport and
//   its approaches. Nobody walks it as a neighborhood: the same call San Diego's
//   military parcels and Detroit's Belle Isle got.
//   "Longview" — 30.6 km² wrapped around Longview Lake, and the feed carries
//   NOTHING anywhere inside it. Probing four separate interior points returned
//   0, 1, 0 and 0 incidents, three of them dataUnavailable. Its page could only
//   have said "0 incidents, 100/100, low risk", which is the absence of a
//   finding dressed as one — the same reason New Orleans's Lake Catherine was
//   dropped. Dropping it also removes the one-member Longview Area Plan.
// Everything else is KEPT, including the industrial districts and the river
// bottoms. They are thin, but a caveat on the page is the honest remedy; a drop
// erases a place, and the bar for that is "a page could say nothing true".
//
// TWO CENTROIDS FALL OUTSIDE THEIR OWN POLYGON — Longview, which wraps Longview
// Lake, and Knoches Park. That is the failure that published Toronto's St
// Lawrence as the 2nd safest place in the city, so it is fixed structurally
// rather than by hand: any centroid outside its ring falls back to a guaranteed
// point-on-surface. That makes no claim about where residents are — it only
// guarantees the point is in the right neighborhood — and the neighbour-ratio
// audit that runs before publishing is what catches it if the result is still
// in a void.
//
// Run: node tools/build-gazetteer-kansascity.mjs

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, 'gazetteer', 'kansascity.json');
const ORG = 'https://services.arcgis.com/4o5uMWTHuOhUVJPd/arcgis/rest/services';
const SRC = `${ORG}/nbhboundaries_updated/FeatureServer/0/query`
  + '?where=1%3D1&outFields=nbhid,nbhname&returnGeometry=true&outSR=4326&f=geojson';
const PLANS = `${ORG}/Databook_AreaPlan_Boundaries/FeatureServer/0/query`
  + '?where=1%3D1&outFields=NAME&returnGeometry=true&outSR=4326&f=geojson';

const NOT_A_NEIGHBOURHOOD = /^(KCI (&|and) 2nd Creek|Longview)$/i;

// The layer mixes connectors: one name uses "&" and thirteen spell out "And"
// mid-name, which title-casing leaves as a capital. Lowercase the connector so
// "18th And Vine" reads the way Kansas City writes it.
const fixName = (s) => s
  .trim()
  .replace(/\s+/g, ' ')
  .replace(/\bAnd\b/g, 'and');

const slugify = (s) => s.toLowerCase()
  .normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/&/g, ' and ')
  .replace(/['’.]/g, '')
  .replace(/[^a-z0-9]+/g, '-')
  .replace(/^-+|-+$/g, '');

const ringsOf = (g) => g?.type === 'Polygon' ? [g.coordinates[0]]
  : g?.type === 'MultiPolygon' ? g.coordinates.map((p) => p[0]) : [];

const ringArea = (r) => {
  let a = 0;
  for (let i = 0, n = r.length - 1; i < n; i++) a += r[i][0] * r[i + 1][1] - r[i + 1][0] * r[i][1];
  return Math.abs(a / 2);
};

function ringCentroid(r) {
  let a = 0, cx = 0, cy = 0;
  for (let i = 0, n = r.length - 1; i < n; i++) {
    const [x0, y0] = r[i], [x1, y1] = r[i + 1];
    const f = x0 * y1 - x1 * y0;
    a += f; cx += (x0 + x1) * f; cy += (y0 + y1) * f;
  }
  if (Math.abs(a) < 1e-12) {
    const m = r.reduce((p, c) => [p[0] + c[0], p[1] + c[1]], [0, 0]);
    return [m[0] / r.length, m[1] / r.length];
  }
  a *= 0.5;
  return [cx / (6 * a), cy / (6 * a)];
}

function pointInRing([x, y], ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/// Guaranteed interior point (the ST_PointOnSurface idea): sweep a horizontal
/// line through the ring, take the WIDEST interior span on it, return its
/// midpoint. Used only when the true centroid falls outside — a C-shaped or
/// lake-wrapped polygon — so a page never scores a point in another area.
function pointOnSurface(ring) {
  const ys = ring.map((p) => p[1]);
  const lo = Math.min(...ys), hi = Math.max(...ys);
  let best = null, bestW = -1;
  for (let k = 1; k < 40; k++) {
    const y = lo + ((hi - lo) * k) / 40;
    const xs = [];
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i], [xj, yj] = ring[j];
      if ((yi > y) !== (yj > y)) xs.push(((xj - xi) * (y - yi)) / (yj - yi) + xi);
    }
    xs.sort((a, b) => a - b);
    for (let i = 0; i + 1 < xs.length; i += 2) {
      const w = xs[i + 1] - xs[i];
      if (w > bestW) { bestW = w; best = [(xs[i] + xs[i + 1]) / 2, y]; }
    }
  }
  return best;
}

function centroidOf(geom) {
  let best = null, bestA = -1;
  for (const r of ringsOf(geom)) {
    const a = ringArea(r);
    if (a > bestA) { bestA = a; best = r; }
  }
  if (!best) return null;
  const c = ringCentroid(best);
  if (pointInRing(c, best)) return { pt: c, snapped: false };
  const s = pointOnSurface(best);
  return s ? { pt: s, snapped: true } : { pt: c, snapped: false };
}

const havM = (a, b) => {
  const R = 6371000, rad = (d) => (d * Math.PI) / 180;
  const dp = rad(b.lat - a.lat), dl = rad(b.lng - a.lng);
  const q = Math.sin(dp / 2) ** 2 +
    Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dl / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(q));
};

const [nRes, pRes] = await Promise.all([
  fetch(SRC, { signal: AbortSignal.timeout(180_000) }),
  fetch(PLANS, { signal: AbortSignal.timeout(180_000) }),
]);
if (!nRes.ok) throw new Error(`KCMO neighborhoods HTTP ${nRes.status}`);
if (!pRes.ok) throw new Error(`KCMO area plans HTTP ${pRes.status}`);
const nJson = await nRes.json();
const plans = (await pRes.json()).features
  .map((f) => ({ name: String(f.properties?.NAME || '').trim(), rings: ringsOf(f.geometry) }))
  .filter((p) => p.name && p.rings.length);

/// District by point-in-polygon, with a nearest-plan fallback so a neighborhood
/// on a plan's edge is never orphaned into an "Other" bucket.
function districtFor(pt) {
  for (const p of plans) if (p.rings.some((r) => pointInRing(pt, r))) return p.name;
  let best = null, bestD = Infinity;
  for (const p of plans) {
    for (const r of p.rings) {
      const c = ringCentroid(r);
      const d = havM({ lat: pt[1], lng: pt[0] }, { lat: c[1], lng: c[0] });
      if (d < bestD) { bestD = d; best = p.name; }
    }
  }
  return best;
}

const areas = [], dropped = [], snapped = [], fellBack = [];
for (const f of nJson.features) {
  const raw = String(f.properties?.nbhname || '');
  if (!raw.trim()) continue;
  const name = fixName(raw);
  if (NOT_A_NEIGHBOURHOOD.test(name)) { dropped.push(name); continue; }
  const c = centroidOf(f.geometry);
  if (!c) continue;
  if (c.snapped) snapped.push(name);
  const inAny = plans.some((p) => p.rings.some((r) => pointInRing(c.pt, r)));
  if (!inAny) fellBack.push(name);
  areas.push({
    name,
    slug: slugify(name),
    lat: +c.pt[1].toFixed(6),
    lng: +c.pt[0].toFixed(6),
    borough: districtFor(c.pt),
  });
}

areas.sort((a, b) => a.name.localeCompare(b.name));

const dup = areas.length - new Set(areas.map((a) => a.slug)).size;
if (dup) throw new Error(`${dup} duplicate slug(s) — refusing to write an ambiguous gazetteer`);
const blank = areas.filter((a) => !a.name || !a.borough);
if (blank.length) throw new Error(`${blank.length} area(s) missing a name or district`);

const nearest = areas.map((a) =>
  Math.min(...areas.filter((b) => b !== a).map((b) => havM(a, b))));
const sorted = [...nearest].sort((x, y) => x - y);
const median = sorted[Math.floor(sorted.length / 2)];

const byDist = areas.reduce((m, a) => (m[a.borough] = (m[a.borough] || 0) + 1, m), {});

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify({
  city: 'Kansas City', citySlug: 'kansascity', country: 'US',
  source: 'City of Kansas City, Missouri — 246 neighborhood boundaries, grouped by the city\'s 18 Area Plans',
  purpose: 'Safety pages + calibration. See this script\'s header for what is dropped and why nothing else is.',
  generatedAt: new Date().toISOString().slice(0, 10),
  areas,
}, null, 2) + '\n');

console.log(`kansas city gazetteer: ${areas.length} neighborhoods → ${OUT}`);
console.log(`  districts: ${Object.entries(byDist).sort().map(([k, v]) => `${k} ${v}`).join(' · ')}`);
if (dropped.length) console.log(`  dropped ${dropped.length}: ${dropped.join(', ')}`);
if (snapped.length) console.log(`  centroid outside its own ring → point-on-surface: ${snapped.join(', ')}`);
if (fellBack.length) console.log(`  district by nearest-plan fallback: ${fellBack.join(', ')}`);
console.log(`  nearest-centroid spacing: median ${Math.round(median)} m, min ${Math.round(sorted[0])} m`);
console.log(`  gate: DC (tightest published) is ~700 m median → ${median >= 700 ? 'PASS' : 'REVIEW'}`);
