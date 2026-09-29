// Northern Ireland: the ward-level MEDIAN SALE PRICE for "All" property types
// in the latest calendar year, from Land & Property Services' annual
// descriptive house price statistics (published with NISRA), drawn on the
// OSNI Largescale Wards (2012) polygons: the 462 wards in use since 2014.
//
// WHY this: Price Paid Data covers England and Wales only, so NI has no open
// sale-level data. These published ward medians are the most local official
// sale-price statistic there, OGL, and they need no postcodes. NEVER use BT
// postcodes from any ONS product (ONSPD, NSPL, the postcode lookups): LPS
// licenses them for internal business use only.
//
// Two feeds of the same statistic, whichever has the newer year:
//   1. NISRA PxStat NIDHPSATWARD  coded by ward (N08…), so no name matching.
//                                 PREFERRED when it carries the newest year; it
//                                 lags the workbook by about six months (in Sept
//                                 2026 it stops at 2024), so it is polled with
//                                 the small ReadMetadata call and the 35 MB CSV
//                                 is pulled only when it would be used.
//   2. The LPS workbook on finance-ni.gov.uk: rows carry only the council and
//                                 the ward NAME (12 names occur in two councils),
//                                 so they are joined to codes through the
//                                 vendored, hand-checked crosswalk
//                                 tools/data/prices/ni-ward-crosswalk.json. Its
//                                 file names are date-stamped, so the links are
//                                 read from the publication page each time.
//
// Honesty rules (SPEC §1):
//   - LPS leaves a ward's median blank when fewer than 30 of its sales could be
//     used; a ward with no sales at all has 0. Both are "no figure": value null,
//     'suppressed', neutral on the map. For those wards the pane gets the median
//     of the ward's District Electoral Area (same release, same year) as a
//     clearly labelled wider-area context line.
//   - Only the median and the verified-sales count are read. The MIN and MAX
//     columns are single transactions and are never published; neither are the
//     quartiles or the mean.
//   - LPS says annual medians must not be used to measure price change, so no
//     earlier year is read at all.

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { nameKey } from '../../schools/ratings/_us.mjs';

const ID = 'ni-ward';
const PUB = 'https://www.finance-ni.gov.uk/publications/annual-ward-district-electoral-area-and-local-government-districts-statistics';
const PX = 'https://ws-data.nisra.gov.uk/public/api.restful/PxStat.Data.Cube_API';
const PX_TABLE = 'NIDHPSATWARD';
// OpenDataNI (CKAN) dataset "OSNI Open Data - Largescale Boundaries - Wards (2012)".
// The GeoJSON resource is looked up in the package each time (resource ids
// change when OSNI re-uploads); the last known URL is the fallback.
const ODNI_PACKAGE = 'https://admin.opendatani.gov.uk/api/3/action/package_show?id=987e16f4-19bb-4765-807c-abee92ee3439';
const ODNI_GEOJSON = 'https://admin.opendatani.gov.uk/dataset/987e16f4-19bb-4765-807c-abee92ee3439/resource/44160d85-47bd-452d-b846-0c7dcc14c932/download/osni_open_data_largescale_boundaries_wards_2012.geojson';
const CROSSWALK = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'data', 'prices', 'ni-ward-crosswalk.json');
const WARDS = 462, COUNCILS = 11;

