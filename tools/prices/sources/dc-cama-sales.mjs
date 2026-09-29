// Washington DC: RECORDED home sales from the Office of Tax and Revenue's
// assessment system (CAMA), "Tax System Property Sales (CAMA)" on Open Data DC
// (item ee35b5aa5ca643679fb37c141c532a92 = DCGIS Property_and_Land layer 57),
// returned as individual sales for the orchestrator to aggregate onto the
// census tracts acs-tract already draws for DC (kind 'point-sales', SPEC2 §B).
//
// WHAT COUNTS AS A SALE (SPEC2 §C), in the order fetch() applies it; every row
// read lands in exactly one `dropped` bucket or is returned as a sale:
//   noDate         no sale date
//   notQualified   QUALIFIED is not "Q". The Assessment Division's own flag:
//                  "Q" = "a single-parcel sale considered to be a valid,
//                  arms-length market sale"; "U" = every multi-parcel sale
//                  (SALE_CODE M…) and every sale it judged unfit for market
//                  analysis (related parties, foreclosures, government, quick
//                  resale, tax-sale deeds, corrective deeds: codes 2–8, T1).
//   vacantLot      qualified, but SALE_CODE 9, "arms-length market value of a
//                  vacant lot": land, not a home.
//   otherCode      qualified with any code but 1 or 9 (the layer's metadata
//                  allows none; counted so a change shows, never kept).
//   nominal        price missing or under $10,000 (the NYC floor, SPEC2 §C):
//                  a handful of "qualified" rows at $1,133–$9,000 are not home
//                  prices whatever their flag says.
//   duplicate      the same SSL, date and price twice.
//   notOnTaxRoll   the SSL is not on the current tax roll (ITSPE Facts): a
//                  retired lot, e.g. one since split into condominium units.
//   nonResidential the roll's CURRENT land-use code is not a home (RESIDENTIAL
//                  below): offices, shops, apartment buildings, parking, lots.
//   noLocation     the roll gives the SSL no Master Address Repository address,
//                  or none of its addresses has an address point.
// The build then drops, and counts, sales dated after the build day and
// outside the window (lib/sales.mjs), and those outside every DC tract.
// Location is the official join only, never a geocode: SSL -> ITSPE Facts
// ADDRESS_ID (the tax roll's own MAR address ids) -> MAR Address Points
// LATITUDE/LONGITUDE. A condominium unit's address is its building's, which
// is all a tract median needs.
//
// THE WINDOW is by SALE_DATE, which the layer defines as the date the sale
// "was recorded among the District of Columbia's land records" (window.by
// 'recording'). The build takes meta.window.months months ending at the
// latest complete month (lib/sales.mjs saleWindow). This source also returns
// `through`: the last month that ended at least COMPLETE_AFTER_DAYS before
// the newest sale in the layer. That is not the publisher's statement but a
// measured one (see WINDOW); it stops a build run in mid-month from ending
// its window on a month whose recordings are still arriving.
//
// HOSTS. The sales layer and the address points are served only by DC's
// self-hosted ArcGIS Server (maps2.dcgis.dc.gov; SafeRoute's backend already
// reaches it from Render). Open Data DC's download of the same layers is an
// Esri Hub cache BUILT FROM that server (createReplica on it), and on
// 29 Sept 2026 it was stale: the sales CSV dated 2 Sept (sales to 21 Aug), the
// address points 19 Aug, with the Hub's last rebuild jobs logged "failed". So
// the live server is read first and the Hub CSV only if it cannot be reached,
// which then moves the window back to whatever that file holds (the window
// always follows the data). The tax-roll lookup (ITSPE Facts) IS hosted on
// ArcGIS Online (services.arcgis.com, refreshed daily), so it is read there,
// its current service URL resolved from its item id (the service name carries
// a date and has changed before).
//
// PRIVACY (SPEC2 §B.5–6): the sales carry only lat, lng, price, date and a
// type, and none of them reaches a tile; the orchestrator publishes tract
// aggregates only. No owner, address, SSL or parcel field is ever requested
// beyond the SSL and address ids needed for the join.

import { createHash } from 'node:crypto';
import { unlinkSync } from 'node:fs';
import { join } from 'node:path';

