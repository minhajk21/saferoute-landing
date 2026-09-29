// The 26 US cities: American Community Survey 5-year estimates, table B25077
// "Median value (dollars)" of owner-occupied housing units, by census tract,
// with the estimated number of owner-occupied homes in each tract from table
// B25003 (Tenure, line 2 "Owner occupied"; a survey estimate of the tract's
// homes, not the sample the median came from). Drawn on the Census Bureau's
// cartographic tract polygons (cb_YYYY_SS_tract_500k, clipped to the shoreline).
//
// WHY this and not sale prices: it is the only home-value figure that is
// uniform across all 26 cities under a clean licence (public domain), keyless,
// local (tract), and published with a margin of error, so thin estimates can
// be kept off the colour scale honestly. Zillow, Redfin and Realtor.com fail
// the licence test; Texas, Louisiana and the Kansas side of KC do not disclose
// sale prices at all (research-summary.md, US lane). It is the OWNERS' OWN
// ESTIMATE of what the home would sell for, pooled over five survey years,
// and the metric label says so; it is never called a price.
//
// Two upstreams, both on www2.census.gov static hosting (api.census.gov needs
// a key since May 2026; these files do not):
//   1. The table-based Summary File: acsdt5y<Y>-b25077.dat and -b25003.dat,
//      pipe-separated, one row per geography, GEO_ID first. The newest 5-year
//      vintage is DISCOVERED from the directory listings (a vintage directory
//      exists months before its 5-year data, and 401s while embargoed), so the
//      2021-2025 release is picked up without an edit; meta is set from the
//      vintage actually read.
//   2. TIGER/Line cartographic boundaries GENZ<Y>, one zip per state: tract
//      polygons for the SAME vintage year, so every tract code in the table
//      has a polygon (2020 tracts; Connecticut's planning-region codes since
//      2022 match on both sides).
//
// Scope (R2): a tract is kept when its state is one of its region's home
// jurisdictions (tools/schools/regions.mjs juris) AND its extent overlaps the
// region's crime-data rectangle. A tract overlapping two rectangles belongs to
// the one containing its centre, else the first in coverage order (the
// backend's PROVIDERS order, as tools/schools/lib/coverage.mjs does). Its
// colour scale is the region's first scale key (tools/prices/regions.mjs):
// its own id, except Los Angeles and Long Beach, whose rectangles overlap,
// which share 'la-area'. No other pair of rectangles overlaps (checked Sept
// 2026). Where a region has a sale-price source too (NYC, DC, Hartford,
// Baltimore), the build hands that source these tracts' polygons, lets its
// tracts replace these inside its `covers`, and moves the tracts left over to
// the region's second key (nyc-outer): tools/build-prices.mjs PRECEDENCE.
//
// Honesty rules (SPEC §1):
//   - A negative estimate is an ACS annotation ("jam value"), not a figure:
//     -666666666 = too few sample cases to compute a median (every tract with
//     no owner-occupied homes gets it). value null, no flag: nothing was
//     published, so nothing is drawn.
//   - A negative MOE is an annotation too (-333333333: the median falls in an
//     open-ended interval; -222222222: controlled, no sampling error): moe null.
//   - CV = MOE / 1.645 / value above 0.30 -> 'uncertain': value and ± MOE in
//     the pane, neutral on the map.
//   - 2,000,001 is the top code ("$2,000,000 or more") -> 'topcoded'; the value
//     is kept as published and takes the top class.
//   - 9,999 is the bottom code ("less than $10,000") -> 'bottomcoded': the
//     value is kept as published and the page prints "Less than $10,000",
//     never $9,999; neutral on the map (it says only which side of $10,000
//     the owners' answers fell).

import { MAX_CV } from '../lib/schema.mjs';
import { politeFetch, UA } from '../lib/ctx.mjs';

