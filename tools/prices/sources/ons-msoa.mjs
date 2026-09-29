// England & Wales: ONS "Median house prices by MSOA" (formerly HPSSA dataset 2),
// all dwellings, for the latest year-ending edition, with the number of sales
// behind each median from its sister table "Residential property sales by
// MSOA" (formerly HPSSA dataset 1). Drawn on the MSOA 2021 polygons (7,264).
//
// WHY this and not Land Registry Price Paid Data: PPD would give finer (LSOA)
// medians, but its postcodes are Royal Mail address data outside the OGL, and
// using them as a join key for a product that may earn money is an owner
// decision not yet taken (SPEC §0). The ONS table is OGL, carries no address
// data, and is ONS's own published median, so nothing here is computed.
//
// Four upstreams, all OGL:
//   1. www.ons.gov.uk      the two xlsx tables. The latest edition is DISCOVERED
//                          from each dataset's /data JSON (editions are named
//                          yearendingmarch2026, yearendingseptember2025, …), never
//                          hard-coded, so the March 2027 release is picked up by
//                          the next build without an edit. ONS rate-limits
//                          (~15 req/10 s for heavy assets, 429 + Retry-After),
//                          asks for a named UA with a contact, and blocks for up
//                          to an hour when a 429 is ignored (ctx.download
//                          paces the host and honours Retry-After).
//   2. ONS Open Geography  MSOA (Dec 2021) Boundaries EW BGC (V3), paged GeoJSON
//                          from the ArcGIS FeatureServer. The server applies the
//                          OSGB36→WGS84 datum shift itself (checked against
//                          lib/osgb.mjs: within 2 m), so no reprojection here.
//   3. ONS Open Geography  MSOA (2021) → LAD (2025) best-fit lookup, and
//   4. ONS Open Geography  LAD (April 2025) → ITL1 (January 2025) lookup: the
//                          scale key. One colour scale per ITL1 region (London,
//                          South East, … Wales), because a single E&W scale
//                          would paint all of London one colour (SPEC §4).
//                          Both lookups are LAD 2025, so they can never disagree
//                          about a council; when ONS moves to LAD 2026, change
//                          the two service names TOGETHER.
//
// Names are the ONS MSOA21NM ("Southwark 023"). The xlsx's own "MSOA name"
// column carries the House of Commons Library names, which are under the Open
// Parliament Licence and would need their own credit, so it is not read.
//
// Honesty rules (SPEC §1): "[x]" (fewer than 5 sales) → value null, 'suppressed';
// fewer than 10 sales → the value is kept for the pane but flagged 'few', and
// meta.colourMinN keeps it neutral on the map.

import { unlinkSync } from 'node:fs';
import { join } from 'node:path';

const ID = 'ons-msoa';
const ONS = 'https://www.ons.gov.uk';
const MEDIAN_DS = '/peoplepopulationandcommunity/housing/datasets/medianhousepricesbymiddlelayersuperoutputarea';
const SALES_DS = '/peoplepopulationandcommunity/housing/datasets/residentialpropertysalesbymiddlelayersuperoutputarea';
// ONS's bot guide asks for a named, versioned UA with an organisational contact.
const ONS_UA = 'SafeRouteBuild/1.0 (+https://safe-route.app; minhaj@safe-route.app)';

const ARC = 'https://services1.arcgis.com/ESMARspQHYMw9BZ9/arcgis/rest/services';
const BOUNDS = `${ARC}/Middle_layer_Super_Output_Areas_December_2021_Boundaries_EW_BGC_V3/FeatureServer/0`;
const MSOA_LAD = `${ARC}/MSOA21_WD25_LAD25_EW_LU_v3/FeatureServer/0`;
const LAD_ITL = `${ARC}/ITL125_ITL225_ITL325_LAU125_LAD25_UK_LU/FeatureServer/0`;
const BOUNDS_PAGE = 2000;   // the boundary layer's maxRecordCount
const TABLE_PAGE = 1000;    // the lookup tables' maxRecordCount

