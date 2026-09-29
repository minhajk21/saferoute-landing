// Minneapolis: recorded home SALE PRICES from Hennepin County's "County
// Parcels" layer (Hennepin GIS Open Data, item 7975aabf6e1e42998a40a4b085ffefdf
// = gis.hennepin.us HennepinData/LAND_PROPERTY MapServer layer 1), returned as
// individual sales for the orchestrator to aggregate onto the census tracts
// acs-tract already draws for the region (kind 'point-sales', SPEC2 §B).
//
// LICENCE (re-verified live 29 Sep 2026). The county's open-data hub
// (gis-hennepin.hub.arcgis.com, site 05cd4c5c…, whose catalog group 1b0a12ae…
// holds County Parcels) says on its Open Data page that it "offers spatial
// data to the public free of charge and without need for a license". That
// rests on County Board Resolution 14-0036 (Feb 2014), which makes county GIS
// data available "without charge or licensure" in place of the old
// conditional licence agreement. The layer's own licence text and its
// metadata's "Use Constraints" are a warranty disclaimer only (as is, no
// warranty, not for legal or survey use, no county liability). It is a
// waiver, not a grant that names commercial use: treated as NYC's "no licence
// required" is (SPEC2 §A); the phase-2 report's draft D11 asks for it in
// writing if SafeRoute ever sells something. Credit, as the item gives it:
// Hennepin County GIS, Survey Division and Property Tax.
//
// WHAT THE LAYER IS. One polygon per tax parcel (condominium units are stacked
// polygons with their own parcel ids), with attributes from the county's
// monthly property-tax extract, among them the parcel's LAST sale only:
// SALE_DATE ("Date of Last Sale", a 'YYYYMM' month, no day), SALE_PRICE,
// SALE_CODE / SALE_CODE_NAME ("Sale Transaction Type"), the property type of
// up to four tax subrecords (PR_TYP_CD1…4), and LAT / LON, "Latitude (Y) /
// Longitude (X) of parcel centroid (SRID 4326)". So:
//   - Each sale is placed at the county's own published parcel centroid; no
//     join, no geocode.
//   - LAST SALE PER PARCEL, NOT A TRANSACTION LOG. A parcel sold twice in the
//     window counts once, at its later price; a parcel sold in the window and
//     again later (even after the window, before the extract, and by any
//     transfer) is not in the window at all; no parcel's older sales can be
//     seen. One extract cannot tell a superseded sale from a change in the
//     market's volume, so the share is estimated, not measured: in the
//     extract of Sept 2026 (newest month Aug 2026), on the sales kept here,
//     the year Aug 2024 – Jul 2025 holds 8.6% FEWER last sales than the year
//     after it countywide (11,587 vs 12,672) and 1.3% MORE in the region's
//     Hennepin tracts (4,819 vs 4,757). Neither is a bound: closings in
//     Minneapolis FELL about 4% over those years (Minneapolis Area REALTORS,
//     4,183 to 4,011), so the flat count there still hides roughly 3% a year
//     of age. A stand-in with a full log (Denver's transfers table,
//     tools/prices/parked/denver-sales.mjs, Sept 2026) says a last-sale feed
//     hides about 9% of a 12-month window's sales (12–14% of its oldest
//     months; about 6% once double closings are set aside) and raises tract
//     medians slightly (median +1.5%, 90th percentile +7%), since what is lost
//     is often a quick resale's first, lower, price. Stated in the notes; 12
//     months keeps it small (a 24-month window's sales are twice as old).
//   - Month precision: a sale is dated the 1st of its month. The build's
//     window is whole months either way (lib/sales.mjs), and a month dated
//     the 1st is never taken as complete on the strength of its own date.
//
// WHAT COUNTS AS A SALE, in the order classify() applies it; every row read
// lands in exactly one `dropped` bucket or is returned as a sale:
//   badDate        SALE_DATE not a real 'YYYYMM' (the query cannot return
//                  one; counted rather than trusted).
//   nonResidential the first subrecord's property type is not a home:
//                  apartments (4+ units), commercial, industrial, farm, vacant
//                  land, seasonal-recreational cabins, low-income rental,
//                  common areas, utilities, and the county's unnamed codes.
//                  An UNKNOWN code throws (format drift, never a guess).
//   notAHome       CONDO GARAGE/MISCELLANEOUS: a garage stall or storage unit.
//   cooperative    COOPERATIVE HOUSING, or a parcel the county marks as a
//                  co-op master or unit: a co-op apartment is a share, not
//                  real property, and its sale is not the parcel's.
//   mixedUse       a home whose other subrecords include a non-home use
//                  (shops, offices, apartments, farm): the price is not a
//                  home's alone. A second subrecord of vacant residential
//                  land, a garage stall or common area does not count.
//   the sale code (SALE_CODE, the county's): only W "WARRANTY DEED" and C
//                  "CONTRACT FOR DEED" are kept. Dropped: R "EXCLUDED FROM
//                  RATIO STUDIES" (excludedFromRatioStudy: the assessor's own
//                  screen for sales that are not open-market sales, which the
//                  county applies over the deed type), M "SALE INCLUDES MORE
//                  THAN ONE PARCEL" (multiParcel), L "VACANT LAND"
//                  (vacantLand), Q "QUIT CLAIM DEED" (quitClaim), P "PROBATE
//                  DEED" (probate), O "OTHER – SEE CERTIFICATE OF REAL ESTATE
//                  VALUE (CRV)" (otherDeed), blank (noSaleCode). An UNKNOWN
//                  code throws. "Other" deeds are left out because the layer
//                  does not say what they are (trustee's, personal
//                  representative's, limited warranty deeds…) and so cannot
//                  show that they are market sales; they are counted apart,
//                  not as non-arm's-length. Measured Sept 2026, Aug 2025 –
//                  Jul 2026: 1,786 home sales countywide (12% of those the
//                  assessor did not exclude), median $457k against $390k for
//                  the 12,650 kept; in the region's tracts, keeping them
//                  would add 607 sales (13%) and move the median of tract
//                  medians from $350k to $344k (tracts: middle 80% within
//                  -5% / +3%, extremes -16% / +18%).
//   nominal        price missing or under $10,000 (SPEC2 §C).
//   implausiblePrice $20 million or more: a recording error, not a home's
//                  price. Measured Sept 2026: one warranty-deed house at over
//                  $200 million in 24 months; the next highest kept sale
//                  countywide was under $10 million.
//   noLocation     LAT / LON missing, or outside the county's own published
//                  extent (metadata bounding box).
//   duplicate      a parcel id read twice (none in Sept 2026; a guard for a
//                  layer reloaded between pages, which also throws below).
// The build then drops, and counts, sales dated after the build day, outside
// the window, outside every tract, and in the region's Ramsey and Anoka
// tracts (outside `covers`), which keep acs-tract on the region's second
// scale key.
//
// THE WINDOW is by month of sale (window.by 'sale'): the build takes 12
// months ending at the latest complete month (lib/sales.mjs saleWindow).
// This source returns `through`, a MEASURED month, not the publisher's
// statement: the newest month in the extract is always part-recorded (Aug
// 2026 in the Sept 2026 extract: 682 kept sales against 1,178 a year before,
// 58%; the county's extract lags recordings by weeks), so `through` is the
// month before it, stepped back (with a warning, at most MAX_STEP months) while
// that month holds fewer than COMPLETE_SHARE of the kept sales of the same
// month a year earlier, countywide. Jul 2026 held 1,388 against 1,188 (117%;
// in the region's tracts 514 against 483), so the window is Aug 2025 – Jul
// 2026, lagMonths 0. The line sits in a wide gap: complete months read 90–120%
// of their year-older selves (Jan 2026 the lowest, at 90%; a year-older month
// has lost some sales to the last-sale rule, above), the part-recorded newest
// month 58%.
// The kept sales of the months read for that test (the MAX_STEP + 1 months
// before the window's first) and of the part-recorded newest month are handed
// to the build, which counts them as out of window.
//
// COVERS: Hennepin County (27053) whole: the layer is every parcel in the
// county. The Minneapolis rectangle also takes in 15 Ramsey (27123) and 7
// Anoka (27003) tracts (acs-tract, Sept 2026): they stay owners' estimates on
// 'minneapolis-outer' (tools/prices/regions.mjs).
//
// HOST. gis.hennepin.us is the county's self-hosted ArcGIS Server (answered
// this Mac 29 Sept 2026: 15 pages of 2,000 rows in about 5 s). Self-hosted
// county hosts have refused datacenter IPs in this project. No ArcGIS Online
// copy of County Parcels exists to fall back to (searched 29 Sept 2026: the
// county's other AGOL items named for parcels are special-purpose layers,
// right-of-way, racial covenants, a transit line; the Hub's CSV export is a
// cache built from this server). So a refusal is a failed fetch, and the
// build re-emits the last published tiles with its warning.
//
// PRIVACY (SPEC2 §B.5–6): only the fields the filter needs are requested:
// never an owner, taxpayer, address, legal description or value. The parcel
// id is read for the duplicate check and never leaves this module; a sale
// carries only lat, lng, price, date and type, and the orchestrator publishes
// tract aggregates only.

