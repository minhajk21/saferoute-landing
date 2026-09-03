#!/usr/bin/env node
// tools/build-gazetteer-neworleans.mjs
//
// New Orleans gazetteer from the city's 72 NEIGHBORHOOD STATISTICAL AREAS
// (the GNOCDC set), published on data.nola.gov as `exvn-jeh2`.
//
// WHY THIS BOUNDARY SET
// It is the set New Orleanians actually name — French Quarter, Marigny,
// Bywater, Garden District, Tremé, Algiers Point — and it is the one the city
// itself reports against. There is no competing "neighborhood" layer to weigh
// it against: 72 areas, stable since the GNOCDC work, and every famous name
// present.
//
// TWO AREAS ARE DROPPED. "U.S. NAVAL BASE" is a military installation, not a
// place anybody walks as a neighborhood — the same call San Diego's MILITARY
// FACILITIES got. "LAKE CATHERINE" is dropped for a different and more
// uncomfortable reason: it is a real place (a fishing community strung along
// Chef Menteur Highway out by the Rigolets) but the OPCD feed carries no
// dispatches anywhere inside it — not at the polygon centre, not over the
// houses. A page for it could only say "0 incidents, 100/100, low risk", which
// is not a finding about Lake Catherine, it is the absence of one. Publishing
// that is the falsely-quiet failure this project refuses to ship, so the area
// gets no page rather than a reassuring blank one.
//
// ONE CENTROID IS MOVED. Several eastern NSAs are mostly wetland with the
// houses pushed into one corner, so the largest-ring centroid lands in open
// marsh and scores an empty circle. Village de l'Est is the case that matters:
// its geometric centre is a mile out in the marsh (0 dispatches), while the
// Versailles settlement it actually names — the Vietnamese-American community
// around Alcee Fortier Blvd — is built-up and does have a record. The override
// below is asserted to be INSIDE the polygon at build time, so this can move a
// centre to where people are but can never move it to another neighborhood.
//
// WHAT IS DELIBERATELY *NOT* DROPPED: the former public-housing developments
// (B. W. Cooper, Iberville, Fischer, Florida, St. Thomas). San Diego dropped
// "reserve areas" because they are structurally not neighborhoods. These are
// the opposite — real residential areas where people live and walk. Removing
// them would erase precisely the neighborhoods most likely to be talked about
// and least likely to be described carefully, which is the failure this whole
// project exists to avoid. They stay, scored on the same feed as everywhere
// else.
//
// Run: node tools/build-gazetteer-neworleans.mjs

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, 'gazetteer', 'neworleans.json');
const SRC = 'https://data.nola.gov/resource/exvn-jeh2.json?$limit=200';

// Names arrive SHOUTED ("LOWER GARDEN DISTRICT"). Title-case them, but keep
// the forms people actually write: "St." stays "St.", "McDonogh" keeps its
// interior capital, and the small words inside a name stay lowercase.
const SMALL = new Set(['of', 'the', 'and', 'at', 'on', 'in', 'de']);
const FIXED = new Map([
  ['mcdonogh', 'McDonogh'],
  ['b.', 'B.'], ['w.', 'W.'], ['u.s.', 'U.S.'],
]);

function titleCase(s) {
  return s.toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[^\s/-]+/g, (w, i) => {
      if (FIXED.has(w)) return FIXED.get(w);
      if (i > 0 && SMALL.has(w)) return w;
      return w.charAt(0).toUpperCase() + w.slice(1);
    });
}

