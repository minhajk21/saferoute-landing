// Vancouver: British Columbia's public and independent K-12 schools, from the
// Ministry of Education and Child Care's "BC Schools K-12 with Francophone
// Indicators" list (MINCODE, level, public/independent, facility type, French
// programmes, design capacity for public schools, and the Ministry's own
// latitude/longitude), joined by MINCODE to its "Student Enrolment and FTE by
// Grade" extract for each school's enrolment and the grades it enrols.
//
// NOT the openmaps WFS layer of the same data: its SCHOOL_NUMBER is broken and
// it failed 9 of 9 attempts in verification (DESIGN.md §1a).
//
// SCHOOLS WITH NO PUBLISHED LOCATION are counted and not drawn. Eight
// Vancouver-addressed schools have no latitude/longitude in the list. They are
// NOT geocoded: the BC Geocoder's terms for republishing its results were not
// checked (owner decision), and a guessed point is never drawn.
//
// CADENCE: monthly (the list is ~400 KB and changes as schools open and
// close). The enrolment extract is annual; its school year is PINNED to the
// one already in the tiles, so a new September count changes the published
// numbers only in a deliberate `--refresh bc` run (the build warns when one
// is out). The extract is ~21 MB, which a monthly job fetches without trouble.
//
// Dropped (not a school building a family attends): provincial and district
// online-learning schools, continuing-education (adult) schools, and youth
// custody / residential attendance programs. Alternate-program and long-term
// Provincial Resource Program schools stay. Held back and counted: a point
// that contradicts the postal code of the school's own address (on-sif.mjs
// locationDoubts; 1 school in Sept 2026). The list's level is corrected only
// where the Ministry's own enrolment count contradicts it completely (levelOf
// below; 9 Vancouver secondary schools listed as "Elementary").
//
// NOT CARRIED: Foundation Skills Assessment and graduation-rate results (test
// results, not an official rating, and 97% of Vancouver's FSA rows mask the
// proficiency split — DESIGN.md §2a); addresses; Indigenous, ELL and
// disability enrolment breakdowns.

import { records } from '../lib/csv.mjs';
import { bcStage } from '../lib/stage.mjs';
// Helpers shared by the Canadian sources live in on-sif.mjs (same lane): the
// postal-code format, the 2-dp "coarse point" rule, the address check and the
// name-matched position check.
import { fmtPostal, coarsePoint, r5, locationDoubts, normName } from './on-sif.mjs';

const BC_DATA = 'https://catalogue.data.gov.bc.ca';
const SCHOOLS_PACKAGE = 'bc-schools-k-12-with-francophone-indicators';
const ENROL_PACKAGE = 'bc-schools-student-enrolment-and-fte-by-grade';

async function ckanResources(id) {
  const res = await fetch(`${BC_DATA}/api/3/action/package_show?id=${id}`, { signal: AbortSignal.timeout(60_000) });
  if (!res.ok) throw new Error(`${id}: package_show HTTP ${res.status}`);
  const j = await res.json();
  if (!j.success || !Array.isArray(j.result?.resources)) throw new Error(`${id}: package_show returned no resources`);
  return j.result.resources;
}
async function schoolsUrl() {
  const r = (await ckanResources(SCHOOLS_PACKAGE)).find(x => /csv/i.test(x.format || '') && /k12_schools/i.test(x.url || ''));
  if (!r) throw new Error(`${SCHOOLS_PACKAGE}: no K-12 schools CSV resource`);
  return r.url;
}
// The extract covering the most recent years ("…_2020-21_to_2025_26.csv").
async function enrolUrl() {
  const list = (await ckanResources(ENROL_PACKAGE))
    .filter(x => /csv/i.test(x.format || ''))
    .map(x => { const m = /to_(\d{4})[_-](\d{2})\.csv$/i.exec(x.url || ''); return m && { url: x.url, end: +m[1] }; })
    .filter(Boolean).sort((a, b) => b.end - a.end);
  if (!list.length) throw new Error(`${ENROL_PACKAGE}: no enrolment CSV resource`);
  return list[0].url;
}

const decodeOf = buf => (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf ? 'utf-8' : 'windows-1252');
const need = (rows, cols, what) => {
  const miss = cols.filter(c => !(c in (rows[0] || {})));
  if (!rows.length || miss.length) throw new Error(`${what} is missing column(s) ${miss.map(m => `"${m}"`).join(', ') || '(no rows)'} — the schema changed; refusing to publish a partial build`);
};
// "2025/2026" -> "2025/26"
const shortYear = y => (/^\d{4}\/\d{4}$/.test(y) ? `${y.slice(0, 5)}${y.slice(7)}` : y);

