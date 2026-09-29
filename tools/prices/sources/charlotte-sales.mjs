// Charlotte (all of Mecklenburg County): recorded home SALE PRICES from the
// City of Charlotte's "Parcel Look Up" table (ArcGIS item
// 3cf4a8c868f0476f897fed7e1e8e81c2, CC BY 4.0), placed at the parcel polygons
// of the City's "Parcels" layer (item 859c7065d49749ab894e119aac72ab87, CC BY
// 4.0), returned as individual sales for the orchestrator to aggregate onto
// the census tracts acs-tract draws for the region (kind 'point-sales',
// SPEC2 §B). Where it covers a tract, its "Median sale price" replaces
// acs-tract's owners' estimate.
//
// LAST SALE PER PARCEL, NOT A LOG OF SALES. The table holds one row per tax
// account (and building card) with that account's MOST RECENT transfer only:
// its date, price and deed type. So a home sold twice in the window counts
// once, at its later price, and ANY later transfer (a quitclaim to a spouse or
// a trust, a deed into a company) hides the sale before it. Older sales are
// invisible. The loss grows with a sale's age, so the oldest months of the
// window hold fewer sales than they had, and the window is kept to 12 months
// (see WINDOW). What is lost is not random: often a quick resale's first,
// lower, price, so the figures lean slightly high. The notes say both.
//
// LICENCE (re-verified 29 Sep 2026). Both items are owned by CharlotteNC, are
// public, and give licenseInfo https://creativecommons.org/licenses/by/4.0/;
// both are in the catalog group of the City's open data portal
// (data.charlottenc.gov), which adds no terms; the layers' own metadata holds
// no use constraint. The two map services' copyright texts are notices CC BY
// 4.0 §3(a)(1)(A)(ii) asks a user to keep, and the attribution keeps both:
// CLTEx_MoreInfo (the table) "City of Charlotte, Data and innovation Dept.",
// CLTEx_PopUps (Parcels) "Copyright(c) City of Charlotte, Mecklenburg
// County, NC" (read 29 Sep 2026; the county's co-claim is one more reason for
// the courtesy note below). fetch() re-reads both items every run and
// THROWS if either licence changes. Caveat: the table is built daily "using
// county parcel data", so the figures are Mecklenburg County's. The county's
// own Data Center page both allows redistribution and says the county "does
// not support secondary distribution"; we hold the City's copy under the
// City's licence, not the county's, and a courtesy note to the county is
// drafted (phase 2, D6). The county's own sales layer (full history, a
// sale-validity code) is NOT used: it carries the county's terms.
//
// WHAT COUNTS AS A SALE (SPEC2 §C), in the order reduceSales() applies it;
// every row read lands in exactly one `dropped` bucket or is returned:
//   noDate          no sale date.
//   duplicate       the same account, date and price again: an account with
//                   several building cards has one row per card.
//   noPropertyUse   the roll gives the parcel no property use (blank). Most
//                   are NEWLY BUILT homes sold by their builder before the
//                   county has assessed the house (building value 0, the
//                   house is added at the next 1 January valuation); the rest
//                   are vacant lots. They cannot be told apart from the
//                   county's own fields, so all are left out, and the notes
//                   say that new-build homes are under-counted.
//   nonResidential  a property use that is not a home: Multi-Family
//                   (apartment buildings), offices, shops, warehouses,
//                   hotels, government and institutional land, and business
//                   condominiums. An unknown property use THROWS.
//   fivePlusHomes   a home-use parcel whose building has five or more units.
//   otherDeed       any deed but a warranty (WD) or special warranty (SW)
//                   deed. The table has NO sale-validity (arm's-length) flag:
//                   the deed type is the only screen it offers. Quitclaim
//                   (QC) and non-warranty (NW) deeds are mostly $0 transfers
//                   between relatives, into trusts and out of estates;
//                   trustee's (TD), commissioner's (COMD), foreclosure (FOR)
//                   and sheriff's (SHF/D) deeds are forced sales; CD, DECL,
//                   ID, AF and R/W are corrections, declarations, affidavits
//                   and rights of way. A sale between relatives on a warranty
//                   deed at a real price still passes.
//   noDeedType      no deed type.
//   multiParcel     the county's own "ML" deed type (one conveyance of
//                   several lots, each row carrying the whole price: a
//                   median of $5.6 million on home-use parcels), or a WD/SW
//                   sale sharing its day, price and deed reference with
//                   another account's (the same conveyance: MULTI below).
//   nominal         a price under $10,000 (SPEC2 §C's floor): $0 and nominal
//                   considerations, which are not market prices.
//   splitPortfolio  three or more kept sales on one day at one price that is
//                   not a whole number of thousands: one price split evenly
//                   across properties (the Maryland rule).
//   noLocation      the account's parcel (PID) has no polygon in Parcels.
// The build then drops, and counts, sales dated after the build day, outside
// the window, and outside every tract.
//
// LOCATION is the official join only, never a geocode: the row's PID -> the
// Parcels polygon with that PID -> a point inside it (interiorPoint). A
// condominium unit's PID is its condominium's common parcel ("…C99"), so a
// unit is placed at its building, which is all a tract median needs, except
// where one complex's parcel straddles a tract line: all its sales then land
// in the tract that holds the point (17332C99, split about evenly between
// 37119003108 and 3109, puts its 10 sales in 3108; measured 29 Sep 2026, 12
// tracts differ between two reasonable choices of point). Said in the notes.
//
// THE WINDOW is by Sales_Date, the date of the sale on the county's record
// (window.by 'sale'); see WINDOW for the months and the completeness cutoff.
//
// HOST. Both layers are served only by the City's self-hosted ArcGIS Server,
// gis.charlottenc.gov (no ArcGIS Online copy exists; searched 29 Sep 2026),
// behind an F5 firewall that answers a URL longer than about 2,000 characters
// with an HTML "Request Rejected" page and HTTP 200. Every answer is checked
// to be the query's JSON, and one that is not is discarded from the cache
// before throwing. Self-hosted city ArcGIS hosts have refused datacenter IPs
// in this project before; the monthly job's runner is unproven here.
//
// PRIVACY (SPEC2 §B.5–6): only the fields the filters need are requested,
// never an owner, grantor, mailing address, street address or legal
// description; the sales carry lat, lng, price, date and a type, and none of
// them reaches a tile.

