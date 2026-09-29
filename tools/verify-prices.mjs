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
//    Toronto 400+ CTs; and for each recorded-sales source, its tract count,
//    and Manhattan's median of tract sale medians $700k–$3M). Each prints
//    what it saw. A phase-1 source missing from the build fails its check; a
//    sale source's check is SKIPPED only when the source is not in the build.
//    --no-spot skips them all (tests).
// 8. SALE PRICES (point-sales sources, SPEC2 §B.5). No tract coloured on
//    fewer than 10 sales, none with a figure on fewer than 3; figures rounded
//    to the 1,000; the middle half only from colourMinN sales and around the
//    median; nothing of a single sale in a tile (no location, date, price,
//    address or parcel id: rows are tract aggregates, a sale tract's name is
//    its census tract's own, its context label its geometry source's, contexts
//    carry only label/value/moe/n/flags, and no tile holds a day-precise
//    date) nor in index.json (every source entry holds only the fields
//    lib/schema.mjs lists, at every depth; entryProblems); every
//    sale received is placed or counted under a drop reason, and the placed
//    ones add up to the tracts' n; PRECEDENCE: inside a sale source's covers
//    only its tracts, outside them only the geometry source's, each on its
//    own scale.
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
import { FIELDS, FORBIDDEN_FIELD, FORBIDDEN_IN_TEXT, MAX_CV, INDEX_VERSION, CONTEXT_KEYS, metaProblems, entryProblems, isColoured, isUnpublished } from './prices/lib/schema.mjs';
import { MIN_SHOWN, MIN_COLOUR_N, ROUND_TO, ORCH_DROPS, isCovered } from './prices/lib/sales.mjs';
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
const skip = (name, msg) => results.push({ lvl: 'SKIP', name, msg });
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
  const salesIds = srcIds.filter(s => index.sources[s].kind === 'point-sales');

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
    if (Object.keys(t).some(x => !['a', 'c'].includes(x))) forbidden.push(`${k}: top-level field(s) ${Object.keys(t).join(', ')}`);
    // A day-precise date is a single sale's; nothing in a tile is one.
    if (/\d{4}-\d{2}-\d{2}/.test(text)) forbidden.push(`${k} holds a day-precise date`);
    for (const c of t.c || []) if (Object.keys(c).some(x => !CONTEXT_KEYS.includes(x))) forbidden.push(`${k}: context field(s) ${Object.keys(c).join(', ')}`);
    const parsed = areasFromTile(text, index);
    t.a.forEach((row, i) => {
      if (row.length !== FIELDS.length) { refs.push(`${k} row ${i}: ${row.length} fields`); return; }
      const [s, , , r, sc, , , , , ci] = row;
      if (!srcIds[s]) refs.push(`${k} row ${i}: src ${s}`);
      if (!index.regions[r]) refs.push(`${k} row ${i}: region ${r}`);
      if (!index.scales[sc]) refs.push(`${k} row ${i}: scale ${sc}`);
      if (ci != null && !t.c?.[ci]) refs.push(`${k} row ${i}: ctx ${ci}`);
      // A context is compared by content: its index differs from tile to tile.
      const rowText = JSON.stringify([row.slice(0, 9), ci == null ? null : t.c[ci], row.slice(10)]);
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
  check('forbidden fields', forbidden, 'no address, postcode, paon, saon, street or sale-level field (location, date, price, parcel); no day-precise date; contexts carry only label/value/moe/n/flags');

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
  check('source meta', srcIds.flatMap(s => metaProblems(index.sources[s], index.sources[s].kind || 'areas', { published: true }).map(p => `${s}: ${p}`)),
    `${srcIds.length} source(s) carry licence + link, attribution, metric, period, currency, unit noun; metrics named honestly`);
  // An allowlist of every field, at every depth: sale data under a name that
  // is not forbidden ("examples", upstream[0].sample) is caught here.
  check('source fields', srcIds.flatMap(s => entryProblems(s, index.sources[s])),
    'every source entry holds only the fields lib/schema.mjs lists (meta, build, upstream records, counts), no sale-level name at any depth');
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
    // One metric: every area on the scale is from a source naming this metric.
    const metrics = [...new Set(srcs.map(x => index.sources[x]?.metric))];
    if (metrics.length !== 1 || metrics[0] !== sc.metric) scaleProbs.push(`${sc.key}: its areas carry ${metrics.length} metric(s): ${metrics.join(' | ')}`);
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
  check('scales', scaleProbs, `${index.scales.length} scale(s): one source, one metric, one currency, 4 increasing breaks computed from their own areas`);

  // ── 8. sale prices ───────────────────────────────────────────────────────
  if (salesIds.length) {
    const sp = [], counted = [], prec = [];
    for (const s of salesIds) {
      const m = index.sources[s], l = bySrc[s] || [], minN = Math.max(MIN_COLOUR_N, m.colourMinN || 0);
      // Nor in index.json: no field of the source's entry is sale-level.
      for (const k of Object.keys(m)) if (FORBIDDEN_FIELD.test(k)) sp.push(`${s}: index.json carries a "${k}" field`);
      for (const a of l) {
        const key = `${s}:${a.id}`;
        if (a.moe != null) sp.push(`${key}: a margin of error on a median of sales`);
        if (a.value != null && a.value % ROUND_TO) sp.push(`${key}: ${a.value} is not rounded to the nearest ${ROUND_TO}`);
        if (a.value != null && !(a.n >= MIN_SHOWN)) sp.push(`${key}: a figure on n=${a.n} (fewer than ${MIN_SHOWN} sales show none)`);
        if (a.n != null && a.n < MIN_SHOWN && (a.value != null || a.iqr != null || a.flags.some(f => f !== 'suppressed'))) sp.push(`${key}: n=${a.n} must be withheld entirely`);
        if (isColoured(a) && !(a.n >= minN)) sp.push(`${key}: coloured on n=${a.n} (< ${minN})`);
        if (a.value != null && a.n >= minN && !a.iqr) sp.push(`${key}: n=${a.n} but no middle half`);
        if (a.iqr && (!(a.n >= minN) || a.iqr.some(v => v % ROUND_TO) || !(a.iqr[0] <= a.value && a.value <= a.iqr[1]))) sp.push(`${key}: middle half ${JSON.stringify(a.iqr)} on n=${a.n} around ${a.value}`);
        if (a.context && (a.context.label === m.metric || /\b(sale price|price paid)\b/i.test(a.context.label))) sp.push(`${key}: its context "${a.context.label}" is not the geometry source's own figure`);
        // Word for word the geometry source's label: a context line is never
        // somewhere to put words of a sale's own.
        const gl = index.sources[m.geometry]?.contextLabel;
        if (a.context && gl && a.context.label !== gl) sp.push(`${key}: its context label "${a.context.label}" is not ${m.geometry}'s ("${gl}")`);
        if (m.geometry === 'acs-tract' && !/^\d{11}$/.test(a.id)) sp.push(`${key}: not a census tract GEOID`);
        // The name is the tract's own official one (or none): never an
        // address or anything else of a sale. For census tracts, the number
        // in it is the GEOID's (…024402 -> "Census Tract 244.02, …").
        if (m.geometry === 'acs-tract' && a.name != null && /^\d{11}$/.test(a.id)) {
          const t = a.id.slice(5), num = `${+t.slice(0, 4)}${t.slice(4) === '00' ? '' : `.${t.slice(4)}`}`;
          const mt = /^Census Tract (\d+(?:\.\d+)?), [\p{L} .'’-]+, [A-Z]{2}$/u.exec(a.name);
          if (!mt || mt[1] !== num) sp.push(`${key}: name "${a.name}" is not census tract ${num}'s official name`);
        }
      }
      // Every sale received is placed or counted under a drop reason; the
      // placed ones are exactly the tracts' n.
      const st = m.stats || {}, d = st.dropped || {}, sales = st.sales || {};
      if (!Number.isInteger(sales.received) || !Number.isInteger(sales.used)) counted.push(`${s}: stats.sales must give received and used`);
      else {
        const missing = ORCH_DROPS.filter(k => !Number.isInteger(d[k]));
        if (missing.length) counted.push(`${s}: no count for ${missing.join(', ')}`);
        const dropped = ORCH_DROPS.reduce((t, k) => t + (d[k] || 0), 0);
        if (sales.received !== sales.used + dropped) counted.push(`${s}: ${sales.received} received ≠ ${sales.used} placed + ${dropped} dropped`);
        const sum = l.reduce((t, a) => t + (a.n || 0), 0);
        if (d.outsideScope ? sum > sales.used : sum !== sales.used) counted.push(`${s}: the tracts' n add up to ${sum}, not the ${sales.used} sales placed`);
      }
      if (Object.values(d).some(v => !(Number.isInteger(v) && v >= 0))) counted.push(`${s}: a drop count is not a whole number`);
      if (Object.keys(m.stats || {}).some(k => !['areas', 'coloured', 'neutral', 'unpublished', 'dropped', 'sales', 'replaced'].includes(k)) ||
          Object.keys(sales).some(k => !['received', 'used'].includes(k))) counted.push(`${s}: stats carry more than counts`);
      // Precedence, in every region the sale source shows.
      const g = m.geometry, covers = m.covers;
      if (!g || !index.sources[g]) { prec.push(`${s}: its geometry source ${g} is not in the build`); continue; }
      if (!covers?.juris) { prec.push(`${s}: no covers`); continue; }
      for (const rid of new Set(l.map(a => a.region))) {
        const mine = l.filter(a => a.region === rid), theirs = (bySrc[g] || []).filter(a => a.region === rid);
        const ids = new Set(mine.map(a => a.id)), [first, second] = scalesFor(rid);
        for (const a of theirs) {
          if (ids.has(a.id)) prec.push(`${rid}: tract ${a.id} is shown by both ${s} and ${g}`);
          if (isCovered(covers, a)) prec.push(`${rid}: ${g} tract ${a.id} is inside ${s}'s covers`);
          if (a.scale !== second) prec.push(`${rid}: ${g} tract ${a.id} is on scale ${a.scale}, not ${second}`);
        }
        for (const a of mine) {
          if (!isCovered(covers, a)) prec.push(`${rid}: ${s} tract ${a.id} is outside its covers`);
          if (a.scale !== first) prec.push(`${rid}: ${s} tract ${a.id} is on scale ${a.scale}, not ${first}`);
        }
      }
    }
    check('sale figures', sp, `${salesIds.join(', ')}: nothing coloured under ${MIN_COLOUR_N} sales, no figure under ${MIN_SHOWN}, figures to the ${ROUND_TO}, middle half only from colourMinN and around the median, contexts are the geometry source's own figure`);
    check('sales counted', counted, salesIds.map(s => { const x = index.sources[s].stats; return `${s} ${fmt(x.sales?.received)} received = ${fmt(x.sales?.used)} placed + ${ORCH_DROPS.map(k => `${fmt(x.dropped?.[k] || 0)} ${k}`).join(' + ')}`; }).join('; '));
    check('precedence', prec, `inside each sale source's covers only its tracts, outside them only its geometry source's, on separate scales`);
  }

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
    // A geometry source is compared with the tracts it and the sale sources
    // placed on it showed together: precedence moves tracts between them.
    const family = x => (x?.stats?.areas == null ? null : x.stats.areas + Object.values(x.stats.replaced || {}).reduce((t, v) => t + v, 0));
    for (const s of srcIds) {
      const p = family(prev.sources?.[s]), n = family(index.sources[s]);
      if (p == null || refreshed(s)) continue;
      const d = (n - p) / p;
      if (Math.abs(d) > DRIFT_AREAS) drift.push(`${s}: ${fmt(p)} -> ${fmt(n)} areas (${(100 * d).toFixed(1)}%)`);
    }
    for (const s of Object.keys(prev.sources || {})) {
      if (index.sources[s]) continue;
      if (givenAnywhere(s)) lost.push(`${s}: ${fmt(prev.sources[s].stats?.areas)} areas last build, absent now`);
      else if (!refreshed(s)) drift.push(`${s}: ${fmt(prev.sources[s].stats?.areas)} areas last build, absent now (no region takes it any more)`);
    }
    // A geometry source whose every tract in a city is now shown by a sale
    // source placed on it (all of DC) has handed the city over, not lost it.
    const handedOver = (rid, s) => salesIds.some(x => index.sources[x].geometry === s && all.some(a => a.region === rid && a.src === x));
    for (const pr of prev.regions || []) {
      const r = index.regions.find(x => x.id === pr.id);
      for (const s of pr.sources || []) {
        if (gives(pr.id, s) && !all.some(a => a.region === pr.id && a.src === s) && !handedOver(pr.id, s)) lost.push(`${pr.id}: had ${s} areas last build, has none now`);
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
    const moved = [];
    for (const sc of index.scales) {
      const p = (prev.scales || []).find(x => x.key === sc.key);
      // A scale that changed source (ACS to recorded sales) changed metric:
      // its median is not comparable, and that is a decision, not drift.
      if (p && p.source && p.source !== sc.source) { moved.push(`${sc.key}: ${p.source} -> ${sc.source}`); continue; }
      if (!p?.median || refreshed(sc.source)) continue;
      const d = (sc.median - p.median) / p.median;
      if (Math.abs(d) > DRIFT_MEDIAN) drift.push(`scale ${sc.key}: median ${fmt(p.median)} -> ${fmt(sc.median)} (${(100 * d).toFixed(1)}%)`);
    }
    check('nothing lost', lost, `every source, city and colour scale of the previous build is still here`, 8);
    check('drift', drift, `areas per source and per city within ±${DRIFT_AREAS * 100}% and scale medians within ±${DRIFT_MEDIAN * 100}% of the previous build` +
      (REFRESH.size ? ` (refreshed: ${[...REFRESH].join(', ')})` : '') + (moved.length ? `; not compared, as their source changed: ${moved.join(', ')}` : ''));
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
    // optional: a sale source's check, skipped (and said so) while that
    // source is not in the build; every other missing source fails its check.
    const spot = (name, src, fn, { optional = false } = {}) => {
      if (!index.sources[src]) { (optional ? skip : fail)(name, `${src} is not in this build`); return; }
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
    // Every NYC tract, whichever source shows it (acs-tract hands the five
    // boroughs to nyc-dof-sales).
    spot('spot NYC', 'acs-tract', () => {
      const n = all.filter(a => a.region === 'nyc').length, by = srcIds.map(s => [s, all.filter(a => a.region === 'nyc' && a.src === s).length]).filter(([, k]) => k);
      return { ok: n > 1500, saw: `${fmt(n)} NYC tracts (${by.map(([s, k]) => `${fmt(k)} ${s}`).join(', ')}; want > 1,500)` };
    });
    const tracts = (l, rid) => l.filter(a => a.region === rid).length;
    spot('spot NYC sales', 'nyc-dof-sales', l => {
      const n = tracts(l, 'nyc'), v = l.filter(a => a.id.startsWith('36061') && coloured(a)).map(a => a.value), m = median(v);
      return { ok: n > 1500 && m >= 700_000 && m <= 3_000_000,
        saw: `${fmt(n)} tracts (want > 1,500); median of ${fmt(v.length)} coloured Manhattan tract medians $${fmt(Math.round(m))} (want $700k–$3M)` };
    }, { optional: true });
    spot('spot DC sales', 'dc-cama-sales', l => ({ ok: tracts(l, 'dc') > 150, saw: `${fmt(tracts(l, 'dc'))} DC tracts (want > 150)` }), { optional: true });
    // SPEC2 asked for > 100: the Hartford rectangle holds only 65 tracts
    // (acs-tract, Sept 2026), so the floor is set under that instead.
    spot('spot Hartford sales', 'ct-opm-sales', l => ({ ok: tracts(l, 'hartford') > 50, saw: `${fmt(tracts(l, 'hartford'))} Hartford-region tracts (want > 50; the rectangle holds 65)` }), { optional: true });
    spot('spot Baltimore sales', 'md-sdat-sales', l => ({ ok: tracts(l, 'baltimore') > 150, saw: `${fmt(tracts(l, 'baltimore'))} Baltimore-region tracts (want > 150)` }), { optional: true });
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
  const fails = results.filter(r => r.lvl === 'FAIL').length, warns = results.filter(r => r.lvl === 'WARN').length, skips = results.filter(r => r.lvl === 'SKIP').length;
  console.log(`\n  ${fails ? 'FAIL' : 'PASS'} — ${results.length - fails - warns - skips} passed, ${fails} failed, ${warns} warning(s)${skips ? `, ${skips} skipped` : ''}; ${fmt(all.length)} areas, ${index.where}.`);
  if (fails) process.exit(1);
};

run().catch(e => { console.error('verify-prices failed:', e.message); process.exit(1); });
