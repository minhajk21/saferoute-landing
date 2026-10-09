// Where the packs' inputs come from: the VERIFIED published data, the page's
// own display rules and the source modules, all at one landing commit; and
// the RULES the gates hold that data to, from the builder's own commit.
//
// THE DATA. Two ways to pin it:
//   --commit <rev>  the files are taken from git (git archive into a temporary
//                   directory), whatever the working tree holds. This is what
//                   O2 (tools/import-overlay-packs.mjs) uses.
//   (default)       the working tree of the repo, which must match HEAD for
//                   every input path (--allow-dirty overrides, and the commit
//                   is then recorded with "+dirty"; it never overrides a dirty
//                   RULE path, below).
// Either way the commit recorded (pack.landingCommit) is the LAST COMMIT THAT
// CHANGED AN INPUT at or before the one asked for, and `generated` is that
// commit's date in UTC. So the same data gives byte-identical packs however
// it is named (a branch tip, a safety-pages-only main commit, the data commit
// itself), and a tooling-only commit changes nothing.
//
// THE RULES. The licence allow-list (tools/schools/licence.mjs), the filter
// definitions, the row field lists and the loaded source and ratings modules
// are ALSO read from the builder's committed HEAD (never its working tree),
// and a scheme is licensed, or a source id loadable, only if it is in BOTH.
// So neither an old --commit nor an edit in the working tree can widen what a
// pack may carry; a licence withdrawn since the data commit is withdrawn from
// the pack too. pack.rulesCommit records the last HEAD commit that changed a
// rule path.

import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

// Everything a pack is made from (both layers: both packs record one commit).
export const INPUT_PATHS = Object.freeze(['schools/data', 'prices/data', 'check/index.html', 'tools/schools', 'tools/prices']);
// What each layer reads (tools/prices imports helpers from tools/schools).
export const LAYER_PATHS = Object.freeze({
  schools: ['schools/data', 'check/index.html', 'tools/schools'],
  prices: ['prices/data', 'tools/prices', 'tools/schools'],
});
// What decides what a pack may carry. Dirty here refuses the build even with
// --allow-dirty, and the gates read these from HEAD as well.
export const RULE_PATHS = Object.freeze([
  'tools/schools/licence.mjs', 'tools/schools/filters.mjs', 'tools/schools/lib/schema.mjs', 'tools/schools/lib/modules.mjs',
  'tools/schools/ratings', 'tools/schools/sources', 'tools/prices/lib/schema.mjs', 'tools/prices/sources', 'tools/prices/parked',
]);
// The builder's own code, recorded in the summary (not in the packs).
export const BUILDER_PATHS = Object.freeze(['tools/app-packs', 'tools/build-app-packs.mjs']);

