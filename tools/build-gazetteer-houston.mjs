#!/usr/bin/env node
// tools/build-gazetteer-houston.mjs
//
// Houston gazetteer for the /safety/ pages: the City of Houston's 88 official
// Super Neighborhoods (the city's own planning/civic units), from the COH GIS
// ArcGIS Online service. Chosen because they are the stable, authoritative City
// of Houston units and carry the names people search — Montrose, the Heights,
// Midtown, River Oaks, Third Ward.
//
// Like LA, Houston's bbox contains incorporated cities with their own police
// (Bellaire, West University, Pasadena TX…) that LAPD-equivalent HPD data does
// not cover; the backend subtracts those as enclaves (see src/providers/
// _enclaves.js) and the gate below reports any council centroid landing in one.
//
// Output: tools/gazetteer/houston.json
// Run:    node tools/build-gazetteer-houston.mjs

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = join(dirname(fileURLToPath(import.meta.url)), 'gazetteer', 'houston.json');
const SVC = 'https://services.arcgis.com/su8ic9KbA7PYVxPS/arcgis/rest/services/' +
            'COH_SUPER_NEIGHBORHOODS/FeatureServer/0';
const SRC = `${SVC}/query?where=1%3D1&outFields=SNBNAME&outSR=4326&f=geojson`;

// HPD-provider enclave boxes (mirror of backend _enclaves.js houston set) — a
// centroid landing here would produce a "no data" page.
const ENCLAVES = [
  { name: 'Pasadena TX',     minLat: 29.6686, maxLat: 29.7136, minLng: -95.2350, maxLng: -95.1832 },
  { name: 'Bellaire',        minLat: 29.6959, maxLat: 29.7157, minLng: -95.4702, maxLng: -95.4474 },
  { name: 'West University', minLat: 29.7068, maxLat: 29.7248, minLng: -95.4422, maxLng: -95.4216 },
  { name: 'South Houston',   minLat: 29.6528, maxLat: 29.6726, minLng: -95.2491, maxLng: -95.2263 },
  { name: 'Galena Park',     minLat: 29.7334, maxLat: 29.7532, minLng: -95.2419, maxLng: -95.2191 },
  { name: 'Jacinto City',    minLat: 29.7573, maxLat: 29.7753, minLng: -95.2441, maxLng: -95.2235 },
  { name: 'Deer Park',       minLat: 29.6854, maxLat: 29.7250, minLng: -95.1466, maxLng: -95.1010 },
];
const enclaveAt = (lat, lng) =>
  ENCLAVES.find(b => lat >= b.minLat && lat <= b.maxLat && lng >= b.minLng && lng <= b.maxLng);

// Names arrive ALL CAPS with " / " and " - " separators and a few tokens that
// must not be naively title-cased ("TRI-COMMUNITY", ordinals). Handle the
// separators, keep them, and fix the handful that plain casing mangles.
const FIXES = {
  'OST': 'OST', 'MacGREGOR': 'MacGregor', // acronym / mixed-case survivors
};
function titleCase(raw) {
  return String(raw).trim().toLowerCase()
    .replace(/\b([a-z])/g, m => m.toUpperCase())
    .replace(/\bMac([a-z])/g, (_, c) => 'Mac' + c.toUpperCase())
    .replace(/\bOst\b/g, 'OST')
    .replace(/\s*\/\s*/g, ' / ')
    .replace(/\s*-\s*/g, ' - ');
}

const slugify = (s) => s
  .normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/['’.]/g, '')
  .replace(/\s*[\/-]\s*/g, '-')
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
if (!res.ok) throw new Error(`COH Super Neighborhoods fetch: HTTP ${res.status}`);
const geo = await res.json();

const areas = geo.features
  .filter(f => f.geometry && f.properties && f.properties.SNBNAME)
  .map(f => {
    const c = centroidOf(f.geometry);
    const name = titleCase(f.properties.SNBNAME);
    return { name, slug: slugify(name), borough: 'Houston', lat: +c.lat.toFixed(6), lng: +c.lng.toFixed(6) };
  })
  .sort((a, b) => a.name.localeCompare(b.name));

const dupes = areas.length - new Set(areas.map(a => a.slug)).size;
if (dupes) throw new Error(`${dupes} duplicate slugs`);

for (const a of areas) {
  a.neighbors = areas.filter(b => b !== a)
    .map(b => ({ slug: b.slug, d: distKm(a, b) }))
    .sort((x, y) => x.d - y.d).slice(0, 5).map(n => n.slug);
}

// HPD city bbox from the backend provider (29.52–30.11, −95.79…−95.01).
const outside = areas.filter(a => !(a.lat >= 29.52 && a.lat <= 30.11 && a.lng >= -95.79 && a.lng <= -95.01));
const inEnclave = areas.map(a => ({ a, e: enclaveAt(a.lat, a.lng) })).filter(x => x.e);

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify({
  city: 'Houston',
  citySlug: 'houston',
  country: 'US',
  source: 'City of Houston — Super Neighborhoods (COH GIS), all 88',
  generatedAt: new Date().toISOString().slice(0, 10),
  areas,
}, null, 1));

console.log(`gazetteer: ${areas.length} Houston super neighborhoods → ${OUT}`);
console.log('sample:', areas.slice(0, 6).map(a => a.name).join(' · '));
console.log(`centroids outside the HPD bbox: ${outside.length}${outside.length ? ' → ' + outside.map(a => a.name).join(', ') : ''}`);
console.log(`centroids inside a non-HPD enclave: ${inEnclave.length}${inEnclave.length ? ' → ' + inEnclave.map(x => `${x.a.name} (${x.e.name})`).join(', ') : ''}`);
