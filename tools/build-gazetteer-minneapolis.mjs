#!/usr/bin/env node
// tools/build-gazetteer-minneapolis.mjs
//
// Minneapolis gazetteer: the city's own 87 official neighborhoods, grouped
// under its own 11 communities.
//
// Both tiers are the city's, not ours. `Minneapolis_Neighborhoods` (BDNAME) is
// the set residents and the city both use — Uptown's constituent neighborhoods,
// Powderhorn Park, Linden Hills, Downtown West — and `Minneapolis_Communities`
// (CommName) is the official 11-way grouping. The community is assigned by
// point-in-polygon of each neighborhood's centroid, because the layers ship
// separately with no shared key.
//
// Run: node tools/build-gazetteer-minneapolis.mjs

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, 'gazetteer', 'minneapolis.json');
const ORG = 'https://services.arcgis.com/afSMGVsC7QlRK1kZ/arcgis/rest/services';
const NB = `${ORG}/Minneapolis_Neighborhoods/FeatureServer/0/query`
  + '?where=1%3D1&outFields=BDNAME&returnGeometry=true&outSR=4326&f=geojson';
const CM = `${ORG}/Minneapolis_Communities/FeatureServer/0/query`
  + '?where=1%3D1&outFields=CommName&returnGeometry=true&outSR=4326&f=geojson';

const slugify = (s) => s.toLowerCase()
  .normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/&/g, ' and ')
  .replace(/['’.]/g, '')
  .replace(/[^a-z0-9]+/g, '-')
  .replace(/^-+|-+$/g, '');

const ringsOf = (g) => g?.type === 'Polygon' ? [g.coordinates[0]]
  : g?.type === 'MultiPolygon' ? g.coordinates.map((p) => p[0]) : [];

const allRings = (g) => g?.type === 'Polygon' ? g.coordinates
  : g?.type === 'MultiPolygon' ? g.coordinates.flat() : [];

function ringCentroid(ring) {
  let a = 0, cx = 0, cy = 0;
  for (let i = 0, n = ring.length - 1; i < n; i++) {
    const [x0, y0] = ring[i], [x1, y1] = ring[i + 1];
    const f = x0 * y1 - x1 * y0;
    a += f; cx += (x0 + x1) * f; cy += (y0 + y1) * f;
  }
  if (Math.abs(a) < 1e-12) {
    const m = ring.reduce((p, c) => [p[0] + c[0], p[1] + c[1]], [0, 0]);
    return [m[0] / ring.length, m[1] / ring.length];
  }
  a *= 0.5;
  return [cx / (6 * a), cy / (6 * a)];
}

const ringArea = (ring) => {
  let a = 0;
  for (let i = 0, n = ring.length - 1; i < n; i++) {
    const [x0, y0] = ring[i], [x1, y1] = ring[i + 1];
    a += x0 * y1 - x1 * y0;
  }
  return Math.abs(a / 2);
};

function centroidOf(geom) {
  let best = null, bestA = -1;
  for (const r of ringsOf(geom)) {
    const a = ringArea(r);
    if (a > bestA) { bestA = a; best = r; }
  }
  return best ? ringCentroid(best) : null;
}

function pointInRing([x, y], ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

// name → [lng, lat] of the built-up core, for any area whose geometric centre
// lands where nobody is (a lake, a rail yard, an industrial flat). Asserted
// point-in-polygon below: this can move a centre to where people live, never
// onto a neighbouring area. Minneapolis has real lakes inside neighborhood
// polygons, so this is a live hazard here, not a formality.
const CENTROID_OVERRIDE = new Map([]);

const havM = (a, b) => {
  const R = 6371000, rad = (d) => (d * Math.PI) / 180;
  const dp = rad(b.lat - a.lat), dl = rad(b.lng - a.lng);
  const q = Math.sin(dp / 2) ** 2 +
    Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dl / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(q));
};

const get = async (u, what) => {
  const r = await fetch(u, { signal: AbortSignal.timeout(120_000) });
  if (!r.ok) throw new Error(`${what} HTTP ${r.status}`);
  return r.json();
};

const [nb, cm] = await Promise.all([get(NB, 'neighborhoods'), get(CM, 'communities')]);

const communities = cm.features.map((f) => ({
  name: String(f.properties?.CommName || '').trim(),
  rings: allRings(f.geometry),
}));

const areas = [], overridden = [], unassigned = [];
for (const f of nb.features) {
  const name = String(f.properties?.BDNAME || '').trim();
  if (!name) continue;
  let c = centroidOf(f.geometry);
  if (!c) continue;
  const ov = CENTROID_OVERRIDE.get(name);
  if (ov) {
    if (!ringsOf(f.geometry).some((r) => pointInRing(ov, r))) {
      throw new Error(`centroid override for "${name}" is outside its own polygon`);
    }
    c = ov; overridden.push(name);
  }
  const hit = communities.find((k) => k.rings.some((r) => pointInRing(c, r)));
  if (!hit) unassigned.push(name);
  areas.push({
    name,
    slug: slugify(name),
    lat: +c[1].toFixed(6),
    lng: +c[0].toFixed(6),
    borough: hit ? hit.name : 'Minneapolis',
  });
}

areas.sort((a, b) => a.name.localeCompare(b.name));

const dup = areas.length - new Set(areas.map((a) => a.slug)).size;
if (dup) throw new Error(`${dup} duplicate slug(s) — refusing to write an ambiguous gazetteer`);

const nearest = areas.map((a) =>
  Math.min(...areas.filter((b) => b !== a).map((b) => havM(a, b))));
const sorted = [...nearest].sort((x, y) => x - y);
const median = sorted[Math.floor(sorted.length / 2)];

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify({
  city: 'Minneapolis', citySlug: 'minneapolis', country: 'US',
  source: 'City of Minneapolis — 87 official neighborhoods grouped by the city\'s 11 communities',
  purpose: 'Safety pages + calibration.',
  generatedAt: new Date().toISOString().slice(0, 10),
  areas,
}, null, 2) + '\n');

const byC = areas.reduce((m, a) => (m[a.borough] = (m[a.borough] || 0) + 1, m), {});
console.log(`minneapolis gazetteer: ${areas.length} neighborhoods → ${OUT}`);
console.log(`  communities: ${JSON.stringify(byC)}`);
if (unassigned.length) console.log(`  ⚠ no community matched (centroid outside every community polygon): ${unassigned.join(', ')}`);
if (overridden.length) console.log(`  centroid moved: ${overridden.join(', ')}`);
console.log(`  nearest-centroid spacing: median ${Math.round(median)} m, min ${Math.round(sorted[0])} m`);
console.log(`  gate: DC (tightest published) is ~700 m median → ${median >= 700 ? 'PASS' : 'REVIEW'}`);
