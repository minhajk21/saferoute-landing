#!/usr/bin/env node
// tools/audit-centroids.mjs
//
// The centroid audit, encoded. Run it for every new SEO city before publishing.
//
// Two failure modes put a wrong number on a page, and they need different
// remedies, so the audit has to tell them apart rather than just flag "odd":
//
//   CENTROID IN A VOID — the area spans built-up land plus water, parkland,
//   airfield or industry, the geometric centre lands in the emptiness, and the
//   1 km circle misses where people actually live. The page then reads falsely
//   safe. Remedy: move the centre onto the built form.
//
//   GENUINELY QUIET — an affluent or rural area really does have very little
//   recorded crime. Remedy: nothing, or a caveat explaining the land use. This
//   is NOT a bug, and auto-"fixing" it publishes a lie in the other direction.
//
// Stage 1 is free: a neighbour-ratio screen over the cached data, flagging any
// area under RATIO_FLAG of the median count of its four nearest neighbours.
// Stage 2 probes only what stage 1 flags, so the request cost stays small.
//
// TWO LESSONS ARE BAKED IN HERE, both learned the hard way on Leeds:
//
//   1. EIGHT compass points, not four. A four-point cardinal ring cannot see a
//      displacement that runs DIAGONALLY. Leeds's Garforth (population to the
//      north-east) and Adel (population to the south) both returned "genuinely
//      quiet" from a four-point ring because every direction it sampled really
//      was empty; both were over 1.8 km from their population centres and both
//      roughly quadrupled their incident count once moved.
//
//   2. The radius SCALES with the city's own geometry. Probing 700 m in a city
//      whose areas are 17 km² keeps the whole ring inside the same void and
//      under-reads. It is set from the median nearest-centroid spacing.
//
// Usage:
//   node tools/audit-centroids.mjs --city dallas
//   node tools/audit-centroids.mjs --city leeds --ratio 0.25 --delay 2200

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const arg = (k, d) => {
  const i = process.argv.indexOf(`--${k}`);
  return i > -1 ? process.argv[i + 1] : d;
};

const CITY = arg('city');
if (!CITY) throw new Error('--city is required');
const RATIO_FLAG = Number(arg('ratio', 0.25));   // stage-1 screen
const DISPLACED_AT = Number(arg('displaced', 0.20));
const QUIET_AT = Number(arg('quiet', 0.25));
const DELAY = Number(arg('delay', 2200));        // /public/area is rate-limited
const BASE = process.env.SAFEROUTE_BASE_URL || 'https://saferoute-backend-w5yf.onrender.com';

const cacheDir = join(ROOT, 'tools', 'data-cache', CITY);
if (!existsSync(cacheDir)) throw new Error(`no data cache for "${CITY}" — fetch it first`);
const areas = readdirSync(cacheDir).filter((f) => f.endsWith('.json'))
  .map((f) => JSON.parse(readFileSync(join(cacheDir, f))));

const havM = (a, b) => {
  const R = 6371000, rad = (d) => (d * Math.PI) / 180;
  const dp = rad(b.lat - a.lat), dl = rad(b.lng - a.lng);
  const q = Math.sin(dp / 2) ** 2 +
    Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dl / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(q));
};
const median = (xs) => [...xs].sort((x, y) => x - y)[Math.floor(xs.length / 2)];

// ── stage 1: neighbour-ratio screen (free) ──
const flagged = [];
for (const a of areas) {
  const near = areas.filter((b) => b.slug !== a.slug)
    .map((b) => ({ b, d: havM(a, b) })).sort((x, y) => x.d - y.d).slice(0, 4);
  const nm = median(near.map((n) => n.b.totalIncidents ?? 0));
  const ratio = (a.totalIncidents ?? 0) / Math.max(1, nm);
  if (ratio < RATIO_FLAG) flagged.push({ a, nm, ratio, near: near.map((n) => n.b.name) });
}

// Radius: far enough to clear the area itself, from the city's own scale.
const spacing = median(areas.map((a) =>
  Math.min(...areas.filter((b) => b.slug !== a.slug).map((b) => havM(a, b)))));
const RADIUS_M = Math.max(700, Math.round(spacing * 0.6));

console.log(`${CITY}: ${areas.length} areas · median centroid spacing ${Math.round(spacing)} m · ring radius ${RADIUS_M} m`);
console.log(`stage 1 — ${flagged.length} area(s) under ${RATIO_FLAG}x their neighbours' median count\n`);
if (!flagged.length) { console.log('nothing to probe.'); process.exit(0); }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function incidentsAt(lat, lng) {
  for (let i = 0; i < 3; i++) {
    try {
      const r = await fetch(`${BASE}/public/area?lat=${lat.toFixed(6)}&lng=${lng.toFixed(6)}`,
        { headers: { Origin: 'https://safe-route.app' }, signal: AbortSignal.timeout(60_000) });
      if (r.ok) return (await r.json()).totalIncidents ?? 0;
    } catch { /* retry */ }
    await sleep(4000);
  }
  return -1;
}

// Eight compass points. See lesson 1 above — four is not enough.
const DIRS = [['N', 1, 0], ['NE', 1, 1], ['E', 0, 1], ['SE', -1, 1],
              ['S', -1, 0], ['SW', -1, -1], ['W', 0, -1], ['NW', 1, -1]];

console.log('stage 2 — ring probe');
console.log(`${'area'.padEnd(32)}${'centre'.padStart(7)}${'ringMax'.padStart(9)}${'at'.padStart(4)}${'ratio'.padStart(7)}  verdict`);
const results = [];
for (const { a } of flagged) {
  const dLat = RADIUS_M / 111320;
  const dLng = dLat / Math.cos((a.lat * Math.PI) / 180);
  const ring = [];
  for (const [label, sy, sx] of DIRS) {
    const k = (sy !== 0 && sx !== 0) ? Math.SQRT1_2 : 1;   // keep diagonals the same distance out
    ring.push({ label, n: await incidentsAt(a.lat + sy * dLat * k, a.lng + sx * dLng * k) });
    await sleep(DELAY);
  }
  const best = ring.reduce((p, c) => (c.n > p.n ? c : p), ring[0]);
  const ratio = (a.totalIncidents ?? 0) / Math.max(1, best.n);
  const verdict = ratio < DISPLACED_AT ? 'DISPLACED — move the centre'
    : ratio > QUIET_AT ? 'genuinely quiet — caveat or leave'
    : 'ambiguous — inspect by hand';
  console.log(`${a.name.padEnd(32)}${String(a.totalIncidents).padStart(7)}${String(best.n).padStart(9)}${best.label.padStart(4)}${ratio.toFixed(2).padStart(7)}  ${verdict}`);
  results.push({ name: a.name, slug: a.slug, centre: a.totalIncidents, best, ratio, verdict });
}

const moved = results.filter((r) => r.verdict.startsWith('DISPLACED'));
console.log(`\n${moved.length} displaced, ${results.length - moved.length} cleared.`);
if (moved.length) {
  console.log('Probe toward the named direction for a built-up point, assert it inside the polygon,');
  console.log('and choose for BUILT FORM and the largest named settlement — never the highest count.');
}