import { createHash } from 'node:crypto';

const ID = 'charlotte-sales';
const REGIONS = ['charlotte'];
const ITEM = {
  lookup: '3cf4a8c868f0476f897fed7e1e8e81c2',    // Parcel Look Up (CLTEx_MoreInfo table 4)
  parcels: '859c7065d49749ab894e119aac72ab87',   // Parcels (CLTEx_PopUps layer 3)
};
const LAYER = {
  lookup: 'https://gis.charlottenc.gov/arcgis/rest/services/CLT_Ex/CLTEx_MoreInfo/MapServer/4',
  parcels: 'https://gis.charlottenc.gov/arcgis/rest/services/CLT_Ex/CLTEx_PopUps/MapServer/3',
};
const AGOL_ITEM = id => `https://www.arcgis.com/sharing/rest/content/items/${id}?f=json`;
const LICENCE_URL = 'https://creativecommons.org/licenses/by/4.0/';
const COUNTY = '37119';            // Mecklenburg County, NC: all of it is in the table

// WINDOW (measured 29 Sep 2026 on 24 months of the table as read that day,
// against the 305 Mecklenburg tracts acs-tract ships):
//   months 12: Aug 2025 – Jul 2026 gives 289 tracts (95%) at least 10 sales,
//     10 with 3–9, 1 with 1–2 and 5 with none. 24 months would lift that
//     only to 295 (97%), while doubling how long a later transfer has to hide
//     a sale (LAST SALE above) and blending two years of prices.
//   The last-sale loss: Aug 2024 – Jul 2025 now holds 16,282 kept sales,
//   Aug 2025 – Jul 2026 16,721 (2.6% more), and each month from January to
//   July 2026 holds 99–103% of the same month a year earlier. That is an
//   estimate, not a bound (a change in the market's volume moves it too:
//   Canopy MLS put July 2026 closings up 3.4% on a year before): a further
//   year of later transfers hides roughly 3% of sales here. A stand-in with a
//   full log (Denver's transfers table, Sept 2026) says a last-sale feed
//   hides about 9% of a 12-month window's sales, 12–14% of its oldest
//   months, and raises tract medians slightly (median +1.5%).
//   COMPLETE_AFTER_DAYS 45: sales reach the table weeks after they close. On
//   29 Sep 2026 the newest sale was dated 23 Sep; against the same weeks of
//   2025 the second and third weeks of September held 75–78% of their sales
//   and August as a whole 91% (1,277 v 1,396), while every month from
//   January to July held 99–103%. So a month counts as complete once it
//   ended 45 days before the newest sale (`through`), and lagMonths stays 0.
//   For the monthly build on the 5th (newest sale about a week earlier) the
//   window ends three months before the build's month: a November build
//   ends it on August.
const WINDOW = { months: 12, by: 'sale', lagMonths: 0 };
const COMPLETE_AFTER_DAYS = 45;
const MIN_PRICE = 10_000;
const MAX_UNITS = 4;
const PAGE = 5000;                 // the table's maxRecordCount
const MAX_URL = 1900;              // the host's firewall rejects URLs past ~2,000 characters
const PARCELS_MAX_AGE_H = 24 * 7;  // parcel lines change slowly

// Property_Use on the roll -> the sale's type, or a known non-home use.
export const RESIDENTIAL = { 'Single-Family': 'single-family', 'Condo/Townhome': 'condo/townhome', Manufactured: 'manufactured' };
export const NON_RESIDENTIAL = new Set(['Multi-Family', 'Warehouse', 'Warehouse Lg', 'Warehouse Condo', 'Office', 'Office Condo', 'Commercial',
  'Commercial Condo', 'Medical Condo', 'Hotel/Motel', 'Govt-Inst', 'StadiumArena']);
