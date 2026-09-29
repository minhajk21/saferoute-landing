// Baltimore: recorded residential SALE PRICES from the Maryland State
// Department of Assessments and Taxation (SDAT), as the State publishes them on
// its open data portal: "Maryland Real Property Assessments: Hidden Property
// Owner Names" (opendata.maryland.gov ed4q-f8tm, public domain). One row per
// tax account carries the account's last three transfers (SDAT "sales
// segments": transfer date, consideration, SDAT's own arm's-length code), its
// land-use code and the Maryland Department of Planning's (MDP) parcel point.
// The orchestrator places each sale in the region's census tracts (the ones
// acs-tract builds) and publishes only per-tract counts, medians and quartiles
// (tools/prices/README.md, SPEC2 §B).
//
// LICENCE (re-verified 29 Sep 2026). The portal's dataset record declares
// license "Public Domain" (licenseId PUBLIC_DOMAIN), attribution "SDAT (State
// Department of Assessments and Taxation) and MDP (Maryland Department of
// Planning)"; its documentation PDF adds only a liability disclaimer. The same
// SDAT sales are also on MD iMAP (mdgeodata.md.gov PlanningCadastre/
// MD_PropertySales), whose layer metadata says the Data "can be freely
// distributed as long as the metadata entry is not modified or deleted. Any
// data derived from the Data must acknowledge the State of Maryland in the
// metadata." The attribution below acknowledges the State of Maryland, so it
// satisfies either set of terms.
//
// WHY this copy and not MD iMAP's sales layer: an explicit public-domain
// licence; Socrata behind Cloudflare, where mdgeodata.md.gov is the State's
// self-hosted ArcGIS server (self-hosted government ArcGIS hosts have refused
// datacenter IPs in this project); and three transfers per account, so a
// 24-month window stays possible, where the MD iMAP layer keeps one year of
// sales.
//
// CLOUDFLARE: the portal's firewall blocks SoQL that reads like SQL injection
// (a where clause with "is null" got "Sorry, you have been blocked", Sep 2026),
// so the queries here use only IN, comparisons, AND and OR. A block page is
// HTML, not CSV, and fails the column check loudly.
//
// WHICH SALES (every exclusion is counted in `dropped`):
//   - A sale is one of an account's three sales segments whose transfer date
//     (SDAT field #89/#109/#129, "YYYY.MM.DD") is on or after the window's
//     first day, so a home sold twice in the window counts twice. A segment
//     repeating another of the same account (same date and price) is counted
//     once ('duplicate'). A date that is not a real date, or is later than the
//     extract, is a typo ('badDate'; Anne Arundel has a transfer dated
//     2031.01.11 in the 3 Sep 2026 extract).
//   - Residential only: SDAT land-use code R (Residential), U (Residential
//     Condominium) or TH (Town House). Apartments (M), Commercial (C, CC, CR),
//     Residential Commercial (RC), Exempt (E, EC), Industrial (I), Agricultural
//     (A), Country Club (CA), Marsh Land (MA) and a blank code are left out; an
//     UNKNOWN code throws (format drift, never a guess). The land use is the
//     account's CURRENT code: SDAT keeps no land use per sale. Also left out:
//     condominium accounts that are a parking space, storage unit or boat slip
//     rather than a home ('notAHome'), and buildings of five or more homes
//     ('fivePlusHomes'), as for Connecticut.
//   - Arm's-length only, by SDAT's own "How Conveyed" code on each sale:
//     1 "Private arms-length transfer, Improved" is kept; 2 "Vacant at time of
//     sale" is land, not a home ('vacantAtSale'); 3 "multiple parcel" is one
//     price for several properties ('multiParcel'); 4 "non-arms-length
//     transfer such as a foreclosure, gift or auction" ('nonArmsLength'); "No
//     Data" or blank ('noConveyanceCode'). Unknown wording throws.
//   - A price under $10,000 is a nominal transfer ('nominal'; SDAT codes some
//     $0 transfers as arm's-length). A price of $20 million or more is taken
//     as a recording error ('implausiblePrice'): measured Sept 2026, the one
//     such record in 24 months was $300,000,000 for one condominium unit, and
//     the next highest home sale was $8,000,000.
//   - One price for several properties that SDAT coded 1 anyway: two or more
//     sales in one jurisdiction on the same day, at the same price, from the
//     same seller's deed (SDAT's grantor deed reference, liber/folio, is the
//     deed the SELLER took title by) are all 'sameSellerDeed'. A portfolio
//     split evenly across properties the seller bought separately has a
//     different deed on each, so also: three or more sales in one
//     jurisdiction on the same day at the same price that is NOT a whole
//     number of thousands are all 'splitPortfolio' (13 Baltimore City sales at
//     $166,666 on 17 Dec 2025, 7 of them in one tract whose median they
//     pulled from $275k to $240k; 3 at $34,615 on 24 Jun 2026). Pairs are
//     not enough, and neither are round prices: new-build houses sell in
//     pairs at list prices such as $284,900 on one day, and removing those
//     moved a tract by 10%. A portfolio at a round price per property can
//     still pass.
//   - Located by MDP's published parcel point only (DoIT converted it from
//     Maryland State Plane to WGS84); a sale without one is 'noLocation',
//     never geocoded.
//
// SCOPE. The tracts are the Maryland census tracts acs-tract keeps for the
// region (their extent overlaps the rectangle), read from the same Census
// cartographic file. Fetched: every sale inside those tracts' combined extent
// in the SDAT jurisdictions (Maryland's 23 counties and Baltimore City) that
// have such tracts, plus EVERY sale of a jurisdiction lying wholly in the
// region (Baltimore City), so that its sales without a point are counted
// rather than silently missing. A sale without a point elsewhere cannot be
// placed in or out of the region and is not fetched. Sales outside every tract
// are dropped (and counted) by the orchestrator. `covers` is those
// jurisdictions: every tract of the region lies in one.
//
// WINDOW (SPEC2 §B.1; the build applies it, lib/sales.mjs saleWindow). By
// RECORDING date: SDAT's "Transfer Date" follows the land records' own order.
// In Baltimore City's Jun–Aug 2026 arm's-length transfers, the new deeds'
// liber numbers (assigned as deeds are recorded) rise with the transfer date,
// 99% of pairs in order, each day's deeds within a few libers of each other;
// settlement dates would scatter across weeks of libers. The portal refreshes
// the dataset about the 3rd of each month with SDAT's data "as of the 1st"
// (its documentation); the extract date is the newest per-row "Date of Most
// Recent Open Data Portal Record Update", and `through` (the last month the
// extract covers) is the month before it: the publisher's own statement, so
// a stray transfer dated on a month's last day cannot make a half-posted month
// look complete. The build pushes that back LAG_MONTHS for SDAT's posting lag
// (a recorded deed takes some weeks to reach SDAT's file), so the sales of the
// lag month are passed through for the build to count as out of window. In the
// 3 Sep 2026 extract, August held 747 kept sales against 840–1,353 in each of
// the 24 months before, and its last ten days only 70 (July's: 311); nothing
// after 26 August had been posted. July (1,057, vs 989 a year earlier) was
// complete, but MD iMAP's copy of the same sales, taken a month earlier, held
// 7% fewer July arm's-length home sales in Baltimore City (747 vs 801), so a
// month is still filling for about a month after it ends. The window
// therefore ends one month before the last month the extract covers: Aug
// 2025 – Jul 2026 for that extract. 12 months, not 24: see WINDOW_MONTHS.