const ID = 'dc-cama-sales';
const DCGIS = 'https://maps2.dcgis.dc.gov/dcgis/rest/services/DCGIS_DATA';
const SALES_LAYER = `${DCGIS}/Property_and_Land_WebMercator/MapServer/57`;
const ADDRESS_LAYER = `${DCGIS}/Location_WebMercator/MapServer/0`;
const ITEM = {
  sales: 'ee35b5aa5ca643679fb37c141c532a92',     // Tax System Property Sales (CAMA), layer 57
  facts: '6c3a37dfce05413bb11937dd66cf89b7',     // Integrated Tax System Public Extract Facts (ArcGIS Online)
  address: 'aa514416aaf74fdc94748f1e56e7cc8a',   // Address Points (MAR), layer 0
};
const AGOL_ITEM = id => `https://www.arcgis.com/sharing/rest/content/items/${id}?f=json`;
const HUB_CSV = (id, layer) => `https://opendata.dc.gov/api/download/v1/items/${id}/csv?layers=${layer}`;

// WINDOW (measured 29 Sept 2026 against DC's 206 census tracts):
//   months 12: Sep 2025 – Aug 2026 gives 166 tracts (81%) at least 10 sales
//     and leaves 40 (19%) under 10, 7 of them with no home sale in two years
//     and no ACS figure either (the National Mall, Joint Base Anacostia-
//     Bolling, Georgetown University, the RFK stadium site…). That is under
//     SPEC2's 30% bar, so 12 months: 24 would lift it to 188 tracts (91%) but
//     blend two years of prices into one figure.
//   COMPLETE_AFTER_DAYS 21: in Open Data DC's extract of 1 Sept 2026 the
//     newest sale was recorded 21 Aug. July, which had ended 21 days before
//     that, then gained only 5 more rows (0.4%) by 29 Sept; August, not yet
//     over, gained 41%. So a month that ended 21 days before the newest sale
//     is complete. The newest sale trails the calendar by 8–11 days, so the
//     monthly build (the 5th) ends its window on the month before last, and
//     lagMonths stays 0: a whole extra month back would only make it staler.
//   What no lag cures: the assessors keep reviewing sales. Between 1 and
//   29 Sept they took the qualified mark off 6–7% of June and July 2026 sales
//   (651 -> 614, 657 -> 610); April and older did not move. Every monthly
//   build re-reads the whole window, so the newest months can shift slightly.
const WINDOW = { months: 12, by: 'recording', lagMonths: 0 };
const COMPLETE_AFTER_DAYS = 21;
const MIN_PRICE = 10_000;
const PAGE = 2000;                 // both servers' maxRecordCount
const FACTS_PAGE = 10_000;         // ArcGIS Online: maxRecordCount 2000 × maxRecordCountFactor 5
const ADDRESS_BATCH = 400;         // MAR ids per IN (…) query: ~3 KB of URL; maps2's IIS 404s past ~8 KB
const ROLL_MAX_AGE_H = 24 * 7;     // the tax roll and address points change slowly

// DC's property use codes (ITS "Property Use Codes", DCGIS layer 54) that are
// a home one household buys. Left out on purpose: 014/018/416/417 garages and
// parking units; 015 residential over shops (mixed use); 021/022/025/029
// apartment buildings (5+ units: investment property, not a home); 026–028
// and 126/127 co-operative BUILDINGS (a co-op apartment is not a separate
// property on the roll, so its sale cannot be told from the building's);
// 001–003, "(NC)" codes, and every non-residential code.
export const RESIDENTIAL = {
  '011': 'single-family', '012': 'single-family', '013': 'single-family', '019': 'single-family',   // row, detached, semi-detached, misc
  '016': 'condo', '017': 'condo', '116': 'condo', '117': 'condo', '216': 'condo', '217': 'condo',    // horizontal/vertical, combined, investment
  '316': 'condo', '516': 'condo',                                                                      // condo duplex, detached condo
  '023': '2-4 unit', '024': '2-4 unit',                                                                // flats and conversions, fewer than 5 units
};

