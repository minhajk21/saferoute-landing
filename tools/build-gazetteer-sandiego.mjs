#!/usr/bin/env node
// tools/build-gazetteer-sandiego.mjs
//
// San Diego gazetteer from the City's 61 COMMUNITY PLAN AREAS, published by
// SANDAG as a single GeoJSON.
//
// WHY COMMUNITY PLAN AREAS
// They are the boundary set San Diegans actually name — North Park, Pacific
// Beach, La Jolla, Hillcrest, Ocean Beach — and they are coarse enough to
// clear the boundary-spacing gate with room to spare: median nearest-centroid
// distance 2,642 m against DC's 700 m (the tightest city published), and a
// minimum of 1,103 m, so no two pages describe overlapping circles. Median
// area is ~11 km², comfortably larger than the 1 km scoring disc.
//
// SIX AREAS ARE NOT NEIGHBOURHOODS and are dropped. Five of them say so in
// their own name ("RESERVE AREA-Not a community plan") and the sixth is
// "MILITARY FACILITIES". Publishing a safety page for a military base or an
// unplanned reserve would be thin content about somewhere nobody walks —
// the same lesson Long Beach taught, where a quarter of the "areas" turned
// out to be marinas and power stations.
//
// NOTE ON THE HOST: SANDAG's geo server is used at BUILD time only, from a
// developer machine. That matters because San Diego's own webmaps.sandiego.gov
// blocks Render's datacenter IP — irrelevant here, since the gazetteer is
// committed and the backend never fetches boundaries at runtime.
//
// Run: node tools/build-gazetteer-sandiego.mjs

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, 'gazetteer', 'sandiego.json');
const SRC = 'https://geo.sandag.org/server/rest/directories/downloads/Community_Plan_SD.geojson';

// Names arrive SHOUTED ("NORTH PARK"); title-case them, but keep the short
// forms people write as-is rather than inventing an expansion.
const SMALL = new Set(['of', 'the', 'and', 'at', 'on', 'in']);
const titleCase = (s) => s.toLowerCase().replace(/[^\s/-]+/g, (w, i) =>
  (i > 0 && SMALL.has(w)) ? w : w.charAt(0).toUpperCase() + w.slice(1));

const slugify = (s) => s.toLowerCase()
  .replace(/&/g, ' and ')
  .replace(/[''']/g, '')
  .replace(/[^a-z0-9]+/g, '-')
  .replace(/^-+|-+$/g, '');

// Not a neighbourhood: five reserve areas that say so themselves, plus the
// military parcels. Anchored so a real name containing "reserve" survives.
const NOT_A_NEIGHBOURHOOD = /^(MILITARY FACILITIES|RESERVE AREA)/i;

// Shoelace centroid on the LARGEST ring. A plain vertex mean drifts toward
// whichever edge is most finely digitised, which in San Diego is the coast —
// every ocean-facing area would pull its centre out to sea.
function ringCentroid(ring) {
  let a = 0, cx = 0, cy = 0;
  for (let i = 0, n = ring.length - 1; i < n; i++) {
    const [x0, y0] = ring[i], [x1, y1] = ring[i + 1];
    const f = x0 * y1 - x1 * y0;
    a += f; cx += (x0 + x1) * f; cy += (y0 + y1) * f;
  }
  if (Math.abs(a) < 1e-12) {
    const m = ring.reduce((p, c) => [p[0] + c[0], p[1] + c[1]], [0, 0]);
    return [m[0] / ring.length, m[1] / ring.length];
  }
  a *= 0.5;
  return [cx / (6 * a), cy / (6 * a)];
}

function ringArea(ring) {
  let a = 0;
  for (let i = 0, n = ring.length - 1; i < n; i++) {
    const [x0, y0] = ring[i], [x1, y1] = ring[i + 1];
    a += x0 * y1 - x1 * y0;
  }
  return Math.abs(a / 2);
}

// Centroids that land on open ground rather than the place the area is named
// for, with the built-up point they move to. Asserted INSIDE the polygon at
// build time, so an override can move a page to where people are but never onto
// a neighbouring community.
//
// La Jolla was found by the 2026-09 all-cities audit. San Diego's Community
// Plan Areas are coarse — 2,642 m median centre spacing, the loosest in the
// project — and La Jolla's geometric centre landed on the Mount Soledad
// hillside: 33 incidents, 79/100. The two places the name actually denotes
// measure 174 (the Village) and 159 (the Shores), both scoring 44. "Is La Jolla
// safe" is a high-volume query and the page was answering it about a hillside.
//
// Chosen for BUILT FORM: the Village is the walkable core the question is
// really about, not the highest-count point.
const CENTROID_OVERRIDE = new Map([
  ['La Jolla', [-117.2740, 32.8470]],   // the Village — Girard Ave / Prospect St
]);

function pointInRing([x, y], ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

const ringsOf = (g) => g?.type === 'Polygon' ? [g.coordinates[0]]
  : g?.type === 'MultiPolygon' ? g.coordinates.map((p) => p[0]) : [];

/// Largest-ring centroid, so a community that includes offshore or detached
/// parcels is still centred on its mainland body.
function centroidOf(geom) {
  const rings = geom.type === 'Polygon' ? [geom.coordinates[0]]
              : geom.type === 'MultiPolygon' ? geom.coordinates.map((p) => p[0])
              : [];
  let best = null, bestA = -1;
  for (const r of rings) {
    const a = ringArea(r);
    if (a > bestA) { bestA = a; best = r; }
  }
  return best ? ringCentroid(best) : null;
}

const res = await fetch(SRC, { signal: AbortSignal.timeout(120_000) });
if (!res.ok) throw new Error(`SANDAG community plan GeoJSON HTTP ${res.status}`);
const gj = await res.json();

const areas = [];
let dropped = [];
const moved = [];
for (const f of gj.features || []) {
  const raw = String(f.properties?.CPNAME || '').trim();
  if (!raw) continue;
  if (NOT_A_NEIGHBOURHOOD.test(raw)) { dropped.push(raw); continue; }
  let c = centroidOf(f.geometry || {});
  if (!c) continue;
  const name = titleCase(raw);
  const ov = CENTROID_OVERRIDE.get(name);
  if (ov) {
    if (!ringsOf(f.geometry || {}).some((r) => pointInRing(ov, r))) {
      throw new Error(`centroid override for "${name}" is outside its own polygon — refusing to move a page onto a neighbouring community`);
    }
    c = ov; moved.push(name);
  }
  areas.push({
    name,
    slug: slugify(name),
    lat: +c[1].toFixed(6),
    lng: +c[0].toFixed(6),
    // Single-tier city: one ranked table on the hub, so borough is the city.
    borough: 'San Diego',
  });
}

areas.sort((a, b) => a.name.localeCompare(b.name));

const dup = areas.length - new Set(areas.map((a) => a.slug)).size;
if (dup) throw new Error(`${dup} duplicate slug(s) — refusing to write an ambiguous gazetteer`);

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify({
  city: 'San Diego', citySlug: 'sandiego', country: 'US',
  source: 'SANDAG / City of San Diego — Community Plan Areas',
  purpose: 'Safety pages + calibration. Community plan areas, not census tracts: see the header of this script for why.',
  generatedAt: new Date().toISOString().slice(0, 10),
  areas,
}, null, 2) + '\n');
console.log(`san diego gazetteer: ${areas.length} community plan areas → ${OUT}`);
if (dropped.length) console.log(`  dropped ${dropped.length} non-neighbourhood: ${dropped.join(', ')}`);
if (moved.length) console.log(`  centroid moved to the built-up core: ${moved.join(', ')}`);