import { createHash } from 'node:crypto';

const ID = 'hennepin-sales';
const REGIONS = ['minneapolis'];
const COUNTY = '27053';
const LAYER = 'https://gis.hennepin.us/arcgis/rest/services/HennepinData/LAND_PROPERTY/MapServer/1';
const ITEM = '7975aabf6e1e42998a40a4b085ffefdf';
const HUB = 'https://gis-hennepin.hub.arcgis.com';
const PAGE = 2000;                           // the layer's maxRecordCount
const MAX_AGE_H = 24;                        // a monthly extract; a rerun the same day reuses the pages
const WINDOW = { months: 12, by: 'sale', lagMonths: 0 };
const MAX_STEP = 2;                          // months `through` may step back from the newest month's predecessor
const COMPLETE_SHARE = 0.8;                  // of the same month a year earlier (see THE WINDOW)
const STALE_MONTHS = 3;                      // a newest month older than this: the monthly extract has stalled (warn)
const MIN_PRICE = 10_000, MAX_PRICE = 20_000_000;
// The county's published extent (metadata bounding coordinates), [s, w, n, e].
const EXTENT = [44.555, -94.01, 45.386, -92.478];

// Property type codes (PR_TYP_CD, trimmed: the layer pads some to two
// characters) -> the type a sale carries. All the county's; the names are its
// PR_TYP_NM. R, RL, D, RM and B are all named "RESIDENTIAL".
export const HOME = {
  R: 'house', RL: 'house', D: 'house', RM: 'house', B: 'house', RZ: 'house',   // RESIDENTIAL…, RESIDENTIAL-ZERO LOT LINE
  X: 'condo', Y: 'townhouse',                                                  // CONDOMINIUM, TOWNHOUSE
  DB: '2-3 unit', TP: '2-3 unit',                                              // RESIDENTIAL-TWO UNIT, TRIPLEX
};
export const NOT_A_HOME = new Set(['XM']);                                     // CONDO GARAGE/MISCELLANEOUS
export const COOPERATIVE = new Set(['XC']);                                    // COOPERATIVE HOUSING
// Every other code in the layer (all 448,090 parcels, all four subrecords,
// Sept 2026; FH and LM occur only in later subrecords). '' = blank.
export const NON_RESIDENTIAL = new Set([
  '', 'A', 'AX', 'C', 'CR', 'F', 'FF', 'FH', 'FM', 'FP', 'GC', 'HF', 'HL', 'HR', 'HT', 'HX', 'HY', 'I', 'K',
  'LA', 'LC', 'LF', 'LI', 'LL', 'LM', 'LR', 'LV', 'ME', 'MH', 'NC', 'ND', 'NH', 'NI', 'NP', 'S', 'SC', 'SL', 'SM', 'U',
]);
// A second-to-fourth subrecord that does not make a home a mixed use: another
// home type, vacant residential land (a side lot), a garage stall, common area.
const WITH_A_HOME = new Set([...Object.keys(HOME), 'LR', 'LL', 'LV', 'XM', 'K']);
// SALE_CODE -> the reason a sale is dropped, or null when it is kept.
export const SALE_CODES = {
  W: null, C: null,                           // WARRANTY DEED, CONTRACT FOR DEED
  R: 'excludedFromRatioStudy', M: 'multiParcel', L: 'vacantLand', Q: 'quitClaim', P: 'probate', O: 'otherDeed', '': 'noSaleCode',
};

