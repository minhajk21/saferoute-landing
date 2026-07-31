#!/usr/bin/env node
// tools/build-gazetteer-boston.mjs
//
// Boston gazetteer for the /safety/ pages: the BPDA's official neighbourhood
// boundaries (Analyze Boston, "BPDA Neighborhood Boundaries") — Back Bay,
// Beacon Hill, North End, South End, Dorchester, Roxbury, Jamaica Plain,
// Charlestown, South Boston, Allston/Brighton, Fenway … the names people
// actually search. Boston is compact and the set is small (26), so unlike
// NYC/Toronto/DC there is no district tier: the hub is ONE ranked table
// (rankHeading in the CITIES config), like Chicago and SF.
//
// HARBOR ISLANDS IS EXCLUDED. It is an uninhabited island national park inside
// the BPDA set; the crime feed has zero incidents there, so it renders as a
// spurious "100/100, perfectly safe" page (verified: covered=false, 0
// incidents). Same class of bug as the jurisdiction enclaves — an empty feed
// must never read as "safe". Longwood is kept: it is a real, walked
// medical-area neighbourhood with genuine incident volume.
//
// Output: tools/gazetteer/boston.json
// Run:    node tools/build-gazetteer-boston.mjs

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = join(dirname(fileURLToPath(import.meta.url)), 'gazetteer', 'boston.json');
const SRC = 'https://data.boston.gov/dataset/bf1a7b50-4c72-4637-b0fa-11d632e3aff1/resource/' +
            'e5849875-a6f6-4c9c-9d8a-5048b0fbd03e/download/boston_neighborhood_boundaries.geojson';

// bostonProvider.covers() — MUST match.
const BBOX = { minLat: 42.22, maxLat: 42.40, minLng: -71.20, maxLng: -70.98 };

// Uninhabited / no-feed areas that would render as false "safe" pages.
const EXCLUDE = new Set(['harbor islands']);

// Centroid overrides — same problem the LA gazetteer solves by snapping to a
// populated core (see snap-la-centroids.mjs). A geometric centroid is wrong
// whenever most of a polygon's area is unpopulated, because the 1 km crime
// circle then lands where nobody walks and the page reads falsely safe.
//   East Boston: the polygon includes LOGAN AIRPORT, so the area-weighted
//   centroid lands airside — 12 incidents → 98/100. The residential core
//   (Maverick / Central / Eagle Hill) reads 397 incidents → 52, and is stable
//   across nearby points, so that is the honest centre for the page.
// Verified against the live feed before hard-coding; revisit if BPDA redraws.
const CENTROID_OVERRIDE = {
  'east boston': { lat: 42.3750, lng: -71.0390, why: 'geometric centroid lands on Logan Airport' },
};

const slugify = (s) => s
  .normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/['’.]/g, '')
  .replace(/\s*\/\s*/g, '-')
  .replace(/[^A-Za-z0-9]+/g, '-')
  .replace(/^-+|-+$/g, '')
  .toLowerCase();

// Area-weighted centroid of the largest ring (ignores harbour slivers/islands).
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
if (!res.ok) throw new Error(`BPDA neighbourhoods: HTTP ${res.status}`);
const geo = await res.json();

const dropped = [], snapped = [];
const areas = geo.features
  .filter(f => f.geometry && f.properties?.name)
  .filter(f => {
    if (EXCLUDE.has(String(f.properties.name).trim().toLowerCase())) { dropped.push(f.properties.name); return false; }
    return true;
  })
  .map(f => {
    const name = String(f.properties.name).trim();
    const ov = CENTROID_OVERRIDE[name.toLowerCase()];
    const c = ov || centroidOf(f.geometry);
    if (ov) snapped.push(`${name} (${ov.why})`);
    return {
      name,
      slug: slugify(name),
      borough: 'Boston',           // flat set — hub renders one ranked table
      lat: +c.lat.toFixed(6),
      lng: +c.lng.toFixed(6),
    };
  })
  .sort((a, b) => a.name.localeCompare(b.name));

for (const a of areas) {
  a.neighbors = areas.filter(b => b !== a)
    .map(b => ({ slug: b.slug, d: distKm(a, b) }))
    .sort((x, y) => x.d - y.d).slice(0, 5).map(n => n.slug);
}

const outside = areas.filter(a =>
  !(a.lat >= BBOX.minLat && a.lat <= BBOX.maxLat && a.lng >= BBOX.minLng && a.lng <= BBOX.maxLng));

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify({
  city: 'Boston',
  citySlug: 'boston',
  country: 'US',
  source: 'Analyze Boston — BPDA Neighborhood Boundaries (Harbor Islands excluded: uninhabited, no feed)',
  generatedAt: new Date().toISOString().slice(0, 10),
  areas,
}, null, 1));

console.log(`gazetteer: ${areas.length} Boston neighbourhoods → ${OUT}`);
if (dropped.length) console.log(`excluded (uninhabited/no feed): ${dropped.join(', ')}`);
if (snapped.length) console.log(`centroid snapped: ${snapped.join(', ')}`);
console.log('sample:', areas.slice(0, 8).map(a => a.name).join(' · '));
console.log(`centroids outside the BPD bbox: ${outside.length}${outside.length ? ' → ' + outside.map(a => `${a.name} (${a.lat},${a.lng})`).join(', ') : ''}`);