const meta = {
  name: 'Tax System Property Sales (CAMA), located through the Integrated Tax System Public Extract and MAR Address Points',
  publisher: 'District of Columbia Office of the Chief Financial Officer, Office of Tax and Revenue',
  url: `https://opendata.dc.gov/datasets/${ITEM.sales}_57`,
  licence: 'Creative Commons Attribution 4.0 International (CC BY 4.0)',
  licenceUrl: 'https://creativecommons.org/licenses/by/4.0/',
  // CC BY 4.0 asks for the source, the licence and a note of changes.
  attribution: [
    'Property sales: District of Columbia Office of the Chief Financial Officer, Office of Tax and Revenue, Tax System Property Sales (CAMA), Open Data DC, CC BY 4.0.',
    'Property use and address: Integrated Tax System Public Extract Facts (Office of Tax and Revenue) and Address Points (Master Address Repository, Office of the Chief Technology Officer), Open Data DC, CC BY 4.0.',
    'Changed by SafeRoute: qualified home sales only, aggregated to census-tract medians.',
  ],
  metric: 'Median sale price',
  unitNoun: 'sales',
  currency: 'USD',
  // period and areaNoun are the build's to fill: the window it finds, and
  // the geometry source's area noun (census tract).
  window: { ...WINDOW },
  notes: [
    'Sales recorded in DC’s land records that the Office of Tax and Revenue’s assessors mark as “qualified”: a single property sold at arm’s length at a market price. Sales between related parties, foreclosures, tax-sale deeds, sales of several properties for one price, other transfers the assessors judged not to be market sales, and sales under $10,000 are left out.',
    'Homes only, by each property’s current use code on the tax roll: row, semi-detached and detached houses, condominium apartments, and buildings of two to four flats. Apartment buildings of five or more units, garages and parking spaces, vacant land, and shops or offices are left out. ' +
      'Co-op apartments are not included at all: a co-op apartment is not a separate property on DC’s tax roll, so its sale cannot be told from a sale of the whole building.',
    'Each sale is placed at its property’s official address point; a sale whose property has no address point is left out.',
    'Rebuilt monthly. The assessors keep reviewing recent sales, so figures for the newest months can shift slightly from one update to the next.',
  ],
  colourMinN: 10,
  credit: 'DC Office of Tax and Revenue',
};

// ── dates ───────────────────────────────────────────────────────────────────
// SALE_DATE is an ArcGIS date (ms) at midnight America/New_York (the layer's
// dateFieldsTimeReference); the Hub CSV writes the same instant in UTC.
const NY_DATE = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' });
export const localDate = ms => (Number.isFinite(ms) ? NY_DATE.format(new Date(ms)) : null);
const monthIdx = ym => { const [y, m] = ym.split('-').map(Number); return y * 12 + (m - 1); };
const monthStr = i => `${Math.floor(i / 12)}-${String((i % 12) + 1).padStart(2, '0')}`;

// 'YYYY-MM': the last month that ended at least `days` before `newest`
// ('YYYY-MM-DD', the newest sale in the layer). See WINDOW.
export function completeThrough(newest, days = COMPLETE_AFTER_DAYS) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(newest || '')) throw new Error(`${ID}: newest sale date "${newest}" is not a date`);
  const cut = new Date(Date.parse(`${newest}T00:00:00Z`) - days * 864e5);
  const y = cut.getUTCFullYear(), m = cut.getUTCMonth();
  // The cutoff's own month counts only if the cutoff is its last day.
  const whole = new Date(Date.UTC(y, m, cut.getUTCDate() + 1)).getUTCMonth() !== m;
  return monthStr(y * 12 + m - (whole ? 0 : 1));
}

// The first day the build's window can reach: `months` back from `through`,
// less lagMonths. Rows before it are never read (the query starts here).
export const readFrom = (through, months = WINDOW.months, lagMonths = WINDOW.lagMonths) =>
  `${monthStr(monthIdx(through) - lagMonths - months + 1)}-01`;

// ── the filter (pure; tools/prices/test/dc-cama-sales.test.mjs) ─────────────
// row:  { ssl, date: 'YYYY-MM-DD' | null, price, qualified, code }
// roll: Map ssl -> { use: '011', addressIds: ['47878', …] }
// points: Map MAR id -> { lat, lng }
// Returns { drop: '<reason>' } or { sale: { lat, lng, price, date, type } }.
// Duplicates are reduceSales()'s (they need the rows already kept); the
// window and future dates are the build's.
export function classify(row, { roll, points }) {
  const { date, price } = row;
  if (!date) return { drop: 'noDate' };
  if (row.qualified !== 'Q') return { drop: 'notQualified' };
  const code = String(row.code ?? '').trim().replace(/^0(?=\d$)/, '');
  if (code === '9') return { drop: 'vacantLot' };
  if (code !== '1') return { drop: 'otherCode' };
  if (!(price >= MIN_PRICE)) return { drop: 'nominal' };
  const r = roll.get(row.ssl);
  if (!r) return { drop: 'notOnTaxRoll' };
  const type = RESIDENTIAL[r.use];
  if (!type) return { drop: 'nonResidential' };
  const pt = r.addressIds.map(id => points.get(id)).find(Boolean);
  if (!pt) return { drop: 'noLocation' };
  return { sale: { lat: pt.lat, lng: pt.lng, price, date, type } };
}

