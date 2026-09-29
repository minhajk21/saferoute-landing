#!/usr/bin/env node
// Dev runner for ONE home-prices source: fetch it exactly as the build would
// (same ctx, same contract checks, same R2 scope, same geometry step) and
// print what came back, without writing any tiles. For building and debugging
// a source module; the build itself is tools/build-prices.mjs.
//
// Prints: the downloads (cached or fetched), areas by region and scale, flag
// counts, each scale's value spread and the breaks it would get, geometry
// before/after simplification, what R2 dropped, any contract violation, and 3
// sample areas (the first coloured one, one near its scale's median, and a
// neutral one) with their geometry summarised.
//
// Usage: node tools/prices/run-source.mjs <id> [--frozen] [--raw-dir <dir>] [--sources <dir>] [--json <file>]
//   --frozen    never touch the network: raw cache only
//   --json      also write the prepared areas (encoded rings) to <file>, for a
//               closer look; never into the repo
// Exit 1 on a fetch failure or any contract violation.

import { join, resolve } from 'node:path';
import { writeFileSync, existsSync } from 'node:fs';
import { makeCtx, loadRegions, RAW_DIR } from './lib/ctx.mjs';
import { SOURCES_DIR, loadSource, prepareAreas, isColoured } from './lib/schema.mjs';
import { computeBreaks, percentile } from './lib/scale.mjs';
import { decodePolys } from './lib/geo.mjs';

const argv = process.argv.slice(2);
const arg = (n, d) => (argv.includes(n) ? argv[argv.indexOf(n) + 1] : d);
const id = argv.find((a, i) => !a.startsWith('--') && !['--raw-dir', '--sources', '--json'].includes(argv[i - 1]));
if (!id || argv.includes('--help')) {
  console.log('Usage: node tools/prices/run-source.mjs <id> [--frozen] [--raw-dir <dir>] [--sources <dir>] [--json <file>]');
  process.exit(id ? 0 : 1);
}
const fmt = n => (typeof n === 'number' ? n.toLocaleString('en-GB', { maximumFractionDigits: 2 }) : String(n));

