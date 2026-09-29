// Toronto and Vancouver: Statistics Canada, Census Profile, 2021 Census of
// Population, by census tract (CT): characteristic 1474 "Median value of
// dwellings ($)", with characteristic 1468 "Total - Owner households in
// non-farm, non-reserve private dwellings - 25% sample data" as the count
// behind it. Drawn on the 2021 cartographic boundary file for census tracts.
//
// WHY this: there is no open small-area sale price or current valuation for
// Toronto (MPAC is proprietary and still on 2016 values; CREA/TRREB/MLS forbid
// display), and Vancouver's assessed values carry BC Assessment's third-party
// rights (SPEC §0, not in phase 1). The census figure is official, open for
// commercial use, local, and suppressed by StatCan itself where unreliable. It
// is the OWNERS' OWN ESTIMATE on census day (11 May 2021), and the metric label
// and notes say so. Census tracts rather than dissemination areas: a DA median
// carries about ±12% sampling error, a CT about ±5% (research-summary.md).
//
// Three upstreams, all Statistics Canada, keyless:
//   1. The Census Profile SDMX API (api.statcan.gc.ca), dataflow DF_CT, every
//      CT in Canada for the two characteristics in ONE call (~1.8 MB CSV;
//      the key has no province dimension). CSV only with the SDMX-CSV Accept
//      header (otherwise SDMX-ML), and only with a real Accept-Language: Node's
//      fetch sends "*", which the API answers with HTTP 500 "languageTag1".
//   2. The same API's codelist CL_GEO_CMACA: the official name of the census
//      metropolitan area a CT belongs to (the first three digits of its code),
//      for the area name "Census tract 5350012.02, Toronto".
//   3. The static boundary zip lct_000b21a_e.zip on www12.statcan.gc.ca (the
//      "b" is the cartographic file, clipped to the shoreline). Preferred over
//      geo.statcan.gc.ca's ArcGIS REST, which answered HTTP 500 on half of
//      identical queries in the research. It is in Statistics Canada Lambert
//      (EPSG:3347); lib/shp.mjs inverts it exactly (checked against StatCan's
//      own Geographic Attribute File: 11,306 DA points in the two CMAs match
//      to 5e-7°, each inside its own CT).
//
// Static until the 2026 Census housing release (expected September 2027); a
// new vintage is a new dataflow version and a new boundary file, so it is
// taken by editing CENSUS below, never picked up silently.
//
// Scope (R2): a CT is kept when its province is one of its region's home
// jurisdictions AND its extent overlaps the region's crime-data rectangle.
//
// Honesty rules (SPEC §1). StatCan's own symbols (SDMX codelist CL_FLAG):
//   x (6) suppressed for confidentiality, F (4) too unreliable to be
//   published, .. (1) not available            -> value null, 'suppressed'
//   ... (2) not applicable, or no value at all  -> value null, no flag: nothing
//                                                  was published (no owner
//                                                  households), so not drawn
//   E (3) / rE (7) use with caution             -> 'uncertain' (value in the
//                                                  pane, neutral on the map)
//   r (5) revised                               -> used as published
// The profile gives a confidence interval (CI_LOW/CI_HIGH), not a 90% margin
// of error, so moe is null rather than a figure StatCan did not publish.

import { unlinkSync } from 'node:fs';
import { join } from 'node:path';

const ID = 'statcan-ct';
const REGIONS = ['toronto', 'vancouver'];
const SDMX = 'https://api.statcan.gc.ca/census-recensement/profile/sdmx/rest';
const CENSUS = {
  year: '2021',
  data: `${SDMX}/data/STC_CP,DF_CT/A5..1.1468+1474.1`,
  cmaNames: `${SDMX}/codelist/STC_CP/CL_GEO_CMACA`,
  boundary: 'https://www12.statcan.gc.ca/census-recensement/2021/geo/sip-pis/boundary-limites/files-fichiers/lct_000b21a_e.zip',
};
const VALUE = '1474', OWNERS = '1468';
const API_HEADERS = { accept: 'application/vnd.sdmx.data+csv', 'accept-language': 'en' };
const MAX_AGE_H = 24 * 90;                 // static data; the cache only spares repeat dev runs