const slugify = (s) => s.toLowerCase()
  .normalize('NFD').replace(/[\u0300-\u036f]/g, '')   // Tremé → treme, not trem-
  .replace(/&/g, ' and ')
  .replace(/['’.]/g, '')
  .replace(/[^a-z0-9]+/g, '-')
  .replace(/^-+|-+$/g, '');

// The feed SHOUTS its labels and strips accents and apostrophes, so title-casing
// alone yields names that are simply misspelt: "Village de Lest" is not a place.
// These restore the spelling New Orleanians (and search engines) actually use.
// Slugs are unaffected — slugify folds diacritics and drops apostrophes.
const NAME_FIX = new Map([
  ['Village de Lest', "Village de l'Est"],
  ['Treme - Lafitte', 'Tremé - Lafitte'],
  ['Fischer Dev', 'Fischer Development'],
  ['Florida Dev', 'Florida Development'],
  ['St. Thomas Dev', 'St. Thomas Development'],
]);

const NOT_A_NEIGHBOURHOOD = /^(U\.?S\.? NAVAL BASE|LAKE CATHERINE)\b/i;

// name → [lng, lat] of the built-up core, for areas whose geometric centre is
// uninhabited. Verified point-in-polygon below; a miss is a hard build error.
const CENTROID_OVERRIDE = new Map([
  ['VILLAGE DE LEST', [-89.9265, 30.0575]],   // Versailles, off Alcee Fortier Blvd
]);

/// Ray-cast point-in-polygon, used only to prove an override is honest.
function pointInRing([x, y], ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function ringsOf(geom) {
  return geom?.type === 'Polygon' ? [geom.coordinates[0]]
       : geom?.type === 'MultiPolygon' ? geom.coordinates.map((p) => p[0])
       : [];
}

// Shoelace centroid on the LARGEST ring. A plain vertex mean drifts toward
// whichever edge is most finely digitised — in New Orleans that is the river
// and the lake, so every waterfront neighborhood would have its centre pulled
// into the water.
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

const ringArea = (ring) => {
  let a = 0;
  for (let i = 0, n = ring.length - 1; i < n; i++) {
    const [x0, y0] = ring[i], [x1, y1] = ring[i + 1];
    a += x0 * y1 - x1 * y0;
  }
  return Math.abs(a / 2);
};

/// Largest-ring centroid, so a neighborhood that includes detached parcels
/// still centres on its mainland body.
function centroidOf(geom) {
  const rings = geom?.type === 'Polygon' ? [geom.coordinates[0]]
              : geom?.type === 'MultiPolygon' ? geom.coordinates.map((p) => p[0])
              : [];
  let best = null, bestA = -1;
  for (const r of rings) {
    const a = ringArea(r);
    if (a > bestA) { bestA = a; best = r; }
  }
  return best ? ringCentroid(best) : null;
}

const havM = (a, b) => {
  const R = 6371000, rad = (d) => (d * Math.PI) / 180;
  const dp = rad(b.lat - a.lat), dl = rad(b.lng - a.lng);
  const q = Math.sin(dp / 2) ** 2 +
    Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dl / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(q));
};

const res = await fetch(SRC, { signal: AbortSignal.timeout(120_000) });
if (!res.ok) throw new Error(`NOLA Neighborhood Statistical Areas HTTP ${res.status}`);
const rows = await res.json();

const areas = [];
const dropped = [];
const overridden = [];
for (const r of rows) {
  const raw = String(r.gnocdc_lab || '').trim();
  if (!raw) continue;
  if (NOT_A_NEIGHBOURHOOD.test(raw)) { dropped.push(raw); continue; }
  let c = centroidOf(r.the_geom);
  if (!c) continue;
  const ov = CENTROID_OVERRIDE.get(raw.toUpperCase().replace(/[’']/g, ''));
  if (ov) {
    if (!ringsOf(r.the_geom).some((ring) => pointInRing(ov, ring))) {
      throw new Error(`centroid override for "${raw}" is outside its own polygon — refusing to move a neighborhood off itself`);
    }
    c = ov;
    overridden.push(raw);
  }
  const cased = titleCase(raw);
  const name = NAME_FIX.get(cased) ?? cased;
  areas.push({
    name,
    slug: slugify(name),
    lat: +c[1].toFixed(6),
    lng: +c[0].toFixed(6),
    // Single-tier city, like San Diego: one ranked table on the hub. The
    // neigh_id prefixes run 1-20 and do not correspond to the city's own
    // planning districts, so grouping on them would invent a geography New
    // Orleanians do not use.
    borough: 'New Orleans',
  });
}

areas.sort((a, b) => a.name.localeCompare(b.name));

const dup = areas.length - new Set(areas.map((a) => a.slug)).size;
if (dup) throw new Error(`${dup} duplicate slug(s) — refusing to write an ambiguous gazetteer`);

// Boundary-spacing gate: pages must describe distinguishable places, not
// overlapping 1 km discs. DC is the tightest city published (median ~700 m).
const nearest = areas.map((a) =>
  Math.min(...areas.filter((b) => b !== a).map((b) => havM(a, b))));
const sorted = [...nearest].sort((x, y) => x - y);
const median = sorted[Math.floor(sorted.length / 2)];

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify({
  city: 'New Orleans', citySlug: 'neworleans', country: 'US',
  source: 'City of New Orleans — Neighborhood Statistical Areas (GNOCDC)',
  purpose: 'Safety pages + calibration. See this script\'s header for what is dropped and, more importantly, what is not.',
  generatedAt: new Date().toISOString().slice(0, 10),
  areas,
}, null, 2) + '\n');

console.log(`new orleans gazetteer: ${areas.length} neighborhoods → ${OUT}`);
if (dropped.length) console.log(`  dropped ${dropped.length}: ${dropped.join(', ')}`);
if (overridden.length) console.log(`  centroid moved to built-up core: ${overridden.join(', ')}`);
console.log(`  nearest-centroid spacing: median ${Math.round(median)} m, min ${Math.round(sorted[0])} m`);
console.log(`  gate: DC (tightest published) is ~700 m median → ${median >= 700 ? 'PASS' : 'REVIEW'}`);