const git = (repo, args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', maxBuffer: 1 << 26, stdio: ['ignore', 'pipe', 'pipe'] }).trim();

// A commit's date as UTC ISO 8601 (seconds), whatever zone the committer used.
const commitDate = (repo, sha) => new Date(Number(git(repo, ['show', '-s', '--format=%ct', sha])) * 1000).toISOString().replace(/\.000Z$/, 'Z');

export const lastChange = (repo, rev, paths) => git(repo, ['log', '-1', '--format=%H', rev, '--', ...paths]);

// git archive <sha> -- paths, extracted into a new temporary directory. Two
// separate processes, so a failing git archive is an error, not an empty tree.
export function archive(repo, sha, paths, prefix = 'app-packs-') {
  const root = mkdtempSync(join(tmpdir(), prefix));
  const tar = join(root, '.archive.tar');
  try {
    execFileSync('git', ['-C', repo, 'archive', '--format=tar', '-o', tar, sha, '--', ...paths], { stdio: ['ignore', 'ignore', 'pipe'] });
    execFileSync('tar', ['-xf', tar, '-C', root], { stdio: ['ignore', 'ignore', 'pipe'] });
  } catch (e) {
    rmSync(root, { recursive: true, force: true });
    throw new Error(`git archive ${sha.slice(0, 9)} -- ${paths.join(' ')} failed: ${String(e.stderr || e.message).trim()}`);
  }
  rmSync(tar, { force: true });
  return root;
}

export function openLanding({ repo = REPO, commit = null, allowDirty = false, layers = ['schools', 'prices'] } = {}) {
  const paths = [...new Set(layers.flatMap(l => LAYER_PATHS[l]))];
  if (commit != null) {
    if (typeof commit !== 'string' || !commit.trim()) throw new Error('--commit needs a revision (it was empty)');
    if (allowDirty) throw new Error('--allow-dirty has no meaning with --commit (the files come from git, not the working tree)');
    let asked;
    try { asked = git(repo, ['rev-parse', '--verify', '--end-of-options', `${commit}^{commit}`]); } catch { throw new Error(`--commit ${commit}: not a commit in ${repo}`); }
    const sha = lastChange(repo, asked, INPUT_PATHS);
    if (!sha) throw new Error(`--commit ${commit}: no commit at or before it changed ${INPUT_PATHS.join(', ')}`);
    const root = archive(repo, sha, paths);
    return {
      root, landingCommit: sha, generated: commitDate(repo, sha),
      from: `commit ${asked.slice(0, 9)}${asked === sha ? '' : ` (last input change ${sha.slice(0, 9)})`}`,
      cleanup: () => rmSync(root, { recursive: true, force: true }),
    };
  }
  const dirtyRules = git(repo, ['status', '--porcelain', '--', ...RULE_PATHS]);
  if (dirtyRules) throw new Error(`rule paths differ from HEAD; commit them first (--allow-dirty never covers these):\n${dirtyRules.split('\n').slice(0, 10).join('\n')}`);
  const dirty = git(repo, ['status', '--porcelain', '--', ...INPUT_PATHS]);
  if (dirty && !allowDirty) throw new Error(`inputs differ from HEAD (commit them, pass --commit <rev>, or --allow-dirty):\n${dirty.split('\n').slice(0, 10).join('\n')}`);
  const sha = lastChange(repo, 'HEAD', INPUT_PATHS);
  return {
    root: repo,
    landingCommit: dirty ? `${sha}+dirty` : sha,
    generated: commitDate(repo, sha),
    from: `working tree (last input change ${sha.slice(0, 9)}${dirty ? ', dirty' : ''})`,
    cleanup: () => {},
  };
}

// The rules at the builder's committed HEAD, in a temporary directory.
export function openRules({ repo = REPO } = {}) {
  const head = git(repo, ['rev-parse', 'HEAD']);
  const root = archive(repo, head, ['tools/schools', 'tools/prices'], 'app-packs-rules-');
  return { root, rulesCommit: lastChange(repo, head, RULE_PATHS), cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

// The toolchain that made the bytes: Node's bundled zlib decides the DEFLATE
// output, and the builder's last commit decides everything else.
export function toolchain(repo = REPO) {
  let builder = null;
  try { builder = lastChange(repo, 'HEAD', BUILDER_PATHS) || null; } catch { /* not a git checkout */ }
  return { node: process.versions.node, zlib: process.versions.zlib, builderCommit: builder };
}

const importFrom = (root, rel) => import(pathToFileURL(join(root, rel)).href);

// The page's own display rules, run exactly as /check/ runs them.
// schCase: the block between "BEGIN schCase" and "END schCase", extracted the
// way tools/schools/test/display-case.test.mjs does. trustName: GIAS trust
// names in capitals, from TRUST_SMALL to the line before ukDate.
export function loadPageRules(root) {
  const page = readFileSync(join(root, 'check', 'index.html'), 'utf8');
  const a = page.indexOf('// ── display case (BEGIN schCase'), b = page.indexOf('// ── END schCase ──');
  if (!(a > 0 && b > a)) throw new Error('check/index.html: the schCase block markers were not found');
  const { schCase } = new Function(`${page.slice(a, b)}; return { schCase };`)();
  const t0 = page.indexOf('const TRUST_SMALL'), t1 = page.indexOf('const ukDate', t0);
  if (!(t0 > 0 && t1 > t0)) throw new Error('check/index.html: trustName (TRUST_SMALL … ukDate) was not found');
  const { trustName } = new Function(`${page.slice(t0, t1)}; return { trustName };`)();
  // Sentinels: if the page's rules change shape, fail rather than pack wrong text.
  const want = [[trustName('HARRIS FEDERATION'), 'Harris Federation'], [trustName('Brook Learning Trust'), 'Brook Learning Trust'],
    [schCase('PS 11 PURVIS J BEHAN', 'en'), 'PS 11 Purvis J Behan'], [schCase('PLANTEL CONALEP 224. GUSTAVO A MADERO II', 'es'), 'Plantel CONALEP 224. Gustavo A Madero II'],
    [schCase('HARRIS FEDERATION', undefined), 'HARRIS FEDERATION']];
  for (const [got, w] of want) if (got !== w) throw new Error(`check/index.html display rules: got "${got}", want "${w}"`);
  return { schCase, trustName };
}

// Two copies of tools/schools/licence.mjs (the data commit's and HEAD's) ->
// one rule: a scheme is licensed only if BOTH license it, for the same
// jurisdiction. Entries are HEAD's. This is the only place the two meet; the
// allow-list itself is never written down anywhere but licence.mjs (W12).
export function combineLicences(data, head) {
  const LICENSED = {};
  for (const [s, h] of Object.entries(head.LICENSED_RATINGS)) {
    const d = data.LICENSED_RATINGS[s];
    if (d && head.ratingLicensed(s) && data.ratingLicensed(s) && d.juris === h.juris) LICENSED[s] = h;
  }
  Object.freeze(LICENSED);
  return { LICENSED, licensed: Object.keys(LICENSED), ratingLicensed: s => Object.hasOwn(LICENSED, s) };
}

const both = (a, b) => a.filter(x => b.includes(x));

// The schools rules. root: the data (source modules: their own schemes and
// defaultScheme); rulesRoot: the builder's HEAD (defaults to root, which is
// what the tests use on a clean working tree).
export async function loadSchoolsRules(root, rulesRoot = root) {
  const at = async r => {
    const { loadSources, loadRatings } = await importFrom(r, 'tools/schools/lib/modules.mjs');
    const [licence, { FILTERS }, { FIELDS }] = await Promise.all([importFrom(r, 'tools/schools/licence.mjs'), importFrom(r, 'tools/schools/filters.mjs'), importFrom(r, 'tools/schools/lib/schema.mjs')]);
    return { sources: await loadSources(), ratings: await loadRatings(), licence, FILTERS, FIELDS };
  };
  const data = await at(root), head = rulesRoot === root ? data : await at(rulesRoot);
  const lic = combineLicences(data.licence, head.licence);
  const headRatings = new Map(head.ratings.map(r => [r.scheme, r]));
  return {
    sources: data.sources,
    sourceIds: both(data.sources.map(s => s.id), head.sources.map(s => s.id)),
    // Every state ratings module either side knows: values under any of them
    // are republished state data, licensed or not.
    ratingSchemes: [...new Set([...data.ratings, ...head.ratings].map(r => r.scheme))],
    // Each source's own schemes (a row may sit on these, or on a licensed one).
    ownSchemes: Object.fromEntries(data.sources.map(s => [s.id, Object.keys(s.schemes || {})])),
    ...lic,
    // HEAD's record of a licensed scheme (its licenceUrl fills a published
    // scheme that lacks one).
    licensedRecords: Object.fromEntries(lic.licensed.map(s => [s, headRatings.get(s)?.record || null])),
    FILTERS: head.FILTERS,
    FIELDS: head.FIELDS,
  };
}

// The home-values rules: the source modules both sides load (tools/prices/
// sources; the parked directory is never loaded) and HEAD's row contract.
export async function loadPricesRules(root, rulesRoot = root) {
  const at = async r => {
    const { loadSources, FIELDS, CONTEXT_KEYS } = await importFrom(r, 'tools/prices/lib/schema.mjs');
    return { ids: (await loadSources()).map(s => s.id), FIELDS, CONTEXT_KEYS };
  };
  const data = await at(root), head = rulesRoot === root ? data : await at(rulesRoot);
  return { sourceIds: both(data.ids, head.ids), FIELDS: head.FIELDS, CONTEXT_KEYS: head.CONTEXT_KEYS };
}