// Every row through classify(), plus duplicates: each row lands in exactly
// one `dropped` bucket or in `sales`, so the counts always add up to rows.
export const DROP_REASONS = ['noDate', 'notQualified', 'vacantLot', 'otherCode', 'nominal', 'duplicate', 'notOnTaxRoll', 'nonResidential', 'noLocation'];
export function reduceSales(rows, lookups) {
  const dropped = Object.fromEntries(DROP_REASONS.map(k => [k, 0]));
  const sales = [], seen = new Set();
  for (const r of rows) {
    const c = classify(r, lookups);
    if (c.drop) { dropped[c.drop]++; continue; }
    const key = `${r.ssl}|${r.date}|${r.price}`;
    if (seen.has(key)) { dropped.duplicate++; continue; }
    seen.add(key);
    sales.push(c.sale);
  }
  return { sales, dropped };
}

// '237616,306561' -> ['237616', '306561']; the roll lists every address of a
// multi-address property, all on the same lot.
export const addressIdsOf = s => String(s ?? '').match(/\d+/g) || [];

// ── ArcGIS paging ───────────────────────────────────────────────────────────
const sha = s => createHash('sha256').update(s).digest('hex');

// ArcGIS answers a bad query with HTTP 200 and an {error} body; a cached error
// would be re-read until it expires, so it is deleted before failing. The
// query's hash is in the cache name, so a changed window or field list is
// never answered from an older query's page. `name` fixes the cache name
// instead (a one-page question whose URL changes daily; see liveSales).
async function arcgisRows(ctx, layer, params, tag, { page = PAGE, maxAgeH = 12, maxPages = 60, once = false, name = null } = {}) {
  const rows = [];
  for (let offset = 0, i = 0; ; i++) {
    if (i >= maxPages) throw new Error(`${ID}: ${tag} needs more than ${maxPages} pages — the query is wrong`);
    const q = new URLSearchParams({ ...params, resultOffset: String(offset), resultRecordCount: String(page), returnGeometry: 'false', f: 'json' });
    const url = `${layer}/query?${q}`;
    const file = name || `${ID}-${tag}-${sha(url).slice(0, 10)}.json`;
    const buf = await ctx.download(file, url, { maxAgeH, timeoutMs: 180_000 });
    let doc = null;
    try { doc = JSON.parse(buf.toString('utf8')); } catch {}
    if (!doc || doc.error || !Array.isArray(doc.features)) {
      if (ctx.rawDir) { try { unlinkSync(join(ctx.rawDir, file)); } catch {} }
      throw new Error(`${ID}: ArcGIS ${tag}: ${doc?.error?.message || (doc ? 'no features array' : 'not JSON')}`);
    }
    for (const f of doc.features) rows.push(f.attributes);
    if (once || !doc.features.length || (!doc.exceededTransferLimit && doc.features.length < page)) break;
    offset += doc.features.length;
  }
  return rows;
}

const ofTag = (p, tag) => p.file.startsWith(`${ID}-${tag}-`) || p.file === `${ID}-${tag}.json`;
function dropProvenance(ctx, tag) { for (let i = ctx.provenance.length - 1; i >= 0; i--) if (ofTag(ctx.provenance[i], tag)) ctx.provenance.splice(i, 1); }
const forget = (ctx, tag) => { for (const p of ctx.provenance.filter(p => p.file.startsWith(`${ID}-${tag}-`))) { try { unlinkSync(join(ctx.rawDir, p.file)); } catch {} } };

// One provenance record per layer instead of one per query page, so
// index.json stays small (tools/schools/sources/ccd.mjs does the same): the
// layer, its data stamp, and a hash of exactly the attributes used.
function collapseProvenance(ctx, tag, record) {
  const pages = ctx.provenance.filter(p => ofTag(p, tag));
  if (!pages.length) return;
  dropProvenance(ctx, tag);
  ctx.provenance.push({
    status: 200, etag: null, queries: pages.length,
    fetchedAt: pages.map(p => p.fetchedAt).filter(Boolean).sort().pop() || null,
    // All pages from the raw cache: the build then dates the data by its
    // download, not by the build day (the build drops this flag itself).
    cached: pages.every(p => p.cached),
    bytes: pages.reduce((a, p) => a + (p.bytes || 0), 0), ...record,
  });
}

