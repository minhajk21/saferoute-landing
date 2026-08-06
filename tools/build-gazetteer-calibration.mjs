#!/usr/bin/env node
// tools/build-gazetteer-calibration.mjs
//
// Area sets for regions that are CALIBRATED but not PUBLISHED.
//
// WHY A SHARED FILE, NOT ONE PER CITY
// The per-city builders (build-gazetteer-philly.mjs and friends) exist because
// an SEO city needs bespoke decisions: which of three competing neighbourhood
// sets to use, how to group them into districts, which display name people
// actually search. None of that applies here. These cities have no /safety/
// pages; the area set exists solely so their normaliser can be measured against
// every real neighbourhood instead of a sample. That is one job, so it is one
// file. If one of them ever graduates to a published city, give it its own
// builder then, with the naming and grouping decisions that come with it.
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
//   kansascity  Its only boundary layer is "Registered Neighborhood/Homes
//               Associations" (Socrata pvda-3rmd) — self-registered association
//               polygons, which over-represent organised (typically affluent)
//               areas and do not tile the city. Calibrating from those would
//               repeat the OSM mistake with a different unrepresentative set,
//               so kansascity stays on its unpinned constant until the city
//               publishes real neighbourhood boundaries.
//
// Output: tools/gazetteer/<id>.json (same shape the calibrator + renderer read)
// Run:    node tools/build-gazetteer-calibration.mjs [id ...]

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUTDIR = join(dirname(fileURLToPath(import.meta.url)), 'gazetteer');

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

const wanted = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(CITIES);
mkdirSync(OUTDIR, { recursive: true });

for (const id of wanted) {
  const cfg = CITIES[id];
  if (!cfg) { console.error(`unknown city: ${id}`); continue; }
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
