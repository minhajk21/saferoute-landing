// Build the data behind the home-prices layer on /check/: official areas
// (census tracts, MSOAs, wards) shaded by their published home-value
// statistic, clipped to where SafeRoute has crime data (scope rule R2), cut
// into adaptive polygon tiles so the map fetches only the areas in view.
//
// This file is the ORCHESTRATOR. It knows no country: each source module in
// tools/prices/sources/ fetches and normalises its own areas (the contract is
// tools/prices/README.md, enforced by tools/prices/lib/schema.mjs), and this
// file validates them, applies R2, simplifies and encodes the polygons,
// computes each scale region's colour breaks, tiles, and writes index.json.
//
// THE SAFETY RULE. A source that throws re-emits its areas from the CURRENT
// tiles (status snapshot-after-failure, with a ::warning::), keeping the meta
// it was published with. The tiles are every source's snapshot, so a fetch
// failure can never empty a region from the map.
//
// CADENCE. These are annual and semi-annual statistics, so the monthly run
// does not refetch by habit. It asks each upstream file it was built from
// whether it changed (a HEAD: ETag, then Last-Modified; where a host refuses
// HEAD, a one-byte ranged GET; a small file with neither is fetched and
// compared by sha256; a source's own probe() can also announce a new release
// at a new URL). Unchanged -> the source re-emits its tiles byte-identical
// (status snapshot). When a file cannot tell, the source is fetched, and if
// every file it downloaded is byte-identical (sha256) to the ones behind the
// current tiles, the fetched areas are thrown away and the snapshot is kept,
// byte-identical again. A `static` source (the 2021 Census) is never asked:
// only --refresh refetches it. A host that cannot be reached at all keeps the
// snapshot (with a warning): a network blip is not a reason to download
// hundreds of megabytes.
//
// INPUTS. Upstream bytes are not the only thing a source's areas are made
// from: its module (flag rules, meta), its vendored lookups
// (tools/data/prices/<id>*), the rectangles, jurisdictions and decisions of
// the regions it serves, and the shared pipeline (PIPELINE below). Their
// fingerprint is kept in index.json (sources[id].inputs); when it differs the
// source is rebuilt, from the raw cache where it can be, so a code or
// coverage change reaches the map without a --refresh.
//
// A SUSPICIOUS FETCH IS A FAILED ONE. A fetch that keeps no area in scope,
// empties a region the source serves that had areas, or (unasked) loses more
// than a tenth of the areas published is treated like a throw: the snapshot
// is kept, with a ::warning::. A swapped coordinate order or a dropped city
// must never ship quietly. --refresh <id> accepts a smaller set, never an
// emptied region.
//
// STATUS. `snapshot-after-failure` (which /check/ tells visitors about) only
// when the source had something newer to give: an upstream change it could
// not fetch or use, or a --refresh. A speculative fetch that fails (upstream
// could not say, or only the inputs changed) keeps plain `snapshot`: the
// published figures are still the newest there are.
//
// A CONTRACT VIOLATION (a malformed area, a region that does not list the
// source, two sources on one colour scale...) stops the build before it
// writes anything: exit 1, and the published tiles stay as they were.
//
// RAW DOWNLOADS NEVER GO INTO THE REPO: they are cached in the OS temp dir.
//
// Usage:
//   node tools/build-prices.mjs                     check upstream; refetch only what changed
//   node tools/build-prices.mjs --refresh acs-tract refetch these (or "all") whatever upstream says
//   node tools/build-prices.mjs --only ons-msoa     fetch exactly these; every other source re-emits its snapshot
//   options: --frozen          never touch the network (raw cache only; upstream not checked)
//            --raw-dir <dir>   download cache (default <os tmp>/saferoute-prices-raw)
//            --out <dir>       output: <dir>/index.json + <dir>/tiles/ (default prices/data)
//            --snapshot <dir>  where the current tiles are read from (default: --out)
//            --sources <dir>   source modules (default tools/prices/sources)

