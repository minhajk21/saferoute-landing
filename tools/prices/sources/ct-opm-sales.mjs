// Hartford: recorded residential SALE PRICES from the Connecticut Office of
// Policy and Management's "Real Estate Sales" listing (data.ct.gov 5mzw-sjtu,
// public domain), which every town assessor files with OPM under C.G.S.
// §10-261a/b: each sale of $2,000 or more, with the date it was recorded, the
// price, the property and residential type, the assessor's "non-usable sale"
// code, and a published point location. The orchestrator places each sale in
// the region's census tracts (the ones acs-tract builds) and publishes only
// per-tract counts, medians and quartiles (tools/prices/README.md, SPEC2 §B).
//
// WHY this and not ACS here: it is the actual price paid, sale by sale, under a
// clean licence, with coordinates published alongside, so no address ever has
// to be geocoded by us. The cost is lag: OPM publishes by GRAND-LIST YEAR (the
// sales recorded 1 October to 30 September), about a year after it closes
// (GL2024, Oct 2024 – Sep 2025, went up on 12 Aug 2026).
//
// WHICH SALES (every exclusion is counted in `dropped`):
//   - Residential only: property type "Residential", i.e. single-family homes,
//     condominiums and two-, three- and four-family houses. OPM files buildings
//     of five or more homes as "Apartments", and those are left out with
//     Commercial, Industrial, Vacant Land and Public Utility. An unknown type
//     THROWS: a sale that cannot be classed is a format change, not a guess.
//   - Arm's-length only: the Non Use Code must be BLANK. Assessors code a sale
//     "non-usable" (OPM's list of 30 reasons is attached to the dataset) when
//     its price is not a reliable market value: between family members (01, 02),
//     related companies (03), correcting deeds (04), part of a property (06) or
//     a part interest (08), tax, court, bankruptcy and foreclosure sales (09,
//     11, 13, 14, 18), wills (10), government or charity parties (15, 16),
//     exchanges and sales with personal property (21, 22), plottage (24),
//     auctions (30), no consideration (29), and "other reasons" when the
//     assessor judged it not a willing-buyer, willing-seller sale (25). A few
//     codes flag the ASSESSMENT rather than the parties: deed date (05), change
//     in the property since it was assessed, e.g. new construction or fire
//     damage (07), zoning (23), deferred rehabilitation (26), crumbling
//     foundation (27), use assessment (28). They are excluded too, because
//     OPM's flag is the only arm's-length test the data carries and we do not
//     second-guess the assessor; the notes say so, and they are counted apart
//     (assessmentCode, not nonArmsLength) so the stats claim nothing false.
//     (Measured on GL2024 in the 9 towns: keeping them would add 9% more
//     sales and move the town medians of Hartford from $290k to $292k and of
//     East Hartford from $280k to $294k.) Same-day, same-price rows are NOT
//     treated as one multi-parcel sale (NYC's rule): spot checks found them to
//     be separate homes at round prices miles apart, or units of one building
//     each priced in line with its own assessment, and assessors code true
//     multi-parcel sales 24 (plottage), which is excluded.
//   - Dated by the date RECORDED (the only date published), inside the window.
//     A malformed date (the file has some "0025-06-23" typos) is dropped, never
//     repaired.
//   - Located by the published point (geo_coordinates) only. A sale without
//     one is dropped, never geocoded. A point outside the sale's OWN town is
//     dropped too: the published geocode sometimes matched a same-named street
//     in the next town (Hartford sales on East Hartford's Madison St, or on
//     Newington's Main St), which would put the price in the wrong tract.
//
// SCOPE: every sale in each Connecticut town whose extent overlaps the
// region's rectangle, whole, the same edge rule acs-tract applies to tracts. A
// tract nests inside its town in Connecticut, so a tract acs-tract keeps is
// always inside a town fetched here. Whole towns, because a sale with no
// location still has to be counted against its town; so the orchestrator
// drops (and counts, outsideTracts) most of the edge towns' sales: 59% of
// those kept here in Sept 2026. Town extents and the own-town check use the
// Census Bureau's county subdivisions, which in Connecticut are its 169 towns
// (their boundaries do not change, so one vintage serves).
//
// WINDOW (SPEC2 §B.1): the 12 months of the latest grand-list year in the
// data (its September is the last complete month; OPM publishes a year only
// whole, so no further recording lag applies). Measured Sept 2026 on the
// region's 65 tracts: 12 months leaves 17 (26%) with fewer than 10 sales
// (GL2023 alone: 19, 29%), inside SPEC2's 30% rule, so 12, not 24 (24 would
// leave 6, 9%). The margin is thin: re-measure when each new year lands. If a
// town filed nothing for the year (OPM's dataset notes say a town need not
// file for the 12 months after a revaluation), its tracts would read as
// having no sales, so the window steps back to the latest year every town
// filed, with a warning, and throws if there is none.