// England and Wales ITL1 regions. Scotland (TLM) and NI (TLN) can never come
// out of an E&W table; if one does, the lookup is wrong and the build stops.
const EW_ITL1 = new Set(['TLC', 'TLD', 'TLE', 'TLF', 'TLG', 'TLH', 'TLI', 'TLJ', 'TLK', 'TLL']);
const COLOUR_MIN_N = 10;

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const cap = s => s[0].toUpperCase() + s.slice(1);

const meta = {
  name: 'Median house prices and residential property sales by Middle layer Super Output Area (formerly HPSSA datasets 2 and 1)',
  publisher: 'Office for National Statistics',
  url: `${ONS}${MEDIAN_DS}`,
  licence: 'Open Government Licence v3.0',
  licenceUrl: 'https://www.nationalarchives.gov.uk/doc/open-government-licence/version/3/',
  attribution: [
    'Source: Office for National Statistics licensed under the Open Government Licence v.3.0',
    'Contains HM Land Registry data © Crown copyright and database right 2026.',
    'Contains OS data © Crown copyright and database right 2026.',
  ],
  metric: 'Median price paid',
  unitNoun: 'sales',
  currency: 'GBP',
  // Set by fetch() from the edition it actually read; this default is the
  // edition current when the source was written (ONS release of 17 Sep 2026).
  period: '12 months to March 2026',
  notes: [
    'The middle price paid for homes sold in the 12 months, all property types, from HM Land Registry’s record of sales.',
    'ONS publishes no median for an area with fewer than 5 sales. Areas with fewer than 10 sales show their figure but are not coloured.',
  ],
  areaNoun: 'middle layer super output area (MSOA)',
  colourMinN: COLOUR_MIN_N,
  // The map's credit line (the full lines above are one click away from it).
  credit: 'ONS, HM Land Registry, OS',
};

// ── ONS ─────────────────────────────────────────────────────────────────────
// ctx.download paces www.ons.gov.uk and waits out a 429's Retry-After
// (lib/ctx.mjs politeFetch), so nothing here retries on top of it: stacked
// retries are exactly what earns the hour-long block. The UA is passed
// explicitly because ONS's bot policy asks for a named one with a contact.
const onsGet = (ctx, file, url, opts = {}) => ctx.download(file, url, { ua: ONS_UA, timeoutMs: 300_000, ...opts });
const json = (buf, what) => {
  try { return JSON.parse(buf.toString('utf8')); }
  catch { throw new Error(`${what} is not JSON (an HTML error or challenge page?)`); }
};

// The newest "yearending<month><year>" edition listed on a dataset's /data
// JSON, and its xlsx. Editions that do not follow the pattern (the 2023 one is
// just "2023") are older than every patterned one and are skipped.
async function latestEdition(ctx, ds, tag) {
  const land = json(await onsGet(ctx, `ons-${tag}-landing.json`, `${ONS}${ds}/data`, { maxAgeH: 12 }), `ONS ${tag} landing page`);
  const eds = (land.datasets || []).map(d => {
    const m = /\/yearending([a-z]+)(\d{4})$/.exec(d.uri || '');
    const mi = m ? MONTHS.indexOf(m[1]) : -1;
    return mi < 0 || !d.uri.startsWith(`${ds}/`) ? null : { uri: d.uri, slug: d.uri.split('/').pop(), year: +m[2], month: mi };
  }).filter(Boolean).sort((a, b) => (b.year * 12 + b.month) - (a.year * 12 + a.month));
  if (!eds.length) throw new Error(`ONS ${tag}: no "yearending<month><year>" edition on ${ds}/data — the page layout changed`);
  const ed = eds[0];
  const doc = json(await onsGet(ctx, `ons-${tag}-${ed.slug}.json`, `${ONS}${ed.uri}/data`, { maxAgeH: 12 }), `ONS ${tag} edition ${ed.slug}`);
  const files = (doc.downloads || []).map(d => d.file).filter(f => /\.xlsx$/i.test(f || ''));
  if (files.length !== 1) throw new Error(`ONS ${tag} ${ed.slug}: expected one xlsx download, found ${JSON.stringify(doc.downloads)}`);
  return {
    ...ed, file: files[0], url: `${ONS}/file?uri=${ed.uri}/${files[0]}`,
    edition: doc.description?.edition || '', released: doc.description?.releaseDate || null,
    // The header the table's newest column must carry: "Year ending Mar 2026".
    column: `Year ending ${cap(MONTHS[ed.month]).slice(0, 3)} ${ed.year}`,
  };
}

