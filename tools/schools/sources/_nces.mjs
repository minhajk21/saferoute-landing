// Shared helpers for the two NCES sources (sources/ccd.mjs = US public schools,
// sources/pss.mjs = US private schools) and for the US state rating modules
// (tools/schools/ratings/us-*.mjs). The leading "_" keeps the module loader from
// treating this file as a source.
//
//   unzipEntry(buf, /\.csv$/i)     -> Buffer   one entry of a .zip (stored or deflated, CRC-checked)
//   ccdGrade / ccdSpan             NCES CCD grade codes (PK KG 01..13 UG AE)  -> "PK–5", "K–8", "9–12"
//   pssGrade / pssSpan             PSS LOGR/HIGR recodes (1..17)              -> "PK–8", "K–12"
//   count(v) / fte(v)              NCES numbers; the missing / not-applicable / suppressed codes (-1, -2, -3, -9) -> null
//   ccdDirectory(ctx)              NCESSCH -> { ST_SCHID, ST_LEAID, … } from the CCD 029 directory:
//                                  the join key every US state rating file needs (see below)
//   zctaPoints() / positionChecks  the independent position reference for verify-schools
//
// Zero dependencies, like the rest of tools/ (the repo has no package.json).

import { inflateRawSync, crc32 } from 'node:zlib';
import { parseCsv, columns } from '../lib/csv.mjs';

// ── zip ─────────────────────────────────────────────────────────────────────
// NCES publishes every file as a .zip holding one CSV. A minimal reader: find
// the end-of-central-directory record, walk the central directory, inflate the
// one entry asked for, and check its CRC-32 and size so a truncated download
// fails loudly instead of parsing half a file. No ZIP64 (every file here is
// far below 4 GB).
export function unzipList(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 0xffff); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('not a zip file (no end-of-central-directory record)');
  const entries = buf.readUInt16LE(eocd + 10), cdOffset = buf.readUInt32LE(eocd + 16);
  if (cdOffset === 0xffffffff) throw new Error('ZIP64 archives are not supported');
  const list = [];
  for (let p = cdOffset, n = 0; n < entries; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('corrupt zip central directory');
    const method = buf.readUInt16LE(p + 10), crc = buf.readUInt32LE(p + 16);
    const csize = buf.readUInt32LE(p + 20), usize = buf.readUInt32LE(p + 24);
    const nlen = buf.readUInt16LE(p + 28), xlen = buf.readUInt16LE(p + 30), clen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nlen);
    list.push({ name, method, crc, csize, usize, local });
    p += 46 + nlen + xlen + clen;
  }
  return list;
}

export function unzipEntry(buf, match) {
  const list = unzipList(buf).filter(e => !e.name.endsWith('/'));
  const hits = list.filter(e => (match instanceof RegExp ? match.test(e.name) : e.name === match));
  if (hits.length !== 1) throw new Error(`zip: expected one entry matching ${match}, found ${hits.length} (${list.map(e => e.name).join(', ')})`);
  const e = hits[0];
  if (buf.readUInt32LE(e.local) !== 0x04034b50) throw new Error(`zip: bad local header for ${e.name}`);
  const start = e.local + 30 + buf.readUInt16LE(e.local + 26) + buf.readUInt16LE(e.local + 28);
  const raw = buf.subarray(start, start + e.csize);
  if (e.method !== 0 && e.method !== 8) throw new Error(`zip: ${e.name} uses compression method ${e.method}`);
  let out;
  try { out = e.method === 0 ? Buffer.from(raw) : inflateRawSync(raw); }
  catch (err) { throw new Error(`zip: ${e.name} is damaged (${err.message}; truncated download?)`); }
  if (out.length !== e.usize || (crc32(out) >>> 0) !== e.crc) throw new Error(`zip: ${e.name} failed its size/CRC check (truncated download?)`);
  return out;
}