export const KEEP_DEEDS = new Set(['WD', 'SW']);
export const MULTI_LOT_DEED = 'ML';

const meta = {
  name: 'Parcel Look Up (last recorded sale of each parcel), located through Parcels, City of Charlotte Open Data',
  publisher: 'City of Charlotte (from Mecklenburg County parcel data)',
  url: `https://data.charlottenc.gov/datasets/charlotte::parcel-look-up`,
  licence: 'Creative Commons Attribution 4.0 International (CC BY 4.0)',
  licenceUrl: LICENCE_URL,
  // CC BY 4.0 asks for the creator, any copyright notice supplied (each map
  // service's copyright text, word for word), the licence, a link to the
  // material (`url` for the table; the Parcels line names its page) and a
  // note of changes.
  attribution: [
    'Sales and property use: City of Charlotte, Data and Innovation Department, Parcel Look Up (built from Mecklenburg County parcel data), City of Charlotte Open Data, CC BY 4.0.',
    'Parcel boundaries: City of Charlotte, Parcels (data.charlottenc.gov/datasets/charlotte::parcels), City of Charlotte Open Data, CC BY 4.0. Copyright(c) City of Charlotte, Mecklenburg County, NC.',
    'Changed by SafeRoute: home sales on warranty deeds only, placed in their parcels and aggregated to census-tract medians.',
  ],
  metric: 'Median sale price',
  unitNoun: 'sales',
  currency: 'USD',
  window: { ...WINDOW },
  notes: [
    'Sales of single-family houses (including buildings of two to four homes), townhouses, condominiums and manufactured homes in Mecklenburg County, from the City of Charlotte’s copy of the county’s parcel records. Apartment buildings, commercial property and vacant land are left out.',
    'The City’s table carries no mark of which sales were at arm’s length (the county’s own sales records have one, but are not published under an open licence), so only sales on a warranty or special warranty deed at $10,000 or more are counted. Quitclaim, non-warranty, trustee’s, foreclosure and court-ordered deeds, sales of several properties for one price, and nominal transfers are left out. A sale between relatives on a warranty deed at a real price can still be included.',
    'The records keep only the latest transfer of each property. A home sold twice in this period counts once, at its later price, and a sale followed by any later transfer (for example into a trust) is not seen at all, ' +
      'so these figures rest on fewer sales than took place, by a few percent (perhaps up to about one in ten), most in the earliest months. The sales missed are often a home’s earlier, lower price before a quick resale, so figures may lean slightly high.',
    'Newly built homes sold before the county has valued the house carry no property use yet, and are left out: where many homes are new, the figure leans toward older homes.',
    'Each sale is placed at its parcel; a condominium is placed at its building, so a complex that straddles a tract boundary counts wholly in one tract. Dated by the date of sale. Sales reach the county’s records some weeks after they close, so the period ends with the latest month that is complete.',
  ],
  colourMinN: 10,
  credit: 'City of Charlotte',
};

// ── dates ───────────────────────────────────────────────────────────────────
// Sales_Date is an ArcGIS date, but not at the day's midnight: every value
// read on 29 Sep 2026 (74,421 rows from Aug 2024) is 16:00 or 17:00 UTC,
// i.e. midday Eastern on the day BEFORE the sale. Read as Eastern calendar
// dates the 35,115 kept sales fall Sunday to Thursday (6,635 on Sundays, 5
// on Fridays); rounded to the nearest UTC midnight they fall Monday to
// Friday (9 at weekends), peaking on Fridays (8,236) and at month ends, as
// closings do, and none on Labor Day 2025 or 2026. So the date is the nearest UTC
// midnight, which also reads a fixed encoding (the day's own midnight, UTC
// or Eastern) correctly. A value far from any midnight is no date.
export function saleDate(ms) {
  if (!Number.isFinite(ms)) return null;
  const off = ((ms % 864e5) + 864e5) % 864e5;
  if (off > 9 * 36e5 && off < 15 * 36e5) return null;
  return new Date(Math.round(ms / 864e5) * 864e5).toISOString().slice(0, 10);
}
const NY_DATE = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' });
const todayNY = () => NY_DATE.format(new Date());
const monthIdx = ym => { const [y, m] = ym.split('-').map(Number); return y * 12 + (m - 1); };
const monthStr = i => `${Math.floor(i / 12)}-${String((i % 12) + 1).padStart(2, '0')}`;
const dayBefore = d => new Date(Date.parse(`${d}T00:00:00Z`) - 864e5).toISOString().slice(0, 10);

