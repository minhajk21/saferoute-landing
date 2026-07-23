#!/usr/bin/env node
// tools/snap-la-centroids.mjs
//
// Some LA neighbourhood councils include large parkland or hillside — Los Feliz
// spans Griffith Park, Hollywood United the Santa Monica Mountains, Bel Air the
// hills — so the area-weighted polygon centroid lands where almost nobody walks.
// A 1km disc there returns a handful of incidents and the page publishes as
// "99/100, low risk" for a genuinely busy neighbourhood: the falsely-safe
// failure mode again.
//
// Fix: for councils whose centroid disc is sparse, probe a grid of points inside
// the council polygon and move the query point to the densest one — the
// populated core rather than the geometric middle. Proven by hand: Los Feliz's
// centroid returns 5 incidents, its commercial core (Vermont/Hillhurst) ~320.
//
// Only low-density councils are re-probed, so this is cheap. Rewrites tools/
// gazetteer/la.json in place, recording the original centroid for auditability.
//
// Run (local backend with LA provider):
//   SAFEROUTE_API_KEY=… SAFEROUTE_BASE_URL=http://localhost:3111 node tools/snap-la-centroids.mjs

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const GAZ = join(ROOT, 'tools', 'gazetteer', 'la.json');
const SVC = 'https://services5.arcgis.com/7nsPwEMP38bSkCjy/arcgis/rest/services/' +
            'Neighborhood_Council_Boundaries_2018_City_of_Los_Angeles/FeatureServer/0';
const BASE = process.env.SAFEROUTE_BASE_URL || 'http://localhost:3111';
const KEY = process.env.SAFEROUTE_API_KEY;
if (!KEY) { console.error('SAFEROUTE_API_KEY required'); process.exit(1); }

const THRESHOLD = 120;   // incident count below which a council is re-probed
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function density(lat, lng) {
  try {
    const r = await fetch(`${BASE}/area-safety?lat=${lat.toFixed(5)}&lng=${lng.toFixed(5)}&radius=1000`,
      { headers: { 'X-SafeRoute-Key': KEY }, signal: AbortSignal.timeout(60_000) });
    if (!r.ok) return null;
    const j = await r.json();
    if (j.dataUnavailable) return null;
    return { n: j.totalIncidents, d: j.densityPerKm2 };
  } catch { return null; }
}

// Point-in-polygon (ray cast) over the largest ring, so candidate points stay
// inside the council rather than drifting into a neighbour.
function rings(geometry) {
  const polys = geometry.type === 'MultiPolygon' ? geometry.coordinates : [geometry.coordinates];
  let best = null, bestArea = -1;
  for (const poly of polys) {
    const r = poly[0];
    let a = 0;
    for (let i = 0; i < r.length - 1; i++) a += r[i][0] * r[i + 1][1] - r[i + 1][0] * r[i][1];
    if (Math.abs(a) > bestArea) { bestArea = Math.abs(a); best = r; }
  }
  return best;
}
function inside(ring, lng, lat) {
  let hit = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if (((yi > lat) !== (yj > lat)) && (lng < (xj - xi) * (lat - yi) / (yj - yi) + xi)) hit = !hit;
  }
  return hit;
}
const bounds = ring => ring.reduce((b, [x, y]) => ({
  minLng: Math.min(b.minLng, x), maxLng: Math.max(b.maxLng, x),
  minLat: Math.min(b.minLat, y), maxLat: Math.max(b.maxLat, y),
}), { minLng: 180, maxLng: -180, minLat: 90, maxLat: -90 });

const gaz = JSON.parse(readFileSync(GAZ));

// Only re-probe councils already known to be sparse, from the generated data —
// no point spending a base probe on the 80+ that are clearly populated. Falls
// back to probing everything if the data cache isn't present.
let candidates = gaz.areas;
try {
  const { readdirSync } = await import('node:fs');
  const dir = join(ROOT, 'tools', 'data-cache', 'la');
  const thin = new Set(readdirSync(dir)
    .map(f => JSON.parse(readFileSync(join(dir, f))))
    .filter(a => a.totalIncidents < THRESHOLD)
    .map(a => a.slug));
  candidates = gaz.areas.filter(a => thin.has(a.slug) && !a.centroidSnapped);
  console.log(`${thin.size} sparse councils in the data cache, ${candidates.length} still to snap`);
} catch { console.log('no data cache — probing all councils'); }

console.log('fetching council polygons…');
const geo = await (await fetch(`${SVC}/query?where=1%3D1&outFields=Name&outSR=4326&f=geojson`,
  { signal: AbortSignal.timeout(120_000) })).json();
const ringByName = new Map(geo.features.map(f => [String(f.properties.Name).trim(), rings(f.geometry)]));

let snapped = 0, kept = 0;
for (const a of candidates) {
  const base = await density(a.lat, a.lng);
  await sleep(800);
  if (base && base.n >= THRESHOLD) { kept++; continue; }

  const ring = ringByName.get(a.name);
  if (!ring) { console.log(`  ${a.name}: no polygon, left as-is`); kept++; continue; }

  // 6×6 candidate grid clipped to the polygon; pick the densest.
  const b = bounds(ring);
  const cand = [];
  for (let i = 1; i <= 6; i++) for (let j = 1; j <= 6; j++) {
    const lng = b.minLng + (b.maxLng - b.minLng) * i / 7;
    const lat = b.minLat + (b.maxLat - b.minLat) * j / 7;
    if (inside(ring, lng, lat)) cand.push({ lat, lng });
  }
  let best = { lat: a.lat, lng: a.lng, n: base ? base.n : 0 };
  for (const c of cand) {
    const d = await density(c.lat, c.lng);
    await sleep(800);
    if (d && d.n > best.n) best = { ...c, n: d.n };
  }

  if (best.lat !== a.lat || best.lng !== a.lng) {
    a.centroidOrig = { lat: a.lat, lng: a.lng };
    a.lat = +best.lat.toFixed(6); a.lng = +best.lng.toFixed(6);
    a.centroidSnapped = true;
    snapped++;
    console.log(`  ${a.name.padEnd(28)} ${base ? base.n : 0} → ${best.n} incidents  (moved to populated core)`);
  } else {
    kept++;
    console.log(`  ${a.name.padEnd(28)} ${base ? base.n : 0} incidents — no denser point inside polygon, left as-is`);
  }
  // Persist after each council so a timeout or restart never loses progress and
  // the run resumes where it left off (centroidSnapped areas are skipped above).
  writeFileSync(GAZ, JSON.stringify(gaz, null, 1));
}

console.log(`\nsnapped ${snapped}, kept ${kept}. Re-run generate-data --city la to refresh.`);
