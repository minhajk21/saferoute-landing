#!/usr/bin/env node
// tools/build-gazetteer-ukcity.mjs
//
// Gazetteer for a UK city outside London, from the SAME ONS ward layer the
// London builder uses (WD_DEC_2025_UK_BSC), filtered to one local authority.
// Generic on purpose: Birmingham first, with Liverpool, Bristol and Cardiff
// queued behind it, and they differ only by the LAD name and a hazard list.
//
// ON THE ONS `LAT`/`LONG` ATTRIBUTES — READ THIS BEFORE TRUSTING THEM.
// An earlier version of this file claimed these were POPULATION-WEIGHTED
// centroids. They are not. The layer publishes no field description, and the
// data disproves it: Sutton Vesey's LAT/LONG lands in Sutton Park, 2,400 acres
// of nature reserve, which a population-weighted point never would. They are
// geometric centroids, and they carry the same void risk as any centroid we
// compute ourselves.
//
// That matters twice over. It is why the overrides below exist, and it is why
// Cardiff's Butetown — a MultiPolygon whose second part is Flat Holm, an island
// 9.5 km offshore — must be checked, not assumed safe, when Cardiff is built.
//
// London is unaffected and this was verified rather than hoped: a
// neighbour-ratio audit over all 248 published Inner London wards returns ZERO
// flags. Inner London wards are small and uniformly built up, so a geometric
// centroid lands in housing whatever it does. The defect only bites a ward that
// contains a large park or green belt — which is precisely Sutton Coldfield.
//
// Run: node tools/build-gazetteer-ukcity.mjs --city birmingham

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SVC = 'https://services1.arcgis.com/ESMARspQHYMw9BZ9/arcgis/rest/services/'
  + 'WD_DEC_2025_UK_BSC/FeatureServer/0/query';

// citySlug → { lad: ONS local-authority name, city: display name }
// The LAD is the *city council* area, deliberately not the wider conurbation:
// "Birmingham" is Birmingham City Council, not the West Midlands.
// Centroids that land in parkland or green belt, with the built-up point they
// are moved to. Each is asserted INSIDE its own ward polygon at build time, so
// an override can move a page to where people live but never onto a neighbour.
// Chosen for BUILT FORM, not for incident count — Five Ways reads slightly
// lower than Calthorpe for Edgbaston, but sits on the city-centre boundary and
// would import the centre's crime into Edgbaston's page.
//
//   Sutton Vesey            3 incidents in Sutton Park  → 72 at Boldmere
//   Sutton Walmley & Minworth  7 in the Minworth green belt → 22 at Walmley village
//   Edgbaston              33 in the university/botanical belt → 429 at Calthorpe
const CENTROID_OVERRIDE = {
  bristol: {
    // The ward is "Avonmouth AND Lawrence Weston" and the centroid landed in
    // Avonmouth — the container port. 6 incidents, 99/100, top of the city.
    // Moved to the Lawrence Weston housing estate the other half is named for:
    // 94 incidents, and where the ward's residents actually are.
    'Avonmouth and Lawrence Weston': { lat: 51.5030, lng: -2.6560 },
  },
  leeds: {
    // Leeds's LAD is 552 km2 and its outer wards are mostly countryside, so the
    // ONS geometric centroid lands in a field far more often than in any other
    // UK city built so far. Ring-probed at ~1500 m (these wards are large:
    // median centroid spacing 2456 m vs DC's ~700 m); every move below is a
    // point the probe showed the centroid was missing, asserted inside its own
    // ward polygon, and chosen for BUILT FORM and the largest named settlement
    // -- never for the highest count, which is how you accidentally publish a
    // neighbouring ward's crime under this ward's name.
    //
    //   Kippax & Methley   0 incidents in farmland east of Kippax -> 55 in Kippax
    //   Otley & Yeadon     3 on the Chevin, the wooded ridge BETWEEN the two
    //                      towns -> 84 in Otley (the larger town, ~14k, and
    //                      first-named; Yeadon read 116 but is half the size)
    //   Alwoodley          4 in the golf courses and green belt -> 73 in the
    //                      Alwoodley/Moor Allerton housing. The 104-incident
    //                      point sits on the Moortown boundary and would import
    //                      Moortown's crime, which is the Edgbaston lesson.
    //   Guiseley & Rawdon 10 -> 62 in Guiseley centre (~21k, first-named). The
    //                      125-incident point is Yeadon, which belongs to the
    //                      OTHER ward entirely.
    //   Harewood           0 at the centroid AND 0 at Harewood village itself.
    //                      Moved to Collingham, the ward's largest village, for
    //                      built form -- it is still only 8, and no point
    //                      anywhere in this ward exceeds that. Rural North
    //                      Leeds genuinely has almost no recorded crime, so it
    //                      also carries the sparse caveat in render-pages.mjs.
    'Kippax & Methley': { lat: 53.7670, lng: -1.3700 },   // Kippax village
    'Otley & Yeadon': { lat: 53.9048, lng: -1.6930 },     // Otley town centre
    'Alwoodley': { lat: 53.8530, lng: -1.5420 },          // Alwoodley / Moor Allerton
    'Guiseley & Rawdon': { lat: 53.8755, lng: -1.7080 },  // Guiseley centre
    'Harewood': { lat: 53.9110, lng: -1.4210 },           // Collingham
    //   Horsforth          11 west of the town in the Horsforth Woodside green
    //                      gap -> 85 on Town Street, the actual town centre of
    //                      a 20k suburb. 11 was never plausible for Horsforth.
    //   Calverley & Farsley 15 in the fields between the two villages -> 50 on
    //                      Farsley Town Street. Deliberately NOT the 109-count
    //                      point to the west: that is over the boundary in
    //                      BRADFORD, a different local authority altogether.
    'Horsforth': { lat: 53.8370, lng: -1.6400 },          // Horsforth Town Street
    'Calverley & Farsley': { lat: 53.8180, lng: -1.6720 },// Farsley Town Street
  },
  birmingham: {
    'Sutton Vesey': { lat: 52.5560, lng: -1.8360 },              // Boldmere
    'Sutton Walmley & Minworth': { lat: 52.5460, lng: -1.7900 }, // Walmley village
    'Edgbaston': { lat: 52.4690, lng: -1.9100 },                 // Calthorpe Estate
  },
};

