#!/usr/bin/env node
// tools/fetch-basemap-osm.mjs
//
// OpenStreetMap counterpart to fetch-basemap.mjs (which is NYC-specific, built
// on NYC Open Data). The vector basemap comes from OSM via the Overpass API
// (roads, water, parks), fetched once per area at build time from a residential
// connection, politely paced across public mirrors. ODbL attribution ("©
// OpenStreetMap contributors") is rendered on every page. Unlike NYC (land
// polygons on a water background), these cities store WATER polygons drawn over
// a land-coloured background — the Thames inland, Lake Michigan on the coast.
//
// Output: tools/data-cache/<city>-basemap/<slug>.json (same px frame as NYC).
// Run:    node tools/fetch-basemap-osm.mjs --city london [--force]

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const FORCE = process.argv.includes('--force');

const W = 640, H = 430, CX = W / 2, CY = H / 2;
const SCALE = (H - 40) / 2 / 1000;
const HALF_W_M = CX / SCALE + 120, HALF_H_M = CY / SCALE + 120;

const cityArg = process.argv.indexOf('--city');
const CITY = cityArg > -1 ? process.argv[cityArg + 1] : 'london';

const gaz = JSON.parse(readFileSync(join(ROOT, 'tools', 'gazetteer', `${CITY}.json`)));
const outDir = join(ROOT, 'tools', 'data-cache', `${CITY}-basemap`);
mkdirSync(outDir, { recursive: true });

// Several mirrors, because a dense grid city (Chicago pulls ~3.5×2.4 km of full
// street network per area) exhausts a single mirror's per-IP slots within a few
// requests and everything after that queues or times out.
// Probed 2026-07-22: kumi.systems and private.coffee were unreachable (connect
// timeouts). overpass.osm.ch looked healthy but is a SWITZERLAND-ONLY extract —
// it answers 200 with zero elements for anything outside Switzerland, which
// silently cached 28 blank Chicago basemaps before it was caught. Only add a
// mirror here after checking it returns data for a non-European bbox.
const OVERPASS = [
  'https://overpass-api.de/api/interpreter',
];

const MAJOR = new Set(['motorway', 'trunk', 'primary', 'secondary']);
const MINOR = new Set(['tertiary', 'unclassified', 'residential', 'living_street', 'pedestrian']);

async function overpass(query, seed = 0) {
  let last;
  // Fixed attempt count, not one-per-mirror: with a single healthy mirror the
  // retries still matter (it returns 504 under load). Seed staggers the start
  // point when there is more than one.
  for (let attempt = 0; attempt < 5; attempt++) {
    const url = OVERPASS[(seed + attempt) % OVERPASS.length];
    try {
      const r = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'SafeRoute-safety-pages/1.0 (minhaj@safe-route.app)' },
        body: 'data=' + encodeURIComponent(query),
        signal: AbortSignal.timeout(100_000),
      });
      // 429 = no free slot, 504 = the query timed out server-side under load.
      // Both mean "come back later", so wait out a full slot window rather than
      // retrying straight into the same wall.
      if (r.status === 429 || r.status === 504) {
        await new Promise(res => setTimeout(res, 30_000));
        throw new Error(`HTTP ${r.status}`);
      }
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const elements = (await r.json()).elements || [];
      // A populated city area always has streets. An empty 200 means the mirror
      // doesn't hold this region (see osm.ch above) or truncated the result —
      // fail it so another attempt runs, rather than caching a blank map.
      if (!elements.length) throw new Error('empty result (mirror lacks this region?)');
      return elements;
    } catch (e) { last = e; await new Promise(res => setTimeout(res, 2500 * (attempt + 1))); }
  }
  throw last;
}

const project = (c) => (lng, lat) => [
  CX + (lng - c.lng) * 111320 * c.cos * SCALE,
  CY - (lat - c.lat) * 111320 * SCALE,
];

function simplify(pts, minGap = 1.3) {
  const out = [];
  for (const p of pts) {
    const last = out[out.length - 1];
    if (!last || Math.hypot(p[0] - last[0], p[1] - last[1]) >= minGap) out.push(p);
  }
  if (out.length > 1) out[out.length - 1] = pts[pts.length - 1];
  return out.map(p => [Math.round(p[0] * 10) / 10, Math.round(p[1] * 10) / 10]);
}

const nice = (s) => String(s || '').trim(); // OSM names are already cased ("Camden High Street")