const meta = {
  name: 'County Parcels (last sale of each parcel), Hennepin County, via Hennepin GIS Open Data',
  publisher: 'Hennepin County',
  // The hub serves a layer's page at <item>_<layer> (the bare item id 404s
  // to a plain request, 29 Sep 2026).
  url: `${HUB}/datasets/${ITEM}_1`,
  licence: 'Hennepin GIS Open Data: free of charge, no licence required (County Board Resolution 14-0036)',
  licenceUrl: `${HUB}/pages/open-data`,
  attribution: [
    'Source: Hennepin County GIS, Hennepin County Survey Division, Hennepin County Property Tax: County Parcels (Hennepin GIS Open Data). SafeRoute kept home sales only and turned them into census-tract medians.',
  ],
  credit: 'Hennepin County',
  metric: 'Median sale price',
  unitNoun: 'sales',
  currency: 'USD',
  // The build finds the window in the data and writes the period ("Sales
  // dated Aug 2025 – Jul 2026") and the area noun (acs-tract's).
  window: { ...WINDOW },
  notes: [
    'Sales of houses, townhouses, condominiums and two- and three-unit homes in Hennepin County, by each property’s type on the county’s tax records. ' +
      'Co-op apartments, garage and storage units, apartment and low-income rental buildings, vacant land, seasonal cabins, properties that are partly shops, offices or farmland, and property types the county does not name are not included.',
    'Only warranty-deed and contract-for-deed sales are counted. Sales the county excludes from its sales-ratio studies (its check that a sale was an open-market sale), ' +
      'sales of several parcels for one price, sales of vacant land, quit-claim and probate deeds, sales under $10,000 and prices of $20 million or more (recording errors) are left out.',
    'Sales on other kinds of deed are left out too, because the county’s records do not say which kind (a trustee’s, a personal representative’s or a limited warranty deed, for example), even where the county did not exclude the sale from its ratio studies. ' +
      'From Aug 2025 to Jul 2026 they were about one in eight of the county’s home sales, and countywide they sold for more than the rest (a median of about $457,000 against $390,000). ' +
      'In the Minneapolis tracts, leaving them out moved most tracts’ figures by under 5%, a few by up to about a sixth either way, and raised the median of the tracts’ figures by about 2%.',
    'Hennepin County publishes only the most recent sale of each property. A home sold twice in the period counts once, at its later price, and one sold in the period and again since then (even by a transfer that is not a sale) is not counted at all, ' +
      'so these figures rest on fewer sales than took place, by a few percent (perhaps up to about one in ten), most in the earliest months. The sales missed are often a home’s earlier, lower price before a quick resale, so figures may lean slightly high.',
    'The county gives the month of each sale, not the day. The newest month is left out until the county’s monthly extract holds it in full. Each sale is placed at the centre of its parcel as the county publishes it.',
  ],
  colourMinN: 10,
};