const NOT_A_SITE = {
  'Provincial Online Learning School': 'dropped.onlineLearning',
  'District Online Learning School': 'dropped.onlineLearning',
  'Continuing Education School': 'dropped.continuingEducation',
  'Youth Custody Or Residential Attendance School': 'dropped.youthCustody',
};

// THE LIST'S LEVEL IS WRONG FOR SOME SECONDARY SCHOOLS. In the 2025/26 list,
// 88 schools province-wide (9 in the Vancouver box: Kitsilano, King George,
// Gladstone, Churchill, Van Tech, David Thompson, Prince of Wales Secondary,
// St Regis…) have SCHOOL_EDUCATION_LEVEL "Elementary" but enrol only grades
// 8–12 in the Ministry's own enrolment count, which defines "All Secondary" as
// grades 8–12 and "All Elementary" as K–7. A pin coloured Primary for
// Kitsilano Secondary would be false, so when the two Ministry sources
// contradict each other COMPLETELY (no enrolled grade on the list level's
// side of the grade 7/8 line), the enrolment count's grouping wins and the
// pane's Level says so in the Ministry's word. Partial overlaps (a K–8
// "Elementary", a 7–12 "Elementary-Secondary") are left exactly as published.
// Counted as levelFromEnrolment.* in the source stats.
const K7_LEVELS = new Set(['Elementary']);
const SEC_ONLY_LEVELS = new Set(['Secondary', 'Junior Secondary', 'Senior Secondary']);
export function levelOf(listLevel, e) {
  if (e?.lo != null && K7_LEVELS.has(listLevel) && e.lo >= 8) return { level: 'Secondary', fixed: 'elementaryButGrades8to12' };
  if (e?.hi != null && SEC_ONLY_LEVELS.has(listLevel) && e.hi <= 7) return { level: 'Elementary', fixed: 'secondaryButGradesKto7' };
  return { level: listLevel, fixed: null };
}

// Grades a school enrols, from its per-grade rows: kindergarten (full- or
// half-time) is "K"; ungraded, graduated-adult and roll-up rows are not grades.
const GRADE_ORDER = { KH: 0, KF: 0, '01': 1, '02': 2, '03': 3, '04': 4, '05': 5, '06': 6, '07': 7, '08': 8, '09': 9, '10': 10, '11': 11, '12': 12 };
const gradeName = g => (g === 0 ? 'K' : String(g));

export function enrolmentBySchool(rows, year) {
  const out = new Map();
  for (const r of rows) {
    if (r.SCHOOL_YEAR !== year || r.DATA_LEVEL !== 'School Level') continue;
    const e = out.get(r.SCHOOL_NUMBER) || out.set(r.SCHOOL_NUMBER, { total: null, masked: false, lo: null, hi: null }).get(r.SCHOOL_NUMBER);
    if (r.GRADE === 'All Grades') {
      if (/^\d+$/.test(r.TOTAL_ENROLMENT)) e.total = +r.TOTAL_ENROLMENT;
      else if (r.TOTAL_ENROLMENT === 'Msk') e.masked = true;
    }
    const g = GRADE_ORDER[r.GRADE];
    if (g != null && r.TOTAL_ENROLMENT && r.TOTAL_ENROLMENT !== '0') {
      e.lo = e.lo == null ? g : Math.min(e.lo, g);
      e.hi = e.hi == null ? g : Math.max(e.hi, g);
    }
  }
  for (const e of out.values()) e.span = e.lo == null ? '' : e.lo === e.hi ? gradeName(e.lo) : `${gradeName(e.lo)}–${gradeName(e.hi)}`;
  return out;
}