// Sheet 1a of either workbook = all dwellings. Returns MSOA code -> the cell in
// the newest column, which must be the edition's own year-ending: a table whose
// last column is anything else has changed layout and is refused.
function latestColumn(ctx, buf, ed, what) {
  const { xlsx, columns } = ctx.readers;
  const wb = xlsx(buf);
  if (!wb.sheets.includes('1a')) throw new Error(`${what}: no sheet "1a" (has ${wb.sheets.join(', ')})`);
  const rows = wb.rows('1a');
  const title = String(rows[0]?.[0] || '');
  // Sheets 1b–1e are single property types; 1a must be the all-dwellings table.
  if (!/^Table 1a - (Median price paid|Number of residential property sales) by MSOA, England and Wales\b/.test(title)) {
    throw new Error(`${what}: sheet 1a is "${title}", not the all-dwellings MSOA table`);
  }
  const hi = rows.findIndex(r => (r || []).some(c => String(c).trim() === 'MSOA code'));
  if (hi < 0) throw new Error(`${what}: header row not found — the layout changed`);
  const header = rows[hi].map(h => String(h ?? '').replace(/\s+/g, ' ').trim());
  const col = columns(header, ['Local authority code', 'MSOA code', ed.column], what);
  const last = header.length - 1 - [...header].reverse().findIndex(h => /^Year ending /.test(h));
  if (col[ed.column] !== last) throw new Error(`${what}: newest column is "${header[last]}", expected "${ed.column}" for edition ${ed.slug}`);
  const out = new Map();
  for (const r of rows.slice(hi + 1)) {
    const code = String(r?.[col['MSOA code']] ?? '').trim();
    if (!/^[EW]02\d{6}$/.test(code)) continue;     // notes rows under the table
    if (out.has(code)) throw new Error(`${what}: MSOA ${code} appears twice`);
    out.set(code, { la: String(r[col['Local authority code']] ?? '').trim(), cell: String(r[col[ed.column]] ?? '').trim() });
  }
  return out;
}

// "123456" -> 123456; "[x]" -> null (suppressed); anything else is a format
// change (a new marker, a decimal count) and stops the build.
function cellValue(cell, code, what) {
  if (/^\d+$/.test(cell)) return +cell;
  if (cell === '[x]') return null;
  throw new Error(`${what}: unexpected value ${JSON.stringify(cell)} for ${code} — the table's markers changed`);
}

// ── ArcGIS (ONS Open Geography Portal) ──────────────────────────────────────
// ArcGIS answers a bad query with HTTP 200 and an {error} body; the cached
// error would be re-read until it expires, so it is deleted before failing.
async function arcgisPages(ctx, layer, params, tag, page, maxAgeH) {
  const out = [];
  for (let offset = 0, i = 0; ; i++) {
    const q = new URLSearchParams({ where: '1=1', ...params, resultOffset: String(offset), resultRecordCount: String(page) });
    const file = `${tag}-p${i}.json`;
    const buf = await ctx.download(file, `${layer}/query?${q}`, { maxAgeH, timeoutMs: 300_000 });
    let doc = null;
    try { doc = JSON.parse(buf.toString('utf8')); } catch {}
    if (!doc || doc.error || !Array.isArray(doc.features)) {
      if (ctx.rawDir) { try { unlinkSync(join(ctx.rawDir, file)); } catch {} }
      throw new Error(`ArcGIS ${file}: ${doc?.error?.message || (doc ? 'no features array' : 'not JSON')}`);
    }
    out.push(...doc.features);
    // GeoJSON output flags a truncated page under properties, JSON at the top.
    const more = doc.exceededTransferLimit || doc.properties?.exceededTransferLimit;
    if (!doc.features.length || (!more && doc.features.length < page)) break;
    offset += doc.features.length;
    if (i > 50) throw new Error(`ArcGIS ${tag}: more than 50 pages — the query is wrong`);
  }
  return out;
}

