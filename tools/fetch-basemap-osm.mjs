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
// Re-probed 2026-08-04 while building Philadelphia (152 fresh areas), with a
// real Philly bbox — the non-European check this list requires. Result: still
// exactly one usable mirror.
//   overpass-api.de          KEEP. Intermittent under load, but it is CHEAP when
//                            it fails: 504 in ~8s, and it will then serve the
//                            identical query a few seconds later.
//   overpass.private.coffee  REJECTED, and note this is not the same failure as
//                            "unreachable". It answers, and a single idle probe
//                            looked fine (200/57.1s/1589 elements) — but under
//                            sustained use it took 92-96s to return a 504. One
//                            slow mirror in the rotation costs more than no
//                            mirror, because every retry that lands on it burns
//                            a minute and a half. Timing a mirror once, idle, is
//                            not enough; time it under load before adding it.
//   kumi.systems             connect timeout (unchanged since July).
//   overpass.osm.jp          fetch failed (unchanged since July).
//   overpass.osm.ch          200 with ZERO elements again — the Switzerland-only
//                            extract. Do not add it.
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
  for (let attempt = 0; attempt < 8; attempt++) {
    const url = OVERPASS[(seed + attempt) % OVERPASS.length];
    try {
      const r = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'SafeRoute-safety-pages/1.0 (minhaj@safe-route.app)' },
        body: 'data=' + encodeURIComponent(query),
        signal: AbortSignal.timeout(100_000),
      });
      // 429 and 504 look alike but have different causes, and treating them the
      // same is expensive. 429 means our per-IP slots really are exhausted, and
      // only time returns them — wait out a full slot window. 504 is the server
      // shedding load; measured over a 152-area Philadelphia build (Aug 2026),
      // overpass-api.de returned 504 in ~8s and then answered the SAME query
      // within seconds on a later attempt, while /api/status reported both our
      // slots free. Charging that a 30s penalty turned a cheap, retryable
      // failure into the dominant cost of the run — hours per city.
      if (r.status === 429) {
        await new Promise(res => setTimeout(res, 30_000));
        throw new Error('HTTP 429');
      }
      if (r.status === 504) throw new Error('HTTP 504');
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const elements = (await r.json()).elements || [];
      // A populated city area always has streets. An empty 200 means the mirror
      // doesn't hold this region (see osm.ch above) or truncated the result —
      // fail it so another attempt runs, rather than caching a blank map.
      if (!elements.length) throw new Error('empty result (mirror lacks this region?)');
      return elements;
      // Escalating but capped: with 8 attempts an uncapped 2500*(attempt+1)
      // would put 90s of sleep on the tail of a run that is mostly cheap 504s.
    } catch (e) { last = e; await new Promise(res => setTimeout(res, Math.min(2500 * (attempt + 1), 10_000))); }
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

// ── Coastline → water polygons ────────────────────────────────────────────
// Open oceans/sounds (Puget Sound, the Pacific, SF Bay's outer edge) are mapped
// in OSM as natural=coastline LINES, not natural=water polygons, so the water
// query alone leaves waterfront neighbourhoods (Alki, Ocean Beach) with a blank
// sea. OSM's rule: walking a coastline in node order, land is on the LEFT and
// water on the RIGHT. We merge the coastline ways into chains, clip each to a
// frame slightly larger than the visible viewBox, and close it back along the
// frame edge on the water side — picking the closing that actually encloses a
// point on the water side of the line, which sidesteps winding-sign confusion.
const FR = { x0: -60, y0: -60, x1: W + 60, y1: H + 60 };