// ── numbers ─────────────────────────────────────────────────────────────────
// NCES writes missing (-1), not applicable (-2), not reported (-3) and
// suppressed (-9) as negative numbers, and the ArcGIS layer can carry null.
// None of them is a count.
export const count = v => { if (v === null || v === undefined || v === '') return null; const n = +v; return Number.isFinite(n) && n > 0 ? Math.round(n) : null; };
export const fte = v => { if (v === null || v === undefined || v === '') return null; const n = +v; return Number.isFinite(n) && n > 0 ? +n.toFixed(1) : null; };
export const r5 = x => +(+x).toFixed(5);

// ── grade spans ─────────────────────────────────────────────────────────────
// CCD GSLO/GSHI: PK, KG, 01..12, 13, UG (ungraded), AE (adult education); M/N
// (missing / not applicable) publish nothing. Shown the way US schools write a
// span: "PK–5", "K–8", "9–12".
const CCD_GRADE = { PK: 'PK', KG: 'K', UG: 'Ungraded', AE: 'Adult education' };
export function ccdGrade(code) {
  const c = String(code ?? '').trim().toUpperCase();
  if (CCD_GRADE[c]) return CCD_GRADE[c];
  if (/^\d{1,2}$/.test(c) && +c >= 1 && +c <= 13) return String(+c);
  return '';
}
// Both ends are needed: one end alone ("PK") would read as the whole span.
// "Ungraded" and "Adult education" are words, not points on the grade scale,
// so a span that reaches one is written out ("9 to adult education").
const WORD = new Set(['Ungraded', 'Adult education']);
export function spanOf(lo, hi) {
  if (!lo || !hi) return '';
  if (lo === hi) return lo;
  if (WORD.has(lo) || WORD.has(hi)) return `${lo} to ${hi.toLowerCase()}`;
  return `${lo}–${hi}`;
}
export const ccdSpan = (lo, hi) => spanOf(ccdGrade(lo), ccdGrade(hi));

// PSS LOGR2024 / HIGR2024 (codebook 2023-24): 1 all ungraded, 2 PK, 3 K,
// 4 transitional kindergarten, 5 transitional first grade, 6..17 = grades 1..12.
// TK is the usual US abbreviation; transitional first grade has none, so it is
// written out.
export function pssGrade(code) {
  const c = +code;
  if (c === 1) return 'Ungraded';
  if (c === 2) return 'PK';
  if (c === 3) return 'K';
  if (c === 4) return 'TK';
  if (c === 5) return 'transitional 1st';
  if (c >= 6 && c <= 17) return String(c - 5);
  return '';
}
export const pssSpan = (lo, hi) => spanOf(pssGrade(lo), pssGrade(hi));

// ── CCD directory (the state-rating join key) ───────────────────────────────
// NCES's ArcGIS layer has no ST_SCHID, and every US state rating file is keyed
// by the state's own school code, so each rating module joins through the CCD
// 029 directory. Rows in the tiles carry the NCES id (row.id = NCESSCH);
// this turns it into the state's ids:
//
//   import { ccdDirectory } from '../sources/_nces.mjs';
//   const dir = await ccdDirectory(ctx);          // ctx from tools/schools/ratings.mjs
//   const stId = dir.get(row.id)?.ST_SCHID;       // e.g. "TX-057905-057905001"
//
// ST_SCHID is "{ST}-{state LEA id}-{state school id}"; the last segment is the
// state's school code (TX 9-digit campus number, IL RCDTS, CA CDS, …). See
// DESIGN.md §1b for each state's verified key.
export const CCD_YEAR = '2024-25';
export const CCD_029 = { file: 'ccd_sch_029_2425.zip', url: 'https://nces.ed.gov/ccd/Data/zip/ccd_sch_029_2425_w_1a_073025.zip' };
export const CCD_129 = { file: 'ccd_sch_129_2425.zip', url: 'https://nces.ed.gov/ccd/Data/zip/ccd_sch_129_2425_w_1a_073025.zip' };
export const CCD_029_NEXT = { file: 'ccd_sch_029_2526_prelim.zip', url: 'https://nces.ed.gov/ccd/data/zip/ccd_sch_029_2526_w_0a_050626.zip', year: '2025-26' };
export const DIRECTORY_FIELDS = ['NCESSCH', 'ST', 'SCH_NAME', 'LEA_NAME', 'ST_LEAID', 'LEAID', 'ST_SCHID', 'SCHID', 'LSTATE', 'LCITY', 'LZIP',
  'SY_STATUS_TEXT', 'SCH_TYPE_TEXT', 'CHARTER_TEXT', 'CHARTAUTHN1', 'GSLO', 'GSHI', 'LEVEL'];

