// Denver: recorded residential SALE PRICES from the City and County of
// Denver's "Real Property Sales and Transfers" table (Denver Open Data
// Catalog, item 55040dd13cb647bcbc7c555a4cfd6844, an ArcGIS Online table: one
// row per property per recorded transfer since 2010, with the deed type, the
// reception number and date, the sale date, the price and the property's
// class), located through the City's "Parcels" layer (item
// 7c53bd0894134e80ae1e478c0789bf49). Returned as individual sales for the
// orchestrator to place in the census tracts acs-tract draws for Denver (kind
// 'point-sales', tools/prices/README.md "Sale prices"). Where this source
// covers a tract (every tract of Denver County, FIPS 08031), its "Median sale
// price" replaces acs-tract's owners' estimate; the rectangle's Adams,
// Arapahoe and Jefferson county tracts keep ACS on their own scale.
//
// PARKED (29 Sep 2026): this module lives in tools/prices/parked/, outside
// sources/, so the build never loads it, and tools/prices/regions.mjs gives
// Denver acs() (owners' estimates). The licence is not clean enough for the
// house rule "commercial use allowed" (tools/prices/README.md, adding a
// source) until the City confirms it in writing. To publish it: move this
// file back to sources/, make regions.mjs denver sales('denver-sales',
// ['denver', 'denver-outer']) with 'denver-outer': 'Counties around Denver'
// in SCALE_NAMES, put Denver's seam points back in tools/audit-viewports.mjs,
// and link the credit "City of Denver Open Data Catalog" to data.denvergov.org
// as the card asks (the page links only licence names today). Worth doing
// then too (Sept 2026 review): read only the parcels the kept sales need
// (about 12,000 of 240,000; the whole layer is 29.5 MB of a 35 MB month, and
// the monthly runner starts with an empty cache), in batches, as
// charlotte-sales does; the host is ArcGIS Online, which takes a POST.
//
// LICENCE (re-read live 29 Sep 2026). The catalog's Terms of Use (the card on
// the hub site data.denvergov.org now redirects to, site item
// 08ac95d2733c45059ec5a3c76faa770d; the same text was on
// denvergov.org/opendata/termsofuse from 2021 to 2024) say the catalog
// "provides open data licensed under the Creative Commons Attribution 3.0
// license (CC BY 3.0)" and ask for credit to the "City of Denver Open Data
// Catalog" with the licence named. Both items are in that site's catalog
// group (31a0c1ba…), checked by an ArcGIS search. Two things ride along, and
// the first is why the module is parked:
//   - The same card says "In addition, the user agrees to abide by the
//     DenverGov Website terms of use" (denvergov.org/Terms-of-Use). Their
//     Copyright Notice says users may not "mirror or copy this information to
//     another server without permission" and that "Commercial use of the
//     materials is prohibited without the written permission of the City".
//     One can read that notice as covering only the website's own "text,
//     graphic images and other content", the data sets being under the
//     catalog's specific CC BY 3.0 grant; but the card binds catalog users
//     to it expressly, and SafeRoute is a commercial app's site. The phase-2
//     research said those terms had no such clause; they do.
//   - Each item's USE CONSTRAINTS text is a warranty disclaimer plus an
//     indemnity: the user agrees to hold Denver harmless for liability
//     arising from the use or dissemination of the data.
//
// WHICH ROWS ARE SALES. Denver publishes NO arm's-length or qualified-sale
// flag, so only the table's own fields are used, in this order (every row
// read lands in exactly one `dropped` bucket or is returned as a sale):
//   badDate         SALE_YEAR + SALE_MONTHDAY is not a real date, or the
//                   RECEPTION_DATE is not one, or the deed was recorded before
//                   the date of sale, or the RECEPTION_NUM (which begins with
//                   the year it was recorded in) names another year than the
//                   RECEPTION_DATE: a typo in one of them. The table has rows
//                   such as a 2018 sale recorded "20281113", and a sale dated
//                   30 Dec 2026, recorded "20261230" under a 2025 number.
//   notWarrantyDeed INSTRUMENT (the deed type) is not WD (warranty deed) or
//                   SW (special warranty deed), the deeds an ordinary sale
//                   conveys a home by: quitclaim deeds (QC), personal
//                   representatives' deeds (PR) and every other type are left
//                   out. That some of those are market sales (an estate
//                   selling a house) is the price of having no flag.
//   nominal         SALE_PRICE missing or under $10,000 (the NYC floor): most
//                   such deeds say "$10" or "$0", a transfer with no price
//   nonResidential  D_CLASS_N (the property's class in the table) is not a
//                   home one household buys: HOME_CLASSES below
//   multiParcel     the RECEPTION_NUM (one recorded deed) conveys more than
//                   one property (schedule number), whatever their classes:
//                   the price is then the whole deed's, not this home's
//   duplicate       the same property and reception number twice
//   quickResale     the first of two counted sales of one property within
//                   RESALE_DAYS (30) days: a double closing, where a
//                   middleman (a wholesaler, an instant-offer or relocation
//                   company) buys and resells, often the same day, and the
//                   first price is usually below market. Measured 29 Sep 2026
//                   on Jul 2025 – Jun 2026: 267 kept sales (2.7%) had a later
//                   warranty-deed sale of the same parcel the same day, 360
//                   (3.7%) within 30 days; the second price was a median 6.5%
//                   higher, and counting both moved 110 of 165 coloured
//                   tracts (median +0.8%, up to 10%). Only the later sale
//                   counts. (A last-sale feed, Charlotte's or Hennepin's, keeps
//                   only the later one by construction.)
//   noLocation      the schedule number is not in today's Parcels layer (a
//                   parcel since retired, e.g. replatted), so the sale cannot
//                   be placed without guessing
// The build then drops, and counts, sales dated after the build day, those
// outside the window, and those outside every kept Denver tract.
//
// LOCATION is an official join only: PARID (the sales table) = SCHEDNUM
// (Parcels), the Assessor's 13-digit schedule number. The point is the
// parcel's centroid as the Parcels feature service itself returns it
// (returnCentroid, in WGS84). A condominium unit has its own schedule number
// and parcel there, drawn on its building, so a unit is placed at its
// building. Nothing is geocoded from an address.
//
// THE WINDOW is by DATE OF SALE (window.by 'sale'): meta.window.months
// months ending with `through`, which this module returns: the last month
// that ended at least COMPLETE_AFTER_DAYS before the newest sale in the table
// (see WINDOW; not the publisher's statement but a measured one, as for
// dc-cama-sales). The build then takes the window from it (lib/sales.mjs
// saleWindow). This module reads the sales dated from the first day any
// window the build could take can reach (READ_SLACK months earlier still, so
// a table a month or two stale is still read whole) and throws if the window
// the data gives would start before that. "Could take" is judged at the
// table's last reload (its data-edit stamp, cached under a fixed name), not
// at today: no sale in it is newer than its reload, and a --frozen rebuild
// weeks later then asks the raw cache the same query instead of a new one.
//
// HOSTS. Both layers are ArcGIS Online feature services (services1.arcgis.com),
// which have not refused datacenter IPs in this project. Both are reloaded
// from time to time (the sales table last on 24 Sep 2026, Parcels on
// 29 Sep); pages are cached under each layer's own data-edit stamp and
// counted against a count query, so rows of two reloads are never mixed.
//
// PRIVACY (SPEC2 §B.5–6): GRANTOR and GRANTEE (names) and every owner and
// address field are never requested. A sale carries only lat, lng, price,
// date and type; none of it reaches a tile.