import { createHash } from 'node:crypto';

const ID = 'md-sdat-sales';
const REGIONS = ['baltimore'];
const DATASET = 'ed4q-f8tm';
const HOST = 'https://opendata.maryland.gov';
const API = `${HOST}/resource/${DATASET}`;
const PAGE = 50_000;                        // Socrata's largest page
// 12 months (SPEC2 §B.1 prefers 12 unless it leaves more than 30% of tracts
// under 10 sales): at 12, 19 of the region's 225 tracts (8%) have fewer than
// 10; 24 would leave 9 (4%). Measured on the 3 Sep 2026 extract (lane report).
// Baltimore City is dense in sales; re-measure if the rectangle grows into
// the suburbs.
const WINDOW_MONTHS = 12;
const LAG_MONTHS = 1;                       // SDAT's posting lag, measured (see WINDOW above)
const MAX_AGE_H = 24;                       // monthly data; the orchestrator decides when to refetch
const STALE_DAYS = 70;                      // an extract older than this is a stalled portal: warn
const MIN_PRICE = 10_000, MAX_PRICE = 20_000_000;
const STATE_FIPS = '24';
const TRACTS_YEAR = 2024;                   // any vintage of the 2020 tracts serves; acs-tract's file
const TRACTS_FILE = `cb_${TRACTS_YEAR}_${STATE_FIPS}_tract_500k.zip`;
const TRACTS_URL = `https://www2.census.gov/geo/tiger/GENZ${TRACTS_YEAR}/shp/${TRACTS_FILE}`;
const EDGE = 0.001;                         // degrees (~100 m) round the tracts' extent: the build places sales in the simplified, quantized rings

