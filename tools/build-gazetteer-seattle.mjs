#!/usr/bin/env node
// tools/build-gazetteer-seattle.mjs
//
// Seattle gazetteer for the /safety/ pages: the city's Neighborhood Map Atlas
// neighborhoods (Seattle City GIS, Planning dept). The Atlas has two tiers —
// S_HOOD (the 94 small neighborhoods people search: Ballard, Fremont, Belltown,
// Georgetown, Alki) grouped under L_HOOD districts (Capitol Hill, West Seattle,
// Downtown…). We use S_HOOD as the page unit and L_HOOD as the district
// grouping, so Seattle gets a multi-district hub like NYC (boroughs) and London
// (boroughs) rather than a single ranked table. Capitol Hill / West Seattle,
// which are L_HOODs rather than discrete S_HOODs, surface as district headers.
//
// Source: the official Seattle City GIS ArcGIS Online host (Render-safe).
//
// Output: tools/gazetteer/seattle.json
// Run:    node tools/build-gazetteer-seattle.mjs

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = join(dirname(fileURLToPath(import.meta.url)), 'gazetteer', 'seattle.json');
const SVC = 'https://services.arcgis.com/ZOyb2t4B0UYuYNYH/arcgis/rest/services/' +
            'nma_nhoods_sub/FeatureServer/0';
const SRC = `${SVC}/query?where=1%3D1&outFields=S_HOOD,L_HOOD&outSR=4326&f=geojson`;

// Provider bbox (src/providers/seattleProvider.js covers()).
const BBOX = { minLat: 47.48, maxLat: 47.74, minLng: -122.46, maxLng: -122.22 };

const slugify = (s) => s
  .normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/['’.]/g, '')
  .replace(/\s*\/\s*/g, '-')
  .replace(/[^A-Za-z0-9]+/g, '-')
  .replace(/^-+|-+$/g, '')
  .toLowerCase();

function centroidOf(geometry) {
  const polys = geometry.type === 'MultiPolygon' ? geometry.coordinates : [geometry.coordinates];
  let best = null, bestArea = -1;
  for (const poly of polys) {
    const ring = poly[0];
    let a = 0, cx = 0, cy = 0;
    for (let i = 0; i < ring.length - 1; i++) {
      const [x1, y1] = ring[i], [x2, y2] = ring[i + 1];
      const f = x1 * y2 - x2 * y1;
      a += f; cx += (x1 + x2) * f; cy += (y1 + y2) * f;
    }
    a /= 2;
    if (Math.abs(a) > bestArea) { bestArea = Math.abs(a); best = { lng: cx / (6 * a), lat: cy / (6 * a) }; }
  }
  return best;
}

const distKm = (a, b) => {
  const dLat = (a.lat - b.lat) * 111.32;
  const dLng = (a.lng - b.lng) * 111.32 * Math.cos(a.lat * Math.PI / 180);
  return Math.hypot(dLat, dLng);
};

const res = await fetch(SRC, { signal: AbortSignal.timeout(120_000) });
if (!res.ok) throw new Error(`Seattle NMA fetch: HTTP ${res.status}`);
const geo = await res.json();

const areas = geo.features
  .filter(f => f.geometry && f.properties && f.properties.S_HOOD)
  .map(f => {
    const c = centroidOf(f.geometry);
    const name = String(f.properties.S_HOOD).trim();
    return {
      name,
      slug: slugify(name),
      borough: String(f.properties.L_HOOD || 'Seattle').trim(), // district grouping
      lat: +c.lat.toFixed(6),
      lng: +c.lng.toFixed(6),
    };
  })
  .sort((a, b) => a.borough.localeCompare(b.borough) || a.name.localeCompare(b.name));

// Some S_HOOD names repeat across districts in raw data? De-dupe defensively.
const dupes = areas.length - new Set(areas.map(a => a.slug)).size;
if (dupes) {
  // keep first occurrence, drop later dupes (rare)
  const seen = new Set();
  for (let i = areas.length - 1; i >= 0; i--) {
    if (seen.has(areas[i].slug)) areas.splice(i, 1); else seen.add(areas[i].slug);
  }
  console.log(`  note: dropped ${dupes} duplicate slug(s)`);
}

for (const a of areas) {
  a.neighbors = areas.filter(b => b !== a)
    .map(b => ({ slug: b.slug, d: distKm(a, b) }))
    .sort((x, y) => x.d - y.d).slice(0, 5).map(n => n.slug);
}

const outside = areas.filter(a =>
  !(a.lat >= BBOX.minLat && a.lat <= BBOX.maxLat && a.lng >= BBOX.minLng && a.lng <= BBOX.maxLng));

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify({
  city: 'Seattle',
  citySlug: 'seattle',
  country: 'US',
  source: 'Seattle City GIS — Neighborhood Map Atlas neighborhoods (94), grouped by district',
  generatedAt: new Date().toISOString().slice(0, 10),
  areas,
}, null, 1));

console.log(`gazetteer: ${areas.length} Seattle neighborhoods → ${OUT}`);
console.log(`districts: ${[...new Set(areas.map(a => a.borough))].length}`);
console.log('sample:', areas.slice(0, 6).map(a => a.name).join(' · '));
console.log(`centroids outside the SPD bbox: ${outside.length}${outside.length ? ' → ' + outside.map(a => a.name).join(', ') : ''}`);