import { createHash } from 'node:crypto';
import { saleWindow, isIsoDate } from '../lib/sales.mjs';

const ID = 'denver-sales';
const REGIONS = ['denver'];
const AGOL = 'https://services1.arcgis.com/zdB7qR0BtYrg0Xpl/arcgis/rest/services';
const SALES_LAYER = `${AGOL}/ODC_real_property_sales_and_transfers/FeatureServer/60`;
const PARCELS_LAYER = `${AGOL}/ODC_PROP_PARCELS_A/FeatureServer/245`;
const ITEM = { sales: '55040dd13cb647bcbc7c555a4cfd6844', parcels: '7c53bd0894134e80ae1e478c0789bf49' };
const HUB = 'https://opendata-geospatialdenver.hub.arcgis.com';
const COUNTY = '08031';                 // the City and County of Denver
// Rows per sales query page: the service's maxRecordCount 2000 ×
// maxRecordCountFactor 5. Parcels are read by ranges of PARCELS_SPAN object
// ids (see rangeRows), which never exceed that cap.
const SALES_PAGE = 10_000, PARCELS_SPAN = 9_000;
const READ_SLACK = 2;                   // months read before the earliest window today allows
const MIN_PRICE = 10_000;
export const RESALE_DAYS = 30;          // see quickResale
const PARCELS_MAX_AGE_H = 24 * 7;       // parcels change slowly; a new one is a new schedule number
// Colorado's extent: a parcel centroid outside it is a coordinate column or
// spatial-reference change. (Not Denver's own: Parcels also draws parcels the
// City owns in the mountains, such as Red Rocks Park; sales there, if any,
// fall in no Denver tract and the build counts them outsideTracts.)
const BOUNDS = { s: 36.99, w: -109.06, n: 41.01, e: -102.04 };