// County FIPS -> SDAT jurisdiction code (JURSCODE), all 24 of them, so a
// moved rectangle needs no edit here.
export const JURISDICTIONS = {
  '24001': 'ALLE', '24003': 'ANNE', '24005': 'BACO', '24009': 'CALV', '24011': 'CARO', '24013': 'CARR',
  '24015': 'CECI', '24017': 'CHAR', '24019': 'DORC', '24021': 'FRED', '24023': 'GARR', '24025': 'HARF',
  '24027': 'HOWA', '24029': 'KENT', '24031': 'MONT', '24033': 'PRIN', '24035': 'QUEE', '24037': 'STMA',
  '24039': 'SOME', '24041': 'TALB', '24043': 'WASH', '24045': 'WICO', '24047': 'WORC', '24510': 'BACI',
};

// The portal's column for each thing read, by the alias the query gives it.
// Only what the filters need: never an address, owner, grantor name, account
// number or assessment.
const COLS = {
  j: 'jurisdiction_code_mdp_field_jurscode',
  lat: 'mdp_latitude_mdp_field_digycord_converted_to_wgs84',
  lng: 'mdp_longitude_mdp_field_digxcord_converted_to_wgs84',
  lu: 'land_use_code_mdp_field_lu_desclu_sdat_field_50',
  bt: 'additional_c_a_m_a_data_dwelling_type_mdp_field_strubldg_sdat_field_265',
  du: 'c_a_m_a_system_data_number_of_dwelling_units_mdp_field_bldg_units_sdat_field_239',
  d1: 'sales_segment_1_transfer_date_yyyy_mm_dd_mdp_field_tradate_sdat_field_89',
  p1: 'sales_segment_1_consideration_mdp_field_considr1_sdat_field_90',
  c1: 'sales_segment_1_how_conveyed_ind_mdp_field_convey1_sdat_field_87',
  l1: 'sales_segment_1_grantor_deed_reference_1_liber_mdp_field_gr1libr1_sdat_field_82',
  f1: 'sales_segment_1_grantor_deed_reference_1_folio_mdp_field_gr1folo1_sdat_field_83',
  d2: 'sales_segment_2_transfer_date_yyyy_mm_dd_sdat_field_109',
  p2: 'sales_segment_2_consideration_sdat_field_110',
  c2: 'sales_segment_2_how_conveyed_ind_sdat_field_107',
  l2: 'sales_segment_2_grantor_deed_reference_1_liber_sdat_field_102',
  f2: 'sales_segment_2_grantor_deed_reference_1_folio_sdat_field_103',
  d3: 'sales_segment_3_transfer_date_yyyy_mm_dd_sdat_field_129',
  p3: 'sales_segment_3_consideration_sdat_field_130',
  c3: 'sales_segment_3_how_conveyed_ind_sdat_field_127',
  l3: 'sales_segment_3_grantor_deed_reference_1_liber_sdat_field_122',
  f3: 'sales_segment_3_grantor_deed_reference_1_folio_sdat_field_123',
  u: 'date_of_most_recent_open_data_portal_record_update',
};
const SEGS = [1, 2, 3];

