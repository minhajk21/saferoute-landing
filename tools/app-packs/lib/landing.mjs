// Where the packs' inputs come from: the VERIFIED published data, the page's
// own display rules and the source modules, all at one landing commit.
//
// Two ways to pin it:
//   --commit <rev>  the files are taken from that commit (git archive into a
//                   temporary directory), whatever the working tree holds. This
//                   is what O2 (tools/import-overlay-packs.mjs) uses.
//   (default)       the working tree of the repo, which must match HEAD for
//                   every input path (--allow-dirty overrides, and the
//                   commit is then recorded with "+dirty"). The commit recorded
//                   is the last one that changed an input, so a later commit
//                   that touches only tooling gives byte-identical packs.

import { execFileSync, execSync } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

// Everything a pack is made from.
export const INPUT_PATHS = ['schools/data', 'prices/data', 'check/index.html', 'tools/schools', 'tools/prices', 'tools/data'];

const git = (repo, args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', maxBuffer: 1 << 26 }).trim();

export function openLanding({ repo = REPO, commit = null, allowDirty = false } = {}) {
  if (commit) {
    const sha = git(repo, ['rev-parse', '--verify', `${commit}^{commit}`]);
    const root = mkdtempSync(join(tmpdir(), 'app-packs-'));
    execSync(`git -C '${repo}' archive --format=tar ${sha} -- ${INPUT_PATHS.join(' ')} | tar -x -C '${root}'`, { stdio: ['ignore', 'ignore', 'inherit'], maxBuffer: 1 << 26 });
    return { root, landingCommit: sha, generated: git(repo, ['show', '-s', '--format=%cI', sha]), from: `commit ${sha}`, cleanup: () => rmSync(root, { recursive: true, force: true }) };
  }
  const dirty = git(repo, ['status', '--porcelain', '--', ...INPUT_PATHS]);
  if (dirty && !allowDirty) throw new Error(`inputs differ from HEAD (commit them, pass --commit <rev>, or --allow-dirty):\n${dirty.split('\n').slice(0, 10).join('\n')}`);
  const sha = git(repo, ['log', '-1', '--format=%H', 'HEAD', '--', ...INPUT_PATHS]);
  return {
    root: repo,
    landingCommit: dirty ? `${sha}+dirty` : sha,
    generated: git(repo, ['show', '-s', '--format=%cI', sha]),
    from: `working tree (last input change ${sha.slice(0, 9)})`,
    cleanup: () => {},
  };
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

// The schools source modules, the state ratings modules, and the licence
// allow-list (tools/schools/licence.mjs: the single source of truth, W12).
export async function loadSchoolsRules(root) {
  const { loadSources, loadRatings } = await importFrom(root, 'tools/schools/lib/modules.mjs');
  const licence = await importFrom(root, 'tools/schools/licence.mjs');
  const sources = await loadSources(), ratings = await loadRatings();
  return {
    sources,
    sourceIds: sources.map(s => s.id),
    ratingSchemes: ratings.map(r => r.scheme),
    ratingLicensed: licence.ratingLicensed,
    licensed: Object.keys(licence.LICENSED_RATINGS),
  };
}

// The home-values source modules the build loads (tools/prices/sources; the
// parked directory is never loaded).
export async function loadPricesRules(root) {
  const { loadSources } = await importFrom(root, 'tools/prices/lib/schema.mjs');
  const sources = await loadSources();
  return { sourceIds: sources.map(s => s.id) };
}