// WINDOW (measured 29 Sep 2026 on the table as reloaded 24 Sep 2026, whose
// newest sale is dated 15 Sep):
//   RECORDING is quick: of the 2025 sales kept here, half were recorded
//   within 3 days of the sale and 99% within 33 days.
//   POSTING is not. The table gains a month's sales in two stages: about
//   three quarters within weeks, the rest about two and a half months after
//   the sale. Kept sales by week of recording, against the same week a year
//   before: 68–82% for every week recorded 26–68 days before the reload (28%
//   at 19 days), 86–128% from 75 days back (a noisy ratio, but no week under
//   86%). By
//   month of sale: June 2026 held 104% of June 2025 (0.94–1.11 by type),
//   July 80%, August 60%. The late quarter is mostly condominiums and
//   rowhouses (Jul–Aug 2026 condos at 59–61% of 2025, houses at 75–84%), so
//   a half-posted month would push a median up (July 2026's, $625,000
//   against $548,000 a year before).
//   COMPLETE_AFTER_DAYS 75: a month counts once it ended at least 75 days
//   before the newest sale (about 84 before the reload). On this table:
//   June (ended 77 days before 15 Sep) in, July out. The build's own rule
//   with lagMonths 2 gives the same June here, but it ends the window 61 days
//   plus the newest sale's day of the month before that sale: under 75 days
//   whenever the newest sale falls before the 14th. This rule keeps 75.
//   lagMonths 0: `through` already holds the posting lag, and there is no
//   recording lag worth a month.
//   months 12. Of the 175 Denver County tracts acs-tract keeps for the
//   rectangle, Jul 2025 – Jun 2026 gives 165 (94%) at least 10 sales and
//   leaves 10 (6%) under 10, 4 of them with no kept sale and no ACS figure
//   either (two are the Census Bureau's 98xx special-land-use tracts); 24
//   months would leave 6 (3%). Far under SPEC2's 30% bar, so 12.
const WINDOW = { months: 12, by: 'sale', lagMonths: 0 };
const COMPLETE_AFTER_DAYS = 75;
const STALE_DAYS = 45;                  // a newest sale older than this: the table has stopped being reloaded

// D_CLASS_N, the property class in the sales table, of a home one household
// buys, and the type each sale carries. Checked against every class in the
// table for sales dated Jul 2025 – Jun 2026 and every residential class in
// Parcels (29 Sep 2026). "w/RK" is part of the City's own class name.
export const HOME_CLASSES = {
  'SFR Grade A': 'single-family', 'SFR Grade A or X, w/RK': 'single-family', 'SFR Grade B': 'single-family',
  'SFR Grade B w/RK': 'single-family', 'SFR Grade C': 'single-family', 'SFR Grade C, D, or E, w/RK': 'single-family',
  'SFR Grade D or E': 'single-family', 'SFR Grade X': 'single-family',
  'RESIDENTIAL-ROWHOUSE': 'rowhouse',
  'RESIDENTIAL-CONDOMINIUM': 'condo',
  'RESIDENTIAL-DUPLEX': '2-3 unit', 'RESIDENTIAL-TRIPLEX': '2-3 unit',
};
// Residential classes that are NOT a home one household buys: land (vacant,
// contiguous, "grace year" new-construction land), buildings of four or more
// homes, institutions, and two classes that are neither a house nor an
// ordinary condominium: "RESIDENTIAL" with no building (D_CLASS 110/111) and
// "RESIDENTIAL CONDOMINIUM" without the hyphen (D_CLASS 100 and 10S, units of
// 149 and 271 sq ft median above-grade area in Parcels: storage- or
// parking-sized). A class that starts SFR or RESIDENTIAL and is in neither
// list THROWS: a new class is format drift, never a guess.
export const OTHER_RESIDENTIAL = new Set([
  'RESIDENTIAL', 'RESIDENTIAL CONDOMINIUM', 'RESIDENTIAL GRACE YEAR', 'RESIDENTIAL LAND CONTIGUOUS',
  'RESIDENTIAL LAND FOR LAND/ IM', 'RESIDENTIAL LAND FOR LAND/ IMPS PARCEL',
  'RESIDENTIAL-4 TO 8 UNITS', 'RESIDENTIAL-APARTMENT', 'RESIDENTIAL-MULTI UNIT APTS', 'RESIDENTIAL-SENIOR CITIZEN APT',
  'RESIDENTIAL-NURSING FACILITY', 'RESIDENTIAL-BOARDING HOME', 'RESIDENTIAL-MISC IMPS',
]);
export const DEEDS = new Set(['WD', 'SW']);   // warranty deed, special warranty deed