import { pointInPolygon } from '../lib/geo.mjs';
import { isIsoDate } from '../lib/sales.mjs';

const ID = 'ct-opm-sales';
const REGIONS = ['hartford'];
const DATASET = '5mzw-sjtu';
const API = `https://data.ct.gov/resource/${DATASET}.json`;
const PAGE = 50_000;                        // Socrata's largest page
const WINDOW_MONTHS = 12;                   // one grand-list year (see WINDOW above)
const STEP_BACK = 2;                        // how many years back the window may go when a town skipped one
const MAX_AGE_H = 24;                       // small files: a rerun the same day reuses them, a correction is seen next day
const TOWNS_MAX_AGE_H = 24 * 30;
const STATE_FIPS = '09';
const TOWNS_YEAR = 2024;                    // any vintage: Connecticut's town lines are fixed
const TOWNS_FILE = `cb_${TOWNS_YEAR}_${STATE_FIPS}_cousub_500k.zip`;
const TOWNS_URL = `https://www2.census.gov/geo/tiger/GENZ${TOWNS_YEAR}/shp/${TOWNS_FILE}`;
// Only what the filters need. Never the address, the assessor's remarks or
// the assessed value: nothing that identifies a property leaves Socrata.
const FIELDS = ['serialnumber', 'listyear', 'daterecorded', 'town', 'saleamount', 'propertytype', 'residentialtype', 'nonusecode', 'geo_coordinates'];

// OPM's residential types -> the type each sale carries (the pane's mix).
export const RESIDENTIAL = {
  'Single Family': 'single family', Condo: 'condo',
  'Two Family': '2-4 family', 'Three Family': '2-4 family', 'Four Family': '2-4 family',
};
// Every other property type OPM uses (checked on GL2022-2024, all of the state).
export const NON_RESIDENTIAL = new Set(['Commercial', 'Industrial', 'Apartments', 'Vacant Land', 'Public Utility']);
const MIN_PRICE = 2000;                     // OPM lists sales of $2,000 or more; below that is a broken row

const meta = {
  name: 'Real Estate Sales, Connecticut Office of Policy and Management (data.ct.gov)',
  publisher: 'Connecticut Office of Policy and Management',
  url: `https://data.ct.gov/d/${DATASET}`,
  licence: 'Public domain',
  // The portal's "Public Domain" licence has no terms page of its own, so the
  // link is the dataset's page, where OPM declares it.
  licenceUrl: `https://data.ct.gov/d/${DATASET}`,
  attribution: [
    'Source: Connecticut Office of Policy and Management, Real Estate Sales (data.ct.gov), public domain; medians by census tract calculated by SafeRoute.',
    `Town boundaries: U.S. Census Bureau, ${TOWNS_YEAR} Cartographic Boundary Files (county subdivisions).`,
  ],
  credit: 'Connecticut OPM',
  metric: 'Median sale price',
  unitNoun: 'sales',
  currency: 'USD',
  // By RECORDING date: OPM publishes no other. No lag: a grand-list year is
  // published only once the towns have filed all of it. The build finds the
  // window in the data and writes the period ("Sales recorded Oct 2024 – Sep
  // 2025") and the area noun (acs-tract's).
  window: { months: WINDOW_MONTHS, by: 'recording' },
  notes: [
    'Sales of single-family homes, condominiums and two- to four-family houses, as recorded by Connecticut town assessors and reported to the Office of Policy and Management. Buildings of five or more homes are not included.',
    'Sales the town assessor marked as not a usable market sale are left out: sales between family members or related companies, foreclosures, court, tax and auction sales, part interests, and sales of properties changed since they were assessed (such as new construction).',
    'Each sale is placed at the location the state publishes with it. Sales with no location, or placed outside their own town, are left out rather than guessed.',
    'Connecticut publishes each year of sales (1 October to 30 September) about a year after it ends, so these figures run about a year behind the market.',
  ],
  colourMinN: 10,
};