async function buildArea(a, seed = 0) {
  const c = { lng: a.lng, lat: a.lat, cos: Math.cos(a.lat * Math.PI / 180) };
  const px = project(c);
  const dLng = HALF_W_M / (111320 * c.cos), dLat = HALF_H_M / 111320;
  const bbox = `${a.lat - dLat},${a.lng - dLng},${a.lat + dLat},${a.lng + dLng}`;

  const q = `[out:json][timeout:90];
(
  way["highway"~"^(motorway|trunk|primary|secondary|tertiary|unclassified|residential|living_street|pedestrian)$"](${bbox});
  way["natural"="water"](${bbox});
  way["waterway"="riverbank"](${bbox});
  way["landuse"~"^(reservoir|basin)$"](${bbox});
  way["leisure"~"^(park|garden|common|recreation_ground|nature_reserve)$"](${bbox});
  relation["natural"="water"](${bbox});
);
out geom;`;

  const elements = await overpass(q, seed);
  const water = [], parks = [], stMinor = [], stMajor = [];
  const byName = new Map();

  const pushRing = (arr, coords) => {
    const r = simplify(coords.map(g => px(g.lon, g.lat)));
    if (r.length >= 3) arr.push(r);
  };

  for (const el of elements) {
    const t = el.tags || {};
    if (el.type === 'relation') {
      // multipolygon water (the Thames is mapped this way) — outer rings only
      for (const m of el.members || []) {
        if (m.role === 'outer' && m.geometry) pushRing(water, m.geometry);
      }
      continue;
    }
    if (!el.geometry) continue;
    if (t.natural === 'water' || t.waterway === 'riverbank' || t.landuse === 'reservoir' || t.landuse === 'basin') {
      pushRing(water, el.geometry);
    } else if (t.leisure) {
      pushRing(parks, el.geometry);
    } else if (t.highway) {
      const p = simplify(el.geometry.map(g => px(g.lon, g.lat)));
      if (p.length < 2) continue;
      const major = MAJOR.has(t.highway);
      (major ? stMajor : stMinor).push(p);
      if (t.name && MINOR.has(t.highway) === false || (t.name && major)) { /* label majors + named tertiary */ }
      if (t.name && (major || t.highway === 'tertiary')) {
        let len = 0;
        for (let i = 1; i < p.length; i++) len += Math.hypot(p[i][0] - p[i - 1][0], p[i][1] - p[i - 1][1]);
        const e = byName.get(t.name) || { len: 0, best: null, bestLen: 0 };
        e.len += len;
        if (len > e.bestLen) { e.bestLen = len; e.best = p; }
        byName.set(t.name, e);
      }
    }
  }

  const labels = [...byName.entries()]
    .sort((x, y) => y[1].len - x[1].len)
    .map(([name, e]) => {
      const p = e.best, mid = p[Math.floor(p.length / 2)];
      const a2 = p[Math.min(p.length - 1, Math.floor(p.length / 2) + 1)], a1 = p[Math.max(0, Math.floor(p.length / 2) - 1)];
      let ang = Math.atan2(a2[1] - a1[1], a2[0] - a1[0]) * 180 / Math.PI;
      if (ang > 90) ang -= 180; if (ang < -90) ang += 180;
      return { t: nice(name), x: mid[0], y: mid[1], a: Math.round(ang) };
    })
    .filter(l => l.x >= 24 && l.x <= W - 24 && l.y >= 20 && l.y <= H - 20)
    .slice(0, 2);

  return { water, parks, stMinor, stMajor, labels };
}

let done = 0, skipped = 0, seq = 0; const failed = [];
for (const a of gaz.areas) {
  const file = join(outDir, `${a.slug}.json`);
  if (!FORCE && existsSync(file)) { skipped++; continue; }
  try {
    const b = await buildArea(a, seq++);
    writeFileSync(file, JSON.stringify(b));
    done++;
    if (done % 10 === 0) console.log(`  ${done} built (${gaz.areas.length - done - skipped} left)`);
  } catch (e) {
    failed.push({ slug: a.slug, error: e.message });
    console.error(`  FAIL ${a.slug}: ${e.message}`);
  }
  await new Promise(r => setTimeout(r, 4000)); // polite to public Overpass mirrors
}
console.log(`basemaps: ${done} built, ${skipped} cached, ${failed.length} failed`);
if (failed.length) { console.log(JSON.stringify(failed)); process.exitCode = 1; }
