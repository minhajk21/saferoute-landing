#!/usr/bin/env node
// tools/fetch-basemap.mjs
//
// Build-time vector basemap for the /safety/ page maps, drawn from NYC Open
// Data — no tile servers, no Mapbox static images (whose terms forbid storing
// the output), no runtime dependencies. Per neighborhood we cache, already
// projected into the page map's 640×430 px frame:
//   land   — borough boundaries (water-excluded, gthc-hcne) clipped to the
//            viewport; everything behind them renders as water
//   parks  — Parks Properties polygons (enfh-gkve)
//   streets— CSCL centerlines (inkn-q76z), split minor/major, + the two most
//            prominent street names as pre-positioned labels
//
// Output: tools/data-cache/<city>-basemap/<slug>.json (small, committed).
// Run:    node tools/fetch-basemap.mjs [--force] [--city new-york]

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CITY = process.argv.includes('--city') ? process.argv[process.argv.indexOf('--city') + 1] : 'new-york';
const FORCE = process.argv.includes('--force');

// Must mirror render-pages.mjs mapSVG's frame exactly.
const W = 640, H = 430, CX = W / 2, CY = H / 2;
const SCALE = (H - 40) / 2 / 1000;             // px per metre (1 km ring fits height)
const HALF_W_M = CX / SCALE + 120;             // metres covered by half the frame + margin
const HALF_H_M = CY / SCALE + 120;

const gaz = JSON.parse(readFileSync(join(ROOT, 'tools', 'gazetteer', `${CITY}.json`)));
const outDir = join(ROOT, 'tools', 'data-cache', `${CITY}-basemap`);
mkdirSync(outDir, { recursive: true });

const SODA = 'https://data.cityofnewyork.us/resource';
const soda = async (id, params) => {
  const u = new URL(`${SODA}/${id}.geojson`);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  for (let attempt = 1; ; attempt++) {
    try {
      const r = await fetch(u, { signal: AbortSignal.timeout(90_000) });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return (await r.json()).features || [];
    } catch (e) {
      if (attempt >= 3) throw e;
      await new Promise(res => setTimeout(res, 2500 * attempt));
    }
  }
};

// ── shared geometry helpers (px space) ───────────────────────────────────────
const project = (c) => (lng, lat) => [
  CX + (lng - c.lng) * 111320 * c.cos * SCALE,
  CY - (lat - c.lat) * 111320 * SCALE,
];

// Drop near-duplicate vertices; quantize to 0.1px. Keeps files/pages small.
function simplify(pts, minGap = 1.3) {
  const out = [];
  for (const p of pts) {
    const last = out[out.length - 1];
    if (!last || Math.hypot(p[0] - last[0], p[1] - last[1]) >= minGap) out.push(p);
  }
  if (out.length > 1) out[out.length - 1] = pts[pts.length - 1];
  return out.map(p => [Math.round(p[0] * 10) / 10, Math.round(p[1] * 10) / 10]);
}

// Sutherland–Hodgman ring clip against the (convex) viewport rect.
function clipRing(ring, x0 = -10, y0 = -10, x1 = W + 10, y1 = H + 10) {
  const edges = [
    (p) => p[0] >= x0, (p) => p[0] <= x1, (p) => p[1] >= y0, (p) => p[1] <= y1,
  ];
  const cross = [
    (a, b) => [x0, a[1] + (b[1] - a[1]) * (x0 - a[0]) / (b[0] - a[0])],
    (a, b) => [x1, a[1] + (b[1] - a[1]) * (x1 - a[0]) / (b[0] - a[0])],
    (a, b) => [a[0] + (b[0] - a[0]) * (y0 - a[1]) / (b[1] - a[1]), y0],
    (a, b) => [a[0] + (b[0] - a[0]) * (y1 - a[1]) / (b[1] - a[1]), y1],
  ];
  let poly = ring;
  for (let e = 0; e < 4; e++) {
    const inp = poly; poly = [];
    for (let i = 0; i < inp.length; i++) {
      const a = inp[i], b = inp[(i + 1) % inp.length];
      const ain = edges[e](a), bin = edges[e](b);
      if (ain) poly.push(a);
      if (ain !== bin) poly.push(cross[e](a, b));
    }
    if (!poly.length) return [];
  }
  return poly;
}

const ringsOf = (geometry) =>
  (geometry.type === 'MultiPolygon' ? geometry.coordinates : [geometry.coordinates])
    .flatMap(poly => poly); // every ring (outer + holes) — rendered with evenodd

// Title-case "W 246 ST" → "W 246 St"
const nice = (s) => String(s || '').trim().toLowerCase()
  .replace(/\b([a-z])/g, m => m.toUpperCase())
  .replace(/\b(Ne|Nw|Se|Sw|Ns|Ew)\b/g, m => m.toUpperCase());

