#!/usr/bin/env node
// tools/build-gazetteer-london.mjs
//
// London gazetteer for the /safety/ pages: the electoral wards of the 12 Inner
// London boroughs (ONS "Wards December 2025" layer, which conveniently carries
// borough names and centroid LONG/LAT as attributes), plus the City of London
// as a single area (its 25 ceremonial wards — Cheap, Cordwainer… — are not
// names anyone searches). Inner London first deliberately: it's where the
// "is X safe" search volume lives; Outer London can follow once Search Console
// data justifies it.
//
// Output: tools/gazetteer/london.json
// Run:    node tools/build-gazetteer-london.mjs

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = join(dirname(fileURLToPath(import.meta.url)), 'gazetteer', 'london.json');
const SVC = 'https://services1.arcgis.com/ESMARspQHYMw9BZ9/arcgis/rest/services/WD_DEC_2025_UK_BSC/FeatureServer/0/query';

// Inner London borough LAD codes (E09000001 = City of London handled separately).
const INNER = {
  E09000007: 'Camden', E09000011: 'Greenwich', E09000012: 'Hackney',
  E09000013: 'Hammersmith and Fulham', E09000019: 'Islington',
  E09000020: 'Kensington and Chelsea', E09000022: 'Lambeth',
  E09000023: 'Lewisham', E09000028: 'Southwark', E09000030: 'Tower Hamlets',
  E09000032: 'Wandsworth', E09000033: 'Westminster',
};

const slugify = (s) => s
  .normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/['’.]/g, '')
  .replace(/[^A-Za-z0-9]+/g, '-')
  .replace(/^-+|-+$/g, '')
  .toLowerCase();

const distKm = (a, b) => {
  const dLat = (a.lat - b.lat) * 111.32;
  const dLng = (a.lng - b.lng) * 111.32 * Math.cos(a.lat * Math.PI / 180);
  return Math.hypot(dLat, dLng);
};

const where = `LAD25CD IN (${Object.keys(INNER).map(c => `'${c}'`).join(',')})`;
const u = new URL(SVC);
u.searchParams.set('where', where);
u.searchParams.set('outFields', 'WD25CD,WD25NM,LAD25NM,LONG,LAT');
u.searchParams.set('returnGeometry', 'false');
u.searchParams.set('resultRecordCount', '2000');
u.searchParams.set('f', 'json');

const res = await fetch(u, { signal: AbortSignal.timeout(60_000) });
if (!res.ok) throw new Error(`wards fetch: HTTP ${res.status}`);
const j = await res.json();
if (j.error) throw new Error(`wards fetch: ${JSON.stringify(j.error)}`);

const areas = (j.features || []).map(f => f.attributes).map(w => ({
  name: w.WD25NM,
  slug: slugify(w.WD25NM),
  borough: w.LAD25NM,
  ward: w.WD25CD,
  lat: +Number(w.LAT).toFixed(6),
  lng: +Number(w.LONG).toFixed(6),
}));

// City of London as one searchable area (Bank junction as its centre).
areas.push({ name: 'City of London', slug: 'city-of-london', borough: 'City of London',
             ward: 'E09000001', lat: 51.5133, lng: -0.0898 });

areas.sort((a, b) => a.name.localeCompare(b.name));

// Same-named wards exist in different boroughs — disambiguate slugs.
const seen = new Map();
for (const a of areas) {
  if (seen.has(a.slug)) {
    const other = seen.get(a.slug);
    if (!other.slug.endsWith(slugify(other.borough))) other.slug = `${other.slug}-${slugify(other.borough)}`;
    a.slug = `${a.slug}-${slugify(a.borough)}`;
  }
  seen.set(a.slug.replace(`-${slugify(a.borough)}`, ''), a);
}
const dupes = areas.length - new Set(areas.map(a => a.slug)).size;
if (dupes) throw new Error(`${dupes} duplicate slugs remain`);

for (const a of areas) {
  a.neighbors = areas
    .filter(b => b !== a)
    .map(b => ({ slug: b.slug, d: distKm(a, b) }))
    .sort((x, y) => x.d - y.d)
    .slice(0, 5)
    .map(n => n.slug);
}

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify({
  city: 'London',
  citySlug: 'london',
  country: 'UK',
  source: 'ONS Wards (December 2025) BSC — Inner London boroughs; City of London merged to one area',
  generatedAt: new Date().toISOString().slice(0, 10),
  areas,
}, null, 1));
console.log(`gazetteer: ${areas.length} London areas → ${OUT}`);
console.log('boroughs:', [...new Set(areas.map(a => a.borough))].join(', '));