// ── pure helpers (tested in test/ct-opm-sales.test.mjs) ─────────────────────
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
// The window of `months` ending with grand-list year `gl` (1 Oct gl – 30 Sep
// gl+1), as the list years it spans and inclusive ISO dates.
export function windowFor(gl, months = WINDOW_MONTHS) {
  if (months % 12) throw new Error(`${ID}: a window of ${months} months is not whole grand-list years`);
  const first = gl - months / 12 + 1;
  return { years: Array.from({ length: months / 12 }, (_, i) => first + i), from: `${first}-10-01`, to: `${gl + 1}-09-30` };
}
export const periodOf = w => `Sales recorded ${MON[+w.from.slice(5, 7) - 1]} ${w.from.slice(0, 4)} – ${MON[+w.to.slice(5, 7) - 1]} ${w.to.slice(0, 4)}`;
export const vintageOf = w => `${w.from.slice(0, 7)}..${w.to.slice(0, 7)}`;

// Non-use codes about the ASSESSMENT, not the parties or the price (see the
// header): excluded all the same, but counted apart.
export const ASSESSMENT_CODES = new Set(['05', '07', '23', '26', '27', '28']);

// The non-use code's number, '' when blank (a usable sale). OPM writes
// "25 - Other"; anything else non-blank still means the assessor coded it.
export function nonUseCode(v) {
  const s = v == null ? '' : String(v).trim();
  if (!s) return '';
  return /^(\d{1,2})\b/.exec(s)?.[1].padStart(2, '0') || 'other';
}

// One OPM row -> { sale } or { drop: reason }. Throws on a property type this
// module does not know (format drift). `inTown(town, lat, lng)` is the
// own-town check; `w` the window from windowFor().
export function classify(row, w, inTown) {
  const date = /^(\d{4}-\d{2}-\d{2})T/.exec(row.daterecorded || '')?.[1];
  if (!date || +date.slice(0, 4) < 1900 || !isIsoDate(date)) return { drop: 'badDate' };
  // Recorded outside the grand-list year(s) it was filed under. (The build's
  // own window drop, outOfWindow, is a separate count.)
  if (date < w.from || date > w.to) return { drop: 'outsideListYear' };
  const pt = row.propertytype;
  if (NON_RESIDENTIAL.has(pt)) return { drop: 'nonResidential' };
  if (pt !== 'Residential') throw new Error(`${ID}: property type "${pt}" is not one this module knows — the format changed`);
  const type = RESIDENTIAL[row.residentialtype];
  if (!type) throw new Error(`${ID}: residential type "${row.residentialtype}" is not one this module knows — the format changed`);
  const code = nonUseCode(row.nonusecode);
  if (code) return { drop: ASSESSMENT_CODES.has(code) ? 'assessmentCode' : 'nonArmsLength', code };
  const price = Number(row.saleamount);
  if (!Number.isFinite(price) || price < MIN_PRICE) return { drop: 'badPrice' };
  const c = row.geo_coordinates?.coordinates;
  if (!Array.isArray(c) || !Number.isFinite(+c[0]) || !Number.isFinite(+c[1])) return { drop: 'noLocation' };
  const lng = +c[0], lat = +c[1];
  if (!inTown(row.town, lat, lng)) return { drop: 'outsideOwnTown' };
  return { sale: { lat, lng, price, date, type } };
}

// ── upstream ────────────────────────────────────────────────────────────────
const q = params => `${API}?${new URLSearchParams(params).toString()}`;
const slug = s => s.replace(/[^A-Za-z0-9]+/g, '_');