const meta = {
  name: 'Northern Ireland Annual Descriptive House Price Statistics, by electoral ward',
  publisher: 'Land & Property Services (LPS) and NISRA',
  url: PUB,
  licence: 'Open Government Licence v3.0',
  licenceUrl: 'https://www.nationalarchives.gov.uk/doc/open-government-licence/version/3/',
  attribution: [
    // The workbook cover's own wording, after the source credit NISRA asks for.
    'Source: Land & Property Services / NISRA, Northern Ireland Annual Descriptive House Price Statistics. Contains public sector information licensed under the Open Government Licence v3.0.',
    // LPS's required statement for its OSNI open data ("LPS OPEN DATA" terms).
    'Ward boundaries: OSNI Open Data, Largescale Boundaries, Wards (2012), Land & Property Services. Contains public sector information licensed under the terms of the Open Government Licence v3.0.',
  ],
  metric: 'Median sale price',
  unitNoun: 'verified sales',
  currency: 'GBP',
  // Set by fetch() to the year it actually read.
  period: 'Calendar year 2025',
  notes: [
    'The middle price of homes sold in the calendar year, all property types: sales recorded by HMRC and verified by Land & Property Services against the NI Valuation List.',
    'LPS publishes a ward median only where at least 30 of the year’s sales could be used in its price model. Where it does not, the median for the wider District Electoral Area is shown instead, labelled as such.',
  ],
  areaNoun: 'electoral ward',
  colourMinN: null,   // LPS's own 30-sale floor already applies
  // The map's credit line (the full lines above are one click away from it).
  credit: 'LPS, NISRA, OSNI',
};