// PRUID -> ISO 3166-2 (every province and territory).
const PROVINCE = {
  10: 'CA-NL', 11: 'CA-PE', 12: 'CA-NS', 13: 'CA-NB', 24: 'CA-QC', 35: 'CA-ON', 46: 'CA-MB', 47: 'CA-SK', 48: 'CA-AB', 59: 'CA-BC',
  60: 'CA-YT', 61: 'CA-NT', 62: 'CA-NU',
};
const SUPPRESSED = new Set(['1', '4', '6']), NOTHING = new Set(['', '2', 'O']), CAUTION = new Set(['3', '7']), AS_PUBLISHED = new Set(['', '5']);

const meta = {
  name: 'Census Profile, 2021 Census of Population: median value of dwellings and owner households, by census tract',
  publisher: 'Statistics Canada',
  url: 'https://www12.statcan.gc.ca/census-recensement/2021/dp-pd/prof/index.cfm?Lang=E',
  licence: 'Statistics Canada Open Licence',
  licenceUrl: 'https://www.statcan.gc.ca/en/terms-conditions/open-licence',
  // The licence's own form for value-added products ("Adapted from Statistics
  // Canada, name of product, reference date. This does not constitute an
  // endorsement…"). The boundary file's own metadata names the Open Government
  // Licence – Canada, so that line says so.
  attribution: [
    'Adapted from Statistics Canada, Census Profile, 2021 Census of Population (98-316-X2021001), 2021. This does not constitute an endorsement by Statistics Canada of this product.',
    'Adapted from Statistics Canada, Census Tracts 2021, Cartographic Boundary Files, 2021. Contains information licensed under the Open Government Licence – Canada.',
  ],
  metric: 'Median home value (owners’ estimate)',
  unitNoun: 'owner households',
  currency: 'CAD',
  period: '2021 Census (May 2021)',
  notes: [
    'Owners’ own estimate of what their home would sell for, from the 2021 Census long-form questionnaire (a 25% sample), not sale prices. Renters’ homes are not included.',
    'The figures describe May 2021, not today’s market. Statistics Canada withholds figures that are too unreliable or could identify a household.',
  ],
  areaNoun: 'census tract',
  colourMinN: null,
  // Characteristic 1468 is itself a weighted estimate from the 25% sample,
  // not the number of answers behind the median.
  nEstimate: true,
  credit: 'Statistics Canada',
  // The boundary line's own licence, which it names, linked there too.
  licences: [{ licence: 'Open Government Licence – Canada', licenceUrl: 'https://open.canada.ca/en/open-government-licence-canada' }],
};

// ── Statistics Canada API ───────────────────────────────────────────────────
// A cached body that turns out not to be what was asked for (an error page
// with HTTP 200) would be re-read until it expires, so it is deleted first.
function refuse(ctx, file, msg) {
  if (ctx.rawDir) { try { unlinkSync(join(ctx.rawDir, file)); } catch {} }
  throw new Error(msg);
}

