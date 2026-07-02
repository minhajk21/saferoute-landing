#!/usr/bin/env node
// tools/build-gazetteer-nyc.mjs
//
// Builds the NYC neighborhood gazetteer for the /safety/ programmatic pages.
// Source: NYC Open Data "2020 Neighborhood Tabulation Areas (NTAs)" (9nt8-h7nd),
// filtered to residential areas (ntatype 0 — parks/cemeteries/airports excluded:
// they'd make meaningless "is it safe" pages). For each NTA we keep a display
// name, URL slug, borough, and an area-weighted centroid (the point the safety
// score is computed around), plus each neighborhood's 5 nearest neighbors
// (centroid distance) for the "nearby areas" internal links.
//
// Output: tools/gazetteer/new-york.json
// Run:    node tools/build-gazetteer-nyc.mjs

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = join(dirname(fileURLToPath(import.meta.url)), 'gazetteer', 'new-york.json');
const SRC = 'https://data.cityofnewyork.us/resource/9nt8-h7nd.geojson?$limit=300';

const slugify = (s) => s
  .normalize('NFD').replace(/[̀-ͯ]/g, '')   // strip accents
  .replace(/['’.]/g, '')
  .replace(/[^A-Za-z0-9]+/g, '-')
  .replace(/^-+|-+$/g, '')
  .toLowerCase();

// Area-weighted centroid (shoelace) of the largest ring — robust for NTA
// multipolygons where a neighborhood may include a small offshore sliver.
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
    if (Math.abs(a) > bestArea) {
      bestArea = Math.abs(a);
      best = { lng: cx / (6 * a), lat: cy / (6 * a) };
    }
  }
  return best;
}

const distKm = (a, b) => {
  const dLat = (a.lat - b.lat) * 111.32;
  const dLng = (a.lng - b.lng) * 111.32 * Math.cos(a.lat * Math.PI / 180);
  return Math.hypot(dLat, dLng);
};

const res = await fetch(SRC);
if (!res.ok) throw new Error(`NTA fetch failed: HTTP ${res.status}`);
const geo = await res.json();

const areas = geo.features
  .filter(f => f.properties.ntatype === '0')
  .map(f => {
    const c = centroidOf(f.geometry);
    return {
      name: f.properties.ntaname,
      slug: slugify(f.properties.ntaname),
      borough: f.properties.boroname,
      nta: f.properties.nta2020,
      lat: +c.lat.toFixed(6),
      lng: +c.lng.toFixed(6),
    };
  })
  .sort((a, b) => a.name.localeCompare(b.name));

// Disambiguate any slug collisions (same neighborhood name in two boroughs).
const bySlug = new Map();
for (const a of areas) {
  if (bySlug.has(a.slug)) {
    const other = bySlug.get(a.slug);
    other.slug = `${other.slug}-${slugify(other.borough)}`;
    a.slug = `${a.slug}-${slugify(a.borough)}`;
  }
  bySlug.set(a.slug, a);
}

// 5 nearest neighbors for internal linking.
for (const a of areas) {
  a.neighbors = areas
    .filter(b => b !== a)
    .map(b => ({ slug: b.slug, d: distKm(a, b) }))
    .sort((x, y) => x.d - y.d)
    .slice(0, 5)
    .map(n => n.slug);
}

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify({
  city: 'New York',
  citySlug: 'new-york',
  country: 'US',
  source: 'NYC Open Data — 2020 Neighborhood Tabulation Areas (9nt8-h7nd), residential (ntatype 0)',
  generatedAt: new Date().toISOString().slice(0, 10),
  areas,
}, null, 1));
console.log(`gazetteer: ${areas.length} neighborhoods → ${OUT}`);
const dupes = areas.length - new Set(areas.map(a => a.slug)).size;
if (dupes) throw new Error(`${dupes} duplicate slugs remain`);