// Merge chains that share endpoints (coastlines arrive split into many ways).
function mergeChains(ways) {
  const chains = ways.map(w => w.slice());
  const key = p => `${Math.round(p[0])},${Math.round(p[1])}`;
  let merged = true;
  while (merged) {
    merged = false;
    for (let i = 0; i < chains.length; i++) {
      for (let j = i + 1; j < chains.length; j++) {
        const a = chains[i], b = chains[j];
        if (!a.length || !b.length) continue;
        if (key(a[a.length - 1]) === key(b[0])) { chains[i] = a.concat(b.slice(1)); chains.splice(j, 1); merged = true; break; }
        if (key(a[a.length - 1]) === key(b[b.length - 1])) { chains[i] = a.concat(b.slice().reverse().slice(1)); chains.splice(j, 1); merged = true; break; }
        if (key(a[0]) === key(b[b.length - 1])) { chains[i] = b.concat(a.slice(1)); chains.splice(j, 1); merged = true; break; }
        if (key(a[0]) === key(b[0])) { chains[i] = b.slice().reverse().concat(a.slice(1)); chains.splice(j, 1); merged = true; break; }
      }
      if (merged) break;
    }
  }
  return chains;
}

const inFrame = p => p[0] >= FR.x0 && p[0] <= FR.x1 && p[1] >= FR.y0 && p[1] <= FR.y1;

// Split a chain into runs that lie inside the frame. Each run BEGINS and ENDS
// exactly on the frame boundary (the real segment/edge intersection), which is
// what lets perim() recognise the endpoints and close the ring correctly — a
// chain that enters from outside (e.g. Alki, whose coast starts NE of frame)
// must get its entry crossing inserted, not just its first interior vertex.
function clipRuns(chain) {
  const runs = [];
  let cur = null;
  for (let i = 0; i < chain.length; i++) {
    const p = chain[i], pin = inFrame(p), prev = chain[i - 1];
    if (pin) {
      if (!cur) { cur = []; if (prev) cur.push(intersectFrame(p, prev)); } // entry crossing
      cur.push(p);
    } else if (cur) {
      cur.push(intersectFrame(prev, p)); // exit crossing (prev is inside)
      runs.push(cur); cur = null;
    }
  }
  if (cur) runs.push(cur);
  return runs.filter(r => r.length >= 2);
}
// Point where segment inside→outside crosses the frame rectangle (smallest t>0).
function intersectFrame(inside, outside) {
  const [x0, y0] = inside, dx = outside[0] - x0, dy = outside[1] - y0;
  let t = 1;
  for (const [num, den] of [[FR.x0 - x0, dx], [FR.x1 - x0, dx], [FR.y0 - y0, dy], [FR.y1 - y0, dy]]) {
    if (Math.abs(den) < 1e-9) continue;
    const tt = num / den;
    if (tt > 1e-9 && tt < t) {
      const px = x0 + dx * tt, py = y0 + dy * tt;
      if (px >= FR.x0 - 0.5 && px <= FR.x1 + 0.5 && py >= FR.y0 - 0.5 && py <= FR.y1 + 0.5) t = tt;
    }
  }
  // Snap exactly onto the nearest edge so perim() recognises it.
  let x = x0 + dx * t, y = y0 + dy * t;
  const d = [[Math.abs(x - FR.x0), 'x0'], [Math.abs(x - FR.x1), 'x1'], [Math.abs(y - FR.y0), 'y0'], [Math.abs(y - FR.y1), 'y1']].sort((a, b) => a[0] - b[0])[0][1];
  if (d === 'x0') x = FR.x0; else if (d === 'x1') x = FR.x1; else if (d === 'y0') y = FR.y0; else y = FR.y1;
  return [x, y];
}

// Parameterise the frame perimeter clockwise, 0..4, so we can walk from one
// border point to another collecting the corners in between.
function perim(p) {
  const { x0, y0, x1, y1 } = FR;
  if (Math.abs(p[1] - y0) < 1e-6) return (p[0] - x0) / (x1 - x0);              // top L→R
  if (Math.abs(p[0] - x1) < 1e-6) return 1 + (p[1] - y0) / (y1 - y0);          // right T→B
  if (Math.abs(p[1] - y1) < 1e-6) return 2 + (x1 - p[0]) / (x1 - x0);          // bottom R→L
  return 3 + (y1 - p[1]) / (y1 - y0);                                          // left B→T
}
const CORNERS = [[FR.x1, FR.y0], [FR.x1, FR.y1], [FR.x0, FR.y1], [FR.x0, FR.y0]]; // t=1,2,3,4
function walkPerim(fromT, toT, dir) {
  // Collect corner points from fromT to toT going in `dir` (+1 CW, -1 CCW).
  const pts = [];
  let t = fromT;
  for (let n = 0; n < 5; n++) {
    t = dir > 0 ? Math.floor(t + 1) : Math.ceil(t - 1);
    let tt = ((t % 4) + 4) % 4;
    const reached = dir > 0 ? crossedCW(fromT, toT, t) : crossedCCW(fromT, toT, t);
    if (reached) break;
    pts.push(CORNERS[(Math.round(tt) + 3) % 4]);
  }
  return pts;
}
function crossedCW(a, b, t) { const span = ((b - a) % 4 + 4) % 4; return ((t - a) % 4 + 4) % 4 >= span; }
function crossedCCW(a, b, t) { const span = ((a - b) % 4 + 4) % 4; return ((a - t) % 4 + 4) % 4 >= span; }

