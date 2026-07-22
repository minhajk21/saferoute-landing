#!/usr/bin/env node
// tools/build-gazetteer-chicago.mjs
//
// Chicago gazetteer for the /safety/ pages: the city's 77 official Community
// Areas (Chicago Data Portal "Boundaries - Community Areas", igwz-8jzy — note
// the sibling id cauq-8yn6 is a *map* visualisation and returns no fields).
// Community areas are the stable, authoritative unit here and they carry the
// names people actually search — Lincoln Park, Hyde Park, Wicker Park sits in
// West Town, etc.
//
// Output: tools/gazetteer/chicago.json
// Run:    node tools/build-gazetteer-chicago.mjs

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = join(dirname(fileURLToPath(import.meta.url)), 'gazetteer', 'chicago.json');
const SRC = 'https://data.cityofchicago.org/resource/igwz-8jzy.geojson?$limit=200';

// The source stores names in caps ("ROGERS PARK", "OHARE"). Plain title-casing
// mangles a few, so fix those explicitly rather than shipping "Ohare".
const NAME_FIXES = {
  'OHARE': "O'Hare",
  'MCKINLEY PARK': 'McKinley Park',
  // The source says "LOOP"; everyone (and every search) says "the Loop", and
  // "Is Loop Safe?" reads broken as a page title.
  'THE LOOP': 'The Loop',
  'LOOP': 'The Loop',
};
const titleCase = (raw) => {
  const key = raw.trim().toUpperCase();
  if (NAME_FIXES[key]) return NAME_FIXES[key];
  return key.toLowerCase()
    .replace(/\b([a-z])/g, (m) => m.toUpperCase())
    .replace(/\bMc([a-z])/g, (_, c) => 'Mc' + c.toUpperCase());
};

const slugify = (s) => s
  .normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/['’.]/g, '')
  .replace(/[^A-Za-z0-9]+/g, '-')
  .replace(/^-+|-+$/g, '')
  .toLowerCase();

// Area-weighted centroid (shoelace) of the largest ring.
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

const res = await fetch(SRC, { signal: AbortSignal.timeout(90_000) });
if (!res.ok) throw new Error(`community areas fetch: HTTP ${res.status}`);
const geo = await res.json();

const areas = geo.features
  .filter(f => f.geometry && f.properties && f.properties.community)
  .map(f => {
    const c = centroidOf(f.geometry);
    const name = titleCase(f.properties.community);
    return {
      name,
      slug: slugify(name),
      // Chicago community areas have no borough tier; the hub renders one
      // ranked table. (Deliberately NOT inventing a "side" grouping — the
      // official side mapping isn't in this dataset.)
      borough: 'Chicago',
      areaNum: f.properties.area_numbe || f.properties.area_num_1,
      lat: +c.lat.toFixed(6),
      lng: +c.lng.toFixed(6),
    };
  })
  .sort((a, b) => a.name.localeCompare(b.name));

const dupes = areas.length - new Set(areas.map(a => a.slug)).size;
if (dupes) throw new Error(`${dupes} duplicate slugs`);

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
  city: 'Chicago',
  citySlug: 'chicago',
  country: 'US',
  source: 'Chicago Data Portal — Boundaries: Community Areas (igwz-8jzy), all 77',
  generatedAt: new Date().toISOString().slice(0, 10),
  areas,
}, null, 1));
console.log(`gazetteer: ${areas.length} Chicago community areas → ${OUT}`);
console.log('sample:', areas.slice(0, 6).map(a => a.name).join(' · '));