// 'YYYY-MM': the last month that ended at least `days` before `newest`
// ('YYYY-MM-DD', the newest sale on or before the build day). See WINDOW.
export function completeThrough(newest, days = COMPLETE_AFTER_DAYS) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(newest || '')) throw new Error(`${ID}: newest sale date "${newest}" is not a date`);
  const cut = new Date(Date.parse(`${newest}T00:00:00Z`) - days * 864e5);
  const y = cut.getUTCFullYear(), m = cut.getUTCMonth();
  const whole = new Date(Date.UTC(y, m, cut.getUTCDate() + 1)).getUTCMonth() !== m;
  return monthStr(y * 12 + m - (whole ? 0 : 1));
}
// The first day the build's window can reach; rows before it are never read.
export const readFrom = (through, months = WINDOW.months, lagMonths = WINDOW.lagMonths) =>
  `${monthStr(monthIdx(through) - lagMonths - months + 1)}-01`;

// ── the filter (pure; tools/prices/test/charlotte-sales.test.mjs) ───────────
// row: { account, pid, date: 'YYYY-MM-DD' | null, price, use, deed, ref, units }
// Returns { drop } or { keep: type } — before the multi-parcel groups and the
// location, which need every row (reduceSales).
export function classify(row) {
  if (!row.date) return { drop: 'noDate' };
  const use = String(row.use ?? '').trim();
  if (!use) return { drop: 'noPropertyUse' };
  const type = RESIDENTIAL[use];
  if (!type) {
    if (NON_RESIDENTIAL.has(use)) return { drop: 'nonResidential' };
    throw new Error(`${ID}: property use "${use}" is not one this module knows — the format changed`);
  }
  if (Number(row.units) > MAX_UNITS) return { drop: 'fivePlusHomes' };
  const deed = String(row.deed ?? '').trim().toUpperCase();
  if (!deed) return { drop: 'noDeedType' };
  if (deed === MULTI_LOT_DEED) return { drop: 'multiParcel' };
  if (!KEEP_DEEDS.has(deed)) return { drop: 'otherDeed' };
  if (!(row.price >= MIN_PRICE)) return { drop: 'nominal' };
  return { keep: type };
}

// Every reason a row is left out, in the order they are applied; each is
// published, 0 or not.
export const DROP_REASONS = ['noDate', 'duplicate', 'noPropertyUse', 'nonResidential', 'fivePlusHomes', 'noDeedType', 'otherDeed',
  'multiParcel', 'nominal', 'splitPortfolio', 'noLocation'];
export const SPLIT_MIN = 3;

// Every row through classify(), then the groups, then the location: each row
// lands in exactly one `dropped` bucket or in `sales`.
//   rows    normalised rows (see classify)
//   points  Map PID -> { lat, lng }
export function reduceSales(rows, points) {
  const dropped = Object.fromEntries(DROP_REASONS.map(k => [k, 0]));
  const seen = new Set(), kept = [];
  for (const r of rows) {
    const key = `${r.account}|${r.date}|${r.price}`;
    if (r.date && seen.has(key)) { dropped.duplicate++; continue; }
    if (r.date) seen.add(key);
    const c = classify(r);
    if (c.drop) { dropped[c.drop]++; continue; }
    kept.push({ r, type: c.keep });
  }
  // MULTI: one conveyance of several accounts. The deed reference groups a
  // conveyance only with its day and price (a builder's lots can share one);
  // counted over every row read at a real price, whatever its use or deed
  // type, so a house sold with a vacant lot next door is caught too.
  const deedKey = r => `${r.date}|${r.price}|${String(r.ref ?? '').trim()}`;
  const accounts = new Map();
  for (const r of rows) {
    if (!r.date || !(r.price >= MIN_PRICE) || !String(r.ref ?? '').trim()) continue;
    const k = deedKey(r);
    if (!accounts.has(k)) accounts.set(k, new Set());
    accounts.get(k).add(r.account);
  }
  const single = kept.filter(({ r }) => !String(r.ref ?? '').trim() || accounts.get(deedKey(r)).size < 2);
  dropped.multiParcel += kept.length - single.length;
  // Split portfolio: SPLIT_MIN or more kept sales on one day at one uneven price.
  const odd = ({ r }) => r.price % 1000 !== 0, day = ({ r }) => `${r.date}|${r.price}`;
  const n = new Map();
  for (const k of single) if (odd(k)) n.set(day(k), (n.get(day(k)) || 0) + 1);
  const left = single.filter(k => !odd(k) || n.get(day(k)) < SPLIT_MIN);
  dropped.splitPortfolio = single.length - left.length;
  const sales = [];
  for (const { r, type } of left) {
    const pt = points.get(r.pid);
    if (!pt) { dropped.noLocation++; continue; }
    sales.push({ lat: pt.lat, lng: pt.lng, price: r.price, date: r.date, type });
  }
  return { sales, dropped };
}