function pointInRing(pt, ring) {
  let hit = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if (((yi > pt[1]) !== (yj > pt[1])) && (pt[0] < (xj - xi) * (pt[1] - yi) / (yj - yi) + xi)) hit = !hit;
  }
  return hit;
}

function coastlineToWater(ways) {
  const out = [];
  for (const chain of mergeChains(ways)) {
    for (const run of clipRuns(chain)) {
      const A = run[0], B = run[run.length - 1];
      // Fully-closed island already: keep as a ring.
      if (Math.hypot(A[0] - B[0], A[1] - B[1]) < 2 && run.length >= 4) { out.push(run); continue; }
      // Water-side test point: just to the RIGHT of the run's midpoint.
      const m = Math.floor(run.length / 2);
      const a = run[Math.max(0, m - 1)], b = run[Math.min(run.length - 1, m + 1)];
      const dx = b[0] - a[0], dy = b[1] - a[1], L = Math.hypot(dx, dy) || 1;
      const test = [run[m][0] - dy / L * 10, run[m][1] + dx / L * 10]; // right = (-dy,dx) in screen coords
      const tB = perim(B), tA = perim(A);
      const cw = run.concat(walkPerim(tB, tA, +1), [A]);
      const ccw = run.concat(walkPerim(tB, tA, -1), [A]);
      const ring = pointInRing(test, cw) ? cw : (pointInRing(test, ccw) ? ccw : null);
      if (ring && ring.length >= 3) out.push(ring.map(p => [Math.round(p[0] * 10) / 10, Math.round(p[1] * 10) / 10]));
    }
  }
  return out;
}

async function buildArea(a, seed = 0) {
  const c = { lng: a.lng, lat: a.lat, cos: Math.cos(a.lat * Math.PI / 180) };
  const px = project(c);
  const dLng = HALF_W_M / (111320 * c.cos), dLat = HALF_H_M / 111320;
  const bbox = `${a.lat - dLat},${a.lng - dLng},${a.lat + dLat},${a.lng + dLng}`;

  const q = `[out:json][timeout:90];
(
  way["highway"~"^(motorway|trunk|primary|secondary|tertiary|unclassified|residential|living_street|pedestrian)$"](${bbox});
  way["natural"="water"](${bbox});
  way["natural"="coastline"](${bbox});
  way["waterway"="riverbank"](${bbox});
  way["landuse"~"^(reservoir|basin)$"](${bbox});
  way["leisure"~"^(park|garden|common|recreation_ground|nature_reserve)$"](${bbox});
  relation["natural"="water"](${bbox});
);
out geom;`;

  const elements = await overpass(q, seed);
  const water = [], parks = [], stMinor = [], stMajor = [];
  const coast = []; // natural=coastline ways (open lines) — see coastlineToWater
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
    if (t.natural === 'coastline') {
      // Open line, land on the LEFT / water on the RIGHT of node order. Kept
      // raw (projected but unsimplified) so chains can be merged before closing.
      coast.push(el.geometry.map(g => px(g.lon, g.lat)));
    } else if (t.natural === 'water' || t.waterway === 'riverbank' || t.landuse === 'reservoir' || t.landuse === 'basin') {
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

  // Fold closed ocean/sound polygons in FIRST so they draw behind lakes/rivers
  // (which are already precise natural=water polygons).
  if (coast.length) water.unshift(...coastlineToWater(coast));

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