// MSOA21CD -> { lad, itl1 } through the two LAD-2025 lookups.
async function itl1ByMsoa(ctx) {
  const lad = await arcgisPages(ctx, MSOA_LAD, { outFields: 'MSOA21CD,LAD25CD', returnGeometry: 'false', orderByFields: 'ObjectId', f: 'json' },
    'ons-msoa21-lad25', TABLE_PAGE, 24 * 90);
  const itl = await arcgisPages(ctx, LAD_ITL, { outFields: 'LAD25CD,ITL125CD', returnGeometry: 'false', orderByFields: 'ObjectId', f: 'json' },
    'ons-lad25-itl1', TABLE_PAGE, 24 * 90);
  // A LAD can have several LAU1 rows (Scotland splits some); they must agree.
  const itlByLad = new Map();
  for (const { attributes: a } of itl) {
    const prev = itlByLad.get(a.LAD25CD);
    if (prev && prev !== a.ITL125CD) throw new Error(`LAD→ITL1 lookup: ${a.LAD25CD} is in both ${prev} and ${a.ITL125CD}`);
    itlByLad.set(a.LAD25CD, a.ITL125CD);
  }
  const out = new Map();
  for (const { attributes: a } of lad) {
    const itl1 = itlByLad.get(a.LAD25CD);
    if (!itl1) throw new Error(`LAD→ITL1 lookup has no row for ${a.LAD25CD} (MSOA ${a.MSOA21CD}) — the two lookups are different LAD vintages`);
    out.set(a.MSOA21CD, { lad: a.LAD25CD, itl1 });
  }
  return out;
}

// GeoJSON Polygon / MultiPolygon -> contract polys ([polygon][ring][[lng,lat]]).
const polysOf = g => (g?.type === 'Polygon' ? [g.coordinates] : g?.type === 'MultiPolygon' ? g.coordinates : null);
function bboxOf(polys) {
  let s = 90, w = 180, n = -90, e = -180;
  for (const p of polys) for (const ring of p) for (const [x, y] of ring) {
    if (y < s) s = y; if (y > n) n = y; if (x < w) w = x; if (x > e) e = x;
  }
  return [s, w, n, e];
}
const intersects = (a, b) => a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1];
const regionOf = (ctx, id) => (Array.isArray(ctx.regions) ? ctx.regions.find(r => r.id === id) : ctx.regions?.[id]);

