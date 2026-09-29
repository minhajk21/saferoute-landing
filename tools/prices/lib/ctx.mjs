// The ctx every home-prices source module is given (tools/prices/README.md):
//
//   const ctx = makeCtx({ rawDir, frozen, log });
//   ctx.download(file, urls, opts)   the schools downloader (cache + provenance
//                                    sidecars + --frozen), made polite: see below
//   ctx.discard(file)                forget a cached file that failed the source's
//                                    format check (see below)
//   ctx.provenance                   what was downloaded, for index.json upstream
//   ctx.log / ctx.warn
//   ctx.coverage                     [{ id, country, bbox: [s, w, n, e] }], backend order
//   ctx.regions                      { id: tools/schools/regions.mjs entry (name,
//                                    juris, outside, view, viewName, tz) + this
//                                    layer's decision (sources | none, currency,
//                                    scales) + country + bbox }
//   ctx.inBox(bbox, lat, lng)
//   ctx.readers                      { parseCsv, records, columns, unzip, xlsx,
//                                    sheetRecords, shp }
//   ctx.frozen
//
// POLITE BY DEFAULT. Every request carries UA, a named user agent with a
// contact (ONS asks for one). Pass ua: null to send Node's default instead
// (admin.opendatani.gov.uk 403s ours), or any string to send that; a
// non-default choice is recorded in the file's provenance (`ua`), so the
// build's upstream check asks that host the same way. Requests are paced per
// host, and a 429/503 is waited out (its Retry-After, capped) and retried, so
// a rate-limited host (ONS: ~15 requests per 10 s) is never hammered.
//
// RAW DOWNLOADS NEVER GO INTO THE REPO: rawDir defaults to the OS temp dir
// ($TMPDIR/saferoute-prices-raw), shared by every source, so a file one run
// cached is reused by the next (downloader maxAgeH, default 12 h).

import { existsSync, unlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { makeDownloader } from '../../schools/lib/download.mjs';
import { parseCsv, records, columns } from '../../schools/lib/csv.mjs';
import { loadCoverage, inBox } from '../../schools/lib/coverage.mjs';
import { unzip, xlsx, sheetRecords } from '../../schools/ratings/_us.mjs';
import { PRICE_REGIONS, decisionProblems } from '../regions.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
export const UA = 'SafeRouteBuild/1.0 (+https://safe-route.app; minhaj@safe-route.app)';
export const RAW_DIR = join(tmpdir(), 'saferoute-prices-raw');

// lib/shp.mjs is its own lane's file. Loaded if present, so this module (and
// every source that does not read shapefiles) works without it; a source that
// needs it gets the reason, not a TypeError.
let shp = null, shpError = 'tools/prices/lib/shp.mjs does not exist yet';
if (existsSync(join(HERE, 'shp.mjs'))) {
  try { const m = await import(pathToFileURL(join(HERE, 'shp.mjs')).href); shp = m.default ?? m; }
  catch (e) { shpError = `tools/prices/lib/shp.mjs failed to load: ${e.message}`; }
}
const fail = () => { throw new Error(shpError); };
const shpMissing = new Proxy(fail, { get: (_, k) => (typeof k === 'symbol' ? undefined : fail) });

// ── politeness ──────────────────────────────────────────────────────────────
// Minimum gap between requests to one host. ONS 429s past ~15 in 10 s.
const SPACING_MS = { 'www.ons.gov.uk': 800, 'api.beta.ons.gov.uk': 800 };
const DEFAULT_SPACING_MS = 150;
const MAX_WAIT_MS = 120_000, TRIES = 4;
const lastAt = new Map();
const sleep = ms => new Promise(r => setTimeout(r, ms));

export function retryAfterMs(h, now = Date.now()) {
  if (!h) return null;
  if (/^\d+$/.test(h.trim())) return +h * 1000;
  const t = Date.parse(h);
  return Number.isFinite(t) ? Math.max(0, t - now) : null;
}

// fetch(), paced per host and patient with 429/503. Same signature.
// The slot is RESERVED before waiting: callers that arrive together each read
// and advance the host's next free time synchronously, so five at once go out
// a gap apart, not all at the end of the first one's wait.
export async function politeFetch(url, init = {}, log = () => {}) {
  const host = new URL(url).host;
  for (let attempt = 1; ; attempt++) {
    const gap = SPACING_MS[host] ?? DEFAULT_SPACING_MS;
    const at = Math.max((lastAt.get(host) ?? -Infinity) + gap, Date.now());
    lastAt.set(host, at);
    if (at > Date.now()) await sleep(at - Date.now());
    const res = await fetch(url, init);
    if ((res.status !== 429 && res.status !== 503) || attempt >= TRIES) return res;
    const ms = retryAfterMs(res.headers.get('retry-after')) ?? 10_000 * attempt;
    await res.body?.cancel().catch(() => {});
    if (ms > MAX_WAIT_MS) { log(`  ${host} asked us to wait ${Math.round(ms / 1000)}s — giving up on this URL`); return res; }
    log(`  ${host} answered ${res.status}; waiting ${Math.round(ms / 1000)}s (attempt ${attempt} of ${TRIES})`);
    await sleep(ms);
  }
}

// ── regions ─────────────────────────────────────────────────────────────────
// Coverage (the backend's rectangles) + schools' region facts + this layer's
// decisions. Throws if any coverage region has no prices decision.
export function loadRegions() {
  const cov = loadCoverage();
  const probs = decisionProblems(cov.regions.map(r => r.id));
  if (probs.length) throw new Error(`prices decisions: ${probs.join('; ')} — a new crime city needs a prices decision, so the build stops here`);
  const regions = {};
  for (const r of cov.regions) regions[r.id] = { ...r, ...PRICE_REGIONS[r.id] };
  return {
    coverage: cov.regions.map(r => ({ id: r.id, country: r.country, bbox: r.bbox })),
    regions, stale: cov.stale,
  };
}

export function makeCtx({ rawDir = RAW_DIR, frozen = false, log = console.log, warn = m => console.log(`::warning::${m}`), regions: reg = null } = {}) {
  const { coverage, regions } = reg || loadRegions();
  const dl = makeDownloader({ rawDir, frozen, log, fetchImpl: (u, i) => politeFetch(u, i, log) });
  return {
    rawDir, frozen, log, warn,
    async download(file, urls, opts = {}) {
      const ua = opts.ua === undefined ? UA : (opts.ua ?? undefined);
      const buf = await dl.download(file, urls, { ...opts, ua });
      // A host that needs another user agent (admin.opendatani.gov.uk refuses
      // ours) is asked the same way when the build checks it for changes.
      const rec = dl.provenance.findLast(p => p.file === file);
      if (rec && ua !== UA) rec.ua = ua ?? null;
      return buf;
    },
    // A cached answer that fails a source's format check (a firewall's block
    // page served with HTTP 200, a cut-off body) would otherwise be served
    // again, without asking the host, for the rest of its maxAgeH: the source
    // calls this before it throws, so the next run downloads it afresh.
    // --frozen never changes the cache: a frozen build must stay reproducible,
    // and the bad file is the evidence.
    discard(file) {
      if (frozen) return false;
      for (const f of [file, `${file}.meta.json`]) { try { unlinkSync(join(rawDir, f)); } catch {} }
      log(`  discarded cached ${file}: it failed the format check`);
      return true;
    },
    provenance: dl.provenance,
    coverage, regions, inBox,
    readers: { parseCsv, records, columns, unzip, xlsx, sheetRecords, shp: shp ?? shpMissing },
    UA,
  };
}