// The workbook writes apostrophes as the literal text "&apos;" (O&apos;NEILL).
const unescape = s => String(s ?? '').replace(/&apos;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&').trim();
const key = (lgd, name) => `${nameKey(lgd)}|${nameKey(name)}`;
const regionOf = (ctx, id) => (Array.isArray(ctx.regions) ? ctx.regions.find(r => r.id === id) : ctx.regions?.[id]);

// A median cell: a number of pounds, or null for blank (fewer than 30 usable
// sales) and 0 (no sales). A count cell: a whole number. Anything else is a
// format change and stops the build.
function median(cell, what) {
  const c = String(cell ?? '').trim();
  if (c === '' || c === '0') return null;
  if (/^\d+(\.\d+)?$/.test(c)) return +c;
  throw new Error(`${what}: median ${JSON.stringify(c)} is not a number — the table changed`);
}
function count(cell, what) {
  const c = String(cell ?? '').trim();
  if (/^\d+$/.test(c)) return +c;
  throw new Error(`${what}: sales count ${JSON.stringify(c)} is not a whole number — the table changed`);
}

// ── the crosswalk ───────────────────────────────────────────────────────────
function loadCrosswalk() {
  const doc = JSON.parse(readFileSync(CROSSWALK, 'utf8'));
  const byCode = new Map(), byName = new Map();
  for (const w of doc.wards || []) {
    if (!/^N08\d{6}$/.test(w.code) || !w.name || !w.lgd || !w.ward || !w.lgdName || !w.dea) throw new Error(`ni-ward-crosswalk.json: incomplete row ${JSON.stringify(w)}`);
    if (byCode.has(w.code) || byName.has(key(w.lgd, w.ward))) throw new Error(`ni-ward-crosswalk.json: ${w.code} / ${w.lgd} ${w.ward} appears twice`);
    byCode.set(w.code, w);
    byName.set(key(w.lgd, w.ward), w);
  }
  if (byCode.size !== WARDS) throw new Error(`ni-ward-crosswalk.json has ${byCode.size} wards, not ${WARDS}`);
  return { byCode, byName };
}

// ── LPS workbooks (ward and DEA) ────────────────────────────────────────────
async function lpsLinks(ctx) {
  const html = (await ctx.download('ni-lps-publication.html', PUB, { maxAgeH: 12 })).toString('utf8');
  const hrefs = [...html.matchAll(/href="([^"]+\.xlsx)"/gi)].map(m => new URL(m[1].replace(/&amp;/g, '&'), PUB).href);
  const one = (re, what) => {
    const hit = hrefs.filter(u => re.test(decodeURIComponent(u)));
    if (hit.length !== 1) throw new Error(`LPS publication page: expected one "${what}" workbook link, found ${hit.length} — the page changed`);
    return hit[0];
  };
  return {
    ward: one(/Electoral Ward Annual Price Statistics Property Types[^/]*\.xlsx$/i, 'Electoral Ward … Property Types'),
    dea: one(/District Electoral Area Annual Price Statistics Property Types[^/]*\.xlsx$/i, 'District Electoral Area … Property Types'),
  };
}
// The upload month in the link (/files/2026-08/) names the cache file, so a
// new publication can never be answered from last year's cached workbook.
const stamp = url => /\/files\/(\d{4}-\d{2})\//.exec(url)?.[1] || 'undated';

// Every "<council>_Total" sheet (all property types). One per council.
function lpsTotals(ctx, buf, areaCol, what) {
  const wb = ctx.readers.xlsx(buf);
  const sheets = wb.sheets.filter(s => /_Total$/.test(s));
  if (sheets.length !== COUNCILS) throw new Error(`${what}: ${sheets.length} "_Total" sheets, expected one per council (${COUNCILS})`);
  const need = ['Local Government District', areaCol, 'Sale Year', 'Property Type', 'No. of Verified Sales', 'Median Sale Price'];
  const out = [];
  for (const s of sheets) {
    const recs = ctx.readers.sheetRecords(wb.rows(s), h => h[0] === 'Local Government District', need, `${what} ${s}`);
    for (const r of recs) {
      if (r['Property Type'] !== 'All Sales') throw new Error(`${what} ${s}: property type "${r['Property Type']}", expected "All Sales"`);
      if (!/^\d{4}$/.test(r['Sale Year'])) throw new Error(`${what} ${s}: sale year "${r['Sale Year']}"`);
      out.push({ lgd: r['Local Government District'], name: unescape(r[areaCol]), year: +r['Sale Year'], vs: r['No. of Verified Sales'], med: r['Median Sale Price'] });
    }
  }
  return out;
}

// ── NISRA PxStat (coded) ────────────────────────────────────────────────────
// Its newest year, or null when the portal is unreachable: the coded feed is
// the preferred one, but not a reason to fail a build the workbook can serve.
async function pxLatestYear(ctx) {
  try {
    const doc = JSON.parse((await ctx.download('nisra-nidhpsatward-meta.json', `${PX}.ReadMetadata/${PX_TABLE}/JSON-stat/2.0/en`, { maxAgeH: 12 })).toString('utf8'));
    const years = (doc.dimension?.['TLIST(A1)']?.category?.index || []).map(Number).filter(Number.isInteger);
    if (!years.length) throw new Error('no TLIST(A1) years');
    return Math.max(...years);
  } catch (e) {
    ctx.log(`  NISRA PxStat ${PX_TABLE} metadata unavailable (${e.message}); using the LPS workbook`);
    return null;
  }
}
async function pxWards(ctx, year) {
  const buf = await ctx.download('nisra-nidhpsatward.csv', `${PX}.ReadDataset/${PX_TABLE}/CSV/1.0/en`, { maxAgeH: 12, timeoutMs: 300_000 });
  const { header, rows } = ctx.readers.parseCsv(buf);
  const col = ctx.readers.columns(header, ['STATISTIC', 'TLIST(A1)', 'WARD2014', 'ACCTYPE', 'VALUE'], `PxStat ${PX_TABLE}`);
  const at = new Map();
  for (const r of rows) {
    if (r[col['TLIST(A1)']] !== String(year) || r[col.ACCTYPE] !== 'All') continue;
    const s = r[col.STATISTIC];
    if (s !== 'MEDIAN' && s !== 'VS') continue;       // MIN/MAX/quartiles/mean are never read
    const code = r[col.WARD2014];
    const w = at.get(code) || {};
    w[s] = r[col.VALUE];
    at.set(code, w);
  }
  return [...at.entries()].map(([code, w]) => ({ code, vs: w.VS, med: w.MEDIAN ?? '' }));
}

// ── OSNI ward polygons ──────────────────────────────────────────────────────
async function wardPolygons(ctx) {
  // admin.opendatani.gov.uk refuses some user agents (curl's 403s); Node's
  // default is accepted, so ua: null. The file itself is a signed redirect.
  const resolve = async () => {
    try {
      const pkg = JSON.parse((await ctx.download('odni-wards-2012-package.json', ODNI_PACKAGE, { maxAgeH: 24 * 7, ua: null })).toString('utf8'));
      const res = (pkg.result?.resources || []).filter(r => /geojson/i.test(r.format || '') && /^https:\/\//.test(r.url || ''));
      return [...res.map(r => r.url), ODNI_GEOJSON];
    } catch (e) {
      ctx.log(`  OpenDataNI package lookup failed (${e.message}); trying the last known GeoJSON URL`);
      return [ODNI_GEOJSON];
    }
  };
  const doc = JSON.parse((await ctx.download('osni-wards-2012.geojson', resolve, { maxAgeH: 24 * 90, ua: null, timeoutMs: 300_000 })).toString('utf8'));
  // The package record is a discovery aid, not data, and it is only read when
  // the GeoJSON is not already cached, so recording it would make the same
  // build list different upstream files on a cold cache (every CI run) than on
  // a warm one, and a refetch of identical bytes look like a new release.
  // Left out of the provenance, as acs-tract leaves out its listings.
  const pk = ctx.provenance?.findIndex(p => p.file === 'odni-wards-2012-package.json') ?? -1;
  if (pk >= 0) ctx.provenance.splice(pk, 1);
  const crs = doc.crs?.properties?.name || 'CRS84';
  if (!/CRS84|EPSG:+4326/i.test(crs)) throw new Error(`OSNI wards GeoJSON is in ${crs}, not WGS84 lon/lat`);
  const out = new Map();
  for (const f of doc.features || []) {
    const code = f.properties?.WardCode;
    const g = f.geometry;
    const polys = g?.type === 'Polygon' ? [g.coordinates] : g?.type === 'MultiPolygon' ? g.coordinates : null;
    if (!/^N08\d{6}$/.test(code || '') || !polys?.length) throw new Error(`OSNI wards GeoJSON: feature without a ward code or polygon (${JSON.stringify(f.properties)})`);
    if (out.has(code)) throw new Error(`OSNI wards GeoJSON: ${code} appears twice`);
    out.set(code, polys);
  }
  return out;
}
function bboxOf(polys) {
  let s = 90, w = 180, n = -90, e = -180;
  for (const p of polys) for (const ring of p) for (const [x, y] of ring) {
    if (y < s) s = y; if (y > n) n = y; if (x < w) w = x; if (x > e) e = x;
  }
  return [s, w, n, e];
}
const intersects = (a, b) => a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1];

async function fetchAreas(ctx) {
  const t0 = Date.now();
  const xw = loadCrosswalk();
  const links = await lpsLinks(ctx);
  const wardBook = lpsTotals(ctx, await ctx.download(`ni-lps-ward-property-types-${stamp(links.ward)}.xlsx`, links.ward, { maxAgeH: 24 * 7 }),
    'Electoral Ward (2014)', 'LPS ward workbook');
  const deaBook = lpsTotals(ctx, await ctx.download(`ni-lps-dea-property-types-${stamp(links.dea)}.xlsx`, links.dea, { maxAgeH: 24 * 7 }),
    'District Electoral Area (2014)', 'LPS DEA workbook');
  const bookYear = Math.max(...wardBook.map(r => r.year));

  // The newest year wins; on a tie the coded feed, which needs no name match.
  const pxYear = await pxLatestYear(ctx);
  const year = pxYear != null && pxYear >= bookYear ? pxYear : bookYear;
  let rows, feed;
  if (pxYear != null && pxYear >= bookYear) {
    feed = `NISRA PxStat ${PX_TABLE}`;
    rows = await pxWards(ctx, year);
    const unknown = rows.filter(r => !xw.byCode.has(r.code));
    if (unknown.length) throw new Error(`${feed} ${year}: ward code(s) not in the 2014 ward set: ${unknown.slice(0, 5).map(r => r.code).join(', ')}`);
  } else {
    feed = 'LPS workbook';
    // Every workbook row must match a crosswalk row: a renamed or new ward
    // stops the build (and gets a hand-checked row) instead of vanishing.
    rows = wardBook.filter(r => r.year === year).map(r => {
      const w = xw.byName.get(key(r.lgd, r.name));
      if (!w) throw new Error(`LPS ward "${r.name}" (${r.lgd}) is not in tools/data/prices/ni-ward-crosswalk.json — add a hand-checked row`);
      return { code: w.code, vs: r.vs, med: r.med };
    });
  }
  const seen = new Set(rows.map(r => r.code));
  if (rows.length !== WARDS || seen.size !== WARDS) throw new Error(`${feed} ${year}: ${rows.length} rows for ${seen.size} wards, expected ${WARDS} each`);

  // DEA medians of the same year, by (council, DEA) as the DEA workbook spells them.
  const deas = new Map(deaBook.filter(r => r.year === year).map(r => [key(r.lgd, r.name), r]));
  if (!deas.size) ctx.log(`  the LPS DEA workbook has no ${year} rows; wards without a median get no wider-area line`);

  const polys = await wardPolygons(ctx);
  const missing = [...xw.byCode.keys()].filter(c => !polys.has(c));
  const extra = [...polys.keys()].filter(c => !xw.byCode.has(c));
  if (missing.length || extra.length) throw new Error(`OSNI ward codes differ from the 2014 ward set: missing ${missing.slice(0, 5)}, extra ${extra.slice(0, 5)}`);

  const cov = (ctx.coverage || []).find(c => c.id === 'uk');
  if (!cov) throw new Error('coverage has no "uk" region');
  const juris = regionOf(ctx, 'uk')?.juris || ['GB-ENG', 'GB-WLS', 'GB-NIR'];
  const stats = { areas: 0, suppressed: 0, noSales: 0, context: 0, outOfScope: 0 };
  const areas = [];
  for (const r of rows.sort((a, b) => (a.code < b.code ? -1 : 1))) {
    const w = xw.byCode.get(r.code), p = polys.get(r.code);
    if (!juris.includes('GB-NIR') || !intersects(bboxOf(p), cov.bbox)) { stats.outOfScope++; continue; }
    const what = `${feed} ${year} ${r.code}`;
    const value = median(r.med, what), n = count(r.vs, what);
    let flags = [], context = null;
    if (value == null) {
      flags = ['suppressed'];
      stats.suppressed++;
      if (n === 0) stats.noSales++;
      const d = deas.get(key(w.lgd, w.dea));
      if (deas.size && !d) throw new Error(`LPS DEA workbook has no ${year} row for ${w.dea} (${w.lgd}), the DEA of ${w.name} in the crosswalk`);
      const dv = d ? median(d.med, `LPS DEA ${year} ${w.dea}`) : null;
      if (dv != null) {
        // The label names the metric: the line stands alone in the pane and
        // the report, beside a ward that has no figure of its own.
        context = { label: `Median sale price, wider area (${w.lgdName} DEA ‘${d.name}’), ${year}`, value: dv, n: count(d.vs, `LPS DEA ${year} ${w.dea}`) };
        stats.context++;
      }
    }
    areas.push({ id: r.code, name: w.name, region: 'uk', juris: 'GB-NIR', scale: 'TLN', value, moe: null, n, flags, context, polys: p });
    stats.areas++;
  }
  ctx.log(`  ni-ward: ${year} from the ${feed} (PxStat has ${pxYear ?? 'n/a'}, workbook ${bookYear}): ${stats.areas} wards, ` +
    `${stats.suppressed} without a median (${stats.noSales} with no sales), ${stats.context} with a DEA line, ${stats.outOfScope} out of scope, ${((Date.now() - t0) / 1000).toFixed(1)}s`);

  meta.period = `Calendar year ${year}`;
  return { vintage: String(year), areas };
}

export default {
  id: ID,
  regions: ['uk'],
  cadence: 'annual',   // LPS publishes each August for the previous calendar year
  meta,
  fetch: fetchAreas,
};