async function fetchAreas(ctx) {
  const t0 = Date.now();
  // Editions first (4 small ONS calls): both tables must be the same edition,
  // or the counts would describe a different 12 months from the medians.
  const med = await latestEdition(ctx, MEDIAN_DS, 'median');
  const sal = await latestEdition(ctx, SALES_DS, 'sales');
  if (med.slug !== sal.slug) throw new Error(`ONS editions disagree: medians ${med.slug}, sales ${sal.slug} — wait for both to be published`);
  ctx.log(`  ONS edition ${med.slug} ("${med.edition}", released ${med.released})`);

  const medians = latestColumn(ctx, await onsGet(ctx, `ons-msoa-median-${med.slug}.xlsx`, med.url, { maxAgeH: 24 * 30 }), med, `ONS ${med.file}`);
  const sales = latestColumn(ctx, await onsGet(ctx, `ons-msoa-sales-${sal.slug}.xlsx`, sal.url, { maxAgeH: 24 * 30 }), sal, `ONS ${sal.file}`);

  const geo = await arcgisPages(ctx, BOUNDS, { outFields: 'MSOA21CD,MSOA21NM', returnGeometry: 'true', outSR: '4326', orderByFields: 'FID', f: 'geojson' },
    'ons-msoa21-bgc', BOUNDS_PAGE, 24 * 90);
  const itl = await itl1ByMsoa(ctx);

  // Same census geography on every side, or refuse: a table on MSOA 2031 codes
  // against 2021 polygons would otherwise silently drop the changed areas.
  const geoCodes = new Set(geo.map(f => f.properties?.MSOA21CD));
  if (geoCodes.size !== geo.length) throw new Error(`MSOA boundary pages hold ${geo.length} features for ${geoCodes.size} codes — paging overlapped`);
  const diff = (a, b) => [...a].filter(c => !b.has(c));
  for (const [name, a, b] of [['medians vs polygons', medians.keys(), geoCodes], ['polygons vs medians', geoCodes, new Set(medians.keys())],
    ['sales vs medians', sales.keys(), new Set(medians.keys())], ['polygons vs ITL1 lookup', geoCodes, new Set(itl.keys())]]) {
    const d = diff(a, b);
    if (d.length) throw new Error(`ONS MSOA codes differ (${name}): ${d.length}, e.g. ${d.slice(0, 5).join(', ')} — a geography change; refusing a partial build`);
  }

  const cov = (ctx.coverage || []).find(c => c.id === 'uk');
  if (!cov) throw new Error('coverage has no "uk" region');
  const juris = regionOf(ctx, 'uk')?.juris || ['GB-ENG', 'GB-WLS', 'GB-NIR'];
  const stats = { areas: 0, suppressed: 0, few: 0, laDiffers: 0, outOfScope: 0 };
  const areas = [];
  for (const f of geo) {
    const code = f.properties.MSOA21CD, name = String(f.properties.MSOA21NM || '').trim();
    if (!name) throw new Error(`MSOA ${code} has no MSOA21NM`);
    const polys = polysOf(f.geometry);
    if (!polys?.length) throw new Error(`MSOA ${code} has no polygon geometry (${f.geometry?.type})`);
    const j = code[0] === 'W' ? 'GB-WLS' : 'GB-ENG';
    const { lad, itl1 } = itl.get(code);
    if (!EW_ITL1.has(itl1) || (itl1 === 'TLL') !== (j === 'GB-WLS')) throw new Error(`MSOA ${code} maps to ITL1 ${itl1}, not an ${j === 'GB-WLS' ? 'Welsh' : 'English'} region`);
    // The xlsx's own LA column is a free cross-check of the lookup chain; a
    // difference is logged, not fatal (ONS may lag a council merger by a release).
    if (medians.get(code).la !== lad) stats.laDiffers++;
    if (!juris.includes(j) || !intersects(bboxOf(polys), cov.bbox)) { stats.outOfScope++; continue; }

    const value = cellValue(medians.get(code).cell, code, med.file);
    const n = cellValue(sales.get(code).cell, code, sal.file);
    const flags = [];
    if (value == null) { flags.push('suppressed'); stats.suppressed++; }
    else if (n != null && n < COLOUR_MIN_N) { flags.push('few'); stats.few++; }
    areas.push({ id: code, name, region: 'uk', juris: j, scale: itl1, value, moe: null, n, flags, context: null, polys });
    stats.areas++;
  }
  if (stats.laDiffers) ctx.log(`  note: ${stats.laDiffers} MSOAs have a different LA code in the ONS table than in the LAD 2025 lookup`);
  ctx.log(`  ons-msoa: ${stats.areas} areas (${stats.suppressed} suppressed, ${stats.few} with fewer than ${COLOUR_MIN_N} sales, ${stats.outOfScope} out of scope) in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

  meta.period = `12 months to ${cap(MONTHS[med.month])} ${med.year}`;
  return { vintage: `12m-to-${med.year}-${String(med.month + 1).padStart(2, '0')}`, areas };
}

export default {
  id: ID,
  regions: ['uk'],
  cadence: 'semiannual',   // ONS releases in March and September
  meta,
  fetch: fetchAreas,
};