const meta = {
  name: 'Real Property Sales and Transfers, located through Parcels (City and County of Denver)',
  publisher: 'City and County of Denver',
  url: `${HUB}/datasets/${ITEM.sales}_60`,
  licence: 'Creative Commons Attribution 3.0 (CC BY 3.0)',
  licenceUrl: 'https://creativecommons.org/licenses/by/3.0/',
  // The catalog asks for credit to the "City of Denver Open Data Catalog"
  // (linked to data.denvergov.org) and the licence named (CC BY 3.0).
  attribution: [
    'Source: City of Denver Open Data Catalog (data.denvergov.org): Real Property Sales and Transfers, and Parcels, City and County of Denver, licensed under CC BY 3.0.',
    'Changed by SafeRoute: home sales by warranty deed only, placed at their parcels and aggregated to census-tract medians.',
  ],
  credit: 'City of Denver Open Data Catalog',
  metric: 'Median sale price',
  unitNoun: 'sales',
  currency: 'USD',
  // period and areaNoun are the build's to fill: the window it finds, and
  // the geometry source's area noun (census tract).
  window: { ...WINDOW },
  notes: [
    'Sales of single-family houses, rowhouses, condominium homes, duplexes and triplexes in the City and County of Denver, by the property class the City gives each sale. ' +
      'Buildings of four or more homes, land, and commercial property are left out.',
    'Denver does not mark which sales were at arm’s length, so only sales conveyed by a warranty deed or a special warranty deed are counted: ' +
      'quitclaim deeds, personal representatives’ deeds and every other kind of transfer are left out, and so are transfers under $10,000 and deeds that convey several properties for one price. ' +
      'Where one home was sold twice within 30 days (usually through an investor or relocation company, the first price below market), only the later sale is counted. A few sales between related parties may remain.',
    'Dated by the date of sale. Each sale is placed at the centre of its parcel on the City’s parcel map; a sale whose parcel is no longer on that map is left out rather than guessed.',
    'The City adds sales to its table in stages, the last of them about two and a half months after the sale, so a month is included only once it ended at least 75 days before the newest sale in the table. Late additions can still shift the newest month slightly from one update to the next.',
  ],
  colourMinN: 10,
};

// ── pure helpers (tested in tools/prices/test/denver-sales.test.mjs) ────────
const monthIdx = ym => { const [y, m] = ym.split('-').map(Number); return y * 12 + (m - 1); };
const monthStr = i => `${Math.floor(i / 12)}-${String((i % 12) + 1).padStart(2, '0')}`;

// SALE_YEAR 2026 + SALE_MONTHDAY 515 -> '2026-05-15'; anything else -> null.
export function saleDate(year, monthDay) {
  if (!Number.isInteger(year) || !Number.isInteger(monthDay) || year < 1900 || monthDay < 101 || monthDay > 1231) return null;
  const s = `${year}-${String(Math.floor(monthDay / 100)).padStart(2, '0')}-${String(monthDay % 100).padStart(2, '0')}`;
  return isIsoDate(s) ? s : null;
}
// RECEPTION_DATE 20260518 -> '2026-05-18'; anything else -> null.
export function receptionDate(n) {
  if (!Number.isInteger(n) || n < 19000101 || n > 99991231) return null;
  const s = `${String(n).slice(0, 4)}-${String(n).slice(4, 6)}-${String(n).slice(6, 8)}`;
  return isIsoDate(s) ? s : null;
}
// PARID 3122043000 -> '0003122043000' (Parcels' SCHEDNUM); anything else -> null.
export function schedNum(parid) {
  if (!Number.isSafeInteger(parid) || parid <= 0 || parid >= 1e13) return null;
  return String(parid).padStart(13, '0');
}
// Class names as the table writes them, runs of spaces collapsed
// ("RESIDENTIAL  LAND FOR LAND/ IM").
export const className = s => String(s ?? '').trim().replace(/\s+/g, ' ');

// The class's sale type, null when it is not a home; throws on a residential
// class this module does not know.
export function homeType(cls) {
  const c = className(cls);
  if (HOME_CLASSES[c]) return HOME_CLASSES[c];
  if (/^(SFR|RESIDENTIAL)\b/i.test(c) && !OTHER_RESIDENTIAL.has(c)) throw new Error(`${ID}: property class "${c}" is not one this module knows — the format changed`);
  return null;
}

// 'YYYY-MM': the last month that ended at least `days` before `newest`
// ('YYYY-MM-DD', the newest sale in the table). See WINDOW.
export function completeThrough(newest, days = COMPLETE_AFTER_DAYS) {
  if (!isIsoDate(newest)) throw new Error(`${ID}: newest sale date "${newest}" is not a date`);
  const cut = new Date(Date.parse(`${newest}T00:00:00Z`) - days * 864e5);
  const y = cut.getUTCFullYear(), m = cut.getUTCMonth();
  // The cutoff's own month counts only if the cutoff is its last day.
  const whole = new Date(Date.UTC(y, m, cut.getUTCDate() + 1)).getUTCMonth() !== m;
  return monthStr(y * 12 + m - (whole ? 0 : 1));
}

// The first day ('YYYY-MM-DD') this module reads from: the first month of the
// latest window the build could take today (no sale is newer than today),
// less the lag and READ_SLACK months, so a table a month or two stale is
// still read whole.
export function readFrom(today, months = WINDOW.months, lagMonths = WINDOW.lagMonths, slack = READ_SLACK) {
  if (!isIsoDate(today)) throw new Error(`${ID}: today "${today}" is not a date`);
  return `${monthStr(monthIdx(completeThrough(today)) - lagMonths - months + 1 - slack)}-01`;
}
// The query's where clause: every row dated on or after `from`.
export function whereFrom(from) {
  const y = +from.slice(0, 4), md = +from.slice(5, 7) * 100 + +from.slice(8, 10);
  return `SALE_YEAR > ${y} OR (SALE_YEAR = ${y} AND SALE_MONTHDAY >= ${md})`;
}

