#!/usr/bin/env node
// tools/build-gazetteer-philly.mjs
//
// Philadelphia gazetteer for the /safety/ pages: the 158 neighbourhood polygons
// the city itself publishes (the Azavea-derived set that OpenDataPhilly, the
// city's own dashboards and basically every Philly map use), grouped under the
// 18 PCPC Planning Districts so Philadelphia gets a multi-district hub like NYC
// (boroughs), London (boroughs), Toronto (former municipalities) and Seattle
// (districts) rather than one unreadable 158-row table.
//
// Why this neighbourhood set and not the other two on the same ArcGIS host:
//   neighborhoods (158)               <- this one. Fine-grained, and the only
//                                        set that names the areas people
//                                        actually search: Rittenhouse, Old
//                                        City, Fishtown, Society Hill,
//                                        Graduate Hospital, Passyunk Square.
//   Philadelphia_Neighborhoods (57)   too coarse — one "Center City" polygon
//                                        swallows Rittenhouse, Old City and
//                                        Washington Square West.
//   Gun_Violence_Dashboard_… (49)     coarser still, and framed around a single
//                                        crime type.
//
// Display name comes from MAPNAME, not LISTNAME: LISTNAME is sort-order text
// ("Mount Airy, East", "Kensington, Old") while MAPNAME is how it is spoken and
// searched ("East Mount Airy", "Old Kensington"). Verified: no nulls, no commas.
//
// The build is LOCAL, so the ArcGIS host only has to be reachable from here —
// unlike the backend's crime fetch, which additionally has to be reachable from
// Render. (phillyProvider uses OpenDataPhilly's Carto SQL API, not this host.)
//
// Output: tools/gazetteer/philly.json
// Run:    node tools/build-gazetteer-philly.mjs

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = join(dirname(fileURLToPath(import.meta.url)), 'gazetteer', 'philly.json');

const HOST = 'https://services.arcgis.com/fLeGjb7u4uXqeF9q/arcgis/rest/services';
const q = (svc, fields) => `${HOST}/${svc}/FeatureServer/0/query` +
  `?where=1%3D1&outFields=${fields}&outSR=4326&resultRecordCount=2000&f=geojson`;

const NBHD_URL = q('neighborhoods', 'NAME,LISTNAME,MAPNAME');
const DIST_URL = q('Planning_Districts', 'dist_name,abbrev');

// phillyProvider.covers() — MUST match. PPD covers the city proper, which is
// coterminous with Philadelphia County, so a plain bbox is exact enough here;
// there are no interlocking foreign enclaves as in Boston.
const BBOX = { minLat: 39.86, maxLat: 40.14, minLng: -75.29, maxLng: -74.95 };

// Areas with no resident population. Their crime counts are near-zero for the
// obvious reason, and an empty feed reads as SAFE — exactly the failure mode
// that put Boston Harbor Islands at the top of the Boston table. Publishing
// "Wissahickon Park is Philadelphia's safest neighbourhood" would be true of
// the data and useless-to-misleading to a reader deciding where to walk.
// Kept deliberately short: only entries that are wholly parkland or airfield.
// Populated-but-quiet areas stay in — that is a real finding, not an artefact.
const EXCLUDE = new Set([
  'wissahickon-park',        // Wissahickon Valley Park — woodland, no residents
  'pennypack-park',          // Pennypack Park — woodland, no residents
  'east-park',               // East Fairmount Park — parkland
  'west-park',               // West Fairmount Park — parkland
  'airport',                 // Philadelphia International (PHL) — airfield
  'northeast-phila-airport', // Northeast Philadelphia Airport — airfield
  // Not a place — a land-use label. This polygon is the Southwest Philadelphia
  // refinery/Penrose belt, and it ranked 4th safest in the city off 36 reports.
  // "Is Industrial safe?" is not a question anyone asks, and answering it 97/100
  // would be the parkland artefact wearing a different hat.
  'industrial',
]);
// DELIBERATELY NOT EXCLUDED, though they also score near the top: Navy Yard (99)
// and Byberry (98) are thinly populated, but they are real, named, searched
// places — Navy Yard is a working corporate campus people commute to, and a
// visitor asking whether it is safe gets an accurate answer. Chestnut Hill,
// Andorra and Torresdale score high because they are genuinely quiet leafy
// neighbourhoods; that is a finding, not an artefact, and it stays.

