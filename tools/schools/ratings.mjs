#!/usr/bin/env node
// Build one US state's rating map: tools/data/schools/ratings/<scheme>.json.
//
// Ratings are refreshed on their own annual cadence, never in the monthly
// build: the files are large (Illinois 40MB, North Carolina 202MB, New York
// 390MB), some hosts are fragile, and a rating must never change shape
// unreviewed. So each scheme is built by hand (or workflow_dispatch) with this
// runner, the map is committed, and build-schools.mjs merges the committed map
// into the tiles every month without touching the network, if
// tools/schools/licence.mjs licenses the scheme's values (this runner says so
// when it does not).
//
//   node tools/schools/ratings.mjs --scheme us-tx-af [--raw-dir <dir>] [--frozen] [--tiles <dir>]
//
// The runner:
//   1. loads tools/schools/ratings/<scheme>.mjs (contract: tools/schools/README.md)
//   2. gives build(ctx) the rows it may rate — current tiles, state schools of
//      the module's sources in its jurisdictions — plus a cached downloader
//   3. keeps only values for those rows, checks each value against the
//      scheme's allowed values, and computes the match share
//   4. REFUSES TO WRITE if the share is below the module's floor (a changed
//      file layout or join key shows up as a collapse in matches, not an error)
//   5. writes { meta: { scheme, juris, sources, vintage, built, upstream, match }, values }

import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { loadRatings, loadSources } from './lib/modules.mjs';
import { readRowsFromTiles } from './lib/tiles.mjs';
import { makeDownloader } from './lib/download.mjs';
import { ratingLicensed } from './licence.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const argv = process.argv.slice(2);
const arg = (n, d) => (argv.includes(n) ? argv[argv.indexOf(n) + 1] : d);
const SCHEME = arg('--scheme');
const RAW_DIR = resolve(arg('--raw-dir', join(tmpdir(), 'saferoute-schools')));
const TILES = resolve(arg('--tiles', join(ROOT, 'schools', 'data', 'tiles')));
const OUT_DIR = join(ROOT, 'tools', 'data', 'schools', 'ratings');

const run = async () => {
  if (!SCHEME) throw new Error('usage: node tools/schools/ratings.mjs --scheme <id>');
  const rm = (await loadRatings()).find(r => r.scheme === SCHEME);
  if (!rm) throw new Error(`no tools/schools/ratings/${SCHEME}.mjs`);
  if (!ratingLicensed(SCHEME)) console.log(`  note: tools/schools/licence.mjs does not license ${SCHEME}'s values, so build-schools.mjs will not apply this map (its schools keep their link-out line). It is built only to be checked.`);
  const sources = await loadSources();
  const legacy = sources.find(s => typeof s.fromV1 === 'function');
  const snap = readRowsFromTiles(TILES, { legacy: { v1: legacy?.fromV1 } });
  const rows = rm.sources.flatMap(s => snap.bySrc.get(s) || [])
    .filter(r => rm.juris.includes(r.juris) && r.sector === 'state');
  if (!rows.length) throw new Error(`no ${rm.sources.join('/')} state-school rows in ${rm.juris.join(', ')} in the current tiles — build that source first`);

  const dl = makeDownloader({ rawDir: join(RAW_DIR, `rating-${SCHEME}`), frozen: argv.includes('--frozen'), log: console.log });
  const stats = {};
  let vintage = null;
  const ctx = {
    scheme: SCHEME, rows, log: (...a) => console.log(...a), warn: m => console.log(`::warning::${SCHEME}: ${m}`),
    download: dl.download, provenance: dl.provenance,
    stat: (k, n = 1) => { stats[k] = (stats[k] || 0) + n; },
    vintage: v => { vintage = v; },
  };
  const got = await rm.build(ctx);
  const all = got?.values || {};
  const ids = new Set(rows.map(r => r.id));
  const values = {}, bad = [];
  for (const [id, v] of Object.entries(all)) {
    if (!ids.has(id)) continue;
    if (!v || typeof v.rv !== 'string' || !v.rv) { bad.push(`${id}: empty rv`); continue; }
    if (rm.record.values && !rm.record.values.includes(v.rv)) { bad.push(`${id}: "${v.rv}" not in the scheme's values`); continue; }
    values[id] = { rv: v.rv, ...(v.rd ? { rd: v.rd } : {}) };
  }
  if (bad.length) throw new Error(`${bad.length} bad value(s), e.g. ${bad.slice(0, 5).join('; ')}`);
  const rated = Object.keys(values).length, share = rated / rows.length;
  console.log(`  ${SCHEME}: ${rated} of ${rows.length} in-scope schools matched (${(100 * share).toFixed(1)}%, floor ${(100 * rm.floor).toFixed(0)}%)`);
  if (share < rm.floor) throw new Error(`match ${(100 * share).toFixed(1)}% is below the floor ${(100 * rm.floor).toFixed(0)}% — not written. A layout or key change upstream looks exactly like this.`);

  mkdirSync(OUT_DIR, { recursive: true });
  const doc = {
    meta: {
      scheme: SCHEME, juris: rm.juris, sources: rm.sources, vintage: got.vintage ?? vintage,
      built: new Date().toISOString().slice(0, 10),
      upstream: dl.provenance.map(({ cached, ...p }) => p),
      match: { rated, inScope: rows.length, share: +share.toFixed(4), floor: rm.floor }, stats,
    },
    values: Object.fromEntries(Object.keys(values).sort().map(k => [k, values[k]])),
  };
  writeFileSync(join(OUT_DIR, `${SCHEME}.json`), JSON.stringify(doc) + '\n');
  console.log(`  wrote tools/data/schools/ratings/${SCHEME}.json`);
};

run().catch(e => { console.error('ratings failed:', e.message); process.exit(1); });