// A point inside a polygon given as ArcGIS rings ([[lng, lat], …], outer
// rings and holes together, read even-odd). The area centroid of the largest
// ring when it is inside; else the middle of the widest inside stretch of a
// horizontal line through that centroid (or through the ring's middle). null
// for a degenerate shape. Returns { lat, lng }.
export function interiorPoint(rings) {
  const raw = (rings || []).filter(r => Array.isArray(r) && r.length >= 3);
  if (!raw.length) return null;
  // Worked relative to one corner: a parcel is metres across while its
  // coordinates are ~80°, and the shoelace sums would otherwise cancel away
  // most of a small parcel's area (a centroid tens of metres off).
  const [ox, oy] = raw[0][0];
  const rs = raw.map(r => r.map(([x, y]) => [x - ox, y - oy]));
  const at = (lat, lng) => ({ lat: lat + oy, lng: lng + ox });
  const area = r => { let a = 0; for (let i = 0, j = r.length - 1; i < r.length; j = i++) a += (r[j][0] * r[i][1] - r[i][0] * r[j][1]); return a / 2; };
  const big = rs.reduce((b, r) => (Math.abs(area(r)) > Math.abs(area(b)) ? r : b), rs[0]);
  const A = area(big);
  if (!A) return null;
  let cx = 0, cy = 0;
  for (let i = 0, j = big.length - 1; i < big.length; j = i++) {
    const f = big[j][0] * big[i][1] - big[i][0] * big[j][1];
    cx += (big[j][0] + big[i][0]) * f; cy += (big[j][1] + big[i][1]) * f;
  }
  cx /= 6 * A; cy /= 6 * A;
  const inside = (x, y) => {
    let c = false;
    for (const r of rs) for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
      const [xi, yi] = r[i], [xj, yj] = r[j];
      if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) c = !c;
    }
    return c;
  };
  if (inside(cx, cy)) return at(cy, cx);
  const ys = big.map(p => p[1]);
  for (const y of [cy, (Math.min(...ys) + Math.max(...ys)) / 2]) {
    const xs = [];
    for (const r of rs) for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
      const [xi, yi] = r[i], [xj, yj] = r[j];
      if ((yi > y) !== (yj > y)) xs.push(xi + ((y - yi) * (xj - xi)) / (yj - yi));
    }
    xs.sort((a, b) => a - b);
    let best = null;
    for (let i = 0; i + 1 < xs.length; i += 2) if (!best || xs[i + 1] - xs[i] > best[1] - best[0]) best = [xs[i], xs[i + 1]];
    if (best && best[1] > best[0]) return at(y, (best[0] + best[1]) / 2);
  }
  return null;
}

// ── ArcGIS ──────────────────────────────────────────────────────────────────
const sha = s => createHash('sha256').update(s).digest('hex');

// One query answer as JSON, or a throw. The host's firewall answers some
// requests with an HTML page and HTTP 200, and ArcGIS a bad query with an
// {error} body: either is discarded from the cache first, so the next run
// asks again instead of reading it back. A server busy for a moment answers a
// good query the same way (or times out, or 5xxs), and one lost answer of
// the ~190 a run would cost the whole month, so a failed question is asked
// ONCE more after a pause (denver-sales does the same), except a firewall
// rejection (an over-long URL: the same again) and under --frozen (the cache
// cannot change). The whole fetch has a time budget: a host that answers
// every question slowly (up to the 180 s timeout each) fails this source
// alone instead of holding the monthly job past its 45 minutes.
// timing: the pause and the budget (exported so the tests can shorten them).
export const timing = { retryMs: 10_000, budgetMs: 15 * 60_000 };
let deadline = Infinity;
const REJECTED = 'the host’s firewall rejected the request';
async function queryJson(ctx, file, url, opts) {
  for (let attempt = 1; ; attempt++) {
    if (Date.now() > deadline) throw new Error(`${ID}: still reading gis.charlottenc.gov after ${timing.budgetMs / 60_000} minutes — the host is too slow this run`);
    try {
      const buf = await ctx.download(file, url, { timeoutMs: 180_000, ...opts });
      let doc = null;
      try { doc = JSON.parse(buf.toString('utf8')); } catch {}
      if (!doc || doc.error) {
        ctx.discard?.(file);
        dropRecords(ctx, file);   // not data: a second try's answer replaces it
        const why = doc?.error?.message || (/Request Rejected/.test(buf.toString('utf8', 0, 400)) ? REJECTED : 'not JSON');
        throw new Error(`${ID}: ${file}: ${why}`);
      }
      return doc;
    } catch (e) {
      if (attempt > 1 || ctx.frozen || e.message.endsWith(REJECTED)) throw e;
      ctx.log(`  ${e.message}; asking once more in ${timing.retryMs / 1000}s`);
      await new Promise(r => setTimeout(r, timing.retryMs));
    }
  }
}
const dropRecords = (ctx, file) => { for (let i = ctx.provenance.length - 1; i >= 0; i--) if (ctx.provenance[i].file === file) ctx.provenance.splice(i, 1); };

