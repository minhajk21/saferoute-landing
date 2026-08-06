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
// Keyless mode: with no API key, fall back to the public read-only endpoint
// (/public/area) — it returns every field the /safety/ pages need, so local
// regeneration needs no secret. CI still passes the key and uses /area-safety.
// The public endpoint is rate-limited to 30/min per IP, so pace above ~2 s
// between requests (GEN_DELAY_MS) when running keyless.
if (!KEY) console.warn('[generate-data] no SAFEROUTE_API_KEY — using keyless /public/area (keep GEN_DELAY_MS ≥ 2100 to stay under its 30/min limit)');

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
    const url = KEY
      ? `${BASE}/area-safety?lat=${a.lat}&lng=${a.lng}&radius=${RADIUS}`
      : `${BASE}/public/area?lat=${a.lat}&lng=${a.lng}`;   // keyless: public endpoint is fixed at 1 km
    const res = await fetch(url,
      { headers: KEY ? { 'X-SafeRoute-Key': KEY } : {}, signal: AbortSignal.timeout(45_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const j = await res.json();
    // /area-safety flags gaps with dataUnavailable; /public/area with covered:false.
    if (j.dataUnavailable || j.covered === false || !(j.totalIncidents >= 0)) throw new Error('dataUnavailable');
    return j;
  } catch (e) {
    // A 5xx or a timeout from the backend is almost always the free Render dyno
    // cold-starting or restarting, which takes ~30s — far longer than the old
    // 1.5s/3s backoff could ride out. That is exactly how the 2026-08-02 monthly
    // rebuild died: two London areas got HTTP 503, and the whole 27-minute job
    // aborted. Transient failures now get more attempts and a much longer wait;
    // everything else (a 4xx, a genuine dataUnavailable) still fails fast,
    // because waiting will not fix those.
    const transient = /HTTP 5\d\d|timeout|aborted|fetch failed|network/i.test(e.message || '');
    const maxAttempts = transient ? 5 : 3;
    if (attempt < maxAttempts) {
      const wait = transient ? Math.min(8000 * attempt, 30_000) : 1500 * attempt;
      await new Promise(r => setTimeout(r, wait));
      return fetchArea(a, attempt + 1);
    }
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
        // How many days of incidents that count covers. The renderer needs it to
        // say "over the 7 months to August" instead of leaving a reader to guess
        // whether a number is a month's worth or a year's. Null on older cached
        // records and on providers with no observed span; the renderer then says
        // nothing rather than inventing a period.
        windowDays: j.windowDays ?? null,
        safetyScore: j.safetyScore, band: j.band,
        totalIncidents: j.totalIncidents, weightedIncidents: j.weightedIncidents,
        densityPerKm2: j.densityPerKm2,
        breakdown: j.breakdown,
        timeOfDay: j.timeOfDay, timeOfDayIsRealData: j.timeOfDayIsRealData,
        dataSource: j.dataSource, policeForce: j.policeForce,
        incidents: samplePoints(j.incidents).map(p => ({ lat: +p.lat.toFixed(5), lng: +p.lng.toFixed(5), w: p.weight ?? p.w })),
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
if (failed.length) {
  console.log('failed:', JSON.stringify(failed));
  // Tolerate a few stragglers. An area that fails KEEPS its previous cached
  // file, so the render still has data for it — just a little staler — and the
  // index above already counts it. Failing the whole run over that trades a
  // couple of slightly-stale areas for ZERO refreshed areas across every city,
  // which is what happened on 2026-08-02: two London 503s out of 1,222 fetches
  // aborted the pipeline before it rendered or pushed anything, and the site
  // then sat unrefreshed for a month. Still fails loudly on a real outage.
  const tolerated = Math.max(3, Math.ceil(gaz.areas.length * 0.02));
  if (failed.length > tolerated) {
    console.log(`FAILING: ${failed.length} failures exceeds the ${tolerated} tolerated for ${gaz.areas.length} areas.`);
    process.exitCode = 1;
  } else {
    console.log(`Tolerating ${failed.length}/${tolerated} failures — those areas keep their previous data.`);
  }
}