const ID = 'acs-tract';
// Every US crime-data city (tools/data/coverage.json country 'us').
const REGIONS = ['nyc', 'chicago', 'sf', 'boston', 'seattle', 'philly', 'dc', 'denver', 'sandiego', 'longbeach', 'la', 'dallas', 'detroit',
  'baltimore', 'memphis', 'charlotte', 'nashville', 'minneapolis', 'cleveland', 'tucson', 'fortworth', 'hartford', 'kansascity',
  'houston', 'neworleans', 'lasvegas'];
const SF = 'https://www2.census.gov/programs-surveys/acs/summary_file';
const GENZ = 'https://www2.census.gov/geo/tiger';
const FIRST_YEAR = 2024;                    // the vintage this module was written and checked against
const TOP_CODE = 2000001, BOTTOM_CODE = 9999;
const MAX_AGE_H = 24 * 30;                  // annual data; the orchestrator decides when to refetch
const TRACT = '1400000US';                  // summary level 140 (census tract), geographic component 00

// State postal code -> FIPS, to name each state's boundary zip. Every state, so
// a new US city in tools/schools/regions.mjs needs no edit here.
const FIPS = {
  AL: '01', AK: '02', AZ: '04', AR: '05', CA: '06', CO: '08', CT: '09', DE: '10', DC: '11', FL: '12', GA: '13', HI: '15',
  ID: '16', IL: '17', IN: '18', IA: '19', KS: '20', KY: '21', LA: '22', ME: '23', MD: '24', MA: '25', MI: '26', MN: '27',
  MS: '28', MO: '29', MT: '30', NE: '31', NV: '32', NH: '33', NJ: '34', NM: '35', NY: '36', NC: '37', ND: '38', OH: '39',
  OK: '40', OR: '41', PA: '42', RI: '44', SC: '45', SD: '46', TN: '47', TX: '48', UT: '49', VT: '50', VA: '51', WA: '53',
  WV: '54', WI: '55', WY: '56', PR: '72',
};

const metaFor = y => ({
  name: `American Community Survey ${y - 4}–${y} 5-year estimates, table B25077 (median value) with B25003 (tenure)`,
  publisher: 'U.S. Census Bureau',
  url: `https://data.census.gov/table/ACSDT5Y${y}.B25077`,
  licence: 'Public domain (U.S. Government work)',
  // The Census Bureau's own dataset record for the ACS 5-year detailed tables
  // (api.census.gov/data/<Y>/acs/acs5.json) declares CC0.
  licenceUrl: 'https://creativecommons.org/publicdomain/zero/1.0/',
  attribution: [
    `Source: U.S. Census Bureau, ${y - 4}–${y} American Community Survey 5-Year Estimates, Tables B25077 and B25003.`,
    `Tract boundaries: U.S. Census Bureau, ${y} Cartographic Boundary Files (census tracts, 1:500,000).`,
  ],
  metric: 'Median home value (owners’ estimate)',
  unitNoun: 'owner-occupied homes',
  currency: 'USD',
  period: `${y - 4}–${y} (5-year survey)`,
  notes: [
    'Owners’ own estimate of what their home would sell for, not sale prices. Renters’ homes are not included. A sample survey: each figure has a margin of error.',
    `Answers were collected across ${y - 4}–${y}, so the figures describe those years, not today’s market.`,
  ],
  areaNoun: 'census tract',
  colourMinN: null,
  // n is B25003's ESTIMATE of how many owner-occupied homes the tract has,
  // not how many answers the median came from (a few hundred households are
  // sampled over the five years), so it is never shown as "based on".
  nEstimate: true,
  credit: 'U.S. Census Bureau',
  // The label of this figure where it is a sale-price tract's context line
  // (lib/sales.mjs): the metric itself (house rule 2: a median home value,
  // and an owners' estimate, not a price), and its survey years.
  contextLabel: `Median home value (owners’ estimate), ${y - 4}–${String(y).slice(2)} survey`,
});
// Set by fetch() from the vintage it actually read; this default is the
// vintage current when the source was written (released 29 Jan 2026).
const meta = metaFor(FIRST_YEAR);