const slugify = (s) => s
  .normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/['’.]/g, '')
  .replace(/\s*[\/-]\s*/g, '-')
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

// Rough polygon area in km², for the thin-data warning at the end.
function areaKm2(geometry) {
  const polys = geometry.type === 'MultiPolygon' ? geometry.coordinates : [geometry.coordinates];
  let total = 0;
  for (const poly of polys) {
    const ring = poly[0];
    const latRef = ring[0][1];
    let a = 0;
    for (let i = 0; i < ring.length - 1; i++) {
      const [x1, y1] = ring[i], [x2, y2] = ring[i + 1];
      a += x1 * y2 - x2 * y1;
    }
    total += Math.abs(a / 2) * 111.32 * 111.32 * Math.cos(latRef * Math.PI / 180);
  }
  return total;
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
    if (!inRing(lng, lat, poly[0])) continue;
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
  const j = await res.json();
  if (!j.features?.length) throw new Error(`${label}: no features returned`);
  return j;
}

const [nbhd, dist] = await Promise.all([
  getJson(NBHD_URL, 'Philadelphia neighbourhoods'),
  getJson(DIST_URL, 'PCPC planning districts'),
]);

const districts = dist.features
  .filter(f => f.geometry && f.properties?.dist_name)
  .map(f => ({
    name: String(f.properties.dist_name).trim(),
    geometry: f.geometry,
    centroid: centroidOf(f.geometry),
  }));

function districtFor(c) {
  for (const d of districts) if (inGeometry(c.lng, c.lat, d.geometry)) return d.name;
  // Centroid landed on water (both rivers cut through the city) or on an exact
  // border — snap to the nearest district rather than dropping the area.
  let best = districts[0], bd = Infinity;
  for (const d of districts) { const dk = distKm(c, d.centroid); if (dk < bd) { bd = dk; best = d; } }
  return best.name;
}

const dropped = [];
const areas = nbhd.features
  .filter(f => f.geometry && f.properties?.MAPNAME)
  .map(f => {
    const c = centroidOf(f.geometry);
    const name = String(f.properties.MAPNAME).trim();
    return {
      name,
      slug: slugify(name),
      borough: districtFor(c),                 // district grouping for the hub
      lat: +c.lat.toFixed(6),
      lng: +c.lng.toFixed(6),
      _km2: areaKm2(f.geometry),
    };
  })
  .filter(a => {
    if (!EXCLUDE.has(a.slug)) return true;
    dropped.push(a.name);
    return false;
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

const tiny = areas.filter(a => a._km2 < 0.35).map(a => `${a.name} (${a._km2.toFixed(2)}km²)`);
const outside = areas.filter(a =>
  !(a.lat >= BBOX.minLat && a.lat <= BBOX.maxLat && a.lng >= BBOX.minLng && a.lng <= BBOX.maxLng));

for (const a of areas) delete a._km2;

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify({
  city: 'Philadelphia',
  citySlug: 'philly',
  country: 'US',
  source: 'City of Philadelphia / OpenDataPhilly — 158 neighbourhoods, grouped by PCPC Planning District',
  generatedAt: new Date().toISOString().slice(0, 10),
  areas,
}, null, 1));

const byDist = {};
for (const a of areas) byDist[a.borough] = (byDist[a.borough] || 0) + 1;
console.log(`gazetteer: ${areas.length} Philadelphia neighbourhoods → ${OUT}`);
console.log('districts:', Object.entries(byDist).sort((x, y) => y[1] - x[1]).map(([d, n]) => `${d} ${n}`).join(' · '));
console.log(`excluded (no residents): ${dropped.length ? dropped.join(', ') : 'none'}`);
console.log(`centroids outside the PPD bbox: ${outside.length}${outside.length ? ' → ' + outside.map(a => a.name).join(', ') : ''}`);
console.log(`small areas to watch for thin counts (${tiny.length}): ${tiny.slice(0, 12).join(', ')}${tiny.length > 12 ? ' …' : ''}`);
