#!/usr/bin/env node
// tools/build-gazetteer-calibration.mjs
//
// Area sets for measuring a region's normaliser against every real
// neighbourhood instead of a sample.
//
// EVERY CITY IN HERE IS NOW PUBLISHED, AND REBUILDING ONE IS A REGRESSION
// This file used to open with "area sets for regions that are CALIBRATED but
// not PUBLISHED", and promised a few lines later that "these cities have no
// /safety/ pages". Both sentences are now false. denver, baltimore, longbeach
// and vancouver each have a live page set under safety/<id>/ and an entry in
// CITIES in tools/render-pages.mjs. They graduated one at a time and the header
// did not follow — which is why the guard below works out what is published by
// reading the repo instead of trusting a list kept in this file.
//
// Running this over one of them does not refresh its pages. It damages them,
// in two different ways depending on the city:
//
//   THE AREAS ARE RIGHT, THE FIELDS ARE NOT — denver, vancouver
//   Nothing here emits `borough`. render-pages.mjs groups the city hub by that
//   field and calls b.toLowerCase() on it, so a regenerated gazetteer does not
//   render a slightly worse page — it throws, and takes the build down with it.
//   Single-tier cities set the field to the city name so that exactly one
//   ranked table renders (the convention Chicago and SF use). It was
//   hand-backfilled into these two, and into baltimore, in 05a8cb25, from the
//   already-fetched caches rather than by re-fetching 154 areas. This script
//   never learned to emit it, so a rebuild silently drops it again.
//
//   THE AREAS THEMSELVES ARE WRONG — longbeach, baltimore
//   longbeach comes back as all 123 boundary areas. The published set is the
//   curated 96 of 73f0dbe6, which dropped 25 "Unassigned" marina, park and
//   power-station fragments, a bare "AOC7" planning code and a duplicate — and
//   the backend normaliser was then refitted 241 -> 326 FOR those 96. Restoring
//   the fragments would re-add thin pages AND leave the city scored by a
//   constant fitted to a different area set, which is the worse half.
//   baltimore comes back as the 256-polygon NSA layer, replacing the published
//   56 Community Statistical Areas that build-gazetteer-baltimore.mjs exists to
//   produce. Those 56 are not a stylistic preference: 256 NSAs sit a median
//   566 m apart, finer than the 1 km index radius, so adjacent pages would
//   describe overlapping circles and read as near-duplicates.
//
// So if a published city here ever needs new boundaries, it needs a per-city
// builder (as baltimore has) and removal from CITIES below — not a run of this.
// The guard refuses any published city unless you name it on the command line
// AND pass --force-published, and a bare run builds only the genuinely
// unpublished sets. Bare used to mean all four at once, which is precisely the
// accident worth engineering against: an argument-free run of a build-gazetteer
// script does not read like "overwrite four live cities", and it was.
//
// WHY A SHARED FILE, NOT ONE PER CITY
// The per-city builders (build-gazetteer-philly.mjs and friends) exist because
// an SEO city needs bespoke decisions: which of three competing neighbourhood
// sets to use, how to group them into districts, which display name people
// actually search. None of that applies to a set that only ever has to be
// measured: the area set exists solely so the normaliser can be fitted against
// a whole city. That is one job, so it is one file, and that reasoning still
// holds for a city that is genuinely calibration-only. Watch what happened to
// the other half of it, though. It closed with "if one of them ever graduates
// to a published city, give it its own builder then" — and when all four
// graduated, only baltimore got one. The other three stayed pointed at this
// script, which is how a builder for unpublished cities turned into a way to
// break live pages.
//
// WHY THIS EXISTS AT ALL
// Calibrating from OSM place=suburb nodes was tried and produced numbers that
// moved more than the error being chased — Houston read "too soft" from 384
// mostly-suburban OSM nodes, then measured too HARSH once all 88 official Super
// Neighborhoods were used. Median-of-a-sample is not median-of-a-city. A real
// published area set is the only input that settles it.
//
// NOT INCLUDED, deliberately:
//   nashville   Metro Nashville publishes 14 Community Planning Areas, which are
//               official and DO tile the county — but they average ~93 km², and
//               the calibrator measures a 1km disc (3.14 km²) at each centroid.
//               That samples 3% of each area, and in a sprawling subarea the
//               centroid sits in the quiet middle rather than the dense core, so
//               it would read systematically LOW and hand Nashville a too-
//               generous constant. Compare: the disc covers 60% of a Denver
//               neighbourhood and 304% of a Long Beach one. A tiling set is not
//               automatically a usable set — the areas have to be the right SIZE
//               for the measurement.
//   fortworth   No city-wide neighbourhood layer exists in its ArcGIS org.
//               "Neighborhood_Boundaries" does not respond and
//               "Neighborhoods_24_03_25" holds 10 features (a study area).
//   kansascity  RESOLVED, kept for the reasoning. The objection was that its
//               only boundary layer looked like "Registered Neighborhood/Homes
//               Associations" (Socrata pvda-3rmd) — self-registered association
//               polygons, which over-represent organised (typically affluent)
//               areas and do not tile the city. Calibrating from those would
//               have repeated the OSM mistake with a different unrepresentative
//               set. The city's own nbhboundaries_updated layer (246
//               neighbourhoods, grouped by its 18 Area Plans) turned out to
//               exist in the same ArcGIS org, so kansascity is published from
//               build-gazetteer-kansascity.mjs and waits on nothing. The note
//               stays because the principle it records — an unrepresentative
//               set is worse than no set — is what still keeps nashville out.
//
// Output: tools/gazetteer/<id>.json (same shape the calibrator + renderer read)
// Run:    node tools/build-gazetteer-calibration.mjs
//             every city here that is NOT published; today that is none of them
//         node tools/build-gazetteer-calibration.mjs <id> [<id> ...]
//             named cities, refusing any that is published
//         node tools/build-gazetteer-calibration.mjs <id> --force-published
//             overwrite a published city's gazetteer anyway. Read the top of
//             this file first; you will have work to do afterwards.

