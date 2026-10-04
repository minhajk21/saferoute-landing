#!/usr/bin/env node
// Apply the rating licence rule (tools/schools/licence.mjs) to the PUBLISHED
// school tiles now, without a build: nothing is fetched and no tile is re-cut.
//
// build-schools.mjs applies the rule every month. This is for the day the rule
// changes (a licence granted or withdrawn), so the site follows it at once
// rather than at the next monthly rebuild. It runs the same code as the build
// (lib/ratings-apply.mjs: reset each row to its source's default scheme, apply
// only the licensed maps, then recompose index.schemes), so its output is what
// the next build would write for the same sources. Only rows' ratingScheme,
// rv and rd, and index.json's `schemes`, can change; every other field, the
// row order, the tile cut and the rest of index.json are left exactly as they
// are. Deterministic: a second run changes nothing.
//
// Usage: node tools/schools/apply-rating-licence.mjs [--tiles <dir>] [--check]
//   --tiles  tile directory (default schools/data/tiles)
//   --check  write nothing; exit 1 if the tiles do not already follow the rule
// Then: node tools/verify-schools.mjs (its "rating licence" check gates it).

import { readFileSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FIELDS, SCHEMA_VERSION, toRow, fromRow } from './lib/schema.mjs';
import { writeTiles } from './lib/tiles.mjs';
import { loadSources, loadRatings } from './lib/modules.mjs';
import { applyRatingMaps, composeSchemes } from './lib/ratings-apply.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const argv = process.argv.slice(2);
const arg = (n, d) => (argv.includes(n) ? argv[argv.indexOf(n) + 1] : d);
const TILES = resolve(arg('--tiles', join(ROOT, 'schools', 'data', 'tiles')));
const CHECK = argv.includes('--check');
const RATING_MAPS = join(ROOT, 'tools', 'data', 'schools', 'ratings');
const fmt = n => n.toLocaleString('en-GB');

const run = async () => {
  const idxPath = join(TILES, 'index.json');
  if (!existsSync(idxPath)) throw new Error(`no ${idxPath}`);
  const idxText = readFileSync(idxPath, 'utf8');
  const index = JSON.parse(idxText);
  if (index.version !== SCHEMA_VERSION) throw new Error(`index.json is version ${index.version}; this reads v${SCHEMA_VERSION}`);
  // Rows are rewritten with lib/schema.mjs toRow, so the tiles must already be
  // in that field order; otherwise this is a build's job, not a patch's.
  if (JSON.stringify(index.fields) !== JSON.stringify(FIELDS)) throw new Error('index.fields differs from lib/schema.mjs FIELDS — run build-schools.mjs instead');

  // Every published row, as an object, kept in its own tile and order.
  const leaves = [], texts = new Map(), before = new Map();
  for (const key of index.cells) {
    const path = join(TILES, `${key}.json`);
    if (!existsSync(path)) throw new Error(`${key}.json is listed in index.json but missing`);
    const text = readFileSync(path, 'utf8');
    texts.set(key, text);
    const rows = JSON.parse(text).map(r => fromRow(r, index.fields));
    for (const o of rows) before.set(o, `${o.ratingScheme}\u0000${o.rv}\u0000${o.rd}`);
    leaves.push([key, rows]);
  }
  const all = leaves.flatMap(([, rows]) => rows);

  // Grouped by source in source-module order, as the build has them.
  const sources = await loadSources(), ratings = await loadRatings();
  const results = sources.map(src => ({ src, rows: all.filter(o => o.src === src.id) }));
  const unknownSrc = [...new Set(all.map(o => o.src))].filter(id => !sources.some(s => s.id === id));
  if (unknownSrc.length) throw new Error(`tiles hold rows of source(s) with no module: ${unknownSrc.join(', ')}`);

  const usedRatings = applyRatingMaps(results, ratings, RATING_MAPS);
  const present = results.filter(r => r.rows.length).map(r => r.src);
  const schemes = composeSchemes(present, all, usedRatings);

  // What changed, for the log.
  const moves = {};
  for (const o of all) {
    const was = before.get(o).split('\u0000'), now = [o.ratingScheme, o.rv, o.rd];
    if (was.join('\u0000') === now.join('\u0000')) continue;
    const k = `${was[0]} -> ${now[0]}`;
    moves[k] ||= { rows: 0, valuesRemoved: 0, valuesAdded: 0 };
    moves[k].rows++;
    if (was[1] && !now[1]) moves[k].valuesRemoved++;
    if (!was[1] && now[1]) moves[k].valuesAdded++;
  }
  const changedTiles = leaves.filter(([key, rows]) => JSON.stringify(rows.map(toRow)) !== texts.get(key)).map(([key]) => key);
  const oldIds = Object.keys(index.schemes), newIds = Object.keys(schemes);
  const nextIndex = { ...index, schemes };
  const indexChanged = JSON.stringify(nextIndex) !== idxText;

  for (const [k, m] of Object.entries(moves).sort()) {
    console.log(`  ${k}: ${fmt(m.rows)} row(s); values removed ${fmt(m.valuesRemoved)}, added ${fmt(m.valuesAdded)}`);
  }
  console.log(`  schemes removed: ${oldIds.filter(id => !schemes[id]).join(', ') || 'none'}`);
  console.log(`  schemes added:   ${newIds.filter(id => !index.schemes[id]).join(', ') || 'none'}`);
  console.log(`  ${changedTiles.length} of ${leaves.length} tile file(s) change; index.json ${indexChanged ? 'changes' : 'unchanged'}`);

  if (CHECK) {
    if (changedTiles.length || indexChanged) { console.log('  --check: the published tiles do not follow tools/schools/licence.mjs'); process.exit(1); }
    console.log('  --check: the published tiles follow tools/schools/licence.mjs');
    return;
  }
  if (!changedTiles.length && !indexChanged) { console.log('  nothing to write'); return; }
  // The build's own atomic writer: the same bytes for every unchanged tile.
  writeTiles(TILES, leaves, nextIndex);
  console.log(`  wrote ${TILES}`);
};

run().catch(e => { console.error('apply-rating-licence failed:', e.message); process.exit(1); });
