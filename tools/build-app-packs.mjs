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
//   --out          output directory (default out/app-packs, git-ignored; never
//                  a served path)
//   --layer        which pack(s) to build (default all)
//   --commit REV   build from that landing commit's files (git archive), not
//                  the working tree
//   --allow-dirty  build from a working tree whose inputs differ from HEAD
//   --json         print the summary as JSON

import { resolve, relative, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { openLanding, loadPageRules, loadSchoolsRules, loadPricesRules, REPO } from './app-packs/lib/landing.mjs';
import { readSchoolsInput, packSchools } from './app-packs/lib/schools.mjs';
import { readPricesInput, packPrices } from './app-packs/lib/prices.mjs';
import { writePack } from './app-packs/lib/container.mjs';
import { GateError } from './app-packs/lib/gates.mjs';

export async function buildPacks({ layer = 'all', commit = null, allowDirty = false, repo = REPO } = {}) {
  const landing = openLanding({ repo, commit, allowDirty });
  try {
    const built = [];
    if (layer === 'schools' || layer === 'all') {
      const rules = { ...loadPageRules(landing.root), ...(await loadSchoolsRules(landing.root)) };
      built.push(packSchools(readSchoolsInput(landing.root), rules, landing));
    }
    if (layer === 'prices' || layer === 'all') {
      const rules = await loadPricesRules(landing.root);
      built.push(packPrices(readPricesInput(landing.root), rules, landing));
    }
    return { landing, built };
  } finally {
    landing.cleanup();
  }
}

const mb = n => `${(n / 1e6).toFixed(2)} MB`;
const kb = n => `${(n / 1e3).toFixed(1)} KB`;
const fmt = n => n.toLocaleString('en-GB');

function printSummary({ landing, built }, written) {
  console.log(`landing: ${landing.from}; landingCommit ${landing.landingCommit}; generated ${landing.generated}`);
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
}

// Inside the repo (the repo root is the served site) only the git-ignored
// out/ may receive packs.
export function outProblem(out, repo = REPO) {
  const rel = relative(repo, out);
  return !rel.startsWith('..') && !/^out(\/|$)/.test(rel) ? `--out ${out} is inside the served site; use out/… (git-ignored) or a path outside the repo` : null;
}

async function main() {
  const argv = process.argv.slice(2);
  const arg = (n, d) => (argv.includes(n) ? argv[argv.indexOf(n) + 1] : d);
  const layer = arg('--layer', 'all');
  const out = resolve(arg('--out', join(REPO, 'out', 'app-packs')));
  if (!['schools', 'prices', 'all'].includes(layer)) { console.error(`--layer ${layer}: want schools | prices | all`); process.exit(2); }
  const bad = outProblem(out);
  if (bad) { console.error(bad); process.exit(2); }
  try {
    const result = await buildPacks({ layer, commit: arg('--commit', null), allowDirty: argv.includes('--allow-dirty') });
    const written = {};
    for (const b of result.built) written[b.report.layer] = writePack(out, b.report.layer, b.json, b.bin);
    if (argv.includes('--json')) {
      const { landingCommit, generated, from } = result.landing;
      console.log(JSON.stringify({ landing: { landingCommit, generated, from }, packs: result.built.map(b => ({ ...b.report, gates: b.gates.map(g => ({ name: g.name, ok: g.ok, detail: g.detail })), files: written[b.report.layer] })) }, null, 1));
    } else printSummary(result, written);
  } catch (e) {
    if (e instanceof GateError) {
      console.error(`::error::${e.message}`);
      for (const g of e.gates) console.error(`  ${g.ok ? 'PASS' : 'FAIL'} ${g.name}`);
      console.error('Nothing was written.');
    } else console.error(e.stack || e.message);
    process.exit(1);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();
