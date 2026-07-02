#!/usr/bin/env node
// tools/generate-data.mjs
//
// Pulls per-neighborhood safety data for the /safety/ pages from a SafeRoute
// backend — by design a LOCAL one (boot the backend repo with `PORT=3111 node
// src/index.js`, then run this): 200 bbox queries belong on a throwaway local
// process hitting the upstream open-data APIs directly, never on the free-tier
// prod dyno.
//
// Per neighborhood it stores a trimmed snapshot (score, band, counts, category
// breakdown, time-of-day profile, and a capped sample of incident points for
// the page's SVG map) in tools/data-cache/<city>/<slug>.json — the build cache,
// committed so monthly rebuilds are incremental — and finally writes the small
// published index (safety/data/<city>/index.json) that powers the client-side
// area checker.
//
// Env:  SAFEROUTE_API_KEY (required) · SAFEROUTE_BASE_URL (default local :3111)
// Run:  node tools/generate-data.mjs [--force] [--city new-york]

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const BASE = process.env.SAFEROUTE_BASE_URL || 'http://localhost:3111';
const KEY = process.env.SAFEROUTE_API_KEY;
if (!KEY) { console.error('SAFEROUTE_API_KEY required'); process.exit(1); }

const FORCE = process.argv.includes('--force');
const cityArg = process.argv[process.argv.indexOf('--city') + 1];
const CITY = process.argv.includes('--city') ? cityArg : 'new-york';
const RADIUS = 1000;           // metres — matches the app's Nearby default
const MAX_POINTS = 500;        // incident points kept for the page SVG map
// The backend rate-limits to 60 req/min — default pacing stays safely under it.
const CONCURRENCY = Number(process.env.GEN_CONCURRENCY || 1);
const DELAY_MS = Number(process.env.GEN_DELAY_MS || 1200);

const gaz = JSON.parse(readFileSync(join(ROOT, 'tools', 'gazetteer', `${CITY}.json`)));
const cacheDir = join(ROOT, 'tools', 'data-cache', CITY);
const outDir = join(ROOT, 'safety', 'data', CITY);
mkdirSync(cacheDir, { recursive: true });
mkdirSync(outDir, { recursive: true });

// Deterministic stride sample — stable across rebuilds with unchanged data.
function samplePoints(incidents) {
  if (!incidents || incidents.length <= MAX_POINTS) return incidents || [];
  const step = incidents.length / MAX_POINTS;
  const out = [];
  for (let i = 0; i < MAX_POINTS; i++) out.push(incidents[Math.floor(i * step)]);
  return out;
}

async function fetchArea(a, attempt = 1) {
  try {
    const res = await fetch(`${BASE}/area-safety?lat=${a.lat}&lng=${a.lng}&radius=${RADIUS}`,
      { headers: { 'X-SafeRoute-Key': KEY }, signal: AbortSignal.timeout(45_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const j = await res.json();
    if (j.dataUnavailable || !(j.totalIncidents >= 0)) throw new Error('dataUnavailable');
    return j;
  } catch (e) {
    if (attempt < 3) { await new Promise(r => setTimeout(r, 1500 * attempt)); return fetchArea(a, attempt + 1); }
    throw e;
  }
}

const queue = [...gaz.areas];
const failed = [];
let done = 0, skipped = 0;

async function worker() {
  for (;;) {
    const a = queue.shift();
    if (!a) return;
    const file = join(cacheDir, `${a.slug}.json`);
    if (!FORCE && existsSync(file)) { skipped++; continue; }
    try {
      const j = await fetchArea(a);
      writeFileSync(file, JSON.stringify({
        slug: a.slug, name: a.name, borough: a.borough,
        lat: a.lat, lng: a.lng, radiusMetres: j.radiusMetres,
        crimeDate: j.crimeDate,
        safetyScore: j.safetyScore, band: j.band,
        totalIncidents: j.totalIncidents, weightedIncidents: j.weightedIncidents,
        densityPerKm2: j.densityPerKm2,
        breakdown: j.breakdown,
        timeOfDay: j.timeOfDay, timeOfDayIsRealData: j.timeOfDayIsRealData,
        dataSource: j.dataSource, policeForce: j.policeForce,
        incidents: samplePoints(j.incidents).map(p => ({ lat: +p.lat.toFixed(5), lng: +p.lng.toFixed(5), w: p.weight })),
        fetchedAt: new Date().toISOString().slice(0, 10),
      }));
      done++;
      if (done % 20 === 0) console.log(`  ${done} fetched (${queue.length} left)`);
      if (DELAY_MS) await new Promise(r => setTimeout(r, DELAY_MS));
    } catch (e) {
      failed.push({ slug: a.slug, error: e.message });
      console.error(`  FAIL ${a.slug}: ${e.message}`);
    }
  }
}

console.log(`generate-data: ${CITY} — ${gaz.areas.length} areas → ${BASE}`);
await Promise.all(Array.from({ length: CONCURRENCY }, worker));

// Published index — powers the client-side checker + hub table.
const index = gaz.areas.flatMap(a => {
  const f = join(cacheDir, `${a.slug}.json`);
  if (!existsSync(f)) return [];
  const j = JSON.parse(readFileSync(f));
  return [{ slug: a.slug, name: a.name, borough: a.borough,
            score: j.safetyScore, band: j.band, total: j.totalIncidents, date: j.crimeDate }];
});
writeFileSync(join(outDir, 'index.json'), JSON.stringify({
  city: gaz.city, citySlug: gaz.citySlug, generatedAt: new Date().toISOString().slice(0, 10), areas: index,
}));

console.log(`done: ${done} fetched, ${skipped} cached, ${failed.length} failed · index: ${index.length} areas`);
if (failed.length) { console.log('failed:', JSON.stringify(failed)); process.exitCode = 1; }
