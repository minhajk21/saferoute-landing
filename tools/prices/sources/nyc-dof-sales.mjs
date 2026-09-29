// New York City (the five boroughs): recorded residential SALE PRICES from the
// NYC Department of Finance (DOF), as individual sales for the orchestrator to
// put into census tracts (kind 'point-sales', SPEC2 §B). Where this source
// covers a tract, its "Median sale price" replaces acs-tract's owners' estimate.
//
// The sales, in two parts that meet without overlapping:
//   1. NYC Citywide Rolling Calendar Sales (NYC Open Data usep-8jbt): every
//      sale DOF recorded with a sale date in the last 12 months, reissued by
//      hand each month (metadata "Automation: No"). Read as CSV through the
//      keyless Socrata API (the backend already reaches data.cityofnewyork.us
//      from Render). Row for row the same as DOF's rollingsales_<borough>.xlsx
//      (checked 2026-09-29: 82,345 rows both ways).
//   2. For window months before the rolling file: DOF's Annualized Sales
//      workbooks, <year>_<borough>.xlsx on www.nyc.gov, one per borough and
//      calendar year, final and posted each spring (2024: 9 Apr 2025; 2025:
//      7 May 2026). NOT the Open Data copy (w2pb-icbu): its Staten Island
//      2025 lacks the first 375 rows of DOF's workbook (all of Annadale and
//      part of Arden Heights, neighbourhoods DOF sorts first), and it gains a
//      year a month later (9 Jun 2026).
// Neither part has coordinates. A sale is placed at its tax lot's point in
// the Department of City Planning's PLUTO (64uk-42ks, one row per lot). A
// condominium UNIT has its own lot (1001, 1002, …) that PLUTO does not list:
// PLUTO holds the condominium's BILLING lot (75xx). DOF's Digital Tax Map says
// which condominium a unit belongs to (eguu-7ie3: unit BBL -> condominium) and
// that condominium's billing lot (p8u6-a6it), so a unit is placed at its
// building. Official joins both ways; nothing is geocoded from an address,
// and a sale that no table places is counted and dropped (noLocation).
//
// WHAT COUNTS AS A HOME SALE, by DOF building class AT THE TIME OF SALE (DOF's
// code list, www.nyc.gov/assets/finance/jump/hlpbldgcode.html, grouped as DOF
// groups its sales files into building class categories):
//   1-3 family  categories 01-03: A0-A9 and S0/S1 ("primarily 1 family with
//               1 or 2 stores or offices"); B1 B2 B3 B9 and S2 (two family);
//               C0 (three families). On DOF's 2025 workbooks this set, with
//               DOF's own $200,000 floor, reproduces every count in DOF's
//               2025 citywide summary (2025_citywide_sale.xlsx) to within 4
//               sales and every median exactly (checked 2026-09-29).
//   condo       residential condominium units: R1 (2-10 unit building), R2
//               (walk-up), R3 (1-3 storey), R4 (elevator), R6 (1-3 unit
//               building, originally class 1). Not R7/R8 (commercial units,
//               which DOF files under categories 04/16), RR (condo rental
//               billing lots) or R5/RA-RW (commercial, parking, storage,
//               terraces).
//   coop        co-op apartments: C6, C8 (walk-up), D4, D0 (elevator), R9
//               (co-op within a condominium).
//   Everything else (rental buildings, four or more families, vacant land,
//   commercial) is not a home sale -> nonResidential.
//
// WHAT COUNTS AS ONE ARM'S-LENGTH SALE. DOF does not flag related-party or
// other non-market sales, so only what the data itself shows is used:
//   - a price under $10,000. DOF's glossary: "A $0 sale indicates that there
//     was a transfer of ownership without a cash consideration. There can be
//     a number of reasons for a $0 sale including transfers of ownership from
//     parents to children." -> nominalPrice
//   - a one-to-three-family home under $200,000: DOF's OWN floor for these
//     homes ("Sale Price Equal or More than $200,000", the heading of its
//     citywide summary of 1-3 family sales, 2025_citywide_sale.xlsx). At
//     $10,000 alone, 203 house sales at $10k-$99k were kept in the phase-2
//     build (a two-family house at $10,000 and another at $25,000 in one
//     Brooklyn tract, moving its median from $900k to $756k); a New York
//     City house at those prices is almost never a market sale. DOF's line
//     is used rather than one of ours. Condominium and co-op apartments keep
//     the $10,000 floor only: DOF publishes no floor for them, and 7% of
//     co-op sales (1,849 of 26,323 in the Aug 2024 - Jul 2026 window) are
//     under $200,000. Measured on the Sept 2026 files: 497 house rows
//     dropped; the tract above is back to $900k; and the 2025 house sales
//     kept (18,944) have a median of $900,000, which is what DOF's own rule
//     gives on DOF's rows (DOF publishes medians per category only: $785,000
//     one-family, $992,794 two-family, $1,280,000 three-family).
//     -> houseUnderDofFloor
//   - one price repeated on one date across several rows: a deed conveying
//     several lots (or several co-op apartments, which share their building's
//     lot and, in these files, show no apartment number) carries the TOTAL
//     price on every row, so no row's price is its own. Detected over rows of
//     ANY class priced from $10,000 (a home sold with a vacant lot or a
//     parking unit is still a multi-property deed), as the same borough + tax
//     block + date + price, or the same borough + date + price when the price
//     is not a whole number of thousands: a portfolio spread over several
//     blocks. Round prices collide across a borough by chance hundreds of
//     times a year and are not taken as one deed; an odd price on the same day
//     is not a coincidence. -> multiProperty
//
// THE WINDOW is by SALE DATE (DOF: "Date the property sold"), not the date the
// deed was recorded: WINDOW_MONTHS whole months ending LAG_MONTHS before the
// rolling file's last month (meta.window). The BUILD applies it (lib/sales.mjs
// saleWindow) and counts what falls outside; this module returns the sales
// from the window's first month through the rolling file's last, and says
// that last month is DOF's own ("All Sales From September 2025 - August
// 2026") with `through`. It computes the same window only to know which
// annualized months to read: rows of those workbooks before the window are
// never read into a sale, as a date filter on a query would never return them.
//
// Privacy (SPEC2 §B.6): `sales` never leaves the build: lat/lng, price, date
// and type only. No BBL, address or apartment goes into a sale (the rolling
// query never asks for them; the workbooks carry addresses, which are read
// past and never kept).
//
// Licence: NYC Administrative Code § 23-502(d): public data sets are available
// "without any registration requirement, license requirement or restrictions
// on their use", provided a third party may be required "to explicitly
// identify the source and version of the public data set, and a description
// of any modifications". The attribution lines name every table, the
// data-as-of date of each, and what we did to them.

import { statSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { politeFetch, UA } from '../lib/ctx.mjs';

const ID = 'nyc-dof-sales';
const SODA = 'https://data.cityofnewyork.us/resource';
const DS = { rolling: 'usep-8jbt', pluto: '64uk-42ks', units: 'eguu-7ie3', condos: 'p8u6-a6it' };
const ANNUAL = 'https://www.nyc.gov/assets/finance/downloads/pdf/rolling_sales/annualized-sales';
const PAGE = 100_000;                 // rows per Socrata page (the host serves 120,000; stay under)

// DOF borough code -> county FIPS (Manhattan = New York County, Brooklyn =
// Kings, Staten Island = Richmond), and the name in DOF's workbook file names.
export const COUNTY = { 1: '36061', 2: '36005', 3: '36047', 4: '36081', 5: '36085' };
export const BOROUGH = { 1: 'Manhattan', 2: 'Bronx', 3: 'Brooklyn', 4: 'Queens', 5: 'Staten Island' };
const WORKBOOK = { 1: 'manhattan', 2: 'bronx', 3: 'brooklyn', 4: 'queens', 5: 'staten_island' };

const CODES = {
  '1-3 family': 'A0 A1 A2 A3 A4 A5 A6 A7 A8 A9 S0 S1 B1 B2 B3 B9 S2 C0',
  condo: 'R1 R2 R3 R4 R6',
  coop: 'C6 C8 D0 D4 R9',
};
const TYPE_OF = new Map(Object.entries(CODES).flatMap(([t, s]) => s.split(' ').map(c => [c, t])));
// The sale type a DOF building class (at the time of sale) makes, or null.
export const saleType = cls => TYPE_OF.get(String(cls || '').trim().toUpperCase()) ?? null;

export const MIN_PRICE = 10_000;
// DOF's floor for one-to-three-family homes (see WHAT COUNTS AS ONE ARM'S-
// LENGTH SALE); only that type has one.
export const HOUSE_MIN_PRICE = 200_000;
// THE WINDOW (SPEC2 §B.1; measured 2026-09-29 on the rolling file of
// 2026-09-15, on the 2,324 census tracts of the five boroughs as acs-tract
// ships them):
//   LAG_MONTHS = 1. The rolling file's latest month is still being recorded
//   when DOF publishes it: its August 2026 held 71% of the home sales of
//   August 2025, and its last week (25-31 Aug) 37% of the same week a year
//   before, while every earlier month held 87-115%. So it is left out.
//   WINDOW_MONTHS = 24. Twelve months (Aug 2025 - Jul 2026) left 968 tracts
//   (42%) under 10 sales, above SPEC2's 30% line (622 of the 1,942 tracts
//   with an ACS figure, 32%); 24 months leave 520 (22%; 216, 11%).
//   The cost: the year before the rolling file comes from DOF's annualized
//   workbooks, which DOF posts each spring, so from about March to May the
//   window's first months are not published anywhere yet. The fetch then
//   fails (error code UPSTREAM_NOT_YET_PUBLISHED) and the build re-emits the
//   last published tiles, with its usual warning, rather than show a
//   shorter window.
export const WINDOW_MONTHS = 24;
export const LAG_MONTHS = 1;

// ── pure helpers (tested in tools/prices/test/nyc-dof-sales.test.mjs) ───────

// A BBL as DOF and DCP write it: borough (1) + block (5) + lot (4) digits.
export function bblOf(boro, block, lot) {
  const b = +boro, k = +block, l = +lot;
  if (!(b >= 1 && b <= 5) || !Number.isInteger(k) || k < 0 || k > 99999 || !Number.isInteger(l) || l < 0 || l > 9999) return null;
  return `${b}${String(k).padStart(5, '0')}${String(l).padStart(4, '0')}`;
}
// Socrata serves number columns such as PLUTO's bbl as "4114317501.00000000".
export function normBbl(s) {
  const m = /^\s*([1-5]\d{9})(?:\.0*)?\s*$/.exec(String(s ?? ''));
  return m ? m[1] : null;
}
// 'YYYY-MM' arithmetic.
export function addMonths(ym, k) {
  const [y, m] = ym.split('-').map(Number);
  const t = y * 12 + (m - 1) + k;
  return `${Math.floor(t / 12)}-${String((t % 12) + 1).padStart(2, '0')}`;
}
// The window for a rolling file whose latest sale month is `latest`.
export function windowFor(latest, months = WINDOW_MONTHS, lag = LAG_MONTHS) {
  const to = addMonths(latest, -lag);
  return { from: addMonths(to, -(months - 1)), to };
}
// An Excel serial day (1900 date system, as DOF's workbooks use) -> 'YYYY-MM-DD'.
export const excelDate = n => new Date(Date.UTC(1899, 11, 30) + Math.round(+n) * 864e5).toISOString().slice(0, 10);

// The rows that belong to a multi-property deed (see the header). `rows` are
// all the rows read, of every building class; returns a Set of those rows.
export function multiPropertyRows(rows) {
  const groups = new Map();
  const add = (k, r) => { const g = groups.get(k); if (g) g.push(r); else groups.set(k, [r]); };
  for (const r of rows) {
    if (!(r.price >= MIN_PRICE)) continue;
    add(`b|${r.boro}|${r.block}|${r.date}|${r.price}`, r);
    if (r.price % 1000) add(`o|${r.boro}|${r.date}|${r.price}`, r);
  }
  const out = new Set();
  for (const g of groups.values()) if (g.length > 1) for (const r of g) out.add(r);
  return out;
}

// The filter, in the order drops are counted (each row counted once, under
// its first reason): nonResidential, nominalPrice, houseUnderDofFloor,
// multiProperty, noLocation.
// (Rows outside the window are the build's to count: outOfWindow.)
//   rows: [{ boro, block, lot, cls, price, date: 'YYYY-MM-DD' }]
//   locate(row) -> [lat, lng] or null
export function filterSales(rows, { locate }) {
  const dropped = { nonResidential: 0, nominalPrice: 0, houseUnderDofFloor: 0, multiProperty: 0, noLocation: 0 };
  const multi = multiPropertyRows(rows);
  const sales = [];
  for (const r of rows) {
    const type = saleType(r.cls);
    if (!type) { dropped.nonResidential++; continue; }
    if (!(r.price >= MIN_PRICE)) { dropped.nominalPrice++; continue; }
    if (type === '1-3 family' && r.price < HOUSE_MIN_PRICE) { dropped.houseUnderDofFloor++; continue; }
    if (multi.has(r)) { dropped.multiProperty++; continue; }
    const at = locate(r);
    if (!at) { dropped.noLocation++; continue; }
    sales.push({ lat: at[0], lng: at[1], price: r.price, date: r.date, type });
  }
  return { sales, dropped };
}

// One sale row, from either part, -> the fields the filter reads. Throws on
// format drift (a renamed column reads as '' and fails), never guesses.
export function saleRow({ borough, block, lot, cls, price, date }, what) {
  const boro = +borough, k = +block, l = +lot, p = price === '' || price == null ? NaN : +price;
  const d = /^(\d{4}-\d{2}-\d{2})(?:T[\d:.]+)?$/.exec(date || '')?.[1];
  if (!COUNTY[boro] || !Number.isInteger(k) || !Number.isInteger(l) || !Number.isFinite(p) || p < 0 || !d) {
    throw new Error(`${what}: ${JSON.stringify({ borough, block, lot, price, date })} is not a sale row — the format changed`);
  }
  return { boro, block: k, lot: l, cls: String(cls || '').trim().toUpperCase(), price: p, date: d };
}

// ── meta ────────────────────────────────────────────────────────────────────
// No period or areaNoun: the build writes the period from the window it finds
// ("Sales dated Aug 2024 – Jul 2026") and takes the area noun from acs-tract;
// it also adds the standard note on rounding and the at-least-3 rule.
const day = s => { const t = Date.parse(s || ''); return Number.isFinite(t) ? new Date(t).toISOString().slice(0, 10) : 'unknown'; };

// § 23-502(d) asks for the source and VERSION of each data set: each part
// carries its data-as-of date. The annualized workbooks come from nyc.gov (see
// the header for why), and are named with their NYC Open Data twin
// (w2pb-icbu), which publishes the same sales under the same law.
function metaFor({ rollingAsOf, annual = [], plutoVersion, taxMapAsOf } = {}) {
  const parts = [`NYC Citywide Rolling Calendar Sales (NYC Open Data usep-8jbt, data as of ${day(rollingAsOf)})`];
  for (const a of annual) parts.push(`Annualized Sales ${a.year} (DOF's workbooks on nyc.gov, also published as NYC Open Data w2pb-icbu; Property Tax System data as of ${a.asOf})`);
  return {
    name: 'NYC Citywide Rolling Calendar Sales and Annualized Sales (NYC Department of Finance)',
    publisher: 'NYC Department of Finance',
    url: 'https://data.cityofnewyork.us/City-Government/NYC-Citywide-Rolling-Calendar-Sales/usep-8jbt',
    licence: 'NYC Open Data: no licence required (NYC Administrative Code § 23-502)',
    licenceUrl: 'https://nycadmincode.readthedocs.io/t23/c05/',
    attribution: [
      `Source: NYC Department of Finance, ${parts.join(' and ')}. SafeRoute kept home sales only and turned them into census-tract medians.`,
      `Lot locations: NYC Department of City Planning, PLUTO${plutoVersion ? ` ${plutoVersion}` : ''} (NYC Open Data 64uk-42ks); condominium units: NYC Department of Finance, Digital Tax Map (NYC Open Data eguu-7ie3 and p8u6-a6it${taxMapAsOf ? `, data as of ${day(taxMapAsOf)}` : ''}).`,
    ],
    metric: 'Median sale price',
    unitNoun: 'sales',
    currency: 'USD',
    window: { months: WINDOW_MONTHS, by: 'sale', lagMonths: LAG_MONTHS },
    notes: [
      'Sales of one-to-three-family homes, condominium apartments and co-op apartments recorded by the NYC Department of Finance, by the date of sale. ' +
        'Transfers under $10,000 (usually between family members) and sales of several properties for one price are left out, ' +
        'and so are one-to-three-family homes sold for under $200,000, the floor the Department of Finance uses in its own summaries of these sales. ' +
        'The Department of Finance does not mark sales between relatives or other related parties, so a few may remain.',
    ],
    colourMinN: 10,
    credit: 'NYC Department of Finance',
  };
}
const meta = metaFor();

// ── fetching ────────────────────────────────────────────────────────────────
const notYet = m => Object.assign(new Error(m), { code: 'UPSTREAM_NOT_YET_PUBLISHED' });
// A small SODA answer (counts, versions, dates): a question, not data, so it
// goes through the paced fetch but not the downloader (no cache, no
// provenance). null when --frozen.
async function ask(ctx, id, params) {
  if (ctx.frozen) return null;
  const res = await politeFetch(`${SODA}/${id}.json?${new URLSearchParams(params)}`, { headers: { 'user-agent': ctx.UA || UA }, signal: AbortSignal.timeout(60_000) }, ctx.log);
  if (!res.ok) throw new Error(`${id}: HTTP ${res.status} for ${JSON.stringify(params)}`);
  return (await res.json())[0] || {};
}
// Every row of a query, PAGE rows at a time in a stable order. Each page is
// its own cached file, named by the data version in `stem`, so a new release
// is a new file rather than a stale cache hit. --frozen (no `expect`): the
// most recently fetched page set whose name starts with `stem`.
async function pages(ctx, id, stem, params, { expect = null, maxAgeH = 24 } = {}) {
  if (ctx.frozen) stem = frozenStem(ctx, stem);
  const out = [];
  for (let i = 0; ; i++) {
    const u = `${SODA}/${id}.csv?${new URLSearchParams({ ...params, $order: params.$order || ':id', $limit: String(PAGE), $offset: String(i * PAGE) })}`;
    const file = `${stem}-p${i}.csv`;
    const recs = ctx.readers.records(await ctx.download(file, u, { maxAgeH, timeoutMs: 300_000 }));
    // A page that is not the query's CSV (an error page served with HTTP 200)
    // is forgotten, so the next run asks again rather than reading it from
    // the cache for days.
    const cols = params.$select.split(',');
    if ((i === 0 && !recs.length) || (recs.length && cols.some(c => !(c in recs[0])))) {
      ctx.discard?.(file);
      throw new Error(i === 0 && !recs.length ? `${id}: the first page is empty — the query or the dataset changed`
        : `${id} has no column "${cols.find(c => !(c in recs[0]))}" in ${file} — the schema changed`);
    }
    out.push(...recs);
    if (recs.length < PAGE) break;
  }
  if (expect != null && out.length !== expect) throw new Error(`${id}: read ${out.length} rows but the dataset says ${expect} — it changed while being read`);
  return out;
}
function frozenStem(ctx, prefix) {
  const hits = readdirSync(ctx.rawDir).filter(f => f.startsWith(prefix) && f.endsWith('-p0.csv'))
    .map(f => ({ stem: f.slice(0, -'-p0.csv'.length), t: statSync(join(ctx.rawDir, f)).mtimeMs })).sort((a, b) => b.t - a.t);
  if (!hits.length) throw new Error(`--frozen: no ${prefix}*-p0.csv in ${ctx.rawDir}`);
  return hits[0].stem;
}

// `months` and `lag` exist to measure other windows (12 against 24 months); the
// build always takes the defaults.
export async function fetchSales(ctx, { months = WINDOW_MONTHS, lag = LAG_MONTHS } = {}) {
  const t0 = Date.now();
  // 1. The rolling file.
  const info = await ask(ctx, DS.rolling, { $select: 'min(sale_date) AS lo, max(sale_date) AS hi, count(*) AS n' });
  if (info && !(/^\d{4}-\d{2}/.test(info.lo || '') && /^\d{4}-\d{2}/.test(info.hi || '') && +info.n > 0)) throw new Error(`${DS.rolling}: no sale dates (${JSON.stringify(info)})`);
  const stem = info ? `nyc-dof-rolling-${info.lo.slice(0, 7)}-${info.hi.slice(0, 7)}-${info.n}` : 'nyc-dof-rolling-';
  const rolling = (await pages(ctx, DS.rolling, stem, { $select: 'borough,block,lot,building_class_at_time_of,sale_price,sale_date' }, { expect: info ? +info.n : null }))
    .map(r => saleRow({ borough: r.borough, block: r.block, lot: r.lot, cls: r.building_class_at_time_of, price: r.sale_price, date: r.sale_date }, DS.rolling));
  // The file is 12 whole months, each with thousands of rows. A stray early
  // or future date would move the window, or leave a month to the few rows
  // the rolling file happens to hold: refuse it rather than build on it.
  const perMonth = new Map();
  for (const r of rolling) perMonth.set(r.date.slice(0, 7), (perMonth.get(r.date.slice(0, 7)) || 0) + 1);
  const seen = [...perMonth.keys()].sort();
  const rollingFrom = seen[0], latest = seen[seen.length - 1];
  const thin = seen.filter(m => perMonth.get(m) < 1000);
  if (addMonths(rollingFrom, 11) < latest || thin.length || latest > new Date().toISOString().slice(0, 7)) {
    throw new Error(`${DS.rolling}: sales ${rollingFrom}..${latest}${thin.length ? `, with only ${thin.map(m => `${perMonth.get(m)} in ${m}`).join(', ')}` : ''} — not the 12 whole months DOF publishes`);
  }
  const rollingAsOf = ctx.provenance.findLast(p => p.file.startsWith('nyc-dof-rolling-'))?.lastModified;
  const win = windowFor(latest, months, lag);
  ctx.log(`  ${DS.rolling}: ${rolling.length} rows, sales ${rollingFrom}..${latest}; window ${win.from}..${win.to} (${months} months, ${lag} month(s) of recording lag)`);

  // 2. Window months before the rolling file, from DOF's annualized workbooks
  //    (read from the window's first month: see THE WINDOW in the header).
  const early = [], annual = [];
  if (win.from < rollingFrom) {
    const last = addMonths(rollingFrom, -1);
    for (let y = +win.from.slice(0, 4); y <= +last.slice(0, 4); y++) {
      const got = await annualYear(ctx, y);
      annual.push({ year: y, asOf: got.asOf });
      for (const r of got.rows) if (r.date.slice(0, 7) >= win.from && r.date.slice(0, 7) <= last) early.push(r);
    }
    ctx.log(`  annualized ${annual.map(a => a.year).join(', ')}: ${early.length} rows for ${win.from}..${last}`);
  }

  // 3. Where each lot is. Only lots that can become a sale are looked up.
  const rows = [...early, ...rolling];
  const wanted = new Set();
  for (const r of rows) if (saleType(r.cls) && r.price >= MIN_PRICE) { r.bbl = bblOf(r.boro, r.block, r.lot); wanted.add(r.bbl); }
  // Condominium units first: their billing and base lots are then looked up
  // in PLUTO with every other wanted lot.
  const { unitOf, billing } = await condoLookup(ctx, wanted);
  const lots = new Set(wanted);
  for (const u of unitOf.values()) { lots.add(u.base); if (billing.has(u.key)) lots.add(billing.get(u.key)); }
  const { point, version } = await plutoPoints(ctx, lots);
  const how = { lot: 0, condo: 0 };
  const locate = r => {
    let at = point.get(r.bbl);
    if (at) { how.lot++; return at; }
    const u = unitOf.get(r.bbl);
    at = u && (point.get(billing.get(u.key)) || point.get(u.base));
    if (at) { how.condo++; return at; }
    return null;
  };

  // 4. The filter.
  const { sales, dropped } = filterSales(rows, { locate });
  const bad = sales.filter(s => !(s.lat > 40.4 && s.lat < 41 && s.lng > -74.3 && s.lng < -73.6));
  if (bad.length) throw new Error(`${bad.length} sale(s) placed outside New York City (e.g. ${bad[0].lat},${bad[0].lng}) — a coordinate column changed`);
  if (sales.length < 2000 * months) throw new Error(`only ${sales.length} sales kept for ${months} months — New York City has about 3,500 a month; the data or a filter changed`);
  const types = {};
  for (const s of sales) types[s.type] = (types[s.type] || 0) + 1;
  ctx.log(`  ${ID}: ${rows.length} rows in; kept ${sales.length} (${Object.entries(types).map(([k, v]) => `${k} ${v}`).join(', ')}); ` +
    `dropped ${Object.entries(dropped).map(([k, v]) => `${k} ${v}`).join(', ')}; placed at the lot ${how.lot}, condo unit at its building ${how.condo}; ` +
    `${((Date.now() - t0) / 1000).toFixed(1)}s`);

  // The Digital Tax Map's version: Socrata's Last-Modified on its pages is the
  // table's own last update (the later of the two tables).
  const taxMapAsOf = ctx.provenance.filter(p => /^nyc-dtm-/.test(p.file) && p.lastModified).map(p => Date.parse(p.lastModified)).filter(Number.isFinite).sort((a, b) => a - b).pop();
  if (months === WINDOW_MONTHS && lag === LAG_MONTHS) Object.assign(meta, metaFor({ rollingAsOf, annual, plutoVersion: version, taxMapAsOf: taxMapAsOf && new Date(taxMapAsOf).toISOString() }));
  return {
    vintage: `${win.from}..${win.to}`,     // the build finds the same window from the sales and `through`
    through: latest,                         // DOF: "All Sales From <12 months back> - <latest>"
    covers: { juris: ['US-NY'], counties: Object.values(COUNTY).sort() },
    sales,
    dropped,
  };
}

// One calendar year of DOF's annualized workbooks, all five boroughs. A year
// DOF has not posted yet (404) is not an error of ours: the build keeps the
// published tiles until it is.
async function annualYear(ctx, y) {
  const rows = [];
  let asOf = null;
  for (const [b, name] of Object.entries(WORKBOOK)) {
    const file = `nyc-dof-annualized-${y}-${name}.xlsx`;
    let buf;
    try { buf = await ctx.download(file, `${ANNUAL}/${y}/${y}_${name}.xlsx`, { maxAgeH: 24 * 30, timeoutMs: 300_000 }); }
    catch (e) {
      if (/HTTP 404/.test(e.message)) throw notYet(`DOF has not posted its ${y} annualized sales yet (${y}_${name}.xlsx: 404), and the ${WINDOW_MONTHS}-month window needs them`);
      throw e;
    }
    const got = readWorkbook(ctx, buf, y, +b, file);
    rows.push(...got.rows);
    asOf = asOf && asOf > got.asOf ? asOf : got.asOf;
  }
  return { rows, asOf };
}

// DOF's workbook layout: a few title lines ("All Sales From January 2025 -
// December 2025. Property Tax System (PTS) data as of 05/04/2026."), then a
// header row, then one row per sale with SALE DATE as an Excel serial day.
export function readWorkbook(ctx, buf, y, boro, file) {
  const sheet = ctx.readers.xlsx(buf).rows(0);
  const title = sheet.slice(0, 10).map(r => String(r?.[0] ?? '')).join(' ');
  if (!title.includes(`January ${y} - December ${y}`)) throw new Error(`${file}: the title does not say it holds January-December ${y} — the layout changed`);
  const m = /data as of (\d{2})\/(\d{2})\/(\d{4})/.exec(title);
  if (!m) throw new Error(`${file}: no "data as of" date in the title — the layout changed`);
  const recs = ctx.readers.sheetRecords(sheet, h => h.includes('SALE PRICE') && h.includes('BLOCK'),
    ['BOROUGH', 'BLOCK', 'LOT', 'BUILDING CLASS AT TIME OF SALE', 'SALE PRICE', 'SALE DATE'], file);
  const rows = [];
  for (const r of recs) {
    if (!/^\d+(\.\d+)?$/.test(r['SALE DATE'])) throw new Error(`${file}: SALE DATE "${r['SALE DATE']}" is not an Excel date — the layout changed`);
    const row = saleRow({ borough: r.BOROUGH, block: r.BLOCK, lot: r.LOT, cls: r['BUILDING CLASS AT TIME OF SALE'], price: r['SALE PRICE'], date: excelDate(r['SALE DATE']) }, file);
    if (row.boro !== boro || row.date.slice(0, 4) !== String(y)) throw new Error(`${file}: a row for borough ${row.boro} on ${row.date} — the file is not what its name says`);
    rows.push(row);
  }
  if (rows.length < 1000) throw new Error(`${file}: only ${rows.length} sales — DOF's borough files hold several thousand`);
  return { rows, asOf: `${m[3]}-${m[1]}-${m[2]}` };
}

// The Digital Tax Map's condominium tables: unit lot -> its condominium
// (base BBL + condominium key), and condominium key -> billing lot.
async function condoLookup(ctx, wanted) {
  const u = await ask(ctx, DS.units, { $select: 'count(*) AS n' });
  const c = await ask(ctx, DS.condos, { $select: 'count(*) AS n' });
  const unitRecs = await pages(ctx, DS.units, `nyc-dtm-condo-units-${u ? u.n : ''}`, { $select: 'unit_bbl,condo_base_bbl,condo_base_bbl_key' }, { expect: u ? +u.n : null, maxAgeH: 24 * 7 });
  const condoRecs = await pages(ctx, DS.condos, `nyc-dtm-condos-${c ? c.n : ''}`, { $select: 'condo_base_bbl_key,condo_billing_bbl' }, { expect: c ? +c.n : null, maxAgeH: 24 * 7 });
  const unitOf = new Map();
  for (const r of unitRecs) {
    const bbl = normBbl(r.unit_bbl);
    if (bbl && wanted.has(bbl)) unitOf.set(bbl, { key: r.condo_base_bbl_key, base: normBbl(r.condo_base_bbl) });
  }
  const billing = new Map();
  for (const r of condoRecs) { const b = normBbl(r.condo_billing_bbl); if (b) billing.set(r.condo_base_bbl_key, b); }
  if (unitRecs.length < 200_000 || billing.size < 10_000) throw new Error(`the Digital Tax Map condominium tables look short (${unitRecs.length} units, ${billing.size} billing lots)`);
  return { unitOf, billing };
}

// PLUTO: lot -> [lat, lng] for the wanted lots. The cache is named by PLUTO's
// version, which changes a few times a year.
async function plutoPoints(ctx, wanted) {
  const v = await ask(ctx, DS.pluto, { $select: 'max(version) AS v, count(*) AS n' });
  if (v && !/^\w+$/.test(v.v || '')) throw new Error(`${DS.pluto}: no version (${JSON.stringify(v)})`);
  const stem = ctx.frozen ? frozenStem(ctx, 'nyc-pluto-') : `nyc-pluto-${v.v}`;
  const recs = await pages(ctx, DS.pluto, stem, { $select: 'bbl,latitude,longitude', $order: 'bbl' }, { expect: v ? +v.n : null, maxAgeH: 24 * 30 });
  if (recs.length < 800_000) throw new Error(`${DS.pluto}: only ${recs.length} lots — PLUTO has about 858,000`);
  const point = new Map();
  for (const r of recs) {
    const bbl = normBbl(r.bbl);
    if (!bbl) throw new Error(`${DS.pluto}: bbl "${r.bbl}" is not a BBL — the format changed`);
    if (!wanted.has(bbl)) continue;
    const lat = r.latitude === '' ? NaN : +r.latitude, lng = r.longitude === '' ? NaN : +r.longitude;
    if (Number.isFinite(lat) && Number.isFinite(lng)) point.set(bbl, [lat, lng]);
  }
  return { point, version: stem.slice('nyc-pluto-'.length) };
}

export default {
  id: ID,
  kind: 'point-sales',
  regions: ['nyc'],
  cadence: 'monthly',            // DOF reissues the rolling file each month; the build fetches every run
  geometry: 'acs-tract',         // aggregated onto acs-tract's NYC tract polygons
  meta,
  fetch: ctx => fetchSales(ctx),
};
