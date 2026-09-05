#!/usr/bin/env node
// tools/build-gazetteer-detroit.mjs
//
// Detroit gazetteer from the City of Detroit's own 205 official neighborhoods
// (`Current_City_of_Detroit_Neighborhoods`, the layer behind theneighborhoods.org).
//
// WHY THIS BOUNDARY SET
// It is the city's own, it is the one the city publishes neighborhood pages
// against, and every name Detroiters actually use is in it — Corktown,
// Indian Village, Boston Edison, Jefferson Chalmers, Brightmoor, Springwells.
// The alternatives are all coarser clusters (Data Driven Detroit's 54 Master
// Plan neighborhoods, SEMCOG's 55) that merge names people distinguish.
//
// GROUPED BY COUNCIL DISTRICT (1-7), which ships in the layer itself. This is
// the city's own second tier, not one we invented — the same call as NYC's
// boroughs and Toronto's former municipalities, and the opposite of New
// Orleans, where the id prefixes matched no geography anyone uses.
//
// WHAT IS DROPPED, and why it is a land-use test rather than a crime-count one:
// an area is dropped only when *nobody lives in it*, because there a near-zero
// score describes empty land while reading as a finding of safety. Dropping on
// low counts instead would delete quiet residential neighborhoods — exactly the
// places least likely to be described fairly, and the same bias that keeps
// ShotSpotter and officer-initiated calls out of the app.
//
// Run: node tools/build-gazetteer-detroit.mjs

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, 'gazetteer', 'detroit.json');
const SRC = 'https://services2.arcgis.com/qvkbeam7Wirps6zC/arcgis/rest/services/'
  + 'Current_City_of_Detroit_Neighborhoods/FeatureServer/0/query'
  + '?where=1%3D1&outFields=nhood_name,council_district&returnGeometry=true&outSR=4326&f=geojson';

// Land-use drops (see header). Each is named, not pattern-matched, so adding
// one is a deliberate act with a reason attached.
const DROP = new Map([
  ['Belle Isle',              'state park island in the Detroit River — no residents'],
  ['Conner Creek Industrial', 'industrial belt'],
  ['Russell Industrial',      'industrial belt'],
  ['West Side Industrial',    'industrial belt'],
]);

const slugify = (s) => s.toLowerCase()
  .normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/&/g, ' and ')
  .replace(/['’.]/g, '')
  .replace(/[^a-z0-9]+/g, '-')
  .replace(/^-+|-+$/g, '');

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

const ringsOf = (g) => g?.type === 'Polygon' ? [g.coordinates[0]]
  : g?.type === 'MultiPolygon' ? g.coordinates.map((p) => p[0]) : [];

/// Largest-ring centroid: a neighborhood with detached parcels still centres on
/// its main body, and a riverfront area is not dragged into the water by a
/// finely-digitised shoreline.
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
// lands somewhere nobody is. Asserted point-in-polygon below, so this can move a
// centre to where people are but never onto a neighbouring area.
const CENTROID_OVERRIDE = new Map([]);

const havM = (a, b) => {
  const R = 6371000, rad = (d) => (d * Math.PI) / 180;
  const dp = rad(b.lat - a.lat), dl = rad(b.lng - a.lng);
  const q = Math.sin(dp / 2) ** 2 +
    Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dl / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(q));
};

const res = await fetch(SRC, { signal: AbortSignal.timeout(120_000) });
if (!res.ok) throw new Error(`Detroit neighborhoods HTTP ${res.status}`);
const { features } = await res.json();

const areas = [], dropped = [], overridden = [];
for (const f of features) {
  const name = String(f.properties?.nhood_name || '').trim();
  if (!name) continue;
  if (DROP.has(name)) { dropped.push(`${name} (${DROP.get(name)})`); continue; }
  let c = centroidOf(f.geometry);
  if (!c) continue;
  const ov = CENTROID_OVERRIDE.get(name);
  if (ov) {
    if (!ringsOf(f.geometry).some((r) => pointInRing(ov, r))) {
      throw new Error(`centroid override for "${name}" is outside its own polygon`);
    }
    c = ov; overridden.push(name);
  }
  const d = f.properties?.council_district;
  areas.push({
    name,
    slug: slugify(name),
    lat: +c[1].toFixed(6),
    lng: +c[0].toFixed(6),
    borough: d ? `District ${d}` : 'Detroit',
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
  city: 'Detroit', citySlug: 'detroit', country: 'US',
  source: 'City of Detroit — Current City of Detroit Neighborhoods (205), grouped by City Council district',
  purpose: 'Safety pages + calibration. See this script\'s header for the land-use drop rule.',
  generatedAt: new Date().toISOString().slice(0, 10),
  areas,
}, null, 2) + '\n');

const byDist = areas.reduce((m, a) => (m[a.borough] = (m[a.borough] || 0) + 1, m), {});
console.log(`detroit gazetteer: ${areas.length} neighborhoods → ${OUT}`);
console.log(`  districts: ${JSON.stringify(byDist)}`);
if (dropped.length) console.log(`  dropped ${dropped.length}: ${dropped.join('; ')}`);
if (overridden.length) console.log(`  centroid moved: ${overridden.join(', ')}`);
console.log(`  nearest-centroid spacing: median ${Math.round(median)} m, min ${Math.round(sorted[0])} m`);
console.log(`  gate: DC (tightest published) is ~700 m median → ${median >= 700 ? 'PASS' : 'REVIEW'}`);