const run = async () => {
  const path = join(resolve(arg('--sources', SOURCES_DIR)), `${id}.mjs`);
  if (!existsSync(path)) throw new Error(`no ${path}`);
  const src = await loadSource(path);
  const R = loadRegions();
  const bad = src.regions.filter(r => !(R.regions[r]?.sources || []).includes(src.id));
  if (bad.length) console.log(`  CONTRACT: ${src.id} serves ${bad.join(', ')}, but tools/prices/regions.mjs does not give it those regions`);
  const ctx = makeCtx({ rawDir: resolve(arg('--raw-dir', RAW_DIR)), frozen: argv.includes('--frozen'), regions: R });

  console.log(`  ── ${src.id} (${src.cadence}): ${src.meta.metric}, ${src.meta.period}, ${src.meta.currency}`);
  const t0 = Date.now();
  const out = await src.fetch(ctx);
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  if (!out || !Array.isArray(out.areas)) throw new Error('fetch did not return { vintage, areas: [...] }');
  console.log(`\n  fetched in ${secs}s: vintage ${out.vintage ?? '(none — the build refuses this)'}, ${fmt(out.areas.length)} areas`);
  for (const p of ctx.provenance) console.log(`    ${p.cached ? 'cached ' : 'fetched'}  ${p.file}  ${(p.bytes / 1e6).toFixed(2)}MB  ${p.lastModified || p.etag || ''}`);

  const prep = prepareAreas(src, out.areas, R.regions);
  const areas = prep.areas;
  const g = prep.geo;
  console.log(`\n  geometry: ${fmt(g.rings)} rings, ${fmt(g.pointsIn)} -> ${fmt(g.pointsOut)} points (${g.pointsIn ? (100 * g.pointsOut / g.pointsIn).toFixed(1) : 0}%), ` +
    `${fmt(g.ringsDropped)} ring(s) dropped; encoded ${(areas.reduce((a, x) => a + JSON.stringify(x.enc).length, 0) / 1e6).toFixed(2)}MB of rings`);
  console.log(`  dropped: ${Object.entries(prep.dropped).map(([k, v]) => `${k} ${fmt(v)}`).join(', ') || 'nothing'}` + (prep.few ? `; flagged few (n < ${src.meta.colourMinN}): ${fmt(prep.few)}` : ''));

  const flags = {};
  for (const a of areas) for (const f of a.flags) flags[f] = (flags[f] || 0) + 1;
  console.log(`  kept ${fmt(areas.length)}: ${fmt(areas.filter(isColoured).length)} coloured, ${fmt(areas.filter(a => a.value == null).length)} without a value, ` +
    `flags ${Object.entries(flags).map(([k, v]) => `${k} ${fmt(v)}`).join(', ') || 'none'}, ${fmt(areas.filter(a => a.context).length)} with a context line`);

  const byRegion = new Map();
  for (const a of areas) byRegion.set(a.region, (byRegion.get(a.region) || 0) + 1);
  console.log(`\n  by region: ${[...byRegion].map(([r, n]) => `${r} ${fmt(n)}`).join(', ')}`);
  const missingRegions = src.regions.filter(r => !byRegion.has(r) && R.regions[r]);
  if (missingRegions.length) console.log(`  NO AREAS in: ${missingRegions.join(', ')}`);
  const byScale = new Map();
  for (const a of areas) { if (!byScale.has(a.scale)) byScale.set(a.scale, []); byScale.get(a.scale).push(a); }
  console.log('  by scale (coloured values: min / p20 / median / p80 / max -> breaks):');
  for (const [k, l] of byScale) {
    const v = l.filter(isColoured).map(a => a.value).sort((a, b) => a - b);
    let br = '';
    try { br = computeBreaks(v).breaks.map(fmt).join(' / '); } catch (e) { br = `NO BREAKS (${e.message})`; }
    const juris = [...new Set(l.map(a => a.juris))].join(',');
    console.log(`    ${k.padEnd(10)} ${fmt(l.length).padStart(6)} areas, ${fmt(v.length).padStart(6)} coloured [${juris}]  ` +
      (v.length ? `${fmt(v[0])} / ${fmt(percentile(v, 0.2))} / ${fmt(percentile(v, 0.5))} / ${fmt(percentile(v, 0.8))} / ${fmt(v[v.length - 1])}` : '-') + `  -> ${br}`);
  }

  // Three samples: the first coloured area, one near the median of the
  // biggest scale, and a neutral one (flagged or without a value).
  const coloured = areas.filter(isColoured);
  const big = [...byScale.values()].sort((a, b) => b.length - a.length)[0] || [];
  const bigCol = big.filter(isColoured).sort((a, b) => a.value - b.value);
  const samples = [coloured[0], bigCol[Math.floor(bigCol.length / 2)], areas.find(a => !isColoured(a))].filter(Boolean);
  console.log('\n  samples:');
  for (const a of samples) {
    const polys = decodePolys(a.enc);
    const { enc, bbox, ...rest } = a;
    console.log(`    ${JSON.stringify(rest)}`);
    console.log(`      ${polys.length} polygon(s), ${polys.reduce((n, p) => n + p.length, 0)} ring(s), ${polys.flat().reduce((n, r) => n + r.length, 0)} points; bbox ${bbox.map(x => x.toFixed(5)).join(', ')}`);
  }

  if (arg('--json')) { writeFileSync(arg('--json'), JSON.stringify({ vintage: out.vintage, areas })); console.log(`\n  wrote ${arg('--json')}`); }
  if (prep.violations.length) {
    console.log(`\n  ${prep.violations.length} CONTRACT VIOLATION(S) — the build would stop here:\n    ${prep.violations.slice(0, 20).join('\n    ')}`);
    process.exit(1);
  }
  if (typeof out.vintage !== 'string' || !out.vintage || !areas.length || bad.length) process.exit(1);
  console.log('\n  OK: every area meets the contract.');
};

run().catch(e => { console.error(`run-source ${id} failed:`, e.stack || e.message); process.exit(1); });