// CTUID -> { value: [obs, flag], owners: [obs, flag] }
async function profile(ctx) {
  const file = `statcan-cp${CENSUS.year}-ct-${OWNERS}-${VALUE}.csv`;
  const buf = await ctx.download(file, CENSUS.data, { maxAgeH: MAX_AGE_H, timeoutMs: 300_000, headers: API_HEADERS });
  const { parseCsv, columns } = ctx.readers;
  const { header, rows } = parseCsv(buf);
  if (header[0] !== 'DATAFLOW') refuse(ctx, file, `${file}: not SDMX-CSV (starts "${buf.toString('utf8', 0, 60)}")`);
  const col = columns(header, ['DATAFLOW', 'TIME_PERIOD', 'GENDER', 'CHARACTERISTIC', 'STATISTIC', 'OBS_VALUE', 'FLAG', 'GEO_LEVEL', 'ALT_GEO_CODE'], file);
  const out = new Map();
  for (const r of rows) {
    if (r.length < header.length - 1) continue;                         // a trailing blank line
    const ch = r[col.CHARACTERISTIC];
    if (ch !== VALUE && ch !== OWNERS) refuse(ctx, file, `${file}: characteristic ${ch} was not asked for — the dataflow changed`);
    // The key asked for exactly this; anything else is a changed dataflow.
    if (!/^STC_CP:DF_CT\(/.test(r[col.DATAFLOW]) || r[col.TIME_PERIOD] !== CENSUS.year || r[col.GENDER] !== '1' || r[col.STATISTIC] !== '1' || r[col.GEO_LEVEL] !== '12') {
      refuse(ctx, file, `${file}: unexpected row ${JSON.stringify(r.slice(0, 16))} — the dataflow changed`);
    }
    const ct = r[col.ALT_GEO_CODE];
    if (!/^\d{7}\.\d{2}$/.test(ct)) throw new Error(`${file}: census tract code "${ct}" is not NNNNNNN.NN`);
    const rec = out.get(ct) || {};
    const key = ch === VALUE ? 'value' : 'owners';
    if (rec[key]) throw new Error(`${file}: CT ${ct} has two rows for characteristic ${ch}`);
    rec[key] = [r[col.OBS_VALUE].trim(), r[col.FLAG].trim()];
    out.set(ct, rec);
  }
  if (out.size < 5000) refuse(ctx, file, `${file}: only ${out.size} census tracts (Canada has about 6,200) — a partial answer`);
  return out;
}

// CMA/CA code (3 digits) -> its English name, from the profile's own codelist.
async function cmaNames(ctx) {
  const file = `statcan-cp${CENSUS.year}-cl-geo-cmaca.xml`;
  const xml = (await ctx.download(file, CENSUS.cmaNames, { maxAgeH: MAX_AGE_H, headers: { 'accept-language': 'en' } })).toString('utf8');
  const out = new Map();
  for (const m of xml.matchAll(/<(?:\w+:)?Code id="2021S050[34](\d{3})">\s*<(?:\w+:)?Name xml:lang="en">([^<]+)</g)) out.set(m[1], m[2].trim());
  if (!out.size) refuse(ctx, file, `${file}: no CMA/CA names found — the codelist format changed`);
  return out;
}

// ── scope ───────────────────────────────────────────────────────────────────
const intersects = (a, b) => a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1];
const regionOf = (ctx, id) => (Array.isArray(ctx.regions) ? ctx.regions.find(r => r.id === id) : ctx.regions?.[id]);
function scaleOf(ctx, id) {
  const scales = regionOf(ctx, id)?.scales || [id];
  if (scales.length !== 1) throw new Error(`${ID}: region ${id} lists ${scales.length} scale keys; a Canadian city has one`);
  return scales[0];
}

// "585000" -> 585000; '' -> null; anything else is a format change.
function count(s, what) {
  if (s === '') return null;
  if (!/^\d+$/.test(s)) throw new Error(`${what}: "${s}" is not a whole number — the format changed`);
  return +s;
}