// ── months ('YYYYMM' as the layer writes them) ──────────────────────────────
const idx = ym => +ym.slice(0, 4) * 12 + (+ym.slice(4, 6) - 1);
const ymOf = i => `${Math.floor(i / 12)}${String((i % 12) + 1).padStart(2, '0')}`;
export const isYm = s => typeof s === 'string' && /^(\d{4})(0[1-9]|1[0-2])$/.test(s) && +s.slice(0, 4) >= 1900;
// '202607' -> '2026-07-01': the contract wants a day; the county gives none.
export const isoOf = ym => `${ym.slice(0, 4)}-${ym.slice(4, 6)}-01`;
// This month in Minneapolis, 'YYYYMM'.
const CHI = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago', year: 'numeric', month: '2-digit' });
export const thisMonth = (ms = Date.now()) => CHI.format(new Date(ms)).replace('-', '');

// The first month read, for an extract whose newest sale month is `newest`:
// far enough back for the window at its most stepped-back `through`, and for
// the same months a year earlier, which the completeness test needs.
export const readFrom = (newest, months = WINDOW.months) => ymOf(idx(newest) - Math.max(months, 12) - 1 - MAX_STEP);

// `through` ('YYYY-MM'): the month before `newest`, stepped back while it
// holds fewer than COMPLETE_SHARE of the kept sales of the same month a year
// earlier. `count` maps 'YYYYMM' to kept sales. Returns { through, steps }.
export function completeThrough(newest, count) {
  for (let s = 0; s <= MAX_STEP; s++) {
    const m = idx(newest) - 1 - s, now = count[ymOf(m)] || 0, before = count[ymOf(m - 12)] || 0;
    if (!before) throw new Error(`${ID}: no kept sales in ${ymOf(m - 12)} to judge ${ymOf(m)} by — the read or the filter is broken`);
    if (now >= COMPLETE_SHARE * before) { const t = ymOf(m); return { through: `${t.slice(0, 4)}-${t.slice(4, 6)}`, steps: s }; }
  }
  throw new Error(`${ID}: none of the ${MAX_STEP + 1} months before ${newest} holds ${Math.round(COMPLETE_SHARE * 100)}% of its sales of a year earlier — the extract looks incomplete`);
}

