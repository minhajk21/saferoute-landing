#!/usr/bin/env node
// tools/build-gazetteer-dallas.mjs
//
// Dallas gazetteer from the City of Dallas GIS "Neighborhood Associations"
// layer — 239 polygons on ArcGIS Online, which is the Render-safe host class
// (self-hosted municipal ArcGIS, including the dead gis.dallascityhall.com,
// blocks datacenter IPs; that pattern already cost San Diego and Fort Worth a
// rewrite).
//
// WHY THIS LAYER, GIVEN IT IS NOT A PARTITION OF THE CITY.
// It is an association REGISTRY, not a boundary set: the polygons cover about
// 37% of Dallas land and some overlap. That is fine for what these pages are
// and would not be fine for anything else. Each page describes the kilometre
// around one named place; it never claims to tile the city, and two pages
// whose circles overlap are two honest answers to two different queries. The
// alternative sets are all worse for the one thing that matters: Dallas's
// Socrata portal has no neighborhood boundaries at all, and the ArcGIS
// alternatives are census block groups (numbered — the Charlotte reject),
// 12 target areas (too few) or an HOA mix.
//
// THE NAMES ARRIVE AS ORGANISATIONS, NOT PLACES, so they cannot be used raw:
// "Is Bishop Arts NA Safe?" and "Is Lakewood NA(LNA) Safe?" are broken titles.
// Stripping is deterministic and conservative — it removes the organisational
// wrapper and nothing else, so "Deep Ellum Community Association" becomes
// "Deep Ellum" while "Casa View Heights" is left exactly as it is.
//
// Run: node tools/build-gazetteer-dallas.mjs

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, 'gazetteer', 'dallas.json');
const SRC = 'https://services2.arcgis.com/rwnOSbfKSwyTBcwN/arcgis/rest/services/'
  + 'NeighborhoodAssociations/FeatureServer/0/query'
  + '?where=1%3D1&outFields=ASSO_NAME%2CStatus&returnGeometry=true&outSR=4326'
  + '&resultRecordCount=1000&f=geojson';