// SDAT land-use codes (the "(X)" at the end of the portal's text), checked
// against every row statewide in Sept 2026.
export const RESIDENTIAL_LU = { R: 'house', U: 'condo', TH: 'townhouse' };
export const NON_RESIDENTIAL_LU = new Set(['A', 'M', 'C', 'CC', 'CR', 'CA', 'EC', 'E', 'I', 'MA', 'RC']);
// SDAT dwelling types that are a condominium ACCOUNT but not a home.
export const NOT_A_HOME = new Set(['0012', '0014', '0015']);   // boat slip, parking space, storage unit
// "DWEL End Unit (0002)" / "DWEL Center Unit (0003)": row and town houses.
const ROW_HOUSE = new Set(['0002', '0003', '0007']);

const meta = {
  name: 'Maryland Real Property Assessments (sales segments), State Department of Assessments and Taxation, via opendata.maryland.gov',
  publisher: 'Maryland State Department of Assessments and Taxation (SDAT) and Maryland Department of Planning (MDP)',
  url: `${HOST}/d/${DATASET}`,
  licence: 'Public domain',
  // The portal's "Public Domain" licence has no terms page of its own, so the
  // link is the dataset's page, where the State declares it.
  licenceUrl: `${HOST}/d/${DATASET}`,
  attribution: [
    'Source: State of Maryland: SDAT (State Department of Assessments and Taxation) and MDP (Maryland Department of Planning), Maryland Real Property Assessments (opendata.maryland.gov), public domain; medians by census tract calculated by SafeRoute.',
    `Tract boundaries: U.S. Census Bureau, ${TRACTS_YEAR} Cartographic Boundary Files (census tracts, 1:500,000).`,
  ],
  credit: 'Maryland SDAT',
  metric: 'Median sale price',
  unitNoun: 'sales',
  currency: 'USD',
  // The build finds the window in the data and writes the period from it.
  window: { months: WINDOW_MONTHS, by: 'recording', lagMonths: LAG_MONTHS },
  // The rule on tracts with fewer than 3 (or 10) sales is the build's
  // standard note (lib/sales.mjs privacyNote), added to these.
  notes: [
    'Sales of houses, town houses and condominium homes recorded by the Maryland State Department of Assessments and Taxation. Buildings of five or more homes, parking spaces and storage units are not included.',
    'Only sales the Department codes as private arm’s-length sales of a built property are counted. Foreclosures, gifts, auctions and other non-arm’s-length transfers, sales of vacant land, and transfers under $10,000 are left out. ' +
      'So are sales of several properties for one price where the records show it: the Department’s own code, one seller’s deed behind several sales, or three or more sales on one day at the same uneven price.',
    'The median counts every arm’s-length sale of a home, whatever its condition, so where many sales are of houses needing major repair it can sit far below the price of a home ready to live in.',
    'Dated by the transfer date the Department records, which follows the recording of the deed. Each sale is placed at the parcel point the Maryland Department of Planning publishes; sales with no point are left out rather than guessed.',
    'The Department adds a sale to its records some weeks after the deed is recorded, so the latest month is left out until it is complete.',
  ],
  areaNoun: 'census tract',
  colourMinN: 10,
};

// Every reason a candidate sale is left out, in the order classify() and
// dropSharedDeeds() apply them; each is published, 0 or not.
export const DROP_REASONS = ['duplicate', 'badDate', 'nonResidential', 'notAHome', 'fivePlusHomes', 'noConveyanceCode', 'vacantAtSale',
  'multiParcel', 'nonArmsLength', 'nominal', 'implausiblePrice', 'noLocation', 'sameSellerDeed', 'splitPortfolio'];

// ── pure helpers (tested in test/md-sdat-sales.test.mjs) ─────────────────────
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const ym = i => `${Math.floor(i / 12)}-${String((i % 12) + 1).padStart(2, '0')}`;
const lastDay = i => new Date(Date.UTC(Math.floor(i / 12), (i % 12) + 1, 0)).getUTCDate();