async function fetchAreas(ctx) {
  const t0 = Date.now();
  const served = (ctx.coverage || []).filter(c => REGIONS.includes(c.id)).map(c => {
    const juris = regionOf(ctx, c.id)?.juris;
    if (!juris?.length) throw new Error(`${ID}: region ${c.id} has no home jurisdictions (tools/schools/regions.mjs juris)`);
    return { id: c.id, bbox: c.bbox, juris, scale: scaleOf(ctx, c.id) };
  });
  const missing = REGIONS.filter(id => !served.some(r => r.id === id));
  if (missing.length) ctx.log(`  note: ${missing.join(', ')} not in coverage.json; skipped`);
  const wanted = new Set(served.flatMap(r => r.juris));
  for (const j of wanted) if (!Object.values(PROVINCE).includes(j)) throw new Error(`${ID}: jurisdiction ${j} is not a Canadian province or territory`);

  const data = await profile(ctx);
  const names = await cmaNames(ctx);
  const zip = ctx.readers.unzip(await ctx.download('lct_000b21a_e.zip', CENSUS.boundary, { maxAgeH: MAX_AGE_H, timeoutMs: 600_000 }));
  const { features, fields, stats: s } = ctx.readers.shp.readShapefile(zip, { where: p => wanted.has(PROVINCE[p.PRUID]) });
  ctx.readers.columns(fields.map(f => f.name), ['CTUID', 'PRUID'], 'lct_000b21a_e.dbf');
  if (s.orphanHoles) ctx.log(`  note: lct_000b21a_e: ${s.orphanHoles} hole(s) with no outer ring kept as polygons`);

  const stats = { areas: 0, suppressed: 0, noValue: 0, uncertain: 0, outOfScope: 0 };
  const areas = [];
  for (const { props: p, bbox, polys } of features) {
    const juris = PROVINCE[p.PRUID];
    const hits = served.filter(r => r.juris.includes(juris) && intersects(bbox, r.bbox));
    if (!hits.length) { stats.outOfScope++; continue; }
    const cLat = (bbox[0] + bbox[2]) / 2, cLng = (bbox[1] + bbox[3]) / 2;
    const region = hits.find(r => ctx.inBox(r.bbox, cLat, cLng)) || hits[0];

    const ct = p.CTUID;
    const rec = data.get(ct);
    // Profile and boundaries are the same census, so every CT must be in both.
    if (!rec?.value || !rec?.owners) throw new Error(`CT ${ct} has no ${!rec?.value ? VALUE : OWNERS} row in the Census Profile — boundary and profile disagree`);
    const cma = names.get(ct.slice(0, 3));
    if (!cma) throw new Error(`CT ${ct}: CMA/CA ${ct.slice(0, 3)} is not in CL_GEO_CMACA`);

    const [obs, flag] = rec.value;
    let value = null;
    const flags = [];
    if (obs === '') {
      if (SUPPRESSED.has(flag)) { flags.push('suppressed'); stats.suppressed++; }
      else if (NOTHING.has(flag)) stats.noValue++;
      else throw new Error(`CT ${ct}: no value with flag "${flag}" — an unknown StatCan symbol`);
    } else {
      value = count(obs, `CT ${ct} median value`);
      if (!(value > 0)) throw new Error(`CT ${ct}: median value ${obs}`);
      if (CAUTION.has(flag)) { flags.push('uncertain'); stats.uncertain++; }
      else if (!AS_PUBLISHED.has(flag)) throw new Error(`CT ${ct}: value ${obs} with flag "${flag}" — an unknown StatCan symbol`);
    }
    const n = count(rec.owners[0], `CT ${ct} owner households`);
    areas.push({ id: ct, name: `Census tract ${ct}, ${cma}`, region: region.id, juris, scale: region.scale, value, moe: null, n, flags, context: null, polys });
    stats.areas++;
  }
  const empty = served.filter(r => !areas.some(a => a.region === r.id)).map(r => r.id);
  if (empty.length) throw new Error(`${ID}: no census tracts for ${empty.join(', ')} — the boundary file or scope check is wrong`);
  ctx.log(`  ${ID}: ${stats.areas} census tracts (${stats.suppressed} suppressed, ${stats.noValue} with nothing published, ${stats.uncertain} use-with-caution, ` +
    `${stats.outOfScope} out of scope in the province) in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  return { vintage: CENSUS.year, areas };
}

export default {
  id: ID,
  regions: REGIONS,
  cadence: 'static',        // until the 2026 Census housing release (expected Sept 2027)
  meta,
  fetch: fetchAreas,
};
