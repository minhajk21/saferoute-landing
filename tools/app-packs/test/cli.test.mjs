// node --test tools/app-packs/test/*.test.mjs
// The builder's guard rails: where it may write (never a served path, in any
// checkout of this repository, however the path is spelled), which landing
// it reads (dirty data refused, dirty rules refused even with --allow-dirty,
// --commit resolved to the last input change, git failures reported), and a
// CLI that refuses what it does not understand instead of building something
// else. The landing tests use a small throwaway git repository.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, symlinkSync, realpathSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { REPO, openLanding, INPUT_PATHS } from '../lib/landing.mjs';
import { outProblem, removeStale } from '../lib/build.mjs';

const CLI = join(REPO, 'tools', 'build-app-packs.mjs');
const cli = (...args) => spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', maxBuffer: 1 << 26 });
const tmp = p => realpathSync(mkdtempSync(join(tmpdir(), p)));
const rm = (...d) => d.forEach(x => rmSync(x, { recursive: true, force: true }));

// ── where packs may go ──────────────────────────────────────────────────────
test('outProblem: inside the repo only out/ is allowed; outside it anything', () => {
  assert.equal(outProblem(join(REPO, 'out', 'app-packs')), null);
  assert.equal(outProblem(join(REPO, 'out')), null);
  assert.equal(outProblem(join(REPO, 'out', 'a', 'b', 'not-yet')), null);
  const t = tmp('packs-out-');
  try { assert.equal(outProblem(join(t, 'packs')), null); } finally { rm(t); }
  for (const p of ['schools/data/tiles', 'prices/data', 'schools', 'tools', 'outside-out', 'check/packs', '.']) {
    assert.match(outProblem(join(REPO, p)) || '', /served site/, p);
  }
  const gitDir = execFileSync('git', ['-C', REPO, 'rev-parse', '--path-format=absolute', '--git-dir'], { encoding: 'utf8' }).trim();
  assert.match(outProblem(join(gitDir, 'x')) || '', /git directory/);
});
test('outProblem: letter case, symlinks and other checkouts of this repository do not get round it', () => {
  // Another spelling of a served directory on a case-insensitive disk.
  const upper = join(REPO, 'SCHOOLS', 'data', 'tiles');
  if (existsSync(upper)) assert.match(outProblem(upper) || '', /served site/);
  // A symlink from outside into the repo.
  const t = tmp('packs-link-');
  try {
    symlinkSync(join(REPO, 'schools', 'data'), join(t, 'link'));
    assert.match(outProblem(join(t, 'link', 'tiles')) || '', /served site/);
    assert.match(outProblem(join(t, 'link', 'new-dir')) || '', /served site/);
  } finally { rm(t); }
  // Every worktree of this repository (the main checkout included).
  const trees = execFileSync('git', ['-C', REPO, 'worktree', 'list', '--porcelain'], { encoding: 'utf8' }).split('\n').filter(l => l.startsWith('worktree ')).map(l => l.slice(9));
  assert.ok(trees.length >= 1);
  for (const w of trees) if (existsSync(join(w, 'schools'))) assert.match(outProblem(join(w, 'schools', 'data', 'tiles')) || '', /served site/, w);
});

test('removeStale: a lone layer\'s pack from another landing commit is removed, the same commit\'s kept', () => {
  const t = tmp('packs-stale-');
  try {
    const put = (layer, commit) => { writeFileSync(join(t, `${layer}-pack.json`), JSON.stringify({ pack: { landingCommit: commit } })); writeFileSync(join(t, `${layer}-pack.bin`), 'x'); };
    put('schools', 'new'); put('prices', 'old');
    assert.deepEqual(removeStale(t, ['schools'], 'new').map(f => f.slice(t.length + 1)), ['prices-pack.json', 'prices-pack.bin']);
    put('prices', 'new');
    assert.deepEqual(removeStale(t, ['schools'], 'new'), []);
    assert.ok(existsSync(join(t, 'prices-pack.bin')));
  } finally { rm(t); }
});

// ── which landing is read ───────────────────────────────────────────────────
// A tiny repository with every input path, then a tooling-only commit.
function tinyRepo() {
  const r = tmp('packs-repo-');
  const g = (...a) => execFileSync('git', ['-C', r, ...a], { encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_DATE: '2026-10-05T08:42:20-04:00', GIT_COMMITTER_DATE: '2026-10-05T08:42:20-04:00' } }).trim();
  g('init', '-q'); g('config', 'user.email', 't@example.org'); g('config', 'user.name', 't'); g('config', 'commit.gpgsign', 'false');
  const put = (p, s) => { mkdirSync(dirname(join(r, p)), { recursive: true }); writeFileSync(join(r, p), s); };
  for (const p of ['schools/data/index.json', 'prices/data/index.json', 'check/index.html', 'tools/schools/licence.mjs', 'tools/schools/x.mjs', 'tools/prices/sources/a.mjs']) put(p, `${p}\n`);
  g('add', '-A'); g('commit', '-q', '-m', 'data');
  const data = g('rev-parse', 'HEAD');
  put('tools/app-packs/README.md', 'tooling\n'); g('add', '-A'); g('commit', '-q', '-m', 'tooling only');
  return { r, g, put, data, head: g('rev-parse', 'HEAD') };
}

