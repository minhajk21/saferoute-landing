// Building and writing the packs: what tools/build-app-packs.mjs runs, kept
// here so the tests can call it without the CLI.

import { execFileSync } from 'node:child_process';
import { existsSync, realpathSync, statSync, readFileSync, rmSync } from 'node:fs';
import { resolve, dirname, basename, join } from 'node:path';
import { openLanding, openRules, loadPageRules, loadSchoolsRules, loadPricesRules, REPO } from './landing.mjs';
import { readSchoolsInput, packSchools } from './schools.mjs';
import { openTextSource, buildSchoolsText, TEXT_FILE } from './schools-text.mjs';
import { GateError } from './gates.mjs';
import { readPricesInput, packPrices } from './prices.mjs';

export const LAYERS = Object.freeze(['schools', 'prices']);

// The schools layer also writes its Spanish display text (schools.es.json,
// lib/schools-text.mjs), from the translation source at the builder's HEAD;
// its gates join the schools pack's. strictEs: a missing translation fails.
export async function buildPacks({ layers = LAYERS, commit = null, allowDirty = false, repo = REPO, strictEs = false } = {}) {
  const landing = openLanding({ repo, commit, allowDirty, layers });
  let rules;
  try {
    const text = layers.includes('schools') ? openTextSource({ repo, allowDirty, commit }) : null;
    rules = openRules({ repo });
    const at = { landingCommit: landing.landingCommit, generated: landing.generated, rulesCommit: rules.rulesCommit };
    const built = [];
    if (layers.includes('schools')) {
      const r = { ...loadPageRules(landing.root), ...(await loadSchoolsRules(landing.root, rules.root)) };
      const b = packSchools(readSchoolsInput(landing.root), r, at);
      const t = buildSchoolsText({ json: b.json, bin: b.bin, rows: b.rows, source: text.source, landingCommit: landing.landingCommit, textCommit: text.textCommit, strictEs });
      b.gates.push(...t.gates);
      if (t.gates.some(g => !g.ok)) throw new GateError('schools', b.gates);
      b.text = t;
      built.push(b);
    }
    if (layers.includes('prices')) {
      const r = await loadPricesRules(landing.root, rules.root);
      built.push(packPrices(readPricesInput(landing.root), r, at));
    }
    return { landing: { ...at, from: landing.from }, built };
  } finally {
    landing.cleanup();
    rules?.cleanup();
  }
}

const gitOut = (dir, args) => {
  try { return execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return null; }
};

// Where packs may be written. The repo root is the served site, so inside
// this repository (this work tree, the main checkout or any other worktree
// of it) only the git-ignored top-level out/ may receive packs. The check is
// on the real path of the deepest existing directory, as git sees it
// (symlinks resolved, letter case as on disk), not on the string given.
// Anywhere outside this repository is fine. Returns a problem or null.
export function outProblem(out, repo = REPO) {
  const abs = resolve(out);
  let anc = abs;
  const rest = [];
  while (!existsSync(anc)) {
    const up = dirname(anc);
    if (up === anc) break;
    rest.unshift(basename(anc));
    anc = up;
  }
  let real;
  try { real = realpathSync.native(anc); } catch (e) { return `--out ${out}: ${e.message}`; }
  if (!statSync(real).isDirectory()) return `--out ${out}: ${anc} is a file, not a directory`;
  const common = gitOut(real, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
  if (!common) return null;                                   // in no git repository
  const ours = gitOut(repo, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
  if (!ours) return null;
  if (realpathSync.native(common) !== realpathSync.native(ours)) return null;   // another repository
  const where = `--out ${out} (${join(real, ...rest)})`;
  if (gitOut(real, ['rev-parse', '--is-inside-work-tree']) !== 'true') return `${where} is inside this repository's git directory`;
  const rel = `${gitOut(real, ['rev-parse', '--show-prefix']) ?? ''}${rest.join('/')}`.replace(/\/+$/, '');
  if (/^out(\/|$)/.test(rel)) return null;
  return `${where} is inside a checkout of the served site; use its out/ (git-ignored) or a path outside the repo`;
}

// After building one layer, the other layer's pack in the same directory is
// removed if it was built from another landing commit, so the directory never
// holds a mixed pair. Returns the files removed.
// The schools pack's Spanish text (schools.es.json) goes with it: removed
// with a stale schools pack, and on its own if it names another pack.
export function removeStale(outDir, built, landingCommit) {
  const removed = [];
  const rm = f => { if (existsSync(f)) { rmSync(f, { force: true }); removed.push(f); } };
  for (const layer of LAYERS) {
    if (built.includes(layer)) continue;
    const json = join(outDir, `${layer}-pack.json`), bin = join(outDir, `${layer}-pack.bin`);
    const extra = layer === 'schools' ? [join(outDir, TEXT_FILE)] : [];
    if (!existsSync(json) && !existsSync(bin)) { extra.forEach(rm); continue; }
    let theirs = null;
    try { theirs = JSON.parse(readFileSync(json, 'utf8')).pack?.landingCommit ?? null; } catch { /* unreadable: stale */ }
    if (theirs === landingCommit && existsSync(bin)) {
      for (const f of extra) {
        let forPack = null;
        try { forPack = JSON.parse(readFileSync(f, 'utf8')).forPack?.landingCommit ?? null; } catch { /* unreadable or absent */ }
        if (existsSync(f) && forPack !== landingCommit) rm(f);
      }
      continue;
    }
    [json, bin, ...extra].forEach(rm);
  }
  return removed;
}
