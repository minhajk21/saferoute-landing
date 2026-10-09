#!/usr/bin/env node
// O1, the app pack builder (SafeRoute 1.4: RELEASE-1.4-SCOPE.md §4.4).
//
// Reads the VERIFIED published school and home-value data at a pinned landing
// commit and writes, OUTSIDE the served tree, the packs the iPhone app bundles:
//   <out>/schools-pack.json + schools-pack.bin
//   <out>/prices-pack.json  + prices-pack.bin
// Container, chunking, display rules and gates: tools/app-packs/README.md.
// Any gate failing stops the build and nothing is written.
//
// Usage:
//   node tools/build-app-packs.mjs [--out DIR] [--layer schools|prices|all]
//                                  [--commit REV] [--allow-dirty] [--json]
//   --out          output directory (default out/app-packs, git-ignored). Inside
//                  any checkout of this repository only its out/ is allowed.
//   --layer        which pack(s) to build (default all). The other layer's pack
//                  in --out is removed if it came from another landing commit.
//   --commit REV   build from git (git archive), not the working tree. The
//                  commit recorded is the last one at or before REV that
//                  changed an input.
//   --allow-dirty  build from a working tree whose data differs from HEAD (never
//                  covers the rule paths: licence, filters, schema, modules)
//   --json         print the summary as JSON
// Exit codes: 0 built, 1 a gate or the build failed, 2 a usage error.

import { parseArgs } from 'node:util';
import { resolve, join } from 'node:path';
import { REPO, toolchain } from './app-packs/lib/landing.mjs';
import { buildPacks, outProblem, removeStale, LAYERS } from './app-packs/lib/build.mjs';
import { writePack } from './app-packs/lib/container.mjs';
import { GateError } from './app-packs/lib/gates.mjs';

const mb = n => `${(n / 1e6).toFixed(2)} MB`;
const kb = n => `${(n / 1e3).toFixed(1)} KB`;
const fmt = n => n.toLocaleString('en-GB');

function printSummary({ landing, built }, written, tools, removed) {
  console.log(`landing: ${landing.from}; landingCommit ${landing.landingCommit}; generated ${landing.generated}`);
  console.log(`rules: HEAD's (last change ${landing.rulesCommit?.slice(0, 9)}); node ${tools.node}, zlib ${tools.zlib}; builder ${tools.builderCommit?.slice(0, 9) ?? '?'}`);
  for (const b of built) {
    const r = b.report;
    console.log(`\n${r.layer} pack`);
    if (r.layer === 'schools') {
      console.log(`  ${fmt(r.chunks)} chunks (one per leaf), ${fmt(r.rows)} rows`);
      console.log(`  display case applied: ${Object.entries(r.displayCased).map(([f, n]) => `${f} ${fmt(n)}`).join(', ')}; unlicensed US rating values stripped: ${r.valuesRemoved} (rows reset: ${r.stripped})`);
    } else {
      console.log(`  ${fmt(r.chunks)} chunks (one per colour scale), ${fmt(r.areas)} areas (from ${fmt(r.occurrences)} tile rows), ${fmt(r.vertices)} vertices`);
      console.log(`  leaf map: ${fmt(r.leaves)} leaves -> (chunk, row), ${kb(r.leafMapBytes)} of JSON`);
    }
    console.log(`  raw ${mb(r.rawBytes)} -> bin ${mb(r.binBytes)} deflated; json ${kb(r.jsonBytes)}`);
    console.log(`  largest chunk: ${r.largest.key}${r.largest.name ? ` (${r.largest.name})` : ''}: ${kb(r.largest.len)} deflated, ${kb(r.largest.raw)} raw, ${fmt(r.largest.rows)} rows`);
    console.log(`  sha256 ${r.sha256}`);
    for (const g of b.gates) console.log(`  ${g.ok ? 'PASS' : 'FAIL'} ${g.name}: ${g.ok ? g.detail : g.problems.slice(0, 5).join(' | ')}`);
    if (written?.[r.layer]) console.log(`  wrote ${written[r.layer].json}\n        ${written[r.layer].bin}`);
  }
  for (const f of removed) console.log(`removed ${f} (another landing commit's pack)`);
}

function usage(msg) {
  console.error(`${msg}\nusage: node tools/build-app-packs.mjs [--out DIR] [--layer schools|prices|all] [--commit REV] [--allow-dirty] [--json]`);
  process.exit(2);
}

async function main() {
  let values;
  try {
    ({ values } = parseArgs({
      args: process.argv.slice(2), strict: true, allowPositionals: false,
      options: { out: { type: 'string' }, layer: { type: 'string', default: 'all' }, commit: { type: 'string' }, 'allow-dirty': { type: 'boolean', default: false }, json: { type: 'boolean', default: false } },
    }));
  } catch (e) { usage(e.message); }
  if (!['schools', 'prices', 'all'].includes(values.layer)) usage(`--layer ${values.layer}: want schools | prices | all`);
  if (values.out !== undefined && !values.out.trim()) usage('--out needs a directory');
  if (values.commit !== undefined && !values.commit.trim()) usage('--commit needs a revision (it was empty)');
  if (values.commit !== undefined && values['allow-dirty']) usage('--allow-dirty has no meaning with --commit');
  const layers = values.layer === 'all' ? [...LAYERS] : [values.layer];
  const out = resolve(values.out ?? join(REPO, 'out', 'app-packs'));
  const bad = outProblem(out);
  if (bad) usage(bad);
  try {
    const result = await buildPacks({ layers, commit: values.commit ?? null, allowDirty: values['allow-dirty'] });
    const written = {};
    for (const b of result.built) written[b.report.layer] = writePack(out, b.report.layer, b.json, b.bin);
    const removed = removeStale(out, layers, result.landing.landingCommit);
    const tools = toolchain();
    if (values.json) {
      console.log(JSON.stringify({ landing: result.landing, toolchain: tools, removed, packs: result.built.map(b => ({ ...b.report, gates: b.gates.map(g => ({ name: g.name, ok: g.ok, detail: g.detail })), files: written[b.report.layer] })) }, null, 1));
    } else printSummary(result, written, tools, removed);
  } catch (e) {
    if (e instanceof GateError) {
      console.error(`::error::${e.message}`);
      for (const g of e.gates) console.error(`  ${g.ok ? 'PASS' : 'FAIL'} ${g.name}`);
      console.error('Nothing was written.');
    } else console.error(e.stack || e.message);
    process.exit(1);
  }
}

// Always run: nothing imports this file (the library is tools/app-packs/lib),
// and a guard comparing import.meta.url with argv[1] silently does nothing
// when the script is reached through a symlink.
await main();