// ── the sales ───────────────────────────────────────────────────────────────
const SALE_FIELDS = ['SSL', 'SALE_DATE', 'SALE_PRICE', 'QUALIFIED', 'SALE_CODE', 'GIS_LAST_MOD_DTTM'];
const sslKey = s => String(s ?? '').trim();   // internal spaces are part of an SSL ("0013    2083")
const normalise = a => ({ ssl: sslKey(a.SSL), date: localDate(a.SALE_DATE), price: a.SALE_PRICE, qualified: a.QUALIFIED, code: a.SALE_CODE });

// Live: the newest sale date first (one row), then every row from the first
// day the build's window can reach. The table is reloaded daily with new
// OBJECTIDs, so every row must carry one reload stamp; pages that straddle a
// reload are fetched again once. The newest-date question names today in its
// URL, so it is cached under one fixed name: were the name the URL's hash, a
// --frozen rebuild on any later day would find no answer, fall back to the
// Hub copy, and quietly build a different window from the same cache.
async function liveSales(ctx, months, lagMonths, today) {
  const top = await arcgisRows(ctx, SALES_LAYER, {
    where: `SALE_DATE <= DATE '${today}'`, outFields: 'SALE_DATE', orderByFields: 'SALE_DATE DESC',
  }, 'newest', { page: 1, once: true, maxAgeH: 6, name: `${ID}-newest.json` });
  dropProvenance(ctx, 'newest');     // a discovery query, not data
  const newest = localDate(top[0]?.SALE_DATE);
  if (!newest) throw new Error(`${ID}: the sales layer returned no dated sale`);
  const through = completeThrough(newest), from = readFrom(through, months, lagMonths);
  const params = { where: `SALE_DATE >= DATE '${from}'`, outFields: SALE_FIELDS.join(','), orderByFields: 'OBJECTID' };
  for (let attempt = 1; ; attempt++) {
    const rows = await arcgisRows(ctx, SALES_LAYER, params, 'sales', { maxPages: 40 });
    const stamps = new Set(rows.map(r => r.GIS_LAST_MOD_DTTM));
    if (stamps.size === 1) {
      collapseProvenance(ctx, 'sales', {
        file: 'DCGIS Property_and_Land layer 57 (Tax System Property Sales, CAMA)', url: SALES_LAYER,
        lastModified: new Date([...stamps][0]).toISOString(), where: params.where,
        sha256: sha(JSON.stringify(rows.map(r => SALE_FIELDS.slice(0, 5).map(f => r[f])).sort())),
      });
      return { rows: rows.map(normalise), newest, through, from, via: 'maps2.dcgis.dc.gov (live)' };
    }
    if (attempt > 1) throw new Error(`${ID}: the sales layer was reloaded while it was being read (${stamps.size} reload stamps)`);
    ctx.log(`  ${ID}: pages straddle a daily reload; reading the rows again`);
    forget(ctx, 'sales');
    dropProvenance(ctx, 'sales');
  }
}

// The Hub CSV: one file of the whole table (37 MB, ~420,000 rows). Rows
// before `from` are left out, as the live query never reads them.
async function hubSales(ctx, months, lagMonths, today) {
  const buf = await ctx.download(`${ID}-hub-sales.csv`, HUB_CSV(ITEM.sales, 57), { maxAgeH: 24, timeoutMs: 600_000 });
  const recs = ctx.readers.records(buf);
  if (!recs.length) throw new Error(`${ID}: the Open Data DC sales CSV is empty`);
  ctx.readers.columns(Object.keys(recs[0]), SALE_FIELDS, `${ID}-hub-sales.csv`);
  // '2026/07/24 04:00:00+00' is UTC; a missing or malformed stamp is no date.
  const ms = s => { const m = /^(\d{4})\/(\d\d)\/(\d\d) (\d\d:\d\d:\d\d)\+00$/.exec(s || ''); return m ? Date.parse(`${m[1]}-${m[2]}-${m[3]}T${m[4]}Z`) : NaN; };
  const rows = recs.map(r => ({ ssl: sslKey(r.SSL), date: localDate(ms(r.SALE_DATE)), price: r.SALE_PRICE === '' ? null : +r.SALE_PRICE, qualified: r.QUALIFIED, code: r.SALE_CODE }));
  const newest = rows.reduce((m, r) => (r.date && r.date <= today && r.date > m ? r.date : m), '');
  if (!newest) throw new Error(`${ID}: the Open Data DC sales CSV has no dated sale`);
  const through = completeThrough(newest), from = readFrom(through, months, lagMonths);
  return { rows: rows.filter(r => !r.date || r.date >= from), newest, through, from, via: 'opendata.dc.gov Hub CSV (fallback)' };
}

