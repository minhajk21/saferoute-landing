// Toronto: Ontario's publicly funded schools (public, Catholic, French-language
// and the one hospital school authority in the box), from the Ministry of
// Education's "School information and student demographics" (SIF) table.
//
// One row per school: the Ministry's 6-digit school number, name, board,
// level, grade range, language, enrolment (rounded by the Ministry to the
// nearest 5) and its own latitude/longitude. Scope is Toronto's crime-data
// rectangle limited to Ontario (R2): 1,000 schools in the 2024-25 final table.
//
// CADENCE: annual. The Ministry publishes one table per school year (a
// preliminary one, then a final one), under a new date-stamped file name, so
// the monthly build re-emits the current tiles and only PROBES the CKAN
// package for a newer table. Taking one is a deliberate `--refresh on-sif`.
//
// NOT CARRIED, on purpose:
//   - the EQAO test-result columns (Grade 3/6/9, OSSLT): test results, not an
//     official rating (owner decision: no EQAO in v1);
//   - the low-income, parental-education, special-education, gifted and
//     newcomer / first-language percentages (DESIGN.md §2a);
//   - addresses, phone numbers and websites: the pane links to the Ministry's
//     own School Finder page for the school instead (recordUrl, verified).
// School Type ("Public" / "Catholic") and the board name are GOVERNANCE — the
// board is the school's legal authority — so they are shown in the pane as
// text, never as a filter or a colour (owner decision).
//
// This file also exports the small helpers the other Canadian source modules
// share (a zero-dependency .xlsx reader, the CKAN resolver, postal-code and
// city formatting, the position check): Ontario publishes its school tables
// only as .xlsx, and the repo takes no npm dependencies. The integrator may
// promote readXlsx to tools/schools/lib/xlsx.mjs (DESIGN.md §6a).

import { inflateRawSync } from 'node:zlib';
import { columns } from '../lib/csv.mjs';
import { ontarioStage } from '../lib/stage.mjs';

// ── .xlsx, read with no dependencies ────────────────────────────────────────
// Enough of OOXML for the government tables this lane reads: the zip central
// directory (stored or deflated entries), the workbook's sheet list and
// relationships, shared strings (rich-text runs concatenated, phonetic runs
// skipped), inline strings, and cell references (so blank cells keep columns
// aligned). Values come back as the raw strings Excel stored: numbers as
// written ("46.534770000000002"), booleans "0"/"1", dates as serial numbers.

