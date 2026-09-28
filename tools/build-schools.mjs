// Build the school data behind the Schools layer on /check/: every open,
// located school from each source in tools/schools/sources/, clipped to where
// SafeRoute has crime data (scope rule R2), cut into adaptive geographic tiles
// so the map fetches only the schools around the address being looked at.
//
// This file is the ORCHESTRATOR. It knows nothing about any one country: each
// source module fetches and normalises its own rows (tools/schools/README.md
// documents the interface), and this file runs them, merges US rating maps,
// clips to scope, tiles, and writes index.json v2.
//
// THE SAFETY RULE. A source that fails to fetch — or that is not due for a
// refresh (annual/static sources outside a --refresh run) — re-emits its rows
// from the CURRENT tiles, with a ::warning::. The tiles are every source's
// snapshot, so a fetch failure can never empty a country from the map.
//
// ONE OUTPUT SHAPE: schools/data/tiles/{key}.json + index.json. If a
// whole-country view is ever wanted, build it from the tiles rather than
// resurrecting a second format that has to be kept in step with the first.
//
// RAW DOWNLOADS NEVER GO INTO THE REPO. The monthly page rebuild commits with
// `git add -A`; they go to the OS temp dir (or --raw-dir).
//
// Usage:
//   node tools/build-schools.mjs                   fetch monthly sources, reuse the rest
//   node tools/build-schools.mjs --only gias,de    fetch exactly these (any cadence); every other source re-emits its snapshot
//   node tools/build-schools.mjs --refresh ccd     also fetch these annual/static sources (a deliberate new vintage)
//   options: --raw-dir <dir>   where downloads are cached (default <os tmp>/saferoute-schools)
//            --frozen          never touch the network; use rawDir's files whatever their age
//            --out <dir>       tile directory to write (default schools/data/tiles)
//            --snapshot <dir>  tile directory to read snapshots from (default: --out)
// Output: <out>/{key}.json + <out>/index.json