// ── the tax roll: SSL -> current use code + MAR address ids ─────────────────
async function taxRoll(ctx) {
  const item = JSON.parse((await ctx.download(`${ID}-facts-item.json`, AGOL_ITEM(ITEM.facts), { maxAgeH: 24 })).toString('utf8'));
  dropProvenance(ctx, 'facts-item');     // resolves the service URL; not data
  if (!/^https:\/\/services\d*\.arcgis\.com\/.+\/FeatureServer\/?$/.test(item.url || '')) {
    throw new Error(`${ID}: ITSPE Facts item ${ITEM.facts} points at "${item.url}", not an ArcGIS Online feature service`);
  }
  const layer = `${item.url.replace(/\/$/, '')}/0`;
  const fields = ['SSL', 'LAND_USE_CODE', 'ADDRESS_ID'];
  // The table is reloaded daily with new OBJECTIDs, so the cache is keyed by
  // the item's modified stamp: pages of two reloads are never mixed.
  const stamp = String(item.modified || 'unknown');
  const rows = await arcgisRows(ctx, layer, { where: '1=1', outFields: ['OBJECTID', ...fields].join(','), orderByFields: 'OBJECTID', maxRecordCountFactor: '5' },
    `facts-${stamp}`, { page: FACTS_PAGE, maxAgeH: ROLL_MAX_AGE_H, maxPages: 60 });
  if (rows.length < 150_000) throw new Error(`${ID}: ITSPE Facts returned ${rows.length} rows; the roll has ~216,000 — refusing a partial roll`);
  if (new Set(rows.map(r => r.OBJECTID)).size !== rows.length) throw new Error(`${ID}: ITSPE Facts pages overlap — the table was reloaded while it was being read`);
  const roll = new Map();
  for (const r of rows) {
    const ssl = sslKey(r.SSL);
    if (!ssl) continue;
    const prev = roll.get(ssl);
    const ids = addressIdsOf(r.ADDRESS_ID);
    // A repeated SSL must agree on its use; its address lists are merged.
    if (prev && prev.use !== r.LAND_USE_CODE) throw new Error(`${ID}: SSL ${r.SSL} has two use codes on the roll (${prev.use}, ${r.LAND_USE_CODE})`);
    if (prev) prev.addressIds.push(...ids.filter(i => !prev.addressIds.includes(i)));
    else roll.set(ssl, { use: r.LAND_USE_CODE, addressIds: ids });
  }
  collapseProvenance(ctx, `facts-${stamp}`, {
    file: 'Integrated Tax System Public Extract Facts (ArcGIS Online)', url: layer, item: ITEM.facts,
    lastModified: item.modified ? new Date(item.modified).toISOString() : null,
    sha256: sha(JSON.stringify(rows.map(r => fields.map(f => r[f])).sort())),
  });
  return roll;
}

// ── the address points: MAR id -> lat/lng ───────────────────────────────────
async function livePoints(ctx, ids) {
  const points = new Map();
  const list = [...ids].sort((a, b) => a - b);
  for (let i = 0; i < list.length; i += ADDRESS_BATCH) {
    const rows = await arcgisRows(ctx, ADDRESS_LAYER, { where: `MAR_ID IN (${list.slice(i, i + ADDRESS_BATCH).join(',')})`, outFields: 'MAR_ID,LATITUDE,LONGITUDE' },
      'points', { maxAgeH: ROLL_MAX_AGE_H, maxPages: 2 });
    for (const r of rows) if (Number.isFinite(r.LATITUDE) && Number.isFinite(r.LONGITUDE)) points.set(String(r.MAR_ID), { lat: r.LATITUDE, lng: r.LONGITUDE });
  }
  collapseProvenance(ctx, 'points', {
    file: 'DCGIS Location layer 0 (Address Points, Master Address Repository)', url: ADDRESS_LAYER, lastModified: null,
    sha256: sha(JSON.stringify([...points].sort((a, b) => a[0] - b[0]))),
  });
  return points;
}