// Every row of a query, paged. The query's hash is in the cache name, so a
// changed window or field list is never answered from an older query's page.
// `files`, when given, collects the cache names read (so a caller can
// discard an answer that fails its own check).
async function pagedRows(ctx, layer, params, tag, { page = PAGE, maxAgeH = 12, maxPages = 60, name = null, once = false, files = null } = {}) {
  const rows = [];
  for (let offset = 0, i = 0; ; i++) {
    if (i >= maxPages) throw new Error(`${ID}: ${tag} needs more than ${maxPages} pages — the query is wrong`);
    const q = new URLSearchParams({ ...params, resultOffset: String(offset), resultRecordCount: String(page), f: 'json' });
    const url = `${layer}/query?${q}`;
    const file = name || `${ID}-${tag}-${sha(url).slice(0, 10)}.json`;
    files?.push(file);
    const doc = await queryJson(ctx, file, url, { maxAgeH });
    if (!Array.isArray(doc.features)) { ctx.discard?.(file); throw new Error(`${ID}: ${tag}: no features array`); }
    if (i === 0 && Array.isArray(doc.fields)) {
      const want = String(params.outFields).split(',');
      ctx.readers.columns(doc.fields.map(f => f.name), want, `${ID} ${tag}`);
    }
    rows.push(...doc.features);
    if (once || !doc.features.length || (!doc.exceededTransferLimit && doc.features.length < page)) break;
    offset += doc.features.length;
  }
  return rows;
}

const ofTag = (p, tag) => p.file.startsWith(`${ID}-${tag}-`) || p.file === `${ID}-${tag}.json`;
function dropProvenance(ctx, tag) { for (let i = ctx.provenance.length - 1; i >= 0; i--) if (ofTag(ctx.provenance[i], tag)) ctx.provenance.splice(i, 1); }

// One provenance record per layer instead of one per query page (as
// dc-cama-sales): the layer, and a hash of exactly the attributes used.
function collapseProvenance(ctx, tag, record) {
  const pages = ctx.provenance.filter(p => ofTag(p, tag));
  if (!pages.length) return;
  dropProvenance(ctx, tag);
  ctx.provenance.push({
    status: 200, etag: null, queries: pages.length,
    fetchedAt: pages.map(p => p.fetchedAt).filter(Boolean).sort().pop() || null,
    cached: pages.every(p => p.cached),
    bytes: pages.reduce((a, p) => a + (p.bytes || 0), 0), ...record,
  });
}

// The item behind a layer: its licence must still be CC BY 4.0 and it must
// still point at the layer read here. Either change stops the source.
async function checkItem(ctx, key) {
  const file = `${ID}-item-${key}.json`;
  const item = await queryJson(ctx, file, AGOL_ITEM(ITEM[key]), { maxAgeH: 24 });
  dropProvenance(ctx, `item-${key}`);     // a licence check, not data
  if (!/creativecommons\.org\/licenses\/by\/4\.0/.test(item.licenseInfo || '')) {
    throw new Error(`${ID}: item ${ITEM[key]} (${item.title}) no longer gives the CC BY 4.0 licence ("${String(item.licenseInfo).slice(0, 80)}") — re-check the terms before publishing`);
  }
  if (item.owner !== 'CharlotteNC' || item.access !== 'public') throw new Error(`${ID}: item ${ITEM[key]} is now owned by "${item.owner}", access "${item.access}"`);
  if ((item.url || '').replace(/\/$/, '') !== LAYER[key]) throw new Error(`${ID}: item ${ITEM[key]} now points at "${item.url}", not ${LAYER[key]} — the service moved`);
}

// ── the sales ───────────────────────────────────────────────────────────────
const FIELDS = ['OBJECTID', 'Tax_ID', 'PID', 'Card_No', 'Property_Use', 'Units', 'Sales_Date', 'Price', 'TypeOfDeed', 'Legal_Reference'];
// A Price that is not a number (a numeric string would pass `>=` by
// coercion and reach the build as a malformed sale, which stops EVERY city's
// build) is format drift: this source throws and keeps its snapshot.
export function normalise(a) {
  if (a.Price != null && !(typeof a.Price === 'number' && Number.isFinite(a.Price))) throw new Error(`${ID}: Price reads ${JSON.stringify(a.Price)}, not a number — the format changed`);
  return {
    account: String(a.Tax_ID ?? '').trim() || String(a.PID ?? '').trim(), pid: String(a.PID ?? '').trim(),
    date: saleDate(a.Sales_Date), price: a.Price, use: a.Property_Use, deed: a.TypeOfDeed, ref: a.Legal_Reference, units: a.Units,
  };
}