function unzip(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('not a zip file (no end-of-central-directory record)');
  const count = buf.readUInt16LE(eocd + 10);
  const files = new Map();
  let p = buf.readUInt32LE(eocd + 16);
  for (let k = 0; k < count; k++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('bad zip central directory');
    const nameLen = buf.readUInt16LE(p + 28), extraLen = buf.readUInt16LE(p + 30), commentLen = buf.readUInt16LE(p + 32);
    files.set(buf.toString('utf8', p + 46, p + 46 + nameLen), {
      method: buf.readUInt16LE(p + 10), csize: buf.readUInt32LE(p + 20), local: buf.readUInt32LE(p + 42),
    });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return name => {
    const f = files.get(name.replace(/^\//, ''));
    if (!f) return null;
    if (buf.readUInt32LE(f.local) !== 0x04034b50) throw new Error(`bad zip local header for ${name}`);
    const start = f.local + 30 + buf.readUInt16LE(f.local + 26) + buf.readUInt16LE(f.local + 28);
    const data = buf.subarray(start, start + f.csize);
    if (f.method === 0) return data;
    if (f.method === 8) return inflateRawSync(data);
    throw new Error(`zip compression method ${f.method} is not supported (${name})`);
  };
}

const XML_ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const unxml = s => s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e) =>
  (e[0] === '#' ? String.fromCodePoint(/^#x/i.test(e) ? parseInt(e.slice(2), 16) : +e.slice(1)) : XML_ENT[e] ?? m));
const xmlAttr = (s, name) => { const m = new RegExp(`(?:^|\\s)${name}="([^"]*)"`).exec(s); return m ? unxml(m[1]) : null; };
const xmlText = xml => [...xml.replace(/<rPh\b[\s\S]*?<\/rPh>/g, '').matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map(m => unxml(m[1])).join('');
const colIndex = ref => { let n = 0; for (const c of /^[A-Z]+/.exec(ref)[0]) n = n * 26 + c.charCodeAt(0) - 64; return n - 1; };

// readXlsx(buf) -> { sheets: [names], rows(name?) -> string[][] } (first sheet by default)
export function readXlsx(buf) {
  const get = unzip(buf);
  const str = name => { const b = get(name); return b ? b.toString('utf8') : null; };
  const wb = str('xl/workbook.xml');
  if (!wb) throw new Error('not an .xlsx workbook (no xl/workbook.xml)');
  const target = {};
  for (const m of (str('xl/_rels/workbook.xml.rels') || '').matchAll(/<Relationship\b([^>]*?)\/?>/g)) target[xmlAttr(m[1], 'Id')] = xmlAttr(m[1], 'Target');
  const shared = [];
  for (const m of (str('xl/sharedStrings.xml') || '').matchAll(/<si\b[^>]*?(?:\/>|>([\s\S]*?)<\/si>)/g)) shared.push(m[1] ? xmlText(m[1]) : '');
  const sheets = [...wb.matchAll(/<sheet\b([^>]*?)\/?>/g)].map(m => {
    const t = target[xmlAttr(m[1], 'r:id')] || '';
    return { name: xmlAttr(m[1], 'name'), path: t.startsWith('/') ? t.slice(1) : `xl/${t.replace(/^\.\//, '')}` };
  });
  function rows(name) {
    const sh = name == null ? sheets[0] : sheets.find(s => s.name === name);
    if (!sh) throw new Error(`no sheet "${name}" (the workbook has ${sheets.map(s => `"${s.name}"`).join(', ')})`);
    const xml = str(sh.path);
    if (xml == null) throw new Error(`sheet "${sh.name}" is missing from the workbook (${sh.path})`);
    const out = [];
    for (const rm of xml.matchAll(/<row\b[^>]*?(?:\/>|>([\s\S]*?)<\/row>)/g)) {
      const row = [];
      for (const cm of (rm[1] || '').matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const ref = xmlAttr(cm[1], 'r'), t = xmlAttr(cm[1], 't'), body = cm[2] || '';
        let v;
        if (t === 'inlineStr') v = xmlText(body);
        else {
          const vm = /<v>([\s\S]*?)<\/v>/.exec(body);
          v = vm ? unxml(vm[1]) : '';
          if (t === 's') v = shared[+v] ?? '';
        }
        const i = ref ? colIndex(ref) : row.length;
        while (row.length < i) row.push('');
        row[i] = v;
      }
      out.push(row);
    }
    return out;
  }
  return { sheets: sheets.map(s => s.name), rows };
}

// Rows of a sheet as objects keyed by the header row, after checking that
// every needed column is there (a renamed column fails loudly, never reads
// '' for every school).
export function sheetRecords(rows, need, what) {
  const header = (rows[0] || []).map(h => String(h).trim());
  const col = columns(header, need, what);
  return rows.slice(1).filter(r => r.some(v => v !== '')).map(r => {
    const o = {};
    for (const [k, i] of Object.entries(col)) o[k] = String(r[i] ?? '').trim();
    return o;
  });
}

// Excel serial day -> ISO date (1900 date system; serials here are all > 60).
export const excelDate = serial => (/^\d+(\.\d+)?$/.test(serial) ? new Date(Math.round((+serial - 25569) * 864e5)).toISOString().slice(0, 10) : '');

// ── shared helpers for the Canadian sources ────────────────────────────────
// CKAN package_show -> resources. Both provinces publish date-stamped file
// names under stable dataset ids, so the build resolves the current file each
// time it has to fetch (never a hard-coded file name).
export async function ckanResources(host, id) {
  const res = await fetch(`${host}/api/3/action/package_show?id=${encodeURIComponent(id)}`, { signal: AbortSignal.timeout(60_000) });
  if (!res.ok) throw new Error(`${host} package_show ${id}: HTTP ${res.status}`);
  const j = await res.json();
  if (!j.success || !Array.isArray(j.result?.resources)) throw new Error(`${host} package_show ${id}: no resources`);
  return j.result.resources;
}

// "M6A3M7" -> "M6A 3M7" (Canada Post's own written form); anything else as published.
export const fmtPostal = v => { const m = /^([A-Z]\d[A-Z])\s*(\d[A-Z]\d)$/i.exec(String(v || '').trim()); return m ? `${m[1]} ${m[2]}`.toUpperCase() : String(v || '').trim(); };
// A few city fields are typed in capitals ("TORONTO", "NORTH YORK"); shown in
// title case. Mixed-case values are left exactly as published.
export const cityName = v => { const s = String(v || '').trim(); return s && s === s.toUpperCase() && /[A-Z]/.test(s) ? s.toLowerCase().replace(/(^|[\s'-])([a-z])/g, (_, p, c) => p + c.toUpperCase()) : s; };
const decimals = v => { const m = /\.(\d+)$/.exec(String(+(+v).toFixed(7))); return m ? m[1].length : 0; };
// A point given to 2 decimal places on BOTH axes (43.65, -79.42) is a ~1 km
// cell, not a building: counted and held back ("never guessed onto a
// centroid"), like the CDMX rule. One short axis alone is a real coordinate
// that happens to end in zeros (-79.44000).
export const coarsePoint = (lat, lng) => decimals(lat) < 3 && decimals(lng) < 3;
export const r5 = x => +(+x).toFixed(5);
// "JK-8" -> "JK–8" (the en dash every other span on the map uses)
export const spanOf = v => String(v || '').trim().replace(/\s*-\s*/, '–');

// Position reference for verify: match school names to an independent layer
// and report the median distance. Names are normalised (accents, "St."/"Saint",
// generic words) so "St Thomas More Catholic School" meets "ST THOMAS MORE".
export const normName = s => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
  .replace(/&/g, ' and ').replace(/\bsaint\b|\bst\.?(?=\s)/g, 'st ')
  .replace(/\b(elementary|elem|secondary|sec|public|catholic|separate|junior|senior|middle|school|collegiate|institute|ci|ps|cs|ss|jr|sr|the|of|and|ecole|e)\b/g, ' ')
  .replace(/[^a-z0-9]/g, '');

export function positionCheck(rows, ref, { haversine, juris, reference, limitM = 50, minMatched = 50 }) {
  const byName = new Map();
  for (const p of ref) { const k = normName(p.name); if (k) (byName.get(k) || byName.set(k, []).get(k)).push(p); }
  const off = [];
  for (const r of rows) {
    const cands = byName.get(normName(r.name));
    if (!cands) continue;
    off.push({ name: r.name, m: Math.min(...cands.map(c => haversine(r.lat, r.lng, c.lat, c.lng))) });
  }
  off.sort((a, b) => a.m - b.m);
  if (off.length < minMatched) return { juris, check: 'position', reference, pass: false, message: `only ${off.length} of ${rows.length} schools matched the reference by name — too few to conclude anything` };
  const median = off[Math.floor(off.length / 2)].m, p90 = off[Math.floor(off.length * 0.9)].m;
  return {
    juris, check: 'position', reference, pass: median <= limitM,
    message: `${off.length} of ${rows.length} schools matched by name: median ${median.toFixed(0)} m, p90 ${p90.toFixed(0)} m; limit median ${limitM} m` +
      ' (name matches include moved schools and namesakes, so only the median is judged)',
  };
}

// City of Toronto "School Locations – All Types" (the City's own address
// points; its CKAN record states no licence, so it is used ONLY as an internal
// build check and nothing from it is ever published). Measured in research:
// median 11 m against SIF.
const TORONTO_OPEN_DATA = 'https://ckan0.cf.opendata.inter.prod-toronto.ca';
export async function torontoSchoolLayer() {
  const res = (await ckanResources(TORONTO_OPEN_DATA, 'school-locations-all-types'))
    .find(r => /geojson/i.test(r.format || '') && /4326/.test(r.name || r.url || ''));
  if (!res) throw new Error('City of Toronto school layer: no 4326 GeoJSON resource');
  const r = await fetch(res.url, { signal: AbortSignal.timeout(120_000) });
  if (!r.ok) throw new Error(`City of Toronto school layer: HTTP ${r.status}`);
  const g = await r.json();
  return g.features.map(f => {
    const c = f.geometry?.type === 'MultiPoint' ? f.geometry.coordinates[0] : f.geometry?.coordinates;
    return c && { name: f.properties.NAME, kind: f.properties.SCHOOL_TYPE_DESC, lat: c[1], lng: c[0] };
  }).filter(Boolean);
}

// ── the published point against the published address ──────────────────────
// A few Ministry records contradict themselves: the latitude/longitude is
// nowhere near the postal code of the address in the same record (a Trenton
// school drawn in North York, a Burlington school in Lake Ontario, a Surrey
// school in downtown Vancouver). We cannot tell which half is wrong, so such a
// school is counted and NOT drawn — a pin claims "the school is here".
//
// The yardstick is the province's own public-school list: the distance from a
// school's point to the nearest public school in the same postal district
// (FSA, the first three characters of the postal code). Two rules, measured
// on the Toronto and Vancouver boxes (Sept 2026; median distance 0.5 km, 99th
// percentile 9.9 km):
//   FAR_M      more than 25 km from every public school of its own postal
//              district: the point and the address are in different places
//              altogether (9 schools: 8 Toronto private, 1 Vancouver independent).
//   CLUSTER    a point shared by 3 or more schools from 2 or more postal
//              districts is a geocoder fallback, not a building; a school on it
//              more than 5 km from its own district is held back (4 more).
// A school with no postal code, or whose district has no public school to
// compare with, is left alone (no evidence either way).
export const FAR_M = 25_000, CLUSTER_MIN = 3, CLUSTER_M = 5_000;
export const fsaOf = pc => { const s = String(pc || '').replace(/\s+/g, '').toUpperCase(); return /^[A-Z]\d[A-Z]/.test(s) ? s.slice(0, 3) : ''; };
const metres = (a, b, c, d) => {
  const R = 6371008.8, k = Math.PI / 180, dp = (c - a) * k, dl = (d - b) * k;
  const h = Math.sin(dp / 2) ** 2 + Math.cos(a * k) * Math.cos(c * k) * Math.sin(dl / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
};
// ref: [{ id, postcode, lat, lng }] — every located public school in the province.
export function locationDoubts(rows, ref) {
  const byFsa = new Map();
  for (const p of ref) { const f = fsaOf(p.postcode); if (f && p.lat && p.lng) (byFsa.get(f) || byFsa.set(f, []).get(f)).push(p); }
  const byPoint = new Map();
  for (const r of rows) { const k = `${r.lat},${r.lng}`; (byPoint.get(k) || byPoint.set(k, []).get(k)).push(r); }
  const out = new Map();
  for (const r of rows) {
    const cands = (byFsa.get(fsaOf(r.postcode)) || []).filter(p => p.id !== r.id);
    if (!cands.length) continue;
    const d = Math.min(...cands.map(p => metres(r.lat, r.lng, p.lat, p.lng)));
    const same = byPoint.get(`${r.lat},${r.lng}`);
    if (d > FAR_M) out.set(r, { reason: 'unmapped.pointConflictsWithAddress', km: +(d / 1000).toFixed(1) });
    else if (d > CLUSTER_M && same.length >= CLUSTER_MIN && new Set(same.map(x => fsaOf(x.postcode))).size >= 2) {
      out.set(r, { reason: 'unmapped.sharedPlaceholderPoint', km: +(d / 1000).toFixed(1), shared: same.length });
    }
  }
  return out;
}

// The address cities of the City of Toronto (the amalgamated city and its
// former municipalities, as the SIF "City" field writes them). A school with
// no published location is counted as unmapped only when its address is in
// one of these, since only then do we know it belongs to the Toronto view.
export const TORONTO_CITIES = new Set(['toronto', 'scarborough', 'north york', 'etobicoke', 'east york', 'york', 'agincourt', 'west hill', 'weston']);

// ── the SIF table ───────────────────────────────────────────────────────────
const ON_DATA = 'https://data.ontario.ca';
const SIF_PACKAGE = 'school-information-and-student-demographics';

// The newest English SIF table: the school year is in the file name
// ("sif_data_table_2022_2023_en", "new_sif_data_2024_25_final_en_july2026");
// a final table beats a preliminary one of the same year.
export async function sifResource() {
  const list = (await ckanResources(ON_DATA, SIF_PACKAGE))
    .filter(r => /xlsx/i.test(r.format || '') && /sif/i.test(r.url || '') && (/english/i.test(r.language || '') || /_en[_.]/i.test(r.url)))
    .map(r => { const m = /(20\d\d)_(?:20)?(\d\d)/.exec(r.url); return m && { url: r.url, year: +m[1], final: !/prelim/i.test(r.url), modified: r.last_modified }; })
    .filter(Boolean)
    .sort((a, b) => b.year - a.year || b.final - a.final);
  if (!list.length) throw new Error(`${SIF_PACKAGE}: no English .xlsx table among the package's resources`);
  return list[0];
}
const yearLabel = y => `${y}-${String((y + 1) % 100).padStart(2, '0')}`;

const SIF_COLUMNS = ['Board Name', 'School Number', 'School Name', 'School Type', 'School Special Condition Code', 'School Level',
  'School Language', 'Grade Range', 'City', 'Province', 'Postal Code', 'Enrolment', 'Latitude', 'Longitude', 'Extract Date'];

// Special-condition codes that are not a school building a family attends.
const NOT_A_SITE = { 'Online School': 'dropped.onlineSchool', 'Continuing Education': 'dropped.continuingEducation' };

// Download and parse the current SIF table. Also used by on-priv, whose
// address check needs every located Ontario public school (sifPoints).
export async function loadSif(ctx) {
  let picked = null;
  const buf = await ctx.download('sif-en.xlsx', async () => (picked = await sifResource()).url, { maxAgeH: 24 * 7 });
  const book = readXlsx(buf);
  const sheet = book.sheets.find(s => /sif/i.test(s)) || book.sheets[0];
  const recs = sheetRecords(book.rows(sheet), SIF_COLUMNS, `SIF sheet "${sheet}"`);
  // The table's own school year, from the sheet name ("SIF_Final_24-25_EN"),
  // else from the file name the resolver picked.
  const sy = /(\d{2})-(\d{2})/.exec(sheet);
  const year = sy ? `20${sy[1]}-${sy[2]}` : picked ? yearLabel(picked.year) : '';
  if (!year) throw new Error(`cannot tell the school year of SIF sheet "${sheet}"`);
  const final = /final/i.test(sheet) ? true : /prelim/i.test(sheet) ? false : picked ? picked.final : null;
  const extract = excelDate(recs.find(r => r['Extract Date'])?.['Extract Date'] || '') || '';
  return { recs, sheet, year, final, extract };
}
const sifId = v => (/^\d{1,5}$/.test(v) ? v.padStart(6, '0') : v);   // a numeric cell loses its leading zero
export const sifPoints = recs => recs.map(r => ({ id: sifId(r['School Number']), postcode: r['Postal Code'], lat: parseFloat(r.Latitude), lng: parseFloat(r.Longitude) }))
  .filter(p => Number.isFinite(p.lat) && Number.isFinite(p.lng) && p.lat && p.lng);

async function fetchRows(ctx) {
  const { recs, year, final, extract } = await loadSif(ctx);
  const out = [];
  for (const r of recs) {
    if (r.Province !== 'Ontario') { ctx.stat('dropped.notOntario'); continue; }
    const cond = r['School Special Condition Code'];
    if (NOT_A_SITE[cond]) { ctx.stat(NOT_A_SITE[cond]); continue; }
    const lat = parseFloat(r.Latitude), lng = parseFloat(r.Longitude);
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || !lat || !lng) {
      ctx.stat(TORONTO_CITIES.has(r.City.toLowerCase()) ? 'unmapped.noCoordinates' : 'dropped.noCoordinatesOutsideToronto');
      continue;
    }
    if (!ctx.coverage.regionFor(lat, lng, 'CA-ON')) { ctx.stat('dropped.outsideScope'); continue; }
    if (coarsePoint(r.Latitude, r.Longitude)) { ctx.stat('unmapped.coarseLocation'); continue; }

    const id = sifId(r['School Number']);
    const level = r['School Level'];
    // "SP" (suppressed) and "NA" are published instead of a number for some
    // schools: no enrolment is shown for them.
    const enrol = /^\d+$/.test(r.Enrolment) ? +r.Enrolment : null;
    if (enrol == null) ctx.stat(`noEnrolment.${r.Enrolment || 'blank'}`);
    out.push({
      src: 'on-sif', id, name: r['School Name'], postcode: fmtPostal(r['Postal Code']),
      lat: r5(lat), lng: r5(lng), juris: 'CA-ON',
      // "Public · English", "Catholic · French", "Public · English · Alternative"
      type: [r['School Type'], r['School Language'], cond && cond !== 'Not applicable' ? cond : ''].filter(Boolean).join(' · '),
      sector: 'state', stage: ontarioStage(level), phase: level, boarding: false,
      span: spanOf(r['Grade Range']),
      pupils: enrol, pupilsAsOf: year,
      la: r['Board Name'], area: cityName(r.City),
      ratingScheme: 'ca-on-none',
    });
    if (!ontarioStage(level)) ctx.stat(`stageNotPublished.${level || 'blank'}`);
  }
  // No SIF school fails the address check today (the largest gap is 14 km, a
  // school housed in another school's building); it runs so one never slips in.
  const doubts = locationDoubts(out, sifPoints(recs));
  for (const [r, d] of doubts) { ctx.stat(d.reason); ctx.log(`     held back ${r.id} ${r.name}: ${d.reason} (${d.km} km)`); }
  ctx.vintage(`${year}${final == null ? '' : final ? ' final' : ' preliminary'} table${extract ? ` (Ministry extract ${extract})` : ''}`);
  return out.filter(r => !doubts.has(r));
}

// Annual: does the CKAN package now carry a newer table than the one in the tiles?
async function probe(ctx) {
  const r = await sifResource();
  const prevUrl = (ctx.prev?.upstream || []).find(u => u.file === 'sif-en.xlsx')?.url || null;
  return { vintage: `${yearLabel(r.year)}${r.final ? ' final' : ' preliminary'} (${r.url.split('/').pop()})`, changed: !!prevUrl && prevUrl !== r.url };
}

async function verify(rows, { haversine }) {
  const ref = (await torontoSchoolLayer()).filter(p => !/private|university|college/i.test(p.kind || ''));
  return [positionCheck(rows.filter(r => r.juris === 'CA-ON'), ref, {
    haversine, juris: 'CA-ON', minMatched: 300,
    reference: 'City of Toronto "School Locations – All Types" (public and separate schools; internal check only, not published)',
  })];
}

const OGL_ON = 'Open Government Licence – Ontario';

export default {
  id: 'on-sif',
  juris: ['CA-ON'],
  cadence: 'annual',
  meta: {
    name: 'School information and student demographics (Ontario Ministry of Education)',
    publisher: 'Ontario Ministry of Education',
    licence: OGL_ON,
    licenceUrl: 'https://www.ontario.ca/page/open-government-licence-ontario',
    // {pupilsAsOf} is the table's school year, carried on every row.
    attribution: `Ontario school number {id} · Ontario Ministry of Education, School information and student demographics {pupilsAsOf}. Contains information licensed under the ${OGL_ON}.`,
    // The Ministry's own per-school page ("<name> | School Finder | ontario.ca").
    // Verified Sept 2026 for all 1,000 Toronto schools: HTTP 200 and its <h1>
    // is the school's name. (It also shows EQAO results — on the Ministry's
    // page, not on the map.) Private schools have no page there (404).
    recordUrl: 'https://www.ontario.ca/locations/schools/{id}/',
    recordLabel: 'Ontario School Finder page',
    where: 'Toronto public and Catholic schools',
    publishes: [],
    labels: {
      type: 'Type · language', phase: 'Level', span: 'Grades', pupils: 'Enrolment', la: 'School board',
      pupilsAsOf: 'Enrolment in the {date} school year, rounded by the Ministry to the nearest 5.',
    },
  },
  schemes: {
    'ca-on-none': {
      kind: 'none',
      notes: [{ html: '<b>Ontario publishes no single school rating</b> or inspection grade for its publicly funded schools. Its testing agency, EQAO, publishes provincial test results separately; they are not a rating and are not shown here.' }],
    },
  },
  fetch: fetchRows,
  probe,
  verify,
};
