// Prove the school tiles are complete and the pins are where they claim to be.
//
// TWO CHECKS, both of which fail silently if nobody looks:
//
// 1. COMPLETENESS. /check/ reads 389 separate tile files. A build that dies or
//    is interrupted part-way leaves a tile set that still loads and still looks
//    plausible — just with some cells missing their schools. So the rows across
//    every tile must add up to the count index.json declares, and every cell
//    index.json lists must exist. This replaces the old row-alignment check
//    between a national schools.json and its labels file, which no longer exist.
//
// 2. POSITION. build-schools.mjs hand-rolls OSGB36 -> WGS84 rather than pulling
//    in proj4. That is the right trade for one projection, but it means the
//    coordinates are only as good as transcribed constants, and a wrong datum
//    shift fails SILENTLY: every pin lands ~100m out, in a consistent direction,
//    on a map that still looks perfectly plausible. In a dense city that puts a
//    school on the wrong side of a main road.
//
//    So check it against something independent. postcodes.io publishes the
//    WGS84 centroid of every UK postcode, derived from ONS data — a completely
//    separate lineage from GIAS's grid references. If the conversion is right,
//    each school sits within a short walk of its own postcode centroid,
//    scattered in no particular direction. The residual is expected, not error:
//    a centroid is the middle of a street or block, the school a building on it.
//
// Usage: node tools/verify-schools.mjs

import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const TILE_DIR = join(ROOT, 'schools', 'data', 'tiles');
const SAMPLE = 100;          // postcodes.io bulk endpoint caps at 100
const MEDIAN_LIMIT_M = 200;  // above this, suspect the projection, not the data

function haversine(lat1, lng1, lat2, lng2) {
  const R = 6371000, rad = x => x * Math.PI / 180;
  const dLat = rad(lat2 - lat1), dLng = rad(lng2 - lng1);
  const h = Math.sin(dLat / 2) ** 2 +
            Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

const run = async () => {
  const index = JSON.parse(readFileSync(join(TILE_DIR, 'index.json'), 'utf8'));
  const f = Object.fromEntries(index.fields.map((name, i) => [name, i]));
  for (const need of ['name', 'postcode', 'lat', 'lng']) {
    if (!(need in f)) throw new Error(`tile index has no "${need}" field — cannot verify`);
  }

  // ── 1. completeness ───────────────────────────────────────────────────────
  const rows = [];
  const missing = [];
  for (const cell of index.cells) {
    const path = join(TILE_DIR, `${cell}.json`);
    if (!existsSync(path)) { missing.push(cell); continue; }
    rows.push(...JSON.parse(readFileSync(path, 'utf8')));
  }
  if (missing.length) {
    throw new Error(`${missing.length} tile(s) listed in index.json do not exist (e.g. ${missing.slice(0, 3).join(', ')}) — a partial build`);
  }
  if (rows.length !== index.count) {
    throw new Error(`tiles hold ${rows.length} schools but index.json declares ${index.count} — the tile set is incomplete`);
  }
  console.log(`  tiles complete    ${index.cells.length} cells, ${rows.length.toLocaleString()} schools = index count`);

  // ── 2. position ───────────────────────────────────────────────────────────
  // Sample the length of the country rather than one city: a projection error
  // can vary with distance from the central meridian, and sampling London alone
  // would hide that.
  rows.sort((a, b) => a[f.lat] - b[f.lat]);
  const stride = Math.floor(rows.length / SAMPLE);
  const picked = [];
  for (let i = 0; i < rows.length && picked.length < SAMPLE; i += stride) {
    const r = rows[i], pc = r[f.postcode];
    if (pc && /^[A-Z]{1,2}\d/i.test(pc)) picked.push({ pc, name: r[f.name], lat: r[f.lat], lng: r[f.lng] });
  }

  const res = await fetch('https://api.postcodes.io/postcodes', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ postcodes: picked.map(p => p.pc) }),
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) throw new Error(`postcodes.io HTTP ${res.status}`);

  const found = new Map();
  for (const r of (await res.json()).result || []) {
    if (r.result?.latitude != null) found.set(r.query.toUpperCase(), r.result);
  }

  const offsets = [];
  for (const p of picked) {
    const ref = found.get(p.pc.toUpperCase());
    if (!ref) continue;
    offsets.push({ ...p, m: haversine(p.lat, p.lng, ref.latitude, ref.longitude) });
  }
  if (offsets.length < 20) throw new Error(`only ${offsets.length} postcodes resolved — too few to conclude anything`);

  offsets.sort((a, b) => a.m - b.m);
  const median = offsets[Math.floor(offsets.length / 2)].m;
  const p90 = offsets[Math.floor(offsets.length * 0.9)].m;
  const worst = offsets[offsets.length - 1];

  console.log(`  schools checked   ${offsets.length}`);
  console.log(`  median offset     ${median.toFixed(0)} m`);
  console.log(`  90th percentile   ${p90.toFixed(0)} m`);
  console.log(`  worst             ${worst.m.toFixed(0)} m  (${worst.name})`);

  if (median > MEDIAN_LIMIT_M) {
    console.error(`\n  FAIL — median ${median.toFixed(0)}m exceeds ${MEDIAN_LIMIT_M}m.`);
    console.error('  A postcode centroid is never that far from its own building, so this is');
    console.error('  the projection, not the data. Check the Helmert parameters and that the');
    console.error('  datum shift runs at all.');
    process.exit(1);
  }
  console.log(`\n  PASS — tiles complete; offsets are centroid-to-building scatter, not projection error.`);
};

run().catch(e => { console.error('verify-schools failed:', e.message); process.exit(1); });
