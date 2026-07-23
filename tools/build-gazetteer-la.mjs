#!/usr/bin/env node
// tools/build-gazetteer-la.mjs
//
// Los Angeles gazetteer for the /safety/ pages: the city's 99 certified
// Neighborhood Councils, published by EmpowerLA (the City of LA's Department of
// Neighborhood Empowerment).
//
// Why Neighborhood Councils rather than the better-known LA Times "Mapping L.A."
// set: NC boundaries are defined ONLY inside City of LA limits. The LA Times set
// spans LA County and includes Santa Monica, Beverly Hills, Culver City and
// others policed by their own departments — LAPD's feed is near-empty there, so
// those pages would render as implausibly safe or as "no data". (That same
// rectangle overreach is why losAngelesProvider now subtracts enclaves; see
// backend src/providers/_enclaves.js.) NC names are also the ones people search:
// Silver Lake, Los Feliz, Venice, Echo Park, Sherman Oaks all appear verbatim.
//
// Output: tools/gazetteer/la.json
// Run:    node tools/build-gazetteer-la.mjs

import { writeFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = join(dirname(fileURLToPath(import.meta.url)), 'gazetteer', 'la.json');
const SVC = 'https://services5.arcgis.com/7nsPwEMP38bSkCjy/arcgis/rest/services/' +
            'Neighborhood_Council_Boundaries_2018_City_of_Los_Angeles/FeatureServer/0';
const SRC = `${SVC}/query?where=1%3D1&outFields=Name&outSR=4326&f=geojson`;

// Municipalities inside LA's bbox with their own police departments. Mirrors
// backend src/providers/_enclaves.js — a centroid landing in one would produce a
// page with no data, so they are reported rather than silently shipped.
const ENCLAVES = [
  { name: 'Santa Monica',   minLat: 34.004, maxLat: 34.054, minLng: -118.525, maxLng: -118.441 },
  { name: 'Beverly Hills',  minLat: 34.053, maxLat: 34.109, minLng: -118.430, maxLng: -118.374 },
  { name: 'West Hollywood', minLat: 34.074, maxLat: 34.100, minLng: -118.397, maxLng: -118.340 },
  { name: 'Culver City',    minLat: 33.974, maxLat: 34.035, minLng: -118.432, maxLng: -118.361 },
  { name: 'Inglewood',      minLat: 33.912, maxLat: 33.981, minLng: -118.380, maxLng: -118.303 },
  { name: 'El Segundo',     minLat: 33.898, maxLat: 33.935, minLng: -118.434, maxLng: -118.369 },
  { name: 'Burbank',        minLat: 34.151, maxLat: 34.223, minLng: -118.374, maxLng: -118.281 },
  { name: 'Glendale',       minLat: 34.113, maxLat: 34.271, minLng: -118.322, maxLng: -118.179 },
];
const enclaveAt = (lat, lng) =>
  ENCLAVES.find(b => lat >= b.minLat && lat <= b.maxLat && lng >= b.minLng && lng <= b.maxLng);

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
if (!res.ok) throw new Error(`EmpowerLA fetch: HTTP ${res.status}`);
const geo = await res.json();

const areas = geo.features
  .filter(f => f.geometry && f.properties && f.properties.Name)
  .map(f => {
    const c = centroidOf(f.geometry);
    const name = String(f.properties.Name).trim();
    return {
      name,
      slug: slugify(name),
      // LA's 12 EmpowerLA regions are numeric with no published name mapping, so
      // the hub renders one ranked table rather than inventing region labels.
      borough: 'Los Angeles',
      lat: +c.lat.toFixed(6),
      lng: +c.lng.toFixed(6),
    };
  })
  .sort((a, b) => a.name.localeCompare(b.name));

const dupes = areas.length - new Set(areas.map(a => a.slug)).size;
if (dupes) throw new Error(`${dupes} duplicate slugs`);

// Preserve density-snapped query points from a previous run (snap-la-centroids
// moves ~30 park-spanning councils to their populated core). Boundaries barely
// change, so re-deriving the geometric centroid each month would silently undo
// the snap and republish those neighbourhoods as falsely safe. Keyed by slug.
if (existsSync(OUT)) {
  const prev = JSON.parse(readFileSync(OUT));
  const snapped = new Map((prev.areas || []).filter(a => a.centroidSnapped).map(a => [a.slug, a]));
  for (const a of areas) {
    const s = snapped.get(a.slug);
    if (s && s.centroidOrig) {
      // Only carry the snap forward if the geometric centroid still matches —
      // i.e. the boundary hasn't been redrawn under us.
      const drift = Math.hypot((a.lat - s.centroidOrig.lat) * 111, (a.lng - s.centroidOrig.lng) * 92);
      if (drift < 0.3) { a.centroidOrig = s.centroidOrig; a.lat = s.lat; a.lng = s.lng; a.centroidSnapped = true; }
    }
  }
}

for (const a of areas) {
  a.neighbors = areas
    .filter(b => b !== a)
    .map(b => ({ slug: b.slug, d: distKm(a, b) }))
    .sort((x, y) => x.d - y.d)
    .slice(0, 5)
    .map(n => n.slug);
}

// Sanity gates before anything is published.
const outside = areas.filter(a => !(a.lat >= 33.70 && a.lat <= 34.34 && a.lng >= -118.67 && a.lng <= -118.15));
const inEnclave = areas.map(a => ({ a, e: enclaveAt(a.lat, a.lng) })).filter(x => x.e);

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify({
  city: 'Los Angeles',
  citySlug: 'la',
  country: 'US',
  source: 'EmpowerLA — Neighborhood Council Boundaries (2018), City of Los Angeles, all 99',
  generatedAt: new Date().toISOString().slice(0, 10),
  areas,
}, null, 1));

console.log(`gazetteer: ${areas.length} LA neighborhood councils → ${OUT}`);
console.log(`centroids outside the LAPD bbox: ${outside.length}${outside.length ? ' → ' + outside.map(a => a.name).join(', ') : ''}`);
console.log(`centroids inside a non-LAPD enclave: ${inEnclave.length}${inEnclave.length ? ' → ' + inEnclave.map(x => `${x.a.name} (${x.e.name})`).join(', ') : ''}`);