// One table row -> the fields the filter reads.
export const normalise = a => ({
  parid: schedNum(a.PARID),
  reception: Number.isSafeInteger(a.RECEPTION_NUM) && a.RECEPTION_NUM > 0 ? String(a.RECEPTION_NUM) : null,
  instrument: String(a.INSTRUMENT ?? '').trim().toUpperCase(),
  date: saleDate(a.SALE_YEAR, a.SALE_MONTHDAY),
  recorded: receptionDate(a.RECEPTION_DATE),
  price: Number.isFinite(a.SALE_PRICE) ? a.SALE_PRICE : null,
  cls: className(a.D_CLASS_N),
});

// Reception numbers that convey more than one property: all rows read, of
// any class, deed type or price, grouped by reception number.
export function multiParcelReceptions(rows) {
  const parids = new Map();
  for (const r of rows) {
    if (!r.reception || !r.parid) continue;
    if (!parids.has(r.reception)) parids.set(r.reception, new Set());
    parids.get(r.reception).add(r.parid);
  }
  return new Set([...parids].filter(([, s]) => s.size > 1).map(([k]) => k));
}

// One row -> { drop: reason } or { sale }. `multi` from multiParcelReceptions;
// `parcels` Map schedule number -> [lat, lng]. Duplicates are reduceSales()'s
// (they need the rows already kept); future dates and the window are the
// build's.
export function classify(r, { multi, parcels }) {
  if (!r.date || !r.recorded || r.recorded < r.date || (r.reception && r.reception.slice(0, 4) !== r.recorded.slice(0, 4))) return { drop: 'badDate' };
  if (!DEEDS.has(r.instrument)) return { drop: 'notWarrantyDeed' };
  if (!(r.price >= MIN_PRICE)) return { drop: 'nominal' };
  const type = homeType(r.cls);
  if (!type) return { drop: 'nonResidential' };
  if (r.reception && multi.has(r.reception)) return { drop: 'multiParcel' };
  const at = r.parid && parcels.get(r.parid);
  if (!at) return { drop: 'noLocation' };
  return { sale: { lat: at[0], lng: at[1], price: r.price, date: r.date, type } };
}