import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { existsSync, readFileSync } from 'node:fs';
import { FIELDS, SCHEMA_VERSION, rowProblems } from './schools/lib/schema.mjs';
import { BASE, MAX_ROWS, MIN_CELL, sortRows, tileRows, tileStats, writeTiles, readRowsFromTiles } from './schools/lib/tiles.mjs';
import { loadCoverage } from './schools/lib/coverage.mjs';
import { loadSources, loadRatings } from './schools/lib/modules.mjs';
import { makeDownloader } from './schools/lib/download.mjs';
import { composeWhere, composeFilters } from './schools/lib/meta.mjs';
import { JURIS } from './schools/juris.mjs';
import { SCOPE_NOTE } from './schools/regions.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
if (argv.includes('--help') || argv.includes('-h')) {
  console.log(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').filter(l => l.startsWith('//')).slice(22, 31).map(l => l.slice(3)).join('\n'));
  process.exit(0);
}
const arg = (n, d) => (argv.includes(n) ? argv[argv.indexOf(n) + 1] : d);
const list = v => new Set((v || '').split(',').map(s => s.trim()).filter(Boolean));
const ONLY = argv.includes('--only') ? list(arg('--only')) : null;
const REFRESH = list(arg('--refresh'));
const FROZEN = argv.includes('--frozen');
const RAW_DIR = resolve(arg('--raw-dir', join(tmpdir(), 'saferoute-schools')));
const OUT = resolve(arg('--out', join(ROOT, 'schools', 'data', 'tiles')));
const SNAPSHOT = resolve(arg('--snapshot', OUT));
const RATING_MAPS = join(ROOT, 'tools', 'data', 'schools', 'ratings');

const warn = m => console.log(`::warning::${m}`);
const fmt = n => n.toLocaleString('en-GB');

const run = async () => {
  const cov = loadCoverage();
  if (cov.stale.length) warn(`regions.mjs has entries the backend no longer covers: ${cov.stale.join(', ')}`);
  const sources = await loadSources();
  const ratings = await loadRatings();
  for (const id of [...(ONLY || []), ...REFRESH]) if (!sources.some(s => s.id === id)) throw new Error(`no source "${id}" in tools/schools/sources/`);

  // ── snapshots: every row currently published, by source ──────────────────
  const legacyV1 = sources.find(s => typeof s.fromV1 === 'function');
  const snap = readRowsFromTiles(SNAPSHOT, { legacy: { v1: legacyV1?.fromV1 } });
  const prev = snap.index?.version === SCHEMA_VERSION ? snap.index : null;
  console.log(`  snapshot: ${snap.index ? `${fmt(snap.index.count)} rows in ${snap.index.cells.length} tiles (v${snap.index.version || 1})` : 'none'}`);

  // ── run each source ──────────────────────────────────────────────────────
  const results = [];
  for (const src of sources) {
    const snapshot = snap.bySrc.get(src.id) || [];
    const prevMeta = prev?.sources?.[src.id] || null;
    // --only names exactly what to fetch (whatever its cadence); otherwise
    // monthly sources fetch, and annual/static ones only on --refresh or when
    // they have nothing in the tiles yet.
    const due = REFRESH.has(src.id) || src.cadence === 'monthly' || !snapshot.length;
    const want = ONLY ? ONLY.has(src.id) : due;
    const dl = makeDownloader({ rawDir: join(RAW_DIR, src.id), frozen: FROZEN, log: console.log });
    const stats = {};
    let vintage = prevMeta?.vintage ?? null;
    const ctx = {
      id: src.id, rawDir: join(RAW_DIR, src.id), frozen: FROZEN, refresh: REFRESH.has(src.id),
      log: (...a) => console.log(...a), warn: m => warn(`${src.id}: ${m}`),
      download: dl.download, provenance: dl.provenance,
      stat: (k, n = 1) => { stats[k] = (stats[k] || 0) + n; },
      vintage: v => { vintage = v; },
      coverage: cov, snapshot, prev: prevMeta,
    };
    console.log(`\n  ── ${src.id} (${src.cadence}) ${want ? 'fetching' : snapshot.length ? 'reusing its snapshot' : 'skipped (no snapshot)'}`);
    let rows = null, status;
    if (want) {
      try {
        rows = await src.fetch(ctx);
        if (!Array.isArray(rows) || !rows.length) throw new Error('fetch returned no rows');
        status = 'fetched';
      } catch (e) {
        rows = null;
        if (snapshot.length) warn(`${src.id}: fetch failed (${e.message}) — re-emitting its ${fmt(snapshot.length)} rows from the current tiles`);
        else warn(`${src.id}: fetch failed (${e.message}) and it has no snapshot — it is absent from this build`);
        status = 'failed';
      }
    }
    if (!rows) {
      rows = snapshot.map(r => ({ ...r }));
      status = status === 'failed' ? (rows.length ? 'snapshot-after-failure' : 'absent') : (rows.length ? 'snapshot' : 'absent');
      // A snapshot keeps the provenance of the build that fetched it — not
      // whatever a failed fetch recorded before it gave up.
      for (const k of Object.keys(stats)) delete stats[k];
      Object.assign(stats, prevMeta?.stats || {});
      vintage = prevMeta?.vintage ?? null;
      if (!want && src.probe && rows.length) {
        try { const p = await src.probe(ctx); if (p?.changed) warn(`new vintage for ${src.id}: ${p.vintage} — refresh deliberately with --refresh ${src.id}`); }
        catch (e) { warn(`${src.id}: vintage probe failed (${e.message})`); }
      }
    }
    const upstream = status === 'fetched' ? dl.provenance.map(({ cached, ...p }) => p) : (prevMeta?.upstream || []);
    // When every download came from the raw cache (--frozen, or a re-run), the
    // data is as old as the newest of those downloads, not today's.
    const dls = dl.provenance.filter(p => 'cached' in p);
    const newest = dls.map(p => p.fetchedAt || '').sort().pop() || '';
    const fetched = status !== 'fetched' ? (prevMeta?.fetched || null)
      : dls.length && dls.every(p => p.cached) && newest ? newest.slice(0, 10) : new Date().toISOString().slice(0, 10);
    results.push({ src, rows, status, stats, vintage, upstream, fetched });
    console.log(`     ${fmt(rows.length)} rows (${status})`);
  }

  // ── validate every row against its source's contract ─────────────────────
  const problems = [];
  for (const { src, rows } of results) {
    for (const r of rows) {
      const p = rowProblems(r, src);
      if (p.length) problems.push(`${src.id} ${r.id || '?'}: ${p.join('; ')}`);
    }
  }
  if (problems.length) throw new Error(`${problems.length} invalid row(s), e.g.\n    ${problems.slice(0, 10).join('\n    ')}`);

  // ── rating maps (US states; built by tools/schools/ratings.mjs) ──────────
  // Applied only to state schools of the listed sources and jurisdictions. A
  // school in a rated state that the map does not list keeps the scheme with
  // an empty value: the pane then says the state publishes a rating but this
  // school is not in that year's file, never a blank.
  const usedRatings = [];
  for (const rm of ratings) {
    const path = join(RATING_MAPS, `${rm.scheme}.json`);
    if (!existsSync(path)) { console.log(`  rating ${rm.scheme}: no map at tools/data/schools/ratings/${rm.scheme}.json yet — not applied`); continue; }
    const map = JSON.parse(readFileSync(path, 'utf8'));
    let n = 0, hit = 0;
    for (const { rows } of results) for (const r of rows) {
      if (!rm.sources.includes(r.src) || !rm.juris.includes(r.juris) || r.sector !== 'state') continue;
      const v = map.values[r.id];
      n++; if (v) hit++;
      r.ratingScheme = rm.scheme; r.rv = v?.rv ?? ''; r.rd = v?.rd ?? '';
    }
    usedRatings.push({ rm, meta: map.meta, applied: n, matched: hit });
    console.log(`  rating ${rm.scheme}: ${fmt(hit)} of ${fmt(n)} schools matched`);
  }

  // ── scope (R2) and de-duplication ────────────────────────────────────────
  const all = [], seen = new Set(), regionOf = new Map();
  for (const res of results) {
    let out = 0, dup = 0;
    const kept = [];
    for (const r of res.rows) {
      const reg = cov.regionFor(r.lat, r.lng, r.juris);
      if (!reg) { out++; continue; }
      const k = `${r.src}\u0000${r.id}`;
      if (seen.has(k)) { dup++; continue; }
      seen.add(k);
      regionOf.set(r, reg);
      kept.push(r);
    }
    if (out) res.stats['dropped.outsideScope'] = out;
    if (dup) { res.stats['dropped.duplicateId'] = dup; warn(`${res.src.id}: ${dup} duplicate id(s) dropped`); }
    res.rows = kept;
    all.push(...kept);
  }
  sortRows(all);

  // ── tiles ────────────────────────────────────────────────────────────────
  const leaves = tileRows(all, { base: BASE, maxRows: MAX_ROWS, minCell: MIN_CELL });
  const ts = tileStats(leaves);

  // ── index.json v2 ────────────────────────────────────────────────────────
  const present = results.filter(r => r.rows.length);
  const presentSources = present.map(r => r.src);
  const regions = cov.regions.map(reg => {
    const rows = all.filter(r => regionOf.get(r) === reg);
    const jurisPresent = reg.juris.filter(j => rows.some(r => r.juris === j));
    return { ...reg, rows, jurisPresent };
  }).filter(r => r.rows.length);
  const jurisCount = {};
  for (const r of all) jurisCount[r.juris] = (jurisCount[r.juris] || 0) + 1;

  const schemes = {};
  const usedIds = new Set(all.map(r => r.ratingScheme));
  for (const { src } of present) for (const [id, s] of Object.entries(src.schemes || {})) {
    if (!usedIds.has(id)) continue;
    if (schemes[id] && JSON.stringify(schemes[id]) !== JSON.stringify(s)) throw new Error(`scheme ${id} is defined differently by two sources`);
    schemes[id] = s;
  }
  for (const u of usedRatings) if (usedIds.has(u.rm.scheme)) schemes[u.rm.scheme] = { ...u.rm.record, vintage: u.meta?.vintage ?? null };
  const unknown = [...usedIds].filter(id => !schemes[id]);
  if (unknown.length) throw new Error(`rows use rating scheme(s) no source or ratings module defines: ${unknown.join(', ')}`);

  const filters = composeFilters(presentSources, all);
  const index = {
    version: SCHEMA_VERSION,
    generated: new Date().toISOString().slice(0, 10),
    base: BASE, split: { maxRows: MAX_ROWS, minCell: MIN_CELL },
    // Read by tools/sync-site-facts.mjs (the homepage count and "where"), and
    // checked by verify-schools against the rows actually in the tiles.
    count: all.length,
    where: composeWhere(regions),
    // What scope rule R2 means for a reader (the sources list on /check/).
    scope: SCOPE_NOTE,
    fields: FIELDS,
    cells: leaves.map(([k]) => k),
    regions: regions.map(r => ({ id: r.id, name: r.name, country: r.country, juris: r.jurisPresent, bbox: r.bbox,
      count: r.rows.length, view: r.view, viewName: r.viewName, ...(r.tz ? { tz: r.tz } : {}),
      // What else the rectangle holds, not mapped under R2 (regions.mjs).
      ...(r.outside?.length ? { outside: r.outside } : {}) })),
    juris: Object.fromEntries(Object.keys(jurisCount).sort().map(j => [j, { ...JURIS[j], count: jurisCount[j] }])),
    sources: Object.fromEntries(present.map(({ src, rows, status, stats, vintage, upstream, fetched }) => [src.id, {
      ...src.meta, cadence: src.cadence, juris: [...new Set(rows.map(r => r.juris))].sort(),
      rows: rows.length, status, vintage, fetched, upstream, stats,
    }])),
    schemes,
    filters,
    // The design's shape for filter values; the same list as filters[gender].options.
    options: Object.fromEntries(filters.filter(f => f.options).map(f => [f.field, f.options])),
  };
  writeTiles(OUT, leaves, index);

  // ── report ───────────────────────────────────────────────────────────────
  console.log(`\n  schools written      ${fmt(all.length)}  (${index.where})`);
  for (const { src, rows, status } of present) console.log(`    ${src.id.padEnd(10)} ${fmt(rows.length).padStart(7)}  ${status}`);
  for (const r of index.regions) console.log(`    region ${r.id.padEnd(11)} ${fmt(r.count).padStart(7)}  [${r.juris.join(' ')}]`);
  console.log(`    state ${fmt(all.filter(s => s.sector === 'state').length)}, private ${fmt(all.filter(s => s.sector === 'private').length)}`);
  for (const { src, stats } of present) {
    const s = Object.entries(stats).map(([k, v]) => `${k} ${fmt(v)}`).join(', ');
    if (s) console.log(`    ${src.id} stats: ${s}`);
  }
  console.log(`  tiles                ${ts.files} files (${Object.entries(ts.byLevel).map(([l, n]) => `${n} @${BASE / 2 ** l}°`).join(', ')}), ` +
    `${(ts.rawBytes / 1e6).toFixed(1)}MB raw, ${(ts.gzBytes / 1e6).toFixed(2)}MB gzipped; median ${(ts.medianGz / 1024).toFixed(1)}KB, ` +
    `worst ${(ts.worst[0]?.gz / 1024).toFixed(1)}KB gzipped (${ts.worst[0]?.key}, ${fmt(ts.worst[0]?.rows ?? 0)} rows)`);
};

run().catch(e => { console.error('build-schools failed:', e.message); process.exit(1); });
