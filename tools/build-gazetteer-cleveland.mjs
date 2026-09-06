#!/usr/bin/env node
// tools/build-gazetteer-cleveland.mjs
//
// Cleveland gazetteer from the city's own 34 Statistical Planning Areas — the
// set Clevelanders name (Tremont, Ohio City, Glenville, Slavic Village) and the
// one the city reports against. It lives on the SAME ArcGIS org as the CPD
// crime feed this project already reads, so boundaries and incidents come from
// one publisher.
//
// Single ranked table, no second tier. The layer carries a `DIST` number, but
// it is a planning-district id rather than a geography Clevelanders use, and
// grouping on it would invent one — the same call New Orleans got, and the
// opposite of Detroit, where the council district is the city's own second tier.
//
// Run: node tools/build-gazetteer-cleveland.mjs

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, 'gazetteer', 'cleveland.json');
const SRC = 'https://services3.arcgis.com/dty2kHktVXHrqO8i/arcgis/rest/services/'
  + 'Cleveland_SPA_Neighborhoods_Salesforce/FeatureServer/0/query'
  + '?where=1%3D1&outFields=SPANM&returnGeometry=true&outSR=4326&f=geojson';

// The layer abbreviates and drops spaces. These are the spellings people write
// and search, restored without changing which place is meant.
const NAME_FIX = new Map([
  ['St.Clair-Superior', 'St. Clair-Superior'],
  ['Goodrich-Kirtland Pk', 'Goodrich-Kirtland Park'],
]);

const slugify = (s) => s.toLowerCase()
  .normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/&/g, ' and ')
  .replace(/['’.]/g, '')
  .replace(/[^a-z0-9]+/g, '-')
  .replace(/^-+|-+$/g, '');

const ringsOf = (g) => g?.type === 'Polygon' ? [g.coordinates[0]]
  : g?.type === 'MultiPolygon' ? g.coordinates.map((p) => p[0]) : [];

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

// Cleveland's SPAs wrap the Cuyahoga's industrial bends and the lakefront, so a
// geometric centre can land in the river valley or the lake. Asserted
// point-in-polygon: can move a centre to where people live, never onto a
// neighbouring area.
const CENTROID_OVERRIDE = new Map([]);

const havM = (a, b) => {
  const R = 6371000, rad = (d) => (d * Math.PI) / 180;
  const dp = rad(b.lat - a.lat), dl = rad(b.lng - a.lng);
  const q = Math.sin(dp / 2) ** 2 +
    Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dl / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(q));
};

const res = await fetch(SRC, { signal: AbortSignal.timeout(120_000) });
if (!res.ok) throw new Error(`Cleveland SPA neighborhoods HTTP ${res.status}`);
const { features } = await res.json();

const areas = [], overridden = [];
for (const f of features) {
  const raw = String(f.properties?.SPANM || '').trim();
  if (!raw) continue;
  const name = NAME_FIX.get(raw) ?? raw;
  let c = centroidOf(f.geometry);
  if (!c) continue;
  const ov = CENTROID_OVERRIDE.get(name);
  if (ov) {
    if (!ringsOf(f.geometry).some((r) => pointInRing(ov, r))) {
      throw new Error(`centroid override for "${name}" is outside its own polygon`);
    }
    c = ov; overridden.push(name);
  }
  areas.push({
    name,
    slug: slugify(name),
    lat: +c[1].toFixed(6),
    lng: +c[0].toFixed(6),
    borough: 'Cleveland',
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
  city: 'Cleveland', citySlug: 'cleveland', country: 'US',
  source: 'City of Cleveland — 34 Statistical Planning Area neighborhoods',
  purpose: 'Safety pages + calibration.',
  generatedAt: new Date().toISOString().slice(0, 10),
  areas,
}, null, 2) + '\n');

console.log(`cleveland gazetteer: ${areas.length} neighborhoods → ${OUT}`);
if (overridden.length) console.log(`  centroid moved: ${overridden.join(', ')}`);
console.log(`  nearest-centroid spacing: median ${Math.round(median)} m, min ${Math.round(sorted[0])} m`);
console.log(`  gate: DC (tightest published) is ~700 m median → ${median >= 700 ? 'PASS' : 'REVIEW'}`);