// ── the filter (pure; tools/prices/test/hennepin-sales.test.mjs) ────────────
const code = v => String(v ?? '').trim().toUpperCase();
function typeClass(c) {
  if (HOME[c]) return 'home';
  if (NOT_A_HOME.has(c)) return 'notAHome';
  if (COOPERATIVE.has(c)) return 'cooperative';
  if (NON_RESIDENTIAL.has(c)) return 'nonResidential';
  throw new Error(`${ID}: property type code "${c}" is not one this module knows — the format changed`);
}

// row: the layer's attributes as queried. Returns { drop: '<reason>' } or
// { sale: { lat, lng, price, date, type } }. Duplicates are reduceSales()'s;
// the window and future dates are the build's.
export function classify(row) {
  if (!isYm(row.SALE_DATE)) return { drop: 'badDate' };
  const t = code(row.PR_TYP_CD1), k = typeClass(t);
  if (k !== 'home') return { drop: k };
  if (['M', 'U'].includes(code(row.CO_OP_IND))) return { drop: 'cooperative' };
  for (const f of ['PR_TYP_CD2', 'PR_TYP_CD3', 'PR_TYP_CD4']) {
    const c = code(row[f]);
    if (c && !WITH_A_HOME.has(c)) { typeClass(c); return { drop: 'mixedUse' }; }
  }
  const sc = code(row.SALE_CODE);
  if (!(sc in SALE_CODES)) throw new Error(`${ID}: sale code "${sc}" (${row.SALE_CODE_NAME ?? 'no name'}) is not one this module knows — the format changed`);
  if (SALE_CODES[sc]) return { drop: SALE_CODES[sc] };
  const price = row.SALE_PRICE;
  if (!(Number.isFinite(price) && price >= MIN_PRICE)) return { drop: 'nominal' };
  if (price >= MAX_PRICE) return { drop: 'implausiblePrice' };
  const lat = row.LAT, lng = row.LON;
  if (!(Number.isFinite(lat) && Number.isFinite(lng) && lat >= EXTENT[0] && lat <= EXTENT[2] && lng >= EXTENT[1] && lng <= EXTENT[3])) return { drop: 'noLocation' };
  return { sale: { lat, lng, price, date: isoOf(row.SALE_DATE), type: HOME[t] } };
}