test('openLanding: --commit records the last commit that changed an input, its date in UTC', () => {
  const { r, data, head } = tinyRepo();
  try {
    assert.notEqual(head, data);
    for (const rev of ['HEAD', head, data, 'HEAD~1']) {
      const l = openLanding({ repo: r, commit: rev });
      try {
        assert.equal(l.landingCommit, data, rev);
        assert.equal(l.generated, '2026-10-05T12:42:20Z');
        assert.ok(existsSync(join(l.root, 'schools/data/index.json')) && existsSync(join(l.root, 'check/index.html')));
      } finally { l.cleanup(); }
    }
    const w = openLanding({ repo: r });
    assert.equal(w.landingCommit, data);
    assert.equal(w.generated, '2026-10-05T12:42:20Z');
  } finally { rm(r); }
});
test('openLanding: an empty or unknown --commit, and a failing git archive, are errors', () => {
  const { r, g } = tinyRepo();
  try {
    assert.throws(() => openLanding({ repo: r, commit: '' }), /needs a revision/);
    assert.throws(() => openLanding({ repo: r, commit: 'deadbeef' }), /not a commit/);
    assert.throws(() => openLanding({ repo: r, commit: 'HEAD', allowDirty: true }), /no meaning with --commit/);
    // A commit without prices/data: the schools layer alone still builds from
    // it; asking for prices names the missing path instead of failing later.
    g('rm', '-q', '-r', 'prices/data'); g('commit', '-q', '-m', 'no prices');
    openLanding({ repo: r, commit: 'HEAD', layers: ['schools'] }).cleanup();
    assert.throws(() => openLanding({ repo: r, commit: 'HEAD', layers: ['prices'] }), /git archive .* failed: .*prices\/data/);
  } finally { rm(r); }
});
test('openLanding: dirty inputs need --allow-dirty (recorded +dirty); dirty rules are refused even with it', () => {
  const { r, put, data } = tinyRepo();
  try {
    put('schools/data/index.json', 'changed\n');
    assert.throws(() => openLanding({ repo: r }), /inputs differ from HEAD/);
    assert.equal(openLanding({ repo: r, allowDirty: true }).landingCommit, `${data}+dirty`);
    put('tools/schools/licence.mjs', 'export const LICENSED_RATINGS = { widened: {} };\n');
    assert.throws(() => openLanding({ repo: r, allowDirty: true }), /rule paths differ from HEAD/);
    put('tools/schools/licence.mjs', 'tools/schools/licence.mjs\n');
    put('tools/prices/parked/denver-sales.mjs', 'x\n');               // untracked counts too
    assert.throws(() => openLanding({ repo: r, allowDirty: true }), /rule paths differ/);
  } finally { rm(r); }
});
test('INPUT_PATHS is only what the builder reads (not tools/data, which the bot touches monthly)', () => {
  assert.ok(!INPUT_PATHS.includes('tools/data'));
});

// ── the CLI ─────────────────────────────────────────────────────────────────
test('CLI: unknown options, empty values and served paths are usage errors (exit 2), nothing is built', () => {
  const t = tmp('packs-cli-');
  try {
    for (const args of [['--comit', 'HEAD'], ['--commit='], ['--commit', ''], ['--out'], ['--layer', 'roads'], ['--commit', 'HEAD', '--allow-dirty'], ['stray'],
      // A served --out. The bad --commit makes sure that, were the guard ever
      // broken, the build would still fail before writing into the site.
      ['--out', join(REPO, 'schools', 'data'), '--commit', 'deadbeef']]) {
      const r = cli('--out', join(t, 'x'), ...args);
      assert.equal(r.status, 2, `${args.join(' ')}: ${r.stderr}`);
      assert.ok(!existsSync(join(t, 'x')), args.join(' '));
    }
    const bad = cli('--out', join(t, 'x'), '--commit', 'deadbeef');
    assert.equal(bad.status, 1);
    assert.match(bad.stderr, /not a commit/);
  } finally { rm(t); }
});
test('CLI: run through a symlinked path it still builds (it used to exit 0 having done nothing)', () => {
  const t = tmp('packs-sym-');
  try {
    symlinkSync(REPO, join(t, 'repo'));
    const r = spawnSync(process.execPath, [join(t, 'repo', 'tools', 'build-app-packs.mjs'), '--layer', 'schools', '--commit', 'HEAD', '--out', join(t, 'out'), '--json'], { encoding: 'utf8', maxBuffer: 1 << 26 });
    assert.equal(r.status, 0, r.stderr);
    assert.ok(existsSync(join(t, 'out', 'schools-pack.bin')));
    assert.equal(JSON.parse(readFileSync(join(t, 'out', 'schools-pack.json'), 'utf8')).pack.layer, 'schools');
  } finally { rm(t); }
});