// ── the vintage ─────────────────────────────────────────────────────────────
// The newest year whose 5-year directory lists BOTH tables AND whose
// cartographic tract boundaries (GENZ<Y>) are out: the tables arrive first
// (the 2020-2024 ones in January 2026), and a year taken without its
// boundaries would fail every build until they came. A missing or embargoed
// directory (404/401) just means "not this year".
const hasTables = (page, y) => page.includes(`acsdt5y${y}-b25077.dat`) && page.includes(`acsdt5y${y}-b25003.dat`);
// Any one state's zip stands for the release (they are published together);
// New York's, which every build needs. null when the host cannot say.
async function hasBoundaries(y) {
  try {
    const res = await politeFetch(`${GENZ}/GENZ${y}/shp/cb_${y}_${FIPS.NY}_tract_500k.zip`, { method: 'HEAD', headers: { 'user-agent': UA }, signal: AbortSignal.timeout(60_000) });
    await res.body?.cancel().catch(() => {});
    return res.ok ? true : res.status === 404 ? false : null;
  } catch { return null; }
}
async function latestVintage(ctx) {
  const top = (await ctx.download('acs-sf-index.html', `${SF}/`, { maxAgeH: 24 })).toString('latin1');
  const years = [...new Set([...top.matchAll(/href="(\d{4})\/"/g)].map(m => +m[1]))].filter(y => y >= FIRST_YEAR).sort((a, b) => b - a);
  if (!years.length) throw new Error(`ACS summary file index lists no year from ${FIRST_YEAR} on — the directory layout changed`);
  for (const y of years) {
    let page;
    try { page = (await ctx.download(`acs-sf-${y}-5yr-index.html`, `${SF}/${y}/table-based-SF/data/5YRData/`, { maxAgeH: 24 })).toString('latin1'); }
    catch (e) { ctx.log(`  ACS ${y - 4}-${y} 5-year: not available (${/HTTP \d+|frozen/.exec(e.message)?.[0] || e.message})`); continue; }
    if (!hasTables(page, y)) { ctx.log(`  ACS ${y - 4}-${y} 5-year: directory exists but lacks B25077/B25003`); continue; }
    // Frozen builds read the cache: whatever boundaries it holds decide.
    if (!ctx.frozen && y > FIRST_YEAR && (await hasBoundaries(y)) === false) { ctx.log(`  ACS ${y - 4}-${y} 5-year: tables out, GENZ${y} tract boundaries not yet`); continue; }
    return y;
  }
  throw new Error(`no ACS 5-year vintage from ${FIRST_YEAR} on lists B25077 and B25003 — the directory layout changed`);
}

// ── the Summary File tables ─────────────────────────────────────────────────
// Pipe-separated, one header line, no quoting. Only tract rows of the wanted
// states are kept (the file also holds block groups, counties, places… about
// 400,000 rows), so rows are sliced by prefix rather than all parsed.
function tractTable(ctx, buf, file, cols, statePrefixes) {
  const text = buf.toString('latin1');
  const nl = text.indexOf('\n');
  const header = text.slice(0, nl).replace(/\r$/, '').split('|');
  const col = ctx.readers.columns(header, ['GEO_ID', ...cols], file);
  const out = new Map();
  for (let p = nl + 1; p < text.length;) {
    let e = text.indexOf('\n', p);
    if (e < 0) e = text.length;
    if (text.startsWith(TRACT, p) && statePrefixes.has(text.slice(p + TRACT.length, p + TRACT.length + 2))) {
      const f = text.slice(p, e).replace(/\r$/, '').split('|');
      const geoid = f[col.GEO_ID].slice(TRACT.length);
      if (!/^\d{11}$/.test(geoid)) throw new Error(`${file}: tract GEO_ID "${f[col.GEO_ID]}" is not 11 digits`);
      if (out.has(geoid)) throw new Error(`${file}: tract ${geoid} appears twice`);
      out.set(geoid, cols.map(c => {
        const s = f[col[c]];
        if (!/^-?\d+$/.test(s ?? '')) throw new Error(`${file}: ${c} for tract ${geoid} is "${s}", not an integer — the format changed`);
        return +s;
      }));
    }
    p = e + 1;
  }
  if (!out.size) throw new Error(`${file}: no tract rows for the wanted states — the file layout changed`);
  return out;
}

