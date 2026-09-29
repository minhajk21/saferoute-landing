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
// SALE PRICES. A 'point-sales' source (NYC, DC, Hartford, Baltimore) returns
// individual recorded sales, not areas. It runs after every areas source, and
// lib/sales.mjs windows its sales, places them in its GEOMETRY source's tract
// polygons (acs-tract's) and aggregates them (median, middle half, n; nothing
// under 3 sales shown). PRECEDENCE: inside the sale source's `covers` its
// tracts REPLACE the geometry source's same tracts; the geometry source keeps
// the region's other tracts on a separate colour scale (the region's second
// scale key, e.g. nyc-outer: one scale, one source, one metric). Each sale
// tract carries the geometry source's own figure as its context line.
//
// CADENCE. The areas sources are annual and semi-annual statistics, so the
// monthly run does not refetch them by habit (sale feeds are 'monthly' and
// are fetched every run: their window moves with the data, and their query
// endpoints rarely carry a validator to ask). It asks each upstream file it was built from
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
//            --partial         build without the modules regions.mjs names but --sources
//                              lacks (tests, a half-written source); without it that FAILS

import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { makeCtx, loadRegions, politeFetch, UA, RAW_DIR as DEFAULT_RAW_DIR } from './prices/lib/ctx.mjs';
import { INDEX_VERSION, FIELDS, SOURCES_DIR, ENTRY_BUILD_KEYS, loadSources, prepareAreas, areaProblems, entryProblems, isColoured, isUnpublished, isSales, kindOf } from './prices/lib/schema.mjs';
import { buildSaleAreas, isCovered } from './prices/lib/sales.mjs';
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
  console.log(lines.slice(at, at + 12).map(l => l.slice(3)).join('\n'));
  process.exit(0);
}
const arg = (n, d) => (argv.includes(n) ? argv[argv.indexOf(n) + 1] : d);
const list = v => new Set((v || '').split(',').map(s => s.trim()).filter(Boolean));
const ONLY = argv.includes('--only') ? list(arg('--only')) : null;
const REFRESH = list(arg('--refresh'));
const FROZEN = argv.includes('--frozen');
const PARTIAL = argv.includes('--partial');
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
const BUILD_KEYS = ENTRY_BUILD_KEYS;
const metaOf = m => Object.fromEntries(Object.entries(m).filter(([k]) => !BUILD_KEYS.includes(k)));
// A sale source's meta as its module states it: without what the build adds
// (its period and window dates, and the area noun and privacy note it fills
// in), so a snapshot's meta can be compared with the module's.
const moduleMeta = (m, src) => {
  if (!isSales(src)) return metaOf(m);
  const { period, areaNoun, window: w, notes, ...rest } = metaOf(m);
  const { from, to, span, ...win } = w || {};
  return { ...rest, window: { ...win, lagMonths: win.lagMonths || 0 } };
};