// Parse one CCD school file (a zip holding one CSV) into Map NCESSCH -> {fields}.
// Fails if a needed column is missing (an upstream layout change must never
// read as a column of blanks).
export function ccdTable(zipBuf, fields, what) {
  const { header, rows } = parseCsv(unzipEntry(zipBuf, /\.csv$/i), { encoding: 'latin1' });
  const col = columns(header, fields, what);
  const out = new Map();
  for (const r of rows) {
    if (r.length < 2) continue;
    const o = {};
    for (const f of fields) o[f] = (r[col[f]] ?? '').trim();
    out.set(o.NCESSCH, o);
  }
  return out;
}

export async function ccdDirectory(ctx, { maxAgeH = 24 * 30 } = {}) {
  const buf = await ctx.download(CCD_029.file, CCD_029.url, { maxAgeH });
  return ccdTable(buf, DIRECTORY_FIELDS, CCD_029.file);
}

// ── ZIP sanity ──────────────────────────────────────────────────────────────
// USPS allocates 3-digit ZIP prefixes by state. A ZIP whose prefix belongs to
// another state is a damaged value, not an address (PSS 2023-24 has a few
// Massachusetts schools whose ZIP lost its leading zero: "21841" for Braintree,
// 02184), so it is not shown. Only the states of the covered US cities are
// listed; a state missing here fails loudly rather than passing every ZIP.
const ZIP3 = {
  AZ: [[850, 865]], CA: [[900, 961]], CO: [[800, 816]], CT: [[60, 69]], DC: [[200, 200], [202, 205], [569, 569]],
  IL: [[600, 629]], LA: [[700, 714]], MA: [[10, 27], [55, 55]], MD: [[206, 219]], MI: [[480, 499]], MN: [[550, 567]],
  MO: [[630, 658]], NC: [[270, 289]], NV: [[889, 898]], NY: [[5, 5], [63, 63], [100, 149]], OH: [[430, 459]],
  PA: [[150, 196]], TN: [[370, 385]], TX: [[733, 733], [750, 799], [885, 885]], WA: [[980, 994]],
};
export function zipInState(zip, juris) {
  const ranges = ZIP3[String(juris).replace(/^US-/, '')];
  if (!ranges) throw new Error(`_nces.mjs: no ZIP prefixes listed for ${juris}`);
  if (!/^\d{5}$/.test(zip || '')) return false;
  const p = +zip.slice(0, 3);
  return ranges.some(([a, b]) => p >= a && p <= b);
}