import { writeFileSync, mkdirSync, readdirSync, readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const OUTDIR = join(HERE, 'gazetteer');

const CITIES = {
  denver: {
    city: 'Denver', country: 'US',
    kind: 'arcgis',
    url: 'https://services1.arcgis.com/zdB7qR0BtYrg0Xpl/arcgis/rest/services/Neighborhoods/FeatureServer/0',
    nameField: 'NBHD_NAME',
    // denverProvider.covers()
    bbox: { minLat: 39.61, maxLat: 39.84, minLng: -105.11, maxLng: -104.78 },
    source: "City and County of Denver — 78 official statistical neighborhoods",
  },
  baltimore: {
    city: 'Baltimore', country: 'US',
    kind: 'arcgis',
    url: 'https://services1.arcgis.com/UWYHeuuJISiGmgXx/arcgis/rest/services/Neighborhoods/FeatureServer/0',
    nameField: 'Name',
    // This layer carries Population, which is a far better uninhabited-area
    // filter than guessing from names. Baltimore has genuine zero-population
    // polygons (industrial waterfront, park land) and an empty feed there reads
    // as SAFE — the failure that put Harbor Islands top of the Boston table.
    populationField: 'Population',
    bbox: { minLat: 39.20, maxLat: 39.37, minLng: -76.71, maxLng: -76.53 },
    source: 'Baltimore City — neighbourhood statistical areas (populated only)',
  },
  longbeach: {
    city: 'Long Beach', country: 'US',
    kind: 'arcgis',
    url: 'https://services6.arcgis.com/yCArG7wGXGyWLqav/arcgis/rest/services/Neighborhoods/FeatureServer/0',
    nameField: 'NEIGHBOR_NAME',
    bbox: { minLat: 33.74, maxLat: 33.88, minLng: -118.25, maxLng: -118.06 },
    source: 'City of Long Beach — 126 neighbourhoods',
  },
  vancouver: {
    city: 'Vancouver', country: 'CA',
    kind: 'opendatasoft',
    url: 'https://opendata.vancouver.ca/api/explore/v2.1/catalog/datasets/local-area-boundary/records?limit=100',
    bbox: { minLat: 49.20, maxLat: 49.32, minLng: -123.27, maxLng: -123.02 },
    source: 'City of Vancouver Open Data — 22 official local areas',
  },
};

const slugify = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/['’.]/g, '').replace(/\s*[\/-]\s*/g, '-')
  .replace(/[^A-Za-z0-9]+/g, '-').replace(/^-+|-+$/g, '').toLowerCase();

// Area-weighted centroid of the largest ring (ignores slivers and islands).
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

async function getJson(url, label) {
  const r = await fetch(url, { signal: AbortSignal.timeout(120_000) });
  if (!r.ok) throw new Error(`${label}: HTTP ${r.status}`);
  return r.json();
}

async function fetchAreas(cfg, id) {
  if (cfg.kind === 'arcgis') {
    const fields = [cfg.nameField, cfg.populationField].filter(Boolean).join(',');
    const j = await getJson(
      `${cfg.url}/query?where=1%3D1&outFields=${fields}&outSR=4326&resultRecordCount=2000&f=geojson`, id);
    const out = [];
    let dropped = 0;
    for (const f of j.features || []) {
      const name = f.properties?.[cfg.nameField];
      if (!f.geometry || !name) continue;
      if (cfg.populationField) {
        const pop = Number(f.properties[cfg.populationField]);
        if (Number.isFinite(pop) && pop <= 0) { dropped++; continue; }
      }
      const c = centroidOf(f.geometry);
      if (c) out.push({ name: String(name).trim(), lat: c.lat, lng: c.lng });
    }
    return { areas: out, dropped };
  }
  // Opendatasoft: already supplies a centroid, so no geometry maths needed.
  const j = await getJson(cfg.url, id);
  const out = (j.results || [])
    .filter(r => r.name && r.geo_point_2d)
    .map(r => ({ name: String(r.name).trim(), lat: r.geo_point_2d.lat, lng: r.geo_point_2d.lon }));
  return { areas: out, dropped: 0 };
}

// ── which cities are published ───────────────────────────────────────────────
// Worked out from the repo, never from a second list kept in this file. A copy
// of "which cities are published" is a copy that goes stale, and a stale copy of
// exactly that fact is what made this script dangerous in the first place. Two
// sources, unioned, because each misses something the other catches and both
// cost nothing:
//
//   safety/<id>/index.html      the published hub page itself — the ground
//                               truth for "this is live right now". The monthly
//                               workflow decides the same way (ls -d safety/*/);
//                               keying on the index.html is what keeps
//                               safety/assets and safety/data out without a
//                               denylist that would need maintaining.
//   CITIES in render-pages.mjs  the renderer's own intent, which also covers a
//                               city configured but not yet rendered into the
//                               tree. Parsed as TEXT deliberately: that module
//                               does its entire job at import — network fetches,
//                               a thousand files written — so importing it to
//                               read one object literal is not an option.
//
// If neither can be read we stop rather than guess. An empty published set here
// would quietly restore the behaviour this guard removes.
function citiesFromRenderer() {
  try {
    const src = readFileSync(join(ROOT, 'tools', 'render-pages.mjs'), 'utf8');
    const from = src.indexOf('\nconst CITIES = {');
    const to = from < 0 ? -1 : src.indexOf('\n};', from);
    if (to < 0) return [];
    return src.slice(from, to).split('\n')
      .map(l => /^ {2}'?([A-Za-z0-9_-]+)'?\s*:\s*\{/.exec(l))
      .filter(Boolean).map(m => m[1]);
  } catch { return []; }
}

const PUBLISHED = (() => {
  const ids = new Set(citiesFromRenderer());
  try {
    for (const e of readdirSync(join(ROOT, 'safety'), { withFileTypes: true }))
      if (e.isDirectory() && existsSync(join(ROOT, 'safety', e.name, 'index.html'))) ids.add(e.name);
  } catch { /* no safety/ — caught by the emptiness check below */ }
  if (!ids.size) {
    console.error('cannot tell which cities are published: found no safety/<id>/index.html and could');
    console.error('not parse CITIES out of tools/render-pages.mjs. Refusing to write anything rather');
    console.error('than assume nothing is live — run this from a full checkout, or fix the detection.');
    process.exit(1);
  }
  return ids;
})();

// ── what to build ────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const FORCE = argv.includes('--force-published');
const badFlag = argv.find(a => a.startsWith('-') && a !== '--force-published');
if (badFlag) {
  console.error(`unknown option: ${badFlag}`);
  console.error('usage: node tools/build-gazetteer-calibration.mjs [<id> ...] [--force-published]');
  process.exit(1);
}
const asked = argv.filter(a => !a.startsWith('-'));

// The override only ever applies to cities named on the command line. If it
// widened a bare run it would hand back the rebuild-all-four button this is
// here to remove, behind a flag that sounds like it grants permission for one.
if (!asked.length && FORCE) {
  console.error('--force-published applies only to cities named on the command line; it never widens');
  console.error('a bare run into one. Name the city: node tools/build-gazetteer-calibration.mjs <id> --force-published');
  process.exit(1);
}

const wanted = asked.length ? asked : Object.keys(CITIES).filter(id => !PUBLISHED.has(id));

if (!asked.length) {
  const held = Object.keys(CITIES).filter(id => PUBLISHED.has(id));
  if (held.length) {
    console.error(`holding back ${held.length} published cit${held.length === 1 ? 'y' : 'ies'}: ${held.join(', ')}`);
    console.error('  each one has live pages under safety/<id>/, and the header says what a rebuild breaks.');
    console.error('  new boundaries for a published city belong in a per-city builder — see build-gazetteer-baltimore.mjs.');
  }
  if (!wanted.length) {
    console.error('nothing left to build.');
    process.exit(0);
  }
}

mkdirSync(OUTDIR, { recursive: true });

for (const id of wanted) {
  const cfg = CITIES[id];
  if (!cfg) { console.error(`unknown city: ${id}`); continue; }
  // Gated here, above the fetch rather than above the write: asking for a
  // published city should cost nothing and return nothing.
  if (PUBLISHED.has(id) && !FORCE) {
    console.error(`${id}: REFUSED — published at safety/${id}/, so this would overwrite a live area set.`);
    console.error('  The specifics are at the top of this file; the part that applies to every city here');
    console.error('  is that nothing this script emits carries `borough`, and render-pages.mjs throws');
    console.error('  on the city hub without it. Pass --force-published if you mean it anyway.');
    process.exitCode = 1;
    continue;
  }
  if (PUBLISHED.has(id)) {
    console.warn(`${id}: --force-published — OVERWRITING the gazetteer behind live safety/${id}/ pages.`);
    console.warn('  The result will have no `borough` field: backfill it before re-rendering, and check');
    console.warn('  the area set against what is published before committing.');
  }
  try {
    const { areas, dropped } = await fetchAreas(cfg, id);
    // Round, de-duplicate by slug, and drop anything outside the provider's own
    // bbox — a centroid the backend would refuse to score is not a sample point.
    const seen = new Set();
    const clean = [];
    let outside = 0;
    for (const a of areas) {
      const slug = slugify(a.name);
      if (!slug || seen.has(slug)) continue;
      const b = cfg.bbox;
      if (a.lat < b.minLat || a.lat > b.maxLat || a.lng < b.minLng || a.lng > b.maxLng) { outside++; continue; }
      seen.add(slug);
      clean.push({ name: a.name, slug, lat: +a.lat.toFixed(6), lng: +a.lng.toFixed(6) });
    }
    clean.sort((x, y) => x.name.localeCompare(y.name));
    writeFileSync(join(OUTDIR, `${id}.json`), JSON.stringify({
      city: cfg.city, citySlug: id, country: cfg.country,
      source: cfg.source,
      purpose: 'CALIBRATION ONLY — no /safety/ pages are generated from this set',
      generatedAt: new Date().toISOString().slice(0, 10),
      areas: clean,
    }, null, 1));
    console.log(`${id.padEnd(11)} ${String(clean.length).padStart(4)} areas` +
      (dropped ? `  · ${dropped} dropped (zero population)` : '') +
      (outside ? `  · ${outside} outside the provider bbox` : ''));
  } catch (e) {
    console.error(`${id}: FAILED — ${e.message}`);
    process.exitCode = 1;
  }
}