// Every row through classify(), plus duplicates, so the counts always add up
// to the rows read. `ym` of each kept sale is returned alongside for the
// completeness test (never to the build).
export const DROP_REASONS = ['badDate', 'nonResidential', 'notAHome', 'cooperative', 'mixedUse',
  'excludedFromRatioStudy', 'multiParcel', 'vacantLand', 'quitClaim', 'probate', 'otherDeed', 'noSaleCode',
  'nominal', 'implausiblePrice', 'noLocation', 'duplicate'];
export function reduceSales(rows) {
  const dropped = Object.fromEntries(DROP_REASONS.map(k => [k, 0]));
  const sales = [], count = {}, seen = new Set();
  for (const r of rows) {
    const pid = String(r.PID ?? '').trim();
    if (pid && seen.has(pid)) { dropped.duplicate++; continue; }
    if (pid) seen.add(pid);
    const c = classify(r);
    if (c.drop) { dropped[c.drop]++; continue; }
    sales.push(c.sale);
    count[r.SALE_DATE] = (count[r.SALE_DATE] || 0) + 1;
  }
  return { sales, dropped, count };
}

// ── ArcGIS ──────────────────────────────────────────────────────────────────
const sha = s => createHash('sha256').update(s).digest('hex');
const FIELDS = ['OBJECTID', 'PID', 'SALE_DATE', 'SALE_PRICE', 'SALE_CODE', 'SALE_CODE_NAME', 'PR_TYP_CD1', 'PR_TYP_CD2', 'PR_TYP_CD3', 'PR_TYP_CD4', 'CO_OP_IND', 'LAT', 'LON'];