// ── scope ───────────────────────────────────────────────────────────────────
const intersects = (a, b) => a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1];
const regionOf = (ctx, id) => (Array.isArray(ctx.regions) ? ctx.regions.find(r => r.id === id) : ctx.regions?.[id]);
// A region's scale key for these tracts: the first of tools/prices/regions.mjs
// `scales` (default its id). A second key is only ever for the tracts a
// sale-price source leaves this one, and the build assigns it.
function scaleOf(ctx, id) {
  const scales = regionOf(ctx, id)?.scales || [id];
  if (scales.length > 2) throw new Error(`${ID}: region ${id} lists ${scales.length} scale keys; a US city has one, and one more beside a sale-price source`);
  return scales[0];
}

async function fetchAreas(ctx) {
  const t0 = Date.now();
  const { shp } = ctx.readers;
  // The served regions, in coverage (PROVIDERS) order, with their home states.
  const served = (ctx.coverage || []).filter(c => REGIONS.includes(c.id)).map(c => {
    const juris = regionOf(ctx, c.id)?.juris;
    if (!juris?.length) throw new Error(`${ID}: region ${c.id} has no home jurisdictions (tools/schools/regions.mjs juris)`);
    return { id: c.id, bbox: c.bbox, juris, scale: scaleOf(ctx, c.id) };
  });
  const missing = REGIONS.filter(id => !served.some(r => r.id === id));
  if (missing.length) ctx.log(`  note: ${missing.join(', ')} not in coverage.json; skipped`);
  const states = [...new Set(served.flatMap(r => r.juris))].map(j => {
    const st = j.replace(/^US-/, '');
    if (!j.startsWith('US-') || !FIPS[st]) throw new Error(`${ID}: jurisdiction ${j} is not a US state`);
    return st;
  }).sort();
  const prefixes = new Set(states.map(st => FIPS[st]));

  // The listings are discovery aids, not data: generated pages whose
  // Last-Modified moves whenever the Bureau adds any file. Recorded as
  // upstream, they would make every monthly run look like a new release, so
  // they are left out of the provenance (probe() below watches for one).
  const mark = ctx.provenance?.length ?? 0;
  const y = await latestVintage(ctx);
  ctx.provenance?.splice(mark);
  ctx.log(`  ACS ${y - 4}-${y} 5-year; ${states.length} states: ${states.join(' ')}`);
  const dat = t => `acsdt5y${y}-${t}.dat`;
  const values = tractTable(ctx, await ctx.download(dat('b25077'), `${SF}/${y}/table-based-SF/data/5YRData/${dat('b25077')}`, { maxAgeH: MAX_AGE_H, timeoutMs: 600_000 }),
    dat('b25077'), ['B25077_E001', 'B25077_M001'], prefixes);
  const owners = tractTable(ctx, await ctx.download(dat('b25003'), `${SF}/${y}/table-based-SF/data/5YRData/${dat('b25003')}`, { maxAgeH: MAX_AGE_H, timeoutMs: 600_000 }),
    dat('b25003'), ['B25003_E002'], prefixes);

  const stats = { areas: 0, noValue: 0, uncertain: 0, topcoded: 0, bottomcoded: 0, outOfScope: 0 };
  const byRegion = {};
  const areas = [];
  for (const st of states) {
    const file = `cb_${y}_${FIPS[st]}_tract_500k.zip`;
    const z = ctx.readers.unzip(await ctx.download(file, `${GENZ}/GENZ${y}/shp/${file}`, { maxAgeH: MAX_AGE_H }));
    const { features, fields, stats: s } = shp.readShapefile(z);
    ctx.readers.columns(fields.map(f => f.name), ['GEOID', 'STUSPS', 'NAMELSAD', 'NAMELSADCO'], file);
    if (s.orphanHoles) ctx.log(`  note: ${file}: ${s.orphanHoles} hole(s) with no outer ring kept as polygons`);
    const juris = `US-${st}`;
    const cand = served.filter(r => r.juris.includes(juris));
    for (const { props: p, bbox, polys } of features) {
      if (p.STUSPS !== st || !p.GEOID.startsWith(FIPS[st])) throw new Error(`${file}: tract ${p.GEOID} says state ${p.STUSPS}`);
      const hits = cand.filter(r => intersects(bbox, r.bbox));
      if (!hits.length) { stats.outOfScope++; continue; }
      const cLat = (bbox[0] + bbox[2]) / 2, cLng = (bbox[1] + bbox[3]) / 2;
      const region = hits.find(r => ctx.inBox(r.bbox, cLat, cLng)) || hits[0];

      const v = values.get(p.GEOID), o = owners.get(p.GEOID);
      // Table and polygons are the same vintage, so every tract must be in both.
      if (!v || !o) throw new Error(`tract ${p.GEOID} (${file}) has no row in ${!v ? dat('b25077') : dat('b25003')} — table and boundary vintages disagree`);
      const [est, err] = v, [own] = o;
      let value = est > 0 ? est : null;
      const moe = value != null && err >= 0 ? err : null;
      const flags = [];
      if (value === BOTTOM_CODE) { flags.push('bottomcoded'); stats.bottomcoded++; }
      else if (value === TOP_CODE) { flags.push('topcoded'); stats.topcoded++; }
      else if (value != null && moe != null && moe / 1.645 / value > MAX_CV) { flags.push('uncertain'); stats.uncertain++; }
      if (value == null && !flags.length) stats.noValue++;
      areas.push({
        id: p.GEOID,
        // "Census Tract 113; Kings County; New York" as the ACS publishes it,
        // with commas and the state's postal code.
        name: `${p.NAMELSAD}, ${p.NAMELSADCO}, ${st}`,
        region: region.id, juris, scale: region.scale,
        value, moe, n: own >= 0 ? own : null, flags, context: null, polys,
      });
      stats.areas++;
      byRegion[region.id] = (byRegion[region.id] || 0) + 1;
    }
  }
  const empty = served.filter(r => !byRegion[r.id]).map(r => r.id);
  if (empty.length) throw new Error(`${ID}: no tracts for ${empty.join(', ')} — a boundary file or scope check is wrong`);
  ctx.log(`  ${ID}: ${stats.areas} tracts (${stats.noValue} with no published median, ${stats.uncertain} uncertain, ${stats.topcoded} top-coded, ` +
    `${stats.bottomcoded} bottom-coded, ${stats.outOfScope} out of scope) in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

  Object.assign(meta, metaFor(y));
  return { vintage: `${y - 4}-${y}`, areas };
}

// A new 5-year release comes at a new URL, which no HEAD of the current files
// can see: ask whether the next year's 5-year directory lists both tables yet
// and its tract boundaries are out, the same test fetch() applies, so a
// half-published release is not fetched month after month. One small GET and
// one HEAD a month; a failure just means "not yet" (the build warns).
async function probe(ctx, prev) {
  const y = +(/-(\d{4})$/.exec(prev?.vintage || '') || [])[1] || FIRST_YEAR;
  const res = await politeFetch(`${SF}/${y + 1}/table-based-SF/data/5YRData/`, { headers: { 'user-agent': ctx.UA || UA }, signal: AbortSignal.timeout(60_000) });
  if (!res.ok) { await res.body?.cancel().catch(() => {}); return { changed: false }; }
  if (!hasTables(await res.text(), y + 1)) return { changed: false };
  if (!(await hasBoundaries(y + 1))) { ctx.log(`  ACS ${y - 3}-${y + 1} 5-year: tables out, GENZ${y + 1} tract boundaries not yet`); return { changed: false }; }
  return { changed: true, vintage: `${y - 3}-${y + 1}` };
}

export default {
  id: ID,
  regions: REGIONS,
  cadence: 'annual',        // one 5-year release a year (the 2020-2024 one came out 29 Jan 2026)
  meta,
  fetch: fetchAreas,
  probe,
};
