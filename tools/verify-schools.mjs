// Prove the school tiles are complete, well-formed, in scope, honest about
// ratings, and that the pins are where they claim to be. Gates the commit: any
// FAIL exits 1.
//
// Every check here fails SILENTLY if nobody looks — a tile set that loads and
// looks plausible can still be missing a cell, hold a school outside its city,
// or put every pin 100m out in a consistent direction.
//
// 1. COMPLETENESS. Every leaf index.json lists exists; no stray tile files;
//    leaves never overlap (a split cell's parent is gone); every row lies inside
//    its own leaf; rows add up to index.count, per source to
//    index.sources[s].rows and per region to index.regions[r].count.
// 2. DRIFT. Each source's row count is within ±5% of the previous build's
//    (git HEAD's index.json, or --prev), unless --refresh <src> announced a new
//    vintage. Catches a partial pull or a schema change that silently empties a
//    source.
// 3. SCOPE (R2). Every row sits inside a region rectangle whose home
//    jurisdictions include the row's own; the regions' rectangles are still the
//    ones in tools/data/coverage.json.
// 4. SCHEMA AND HONESTY INVARIANTS. stage is one of the three stages or '';
//    sector state|private; (src, id) unique; every rating scheme is defined; a
//    scheme's rv is in its allowed values; NO private school carries a rating
//    value; a value appears only under its own source's scheme or a rating map
//    that tools/schools/licence.mjs licenses; gender/boarding/charter only
//    where the source declares it publishes them; mealsKind set exactly when
//    meals is; no religion-type field exists; every source carries a licence
//    and an attribution, and a link to the licence that /check/ renders; plus
//    each source's own offline invariants (sources/<id>.mjs invariants(rows):
//    NI, no ETI report left unlinked).
// 5. SIZE. No tile over 50KB gzipped; no leaf over the split threshold unless it
//    is already at the minimum cell size.
// 6. POSITION, per jurisdiction, against an independent reference that each
//    source module plugs in (its verify() hook): England and Wales against
//    postcodes.io postcode centroids. A jurisdiction with no reference is a WARN.
//    A reference that cannot be reached FAILS, unless --reference-optional
//    (the monthly workflow): a datacenter IP a reference host refuses is not a
//    fault in the data, and must not block every refresh; it is then a WARN.
//
// Usage: node tools/verify-schools.mjs [--tiles <dir>] [--prev <index.json>]
//                                      [--refresh <src,...>] [--no-position]
//                                      [--reference-optional]

import { readFileSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { gzipSync } from 'node:zlib';
import { FIELDS, STAGES, SECTORS, MEALS_KINDS, FORBIDDEN_FIELD, fromRow } from './schools/lib/schema.mjs';
import { parseKey, orphanTiles } from './schools/lib/tiles.mjs';
import { loadSources, schemeProblems } from './schools/lib/modules.mjs';
import { inBox, COVERAGE_PATH } from './schools/lib/coverage.mjs';
import { FILTERS } from './schools/filters.mjs';
import { LICENSED_RATINGS, ratingLicensed } from './schools/licence.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const arg = (n, d) => (argv.includes(n) ? argv[argv.indexOf(n) + 1] : d);
const TILE_DIR = resolve(arg('--tiles', join(ROOT, 'schools', 'data', 'tiles')));
const REFRESH = new Set((arg('--refresh', '') || '').split(',').filter(Boolean));
const POSITION = !argv.includes('--no-position');
const REF_OPTIONAL = argv.includes('--reference-optional');
const MAX_TILE_GZ = 50 * 1024;
const DRIFT = 0.05;

const results = [];
const pass = (name, msg) => results.push({ lvl: 'PASS', name, msg });
const fail = (name, msg) => results.push({ lvl: 'FAIL', name, msg });
const warnR = (name, msg) => results.push({ lvl: 'WARN', name, msg });
const check = (name, problems, okMsg, max = 5) => (problems.length
  ? fail(name, `${problems.length} problem(s): ${problems.slice(0, max).join(' | ')}`)
  : pass(name, okMsg));
const fmt = n => n.toLocaleString('en-GB');

function haversine(lat1, lng1, lat2, lng2) {
  const R = 6371000, rad = x => x * Math.PI / 180;
  const dLat = rad(lat2 - lat1), dLng = rad(lng2 - lng1);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

function previousIndex() {
  const p = arg('--prev');
  if (p) return JSON.parse(readFileSync(p, 'utf8'));
  try {
    const rel = TILE_DIR.startsWith(ROOT + '/') ? TILE_DIR.slice(ROOT.length + 1) : null;
    if (!rel) return null;
    return JSON.parse(execFileSync('git', ['-C', ROOT, 'show', `HEAD:${rel}/index.json`], { encoding: 'utf8', maxBuffer: 64e6, stdio: ['ignore', 'pipe', 'ignore'] }));
  } catch { return null; }
}

const run = async () => {
  const index = JSON.parse(readFileSync(join(TILE_DIR, 'index.json'), 'utf8'));
  if (index.version !== 2) throw new Error(`index.json is version ${index.version ?? 1}; this verifier reads v2`);

  // ── schema of the index itself ───────────────────────────────────────────
  check('fields', [
    ...(JSON.stringify(index.fields) !== JSON.stringify(FIELDS) ? ['index.fields differs from lib/schema.mjs FIELDS'] : []),
    ...index.fields.filter(f => FORBIDDEN_FIELD.test(f)).map(f => `forbidden field "${f}"`),
  ], `${index.fields.length} fields, as lib/schema.mjs; no religion-type field`);

  // ── 1. completeness ──────────────────────────────────────────────────────
  const leafSet = new Set(index.cells);
  const missing = index.cells.filter(k => !existsSync(join(TILE_DIR, `${k}.json`)));
  const orphans = orphanTiles(TILE_DIR, index);
  const overlaps = [];
  for (const k of index.cells) {
    const { level, y, x } = parseKey(k, index.base);
    for (let l = 0; l < level; l++) {
      const d = 2 ** (level - l), anc = 'q'.repeat(l) + `${Math.floor(y / d)}_${Math.floor(x / d)}`;
      if (leafSet.has(anc)) overlaps.push(`${k} inside ${anc}`);
    }
  }
  check('tiles exist', missing.map(k => `${k}.json missing`), `${index.cells.length} leaves listed, all present`);
  check('no stray tiles', orphans, 'no tile file on disk that index.json does not list');
  check('leaves disjoint', overlaps, 'no leaf is inside another (split parents are gone)');

  const rows = [], sizes = [], outside = [], overfull = [];
  const maxLevel = Math.round(Math.log2(index.base / index.split.minCell));
  for (const k of index.cells) {
    if (missing.includes(k)) continue;
    const text = readFileSync(join(TILE_DIR, `${k}.json`), 'utf8');
    const list = JSON.parse(text);
    const { level, bounds: [s, w, n, e] } = parseKey(k, index.base);
    sizes.push({ k, rows: list.length, level, gz: gzipSync(Buffer.from(text)).length, raw: text.length });
    if (list.length > index.split.maxRows && level < maxLevel) overfull.push(`${k} has ${list.length} rows`);
    for (const r of list) {
      const o = fromRow(r, index.fields);
      if (!(o.lat >= s && o.lat < n && o.lng >= w && o.lng < e)) outside.push(`${o.src}:${o.id} not inside ${k}`);
      rows.push(o);
    }
  }
  check('rows in their leaf', outside, `every row lies inside its own leaf's cell`);
  check('split threshold', overfull, `no leaf above ${index.split.maxRows} rows unless at the ${index.split.minCell}° minimum`);
  check('count', rows.length === index.count ? [] : [`tiles hold ${rows.length}, index.count says ${index.count}`], `${fmt(rows.length)} rows = index.count`);

  const bySrc = {}, byReg = {};
  for (const o of rows) bySrc[o.src] = (bySrc[o.src] || 0) + 1;
  check('per-source counts', [
    ...Object.keys(bySrc).filter(s => !index.sources[s]).map(s => `rows from "${s}", which index.sources does not describe`),
    ...Object.entries(index.sources).filter(([s, m]) => m.rows !== (bySrc[s] || 0)).map(([s, m]) => `${s}: index says ${m.rows}, tiles hold ${bySrc[s] || 0}`),
  ], Object.entries(bySrc).map(([s, n]) => `${s} ${fmt(n)}`).join(', '));

  // ── 2. drift ─────────────────────────────────────────────────────────────
  const prev = previousIndex();
  if (!prev) warnR('drift', 'no previous index.json (not in git HEAD and no --prev) — drift not checked');
  else {
    const prevRows = prev.version === 2 ? Object.fromEntries(Object.entries(prev.sources).map(([s, m]) => [s, m.rows]))
      : { gias: prev.count };   // v1 index: England & Wales only, all from GIAS
    const drift = [];
    for (const [s, m] of Object.entries(index.sources)) {
      const p = prevRows[s];
      if (p == null) continue;
      const d = (m.rows - p) / p;
      if (Math.abs(d) > DRIFT && !REFRESH.has(s)) drift.push(`${s}: ${fmt(p)} -> ${fmt(m.rows)} (${(100 * d).toFixed(1)}%)`);
    }
    for (const s of Object.keys(prevRows)) if (!index.sources[s]) drift.push(`${s}: ${fmt(prevRows[s])} rows last build, absent now`);
    check('drift', drift, `every source within ±${DRIFT * 100}% of the previous build (v${prev.version || 1})` +
      (Object.keys(index.sources).some(s => prevRows[s] == null) ? `; new: ${Object.keys(index.sources).filter(s => prevRows[s] == null).join(', ')}` : ''));
  }

  // ── 3. scope (R2) ────────────────────────────────────────────────────────
  const cov = existsSync(COVERAGE_PATH) ? JSON.parse(readFileSync(COVERAGE_PATH, 'utf8')) : null;
  const covBox = new Map((cov?.regions || []).map(r => [r.id, JSON.stringify(r.bbox)]));
  check('regions = coverage.json', index.regions.filter(r => covBox.get(r.id) !== JSON.stringify(r.bbox)).map(r => `${r.id} bbox ${JSON.stringify(r.bbox)} vs coverage ${covBox.get(r.id) ?? 'absent'}`),
    `${index.regions.length} region rectangle(s) match tools/data/coverage.json`);
  const scope = [];
  for (const o of rows) {
    const reg = index.regions.find(r => inBox(r.bbox, o.lat, o.lng) && r.juris.includes(o.juris));
    if (!reg) scope.push(`${o.src}:${o.id} (${o.juris}) at ${o.lat},${o.lng}`);
    else byReg[reg.id] = (byReg[reg.id] || 0) + 1;
  }
  check('scope R2', scope, 'every row is inside a region rectangle whose home jurisdictions include its own');
  check('per-region counts', index.regions.filter(r => r.count !== (byReg[r.id] || 0)).map(r => `${r.id}: index ${r.count}, rows ${byReg[r.id] || 0}`),
    index.regions.map(r => `${r.id} ${fmt(r.count)}`).join(', '));

  // ── 4. schema and honesty invariants ─────────────────────────────────────
  const seen = new Set(), dupes = [], bad = [], ratings = [], pub = [], meals = [];
  const publishes = s => new Set(index.sources[s]?.publishes || []);
  for (const o of rows) {
    const key = `${o.src}:${o.id}`;
    if (seen.has(key)) dupes.push(key); seen.add(key);
    if (typeof o.id !== 'string' || !o.id) bad.push(`${key}: id not a string`);
    if (o.stage !== '' && !STAGES.includes(o.stage)) bad.push(`${key}: stage "${o.stage}"`);
    if (!SECTORS.includes(o.sector)) bad.push(`${key}: sector "${o.sector}"`);
    if (!index.juris[o.juris]) bad.push(`${key}: juris "${o.juris}" not in index.juris`);
    if (!Number.isFinite(o.lat) || !Number.isFinite(o.lng) || +o.lat.toFixed(5) !== o.lat || +o.lng.toFixed(5) !== o.lng) bad.push(`${key}: lat/lng not 5-dp numbers`);
    const sc = index.schemes[o.ratingScheme];
    if (!sc) ratings.push(`${key}: scheme "${o.ratingScheme}" undefined`);
    else if (o.rv && sc.values && !sc.values.includes(o.rv)) ratings.push(`${key}: rv "${o.rv}" not allowed by ${o.ratingScheme}`);
    if (o.rv && (!sc || !['rating', 'status'].includes(sc.kind))) ratings.push(`${key}: rv set under a ${sc?.kind} scheme`);
    if (o.sector === 'private' && o.rv) ratings.push(`${key}: a PRIVATE school carries a rating value`);
    const p = publishes(o.src);
    if (o.gender && !p.has('gender')) pub.push(`${key}: gender set, but ${o.src} does not publish gender`);
    if (o.boarding && !p.has('boarding')) pub.push(`${key}: boarding set, but ${o.src} does not publish boarding`);
    for (const t of (o.tags || '').split(' ').filter(Boolean)) {
      const f = Object.entries(FILTERS).find(([, d]) => d.tag === t);
      if (f && !p.has(f[0])) pub.push(`${key}: tag "${t}" is a filter ${o.src} does not declare`);
    }
    if ((o.meals != null) !== !!o.mealsKind || (o.mealsKind && !MEALS_KINDS.includes(o.mealsKind))) meals.push(`${key}: meals ${o.meals} / mealsKind "${o.mealsKind}"`);
  }
  check('unique ids', dupes, '(src, id) unique across all rows');
  check('row values', bad, 'stage, sector, juris and coordinates well-formed on every row');
  check('ratings', ratings, 'every scheme defined; values allowed; no private school carries a rating');
  // THE LICENCE RULE (tools/schools/licence.mjs). A value is published only
  // under a scheme its row's own source defines (that source's own data, under
  // its meta.licence: NI's ETI outcomes) or under a rating map whose values are
  // licensed for reuse. Anything else is a state's data we have no licence to republish.
  {
    const own = new Map((await loadSources()).map(m => [m.id, new Set(Object.keys(m.schemes || {}))]));
    const by = {};
    for (const o of rows) if (o.rv && !own.get(o.src)?.has(o.ratingScheme) && !ratingLicensed(o.ratingScheme)) by[o.ratingScheme] = (by[o.ratingScheme] || 0) + 1;
    check('rating licence', Object.entries(by).map(([id, n]) => `${fmt(n)} value(s) under ${id}, which tools/schools/licence.mjs does not license`),
      `values only under their source's own schemes or a licensed rating map (${Object.keys(LICENSED_RATINGS).join(', ')})`);
  }
  check('published fields', pub, 'gender, boarding and filter tags only where the source declares them');
  check('meals', meals, 'mealsKind set exactly when meals is');
  const schemeProbs = Object.entries(index.schemes).flatMap(([id, s]) => schemeProblems(id, s));
  const unusedSchemes = Object.keys(index.schemes).filter(id => !rows.some(o => o.ratingScheme === id));
  check('schemes', [...schemeProbs, ...unusedSchemes.map(id => `scheme ${id} defined but unused`)], `${Object.keys(index.schemes).length} scheme records well-formed and all in use`);
  check('attribution', Object.entries(index.sources).filter(([, m]) => !m.licence || !m.attribution).map(([s]) => `${s} has no licence or attribution`),
    'every source carries a licence and an attribution line');
  check('filters', index.filters.flatMap(f => f.publishedBy.filter(s => !index.sources[s]).map(s => `${f.id} published by absent ${s}`)),
    `${index.filters.map(f => `${f.id} (${f.where})`).join(', ') || 'none'}`);
  // Licences are LINKED, not just named: CC BY 4.0 requires a link to the
  // licence, and the OGLs ask for one where possible. Every source and every
  // scheme that names a licence needs a licenceUrl, and /check/ must render
  // them (its sources list reads licenceUrl).
  {
    const page = readFileSync(join(ROOT, 'check', 'index.html'), 'utf8');
    const probs = [
      ...Object.entries(index.sources).filter(([, m]) => !/^https:\/\//.test(m.licenceUrl || '')).map(([s]) => `source ${s} has no https licenceUrl`),
      ...Object.entries(index.schemes).filter(([, sc]) => /CC BY|Open Government Licence/i.test(`${sc.licence || ''} ${sc.attribution || ''}`) && !/^https:\/\//.test(sc.licenceUrl || '')).map(([id]) => `scheme ${id} names an open licence but has no licenceUrl`),
      ...(/\.licenceUrl\b/.test(page) ? [] : ['check/index.html never reads a licenceUrl']),
    ];
    // (tools/audit-viewports.mjs opens the sources list in a browser and checks each link is there.)
    check('licence links', probs, `${Object.keys(index.sources).length} sources and ${Object.values(index.schemes).filter(sc => sc.licenceUrl).length} scheme(s) carry a licence link; /check/ reads them`);
  }
  // Offline checks a source plugs in (sources/<id>.mjs invariants(rows)).
  for (const mod of await loadSources()) {
    if (!mod.invariants || !index.sources[mod.id]) continue;
    for (const c of mod.invariants(rows.filter(o => o.src === mod.id))) check(c.name, c.problems, c.ok);
  }

  // ── 5. size ──────────────────────────────────────────────────────────────
  sizes.sort((a, b) => b.gz - a.gz);
  const byLevel = sizes.reduce((a, t) => (a[t.level] = (a[t.level] || 0) + 1, a), {});
  const med = [...sizes].sort((a, b) => a.gz - b.gz)[Math.floor(sizes.length / 2)];
  check('tile size', sizes.filter(t => t.gz > MAX_TILE_GZ).map(t => `${t.k} ${(t.gz / 1024).toFixed(1)}KB`),
    `${sizes.length} tiles (${Object.entries(byLevel).map(([l, n]) => `${n} @${index.base / 2 ** l}°`).join(', ')}); ` +
    `median ${(med.gz / 1024).toFixed(1)}KB, worst ${(sizes[0].gz / 1024).toFixed(1)}KB gzipped (${sizes[0].k}, ${sizes[0].rows} rows); ` +
    `total ${(sizes.reduce((a, t) => a + t.gz, 0) / 1e6).toFixed(2)}MB gz, limit ${MAX_TILE_GZ / 1024}KB a tile`);

  // ── 6. position, per jurisdiction, via each source's reference ───────────
  if (!POSITION) warnR('position', 'skipped (--no-position)');
  else {
    const sources = await loadSources();
    const covered = new Set();
    for (const [s] of Object.entries(index.sources)) {
      const mod = sources.find(m => m.id === s);
      if (!mod?.verify) continue;
      const mine = rows.filter(o => o.src === s);
      try {
        for (const c of await mod.verify(mine, { haversine, log: console.log })) {
          covered.add(c.juris);
          (c.pass ? pass : fail)(`position ${c.juris} ${s}`, `${c.message}${c.reference ? ` [vs ${c.reference}]` : ''}`);
        }
      } catch (e) { (REF_OPTIONAL ? warnR : fail)(`position ${s}`, `reference check failed to run: ${e.message}`); }
    }
    for (const j of Object.keys(index.juris)) if (!covered.has(j)) warnR(`position ${j}`, 'no independent position reference plugged in for this jurisdiction');
  }

  // ── report ───────────────────────────────────────────────────────────────
  for (const r of results) console.log(`  ${r.lvl.padEnd(4)}  ${r.name.padEnd(20)} ${r.msg}`);
  const fails = results.filter(r => r.lvl === 'FAIL').length, warns = results.filter(r => r.lvl === 'WARN').length;
  console.log(`\n  ${fails ? 'FAIL' : 'PASS'} — ${results.length - fails - warns} passed, ${fails} failed, ${warns} warning(s); ${fmt(rows.length)} schools, ${index.where}.`);
  if (fails) process.exit(1);
};

run().catch(e => { console.error('verify-schools failed:', e.message); process.exit(1); });