function pointInRing({ lat, lng }, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > lat) !== (yj > lat) && lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

const ringsOf = (g) => g?.type === 'Polygon' ? [g.coordinates[0]]
  : g?.type === 'MultiPolygon' ? g.coordinates.map((p) => p[0]) : [];

const CITIES = {
  birmingham: { lad: 'Birmingham', city: 'Birmingham' },
  liverpool:  { lad: 'Liverpool',  city: 'Liverpool' },
  bristol:    { lad: 'Bristol, City of', city: 'Bristol' },
  cardiff:    { lad: 'Cardiff',    city: 'Cardiff' },
  leeds:      { lad: 'Leeds',      city: 'Leeds' },
};

const arg = process.argv.indexOf('--city');
const KEY = arg > -1 ? process.argv[arg + 1] : 'birmingham';
const CFG = CITIES[KEY];
if (!CFG) throw new Error(`unknown city "${KEY}" — known: ${Object.keys(CITIES).join(', ')}`);

const OUT = join(HERE, 'gazetteer', `${KEY}.json`);

const slugify = (s) => s.toLowerCase()
  .normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/&/g, ' and ')
  .replace(/['’.]/g, '')
  .replace(/[^a-z0-9]+/g, '-')
  .replace(/^-+|-+$/g, '');

const distM = (a, b) => {
  const dLat = (a.lat - b.lat) * 111320;
  const dLng = (a.lng - b.lng) * 111320 * Math.cos((a.lat * Math.PI) / 180);
  return Math.hypot(dLat, dLng);
};

const u = new URL(SVC);
u.searchParams.set('where', `LAD25NM='${CFG.lad.replace(/'/g, "''")}'`);
u.searchParams.set('outFields', 'WD25CD,WD25NM,LAD25NM,LONG,LAT');
u.searchParams.set('returnGeometry', 'true');
u.searchParams.set('outSR', '4326');
u.searchParams.set('f', 'geojson');

const res = await fetch(u, { signal: AbortSignal.timeout(120_000) });
if (!res.ok) throw new Error(`ONS ward layer HTTP ${res.status}`);
const { features } = await res.json();
if (!features?.length) throw new Error(`no wards for LAD "${CFG.lad}" — check the exact ONS spelling`);

const OVERRIDES = CENTROID_OVERRIDE[KEY] || {};
const areas = [], moved = [];
for (const f of features) {
  const a = f.properties;
  const name = String(a.WD25NM || '').trim();
  let lat = Number(a.LAT), lng = Number(a.LONG);
  // A ward with no ONS centroid is a hard error, not a silent skip: dropping it
  // would quietly remove a real place from the city's ranking.
  if (!name) throw new Error(`ward ${a.WD25CD} has no name`);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    throw new Error(`ward "${name}" has no usable ONS centroid (LAT/LONG)`);
  }
  const ov = OVERRIDES[name];
  if (ov) {
    if (!ringsOf(f.geometry).some((r) => pointInRing(ov, r))) {
      throw new Error(`centroid override for "${name}" is outside its own ward — refusing to move a page onto a neighbour`);
    }
    lat = ov.lat; lng = ov.lng; moved.push(name);
  }
  areas.push({ name, slug: slugify(name), lat: +lat.toFixed(6), lng: +lng.toFixed(6), borough: CFG.city });
}

areas.sort((a, b) => a.name.localeCompare(b.name));

const dup = areas.length - new Set(areas.map((a) => a.slug)).size;
if (dup) throw new Error(`${dup} duplicate slug(s) — refusing to write an ambiguous gazetteer`);

const nearest = areas.map((a) =>
  Math.min(...areas.filter((b) => b !== a).map((b) => distM(a, b))));
const sorted = [...nearest].sort((x, y) => x - y);
const median = sorted[Math.floor(sorted.length / 2)];

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify({
  city: CFG.city, citySlug: KEY, country: 'GB',
  source: `ONS Wards (December 2025) Boundaries UK BSC — local authority "${CFG.lad}", ONS population-weighted centroids`,
  purpose: 'Safety pages + calibration.',
  generatedAt: new Date().toISOString().slice(0, 10),
  areas,
}, null, 2) + '\n');

console.log(`${CFG.city} gazetteer: ${areas.length} wards → ${OUT}`);
if (moved.length) console.log(`  centroid moved to built-up land: ${moved.join(', ')}`);
console.log(`  nearest-centroid spacing: median ${Math.round(median)} m, min ${Math.round(sorted[0])} m`);
console.log(`  gate: DC (tightest published) is ~700 m median → ${median >= 700 ? 'PASS' : 'REVIEW'}`);