// For an extract dated `extract` ('YYYYMMDD'): `through`, the last month it
// covers (the one before the extract's; SDAT's data is "as of the 1st"), and
// the window of `months` the build will take, ending `lag` months before it
// (inclusive ISO dates). The same arithmetic as lib/sales.mjs saleWindow
// given `through`; fetch() uses it only to ask for no older sales than needed.
export function windowFor(extract, months = WINDOW_MONTHS, lag = LAG_MONTHS) {
  const m = /^(\d{4})(\d{2})\d{2}$/.exec(extract || '');
  if (!m) throw new Error(`${ID}: extract date "${extract}" is not YYYYMMDD`);
  const through = +m[1] * 12 + (+m[2] - 1) - 1, end = through - lag, start = end - months + 1;
  return { through: ym(through), from: `${ym(start)}-01`, to: `${ym(end)}-${String(lastDay(end)).padStart(2, '0')}` };
}
export const periodOf = w => `Sales recorded ${MON[+w.from.slice(5, 7) - 1]} ${w.from.slice(0, 4)} – ${MON[+w.to.slice(5, 7) - 1]} ${w.to.slice(0, 4)}`;
export const vintageOf = w => `${w.from.slice(0, 7)}..${w.to.slice(0, 7)}`;

// "Private arms-length transfer, Improved (1)" -> 1; "No Data" or blank ->
// null; any other wording throws (SDAT renamed or added a code).
export function conveyance(text) {
  const s = (text ?? '').trim();
  if (!s || s === 'No Data') return null;
  const m = /^Private (?:non-)?arms-length transfer.*\(([1-4])\)$/.exec(s);
  if (!m) throw new Error(`${ID}: conveyance "${s}" is not one this module knows — the format changed`);
  return +m[1];
}
// "Residential Condominium (U)" -> 'U'; blank -> null; an unknown code throws.
export function landUse(text) {
  const s = (text ?? '').trim();
  if (!s) return null;
  const code = /\(([A-Z]{1,2})\)$/.exec(s)?.[1];
  if (!code || (!RESIDENTIAL_LU[code] && !NON_RESIDENTIAL_LU.has(code))) throw new Error(`${ID}: land use "${s}" is not one this module knows — the format changed`);
  return code;
}
// "DWEL Parking Space (0014)" -> '0014'; commercial "(C101)" and blank -> ''.
export const dwellingType = text => /\((\d{4})\)$/.exec((text ?? '').trim())?.[1] || '';
// 'YYYY.MM.DD' -> 'YYYY-MM-DD', or null when it is not a real date.
export function isoDate(s) {
  const m = /^(\d{4})\.(\d{2})\.(\d{2})$/.exec((s ?? '').trim());
  if (!m || +m[1] < 1900 || +m[2] < 1 || +m[2] > 12 || +m[3] < 1 || +m[3] > lastDay(+m[1] * 12 + +m[2] - 1)) return null;
  return `${m[1]}-${m[2]}-${m[3]}`;
}

// One account row -> its candidate sales: the segments dated on or after
// `from` (older segments are the account's history, outside the query), each
// with the account's fields. Repeats within the account come back flagged.
export function segmentsOf(row, from) {
  const out = [], seen = new Set();
  for (const s of SEGS) {
    const raw = (row[`d${s}`] ?? '').trim();
    if (!raw || raw.replace(/\./g, '-') < from) continue;          // '0000.00.00' = no transfer
    const key = `${raw}|${row[`p${s}`]}`;
    out.push({ seg: s, raw, date: isoDate(raw), price: Number(row[`p${s}`]), code: row[`c${s}`],
      deed: `${(row[`l${s}`] ?? '').trim()}/${(row[`f${s}`] ?? '').trim()}`, repeat: seen.has(key) });
    seen.add(key);
  }
  return out;
}

