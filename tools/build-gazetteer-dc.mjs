#!/usr/bin/env node
// tools/build-gazetteer-dc.mjs
//
// Washington, D.C. gazetteer for the /safety/ pages: the District's 132 named
// neighbourhoods (DCGIS "Neighborhood Names", layer 18) — Georgetown, Columbia
// Heights, Anacostia, Capitol Hill, … — each already a point at the
// neighbourhood centre (no polygon-centroid needed), which is exactly what the
// 1-km crime query wants. Grouped by the 8 city Wards (DCGIS "Ward - 2022",
// layer 53) via point-in-polygon, so D.C. gets a multi-district hub like NYC /
// Toronto rather than one 132-row table. Wards are the unit D.C. actually
// governs and reports by, and ward identity is strong in D.C.
//
// Same DCGIS ArcGIS host the backend's dcProvider already uses (Render-safe for
// the crime fetch; here the gazetteer build is local anyway).
//
// Output: tools/gazetteer/dc.json
// Run:    node tools/build-gazetteer-dc.mjs

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = join(dirname(fileURLToPath(import.meta.url)), 'gazetteer', 'dc.json');
const SVC = 'https://maps2.dcgis.dc.gov/dcgis/rest/services/DCGIS_DATA/' +
            'Administrative_Other_Boundaries_WebMercator/MapServer';
const NBHD = `${SVC}/18/query?where=1%3D1&outFields=NAME&outSR=4326&f=json`;
const WARD = `${SVC}/53/query?where=1%3D1&outFields=NAME&outSR=4326&f=json`;

// dcProvider.covers() — MUST match.
const BBOX = { minLat: 38.79, maxLat: 39.00, minLng: -77.12, maxLng: -76.90 };

const slugify = (s) => s
  .normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/['’.]/g, '')
  .replace(/\s*\/\s*/g, '-')
  .replace(/[^A-Za-z0-9]+/g, '-')
  .replace(/^-+|-+$/g, '')
  .toLowerCase();

// Even-odd ray cast for one Esri ring ([lng,lat] pairs).
function inRing(lng, lat, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], yi = ring[i][1], xj = ring[j][0], yj = ring[j][1];
    if (((yi > lat) !== (yj > lat)) && (lng < (xj - xi) * (lat - yi) / (yj - yi) + xi)) inside = !inside;
  }
  return inside;
}
// Point in an Esri polygon (rings = exterior + holes): inside an odd number of rings.
function inWard(lng, lat, rings) {
  let c = 0;
  for (const r of rings) if (inRing(lng, lat, r)) c++;
  return (c % 2) === 1;
}

const distKm = (a, b) => {
  const dLat = (a.lat - b.lat) * 111.32;
  const dLng = (a.lng - b.lng) * 111.32 * Math.cos(a.lat * Math.PI / 180);
  return Math.hypot(dLat, dLng);
};

async function esri(url, label) {
  const res = await fetch(url, { signal: AbortSignal.timeout(60_000) });
  if (!res.ok) throw new Error(`${label}: HTTP ${res.status}`);
  const j = await res.json();
  if (!j.features) throw new Error(`${label}: no features (${JSON.stringify(j).slice(0, 120)})`);
  return j.features;
}

const [nFeat, wFeat] = await Promise.all([esri(NBHD, 'neighbourhoods'), esri(WARD, 'wards')]);

const wards = wFeat.map(f => ({ name: String(f.attributes.NAME).trim(), rings: f.geometry.rings }));
function wardFor(lng, lat) {
  for (const w of wards) if (inWard(lng, lat, w.rings)) return w.name;
  // On a ward line / just outside → nearest ward by centroid-of-first-ring.
  let best = wards[0], bd = Infinity;
  for (const w of wards) {
    const r = w.rings[0]; const cx = r.reduce((s, p) => s + p[0], 0) / r.length, cy = r.reduce((s, p) => s + p[1], 0) / r.length;
    const d = distKm({ lat, lng }, { lat: cy, lng: cx }); if (d < bd) { bd = d; best = w; }
  }
  return best.name;
}

const areas = nFeat
  .filter(f => f.geometry && f.attributes?.NAME)
  .map(f => {
    const lng = f.geometry.x, lat = f.geometry.y;
    const name = String(f.attributes.NAME).trim();
    return { name, slug: slugify(name), borough: wardFor(lng, lat), lat: +lat.toFixed(6), lng: +lng.toFixed(6) };
  })
  .sort((a, b) => a.borough.localeCompare(b.borough, 'en', { numeric: true }) || a.name.localeCompare(b.name));

// De-dupe slugs (keep first).
const seen = new Set();
for (let i = areas.length - 1; i >= 0; i--) {
  if (seen.has(areas[i].slug)) { console.log(`  note: dropped duplicate slug ${areas[i].slug}`); areas.splice(i, 1); }
  else seen.add(areas[i].slug);
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
  city: 'Washington, D.C.',
  citySlug: 'dc',
  country: 'US',
  source: 'DCGIS Open Data — 132 named neighbourhoods (Neighborhood Names), grouped by Ward',
  generatedAt: new Date().toISOString().slice(0, 10),
  areas,
}, null, 1));

const byW = {};
for (const a of areas) byW[a.borough] = (byW[a.borough] || 0) + 1;
console.log(`gazetteer: ${areas.length} D.C. neighbourhoods → ${OUT}`);
console.log('wards:', Object.entries(byW).sort().map(([w, n]) => `${w} ${n}`).join(' · '));
console.log('sample:', areas.slice(0, 6).map(a => `${a.name} [${a.borough}]`).join(' · '));
console.log(`centroids outside the MPD bbox: ${outside.length}${outside.length ? ' → ' + outside.map(a => a.name).join(', ') : ''}`);