import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { makeCtx, loadRegions, politeFetch, UA, RAW_DIR as DEFAULT_RAW_DIR } from './prices/lib/ctx.mjs';
import { INDEX_VERSION, FIELDS, SOURCES_DIR, loadSources, prepareAreas, isColoured, isUnpublished } from './prices/lib/schema.mjs';
import { bboxIntersects } from './prices/lib/geo.mjs';
import { computeBreaks } from './prices/lib/scale.mjs';
import { BASE, MAX_AREAS, MAX_BYTES, MIN_CELL, tileAreas, tileJson, tileStats, writeOutput, readAreasFromTiles, removeLeftovers } from './prices/lib/tiles.mjs';
import { SCALE_NAMES, SCOPE_NOTE, scalesFor } from './prices/regions.mjs';
import { joinAnd } from './schools/lib/meta.mjs';
import { JURIS } from './schools/juris.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
if (argv.includes('--help') || argv.includes('-h')) {
  const lines = readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n');
  const at = lines.findIndex(l => l.startsWith('// Usage:'));
  console.log(lines.slice(at, at + 10).map(l => l.slice(3)).join('\n'));
  process.exit(0);
}
const arg = (n, d) => (argv.includes(n) ? argv[argv.indexOf(n) + 1] : d);
const list = v => new Set((v || '').split(',').map(s => s.trim()).filter(Boolean));
const ONLY = argv.includes('--only') ? list(arg('--only')) : null;
const REFRESH = list(arg('--refresh'));
const FROZEN = argv.includes('--frozen');
const RAW_DIR = resolve(arg('--raw-dir', DEFAULT_RAW_DIR));
const OUT = resolve(arg('--out', join(ROOT, 'prices', 'data')));
const SNAPSHOT = resolve(arg('--snapshot', OUT));
const SOURCES = resolve(arg('--sources', SOURCES_DIR));
const MIN_ZOOM = 11;   // below it the page draws no areas ("Zoom in to see home values.")

const log = (...a) => console.log(...a);
const warn = m => console.log(`::warning::${m}`);
const fmt = n => n.toLocaleString('en-GB');
const today = () => new Date().toISOString().slice(0, 10);
const violations = [];
const violate = m => violations.push(m);

// Fields of index.json sources[id] that describe a build, not the source.
const BUILD_KEYS = ['cadence', 'regions', 'vintage', 'status', 'fetched', 'upstream', 'inputs', 'stats'];
const metaOf = m => Object.fromEntries(Object.entries(m).filter(([k]) => !BUILD_KEYS.includes(k)));

// ── what a source's areas are made from, besides upstream data ─────────────
// Bump PIPELINE whenever code every source shares changes what a fetched area
// becomes: lib/geo.mjs (simplify, quantize, encode), lib/schema.mjs
// (prepareAreas), lib/shp.mjs, or a tools/schools reader the sources use. The
// next monthly run then rebuilds every source (tiling itself is redone on
// every build and needs no bump).
const PIPELINE = 1;
const LOOKUPS = join(ROOT, 'tools', 'data', 'prices');
function inputsOf(src, R) {
  const h = createHash('sha256').update(`pipeline ${PIPELINE}\n`);
  h.update(readFileSync(join(SOURCES, `${src.id}.mjs`)));
  // Vendored lookups are named after the source that reads them (ni-ward-crosswalk.json).
  const own = existsSync(LOOKUPS) ? readdirSync(LOOKUPS).filter(f => f.startsWith(`${src.id}-`) || f.startsWith(`${src.id}.`)).sort() : [];
  for (const f of own) h.update(`\n${f}\n`).update(readFileSync(join(LOOKUPS, f)));
  for (const rid of [...src.regions].sort()) {
    const r = R.regions[rid] || {};
    h.update(JSON.stringify([rid, r.bbox ?? null, r.juris ?? null, r.sources ?? null, r.none ?? null, r.currency ?? null, scalesFor(rid)]));
  }
  return h.digest('hex').slice(0, 16);
}