// One candidate sale of `row` -> { sale } or { drop: reason }. `extract`
// ('YYYY-MM-DD') is the extract date, after which no transfer is real. The
// window's end is NOT applied here: the build does that, and counts it.
export function classify(row, seg, extract) {
  if (seg.repeat) return { drop: 'duplicate' };
  if (!seg.date || seg.date > extract) return { drop: 'badDate' };
  const lu = landUse(row.lu);
  if (!lu || !RESIDENTIAL_LU[lu]) return { drop: 'nonResidential' };
  const bt = dwellingType(row.bt);
  if (NOT_A_HOME.has(bt)) return { drop: 'notAHome' };
  if (Number(row.du) > 4) return { drop: 'fivePlusHomes' };
  const code = conveyance(seg.code);
  if (code === null) return { drop: 'noConveyanceCode' };
  if (code === 2) return { drop: 'vacantAtSale' };
  if (code === 3) return { drop: 'multiParcel' };
  if (code === 4) return { drop: 'nonArmsLength' };
  const price = seg.price;
  if (!Number.isFinite(price) || price < MIN_PRICE) return { drop: 'nominal' };
  if (price >= MAX_PRICE) return { drop: 'implausiblePrice' };
  const lat = row.lat === '' ? NaN : Number(row.lat), lng = row.lng === '' ? NaN : Number(row.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return { drop: 'noLocation' };
  const type = lu === 'R' && ROW_HOUSE.has(bt) ? 'townhouse' : RESIDENTIAL_LU[lu];
  return { sale: { lat, lng, price, date: seg.date, type }, key: `${row.j}|${seg.date}|${price}|${seg.deed}`, deed: seg.deed };
}

// Kept sales sharing jurisdiction, day, price and the seller's deed are one
// price for several properties: all of them go ('sameSellerDeed'). A blank or
// zero deed reference ('00000/0000') says nothing and never groups. Of the
// rest, SPLIT_MIN or more on one day in one jurisdiction at one price that is
// not a whole number of thousands are a portfolio split evenly across
// properties: all of them go too ('splitPortfolio'; see WHICH SALES).
export const SPLIT_MIN = 3;
export function dropSharedDeeds(kept) {
  const n = new Map();
  const real = k => !/^0*\/0*$/.test(k.deed);
  for (const k of kept) if (real(k)) n.set(k.key, (n.get(k.key) || 0) + 1);
  const out = kept.filter(k => !real(k) || n.get(k.key) === 1);
  const odd = k => k.sale.price % 1000 !== 0, day = k => `${k.j}|${k.sale.date}|${k.sale.price}`;
  const m = new Map();
  for (const k of out) if (odd(k)) m.set(day(k), (m.get(day(k)) || 0) + 1);
  const left = out.filter(k => !odd(k) || m.get(day(k)) < SPLIT_MIN);
  return { kept: left, dropped: kept.length - out.length, split: out.length - left.length };
}

// The SoQL filter: the jurisdictions, located inside the box or in a
// jurisdiction lying wholly in the region, with any segment dated from `from`.
export function whereClause({ codes, whole = [], box, from }) {
  const list = a => a.map(c => `'${c}'`).join(', ');
  const d = from.replace(/-/g, '.');
  const inBox = `${COLS.lat} >= ${box[0]} AND ${COLS.lat} <= ${box[2]} AND ${COLS.lng} >= ${box[1]} AND ${COLS.lng} <= ${box[3]}`;
  const place = whole.length ? `(${COLS.j} IN (${list(whole)}) OR (${inBox}))` : `(${inBox})`;
  return `${COLS.j} IN (${list(codes)}) AND ${place} AND (${SEGS.map(s => `${COLS[`d${s}`]} >= '${d}'`).join(' OR ')})`;
}

// ── upstream ────────────────────────────────────────────────────────────────
const url = (fmt, params) => `${API}.${fmt}?${new URLSearchParams(params).toString()}`;
const tag = s => createHash('sha256').update(s).digest('hex').slice(0, 10);
// Outward to 4 decimals (~10 m), so the query reads 39.1532, not 39.15322000001.
const out4 = (v, up) => (up ? Math.ceil(v * 1e4) : Math.floor(v * 1e4)) / 1e4;

// The region's tracts as acs-tract keeps them (Maryland, extent overlapping
// the rectangle): which jurisdictions they lie in, which of those lie wholly
// in the region, and their combined extent.
async function regionScope(ctx, bbox) {
  const z = ctx.readers.unzip(await ctx.download(TRACTS_FILE, TRACTS_URL, { maxAgeH: 24 * 30 }));
  const { features, fields } = ctx.readers.shp.readShapefile(z);
  ctx.readers.columns(fields.map(f => f.name), ['GEOID', 'STATEFP', 'COUNTYFP'], TRACTS_FILE);
  const all = features.filter(f => f.props.STATEFP === STATE_FIPS);
  if (all.length < 1000) throw new Error(`${TRACTS_FILE}: ${all.length} Maryland tracts — the file changed`);
  const hit = all.filter(f => f.bbox[0] <= bbox[2] && f.bbox[2] >= bbox[0] && f.bbox[1] <= bbox[3] && f.bbox[3] >= bbox[1]);
  if (!hit.length) throw new Error(`${ID}: no Maryland tract overlaps the rectangle ${bbox}`);
  const counties = [...new Set(hit.map(f => STATE_FIPS + f.props.COUNTYFP))].sort();
  for (const c of counties) if (!JURISDICTIONS[c]) throw new Error(`${ID}: county ${c} has no SDAT jurisdiction code here`);
  const whole = counties.filter(c => all.filter(f => STATE_FIPS + f.props.COUNTYFP === c).every(f => hit.includes(f)));
  const box = [
    out4(Math.min(...hit.map(f => f.bbox[0])) - EDGE, false), out4(Math.min(...hit.map(f => f.bbox[1])) - EDGE, false),
    out4(Math.max(...hit.map(f => f.bbox[2])) + EDGE, true), out4(Math.max(...hit.map(f => f.bbox[3])) + EDGE, true),
  ];
  return { tracts: hit.length, counties, whole, box };
}

// The extract date: the newest per-row portal update in these jurisdictions.
async function extractDate(ctx, codes) {
  const where = `${COLS.j} IN (${codes.map(c => `'${c}'`).join(', ')})`;
  const file = `${ID}-extract-${tag(where)}.json`;
  const buf = await ctx.download(file, url('json', { $select: `max(${COLS.u}) AS u`, $where: where }), { maxAgeH: MAX_AGE_H });
  let u;
  try { u = JSON.parse(buf.toString('utf8'))?.[0]?.u; } catch {}
  if (!/^20\d{6}$/.test(u || '')) { ctx.discard?.(file); throw new Error(`${ID}: the extract date reads "${u}" — the dataset changed (or the portal answered with a page, not data)`); }
  return u;
}

// Every account row the filter matches, paged by row id.
async function accountRows(ctx, where) {
  const rows = [], names = Object.keys(COLS);
  const $select = names.map(k => `${COLS[k]} AS ${k}`).join(', ');
  for (let page = 0; ; page++) {
    const file = `${ID}-${tag(where)}-p${page + 1}.csv`;
    const buf = await ctx.download(file, url('csv', { $select, $where: where, $order: ':id', $limit: PAGE, $offset: page * PAGE }), { maxAgeH: MAX_AGE_H, timeoutMs: 600_000 });
    let got;
    try {
      let header;
      ({ header, rows: got } = ctx.readers.parseCsv(buf));
      const col = ctx.readers.columns(header, names, file);   // a Cloudflare block page fails here
      for (const r of got) {
        if (r.length === 1 && r[0] === '') continue;
        if (r.length !== header.length) throw new Error(`${file}: a row of ${r.length} fields, not ${header.length} — the format changed`);
        rows.push(Object.fromEntries(names.map(k => [k, r[col[k]]])));
      }
    } catch (e) { ctx.discard?.(file); throw e; }   // never served again from the cache
    if (got.length < PAGE) return rows;
  }
}

async function fetchSales(ctx) {
  const t0 = Date.now();
  const served = REGIONS.map(id => ({ id, reg: ctx.regions?.[id] })).filter(r => r.reg);
  if (!served.length) throw new Error(`${ID}: none of ${REGIONS.join(', ')} is in coverage.json`);
  if (served.length > 1) throw new Error(`${ID}: written for one region; ${served.length} served`);
  const { id, reg } = served[0];
  if (!reg.juris?.includes('US-MD')) throw new Error(`${ID}: region ${id} is not in Maryland (juris ${reg.juris})`);

  const scope = await regionScope(ctx, reg.bbox);
  const codes = scope.counties.map(c => JURISDICTIONS[c]), whole = scope.whole.map(c => JURISDICTIONS[c]);
  ctx.log(`  ${scope.tracts} tracts in ${codes.join(', ')} (wholly in the region: ${whole.join(', ') || 'none'}); box ${scope.box.join(', ')}`);

  const u = await extractDate(ctx, codes);
  const extract = `${u.slice(0, 4)}-${u.slice(4, 6)}-${u.slice(6, 8)}`;
  const ageDays = (Date.now() - Date.parse(extract)) / 864e5;
  if (ageDays > STALE_DAYS) ctx.warn(`${ID}: the portal's newest record update is ${extract}, ${Math.round(ageDays)} days ago — its monthly refresh may have stalled`);
  const w = windowFor(u);
  const rows = await accountRows(ctx, whereClause({ codes, whole, box: scope.box, from: w.from }));

  // Every reason, counted from 0, so a reason that dropped nothing this month
  // is published as 0 rather than missing.
  const dropped = Object.fromEntries(DROP_REASONS.map(k => [k, 0])), perJuris = {};
  const count = r => { if (!(r in dropped)) throw new Error(`${ID}: drop reason "${r}" is not in DROP_REASONS`); dropped[r]++; };
  let salesIn = 0, newest = '';
  const kept = [];
  for (const row of rows) {
    if (!codes.includes(row.j)) throw new Error(`${ID}: a row for jurisdiction "${row.j}" — the query was not applied`);
    const pj = perJuris[row.j] ??= { in: 0, kept: 0 };
    for (const seg of segmentsOf(row, w.from)) {
      salesIn++; pj.in++;
      if (seg.date && seg.date <= extract && seg.date > newest) newest = seg.date;
      const r = classify(row, seg, extract);
      if (r.drop) { count(r.drop); continue; }
      kept.push({ ...r, j: row.j });
    }
  }
  // The data must reach the window's end, or the window (and its label) is wrong.
  if (newest < w.to) throw new Error(`${ID}: the newest transfer is ${newest || 'none'}, before the window's end ${w.to} — the extract is incomplete`);
  const shared = dropSharedDeeds(kept);
  dropped.sameSellerDeed = shared.dropped;
  dropped.splitPortfolio = shared.split;
  for (const k of shared.kept) perJuris[k.j].kept++;
  const sales = shared.kept.map(k => k.sale);
  if (!sales.length) throw new Error(`${ID}: no sales kept from ${salesIn} — a filter or the format is wrong`);

  ctx.log(`  ${ID}: extract ${extract}, through ${w.through}; the build's window will be ${periodOf(w)}; ${rows.length} accounts, ${salesIn} sales in, ${sales.length} passed on; dropped ` +
    Object.entries(dropped).sort().map(([k, v]) => `${k} ${v}`).join(', ') + ` in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  ctx.log(`  per jurisdiction (in -> kept): ${Object.entries(perJuris).sort().map(([k, v]) => `${k} ${v.in}->${v.kept}`).join(', ')}`);

  return {
    vintage: vintageOf(w),
    through: w.through,
    covers: { juris: ['US-MD'], counties: scope.counties },
    sales,
    dropped,
  };
}

export default {
  id: ID,
  kind: 'point-sales',
  regions: REGIONS,
  cadence: 'monthly',           // the portal refreshes about the 3rd of each month
  geometry: 'acs-tract',
  meta,
  fetch: fetchSales,
};