// Every row through classify(): each lands in exactly one `dropped` bucket or
// in `sales`, so the counts always add up to the rows read.
export const DROP_REASONS = ['badDate', 'notWarrantyDeed', 'nominal', 'nonResidential', 'multiParcel', 'duplicate', 'quickResale', 'noLocation'];
const daysBetween = (a, b) => (Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 864e5;
// b sold after a: a later date, or the same date under a later reception
// number (the order the deeds were recorded in).
const soldAfter = (a, b) => b.date > a.date || (b.date === a.date && !!a.reception && !!b.reception && b.reception > a.reception);
export function reduceSales(rows, { parcels }) {
  const multi = multiParcelReceptions(rows);
  const dropped = Object.fromEntries(DROP_REASONS.map(k => [k, 0]));
  const kept = [], seen = new Set();
  for (const r of rows) {
    // A row that would be kept but repeats one already kept is a duplicate;
    // the order of the checks keeps every other reason ahead of it.
    const c = classify(r, { multi, parcels: { get: () => [0, 0] } });
    if (c.drop) { dropped[c.drop]++; continue; }
    const key = `${r.parid}|${r.reception ?? `${r.date}|${r.price}`}`;
    if (seen.has(key)) { dropped.duplicate++; continue; }
    seen.add(key);
    kept.push(r);
  }
  // quickResale: the first of two counted sales of one parcel within
  // RESALE_DAYS (see the header).
  const byParcel = new Map();
  for (const r of kept) byParcel.set(r.parid, [...(byParcel.get(r.parid) || []), r]);
  const sales = [];
  for (const r of kept) {
    if (byParcel.get(r.parid).some(o => o !== r && soldAfter(r, o) && daysBetween(r.date, o.date) <= RESALE_DAYS)) { dropped.quickResale++; continue; }
    const placed = classify(r, { multi, parcels });
    if (placed.drop) { dropped[placed.drop]++; continue; }
    sales.push(placed.sale);
  }
  return { sales, dropped };
}

// ── ArcGIS ──────────────────────────────────────────────────────────────────
const sha = s => createHash('sha256').update(s).digest('hex');
const json = (ctx, buf, file, what) => {
  let doc = null;
  try { doc = JSON.parse(buf.toString('utf8')); } catch {}
  // ArcGIS answers a bad query with HTTP 200 and an {error} body: forget it,
  // so the next run asks again rather than reading it from the cache.
  if (!doc || doc.error) { ctx.discard?.(file); throw new Error(`${ID}: ${what}: ${doc?.error?.message || 'not JSON'}`); }
  return doc;
};
const ofTag = (p, tag) => p.file.startsWith(`${ID}-${tag}`);
function dropProvenance(ctx, tag) { for (let i = ctx.provenance.length - 1; i >= 0; i--) if (ofTag(ctx.provenance[i], tag)) ctx.provenance.splice(i, 1); }

// One provenance record per layer instead of one per page, so index.json
// stays small (dc-cama-sales does the same): the layer, its data stamp, and a
// hash of exactly the attributes used.
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

// The layer's data-edit stamp (ms): names the cache of its pages, so a reload
// is a new set of files. A discovery question, not data.
async function layerStamp(ctx, layer, tag, maxAgeH) {
  const file = `${ID}-${tag}-layer.json`;
  const doc = json(ctx, await ctx.download(file, `${layer}?f=json`, { maxAgeH }), file, `${tag} layer`);
  dropProvenance(ctx, `${tag}-layer`);
  const stamp = doc.editingInfo?.dataLastEditDate ?? doc.editingInfo?.lastEditDate;
  if (!Number.isFinite(stamp)) throw new Error(`${ID}: the ${tag} layer has no edit date — the service changed`);
  return stamp;
}

// One query page. ArcGIS Online answers a query it timed out on with HTTP 200
// and {"error": "Cannot perform query. Invalid query parameters."} (seen on
// one Parcels page of 24 on 29 Sep 2026; the same URL answered a minute
// later). ctx retries only 429/503, so such an answer is forgotten and asked
// once more after a pause; a second error throws.
async function page(ctx, file, url, what, { maxAgeH }) {
  for (let attempt = 1; ; attempt++) {
    try { return json(ctx, await ctx.download(file, url, { maxAgeH, timeoutMs: 300_000 }), file, what); }
    catch (e) {
      if (attempt > 1 || ctx.frozen || !/: (Cannot perform query|not JSON)/.test(e.message)) throw e;
      ctx.log(`  ${e.message}; asking once more in 10s`);
      await new Promise(r => setTimeout(r, 10_000));
    }
  }
}

const tooMany = (tag, got, want, distinct) => Object.assign(
  new Error(`${ID}: ${tag}: read ${got} rows (${distinct} distinct) but the layer counts ${want} — it was reloaded while being read`), { code: 'RELOADED' });

// The sales: every row of the where clause, SALES_PAGE at a time by offset
// (a few pages), checked against the layer's own count for the same clause.
async function offsetRows(ctx, layer, params, tag, { maxAgeH, maxPages }) {
  const cq = new URLSearchParams({ where: params.where, returnCountOnly: 'true', f: 'json' });
  const cfile = `${ID}-${tag}-count-${sha(cq.toString()).slice(0, 10)}.json`;
  const count = (await page(ctx, cfile, `${layer}/query?${cq}`, `${tag} count`, { maxAgeH })).count;
  dropProvenance(ctx, `${tag}-count`);
  if (!Number.isInteger(count)) throw new Error(`${ID}: the ${tag} count query returned no count`);
  const rows = [];
  for (let offset = 0, i = 0; ; i++) {
    if (i >= maxPages) throw new Error(`${ID}: ${tag} needs more than ${maxPages} pages — the query is wrong`);
    const q = new URLSearchParams({ ...params, orderByFields: 'OBJECTID', resultOffset: String(offset), resultRecordCount: String(SALES_PAGE), maxRecordCountFactor: '5', f: 'json' });
    const file = `${ID}-${tag}-${sha(q.toString()).slice(0, 10)}.json`;
    const doc = await page(ctx, file, `${layer}/query?${q}`, tag, { maxAgeH });
    if (!Array.isArray(doc.features)) { ctx.discard?.(file); throw new Error(`${ID}: ${tag}: no features array`); }
    rows.push(...doc.features);
    if (!doc.features.length || (!doc.exceededTransferLimit && doc.features.length < SALES_PAGE)) break;
    offset += doc.features.length;
  }
  const ids = new Set(rows.map(f => f.attributes.OBJECTID));
  if (rows.length !== count || ids.size !== rows.length) throw tooMany(tag, rows.length, count, ids.size);
  return rows;
}

// Parcels: every row, by OBJECTID RANGE (keyset paging), PARCELS_SPAN ids a
// query. Offset paging made the server sort the whole layer for every page
// (6–16 s a page of 2,000 on 29 Sep 2026, and one page timed out); a range of
// ids takes about 2 s for ~9,000 rows. The layer's own count, lowest and
// highest id come first, and the rows read must match the count.
async function rangeRows(ctx, layer, params, tag, { maxAgeH }) {
  const stats = [['count', 'n'], ['min', 'lo'], ['max', 'hi']].map(([t, o]) => ({ statisticType: t, onStatisticField: 'OBJECTID', outStatisticFieldName: o }));
  const sq = new URLSearchParams({ where: '1=1', outStatistics: JSON.stringify(stats), f: 'json' });
  const sfile = `${ID}-${tag}-stats.json`;
  const st = (await page(ctx, sfile, `${layer}/query?${sq}`, `${tag} stats`, { maxAgeH })).features?.[0]?.attributes;
  dropProvenance(ctx, `${tag}-stats`);
  if (!st || ![st.n, st.lo, st.hi].every(Number.isInteger) || st.hi < st.lo) throw new Error(`${ID}: the ${tag} statistics query returned ${JSON.stringify(st)}`);
  const rows = [];
  for (let lo = st.lo; lo <= st.hi; lo += PARCELS_SPAN) {
    const q = new URLSearchParams({ ...params, where: `OBJECTID >= ${lo} AND OBJECTID < ${lo + PARCELS_SPAN}`, resultRecordCount: '10000', maxRecordCountFactor: '5', f: 'json' });
    const file = `${ID}-${tag}-${sha(q.toString()).slice(0, 10)}.json`;
    const doc = await page(ctx, file, `${layer}/query?${q}`, tag, { maxAgeH });
    // A range never holds more ids than the page cap, so a cut page is a
    // changed service, not a big range.
    if (!Array.isArray(doc.features) || doc.exceededTransferLimit) { ctx.discard?.(file); throw new Error(`${ID}: ${tag}: ids ${lo}+ came back ${doc.exceededTransferLimit ? 'cut short' : 'without a features array'}`); }
    rows.push(...doc.features);
  }
  const ids = new Set(rows.map(f => f.attributes.OBJECTID));
  if (rows.length !== st.n || ids.size !== rows.length) throw tooMany(tag, rows.length, st.n, ids.size);
  return rows;
}

// Read twice at most: a reload between the count and the last page makes the
// second read, under the new stamp, whole.
async function readLayer(ctx, layer, tag, read, maxAgeH) {
  for (let attempt = 1; ; attempt++) {
    const stamp = await layerStamp(ctx, layer, tag, attempt === 1 ? Math.min(maxAgeH, 6) : 0);
    try { return { ...(await read(`${tag}-${stamp}`, stamp)), stamp }; }
    catch (e) {
      if (e.code !== 'RELOADED' || attempt > 1 || ctx.frozen) throw e;
      ctx.log(`  ${e.message}; reading it again`);
      dropProvenance(ctx, `${tag}-${stamp}`);
    }
  }
}

const SALE_FIELDS = ['OBJECTID', 'PARID', 'RECEPTION_NUM', 'INSTRUMENT', 'SALE_YEAR', 'SALE_MONTHDAY', 'RECEPTION_DATE', 'SALE_PRICE', 'D_CLASS_N'];

// `from` is worked out from the layer's data-edit stamp (see THE WINDOW), so
// each read of readLayer (a second one after a reload) asks its own.
async function readSales(ctx, { today, months, lagMonths }) {
  const maxAgeH = 12;
  const { rows, stamp, from, where } = await readLayer(ctx, SALES_LAYER, 'sales', async (tag, stamp) => {
    const reloaded = new Date(stamp).toISOString().slice(0, 10);
    const from = readFrom(reloaded < today ? reloaded : today, months, lagMonths), where = whereFrom(from);
    const params = { where, outFields: SALE_FIELDS.join(','), returnGeometry: 'false' };
    return { rows: await offsetRows(ctx, SALES_LAYER, params, tag, { maxAgeH, maxPages: 30 }), from, where };
  }, maxAgeH);
  const attrs = rows.map(f => f.attributes);
  if (attrs.length) {
    const missing = SALE_FIELDS.filter(k => !(k in attrs[0]));
    if (missing.length) throw new Error(`${ID}: the sales table has no ${missing.join(', ')} — the schema changed`);
  }
  collapseProvenance(ctx, `sales-${stamp}`, {
    file: 'Real Property Sales and Transfers (Denver Open Data Catalog)', url: SALES_LAYER, item: ITEM.sales, where,
    lastModified: new Date(stamp).toISOString(),
    sha256: sha(JSON.stringify(attrs.map(a => SALE_FIELDS.slice(1).map(k => a[k])).sort())),
  });
  return { rows: attrs.map(normalise), from };
}

// Parcels: schedule number -> [lat, lng], the parcel's centroid.
async function readParcels(ctx) {
  const params = { outFields: 'OBJECTID,SCHEDNUM', returnGeometry: 'false', returnCentroid: 'true', outSR: '4326' };
  const { rows, stamp } = await readLayer(ctx, PARCELS_LAYER, 'parcels', async tag => ({ rows: await rangeRows(ctx, PARCELS_LAYER, params, tag, { maxAgeH: PARCELS_MAX_AGE_H }) }), PARCELS_MAX_AGE_H);
  if (rows.length < 200_000) throw new Error(`${ID}: Parcels returned ${rows.length} parcels; Denver has about 240,000 — refusing a partial layer`);
  const parcels = new Map();
  let repeats = 0, noPoint = 0;
  for (const f of rows) {
    const s = String(f.attributes.SCHEDNUM ?? '').trim(), c = f.centroid;
    if (!/^\d{13}$/.test(s)) continue;                   // no schedule number: nothing can join to it
    if (!c || !Number.isFinite(c.x) || !Number.isFinite(c.y)) { noPoint++; continue; }
    if (c.y < BOUNDS.s || c.y > BOUNDS.n || c.x < BOUNDS.w || c.x > BOUNDS.e) throw new Error(`${ID}: a parcel centroid at ${c.y},${c.x} is outside Colorado — the spatial reference changed`);
    if (parcels.has(s)) { repeats++; continue; }         // one schedule number drawn as several features: the first
    parcels.set(s, [c.y, c.x]);
  }
  collapseProvenance(ctx, `parcels-${stamp}`, {
    file: 'Parcels (Denver Open Data Catalog)', url: PARCELS_LAYER, item: ITEM.parcels,
    lastModified: new Date(stamp).toISOString(),
    sha256: sha(JSON.stringify([...parcels].sort((a, b) => (a[0] < b[0] ? -1 : 1)))),
  });
  return { parcels, repeats, noPoint, rows: rows.length };
}

// ── fetch ───────────────────────────────────────────────────────────────────
// Also the measuring entry point: `months` / `lagMonths` override the
// module's window (12 against 24 months), and `inspect` is handed the rows.
export async function fetchSales(ctx, { months = WINDOW.months, lagMonths = WINDOW.lagMonths, today = new Date().toISOString().slice(0, 10), inspect = null } = {}) {
  const t0 = Date.now();
  const served = REGIONS.map(id => ({ id, reg: ctx.regions?.[id] })).filter(r => r.reg);
  if (!served.length) throw new Error(`${ID}: none of ${REGIONS.join(', ')} is in coverage.json`);
  for (const { id, reg } of served) if (!reg.juris?.includes('US-CO')) throw new Error(`${ID}: region ${id} is not in Colorado (juris ${reg.juris})`);

  const { rows, from } = await readSales(ctx, { today, months, lagMonths });
  const { parcels, repeats, noPoint, rows: parcelRows } = await readParcels(ctx);
  const { sales, dropped } = reduceSales(rows, { parcels });
  inspect?.({ rows, parcels, sales, dropped, from });

  // The window the build will take from these sales must lie inside what was
  // read, and must hold a Denver-sized number of sales (~800 a month).
  const current = sales.filter(s => s.date <= today);
  if (!current.length) throw new Error(`${ID}: no sale kept from ${rows.length} rows — a filter or the format is wrong`);
  const latest = current.reduce((m, s) => (s.date > m ? s.date : m), '');
  const through = completeThrough(latest);
  const w = saleWindow({ latest, months, lagMonths, through });
  const age = (Date.parse(`${today}T00:00:00Z`) - Date.parse(`${latest}T00:00:00Z`)) / 864e5;
  if (age > STALE_DAYS) ctx.warn(`${ID}: the newest sale in the table is ${latest}, ${Math.round(age)} days ago — its reloads may have stopped`);
  if (`${w.from}-01` < from) throw new Error(`${ID}: the newest sale is ${latest}, so the window starts ${w.from}, before the ${from} this module read from — the table is stale`);
  const inWin = current.filter(s => s.date.slice(0, 7) >= w.from && s.date.slice(0, 7) <= w.to).length;
  if (inWin < 400 * months) throw new Error(`${ID}: only ${inWin} sales kept in ${w.span} — Denver has about 800 a month; the table or a filter changed`);
  if (dropped.noLocation > 0.1 * (dropped.noLocation + sales.length)) throw new Error(`${ID}: ${dropped.noLocation} sales have no parcel — the parcel join is broken`);

  const types = {};
  for (const s of sales) types[s.type] = (types[s.type] || 0) + 1;
  ctx.log(`  ${ID}: ${rows.length} rows dated from ${from}; newest kept sale ${latest}, complete through ${through}, so the build's window is ${w.span}; ` +
    `${sales.length} sales (${Object.entries(types).map(([k, v]) => `${v} ${k}`).join(', ')}); ` +
    `dropped ${Object.entries(dropped).map(([k, v]) => `${k} ${v}`).join(', ')}; ` +
    `${parcels.size} parcels located of ${parcelRows} (${repeats} repeated parts, ${noPoint} without a centroid); ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  return {
    vintage: `${w.from}..${w.to}`,     // the build finds the same window from the sales and `through`
    through,                           // measured, not the publisher's statement: see WINDOW
    // The City and County of Denver is one county (08031), all of it in the
    // table: this source replaces acs-tract for every Denver tract.
    covers: { juris: ['US-CO'], counties: [COUNTY] },
    sales,
    dropped,
  };
}

export default {
  id: ID,
  kind: 'point-sales',
  regions: REGIONS,
  cadence: 'monthly',       // the table's months fill over about 75 days; the build fetches every run
  geometry: 'acs-tract',
  meta,
  fetch: ctx => fetchSales(ctx),
};
