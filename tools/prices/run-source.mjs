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
// A SALE source (kind point-sales) is fetched the same way, and its sales are
// placed in its geometry source's tracts as published (--snapshot, default
// prices/data: the geometry source's rows plus the sale source's own), or, if
// none are published, in the geometry source's own fresh fetch (raw cache).
// It prints what SPEC2 §C asks each sale source to measure: rows in and each
// drop reason, sales placed, the window, tracts with n >= 3 and n >= 10 at 12
// AND 24 months (prefer 12 unless it leaves more than 30% of covered tracts
// under 10), the median of tract medians per county, and the median of all
// placed sales (to compare with the publisher's own summary).
//
// Usage: node tools/prices/run-source.mjs <id> [--frozen] [--raw-dir <dir>] [--sources <dir>] [--snapshot <dir>] [--json <file>]
//   --frozen    never touch the network: raw cache only
//   --json      also write the prepared areas (encoded rings) to <file>, for a
//               closer look; never into the repo
// Exit 1 on a fetch failure or any contract violation.

import { join, resolve, dirname } from 'node:path';
import { writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { makeCtx, loadRegions, RAW_DIR } from './lib/ctx.mjs';
import { SOURCES_DIR, loadSource, prepareAreas, areaProblems, isColoured, isSales } from './lib/schema.mjs';
import { computeBreaks, percentile } from './lib/scale.mjs';
import { decodePolys } from './lib/geo.mjs';
import { buildSaleAreas, MIN_SHOWN } from './lib/sales.mjs';
import { readAreasFromTiles } from './lib/tiles.mjs';
import { scalesFor } from './regions.mjs';

const argv = process.argv.slice(2);
const arg = (n, d) => (argv.includes(n) ? argv[argv.indexOf(n) + 1] : d);
const id = argv.find((a, i) => !a.startsWith('--') && !['--raw-dir', '--sources', '--json', '--snapshot'].includes(argv[i - 1]));
if (!id || argv.includes('--help')) {
  console.log('Usage: node tools/prices/run-source.mjs <id> [--frozen] [--raw-dir <dir>] [--sources <dir>] [--snapshot <dir>] [--json <file>]');
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
  if (isSales(src)) return runSales(src, R, ctx, bad);

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

// ── a sale source ───────────────────────────────────────────────────────────
async function geometryTracts(src, g, R) {
  const dir = resolve(arg('--snapshot', join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'prices', 'data')));
  const snap = readAreasFromTiles(dir);
  const byId = new Map();
  for (const a of [...(snap.bySrc.get(src.id) || []), ...(snap.bySrc.get(g.id) || [])]) if (src.regions.includes(a.region)) byId.set(a.id, a);
  if (byId.size) { console.log(`  tracts: ${fmt(byId.size)} published by ${g.id}${snap.bySrc.has(src.id) ? ` and ${src.id}` : ''} (${dir})`); return [...byId.values()]; }
  console.log(`  tracts: none published in ${dir}; fetching ${g.id} (raw cache where it can)`);
  const gctx = makeCtx({ rawDir: resolve(arg('--raw-dir', RAW_DIR)), frozen: argv.includes('--frozen'), regions: R });
  const out = await g.fetch(gctx);
  const prep = prepareAreas(g, out.areas, R.regions);
  if (prep.violations.length) throw new Error(`${g.id}: ${prep.violations.slice(0, 3).join('; ')}`);
  return prep.areas.filter(a => src.regions.includes(a.region));
}

async function runSales(src, R, ctx, bad) {
  const w = src.meta.window || {};
  console.log(`  ── ${src.id} (point-sales, ${src.cadence}): ${src.meta.metric}, ${w.months} months by ${w.by} date, lag ${w.lagMonths || 0}, ${src.meta.currency}; geometry ${src.geometry}`);
  const gPath = join(resolve(arg('--sources', SOURCES_DIR)), `${src.geometry}.mjs`);
  if (!existsSync(gPath)) throw new Error(`no geometry source ${gPath}`);
  const g = await loadSource(gPath);
  const tracts = await geometryTracts(src, g, R);
  const t0 = Date.now();
  const out = await src.fetch(ctx);
  console.log(`\n  fetched in ${((Date.now() - t0) / 1000).toFixed(1)}s: ${fmt(out?.sales?.length ?? 0)} sales; covers ${JSON.stringify(out?.covers)}${out?.through ? `; through ${out.through}` : ''}`);
  for (const p of ctx.provenance) console.log(`    ${p.cached ? 'cached ' : 'fetched'}  ${p.file}  ${(p.bytes / 1e6).toFixed(2)}MB  ${p.lastModified || p.etag || ''}`);
  const srcDrops = Object.entries(out?.dropped || {});
  console.log(`  the source left out ${fmt(srcDrops.reduce((t, [, v]) => t + v, 0))} row(s): ${srcDrops.map(([k, v]) => `${k} ${fmt(v)}`).join(', ') || 'none counted'}`);

  const now = new Date().toISOString().slice(0, 10);   // as the build: the build day
  const geoMeta = g.meta;
  const build = months => buildSaleAreas({ src: { ...src, meta: { ...src.meta, window: { ...w, months } } }, out, tracts, geoMeta, now, scaleOf: rid => scalesFor(rid)[0], keepPrices: true });
  const main = build(w.months);
  if (main.violations.length) {
    console.log(`\n  ${main.violations.length} CONTRACT VIOLATION(S) — the build would stop here:\n    ${main.violations.slice(0, 20).join('\n    ')}`);
    process.exit(1);
  }
  const probs = main.areas.flatMap(a => areaProblems(a, src, { raw: false }).map(p => `${a.id}: ${p}`));
  const d = main.stats.dropped;
  console.log(`  window ${main.window.from}..${main.window.to} — "${main.meta.period}"`);
  console.log(`  placed ${fmt(main.stats.sales.used)} of ${fmt(main.stats.sales.received)}; the build dropped: ${['futureDate', 'outOfWindow', 'outsideTracts', 'outsideCovers'].map(k => `${k} ${fmt(d[k])}`).join(', ')}`);

  // Coverage at 12 and 24 months (SPEC2 §C: prefer 12 unless it leaves more
  // than 30% of covered tracts under 10 sales).
  const minN = src.meta.colourMinN;
  console.log(`\n  covered tracts: ${fmt(main.areas.length)} (${[...new Set(main.areas.map(a => a.region))].join(', ')})`);
  for (const months of [12, 24]) {
    const b = months === w.months ? main : build(months), l = b.areas;
    const k = f => l.filter(f).length, pct = x => `${(100 * x / (l.length || 1)).toFixed(1)}%`;
    console.log(`    ${String(months).padStart(2)} months (${b.window.from}..${b.window.to}): ${fmt(b.stats.sales.used)} sales; n >= ${minN} ${fmt(k(a => a.n >= minN))} (${pct(k(a => a.n >= minN))}), ` +
      `${MIN_SHOWN}–${minN - 1} ${fmt(k(a => a.n >= MIN_SHOWN && a.n < minN))}, 1–${MIN_SHOWN - 1} ${fmt(k(a => a.n > 0 && a.n < MIN_SHOWN))}, none ${fmt(k(a => !a.n))}; ` +
      `under ${minN}: ${pct(k(a => a.n < minN))}${months === w.months ? '  <- the window this source declares' : ''}`);
  }

  // Median of tract medians by county, and of every placed sale.
  const county = a => /,\s*([^,]+),\s*[A-Z]{2}$/.exec(a.name || '')?.[1] || a.id.slice(0, 5);
  const byCounty = new Map();
  for (const a of main.areas.filter(isColoured)) { const c = `${county(a)} (${a.id.slice(0, 5)})`; if (!byCounty.has(c)) byCounty.set(c, []); byCounty.get(c).push(a.value); }
  const med = v => percentile([...v].sort((x, y) => x - y), 0.5);
  console.log('\n  median of coloured tract medians, by county:');
  for (const [c, v] of [...byCounty].sort()) console.log(`    ${c.padEnd(32)} ${fmt(v.length).padStart(5)} tracts  ${fmt(Math.round(med(v)))}`);
  const every = [...main.prices.values()].flat();
  console.log(`  median of all ${fmt(every.length)} placed sales: ${fmt(Math.round(med(every)))} (compare with the publisher's own summary for ${main.window.span})`);
  const v = main.areas.filter(isColoured).map(a => a.value).sort((x, y) => x - y);
  try { console.log(`  breaks it would get: ${computeBreaks(v).breaks.map(fmt).join(' / ')}`); } catch (e) { console.log(`  NO BREAKS (${e.message})`); }

  console.log('\n  samples:');
  const col = main.areas.filter(isColoured).sort((x, y) => x.value - y.value);
  for (const a of [col[Math.floor(col.length / 2)], main.areas.find(x => x.flags.includes('few')), main.areas.find(x => x.flags.includes('suppressed'))].filter(Boolean)) {
    const { enc, bbox, ...rest } = a;
    console.log(`    ${JSON.stringify(rest)}`);
  }
  if (arg('--json')) { writeFileSync(arg('--json'), JSON.stringify({ window: main.window, areas: main.areas })); console.log(`\n  wrote ${arg('--json')}`); }
  if (probs.length) {
    console.log(`\n  ${probs.length} CONTRACT VIOLATION(S) — the build would stop here:\n    ${probs.slice(0, 20).join('\n    ')}`);
    process.exit(1);
  }
  if (!main.stats.sales.used || bad.length) process.exit(1);
  console.log('\n  OK: every tract meets the contract.');
}

run().catch(e => { console.error(`run-source ${id} failed:`, e.stack || e.message); process.exit(1); });