// A Socrata query result. Its ETag is useless as a change check: the gzipped
// GET answers "…--gzip--gzip" and the HEAD the build's upstream check sends
// answers "…--gzip" for the same unchanged data (measured Sept 2026), so every
// monthly run would look like a new release. Dropping it from the provenance
// makes the check use Last-Modified, which Socrata sets to the dataset's own
// last update (X-SODA2-Truth-Last-Modified) and which is stable across both.
// Every answer here is JSON: one that is not (an error page served with HTTP
// 200) is forgotten, so the next run asks again rather than reading it from
// the cache.
async function download(ctx, file, url) {
  const buf = await ctx.download(file, url, { maxAgeH: MAX_AGE_H });
  const rec = ctx.provenance?.findLast(p => p.file === file);
  if (rec?.lastModified) rec.etag = null;
  try { return JSON.parse(buf.toString('utf8')); }
  catch { ctx.discard?.(file); throw new Error(`${file}: the answer is not JSON — the API changed, or the host sent an error page`); }
}

// Every row a town filed for one grand-list year, paged. [] = it filed none.
async function townYear(ctx, town, gl) {
  const rows = [];
  for (let page = 0; ; page++) {
    const url = q({ $select: FIELDS.join(','), $where: `listyear=${gl} AND town='${town.replace(/'/g, "''")}'`, $order: ':id', $limit: PAGE, $offset: page * PAGE });
    const file = `ct-opm-sales-GL${gl}-${slug(town)}${page ? `-p${page + 1}` : ''}.json`;
    const got = await download(ctx, file, url);
    if (!Array.isArray(got)) { ctx.discard?.(file); throw new Error(`${file}: not a list of rows — the API changed`); }
    for (const r of got) if (r.town !== town || +r.listyear !== gl) throw new Error(`${file}: a row for ${r.town} GL${r.listyear} — the query was not applied`);
    rows.push(...got);
    if (got.length < PAGE) return rows;
  }
}

async function latestYear(ctx) {
  const got = await download(ctx, 'ct-opm-sales-latest.json', q({ $select: 'max(listyear) AS gl' }));
  const gl = +got?.[0]?.gl;
  if (!Number.isInteger(gl) || gl < 2023) throw new Error(`${ID}: the latest grand-list year reads "${got?.[0]?.gl}" — the dataset changed`);
  return gl;
}

// The Connecticut towns (Census county subdivisions) whose extent overlaps
// the region's rectangle, with their polygons for the own-town check.
async function townsFor(ctx, bbox) {
  const z = ctx.readers.unzip(await ctx.download(TOWNS_FILE, TOWNS_URL, { maxAgeH: TOWNS_MAX_AGE_H }));
  const { features, fields } = ctx.readers.shp.readShapefile(z);
  ctx.readers.columns(fields.map(f => f.name), ['STATEFP', 'COUNTYFP', 'COUSUBFP', 'NAME'], TOWNS_FILE);
  const all = features.filter(f => f.props.STATEFP === STATE_FIPS && f.props.COUSUBFP !== '00000');
  if (all.length !== 169) throw new Error(`${TOWNS_FILE}: ${all.length} towns, not Connecticut's 169 — the file changed`);
  const hit = all.filter(f => f.bbox[0] <= bbox[2] && f.bbox[2] >= bbox[0] && f.bbox[1] <= bbox[3] && f.bbox[3] >= bbox[1]);
  return hit.map(f => ({ name: f.props.NAME, county: STATE_FIPS + f.props.COUNTYFP, bbox: f.bbox, polys: f.polys }));
}