async function hubPoints(ctx, ids) {
  const buf = await ctx.download(`${ID}-hub-points.csv`, HUB_CSV(ITEM.address, 0), { maxAgeH: ROLL_MAX_AGE_H, timeoutMs: 600_000 });
  const recs = ctx.readers.records(buf);
  if (!recs.length) throw new Error(`${ID}: the Open Data DC address points CSV is empty`);
  ctx.readers.columns(Object.keys(recs[0]), ['MAR_ID', 'LATITUDE', 'LONGITUDE'], `${ID}-hub-points.csv`);
  const points = new Map();
  for (const r of recs) {
    if (!ids.has(r.MAR_ID)) continue;
    const lat = +r.LATITUDE, lng = +r.LONGITUDE;
    if (r.LATITUDE !== '' && r.LONGITUDE !== '' && Number.isFinite(lat) && Number.isFinite(lng)) points.set(r.MAR_ID, { lat, lng });
  }
  return points;
}

// ── fetch ───────────────────────────────────────────────────────────────────
// Also the measuring entry point: `months` / `lagMonths` override the module's
// window (the phase-2 report compared 12 with 24 months), and `inspect` is
// handed the joined inputs.
export async function fetchSales(ctx, { months = WINDOW.months, lagMonths = WINDOW.lagMonths, today = localDate(Date.now()), inspect = null } = {}) {
  const t0 = Date.now();
  let got;
  try { got = await liveSales(ctx, months, lagMonths, today); }
  catch (e) {
    ctx.warn(`${ID}: the DC GIS sales layer failed (${e.message}); using Open Data DC's Hub copy, which may be weeks older`);
    dropProvenance(ctx, 'newest'); dropProvenance(ctx, 'sales');     // pages of a failed read are not what the figures came from
    got = await hubSales(ctx, months, lagMonths, today);
  }
  const { rows, newest, through, from, via } = got;
  const roll = await taxRoll(ctx);

  // Look up only the addresses of sales that can still be kept.
  const want = new Set();
  for (const r of rows) if (classify(r, { roll, points: { get: () => true } }).sale) for (const id of roll.get(r.ssl).addressIds) want.add(id);
  let points;
  try { points = await livePoints(ctx, want); }
  catch (e) {
    ctx.warn(`${ID}: the DC GIS address points failed (${e.message}); using Open Data DC's Hub copy (86 MB)`);
    dropProvenance(ctx, 'points');
    points = await hubPoints(ctx, want);
  }

  const { sales, dropped } = reduceSales(rows, { roll, points });
  inspect?.({ rows, roll, points, newest, through, from, via, sales, dropped });

  // A fetch that looks wrong is a failed one (README house rule 8): DC records
  // ~400–650 qualified sales a month, most of them homes.
  const upTo = `${through}-31`;
  const inRange = sales.filter(s => s.date >= from && s.date <= upTo).length;
  if (inRange < 150 * months) throw new Error(`${ID}: only ${inRange} sales kept from ${from} through ${through} — the layer or a join is broken`);
  const lost = dropped.notOnTaxRoll + dropped.noLocation;
  if (lost > 0.1 * (lost + sales.length)) throw new Error(`${ID}: ${lost} qualified sales could not be joined to the roll or an address point — a lookup is partial`);

  const byType = {};
  for (const s of sales) byType[s.type] = (byType[s.type] || 0) + 1;
  ctx.log(`  ${ID}: ${rows.length} rows recorded from ${from} via ${via} (newest ${newest}, complete through ${through}); ` +
    `${sales.length} sales (${Object.entries(byType).map(([k, v]) => `${v} ${k}`).join(', ')}); ` +
    `dropped ${Object.entries(dropped).map(([k, v]) => `${k} ${v}`).join(', ')}; ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  return {
    // DC is one county-equivalent (FIPS 11001) and all of it is covered: this
    // source replaces acs-tract for every DC tract.
    covers: { juris: ['US-DC'], counties: ['11001'] },
    sales,
    dropped,
    through,
  };
}

export default {
  id: ID,
  kind: 'point-sales',
  regions: ['dc'],
  cadence: 'monthly',       // the layer is reloaded daily; a month adds ~500 qualified sales
  geometry: 'acs-tract',
  meta,
  fetch: ctx => fetchSales(ctx),
};