// ── position reference (verify-schools) ─────────────────────────────────────
// NCES geocodes are published in WGS84 and used as-is, so there is no datum
// shift to get wrong; what can still go wrong is a swapped or mis-scaled
// coordinate, a join that attaches one school's point to another school, or
// an upstream re-geocode gone bad. The reference is independent of NCES: the
// Census Bureau's ZCTA Gazetteer, the internal point and area of each ZIP Code
// Tabulation Area. Distances are measured in ZIP RADII (the radius of a circle
// with the ZIP area's size), because ZIP areas are 1 km across in Manhattan
// and 10 km in suburban Charlotte: for points spread evenly over a disc the
// median is 0.71 radii. A broken join or a swapped axis puts schools tens or
// thousands of radii away. Public domain (U.S. Census Bureau).
export const ZCTA_URL = 'https://www2.census.gov/geo/docs/maps-data/data/gazetteer/2025_Gazetteer/2025_Gaz_zcta_national.zip';
let zctaCache = null;
export async function zctaPoints(url = ZCTA_URL) {
  if (zctaCache) return zctaCache;
  const res = await fetch(url, { signal: AbortSignal.timeout(120_000) });
  if (!res.ok) throw new Error(`Census ZCTA gazetteer HTTP ${res.status}`);
  const text = unzipEntry(Buffer.from(await res.arrayBuffer()), /\.txt$/i).toString('latin1');
  const sep = text.slice(0, text.indexOf('\n')).includes('|') ? '|' : '\t';
  const { header, rows } = parseCsv(text, { sep });
  const col = columns(header.map(h => h.trim()), ['GEOID', 'INTPTLAT', 'INTPTLONG', 'ALAND', 'AWATER'], 'ZCTA gazetteer');
  zctaCache = new Map(rows.filter(r => r.length > 4).map(r => [r[col.GEOID].trim(),
    { lat: +r[col.INTPTLAT], lng: +r[col.INTPTLONG], radius: Math.sqrt((+r[col.ALAND] + +r[col.AWATER]) / Math.PI) }]));
  return zctaCache;
}

// Per jurisdiction: the median school must lie within MEDIAN_RADII of its own
// ZIP area's internal point (measured 0.63–0.82 across the 20 states, 2024-25),
// at most FAR_SHARE may lie beyond FAR_RADII (and 2 km) — a PO-box or
// head-office ZIP can be far, a systematic error moves them all — and at least
// MIN_RESOLVED of the schools must have a ZIP the gazetteer knows, or the check
// could not see a problem.
export const MEDIAN_RADII = 1, FAR_RADII = 3, FAR_SHARE = 0.03, MIN_RESOLVED = 0.9;
export async function positionChecks(rows, { haversine, zcta }, what) {
  const z = zcta || await zctaPoints();     // zcta: injectable for tests
  const byJuris = new Map();
  for (const r of rows) if (!byJuris.has(r.juris)) byJuris.set(r.juris, { total: 0, list: [] });
  for (const r of rows) {
    const g = byJuris.get(r.juris);
    g.total++;
    const ref = z.get(String(r.postcode || '').slice(0, 5));
    if (!ref || !ref.radius) continue;
    const m = haversine(r.lat, r.lng, ref.lat, ref.lng);
    g.list.push({ name: r.name, m, n: m / ref.radius });
  }
  const checks = [];
  for (const [juris, { total, list }] of [...byJuris].sort()) {
    if (!list.length) { checks.push({ juris, check: 'position', pass: false, message: `${what}: none of ${total} schools has a ZIP in the Census gazetteer` }); continue; }
    list.sort((a, b) => a.n - b.n);
    const q = p => list[Math.min(list.length - 1, Math.floor(list.length * p))];
    const far = list.filter(x => x.n > FAR_RADII && x.m > 2000), worst = [...list].sort((a, b) => b.m - a.m)[0];
    const resolved = list.length / total;
    const pass = q(0.5).n <= MEDIAN_RADII && far.length <= Math.max(1, Math.floor(FAR_SHARE * list.length)) && resolved >= MIN_RESOLVED;
    checks.push({
      juris, check: 'position', reference: 'U.S. Census Bureau 2025 ZCTA Gazetteer (ZIP area internal points and areas)', pass,
      message: `${what}: ${list.length} of ${total} schools vs their own ZIP area: median ${q(0.5).n.toFixed(2)} ZIP radii (${(q(0.5).m / 1000).toFixed(1)} km), ` +
        `p95 ${q(0.95).n.toFixed(2)}; ${far.length} beyond ${FAR_RADII} radii; farthest ${(worst.m / 1000).toFixed(1)} km (${worst.name}); ` +
        `limits: median ≤ ${MEDIAN_RADII}, ≤ ${FAR_SHARE * 100}% beyond ${FAR_RADII}, ≥ ${MIN_RESOLVED * 100}% resolved`,
    });
  }
  return checks;
}