// Organisational wrapper, stripped. Order matters: parentheses first, because
// several names carry an acronym that repeats the name itself ("The Uptown NA
// (TUNA)"), and the bare-word pass would otherwise leave "(TUNA)" stranded.
const stripOrg = (s) => s
  .replace(/\s*\([^)]*\)/g, '')
  .replace(/\bNeighborhood\s+Association\b/gi, '')
  .replace(/\bNeighborhood\s+Watch\b/gi, '')
  .replace(/\bCrime\s*Watch\b.*$/gi, '')
  .replace(/\b(?:NA|N\.A\.|HOA)\b/g, '')
  .replace(/\b(?:Association|Assoc\.?|Coalition|Council|Alliance|Committee|Civic\s+League)\b/gi, '')
  .replace(/\bNeighbors?\s+United\b/gi, '')
  // Trailing collective nouns. Two associations can name the same place and
  // differ only here -- "Deep Ellum Community" and "Deep Ellum Neighbors" are
  // one neighborhood -- so these must go before the proximity dedupe can see
  // them as the same row.
  .replace(/\s+(?:Community|Neighbors?|Homeowners?|Residents?|Preservation|Improvement)\s*$/gi, '')
  .replace(/\s*\+.*$/, '')
  .replace(/["“”]/g, '')
  .replace(/\s*\/\s*/g, '/')
  .replace(/\s*[-–,]\s*$/, '')
  .replace(/\s{2,}/g, ' ')
  .replace(/^[\s\-–,"']+|[\s\-–,"']+$/g, '')
  .trim();

// Entries that are not places. Kept as an explicit list rather than a clever
// heuristic, because the failure mode is publishing "Is Monopoly Place Duplexes
// Safe?" and a reader cannot tell that from a real obscure neighborhood.
// Judged on the CLEANED name, never the raw one. Testing the raw name cost two
// of Dallas's best-known neighborhoods on the first pass: "Downtown Residents
// Council" and "Pleasant Grove \"A Community Striving to Thrive\"" are Downtown
// and Pleasant Grove, and both were thrown away by a rule aimed at
// "Park Towers Condominiums" and "Monopoly Place Duplexes".
const NOT_A_PLACE = /duplex|condo|apartment|beautification|bordello|^ave\b|\bave$|development$|^misc|greenbelt|nature\s+center/i;

// An all-caps initialism is an organisation's shorthand, never a place people
// search: SOHIP, RUFCO, PAPA. Allowed to contain digits-free caps only, and
// checked on the CLEANED name so "NW" inside "Bachman/NW Highway" survives.
const IS_ACRONYM = (s) => /^[A-Z]{3,}$/.test(s.replace(/[^A-Za-z]/g, ''));

// Real Dallas places whose registry spelling is not the searched one.
const NAME_FIX = new Map([
  ['The Uptown', 'Uptown'],
  ['Lower Greenville', 'Lower Greenville'],
  ['Pleasant Grove A Community Striving To Thrive', 'Pleasant Grove'],
  ['Fort Worth Ave Development', ''],
  ['Schreiber Community Volunteer', ''],
  ['Neighborhood Planning', ''],
]);

const slugify = (s) => s.toLowerCase()
  .normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/&/g, ' and ')
  .replace(/['’.]/g, '')
  .replace(/[^a-z0-9]+/g, '-')
  .replace(/^-+|-+$/g, '');

const ringsOf = (g) => g?.type === 'Polygon' ? [g.coordinates[0]]
  : g?.type === 'MultiPolygon' ? g.coordinates.map((p) => p[0]) : [];

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

// Degrees squared -> km2, near Dallas's latitude.
const KM2 = (degSq) => degSq * 111.32 * 111.32 * Math.cos(32.78 * Math.PI / 180);

function biggestRing(geom) {
  let best = null, bestA = -1;
  for (const r of ringsOf(geom)) {
    const a = ringArea(r);
    if (a > bestA) { bestA = a; best = r; }
  }
  return { ring: best, area: bestA };
}

function pointInRing([x, y], ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

// A concave association boundary (several wrap a creek or a rail corridor) can
// put its own area-centroid outside itself. Fall back to the midpoint of the
// widest interior horizontal span, which is always inside.
function pointOnSurface(ring) {
  const ys = ring.map((p) => p[1]);
  const y = (Math.min(...ys) + Math.max(...ys)) / 2;
  const xs = [];
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > y) !== (yj > y)) xs.push(xi + ((xj - xi) * (y - yi)) / (yj - yi));
  }
  xs.sort((a, b) => a - b);
  let best = null, span = -1;
  for (let i = 0; i + 1 < xs.length; i += 2) {
    if (xs[i + 1] - xs[i] > span) { span = xs[i + 1] - xs[i]; best = (xs[i] + xs[i + 1]) / 2; }
  }
  return best == null ? null : [best, y];
}

// Found by tools/audit-centroids.mjs, then placed by an interior-point search:
// sample a grid inside the polygon, keep only points at least 250 m from any
// edge, and take the DEEPEST one. That is the built-form rule made mechanical --
// the deepest interior point cannot be sitting on a neighbour's doorstep, so it
// cannot import the next neighborhood's crime the way "just move it to the
// highest count" would. It matters here: Old Lake Highlands' best-count point
// and its deepest point differ by 56 incidents, and Forest Lakes' candidates
// swung 373 to 797 across 250 m because the polygon abuts a commercial strip.
//
//   Hillcrest Forest    60 -> 230
//   Old Lake Highlands  69 -> 404
//   South Central       72 -> 228
const CENTROID_OVERRIDE = new Map([
  ['Hillcrest Forest', [-96.78031, 32.90485]],
  ['Old Lake Highlands', [-96.70934, 32.85691]],
  ['South Central', [-96.74764, 32.71099]],
]);

const havM = (a, b) => {
  const R = 6371000, rad = (d) => (d * Math.PI) / 180;
  const dp = rad(b.lat - a.lat), dl = rad(b.lng - a.lng);
  const q = Math.sin(dp / 2) ** 2 +
    Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dl / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(q));
};

// Under this, a polygon is a single subdivision or one apartment complex, not a
// neighborhood. 73 of the 239 sit below it and they are the ones that produce
// near-duplicate pages: the scoring circle is 3.14 km2, so anything much
// smaller is measuring mostly its neighbours anyway.
const MIN_KM2 = 0.25;

const res = await fetch(SRC, { signal: AbortSignal.timeout(120_000) });
if (!res.ok) throw new Error(`Dallas neighborhood associations HTTP ${res.status}`);
const { features } = await res.json();

const dropped = { notAPlace: [], tooSmall: [], noName: 0, merged: [] };
const byName = new Map();

for (const f of features) {
  const raw = String(f.properties?.ASSO_NAME || '').trim();
  if (!raw) { dropped.noName++; continue; }

  let name = stripOrg(raw);
  name = name.replace(/\b[a-z]/g, (c, i) => (i === 0 || /[\s/-]/.test(name[i - 1])) ? c.toUpperCase() : c);
  name = NAME_FIX.get(name) ?? name;
  if (!name || name.length < 3 || /^\d/.test(name) || IS_ACRONYM(name) || NOT_A_PLACE.test(name)) {
    dropped.notAPlace.push(raw); continue;
  }
  name = name.replace(/\b[a-z]/g, (c, i) => (i === 0 || /[\s/-]/.test(name[i - 1])) ? c.toUpperCase() : c);

  const { ring, area } = biggestRing(f.geometry);
  if (!ring) continue;
  const km2 = KM2(area);
  if (km2 < MIN_KM2) { dropped.tooSmall.push(`${name} (${km2.toFixed(2)} km2)`); continue; }

  // Several places are registered twice (Casa View appears five times). Keep
  // the largest polygon for a given name; it is the one that covers the place
  // rather than one block of it.
  const prev = byName.get(name);
  if (prev && prev.km2 >= km2) { dropped.merged.push(name); continue; }
  if (prev) dropped.merged.push(name);
  byName.set(name, { name, ring, km2, geometry: f.geometry });
}

const areas = [];
for (const { name, ring, geometry } of byName.values()) {
  let c = ringCentroid(ring);
  if (!pointInRing(c, ring)) c = pointOnSurface(ring) ?? c;
  const ov = CENTROID_OVERRIDE.get(name);
  if (ov) {
    if (!ringsOf(geometry).some((r) => pointInRing(ov, r))) {
      throw new Error(`centroid override for "${name}" is outside its own polygon`);
    }
    c = ov;
  }
  areas.push({
    name,
    slug: slugify(name),
    lat: +c[1].toFixed(6),
    lng: +c[0].toFixed(6),
    borough: 'Dallas',
  });
}

// PROXIMITY DEDUPE. The scoring circle is 1 km across, so two centres a few
// hundred metres apart produce two pages describing the same ground, ranked
// against each other for the same query. That is worse than publishing one:
// it splits whatever authority the place earns. Where two survive within
// MIN_SEPARATION_M, keep the one whose polygon is larger -- it is the one that
// covers the place rather than a corner of it.
const MIN_SEPARATION_M = 400;
const km2Of = new Map([...byName.values()].map((v) => [v.name, v.km2]));
areas.sort((a, b) => (km2Of.get(b.name) ?? 0) - (km2Of.get(a.name) ?? 0));
const kept = [];
const tooClose = [];
for (const a of areas) {
  const near = kept.find((k) => havM(a, k) < MIN_SEPARATION_M);
  if (near) { tooClose.push(`${a.name} (${Math.round(havM(a, near))} m from ${near.name})`); continue; }
  kept.push(a);
}
areas.length = 0; areas.push(...kept);

areas.sort((a, b) => a.name.localeCompare(b.name));

const dup = areas.length - new Set(areas.map((a) => a.slug)).size;
if (dup) throw new Error(`${dup} duplicate slug(s) — refusing to write an ambiguous gazetteer`);

const nearest = areas.map((a) =>
  Math.min(...areas.filter((b) => b !== a).map((b) => havM(a, b))));
const sortedN = [...nearest].sort((x, y) => x - y);

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify({
  city: 'Dallas', citySlug: 'dallas', country: 'US',
  source: 'City of Dallas GIS — registered Neighborhood Associations',
  purpose: 'SafeRoute programmatic neighborhood safety pages',
  generatedAt: new Date().toISOString().slice(0, 10),
  areas,
}, null, 2));

console.log(`Dallas gazetteer: ${areas.length} neighborhoods → ${OUT}`);
console.log(`  dropped: ${dropped.notAPlace.length} not-a-place, ${dropped.tooSmall.length} under ${MIN_KM2} km2, ${dropped.merged.length} duplicate registrations, ${tooClose.length} within ${MIN_SEPARATION_M} m of a kept neighbor`);
console.log(`  nearest-centroid spacing: median ${Math.round(sortedN[Math.floor(sortedN.length / 2)])} m, min ${Math.round(sortedN[0])} m`);
if (process.argv.includes('--verbose')) {
  console.log('  not-a-place:', dropped.notAPlace.join(' | '));
  console.log('  too-small:', dropped.tooSmall.slice(0, 20).join(' | '));
  console.log('  too-close:', tooClose.join(' | '));
}
