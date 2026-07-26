#!/usr/bin/env node
// tools/build-gazetteer-toronto.mjs
//
// Toronto gazetteer for the /safety/ pages: the City of Toronto's 158 official
// neighbourhoods (the 2021 set the city itself reports on — Neighbourhood
// Profiles, etc.). Each neighbourhood is the page unit; we group them under the
// six former municipalities (Old Toronto, North York, Scarborough, Etobicoke,
// East York, York) so Toronto gets a multi-district hub like NYC (boroughs),
// London (boroughs) and Seattle (districts) rather than one 158-row table.
//
// Both boundary sets come from Toronto Open Data (CKAN). The gazetteer build is
// LOCAL, so CKAN's host (not Render-safe) is fine here — only the backend crime
// fetch must run from a Render-safe host, and that's TPS's ArcGIS Online, which
// it already does. Districts are assigned by point-in-polygon of each
// neighbourhood centroid against the former-municipality polygons.
//
// Output: tools/gazetteer/toronto.json
// Run:    node tools/build-gazetteer-toronto.mjs

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = join(dirname(fileURLToPath(import.meta.url)), 'gazetteer', 'toronto.json');

// Toronto Open Data — current 158 neighbourhoods + former municipality boundaries (WGS84).
const NBHD_URL = 'https://ckan0.cf.opendata.inter.prod-toronto.ca/dataset/' +
  'fc443770-ef0a-4025-9c2c-2cb558bfab00/resource/0719053b-28b7-48ea-b863-068823a93aaa/' +
  'download/neighbourhoods-4326.geojson';
const FM_URL = 'https://ckan0.cf.opendata.inter.prod-toronto.ca/dataset/' +
  '833937f6-e190-49a2-9835-80137cf88c41/resource/4eadc3a3-bafa-44cf-a43f-f99a7fa98eb4/' +
  'download/former-municipality-boundaries-data-4326.geojson';

// torontoProvider.covers() — MUST match. TPS covers the City of Toronto only.
const BBOX = { minLat: 43.58, maxLat: 43.86, minLng: -79.64, maxLng: -79.12 };

// Pretty district label. The former City of Toronto is universally called
// "Old Toronto" to distinguish the pre-amalgamation core from the amalgamated city.
const DISTRICT = {
  'TORONTO': 'Old Toronto', 'NORTH YORK': 'North York', 'EAST YORK': 'East York',
  'SCARBOROUGH': 'Scarborough', 'ETOBICOKE': 'Etobicoke', 'YORK': 'York',
};

const slugify = (s) => s
  .normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/['’.]/g, '')
  .replace(/\s*\/\s*/g, '-')
  .replace(/[^A-Za-z0-9]+/g, '-')
  .replace(/^-+|-+$/g, '')
  .toLowerCase();

// Area-weighted centroid of a polygon's largest ring (skips slivers/islands).
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

// Even-odd ray casting for a single [lng,lat] ring.
function inRing(lng, lat, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], yi = ring[i][1], xj = ring[j][0], yj = ring[j][1];
    const hit = ((yi > lat) !== (yj > lat)) &&
      (lng < (xj - xi) * (lat - yi) / (yj - yi) + xi);
    if (hit) inside = !inside;
  }
  return inside;
}

// Point in a (Multi)Polygon: inside an exterior ring and outside its holes.
function inGeometry(lng, lat, geometry) {
  const polys = geometry.type === 'MultiPolygon' ? geometry.coordinates : [geometry.coordinates];
  for (const poly of polys) {
    if (!inRing(lng, lat, poly[0])) continue;            // outside this exterior ring
    let inHole = false;
    for (let h = 1; h < poly.length; h++) if (inRing(lng, lat, poly[h])) { inHole = true; break; }
    if (!inHole) return true;
  }
  return false;
}

const distKm = (a, b) => {
  const dLat = (a.lat - b.lat) * 111.32;
  const dLng = (a.lng - b.lng) * 111.32 * Math.cos(a.lat * Math.PI / 180);
  return Math.hypot(dLat, dLng);
};

async function getJson(url, label) {
  const res = await fetch(url, { signal: AbortSignal.timeout(120_000) });
  if (!res.ok) throw new Error(`${label}: HTTP ${res.status}`);
  return res.json();
}

const [nbhd, fm] = await Promise.all([
  getJson(NBHD_URL, 'Toronto neighbourhoods'),
  getJson(FM_URL, 'former municipalities'),
]);

// Former-municipality polygons + a centroid each (fallback for border cases).
const municipalities = fm.features
  .filter(f => f.geometry && f.properties?.AREA_NAME)
  .map(f => ({
    name: DISTRICT[String(f.properties.AREA_NAME).trim().toUpperCase()] || String(f.properties.AREA_NAME).trim(),
    geometry: f.geometry,
    centroid: centroidOf(f.geometry),
  }));

function districtFor(c) {
  for (const m of municipalities) if (inGeometry(c.lng, c.lat, m.geometry)) return m.name;
  // Centroid landed on water / exact border — snap to the nearest municipality.
  let best = municipalities[0], bd = Infinity;
  for (const m of municipalities) { const d = distKm(c, m.centroid); if (d < bd) { bd = d; best = m; } }
  return best.name;
}

const areas = nbhd.features
  .filter(f => f.geometry && f.properties?.AREA_NAME)
  .map(f => {
    const c = centroidOf(f.geometry);
    // Names arrive as "South Eglinton-Davisville"; drop any trailing "(174)" code.
    const name = String(f.properties.AREA_NAME).replace(/\s*\(\d+\)\s*$/, '').trim();
    return {
      name,
      slug: slugify(name),
      borough: districtFor(c),                 // district grouping for the hub
      lat: +c.lat.toFixed(6),
      lng: +c.lng.toFixed(6),
    };
  })
  .sort((a, b) => a.borough.localeCompare(b.borough) || a.name.localeCompare(b.name));

// Defensive slug de-dupe (keep first).
const seen = new Set();
for (let i = areas.length - 1; i >= 0; i--) {
  if (seen.has(areas[i].slug)) { console.log(`  note: dropped duplicate slug ${areas[i].slug}`); areas.splice(i, 1); }
  else seen.add(areas[i].slug);
}

// 5 nearest neighbours (for the "nearby areas" cross-links).
for (const a of areas) {
  a.neighbors = areas.filter(b => b !== a)
    .map(b => ({ slug: b.slug, d: distKm(a, b) }))
    .sort((x, y) => x.d - y.d).slice(0, 5).map(n => n.slug);
}

const outside = areas.filter(a =>
  !(a.lat >= BBOX.minLat && a.lat <= BBOX.maxLat && a.lng >= BBOX.minLng && a.lng <= BBOX.maxLng));

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify({
  city: 'Toronto',
  citySlug: 'toronto',
  country: 'CA',
  source: 'City of Toronto Open Data — 158 neighbourhoods, grouped by former municipality',
  generatedAt: new Date().toISOString().slice(0, 10),
  areas,
}, null, 1));

const byDist = {};
for (const a of areas) byDist[a.borough] = (byDist[a.borough] || 0) + 1;
console.log(`gazetteer: ${areas.length} Toronto neighbourhoods → ${OUT}`);
console.log('districts:', Object.entries(byDist).map(([d, n]) => `${d} ${n}`).join(' · '));
console.log('sample:', areas.slice(0, 6).map(a => `${a.name} [${a.borough}]`).join(' · '));
console.log(`centroids outside the TPS bbox: ${outside.length}${outside.length ? ' → ' + outside.map(a => a.name).join(', ') : ''}`);