async function tableRows(ctx, months, lagMonths, today) {
  const top = await pagedRows(ctx, LAYER.lookup, {
    where: `Sales_Date <= DATE '${today}'`, outFields: 'Sales_Date', orderByFields: 'Sales_Date DESC',
  }, 'newest', { page: 1, once: true, maxAgeH: 6, name: `${ID}-newest.json` });
  dropProvenance(ctx, 'newest');     // a discovery query, not data
  const newest = saleDate(top[0]?.attributes?.Sales_Date);
  if (!newest) throw new Error(`${ID}: the table returned no dated sale`);
  const ageDays = (Date.parse(`${today}T00:00:00Z`) - Date.parse(`${newest}T00:00:00Z`)) / 864e5;
  if (ageDays > 30) ctx.warn(`${ID}: the table's newest sale is dated ${newest}, ${Math.round(ageDays)} days ago — its daily rebuild may have stalled`);
  const through = completeThrough(newest), from = readFrom(through, months, lagMonths);
  // From the day before: a sale is stored before its own midnight (see
  // dates), so a query from `from` itself would miss the window's first day.
  // A row that turns out to be before `from` is the build's to count.
  const where = `Sales_Date >= DATE '${dayBefore(from)}'`;
  const countFile = `${ID}-count-${sha(where).slice(0, 10)}.json`;
  const count = (await queryJson(ctx, countFile,
    `${LAYER.lookup}/query?${new URLSearchParams({ where, returnCountOnly: 'true', f: 'json' })}`, { maxAgeH: 12 })).count;
  dropProvenance(ctx, 'count');     // a check on the pages, not data
  const feats = await pagedRows(ctx, LAYER.lookup, { where, outFields: FIELDS.join(','), orderByFields: 'OBJECTID', returnGeometry: 'false' }, 'sales');
  const rows = feats.map(f => f.attributes);
  // The table is rebuilt daily: pages read across a rebuild would repeat or
  // miss rows. The count asked before must match, with no OBJECTID twice.
  if (rows.length !== count || new Set(rows.map(r => r.OBJECTID)).size !== rows.length) {
    for (const f of [countFile, ...ctx.provenance.filter(p => ofTag(p, 'sales')).map(p => p.file)]) ctx.discard?.(f);
    throw new Error(`${ID}: read ${rows.length} rows (${new Set(rows.map(r => r.OBJECTID)).size} distinct) but the table counts ${count} — it was rebuilt while being read; the next run reads it afresh`);
  }
  collapseProvenance(ctx, 'sales', {
    file: 'City of Charlotte CLTEx_MoreInfo table 4 (Parcel Look Up)', url: LAYER.lookup, item: ITEM.lookup, where, lastModified: null,
    sha256: sha(JSON.stringify(rows.map(r => FIELDS.slice(1).map(f => r[f])).sort())),
  });
  return { rows: rows.map(normalise), newest, through, from };
}

// ── the parcels: PID -> a point inside its polygon ──────────────────────────
// PIDs are asked for in batches whose URL stays under the firewall's limit.
export function pidBatches(pids, base = `${LAYER.parcels}/query?`, max = MAX_URL) {
  const out = [];
  let cur = [];
  const len = list => base.length + new URLSearchParams({ where: `PID IN (${list.map(p => `'${p}'`).join(',')})`, outFields: 'PID', returnGeometry: 'true', outSR: '4326', geometryPrecision: '6', f: 'json' }).toString().length;
  for (const p of [...pids].sort()) {
    if (!/^[0-9A-Z]{8}$/.test(p)) throw new Error(`${ID}: PID "${p}" is not an 8-character parcel id — the format changed`);
    if (cur.length && len([...cur, p]) > max) { out.push(cur); cur = []; }
    cur.push(p);
  }
  if (cur.length) out.push(cur);
  return out;
}

// A batch must answer at least BATCH_MIN_SHARE of the PIDs it asked for.
// Batches follow the sorted PIDs, i.e. map book and page, so each is one
// neighbourhood: a partial answer (an overloaded server's short page) would
// take whole tracts off the map while staying far under the fetch's 5%
// no-location guard. Measured 29 Sep 2026: the worst of the 180 batches
// answered 99% of its PIDs, so 0.9 is far from any real batch. A short batch
// is discarded and asked once more (not under --frozen), then fails the
// source.
export const BATCH_MIN_SHARE = 0.9;
export async function parcelPoints(ctx, pids) {
  const rings = new Map();
  let worst = 1;
  for (const batch of pidBatches(pids)) {
    for (let attempt = 1; ; attempt++) {
      const files = [];
      const feats = await pagedRows(ctx, LAYER.parcels, {
        where: `PID IN (${batch.map(p => `'${p}'`).join(',')})`, outFields: 'PID', returnGeometry: 'true', outSR: '4326', geometryPrecision: '6',
      }, 'parcels', { page: 2000, maxAgeH: PARCELS_MAX_AGE_H, maxPages: 3, files });
      const got = new Map();
      for (const f of feats) {
        const pid = String(f.attributes?.PID ?? '').trim();
        if (!batch.includes(pid)) throw new Error(`${ID}: the parcels query answered PID "${pid}", which it was not asked for — the query was not applied`);
        if (!Array.isArray(f.geometry?.rings)) continue;
        if (!got.has(pid)) got.set(pid, []);
        got.get(pid).push(...f.geometry.rings);
      }
      const share = got.size / batch.length;
      if (share >= BATCH_MIN_SHARE) {
        worst = Math.min(worst, share);
        for (const [pid, rs] of got) rings.set(pid, rs);
        break;
      }
      const why = `${ID}: a parcels batch answered ${got.size} of the ${batch.length} PIDs it asked for (${batch[0]}…${batch.at(-1)}) — a partial answer`;
      for (const f of files) { ctx.discard?.(f); dropRecords(ctx, f); }
      if (attempt > 1 || ctx.frozen) throw new Error(why);
      ctx.log(`  ${why}; asking once more`);
    }
  }
  ctx.log(`  ${ID}: every parcels batch answered at least ${(100 * worst).toFixed(1)}% of its PIDs`);
  const points = new Map();
  for (const [pid, rs] of rings) { const pt = interiorPoint(rs); if (pt) points.set(pid, pt); }
  collapseProvenance(ctx, 'parcels', {
    file: 'City of Charlotte CLTEx_PopUps layer 3 (Parcels)', url: LAYER.parcels, item: ITEM.parcels, lastModified: null,
    sha256: sha(JSON.stringify([...points].sort((a, b) => (a[0] < b[0] ? -1 : 1)))),
  });
  return points;
}