async function fetchRows(ctx) {
  const sbuf = await ctx.download('bc-k12-schools.csv', schoolsUrl, { maxAgeH: 12 });
  const schools = records(sbuf, { encoding: decodeOf(sbuf) });
  need(schools, ['SCHOOL_YEAR', 'MINCODE', 'SCHOOL_NAME', 'DISTRICT_NAME', 'PUBLIC_OR_INDEPENDENT', 'PHYSICAL_ADDRESS_CITY',
    'ADDRESS_POSTAL_CODE', 'FACILITY_TYPE', 'SCHOOL_EDUCATION_LEVEL', 'HAS_EARLY_FRENCH_IMMERSION', 'HAS_LATE_FRENCH_IMMERSION',
    'HAS_PROG_FRANCOPHONE', 'LATITUDE', 'LONGITUDE', 'DESIGN_CAPACITY_TOTAL'], 'BC K-12 schools list');
  const listYear = schools.map(r => r.SCHOOL_YEAR).filter(Boolean).sort().pop();

  const ebuf = await ctx.download('bc-enrolment-by-grade.csv', enrolUrl, { maxAgeH: 24 * 7, timeoutMs: 300_000 });
  const erows = records(ebuf, { encoding: decodeOf(ebuf) });
  need(erows, ['SCHOOL_YEAR', 'DATA_LEVEL', 'SCHOOL_NUMBER', 'GRADE', 'TOTAL_ENROLMENT'], 'BC enrolment extract');
  // Pin the enrolment year to the one already published, unless refreshing.
  const years = [...new Set(erows.map(r => r.SCHOOL_YEAR).filter(y => /^\d{4}\/\d{4}$/.test(y)))].sort();
  const newest = years[years.length - 1];
  const published = ctx.refresh ? null : (ctx.snapshot.find(r => r.pupilsAsOf)?.pupilsAsOf || null);   // "2025/26"
  let year = newest;
  if (published) {
    const match = years.find(y => shortYear(y) === published);
    if (match) year = match;
    else ctx.warn(`the published enrolment year ${published} is no longer in the extract; using ${shortYear(newest)}`);
    if (match && match !== newest) ctx.warn(`enrolment ${shortYear(newest)} is published; take it deliberately with --refresh bc`);
  }
  const enrol = enrolmentBySchool(erows, year);

  const out = [];
  for (const r of schools) {
    if (r.SCHOOL_YEAR !== listYear) { ctx.stat('dropped.olderSchoolYear'); continue; }
    if (NOT_A_SITE[r.FACILITY_TYPE]) { ctx.stat(NOT_A_SITE[r.FACILITY_TYPE]); continue; }
    const lat = parseFloat(r.LATITUDE), lng = parseFloat(r.LONGITUDE);
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || !lat || !lng) {
      // Counted as not drawn only when the address says Vancouver: then we
      // know it belongs in this view. Never geocoded (see the header).
      ctx.stat(r.PHYSICAL_ADDRESS_CITY === 'Vancouver' ? 'unmapped.noCoordinates' : 'dropped.noCoordinatesOutsideVancouver');
      continue;
    }
    if (!ctx.coverage.regionFor(lat, lng, 'CA-BC')) { ctx.stat('dropped.outsideScope'); continue; }
    if (coarsePoint(r.LATITUDE, r.LONGITUDE)) { ctx.stat('unmapped.coarseLocation'); continue; }

    const pub = /public/i.test(r.PUBLIC_OR_INDEPENDENT);
    const e = enrol.get(r.MINCODE);
    const cap = /^\d+$/.test(r.DESIGN_CAPACITY_TOTAL) && +r.DESIGN_CAPACITY_TOTAL > 0 ? +r.DESIGN_CAPACITY_TOTAL : null;
    const { level, fixed } = levelOf(r.SCHOOL_EDUCATION_LEVEL, e);
    if (fixed) ctx.stat(`levelFromEnrolment.${fixed}`);
    out.push({
      src: 'bc', id: r.MINCODE, name: r.SCHOOL_NAME, postcode: fmtPostal(r.ADDRESS_POSTAL_CODE),
      lat: r5(lat), lng: r5(lng), juris: 'CA-BC',
      // "Public School", "Independent School · Alternate Programs School"
      type: [r.PUBLIC_OR_INDEPENDENT, r.FACILITY_TYPE !== 'Standard School' ? r.FACILITY_TYPE : ''].filter(Boolean).join(' · '),
      sector: pub ? 'state' : 'private', stage: bcStage(level), phase: level, boarding: false,
      tags: [r.HAS_EARLY_FRENCH_IMMERSION === 'YES' || r.HAS_LATE_FRENCH_IMMERSION === 'YES' ? 'french-immersion' : '',
        r.HAS_PROG_FRANCOPHONE === 'YES' ? 'francophone' : ''].filter(Boolean).join(' '),
      span: e?.span || '', pupils: e?.total ?? null, pupilsAsOf: e ? shortYear(year) : '',
      capacity: pub ? cap : null,
      // DISTRICT_NAME is the school's own authority only for PUBLIC schools; for
      // an independent school it is just the district it sits in, so not shown.
      la: pub ? r.DISTRICT_NAME : '',
      area: r.PHYSICAL_ADDRESS_CITY,
      ratingScheme: 'ca-bc-none',
    });
    if (!bcStage(level)) ctx.stat(`stageNotPublished.${level || 'blank'}`);
  }
  // The published point against the published address (on-sif.mjs
  // locationDoubts), measured against every located BC public school. Today
  // this holds back one independent school: its address is in South Surrey
  // (V3Z) but its point is in downtown Vancouver, 34 km away.
  const ref = schools.filter(r => /public/i.test(r.PUBLIC_OR_INDEPENDENT) && r.SCHOOL_YEAR === listYear)
    .map(r => ({ id: r.MINCODE, postcode: r.ADDRESS_POSTAL_CODE, lat: parseFloat(r.LATITUDE), lng: parseFloat(r.LONGITUDE) }))
    .filter(p => Number.isFinite(p.lat) && Number.isFinite(p.lng));
  const doubts = locationDoubts(out, ref);
  for (const [r, d] of doubts) { ctx.stat(d.reason); ctx.log(`     held back ${r.id} ${r.name}: ${d.reason} (${d.km} km from its postal district)`); }
  ctx.vintage(`K-12 schools list ${shortYear(listYear)}; enrolment ${shortYear(year)} (September count)`);
  const kept = out.filter(r => !doubts.has(r));
  for (const r of kept) {
    const e = enrol.get(r.id);
    if (!e) ctx.stat('enrolment.notInExtract');
    else if (e.total == null) ctx.stat(e.masked ? 'enrolment.maskedUnder10' : 'enrolment.notPublished');
  }
  return kept;
}