// ── land source (boroughs, water-excluded) — fetched once, clipped per area ──
const landPath = join(tmpdir(), 'nyc-boroughs.geojson');
let landFeatures;
if (existsSync(landPath) && !FORCE) {
  landFeatures = JSON.parse(readFileSync(landPath)).features;
  console.log('land: using cached borough boundaries');
} else {
  console.log('land: fetching borough boundaries (once)…');
  landFeatures = await soda('gthc-hcne', { $limit: 10 });
  writeFileSync(landPath, JSON.stringify({ features: landFeatures }));
}
const landRings = landFeatures.flatMap(f => ringsOf(f.geometry));
console.log(`land: ${landRings.length} rings citywide`);

// rw_type: 1 street, 2 highway, 3 bridge, 5 boardwalk, 9 ramp, 10 alley — drawn.
// 4 tunnels, 6/7 paths+steps, 8 driveways, 12+ non-physical — skipped.
const DRAWN_TYPES = new Set(['1', '2', '3', '5', '9', '10']);

async function buildArea(a) {
  const c = { lng: a.lng, lat: a.lat, cos: Math.cos(a.lat * Math.PI / 180) };
  const px = project(c);
  const dLng = HALF_W_M / (111320 * c.cos), dLat = HALF_H_M / 111320;
  const wkt = `POLYGON((${a.lng - dLng} ${a.lat - dLat}, ${a.lng + dLng} ${a.lat - dLat}, ${a.lng + dLng} ${a.lat + dLat}, ${a.lng - dLng} ${a.lat + dLat}, ${a.lng - dLng} ${a.lat - dLat}))`;

  // land: project + clip citywide rings to this viewport
  const land = [];
  for (const ring of landRings) {
    const clipped = clipRing(ring.map(([lng, lat]) => px(lng, lat)));
    if (clipped.length >= 3) {
      const s = simplify(clipped);
      if (s.length >= 3) land.push(s);
    }
  }

  const [streetFeats, parkFeats] = await Promise.all([
    soda('inkn-q76z', { $where: `intersects(the_geom,'${wkt}')`, $select: 'the_geom,stname_label,rw_type,streetwidth', $limit: 8000 }),
    soda('enfh-gkve', { $where: `intersects(multipolygon,'${wkt}')`, $select: 'multipolygon', $limit: 600 }),
  ]);

  const parks = parkFeats.flatMap(f => ringsOf(f.geometry))
    .map(r => simplify(clipRing(r.map(([lng, lat]) => px(lng, lat)))))
    .filter(r => r.length >= 3);

  const stMinor = [], stMajor = [];
  const byName = new Map(); // label candidates: name → { len, seg: longest polyline }
  for (const f of streetFeats) {
    const t = f.properties.rw_type?.trim();
    if (!DRAWN_TYPES.has(t)) continue;
    const width = Number(f.properties.streetwidth) || 0;
    const major = t === '2' || t === '3' || width >= 30;
    const lines = f.geometry.type === 'MultiLineString' ? f.geometry.coordinates : [f.geometry.coordinates];
    for (const line of lines) {
      const p = simplify(line.map(([lng, lat]) => px(lng, lat)));
      if (p.length < 2) continue;
      (major ? stMajor : stMinor).push(p);
      const name = f.properties.stname_label;
      if (name && t !== '9' && !/UNNAMED/i.test(name)) {
        let len = 0;
        for (let i = 1; i < p.length; i++) len += Math.hypot(p[i][0] - p[i - 1][0], p[i][1] - p[i - 1][1]);
        const e = byName.get(name) || { len: 0, best: null, bestLen: 0 };
        e.len += len;
        if (len > e.bestLen) { e.bestLen = len; e.best = p; }
        byName.set(name, e);
      }
    }
  }

  // two most prominent street names, positioned + rotated along their segment;
  // candidates whose anchor falls outside the visible frame are skipped (the
  // fetch bbox is wider than the viewport, so a long road's midpoint can land
  // off-canvas — an invisible label).
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

  return { land, parks, stMinor, stMajor, labels };
}

let done = 0, skipped = 0; const failed = [];
for (const a of gaz.areas) {
  const file = join(outDir, `${a.slug}.json`);
  if (!FORCE && existsSync(file)) { skipped++; continue; }
  try {
    const b = await buildArea(a);
    writeFileSync(file, JSON.stringify(b));
    done++;
    if (done % 10 === 0) console.log(`  ${done} built (${gaz.areas.length - done - skipped} left)`);
    await new Promise(r => setTimeout(r, 300));
  } catch (e) {
    failed.push({ slug: a.slug, error: e.message });
    console.error(`  FAIL ${a.slug}: ${e.message}`);
  }
}
console.log(`basemaps: ${done} built, ${skipped} cached, ${failed.length} failed`);
if (failed.length) { console.log(JSON.stringify(failed)); process.exitCode = 1; }