async function fetchSales(ctx) {
  const t0 = Date.now();
  const served = REGIONS.map(id => ({ id, reg: ctx.regions?.[id] })).filter(r => r.reg);
  if (!served.length) throw new Error(`${ID}: none of ${REGIONS.join(', ')} is in coverage.json`);
  const towns = [];
  for (const { id, reg } of served) {
    if (!reg.juris?.includes('US-CT')) throw new Error(`${ID}: region ${id} is not in Connecticut (juris ${reg.juris})`);
    for (const t of await townsFor(ctx, reg.bbox)) if (!towns.some(x => x.name === t.name)) towns.push(t);
  }
  towns.sort((a, b) => a.name.localeCompare(b.name));
  ctx.log(`  ${towns.length} towns overlap the rectangle: ${towns.map(t => t.name).join(', ')}`);

  // The window: the latest one in which every town filed its sales.
  const latest = await latestYear(ctx);
  const cache = new Map();
  const rowsOf = async (town, gl) => {
    const k = `${town}|${gl}`;
    if (!cache.has(k)) cache.set(k, await townYear(ctx, town, gl));
    return cache.get(k);
  };
  let w = null;
  for (let end = latest; end >= latest - STEP_BACK && !w; end--) {
    const cand = windowFor(end);
    const silent = [];
    for (const gl of cand.years) for (const t of towns) if (!(await rowsOf(t.name, gl)).length) silent.push(`${t.name} GL${gl}`);
    if (!silent.length) { w = cand; break; }
    ctx.warn(`${ID}: no sales filed for ${silent.join(', ')} (a town may skip the year after a revaluation); trying the window a year earlier`);
  }
  if (!w) throw new Error(`${ID}: no ${WINDOW_MONTHS}-month window since GL${latest - STEP_BACK - WINDOW_MONTHS / 12 + 1} in which every town filed its sales`);
  if (w.years.at(-1) !== latest) ctx.warn(`${ID}: GL${latest} is out but incomplete for this region; using ${periodOf(w)}`);

  const byName = new Map(towns.map(t => [t.name, t]));
  const inTown = (town, lat, lng) => {
    const t = byName.get(town);
    return !!t && lat >= t.bbox[0] && lat <= t.bbox[2] && lng >= t.bbox[1] && lng <= t.bbox[3] && pointInPolygon(lat, lng, t.polys);
  };
  // Every reason is listed, a zero included, so the published stats show each
  // rule was applied.
  const dropped = { outsideListYear: 0, badDate: 0, nonResidential: 0, nonArmsLength: 0, assessmentCode: 0, badPrice: 0, noLocation: 0, outsideOwnTown: 0, duplicate: 0 };
  const codes = {}, perTown = {};
  const sales = [], seen = new Set();
  let rowsIn = 0;
  for (const t of towns) {
    const pt = perTown[t.name] = { rows: 0, kept: 0 };
    for (const gl of w.years) {
      for (const row of await rowsOf(t.name, gl)) {
        rowsIn++; pt.rows++;
        // A serial number is unique within a town's grand-list year; a repeat
        // is the same sale filed twice (none in GL2023-2024, checked).
        const key = row.serialnumber != null ? `${t.name}|${gl}|${row.serialnumber}` : null;
        const r = key && seen.has(key) ? { drop: 'duplicate' } : classify(row, w, inTown);
        if (key) seen.add(key);
        if (r.drop) {
          dropped[r.drop]++;
          if (r.code) codes[r.code] = (codes[r.code] || 0) + 1;
          continue;
        }
        sales.push(r.sale); pt.kept++;
      }
    }
  }
  if (!sales.length) throw new Error(`${ID}: no sales kept from ${rowsIn} rows — a filter or the format is wrong`);
  ctx.log(`  ${ID}: ${periodOf(w)} (GL${w.years.join('+GL')}); ${rowsIn} rows in, ${sales.length} sales kept; dropped ` +
    Object.entries(dropped).map(([k, v]) => `${k} ${v}`).join(', ') + ` in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  ctx.log(`  non-use codes: ${Object.entries(codes).sort().map(([k, v]) => `${k}:${v}`).join(' ')}`);
  ctx.log(`  per town (rows -> kept): ${Object.entries(perTown).map(([k, v]) => `${k} ${v.rows}->${v.kept}`).join(', ')}`);

  return {
    vintage: vintageOf(w),
    // OPM's own statement of the period: a grand-list year runs to 30 Sep.
    through: w.to.slice(0, 7),
    // Authoritative for Connecticut tracts in the planning regions (the
    // state's county-equivalents since 2022) of the towns fetched: every
    // tract of the region lies in one of those towns.
    covers: { juris: ['US-CT'], counties: [...new Set(towns.map(t => t.county))].sort() },
    sales,
    dropped,
  };
}

export default {
  id: ID,
  kind: 'point-sales',
  regions: REGIONS,
  cadence: 'annual',            // one grand-list year a year (GL2024 went up 12 Aug 2026)
  geometry: 'acs-tract',
  meta,
  fetch: fetchSales,
};