// ── fetch ───────────────────────────────────────────────────────────────────
// Also the measuring entry point: `months` / `lagMonths` override the
// module's window, and `inspect` is handed the joined inputs.
export async function fetchSales(ctx, { months = WINDOW.months, lagMonths = WINDOW.lagMonths, today = todayNY(), inspect = null } = {}) {
  const t0 = Date.now();
  deadline = t0 + timing.budgetMs;
  const served = REGIONS.map(id => ({ id, reg: ctx.regions?.[id] })).filter(r => r.reg);
  if (!served.length) throw new Error(`${ID}: none of ${REGIONS.join(', ')} is in coverage.json`);
  for (const { id, reg } of served) if (!reg.juris?.includes('US-NC')) throw new Error(`${ID}: region ${id} is not in North Carolina (juris ${reg.juris})`);
  await checkItem(ctx, 'lookup');
  await checkItem(ctx, 'parcels');

  const { rows, newest, through, from } = await tableRows(ctx, months, lagMonths, today);
  // Look up only the parcels of rows that can still be kept.
  const want = new Set(rows.filter(r => !classify(r).drop).map(r => r.pid));
  const points = await parcelPoints(ctx, want);
  const { sales, dropped } = reduceSales(rows, points);
  inspect?.({ rows, points, newest, through, from, sales, dropped });

  // A fetch that looks wrong is a failed one (README house rule 8). Every
  // date read is near a UTC midnight (see dates): many that are not mean the
  // encoding changed, and the window would be read wrongly. Mecklenburg has
  // well over 1,000 kept home sales a month.
  if (dropped.noDate > 0.01 * rows.length) throw new Error(`${ID}: ${dropped.noDate} of ${rows.length} rows have no readable sale date — the date encoding changed`);
  const upTo = `${through}-31`;
  const inRange = sales.filter(s => s.date >= from && s.date <= upTo).length;
  if (inRange < 700 * months) throw new Error(`${ID}: only ${inRange} sales kept from ${from} through ${through} — the table or a filter changed`);
  if (dropped.noLocation > 0.05 * (dropped.noLocation + sales.length)) throw new Error(`${ID}: ${dropped.noLocation} kept sales have no parcel polygon — the parcels layer is partial`);
  const bad = sales.filter(s => !(s.lat > 34.9 && s.lat < 35.6 && s.lng > -81.2 && s.lng < -80.4));
  if (bad.length) throw new Error(`${ID}: ${bad.length} sale(s) placed outside Mecklenburg County (e.g. ${bad[0].lat},${bad[0].lng}) — a coordinate changed`);

  const byType = {};
  for (const s of sales) byType[s.type] = (byType[s.type] || 0) + 1;
  ctx.log(`  ${ID}: ${rows.length} rows with a sale from ${from} (newest ${newest}, complete through ${through}); ` +
    `${sales.length} sales (${Object.entries(byType).map(([k, v]) => `${v} ${k}`).join(', ')}); ` +
    `dropped ${Object.entries(dropped).map(([k, v]) => `${k} ${v}`).join(', ')}; ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  return {
    // Every Mecklenburg parcel is in the table, so every Mecklenburg tract is
    // this source's; the rectangle's tracts in the neighbouring counties keep
    // acs-tract on the region's second scale key (charlotte-outer).
    covers: { juris: ['US-NC'], counties: [COUNTY] },
    sales,
    dropped,
    through,
  };
}

export default {
  id: ID,
  kind: 'point-sales',
  regions: REGIONS,
  cadence: 'monthly',       // the table is rebuilt daily from the county's parcel data
  geometry: 'acs-tract',
  meta,
  fetch: ctx => fetchSales(ctx),
};