// One query answer. ArcGIS answers a bad query with HTTP 200 and an {error}
// body, and a firewall with an HTML page: either is discarded from the cache
// before failing, so the next run asks again. A server busy for a moment
// answers a good query the same way ({"error": "Cannot perform query"} on
// ArcGIS Online, 29 Sep 2026; a timeout or a 5xx on a self-hosted server), so
// a failed question is asked ONCE more, after a pause, before the source
// fails (ctx retries only 429/503; denver-sales does the same). Never under
// --frozen: the cache cannot change, and the bad file is the evidence.
// A self-hosted server that answers every question slowly (up to the 180 s
// timeout each) must not hold the whole monthly job past its 45 minutes: past
// the budget the source fails alone and the other sources still publish.
// `count`: a returnCountOnly answer ({ count }) rather than features.
// timing: the pause before the second try and the budget of one fetch
// (exported so the tests can shorten them).
export const timing = { retryMs: 10_000, budgetMs: 12 * 60_000 };
let deadline = Infinity;
async function ask(ctx, params, file, { count = false } = {}) {
  const url = `${LAYER}/query?${new URLSearchParams({ ...params, ...(count ? {} : { returnGeometry: 'false' }), f: 'json' })}`;
  const name = file || `${ID}-${sha(url).slice(0, 10)}.json`;
  for (let attempt = 1; ; attempt++) {
    if (Date.now() > deadline) throw new Error(`${ID}: still reading the parcels layer after ${timing.budgetMs / 60_000} minutes — the host is too slow this run`);
    try {
      const buf = await ctx.download(name, url, { maxAgeH: MAX_AGE_H, timeoutMs: 180_000 });
      let doc = null;
      try { doc = JSON.parse(buf.toString('utf8')); } catch {}
      if (!doc || doc.error || (count ? !Number.isInteger(doc.count) : !Array.isArray(doc.features))) {
        ctx.discard?.(name);
        dropRecords(ctx, name);   // not data: a second try's answer replaces it
        throw new Error(`${ID}: the parcels layer answered ${doc?.error ? `error ${doc.error.code}: ${doc.error.message}` : doc ? `without ${count ? 'a count' : 'a features list'}` : 'with something that is not JSON (a block page?)'}`);
      }
      return doc;
    } catch (e) {
      if (attempt > 1 || ctx.frozen) throw e;
      ctx.log(`  ${e.message}; asking once more in ${timing.retryMs / 1000}s`);
      await new Promise(r => setTimeout(r, timing.retryMs));
    }
  }
}
// The newest sale month on or before this month. The question names this
// month, so it is cached under one fixed name: a --frozen rebuild on a later
// day then finds the same answer instead of none (dc-cama-sales does the same).
async function newestMonth(ctx, today) {
  const doc = await ask(ctx, {
    where: `SALE_DATE <= '${today}' AND SALE_DATE >= '190001'`,
    outStatistics: JSON.stringify([{ statisticType: 'max', onStatisticField: 'SALE_DATE', outStatisticFieldName: 'newest' }]),
  }, `${ID}-newest.json`);
  dropRecords(ctx, `${ID}-newest.json`);   // a question, not data
  const n = doc.features[0]?.attributes?.newest;
  if (!isYm(n)) throw new Error(`${ID}: the newest sale month reads "${n}" — the layer changed`);
  return n;
}
const dropRecords = (ctx, file) => { for (let i = ctx.provenance.length - 1; i >= 0; i--) if (ctx.provenance[i].file === file) ctx.provenance.splice(i, 1); };

// Every parcel whose last sale is from `from` on, paged by OBJECTID, checked
// against the layer's own count for the same clause (asked first): pages read
// across the monthly reload can overlap (an OBJECTID twice) or SKIP rows, and
// a short read would otherwise pass every later check (its floor is half a
// normal month's sales). On a mismatch the count and every page are
// discarded and read once more (not under --frozen) before the source fails.
// One provenance record for the layer instead of one per page.
export async function saleRows(ctx, from) {
  const where = `SALE_DATE >= '${from}'`;
  for (let attempt = 1; ; attempt++) {
    const countFile = `${ID}-count-${sha(where).slice(0, 10)}.json`;
    const count = (await ask(ctx, { where, returnCountOnly: 'true' }, countFile, { count: true })).count;
    dropRecords(ctx, countFile);   // a check on the pages, not data
    const rows = [], first = ctx.provenance.length;
    for (let offset = 0, page = 0; ; page++) {
      if (page >= 60) throw new Error(`${ID}: more than 60 pages since ${from} — the query is wrong`);
      const doc = await ask(ctx, { where, outFields: FIELDS.join(','), orderByFields: 'OBJECTID', resultOffset: String(offset), resultRecordCount: String(PAGE) });
      for (const f of doc.features) rows.push(f.attributes);
      if (!doc.features.length || (!doc.exceededTransferLimit && doc.features.length < PAGE)) break;
      offset += doc.features.length;
    }
    const pages = ctx.provenance.splice(first);
    const distinct = new Set(rows.map(r => r.OBJECTID)).size;
    if (rows.length === count && distinct === rows.length) {
      ctx.provenance.push({
        file: 'Hennepin County Parcels (HennepinData/LAND_PROPERTY MapServer layer 1)', url: LAYER, item: ITEM, where,
        status: 200, etag: null, lastModified: null, queries: pages.length,
        fetchedAt: pages.map(p => p.fetchedAt).filter(Boolean).sort().pop() || null,
        // Every page from the raw cache: the build then dates the data by its
        // download, not by the build day.
        cached: pages.length > 0 && pages.every(p => p.cached),
        bytes: pages.reduce((a, p) => a + (p.bytes || 0), 0),
        sha256: sha(JSON.stringify(rows.map(r => FIELDS.slice(1).map(f => r[f])).sort())),
      });
      return rows;
    }
    const why = `${ID}: read ${rows.length} rows (${distinct} distinct) but the layer counts ${count} for ${where} — it was reloaded while being read, or answered part of a page`;
    for (const f of [countFile, ...pages.map(p => p.file)]) ctx.discard?.(f);
    if (attempt > 1 || ctx.frozen) throw new Error(`${why}; the next run reads it afresh`);
    ctx.log(`  ${why}; reading it again`);
  }
}