// Position reference: the City of Vancouver's "Schools" open data (its own
// address points; Open Government Licence – Vancouver). Used only as an
// internal check, never published. Measured Sept 2026: median 30 m, 135 of
// 171 matched by name.

async function verify(rows, { haversine }) {
  const res = await fetch('https://opendata.vancouver.ca/api/explore/v2.1/catalog/datasets/schools/exports/json', { signal: AbortSignal.timeout(60_000) });
  if (!res.ok) throw new Error(`City of Vancouver schools: HTTP ${res.status}`);
  const byName = new Map();
  for (const p of await res.json()) {
    if (!/public|independent/i.test(p.school_category || '') || !p.geo_point_2d) continue;
    const k = normName(p.school_name);
    if (k) (byName.get(k) || byName.set(k, []).get(k)).push({ lat: p.geo_point_2d.lat, lng: p.geo_point_2d.lon });
  }
  const mine = rows.filter(r => r.juris === 'CA-BC'), off = [];
  for (const r of mine) {
    const c = byName.get(normName(r.name));
    if (c) off.push(Math.min(...c.map(p => haversine(r.lat, r.lng, p.lat, p.lng))));
  }
  off.sort((a, b) => a - b);
  const reference = 'City of Vancouver "Schools" open data (internal check only, not published)';
  if (off.length < 50) return [{ juris: 'CA-BC', check: 'position', reference, pass: false, message: `only ${off.length} of ${mine.length} schools matched by name — too few to conclude anything` }];
  const median = off[Math.floor(off.length / 2)], p90 = off[Math.floor(off.length * 0.9)];
  return [{ juris: 'CA-BC', check: 'position', reference, pass: median <= 50,
    message: `${off.length} of ${mine.length} schools matched by name: median ${median.toFixed(0)} m, p90 ${p90.toFixed(0)} m; limit median 50 m (the City layer dates from 2009, so moved schools sit in the tail)` }];
}

const OGL_BC = 'Open Government Licence – British Columbia';

export default {
  id: 'bc',
  juris: ['CA-BC'],
  cadence: 'monthly',
  meta: {
    name: 'BC Schools K-12 and Student Enrolment by Grade (BC Ministry of Education and Child Care)',
    publisher: 'British Columbia Ministry of Education and Child Care',
    licence: OGL_BC,
    licenceUrl: 'https://www2.gov.bc.ca/gov/content?id=A519A56BC2BF44E4A008B33FCF527F61',
    attribution: `BC school number {id} · BC Ministry of Education and Child Care, K-12 schools list and student enrolment by grade. Contains information licensed under the ${OGL_BC}.`,
    where: 'Vancouver',
    publishes: [],
    labels: {
      type: 'Type', phase: 'Level', span: 'Grades', pupils: 'Students', capacity: 'Design capacity', la: 'School district',
      tags: { 'french-immersion': 'French immersion', francophone: 'Francophone program' },
      pupilsAsOf: "Students and grades from the Ministry's September enrolment count, {date}.",
    },
  },
  schemes: {
    'ca-bc-none': {
      kind: 'none',
      notes: [{ html: '<b>British Columbia publishes no single school rating</b> or inspection grade, for public or independent schools. Its Foundation Skills Assessment results are published separately; they are test results, not a rating, and are not shown here.' }],
    },
  },
  fetch: fetchRows,
  verify,
};