// ── has anything this source was built from changed upstream? ──────────────
// One question per recorded file, as cheaply as the host allows:
//   HEAD (retried once) -> ETag, else Last-Modified;
//   a host that refuses HEAD (OpenDataNI's signed storage answers 403) or
//     answers it without either header -> the same GET the file came from,
//     for its first byte only (Range: bytes=0-0), read for the same headers;
//   still neither, and the file is small (NISRA's 22 KB PxStat metadata) ->
//     fetched whole and compared by sha256.
// Pages of one ArcGIS layer share the layer's ETag, so a (path, ETag) already
// found unchanged is not asked again. 404/410 means the publisher replaced
// the file: something new is out. A host that cannot be reached is not a
// change: the snapshot is kept, and the warning says so.
const etagOf = e => (e || '').replace(/^W\//, '');
const SMALL_FILE = 2e6;
async function askFile(r) {
  const headers = r.ua === undefined ? { 'user-agent': UA } : r.ua === null ? {} : { 'user-agent': r.ua };
  const ask = async init => {
    for (let attempt = 1; ; attempt++) {
      try {
        const res = await politeFetch(r.url, { redirect: 'follow', signal: AbortSignal.timeout(30_000), ...init, headers: { ...headers, ...init.headers } });
        if (res.status >= 500 && attempt < 2) { await res.body?.cancel().catch(() => {}); continue; }
        return res;
      } catch (e) { if (attempt >= 2) return { error: e }; }
    }
  };
  const verdict = res => {
    const etag = res.headers.get('etag'), lm = res.headers.get('last-modified');
    if (etag && r.etag) return etagOf(etag) === etagOf(r.etag) ? { state: 'same' } : { state: 'changed', why: `${r.file} ETag changed` };
    // Last-Modified must be an HTTP date to mean anything (NISRA's HEAD sends today's date as "29/09/2026").
    if (lm && r.lastModified && Number.isFinite(Date.parse(lm))) return lm === r.lastModified ? { state: 'same' } : { state: 'changed', why: `${r.file} Last-Modified ${r.lastModified} -> ${lm}` };
    return null;
  };
  let res = await ask({ method: 'HEAD' });
  if (res.error) return { state: 'unreachable', why: `${r.file}: ${res.error.message}` };
  await res.body?.cancel().catch(() => {});
  if (res.status === 404 || res.status === 410) return { state: 'changed', why: `${r.file} answers HTTP ${res.status}` };
  let v = res.ok ? verdict(res) : null;
  if (v) return v;
  res = await ask({ method: 'GET', headers: { range: 'bytes=0-0' } });
  if (!res.error) {
    await res.body?.cancel().catch(() => {});
    if (res.status === 404 || res.status === 410) return { state: 'changed', why: `${r.file} answers HTTP ${res.status}` };
    if (res.ok && (v = verdict(res))) return v;
  }
  if (r.sha256 && r.bytes != null && r.bytes <= SMALL_FILE) {
    res = await ask({ method: 'GET' });
    if (res.error) return { state: 'unreachable', why: `${r.file}: ${res.error.message}` };
    if (res.ok) {
      const sha = createHash('sha256').update(Buffer.from(await res.arrayBuffer())).digest('hex');
      return sha === r.sha256 ? { state: 'same' } : { state: 'changed', why: `${r.file} content changed` };
    }
    await res.body?.cancel().catch(() => {});
  }
  return { state: 'unknown', why: `${r.file}: HTTP ${res.status ?? 'error'}, no ETag or Last-Modified` };
}
async function upstreamCheck(src, ctx, prevMeta) {
  if (src.probe) {
    try {
      const p = await src.probe(ctx, prevMeta);
      if (p?.changed) return { state: 'changed', why: `its probe reports ${p.vintage ? `a new vintage (${p.vintage})` : 'a new release'}` };
    } catch (e) { warn(`${src.id}: probe failed (${e.message})`); }
  }
  const recs = (prevMeta?.upstream || []).filter(r => /^https?:\/\//.test(r.url || ''));
  if (!recs.length) return { state: 'same', why: 'no upstream files recorded' };
  const confirmed = new Set(), unknown = [], unreachable = [];
  let asked = 0;
  for (const r of recs) {
    const key = r.etag ? `${new URL(r.url).origin}${new URL(r.url).pathname}\u0000${etagOf(r.etag)}` : null;
    if (key && confirmed.has(key)) continue;
    asked++;
    const a = await askFile(r);
    if (a.state === 'changed') return a;
    if (a.state === 'same' && key) confirmed.add(key);
    if (a.state === 'unknown') unknown.push(a.why);
    if (a.state === 'unreachable') unreachable.push(a.why);
  }
  if (unreachable.length) warn(`${src.id}: ${unreachable.length} upstream file(s) unreachable, treated as unchanged (${unreachable.slice(0, 3).join('; ')})`);
  if (unknown.length) return { state: 'unknown', why: `${unknown.length} of ${recs.length} upstream file(s) could not say whether they changed (${unknown.slice(0, 3).join('; ')})` };
  return { state: 'same', why: `all ${recs.length} upstream file(s) unchanged (${asked} asked${unreachable.length ? `, ${unreachable.length} unreachable` : ''})` };
}

// Every downloaded file byte-identical to one the current tiles came from?
function sameFiles(now, before = []) {
  if (!now.length || now.length !== before.length) return false;
  const had = new Set(before.map(r => `${r.file}\u0000${r.sha256}`));
  return now.every(r => had.has(`${r.file}\u0000${r.sha256}`));
}

// Why a fetched area set must not replace the published one ('' when fine):
// see A SUSPICIOUS FETCH above. `published` is the source's snapshot.
const MAX_LOSS = 0.10;
function suspicious(src, areas, published, forced) {
  if (!areas.length) return 'none of its areas is in scope (a swapped lng/lat, or a scope check gone wrong?)';
  const emptied = src.regions.filter(rid => published.some(a => a.region === rid) && !areas.some(a => a.region === rid));
  if (emptied.length) return `it has no areas for ${emptied.join(', ')}, which had ${emptied.map(rid => fmt(published.filter(a => a.region === rid).length)).join(', ')} published`;
  const loss = published.length ? 1 - areas.length / published.length : 0;
  if (!forced && loss > MAX_LOSS) return `${fmt(areas.length)} areas, ${(100 * loss).toFixed(1)}% fewer than the ${fmt(published.length)} published (--refresh ${src.id} accepts that)`;
  return '';
}

const run = async () => {
  const R = loadRegions();
  if (R.stale.length) warn(`tools/schools/regions.mjs has entries the backend no longer covers: ${R.stale.join(', ')}`);
  const sources = await loadSources(SOURCES);
  for (const id of [...(ONLY || []), ...REFRESH]) if (id !== 'all' && !sources.some(s => s.id === id)) throw new Error(`no source "${id}" in ${SOURCES}`);
  // Both directions: a region regions.mjs gives a source must be one the
  // source serves (else that city would silently get nothing), and a region a
  // source serves must list it there.
  const named = new Map();
  for (const [rid, d] of Object.entries(R.regions)) for (const sid of d.sources || []) named.set(sid, [...(named.get(sid) || []), rid]);
  for (const [sid, rids] of named) {
    const s = sources.find(x => x.id === sid);
    if (!s) warn(`regions.mjs gives ${rids.join(', ')} the source "${sid}", but there is no ${sid}.mjs in ${SOURCES} — no price areas there this build`);
    else for (const rid of rids) if (!s.regions.includes(rid)) violate(`tools/prices/regions.mjs gives "${rid}" the source ${sid}, but sources/${sid}.mjs does not serve it (its regions list)`);
  }
  for (const s of sources) for (const rid of s.regions) {
    if (!R.regions[rid]) violate(`${s.id}: serves "${rid}", which is not a coverage region`);
    else if (!(R.regions[rid].sources || []).includes(s.id)) violate(`${s.id}: serves "${rid}", but tools/prices/regions.mjs does not list ${s.id} for it`);
    else if (R.regions[rid].currency !== s.meta.currency) violate(`${s.id}: publishes ${s.meta.currency}, but ${rid} is ${R.regions[rid].currency} (nothing converts currencies)`);
  }
  if (violations.length) throw new Error(`contract: ${violations.join('; ')}`);

  // ── snapshots: every area currently published, by source ─────────────────
  // First, what a killed build left beside the output (tools/prices/lib/tiles.mjs).
  for (const d of removeLeftovers(OUT)) log(`  ${d} (left by a build that did not finish)`);
  const snap = readAreasFromTiles(SNAPSHOT);
  const prev = snap.index?.version === INDEX_VERSION ? snap.index : null;
  log(`  snapshot: ${snap.index ? `${fmt([...snap.bySrc.values()].reduce((a, l) => a + l.length, 0))} areas in ${snap.index.tiles.cells.length} tiles` : 'none'}`);

  // ── run each source ──────────────────────────────────────────────────────
  const results = [];
  for (const src of sources) {
    const snapshot = snap.bySrc.get(src.id) || [];
    const prevMeta = prev?.sources?.[src.id] || null;
    const forced = ONLY ? ONLY.has(src.id) : REFRESH.has(src.id) || REFRESH.has('all');
    const inputs = inputsOf(src, R);
    const ctx = makeCtx({ rawDir: RAW_DIR, frozen: FROZEN, log, warn: m => warn(`${src.id}: ${m}`), regions: R });
    // speculative: nothing says the upstream data is newer than what is
    // published, so a failed fetch leaves plain `snapshot` (see STATUS).
    let want, why, speculative = false;
    if (ONLY) { want = forced; why = want ? '--only' : 'not named by --only'; }
    else if (forced) { want = true; why = '--refresh'; }
    else if (!snapshot.length) { want = true; why = 'nothing published yet'; }
    else if (prevMeta?.inputs !== inputs) {
      want = true; speculative = true;
      why = prevMeta?.inputs ? 'its inputs changed (its module, lookups or regions, or the pipeline)' : 'the published build records no inputs fingerprint';
    }
    else if (FROZEN) { want = false; why = '--frozen: upstream not checked'; }
    else if (src.cadence === 'static') { want = false; why = 'static data: upstream not checked (--refresh to refetch)'; }
    else { const c = await upstreamCheck(src, ctx, prevMeta); want = c.state !== 'same'; why = c.why; speculative = c.state === 'unknown'; }
    log(`\n  ── ${src.id} (${src.cadence}) ${want ? 'fetching' : snapshot.length ? 'reusing its snapshot' : 'skipped (nothing published)'}: ${why}`);

    let got = null, status = null;
    // A failure keeps the snapshot; see THE SAFETY RULE and STATUS.
    const failed = m => {
      status = speculative ? 'kept' : 'failed';
      if (snapshot.length) warn(`${src.id}: ${m} — re-emitting its ${fmt(snapshot.length)} areas from the current tiles${speculative ? ' (nothing newer was known to be out)' : ''}`);
      else warn(`${src.id}: ${m} and nothing is published for it — it is absent from this build`);
    };
    if (want) {
      try {
        const out = await src.fetch(ctx);
        if (!out || !Array.isArray(out.areas) || !out.areas.length) throw new Error('fetch returned no areas');
        if (typeof out.vintage !== 'string' || !out.vintage) throw new Error('fetch returned no vintage');
        got = out; status = 'fetched';
      } catch (e) { failed(`fetch failed (${e.message})`); }
    }
    // Identical bytes AND identical inputs: nothing could differ.
    if (got && !forced && snapshot.length && prevMeta && prevMeta.inputs === inputs && sameFiles(ctx.provenance, prevMeta.upstream)) {
      log(`     every upstream file is byte-identical to the published build's — keeping the snapshot`);
      got = null; status = 'unchanged';
    }

    const stats = { dropped: {} };
    const drop = (k, n = 1) => { stats.dropped[k] = (stats.dropped[k] || 0) + n; };
    const areas = [];
    let meta, vintage, upstream, fetched, used = inputs;
    if (got) {
      const prep = prepareAreas(src, got.areas, R.regions, src.meta);
      violations.push(...prep.violations);
      const bad = prep.violations.length ? '' : suspicious(src, prep.areas, snapshot, forced);
      if (bad) { failed(`the fetch looks wrong: ${bad}`); got = null; }
      else {
        meta = { ...src.meta };
        vintage = got.vintage;
        upstream = ctx.provenance.map(({ cached, ...p }) => p).sort((x, y) => (x.file < y.file ? -1 : x.file > y.file ? 1 : 0));   // downloads may run in parallel
        // All from the raw cache: the data is as old as its newest download.
        const dls = ctx.provenance.filter(p => 'cached' in p), newest = dls.map(p => p.fetchedAt || '').sort().pop() || '';
        fetched = dls.length && dls.every(p => p.cached) && newest ? newest.slice(0, 10) : today();
        areas.push(...prep.areas);
        Object.assign(stats.dropped, prep.dropped);
        const { geo, few } = prep;
        if (stats.dropped.duplicateId) warn(`${src.id}: ${stats.dropped.duplicateId} duplicate id(s) dropped`);
        log(`     geometry: ${fmt(geo.rings)} rings, ${fmt(geo.pointsIn)} -> ${fmt(geo.pointsOut)} points (${geo.pointsIn ? (100 * geo.pointsOut / geo.pointsIn).toFixed(1) : 0}%), ${fmt(geo.ringsDropped)} ring(s) dropped` +
          (few ? `; ${fmt(few)} area(s) flagged few (n < ${meta.colourMinN})` : ''));
      }
    }
    if (!got) {
      // The snapshot keeps the meta it was published with: the period, metric
      // and attribution belong to THAT data, not to whatever the module says
      // now; and the inputs it was built from, so a failed rebuild is tried
      // again next month.
      meta = prevMeta ? metaOf(prevMeta) : { ...src.meta };
      vintage = prevMeta?.vintage ?? null;
      upstream = prevMeta?.upstream || [];
      fetched = prevMeta?.fetched ?? null;
      used = prevMeta ? prevMeta.inputs ?? null : inputs;
      Object.assign(stats.dropped, prevMeta?.stats?.dropped || {});
      if (prevMeta && JSON.stringify(metaOf({ ...src.meta })) !== JSON.stringify(meta)) {
        warn(`${src.id}: sources/${src.id}.mjs meta differs from the published build's; it applies when the source is next fetched`);
      }
      for (const a0 of snapshot) {
        const a = { ...a0, flags: [...a0.flags] };
        const reg = R.regions[a.region];
        // Coverage or decisions can move under a snapshot; R2 still applies.
        if (!reg || !(reg.sources || []).includes(src.id) || !src.regions.includes(a.region) || !scalesFor(a.region).includes(a.scale) ||
            !reg.juris.includes(a.juris) || !bboxIntersects(a.bbox, reg.bbox)) { drop('outsideScope'); continue; }
        areas.push(a);
      }
      if (areas.length < snapshot.length) warn(`${src.id}: ${snapshot.length - areas.length} snapshot area(s) no longer in scope`);
      status = status === 'failed' ? (areas.length ? 'snapshot-after-failure' : 'absent') : (areas.length ? 'snapshot' : 'absent');
    }
    results.push({ src, areas, status, meta, vintage, upstream, fetched, inputs: used, stats });
    log(`     ${fmt(areas.length)} areas (${status})`);
  }
  if (violations.length) {
    throw new Error(`${violations.length} contract violation(s); nothing written. e.g.\n    ${violations.slice(0, 15).join('\n    ')}`);
  }

  // ── index arrays: sources, regions, scales ───────────────────────────────
  const present = results.filter(r => r.areas.length);
  const all = present.flatMap(r => r.areas);
  const srcIdx = new Map(present.map((r, i) => [r.src.id, i]));
  const regionIds = R.coverage.map(c => c.id).filter(id => all.some(a => a.region === id));
  const regionIdx = new Map(regionIds.map((id, i) => [id, i]));
  const scaleKeys = [];
  for (const rid of regionIds) for (const k of scalesFor(rid)) if (!scaleKeys.includes(k) && all.some(a => a.region === rid && a.scale === k)) scaleKeys.push(k);
  const scaleIdx = new Map(scaleKeys.map((k, i) => [k, i]));
  for (const a of all) { a.srcIdx = srcIdx.get(a.src); a.regionIdx = regionIdx.get(a.region); a.scaleIdx = scaleIdx.get(a.scale); }

  // ── colour scales: one per scale region; one source, metric, period, currency
  const metaBySrc = new Map(present.map(r => [r.src.id, r.meta]));
  const scales = [];
  for (const key of scaleKeys) {
    const mine = all.filter(a => a.scale === key);
    const srcs = [...new Set(mine.map(a => a.src))];
    if (srcs.length !== 1) { violate(`scale ${key}: ${srcs.length} sources (${srcs.join(', ')}) — one scale region takes one source`); continue; }
    // One jurisdiction too: tiles do not repeat an area's juris, the scale
    // carries it (a snapshot re-reads it from there, verify checks R2 by it).
    const juris = [...new Set(mine.map(a => a.juris))];
    if (juris.length !== 1) { violate(`scale ${key}: spans ${juris.join(', ')} — one scale region lies in one jurisdiction`); continue; }
    const m = metaBySrc.get(srcs[0]);
    const firstRegion = R.regions[mine[0].region];
    const coloured = mine.filter(isColoured).map(a => a.value);
    let b;
    try { b = computeBreaks(coloured); } catch (e) { violate(`scale ${key}: ${e.message}`); continue; }
    scales.push({ key, name: SCALE_NAMES[key] || firstRegion.name, source: srcs[0], metric: m.metric, period: m.period, currency: m.currency, juris: juris[0], ...b });
  }
  if (violations.length) throw new Error(`${violations.length} contract violation(s); nothing written:\n    ${violations.join('\n    ')}`);

  // ── index.json v1 ────────────────────────────────────────────────────────
  const regions = regionIds.map(id => {
    const r = R.regions[id], mine = all.filter(a => a.region === id);
    return {
      id, name: r.name, country: r.country, currency: r.currency,
      sources: present.map(p => p.src.id).filter(s => mine.some(a => a.src === s)),
      view: r.view, viewName: r.viewName, ...(r.tz ? { tz: r.tz } : {}), bbox: r.bbox,
      juris: r.juris.filter(j => mine.some(a => a.juris === j)),
      // What else the rectangle holds, not mapped under R2 (schools' regions.mjs).
      ...(r.outside?.length ? { outside: r.outside } : {}),
      // For verify-prices: a city that loses areas between builds is caught.
      areas: mine.length,
    };
  });
  // bbox: a no-data region is not in `regions`, so the page finds "the map is
  // over Mexico City" (its note names the city) by this rectangle; tz, so a
  // visitor from there who is sent elsewhere is told why.
  const missing = R.coverage.filter(c => R.regions[c.id].none).map(c => ({ region: c.id, name: R.regions[c.id].name, reason: R.regions[c.id].none, bbox: c.bbox,
    ...(R.regions[c.id].tz ? { tz: R.regions[c.id].tz } : {}) }));
  // How the page names a region's own jurisdictions in "Here the map shows
  // home values in New York State only, not New Jersey." (as schools' index).
  const jurisNames = Object.fromEntries([...new Set(regions.flatMap(r => r.juris))].sort().map(j => [j, {
    name: JURIS[j]?.name || j, ...(JURIS[j]?.area ? { area: JURIS[j].area } : {}) }]));
  const index = {
    version: INDEX_VERSION,
    generated: today(),
    fields: FIELDS,
    tiles: { base: BASE, split: { maxAreas: MAX_AREAS, maxBytes: MAX_BYTES, minCell: MIN_CELL }, cells: [] },
    minZoom: MIN_ZOOM,
    regions,
    juris: jurisNames,
    scales,
    sources: Object.fromEntries(present.map(({ src, areas, status, meta, vintage, upstream, fetched, inputs, stats }) => {
      const coloured = areas.filter(isColoured).length;
      // Of the neutral ones, those with nothing published and nothing withheld:
      // the page leaves them off the map (only the report names them).
      const unpublished = areas.filter(isUnpublished).length;
      return [src.id, {
        ...meta, cadence: src.cadence, regions: regionIds.filter(id => areas.some(a => a.region === id)),
        vintage, status, fetched, upstream, inputs,
        stats: { areas: areas.length, coloured, neutral: areas.length - coloured, unpublished, dropped: stats.dropped },
      }];
    })),
    missing,
    // Read by tools/sync-site-facts.mjs (data-fact="prices-where").
    where: composeWhere(regions),
    scope: SCOPE_NOTE,
  };

  // ── tiles ────────────────────────────────────────────────────────────────
  const leaves = tileAreas(all);
  index.tiles.cells = leaves.map(([k]) => k);
  // NO CHURN. A month where nothing changed upstream must leave the output
  // exactly as it was, or the workflow would commit a new `generated` date and
  // nothing else. The same index (but for that date) over byte-identical
  // tiles keeps the date it was generated on.
  const readIf = f => (existsSync(f) ? readFileSync(f, 'utf8') : null);
  const cur = (() => { try { return JSON.parse(readIf(join(OUT, 'index.json'))); } catch { return null; } })();
  if (cur?.generated && JSON.stringify({ ...cur, generated: 0 }) === JSON.stringify({ ...index, generated: 0 }) &&
      leaves.every(([k, l]) => readIf(join(OUT, 'tiles', `${k}.json`)) === tileJson(l))) {
    index.generated = cur.generated;
    log(`
  nothing changed: index.json and all ${fmt(leaves.length)} tiles are as published (generated ${cur.generated})`);
  }
  writeOutput(OUT, leaves, index);
  const ts = tileStats(leaves);

  // ── report ───────────────────────────────────────────────────────────────
  // (rebuild-prices.yml greps the per-source lines for its commit message.)
  log(`\n  prices written       ${fmt(all.length)} areas  (${index.where})`);
  for (const { src, areas, status } of present) log(`    ${src.id.padEnd(12)} ${fmt(areas.length).padStart(7)}  ${status}`);
  for (const r of results.filter(r => !r.areas.length)) log(`    ${r.src.id.padEnd(12)} ${'0'.padStart(7)}  ${r.status || 'absent'}`);
  for (const { src, stats } of present) {
    const d = Object.entries(stats.dropped).map(([k, v]) => `${k} ${fmt(v)}`).join(', ');
    if (d) log(`    ${src.id} dropped: ${d}`);
  }
  for (const s of scales) log(`    scale ${s.key.padEnd(11)} ${fmt(s.areas).padStart(6)} coloured  breaks ${s.breaks.map(fmt).join(' / ')} ${s.currency}  (${s.name}, ${s.source})`);
  for (const m of missing) log(`    missing ${m.region}: ${m.reason}`);
  log(`  tiles                ${ts.files} files (${Object.entries(ts.byLevel).map(([l, n]) => `${n} @${BASE / 2 ** l}°`).join(', ')}), ` +
    `${(ts.rawBytes / 1e6).toFixed(1)}MB raw, ${(ts.gzBytes / 1e6).toFixed(2)}MB gzipped; median ${(ts.medianGz / 1024).toFixed(1)}KB, ` +
    `worst ${((ts.worst[0]?.gz || 0) / 1024).toFixed(1)}KB gzipped (${ts.worst[0]?.key}, ${fmt(ts.worst[0]?.areas ?? 0)} areas)`);
  log(`  written to           ${OUT}`);
};

// "England, Wales and Northern Ireland; 26 US cities; Toronto and Vancouver":
// the UK by its jurisdictions, US cities counted once there are three or
// more, anything else by city; countries in coverage order.
function composeWhere(regions) {
  const byCountry = new Map();
  for (const r of regions) { if (!byCountry.has(r.country)) byCountry.set(r.country, []); byCountry.get(r.country).push(r); }
  return [...byCountry].map(([c, rs]) => {
    if (c === 'gb') return joinAnd([...new Set(rs.flatMap(r => r.juris.map(j => JURIS[j]?.where || JURIS[j]?.name || j)))]);
    if (c === 'us' && rs.length >= 3) return `${rs.length} US cities`;
    return joinAnd(rs.map(r => r.name));
  }).join('; ');
}

run().catch(e => { console.error('build-prices failed:', e.message); process.exit(1); });