// ── fetch ───────────────────────────────────────────────────────────────────
// Also the measuring entry point: `months` overrides the module's window for
// the read (run-source compares 12 with 24 months on the same sales), and
// `inspect` is handed the rows and the filter's result.
export async function fetchSales(ctx, { months = WINDOW.months, today = thisMonth(), inspect = null } = {}) {
  const t0 = Date.now();
  deadline = t0 + timing.budgetMs;
  const served = REGIONS.map(id => ({ id, reg: ctx.regions?.[id] })).filter(r => r.reg);
  if (!served.length) throw new Error(`${ID}: none of ${REGIONS.join(', ')} is in coverage.json`);
  for (const { id, reg } of served) if (!reg.juris?.includes('US-MN')) throw new Error(`${ID}: region ${id} is not in Minnesota (juris ${reg.juris})`);

  const newest = await newestMonth(ctx, today);
  if (idx(today) - idx(newest) > STALE_MONTHS) ctx.warn(`${ID}: the newest sale month in the parcels layer is ${newest} — the county's monthly extract may have stalled`);
  const from = readFrom(newest, months);
  const rows = await saleRows(ctx, from);
  const { sales, dropped, count } = reduceSales(rows);
  const { through, steps } = completeThrough(newest, count);
  if (steps) ctx.warn(`${ID}: ${steps} month(s) before ${newest} still look part-recorded; the window ends ${through}`);
  inspect?.({ rows, sales, dropped, count, newest, from, through });

  // A fetch that looks wrong is a failed one (README house rule 8): the county
  // records about 1,000 kept home sales a month (600 in its slowest months).
  const lo = `${through.slice(0, 4)}${through.slice(5, 7)}`, inWin = Object.entries(count).filter(([m]) => idx(m) > idx(lo) - months && m <= lo).reduce((a, [, v]) => a + v, 0);
  if (inWin < 500 * months) throw new Error(`${ID}: only ${inWin} sales kept in the ${months} months to ${through} — the layer or the filter is broken`);
  if (dropped.noLocation > 0.05 * (sales.length + dropped.noLocation)) throw new Error(`${ID}: ${dropped.noLocation} sales have no parcel centroid — the layer changed`);

  const byType = {};
  for (const s of sales) byType[s.type] = (byType[s.type] || 0) + 1;
  ctx.log(`  ${ID}: ${rows.length} parcels with a last sale since ${from} (newest ${newest}, complete through ${through}); ` +
    `${sales.length} sales (${Object.entries(byType).map(([k, v]) => `${v} ${k}`).join(', ')}); ` +
    `dropped ${Object.entries(dropped).map(([k, v]) => `${k} ${v}`).join(', ')}; ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  return {
    // The layer is every parcel in Hennepin County, so its sales are complete
    // there; the region's Ramsey and Anoka tracts keep acs-tract.
    covers: { juris: ['US-MN'], counties: [COUNTY] },
    sales,
    dropped,
    through,
  };
}

export default {
  id: ID,
  kind: 'point-sales',
  regions: REGIONS,
  cadence: 'monthly',        // the county refreshes the layer from its monthly tax extract
  geometry: 'acs-tract',
  meta,
  fetch: ctx => fetchSales(ctx),
};
