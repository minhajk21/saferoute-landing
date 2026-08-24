#!/usr/bin/env node
// tools/build-gazetteer-baltimore.mjs
//
// Baltimore gazetteer for the /safety/ pages: the 56 COMMUNITY STATISTICAL
// AREAS (CSAs), not the 256 Neighborhood Statistical Areas.
//
// WHY CSAs AND NOT NEIGHBOURHOODS
// The safety index sums incidents within 1 km of an area centre. Baltimore's
// 256 NSAs have a median centre spacing of 566 m — finer than the index radius
// and tighter than any city already published (DC, the tightest, is 700 m). At
// that density adjacent pages describe heavily overlapping circles and read as
// near-duplicates: thin content that risks the whole domain rather than
// growing it. CSAs aggregate those neighbourhoods into 56 areas on census-tract
// boundaries, which is the granularity Baltimore's own indicator reporting
// (BNIA-JFI) uses, and which lands near Chicago/LA-like spacing.
//
// The CSA names are compound by design ("Allendale/Irvington/S. Hilton"),
// because that is how the areas are actually referred to locally and in the
// city's own reporting. The constituent neighbourhood list is carried through
// so pages can say which neighbourhoods an area covers — that is what people
// search for, and it keeps the page useful for someone who knows "Gwynns Falls"
// but not the CSA it sits in.
//
// Source: Community Statistical Areas (CSAs) Reference Boundaries, published on
// ArcGIS Online by the Jacob France Institute / BNIA-JFI (University of
// Baltimore), the body that defines and maintains the CSA geography.
//
// Output: tools/gazetteer/baltimore.json
// Run:    node tools/build-gazetteer-baltimore.mjs

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, 'gazetteer', 'baltimore.json');
const SRC = 'https://services1.arcgis.com/mVFRs7NF4iFitgbY/arcgis/rest/services/'
          + 'Community_Statistical_Areas_(CSAs)__Reference_Boundaries/FeatureServer/0';

const slugify = (s) => s.toLowerCase()
  .replace(/&/g, ' and ')
  .replace(/[''']/g, '')
  .replace(/[^a-z0-9]+/g, '-')
  .replace(/^-+|-+$/g, '');

// Ring centroid by the shoelace formula, on the largest ring of the polygon —
// a plain average of vertices drifts toward whichever edge is most finely
// digitised, which for these boundaries is the waterfront.
function ringCentroid(ring) {
  let a = 0, cx = 0, cy = 0;
  for (let i = 0, n = ring.length - 1; i < n; i++) {
    const [x0, y0] = ring[i], [x1, y1] = ring[i + 1];
    const f = x0 * y1 - x1 * y0;
    a += f; cx += (x0 + x1) * f; cy += (y0 + y1) * f;
  }
  if (Math.abs(a) < 1e-12) {                      // degenerate → vertex mean
    const m = ring.reduce((p, c) => [p[0] + c[0], p[1] + c[1]], [0, 0]);
    return [m[0] / ring.length, m[1] / ring.length];
  }
  a *= 0.5;
  return [cx / (6 * a), cy / (6 * a)];
}

const url = `${SRC}/query?where=1%3D1&outFields=CSA2020,Community,Neigh&outSR=4326&f=json`;
const res = await fetch(url, { signal: AbortSignal.timeout(60_000) });
if (!res.ok) throw new Error(`CSA source HTTP ${res.status}`);
const j = await res.json();
if (!j.features?.length) throw new Error('CSA source returned no features');

const areas = [];
for (const f of j.features) {
  const name = String(f.attributes.Community || f.attributes.CSA2020 || '').trim();
  if (!name) continue;
  const rings = f.geometry?.rings || [];
  if (!rings.length) continue;
  // Largest ring by absolute area = the mainland part, not an islet.
  const largest = rings.reduce((best, r) => {
    let a = 0;
    for (let i = 0, n = r.length - 1; i < n; i++) a += r[i][0] * r[i + 1][1] - r[i + 1][0] * r[i][1];
    return Math.abs(a) > best.a ? { a: Math.abs(a), r } : best;
  }, { a: -1, r: rings[0] }).r;
  const [lng, lat] = ringCentroid(largest);
  areas.push({
    name,
    slug: slugify(name),
    // Single-tier city: one ranked table on the hub, so borough is the city
    // itself (the convention Chicago and SF already use).
    borough: 'Baltimore',
    lat: +lat.toFixed(6),
    lng: +lng.toFixed(6),
    // Which neighbourhoods this CSA covers — used in page copy so someone
    // searching a neighbourhood name still lands somewhere that mentions it.
    covers: String(f.attributes.Neigh || '').split(',').map(s => s.trim()).filter(Boolean),
  });
}
areas.sort((a, b) => a.name.localeCompare(b.name));

const dup = areas.length - new Set(areas.map(a => a.slug)).size;
if (dup) throw new Error(`${dup} duplicate slug(s) — refusing to write an ambiguous gazetteer`);

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify({
  city: 'Baltimore', citySlug: 'baltimore', country: 'US',
  source: 'BNIA-JFI / Jacob France Institute — Baltimore City Community Statistical Areas (CSAs), 2020 boundaries',
  purpose: 'Safety pages + calibration. CSAs, not the 256 NSAs: see the header of this script for why.',
  generatedAt: new Date().toISOString().slice(0, 10),
  areas,
}, null, 2) + '\n');
console.log(`baltimore gazetteer: ${areas.length} CSAs → ${OUT}`);
