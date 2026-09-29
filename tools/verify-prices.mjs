// Prove the home-prices tiles are complete, well-formed, in scope and honest.
// Gates the commit: any FAIL exits 1.
//
// Every check here fails SILENTLY if nobody looks: a tile set that loads and
// looks plausible can still miss the leaf a big tract crosses into, colour an
// area built on seven sales, or put a New Jersey tract on New York's scale.
//
// 1. STRUCTURE. index.fields is the contract's; every leaf index.json lists
//    exists and there are no strays; leaves never overlap; every row's indices
//    resolve; every area is in EVERY leaf its bbox touches (the page loads only
//    the leaves in view), each copy identical; the split thresholds hold.
// 2. HONESTY. No value <= 0. Suppressed = no value. Nothing neutral is
//    coloured: an area under its source's colourMinN, or with a margin of
//    error above CV 0.30, carries the flag that makes it neutral. Every source
//    carries licence (+ https link), attribution, metric, period, currency and
//    unit noun, and its metric never says average/mean or calls an owners'
//    estimate a price. Each scale has one source and one currency, 4 strictly
//    increasing breaks, and those breaks are what its own areas give. No
//    address, postcode, paon, saon or street field anywhere. No price value
//    for a region whose decision is none (Mexico City), and it is listed
//    under `missing`.
// 3. SCOPE (R2). Every area's jurisdiction is one of its region's home
//    jurisdictions, its extent reaches the region's rectangle, and the
//    rectangles are still tools/data/coverage.json's.
// 4. DRIFT vs git HEAD (or --prev): areas per source and per city within
//    ±10%, and each scale's median within ±15%, unless --refresh names the
//    source. What --refresh never excuses: a source, a city's areas from a
//    source, or a colour scale that the previous build had and this one has
//    lost while tools/prices/regions.mjs still gives it (a swapped lng/lat
//    empties England and Wales without a single error otherwise).
// 5. SIZE. FAIL above 60 KB gzipped a tile; WARN above 30 KB.
// 6. SPOT CHECKS against what is known to be true (Southwark has 30+ MSOAs;
//    London's median of MSOA medians is £400k–£900k; NYC has 1,500+ tracts;
//    Toronto 400+ CTs). Each prints what it saw, and a source missing from the
//    build fails its check. --no-spot skips them (tests).
// 7. BANDS (warning only): each scale's five colour bands hold between 5% and
//    45% of its coloured areas; tied or bunched values can make quintile
//    breaks that leave a band all but empty.
//
// Usage: node tools/verify-prices.mjs [--dir <prices/data>] [--prev <index.json>]
//                                     [--refresh <src,...|all>] [--reference-optional] [--no-spot]
//   --reference-optional  accepted for the workflow's sake: phase 1 has no
//                         network position reference, so nothing to relax yet

import { readFileSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { gzipSync } from 'node:zlib';
import { FIELDS, FORBIDDEN_FIELD, FORBIDDEN_IN_TEXT, MAX_CV, INDEX_VERSION, metaProblems, isColoured, isUnpublished } from './prices/lib/schema.mjs';
import { parseKey, orphanTiles, areasFromTile, cellsForBbox } from './prices/lib/tiles.mjs';
import { bboxOfEncoded, bboxIntersects } from './prices/lib/geo.mjs';
import { computeBreaks, increasing, classOf } from './prices/lib/scale.mjs';
import { PRICE_REGIONS, scalesFor } from './prices/regions.mjs';
import { REGIONS as SCHOOL_REGIONS } from './schools/regions.mjs';
import { COVERAGE_PATH } from './schools/lib/coverage.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const arg = (n, d) => (argv.includes(n) ? argv[argv.indexOf(n) + 1] : d);
const DIR = resolve(arg('--dir', join(ROOT, 'prices', 'data')));
const REFRESH = new Set((arg('--refresh', '') || '').split(',').map(s => s.trim()).filter(Boolean));
const SPOT = !argv.includes('--no-spot');
const MAX_TILE_GZ = 60 * 1024, WARN_TILE_GZ = 30 * 1024;
const DRIFT_AREAS = 0.10, DRIFT_MEDIAN = 0.15;

const results = [];
const pass = (name, msg) => results.push({ lvl: 'PASS', name, msg });
const fail = (name, msg) => results.push({ lvl: 'FAIL', name, msg });
const warnR = (name, msg) => results.push({ lvl: 'WARN', name, msg });
const check = (name, problems, okMsg, max = 5) => (problems.length
  ? fail(name, `${problems.length} problem(s): ${problems.slice(0, max).join(' | ')}`)
  : pass(name, okMsg));
const fmt = n => (typeof n === 'number' ? n.toLocaleString('en-GB') : String(n));
const refreshed = s => REFRESH.has(s) || REFRESH.has('all');

function previousIndex() {
  const p = arg('--prev');
  if (p) return JSON.parse(readFileSync(p, 'utf8'));
  try {
    const rel = DIR.startsWith(ROOT + '/') ? DIR.slice(ROOT.length + 1) : null;
    if (!rel) return null;
    return JSON.parse(execFileSync('git', ['-C', ROOT, 'show', `HEAD:${rel}/index.json`], { encoding: 'utf8', maxBuffer: 64e6, stdio: ['ignore', 'pipe', 'ignore'] }));
  } catch { return null; }
}

const median = xs => { const s = [...xs].sort((a, b) => a - b); return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : NaN; };

const run = async () => {
  const index = JSON.parse(readFileSync(join(DIR, 'index.json'), 'utf8'));
  if (index.version !== INDEX_VERSION) throw new Error(`index.json is version ${index.version}; this verifier reads v${INDEX_VERSION}`);
  const srcIds = Object.keys(index.sources);

  // ── 1. structure ─────────────────────────────────────────────────────────
  check('fields', [
    ...(JSON.stringify(index.fields) !== JSON.stringify(FIELDS) ? [`index.fields ${JSON.stringify(index.fields)} is not lib/schema.mjs FIELDS`] : []),
    ...index.fields.filter(f => FORBIDDEN_FIELD.test(f)).map(f => `forbidden field "${f}"`),
  ], `${index.fields.length} fields, as lib/schema.mjs`);

  const { base, split, cells } = index.tiles;
  const leafSet = new Set(cells);
  const missingTiles = cells.filter(k => !existsSync(join(DIR, 'tiles', `${k}.json`)));
  const overlaps = [];
  for (const k of cells) {
    const { level, y, x } = parseKey(k, base);
    for (let l = 0; l < level; l++) {
      const d = 2 ** (level - l), anc = 'q'.repeat(l) + `${Math.floor(y / d)}_${Math.floor(x / d)}`;
      if (leafSet.has(anc)) overlaps.push(`${k} inside ${anc}`);
    }
  }
  check('tiles exist', missingTiles.map(k => `tiles/${k}.json missing`), `${cells.length} leaves listed, all present`);
  check('no stray tiles', orphanTiles(DIR, index), 'no tile file on disk that index.json does not list');
  check('leaves disjoint', overlaps, 'no leaf is inside another (split parents are gone)');

  const areas = new Map();          // src:id -> { a, text, leaves: Set }
  const sizes = [], refs = [], forbidden = [], overfull = [], outsideLeaf = [], copies = [];
  const maxLevel = Math.round(Math.log2(base / split.minCell));
  for (const k of cells) {
    if (missingTiles.includes(k)) continue;
    const text = readFileSync(join(DIR, 'tiles', `${k}.json`), 'utf8');
    const t = JSON.parse(text);
    const { level, bounds } = parseKey(k, base);
    const gz = gzipSync(Buffer.from(text)).length;
    sizes.push({ k, areas: t.a.length, level, gz });
    if ((t.a.length > split.maxAreas || Buffer.byteLength(text) > split.maxBytes) && level < maxLevel) overfull.push(`${k}: ${t.a.length} areas, ${Buffer.byteLength(text)} bytes`);
    if (FORBIDDEN_IN_TEXT.test(text)) forbidden.push(`${k} names a forbidden field`);
    for (const c of t.c || []) if (Object.keys(c).some(x => !['label', 'value', 'n'].includes(x))) forbidden.push(`${k}: context field(s) ${Object.keys(c).join(', ')}`);
    const parsed = areasFromTile(text, index);
    t.a.forEach((row, i) => {
      if (row.length !== FIELDS.length) { refs.push(`${k} row ${i}: ${row.length} fields`); return; }
      const [s, , , r, sc, , , , , ci] = row;
      if (!srcIds[s]) refs.push(`${k} row ${i}: src ${s}`);
      if (!index.regions[r]) refs.push(`${k} row ${i}: region ${r}`);
      if (!index.scales[sc]) refs.push(`${k} row ${i}: scale ${sc}`);
      if (ci != null && !t.c?.[ci]) refs.push(`${k} row ${i}: ctx ${ci}`);
      // A context is compared by content: its index differs from tile to tile.
      const rowText = JSON.stringify([row.slice(0, 9), ci == null ? null : t.c[ci], row[10]]);
      const a = parsed[i];
      const key = `${a.src}:${a.id}`;
      a.bbox = bboxOfEncoded(a.enc);
      if (!bboxIntersects(a.bbox, bounds)) outsideLeaf.push(`${key} does not reach ${k}`);
      const seen = areas.get(key);
      if (!seen) areas.set(key, { a, text: rowText, leaves: new Set([k]) });
      else { seen.leaves.add(k); if (seen.text !== rowText) copies.push(`${key} differs between leaves`); }
    });
  }
  check('row references', refs, 'every src, region, scale and ctx index resolves');
  check('areas reach leaf', outsideLeaf, 'every area in a leaf touches that leaf');
  check('copies identical', copies, 'an area repeated across leaves is the same row everywhere');
  // Every leaf an area's bbox touches must hold it: walk down from each 0.25°
  // cell the bbox touches to the leaves under it.
  const missed = [];
  for (const [key, { a, leaves }] of areas) {
    const want = new Set();
    const walk = (level, parent) => {
      for (const c of cellsForBbox(a.bbox, level, base, parent)) {
        if (leafSet.has(c)) want.add(c);
        else if (level < maxLevel) walk(level + 1, parseKey(c, base));
      }
    };
    walk(0, null);
    for (const k of want) if (!leaves.has(k)) missed.push(`${key} missing from ${k}`);
  }
  check('areas in every leaf', missed, `each of ${fmt(areas.size)} areas is in every leaf its bbox touches`);
  check('split threshold', overfull, `no leaf above ${split.maxAreas} areas or ${split.maxBytes} bytes unless at the ${split.minCell}° minimum`);
  check('forbidden fields', forbidden, 'no address, postcode, paon, saon or street field; contexts carry only label/value/n');

  const all = [...areas.values()].map(x => x.a);
  const coloured = isColoured;

  // ── counts ───────────────────────────────────────────────────────────────
  const bySrc = {};
  for (const a of all) (bySrc[a.src] ||= []).push(a);
  check('per-source counts', srcIds.flatMap(s => {
    const st = index.sources[s].stats || {}, l = bySrc[s] || [], c = l.filter(coloured).length, u = l.filter(isUnpublished).length;
    return st.areas === l.length && st.coloured === c && st.neutral === l.length - c && st.unpublished === u ? []
      : [`${s}: index says ${st.areas}/${st.coloured}/${st.neutral}/${st.unpublished}, tiles hold ${l.length}/${c}/${l.length - c}/${u} (areas/coloured/neutral/unpublished)`];
  }), srcIds.map(s => `${s} ${fmt((bySrc[s] || []).length)} (${fmt((bySrc[s] || []).filter(coloured).length)} coloured, ${fmt((bySrc[s] || []).filter(isUnpublished).length)} with nothing published)`).join(', ') || 'no sources');
  check('region sources', index.regions.flatMap(r => {
    const mine = all.filter(a => a.region === r.id), got = [...new Set(mine.map(a => a.src))].sort().join(',');
    return [
      ...(got === [...r.sources].sort().join(',') ? [] : [`${r.id}: index lists ${r.sources.join(',')}, tiles hold ${got || 'nothing'}`]),
      ...(r.areas === mine.length ? [] : [`${r.id}: index counts ${r.areas} areas, tiles hold ${mine.length}`]),
      // The page names a region's own jurisdictions from index.juris.
      ...r.juris.filter(j => !index.juris?.[j]?.name).map(j => `${r.id}: no name for ${j} in index.juris`),
    ];
  }), `${index.regions.length} region(s), each listing exactly the sources its areas come from, its area count, and names for its jurisdictions`);

  // ── 2. honesty ───────────────────────────────────────────────────────────
  const vals = [], neutral = [];
  for (const a of all) {
    const key = `${a.src}:${a.id}`, m = index.sources[a.src] || {};
    if (a.value != null && !(a.value > 0)) vals.push(`${key}: value ${a.value}`);
    if (a.moe != null && !(a.moe >= 0)) vals.push(`${key}: moe ${a.moe}`);
    if (a.n != null && !(Number.isInteger(a.n) && a.n >= 0)) vals.push(`${key}: n ${a.n}`);
    if (typeof a.id !== 'string' || !a.id) vals.push(`${key}: id not a string`);
    const f = new Set(a.flags);
    if (f.has('suppressed') && a.value != null) neutral.push(`${key}: suppressed but carries ${a.value}`);
    for (const x of ['uncertain', 'few', 'topcoded', 'bottomcoded']) if (f.has(x) && a.value == null) neutral.push(`${key}: ${x} without a value`);
    if (coloured(a) && [...f].some(x => x !== 'topcoded')) neutral.push(`${key}: coloured with flags ${[...f]}`);
    if (coloured(a) && m.colourMinN && a.n != null && a.n < m.colourMinN) neutral.push(`${key}: coloured on n=${a.n} (< ${m.colourMinN})`);
    const cv = a.moe != null && a.value > 0 ? a.moe / 1.645 / a.value : null;
    if (coloured(a) && cv != null && cv > MAX_CV) neutral.push(`${key}: coloured with CV ${cv.toFixed(2)}`);
  }
  check('values', vals, 'every value > 0, moe >= 0, n a whole number');
  check('nothing neutral coloured', neutral, `suppressed carry no value; under colourMinN or CV > ${MAX_CV} are neutral; coloured areas carry no neutral flag`);
  check('source meta', srcIds.flatMap(s => metaProblems(index.sources[s]).map(p => `${s}: ${p}`)),
    `${srcIds.length} source(s) carry licence + link, attribution, metric, period, currency, unit noun; metrics named honestly`);
  check('source status', srcIds.flatMap(s => ['fetched', 'snapshot', 'snapshot-after-failure'].includes(index.sources[s].status) ? [] : [`${s}: status "${index.sources[s].status}"`]),
    srcIds.map(s => `${s} ${index.sources[s].status}`).join(', ') || 'none');
  for (const s of srcIds) if (index.sources[s].status === 'snapshot-after-failure') warnR(`stale ${s}`, `its last fetch failed; showing the build of ${index.sources[s].fetched} (${index.sources[s].vintage})`);

  const scaleProbs = [];
  index.scales.forEach(sc => {
    const mine = all.filter(a => a.scale === sc.key);
    const srcs = [...new Set(mine.map(a => a.src))];
    if (srcs.length !== 1 || srcs[0] !== sc.source) scaleProbs.push(`${sc.key}: areas from ${srcs.join(',') || 'none'}, index says ${sc.source}`);
    const m = index.sources[sc.source];
    if (!m || m.currency !== sc.currency || m.metric !== sc.metric || m.period !== sc.period) scaleProbs.push(`${sc.key}: currency/metric/period differ from its source's`);
    for (const rid of new Set(mine.map(a => a.region))) {
      const r = index.regions.find(x => x.id === rid);
      if (r?.currency !== sc.currency) scaleProbs.push(`${sc.key}: region ${rid} is ${r?.currency}, scale is ${sc.currency}`);
    }
    if (new Set(mine.map(a => a.juris)).size !== 1 || !sc.juris) scaleProbs.push(`${sc.key}: juris ${sc.juris} — one scale region lies in one jurisdiction`);
    if (!Array.isArray(sc.breaks) || sc.breaks.length !== 4 || !increasing(sc.breaks) || sc.breaks.some(b => !(b > 0))) scaleProbs.push(`${sc.key}: breaks ${JSON.stringify(sc.breaks)}`);
    try {
      const b = computeBreaks(mine.filter(coloured).map(a => a.value));
      if (JSON.stringify(b.breaks) !== JSON.stringify(sc.breaks) || b.areas !== sc.areas || b.min !== sc.min || b.max !== sc.max) scaleProbs.push(`${sc.key}: its areas give breaks ${b.breaks} (${b.areas} coloured), index says ${sc.breaks} (${sc.areas})`);
    } catch (e) { scaleProbs.push(`${sc.key}: ${e.message}`); }
  });
  check('scales', scaleProbs, `${index.scales.length} scale(s): one source, one currency, 4 increasing breaks computed from their own areas`);

  const noneRegions = Object.entries(PRICE_REGIONS).filter(([, d]) => d.none).map(([id]) => id);
  check('no-data regions', noneRegions.flatMap(id => [
    ...(all.some(a => a.region === id) ? [`${id} has price areas`] : []),
    ...(index.regions.some(r => r.id === id) ? [`${id} is listed as a region`] : []),
    ...(index.missing.some(m => m.region === id && m.reason === PRICE_REGIONS[id].none) ? [] : [`${id} is not under missing with its reason`]),
  ]), `${noneRegions.join(', ') || 'none'}: no price value, listed under missing with the reason`);

  // ── 3. scope (R2) ────────────────────────────────────────────────────────
  const cov = existsSync(COVERAGE_PATH) ? JSON.parse(readFileSync(COVERAGE_PATH, 'utf8')) : { regions: [] };
  const covBox = new Map(cov.regions.map(r => [r.id, JSON.stringify(r.bbox)]));
  check('regions = coverage.json', index.regions.filter(r => covBox.get(r.id) !== JSON.stringify(r.bbox)).map(r => `${r.id} bbox ${JSON.stringify(r.bbox)} vs coverage ${covBox.get(r.id) ?? 'absent'}`),
    `${index.regions.length} region rectangle(s) match tools/data/coverage.json`);
  const scope = [];
  for (const a of all) {
    const key = `${a.src}:${a.id}`, r = index.regions.find(x => x.id === a.region);
    const home = SCHOOL_REGIONS[a.region]?.juris || [];
    if (!r) { scope.push(`${key}: region ${a.region} not in index`); continue; }
    // The row carries no juris: its scale does (one scale, one jurisdiction).
    if (!a.juris || !home.includes(a.juris) || !r.juris.includes(a.juris)) scope.push(`${key}: ${a.juris} (scale ${a.scale}) is not a home jurisdiction of ${a.region}`);
    if (!bboxIntersects(a.bbox, r.bbox)) scope.push(`${key}: does not reach ${a.region}'s rectangle`);
    if (!(PRICE_REGIONS[a.region]?.sources || []).includes(a.src)) scope.push(`${key}: ${a.region} does not take ${a.src} (regions.mjs)`);
    if (!scalesFor(a.region).includes(a.scale)) scope.push(`${key}: scale ${a.scale} not allowed in ${a.region}`);
  }
  check('scope R2', scope, 'every area is in its region’s home jurisdictions, reaches its rectangle, and is from the source regions.mjs names');
  const unlisted = cov.regions.map(r => r.id).filter(id => !index.regions.some(r => r.id === id) && !index.missing.some(m => m.region === id));
  if (unlisted.length) warnR('coverage', `no price areas and no stated reason for: ${unlisted.join(', ')}`);
  else pass('coverage', `all ${cov.regions.length} coverage regions are either mapped or listed as missing`);

  // ── 4. drift ─────────────────────────────────────────────────────────────
  const prev = previousIndex();
  if (!prev) warnR('drift', 'no previous index.json (not in git HEAD and no --prev) — drift not checked');
  else {
    const drift = [], lost = [];
    // Still given by tools/prices/regions.mjs: a loss of these is never
    // excused, not even by --refresh.
    const gives = (rid, s) => (PRICE_REGIONS[rid]?.sources || []).includes(s);
    const givenAnywhere = s => Object.keys(PRICE_REGIONS).some(rid => gives(rid, s));
    for (const s of srcIds) {
      const p = prev.sources?.[s]?.stats?.areas, n = index.sources[s].stats.areas;
      if (p == null || refreshed(s)) continue;
      const d = (n - p) / p;
      if (Math.abs(d) > DRIFT_AREAS) drift.push(`${s}: ${fmt(p)} -> ${fmt(n)} areas (${(100 * d).toFixed(1)}%)`);
    }
    for (const s of Object.keys(prev.sources || {})) {
      if (index.sources[s]) continue;
      if (givenAnywhere(s)) lost.push(`${s}: ${fmt(prev.sources[s].stats?.areas)} areas last build, absent now`);
      else if (!refreshed(s)) drift.push(`${s}: ${fmt(prev.sources[s].stats?.areas)} areas last build, absent now (no region takes it any more)`);
    }
    for (const pr of prev.regions || []) {
      const r = index.regions.find(x => x.id === pr.id);
      for (const s of pr.sources || []) {
        if (gives(pr.id, s) && !all.some(a => a.region === pr.id && a.src === s)) lost.push(`${pr.id}: had ${s} areas last build, has none now`);
      }
      if (r && pr.areas != null && r.areas != null && !(pr.sources || []).some(refreshed)) {
        const d = (r.areas - pr.areas) / pr.areas;
        if (Math.abs(d) > DRIFT_AREAS) drift.push(`${pr.id}: ${fmt(pr.areas)} -> ${fmt(r.areas)} areas (${(100 * d).toFixed(1)}%)`);
      }
    }
    for (const ps of prev.scales || []) {
      if (index.scales.some(x => x.key === ps.key)) continue;
      if (Object.keys(PRICE_REGIONS).some(rid => gives(rid, ps.source) && scalesFor(rid).includes(ps.key))) lost.push(`colour scale ${ps.key} (${ps.name}) existed last build, is gone now`);
    }
    for (const sc of index.scales) {
      const p = (prev.scales || []).find(x => x.key === sc.key);
      if (!p?.median || refreshed(sc.source)) continue;
      const d = (sc.median - p.median) / p.median;
      if (Math.abs(d) > DRIFT_MEDIAN) drift.push(`scale ${sc.key}: median ${fmt(p.median)} -> ${fmt(sc.median)} (${(100 * d).toFixed(1)}%)`);
    }
    check('nothing lost', lost, `every source, city and colour scale of the previous build is still here`, 8);
    check('drift', drift, `areas per source and per city within ±${DRIFT_AREAS * 100}% and scale medians within ±${DRIFT_MEDIAN * 100}% of the previous build` +
      (REFRESH.size ? ` (refreshed: ${[...REFRESH].join(', ')})` : ''));
  }

  // ── 5. size ──────────────────────────────────────────────────────────────
  sizes.sort((a, b) => b.gz - a.gz);
  const kb = b => `${(b / 1024).toFixed(1)}KB`;
  if (sizes.length) {
    const med = [...sizes].sort((a, b) => a.gz - b.gz)[Math.floor(sizes.length / 2)];
    const byLevel = sizes.reduce((a, t) => (a[t.level] = (a[t.level] || 0) + 1, a), {});
    check('tile size', sizes.filter(t => t.gz > MAX_TILE_GZ).map(t => `${t.k} ${kb(t.gz)}`),
      `${sizes.length} tiles (${Object.entries(byLevel).map(([l, n]) => `${n} @${base / 2 ** l}°`).join(', ')}); median ${kb(med.gz)}, worst ${kb(sizes[0].gz)} gzipped ` +
      `(${sizes[0].k}, ${sizes[0].areas} areas); total ${(sizes.reduce((a, t) => a + t.gz, 0) / 1e6).toFixed(2)}MB gz; limit ${kb(MAX_TILE_GZ)}`);
    const big = sizes.filter(t => t.gz > WARN_TILE_GZ);
    if (big.length) warnR('tile size', `${big.length} tile(s) over ${kb(WARN_TILE_GZ)} gzipped: ${big.slice(0, 5).map(t => `${t.k} ${kb(t.gz)}`).join(', ')}`);
  } else fail('tile size', 'no tiles');

  // ── 6. spot checks ───────────────────────────────────────────────────────
  if (!SPOT) warnR('spot checks', 'skipped (--no-spot)');
  else {
    const spot = (name, src, fn) => {
      if (!index.sources[src]) { fail(name, `${src} is not in this build`); return; }
      const { ok, saw } = fn(bySrc[src] || []);
      (ok ? pass : fail)(name, saw);
    };
    spot('spot Southwark', 'ons-msoa', l => {
      const n = l.filter(a => /^Southwark\b/.test(a.name || '')).length;
      return { ok: n > 30, saw: `${n} MSOAs named "Southwark …" (want > 30)` };
    });
    spot('spot London', 'ons-msoa', l => {
      const v = l.filter(a => a.scale === 'TLI' && coloured(a)).map(a => a.value), m = median(v);
      return { ok: m >= 400_000 && m <= 900_000, saw: `median of ${fmt(v.length)} London MSOA medians £${fmt(Math.round(m))} (want £400k–£900k)` };
    });
    spot('spot NYC', 'acs-tract', l => {
      const n = l.filter(a => a.region === 'nyc').length;
      return { ok: n > 1500, saw: `${fmt(n)} NYC tracts (want > 1,500)` };
    });
    spot('spot Toronto', 'statcan-ct', l => {
      const n = l.filter(a => a.region === 'toronto').length;
      return { ok: n > 400, saw: `${fmt(n)} Toronto census tracts (want > 400)` };
    });
  }

  // ── 7. bands ─────────────────────────────────────────────────────────────
  const thin = [];
  for (const sc of index.scales) {
    const v = all.filter(a => a.scale === sc.key && coloured(a)).map(a => a.value);
    if (v.length < 25 || sc.breaks?.length !== 4) continue;
    const n = [0, 0, 0, 0, 0];
    for (const x of v) n[classOf(x, sc.breaks)]++;
    const share = n.map(k => k / v.length);
    if (share.some(x => x < 0.05 || x > 0.45)) thin.push(`${sc.key} ${share.map(x => `${Math.round(100 * x)}%`).join('/')}`);
  }
  if (thin.length) warnR('bands', `colour bands out of 5–45% of a scale's areas: ${thin.slice(0, 5).join(', ')}`);
  else pass('bands', `every scale's five bands hold 5–45% of its coloured areas`);

  // ── report ───────────────────────────────────────────────────────────────
  for (const r of results) console.log(`  ${r.lvl.padEnd(4)}  ${r.name.padEnd(24)} ${r.msg}`);
  const fails = results.filter(r => r.lvl === 'FAIL').length, warns = results.filter(r => r.lvl === 'WARN').length;
  console.log(`\n  ${fails ? 'FAIL' : 'PASS'} — ${results.length - fails - warns} passed, ${fails} failed, ${warns} warning(s); ${fmt(all.length)} areas, ${index.where}.`);
  if (fails) process.exit(1);
};

run().catch(e => { console.error('verify-prices failed:', e.message); process.exit(1); });
