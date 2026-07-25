#!/usr/bin/env node
// tools/build-gazetteer-sf.mjs
//
// San Francisco gazetteer for the /safety/ pages: the city's 41 official
// "Analysis Neighborhoods" (DataSF's standard analytical unit — the same field
// the SFPD incident feed tags each report with, so pages line up exactly with
// the data). Pulled from an ArcGIS Online mirror because DataSF's own SODA
// GeoJSON export returns geometry-less features (a known Socrata map-view quirk,
// same as Chicago's cauq-8yn6).
//
// SF is a consolidated city-county, so there are no incorporated enclaves inside
// it the way LA/Houston have. Park neighbourhoods turned out NOT to need special
// handling (checked against real YTD pulls, 2026-07): Golden Gate Park (182
// incidents), Lincoln Park (126) and McLaren Park (203) all carry real signal —
// largely tourist car break-ins — so they score like ordinary areas. Only the
// Presidio is thin (6), and it is a genuinely safe national park, so its high
// score is truthful rather than a centroid artifact; no LA-style snapping.
//
// Output: tools/gazetteer/sf.json
// Run:    node tools/build-gazetteer-sf.mjs

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = join(dirname(fileURLToPath(import.meta.url)), 'gazetteer', 'sf.json');
const SVC = 'https://services.arcgis.com/Zs2aNLFN00jrS4gG/arcgis/rest/services/' +
            'Dissolve_SF_Analysis_Neighborhoods_41/FeatureServer/0';
const SRC = `${SVC}/query?where=1%3D1&outFields=nhood&outSR=4326&f=geojson`;

// Neighborhoods that are essentially parkland — real Analysis Neighborhoods but
// with almost no residential population, so a 1km disc there is low-signal
// rather than genuinely "safe". Reported so the page build can caveat or drop.
const PARK_LIKE = new Set([
  'golden gate park', 'lincoln park', 'mclaren park', 'presidio', 'lake merced',
]);

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
if (!res.ok) throw new Error(`SF Analysis Neighborhoods fetch: HTTP ${res.status}`);
const geo = await res.json();

const areas = geo.features
  .filter(f => f.geometry && f.properties && f.properties.nhood)
  .map(f => {
    const c = centroidOf(f.geometry);
    const name = String(f.properties.nhood).trim();
    const a = { name, slug: slugify(name), borough: 'San Francisco', lat: +c.lat.toFixed(6), lng: +c.lng.toFixed(6) };
    if (PARK_LIKE.has(name.toLowerCase())) a.parkLike = true;
    return a;
  })
  .sort((a, b) => a.name.localeCompare(b.name));

const dupes = areas.length - new Set(areas.map(a => a.slug)).size;
if (dupes) throw new Error(`${dupes} duplicate slugs`);

for (const a of areas) {
  a.neighbors = areas.filter(b => b !== a)
    .map(b => ({ slug: b.slug, d: distKm(a, b) }))
    .sort((x, y) => x.d - y.d).slice(0, 5).map(n => n.slug);
}

// SF provider bbox (from src/providers/sfProvider.js covers()).
const outside = areas.filter(a => !(a.lat >= 37.70 && a.lat <= 37.84 && a.lng >= -122.52 && a.lng <= -122.35));

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify({
  city: 'San Francisco',
  citySlug: 'sf',
  country: 'US',
  source: 'DataSF — Analysis Neighborhoods (41), via ArcGIS Online mirror',
  generatedAt: new Date().toISOString().slice(0, 10),
  areas,
}, null, 1));

console.log(`gazetteer: ${areas.length} SF analysis neighborhoods → ${OUT}`);
console.log('sample:', areas.slice(0, 6).map(a => a.name).join(' · '));
console.log(`centroids outside the SFPD bbox: ${outside.length}${outside.length ? ' → ' + outside.map(a => a.name).join(', ') : ''}`);
console.log(`park-like (low-signal) neighborhoods: ${areas.filter(a => a.parkLike).length} → ${areas.filter(a => a.parkLike).map(a => a.name).join(', ')}`);