// ── what a source's areas are made from, besides upstream data ─────────────
// Bump PIPELINE whenever code every source shares changes what a fetched area
// becomes: lib/geo.mjs (simplify, quantize, encode), lib/schema.mjs
// (prepareAreas), lib/shp.mjs, or a tools/schools reader the sources use. The
// next monthly run then rebuilds every source (tiling itself is redone on
// every build and needs no bump).
const PIPELINE = 1;
const LOOKUPS = join(ROOT, 'tools', 'data', 'prices');
// `extra`: for a sale source, what its geometry source's areas were made
// from (a new ACS vintage re-aggregates the sales onto the new tracts).
function inputsOf(src, R, extra = '') {
  const h = createHash('sha256').update(`pipeline ${PIPELINE}\n`);
  if (extra) h.update(`geometry ${extra}\n`);
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
// see A SUSPICIOUS FETCH above. `published` is the source's snapshot (for a
// geometry source, with the tracts sale sources showed in its place).
const MAX_LOSS = 0.10;
function suspicious(src, areas, published, forced) {
  if (!areas.length) return 'none of its areas is in scope (a swapped lng/lat, or a scope check gone wrong?)';
  const emptied = src.regions.filter(rid => published.some(a => a.region === rid) && !areas.some(a => a.region === rid));
  if (emptied.length) return `it has no areas for ${emptied.join(', ')}, which had ${emptied.map(rid => fmt(published.filter(a => a.region === rid).length)).join(', ')} published`;
  const loss = published.length ? 1 - areas.length / published.length : 0;
  if (!forced && loss > MAX_LOSS) return `${fmt(areas.length)} areas, ${(100 * loss).toFixed(1)}% fewer than the ${fmt(published.length)} published (--refresh ${src.id} accepts that)`;
  return '';
}
// And for a sale source, the sales themselves: none placed (a swapped
// lng/lat lands every sale outside every tract), or unasked, fewer than half
// of those behind the published figures.
const MIN_SALES_KEPT = 0.5;
function suspiciousSales(src, built, prevMeta, forced) {
  const used = built.stats.sales.used, before = prevMeta?.stats?.sales?.used;
  if (!used) return `none of its ${fmt(built.stats.sales.received)} sales fell in a covered tract inside the window (a swapped lng/lat, or the wrong covers?)`;
  if (!forced && before && used < MIN_SALES_KEPT * before) return `${fmt(used)} sales placed, under half the ${fmt(before)} behind the published figures (--refresh ${src.id} accepts that)`;
  return '';
}

// A sale dated after the build day is a typo, not a sale (and would drag the
// window into the future). The build day, not the download day: a source may
// fetch its sales outside ctx.download (unrecorded) beside a lookup cached
// weeks ago, and a real sale is never dated after the day it was fetched, so
// a --frozen rebuild of the same files still gives the same figures.
const dataDay = () => today();

// Scope rule R2 for a published area of `src`, read back from the tiles.
function inScope(a, src, R) {
  const reg = R.regions[a.region];
  return !!reg && (reg.sources || []).includes(src.id) && src.regions.includes(a.region) && scalesFor(a.region).includes(a.scale) &&
    reg.juris.includes(a.juris) && bboxIntersects(a.bbox, reg.bbox);
}

// The tracts a sale source's sales are placed in: its geometry source's areas
// in its regions, as they stand this build. A geometry source that re-emits
// its snapshot no longer holds the tracts this source showed last time (they
// were published as this source's rows, same id, same polygons), so those
// come from this source's own snapshot, with their old context line.
function tractsFor(src, geo, own, R) {
  const byId = new Map();
  if (geo.status !== 'fetched') for (const a of own) if (inScope(a, src, R)) byId.set(a.id, { ...a, fromSale: true });
  for (const a of geo.areas) if (src.regions.includes(a.region)) byId.set(a.id, a);
  return [...byId.values()];
}

const run = async () => {
  const R = loadRegions();
  if (R.stale.length) warn(`tools/schools/regions.mjs has entries the backend no longer covers: ${R.stale.join(', ')}`);
  const sources = await loadSources(SOURCES);
  for (const id of [...(ONLY || []), ...REFRESH]) if (id !== 'all' && !sources.some(s => s.id === id)) throw new Error(`no source "${id}" in ${SOURCES}`);
  // Both directions: a region regions.mjs gives a source must be one the
  // source serves (else that city would silently get nothing), and a region a
  // source serves must list it there. A source regions.mjs names must exist:
  // a deleted or never-written module is a failure, not a quiet fallback
  // (--partial allows it, for tests and a source still being written).
  const named = new Map();
  for (const [rid, d] of Object.entries(R.regions)) for (const sid of d.sources || []) named.set(sid, [...(named.get(sid) || []), rid]);
  for (const [sid, rids] of named) {
    const s = sources.find(x => x.id === sid);
    if (!s) {
      const m = `tools/prices/regions.mjs gives ${rids.join(', ')} the source "${sid}", but there is no ${sid}.mjs in ${SOURCES}`;
      if (PARTIAL) warn(`${m} — no price areas from it this build (--partial)`);
      else violate(`${m}: write the module, or take ${sid} out of regions.mjs`);
    }
    else for (const rid of rids) if (!s.regions.includes(rid)) violate(`tools/prices/regions.mjs gives "${rid}" the source ${sid}, but sources/${sid}.mjs does not serve it (its regions list)`);
  }
  for (const s of sources) for (const rid of s.regions) {
    if (!R.regions[rid]) violate(`${s.id}: serves "${rid}", which is not a coverage region`);
    else if (!(R.regions[rid].sources || []).includes(s.id)) violate(`${s.id}: serves "${rid}", but tools/prices/regions.mjs does not list ${s.id} for it`);
    else if (R.regions[rid].currency !== s.meta.currency) violate(`${s.id}: publishes ${s.meta.currency}, but ${rid} is ${R.regions[rid].currency} (nothing converts currencies)`);
  }
  // A sale source needs its geometry source in every region it serves: the
  // tract polygons come from it, and so do the tracts outside its covers.
  const byId = new Map(sources.map(s => [s.id, s]));
  for (const s of sources.filter(isSales)) {
    const g = byId.get(s.geometry);
    if (!g) { violate(`${s.id}: its geometry source "${s.geometry}" has no module in ${SOURCES}`); continue; }
    if (isSales(g)) { violate(`${s.id}: its geometry source ${g.id} is a point-sales source too; sales are placed in published areas`); continue; }
    for (const rid of s.regions) {
      if (!g.regions.includes(rid) || !(R.regions[rid]?.sources || []).includes(g.id)) violate(`${s.id}: serves ${rid}, but its geometry source ${g.id} does not there (regions.mjs must give ${rid} both)`);
    }
  }
  for (const [rid, d] of Object.entries(R.regions)) {
    const ps = (d.sources || []).filter(id => isSales(byId.get(id)));
    if (ps.length > 1) violate(`${rid}: regions.mjs gives it ${ps.length} point-sales sources (${ps.join(', ')}); a region has one sale-price scale`);
  }
  if (violations.length) throw new Error(`contract: ${violations.join('; ')}`);

  // ── snapshots: every area currently published, by source ─────────────────
  // First, what a killed build left beside the output (tools/prices/lib/tiles.mjs).
  for (const d of removeLeftovers(OUT)) log(`  ${d} (left by a build that did not finish)`);
  const snap = readAreasFromTiles(SNAPSHOT);
  const prev = snap.index?.version === INDEX_VERSION ? snap.index : null;
  log(`  snapshot: ${snap.index ? `${fmt([...snap.bySrc.values()].reduce((a, l) => a + l.length, 0))} areas in ${snap.index.tiles.cells.length} tiles` : 'none'}`);
  // A geometry source's published tracts include those a sale source showed
  // in its place: what a fresh fetch of it (every tract) is compared with.
  const family = gid => {
    const deps = new Set([...sources.filter(s => isSales(s) && s.geometry === gid).map(s => s.id),
      ...Object.entries(prev?.sources || {}).filter(([, m]) => m.geometry === gid).map(([id]) => id)]);
    return [...(snap.bySrc.get(gid) || []), ...[...deps].flatMap(id => snap.bySrc.get(id) || [])];
  };

  // ── run each source: areas sources first, then the sale sources on them ──
  const results = [];
  for (const src of [...sources.filter(s => !isSales(s)), ...sources.filter(isSales)]) {
    const sales = isSales(src);
    const snapshot = snap.bySrc.get(src.id) || [];
    const prevMeta = prev?.sources?.[src.id] || null;
    const forced = ONLY ? ONLY.has(src.id) : REFRESH.has(src.id) || REFRESH.has('all');
    const geo = sales ? results.find(r => r.src.id === src.geometry) : null;
    const inputs = inputsOf(src, R, geo ? JSON.stringify([geo.inputs, geo.vintage, (geo.upstream || []).map(u => `${u.file} ${u.sha256}`)]) : '');
    const ctx = makeCtx({ rawDir: RAW_DIR, frozen: FROZEN, log, warn: m => warn(`${src.id}: ${m}`), regions: R });
    // speculative: nothing says the upstream data is newer than what is
    // published, so a failed fetch leaves plain `snapshot` (see STATUS).
    let want, why, speculative = false, rehand = false;
    if (ONLY) { want = forced; why = want ? '--only' : 'not named by --only'; }
    else if (forced) { want = true; why = '--refresh'; }
    else if (!snapshot.length) { want = true; why = 'nothing published yet'; }
    else if (prevMeta?.inputs !== inputs) {
      // A monthly feed always has a newer month out, so its failure is a
      // missed update whatever else changed: never speculative (else a module
      // edit, or acs-tract's December refresh, would hide the stale notice for
      // the whole outage, as a failure keeps the old inputs and every later
      // month would be "inputs changed" again).
      want = true; speculative = src.cadence !== 'monthly';
      why = prevMeta?.inputs ? `its inputs changed (its module, lookups or regions, the pipeline${sales ? `, or ${src.geometry}'s areas` : ''})` : 'the published build records no inputs fingerprint';
    }
    // Tracts it left off the map last time because the sale source that owns
    // them could not show them yet (see PRECEDENCE below): its snapshot no
    // longer holds them, so only a fetch can hand them over.
    else if (prevMeta?.stats?.dropped?.awaitingSaleSource) {
      want = true; speculative = true; rehand = true;
      why = `${fmt(prevMeta.stats.dropped.awaitingSaleSource)} of its tracts are waiting for a sale source to show them`;
    }
    else if (FROZEN) { want = false; why = '--frozen: upstream not checked'; }
    else if (src.cadence === 'static') { want = false; why = 'static data: upstream not checked (--refresh to refetch)'; }
    // A monthly feed has something new every month, so it is simply fetched
    // (a failure then is a missed update: snapshot-after-failure). Identical
    // bytes still keep the snapshot byte-identical, below.
    else if (src.cadence === 'monthly') { want = true; why = 'monthly data: fetched every run'; }
    else { const c = await upstreamCheck(src, ctx, prevMeta); want = c.state !== 'same'; why = c.why; speculative = c.state === 'unknown'; }
    log(`\n  ── ${src.id} (${sales ? 'point-sales, ' : ''}${src.cadence}) ${want ? 'fetching' : snapshot.length ? 'reusing its snapshot' : 'skipped (nothing published)'}: ${why}`);

    let got = null, status = null;
    // A failure keeps the snapshot; see THE SAFETY RULE and STATUS.
    const failed = m => {
      status = speculative ? 'kept' : 'failed';
      if (snapshot.length) warn(`${src.id}: ${m} — re-emitting its ${fmt(snapshot.length)} areas from the current tiles${speculative ? ' (nothing newer was known to be out)' : ''}`);
      else warn(`${src.id}: ${m} and nothing is published for it — it is absent from this build`);
    };
    const tracts = sales ? tractsFor(src, geo, snapshot, R) : null;
    if (want && sales && !tracts.length) { failed(`its geometry source ${src.geometry} has no areas in ${src.regions.join(', ')} to place sales in`); want = false; }
    if (want) {
      try {
        const out = await src.fetch(ctx);
        if (sales) {
          if (!out || !Array.isArray(out.sales) || !out.sales.length) throw new Error('fetch returned no sales');
        } else {
          if (!out || !Array.isArray(out.areas) || !out.areas.length) throw new Error('fetch returned no areas');
          if (typeof out.vintage !== 'string' || !out.vintage) throw new Error('fetch returned no vintage');
        }
        got = out; status = 'fetched';
      } catch (e) { failed(`fetch failed (${e.message})`); }
    }
    // Identical bytes AND identical inputs: nothing could differ (except the
    // tracts the snapshot no longer holds, which is why it was fetched).
    if (got && !forced && !rehand && snapshot.length && prevMeta && prevMeta.inputs === inputs && sameFiles(ctx.provenance, prevMeta.upstream)) {
      log(`     every upstream file is byte-identical to the published build's — keeping the snapshot`);
      got = null; status = 'unchanged';
    }

    const stats = { dropped: {} };
    const drop = (k, n = 1) => { stats.dropped[k] = (stats.dropped[k] || 0) + n; };
    const areas = [];
    let meta, vintage, upstream, fetched, covers = null, used = inputs;
    if (got && sales) {
      const b = buildSaleAreas({ src, out: got, tracts, geoMeta: geo.meta, now: dataDay(), scaleOf: rid => scalesFor(rid)[0] });
      const bv = [...b.violations];
      if (!bv.length) for (const a of b.areas) {
        const p = areaProblems(a, src, { raw: false });
        if (p.length) bv.push(`${src.id} ${a.id}: ${p.join('; ')}`);
      }
      violations.push(...bv);
      const bad = bv.length ? '' : suspicious(src, b.areas, snapshot, forced) || suspiciousSales(src, b, prevMeta, forced);
      if (bad) { failed(`the fetch looks wrong: ${bad}`); got = null; }
      else if (!bv.length) {
        ({ meta, vintage, covers } = b);
        areas.push(...b.areas);
        Object.assign(stats.dropped, b.stats.dropped);
        stats.sales = b.stats.sales;
        const n = k => b.areas.filter(a => a.flags.includes(k)).length;
        log(`     ${fmt(b.stats.sales.used)} of ${fmt(b.stats.sales.received)} sales placed, ${b.meta.period[0].toLowerCase()}${b.meta.period.slice(1)} (window ${b.window.from}..${b.window.to}); ` +
          `${fmt(b.areas.length)} tracts: ${fmt(b.areas.filter(isColoured).length)} coloured, ${fmt(n('few'))} too few to colour, ${fmt(n('suppressed'))} under 3 sales`);
      }
    } else if (got) {
      const prep = prepareAreas(src, got.areas, R.regions, src.meta);
      violations.push(...prep.violations);
      const bad = prep.violations.length ? '' : suspicious(src, prep.areas, family(src.id), forced);
      if (bad) { failed(`the fetch looks wrong: ${bad}`); got = null; }
      else {
        meta = { ...src.meta };
        vintage = got.vintage;
        areas.push(...prep.areas);
        Object.assign(stats.dropped, prep.dropped);
        const { geo: g, few } = prep;
        if (stats.dropped.duplicateId) warn(`${src.id}: ${stats.dropped.duplicateId} duplicate id(s) dropped`);
        log(`     geometry: ${fmt(g.rings)} rings, ${fmt(g.pointsIn)} -> ${fmt(g.pointsOut)} points (${g.pointsIn ? (100 * g.pointsOut / g.pointsIn).toFixed(1) : 0}%), ${fmt(g.ringsDropped)} ring(s) dropped` +
          (few ? `; ${fmt(few)} area(s) flagged few (n < ${meta.colourMinN})` : ''));
      }
    }
    if (got) {
      upstream = ctx.provenance.map(({ cached, ...p }) => p).sort((x, y) => (x.file < y.file ? -1 : x.file > y.file ? 1 : 0));   // downloads may run in parallel
      // All from the raw cache: the data is as old as its newest download.
      const dls = ctx.provenance.filter(p => 'cached' in p), newest = dls.map(p => p.fetchedAt || '').sort().pop() || '';
      fetched = dls.length && dls.every(p => p.cached) && newest ? newest.slice(0, 10) : today();
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
      covers = prevMeta?.covers ?? null;
      used = prevMeta ? prevMeta.inputs ?? null : inputs;
      Object.assign(stats.dropped, prevMeta?.stats?.dropped || {});
      if (prevMeta?.stats?.sales) stats.sales = { ...prevMeta.stats.sales };
      if (prevMeta && JSON.stringify(moduleMeta({ ...src.meta }, src)) !== JSON.stringify(moduleMeta(meta, src))) {
        warn(`${src.id}: sources/${src.id}.mjs meta differs from the published build's; it applies when the source is next fetched`);
      }
      for (const a0 of snapshot) {
        const a = { ...a0, flags: [...a0.flags] };
        // Coverage or decisions can move under a snapshot; R2 still applies.
        if (!inScope(a, src, R)) { drop('outsideScope'); continue; }
        areas.push(a);
      }
      if (areas.length < snapshot.length) warn(`${src.id}: ${snapshot.length - areas.length} snapshot area(s) no longer in scope`);
      status = status === 'failed' ? (areas.length ? 'snapshot-after-failure' : 'absent') : (areas.length ? 'snapshot' : 'absent');
    }
    results.push({ src, areas, status, meta, vintage, upstream, fetched, inputs: used, stats, covers });
    log(`     ${fmt(areas.length)} areas (${status})`);
  }
  if (violations.length) {
    throw new Error(`${violations.length} contract violation(s); nothing written. e.g.\n    ${violations.slice(0, 15).join('\n    ')}`);
  }

  // ── precedence: a sale source's tracts replace its geometry source's ─────
  // Same id, same polygon: the geometry source's copy goes. Its other tracts
  // in that region move to the region's second scale key (nyc-outer): they
  // are another source, metric and period, so another colour scale. Where no
  // sale source has areas (none written yet, or it has never published), the
  // geometry source keeps the whole region on its first key, as before.
  const withSales = new Map();   // region -> the sale source showing tracts there
  for (const r of results.filter(r => isSales(r.src))) for (const a of r.areas) withSales.set(a.region, r);
  for (const g of results.filter(r => !isSales(r.src))) {
    const deps = results.filter(r => isSales(r.src) && r.src.geometry === g.src.id);
    if (!deps.length && !sources.some(s => isSales(s) && s.geometry === g.src.id)) continue;
    const taken = new Set(deps.flatMap(r => r.areas.map(a => `${a.region}\u0000${a.id}`)));
    // How many of its tracts sale sources show in its place: every tract they
    // show (a snapshot of this source no longer holds them to be removed).
    const replaced = Object.fromEntries(deps.filter(r => r.areas.length).map(r => [r.src.id, r.areas.length]));
    const keep = [], waiting = [];
    for (const a of g.areas) {
      const s = withSales.get(a.region);
      if (s?.src.geometry === g.src.id && taken.has(`${a.region}\u0000${a.id}`)) continue;
      if (s?.src.geometry === g.src.id) {
        // Inside the sale source's covers but not among its tracts: the sale
        // source re-emitted a snapshot from before this tract existed (a new
        // tract vintage, a moved rectangle) while this source was fetched
        // afresh. It belongs to the sale source, which has no figure for it
        // yet: left off the map until that source is next fetched, rather
        // than shown as an owners' estimate inside the sale-price scale, or
        // one source's outage stopping every city's build.
        if (s.covers && isCovered(s.covers, a)) {
          if (s.status === 'fetched') violate(`${a.region}: ${g.src.id} tract ${a.id} is inside ${s.src.id}'s covers, but ${s.src.id} placed no tract there`);
          else waiting.push(a);
          continue;
        }
        const outer = scalesFor(a.region)[1];
        if (!outer) { violate(`${a.region}: ${g.src.id} tract ${a.id} is outside ${s.src.id}'s covers, and tools/prices/regions.mjs gives ${a.region} no second scale key for such tracts`); continue; }
        a.scale = outer;
      } else if (sources.some(x => isSales(x) && x.geometry === g.src.id && x.regions.includes(a.region))) a.scale = scalesFor(a.region)[0];
      keep.push(a);
    }
    g.areas = keep;
    if (waiting.length) {
      g.stats.dropped.awaitingSaleSource = (g.stats.dropped.awaitingSaleSource || 0) + waiting.length;
      warn(`${g.src.id}: ${fmt(waiting.length)} tract(s) inside a sale source's covers that its current tiles do not hold (e.g. ${waiting[0].region} ${waiting[0].id}) — not shown until that source is fetched again`);
    }
    if (Object.keys(replaced).length) {
      g.stats.replaced = replaced;
      log(`  ${g.src.id}: ${Object.entries(replaced).map(([k, v]) => `${fmt(v)} tracts shown by ${k}`).join(', ')}, not by it`);
    }
  }
  if (violations.length) throw new Error(`${violations.length} contract violation(s); nothing written:\n    ${violations.join('\n    ')}`);
  for (const r of results) r.status = r.areas.length ? r.status : 'absent';

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
    sources: Object.fromEntries(present.map(({ src, areas, status, meta, vintage, upstream, fetched, inputs, stats, covers }) => {
      const coloured = areas.filter(isColoured).length;
      // Of the neutral ones, those with nothing published and nothing withheld:
      // the page leaves them off the map (only the report names them).
      const unpublished = areas.filter(isUnpublished).length;
      return [src.id, {
        ...meta, kind: kindOf(src), ...(isSales(src) ? { geometry: src.geometry, covers } : {}),
        cadence: src.cadence, regions: regionIds.filter(id => areas.some(a => a.region === id)),
        vintage, status, fetched, upstream, inputs,
        // A sale source: sales received and placed (received = placed + the
        // build's drops); a geometry source: its tracts a sale source shows.
        stats: { areas: areas.length, coloured, neutral: areas.length - coloured, unpublished, dropped: stats.dropped,
          ...(stats.sales ? { sales: stats.sales } : {}), ...(stats.replaced ? { replaced: stats.replaced } : {}) },
      }];
    })),
    missing,
    // Read by tools/sync-site-facts.mjs (data-fact="prices-where").
    where: composeWhere(regions),
    scope: SCOPE_NOTE,
  };
  // Every source entry holds only fields the contract lists (lib/schema.mjs
  // META_KEYS and friends): a module that adds to its meta at fetch time must
  // never publish what it added. Refused before anything is written.
  for (const [id, e] of Object.entries(index.sources)) violations.push(...entryProblems(id, e));
  if (violations.length) throw new Error(`${violations.length} contract violation(s); nothing written:\n    ${violations.join('\n    ')}`);

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
  for (const { src, areas, status } of present) log(`    ${src.id.padEnd(13)} ${fmt(areas.length).padStart(7)}  ${status}`);
  for (const r of results.filter(r => !r.areas.length)) log(`    ${r.src.id.padEnd(13)} ${'0'.padStart(7)}  ${r.status || 'absent'}`);
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
