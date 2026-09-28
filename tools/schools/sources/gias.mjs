// England & Wales: every open, geocoded school in the Department for
// Education's register (Get Information About Schools), with Ofsted's latest
// inspection outcome for English state schools. Wales is in GIAS too (state
// schools only, every one typed "Welsh establishment"); Estyn outcomes are not.
//
// This is the pre-v2 build-schools.mjs logic, moved behind the source-module
// interface (tools/schools/README.md) and emitting v2 rows. Its output was
// proven identical, school by school and field by field, to the last v1 build
// from the same GIAS and Ofsted files (Sept 2026 refactor).
//
// NOT CARRIED, so nobody re-adds them by accident:
//   ReligiousCharacter — the religion filter was removed at the owner's
//                  request, and religion is not reintroduced through the back
//                  door as a detail row either.
//   SchoolWebsite  — 188KB gzipped, and every school's GIAS page is derivable
//                  from the URN, so the pane links there instead.
//   LSOA (code)    — 69KB, only needed to cross-link schools to the crime area
//                  pages. Add it back with that feature, not before.
//   DateOfLastInspectionVisit — filled for 310 of 27,173 open schools (1%).
//                  A date that is absent 99% of the time is not a field.

import { parseCsv, columns } from '../lib/csv.mjs';
import { osgb36ToWgs84 } from '../lib/osgb.mjs';
import { giasStage } from '../lib/stage.mjs';
import { RC_FIELDS } from '../lib/schema.mjs';
import { loadOfsted, REPORT_CARD_AREAS, LANDING as OFSTED_LANDING, dateFromName } from './_ofsted.mjs';

// GIAS publishes a fresh all-establishments extract every morning under a
// date-stamped filename. There is no "latest" alias, so walk back a few days:
// the file for today usually exists, but not always before ~07:00 UK.
const GIAS_BASE = 'https://ea-edubase-api-prod.azurewebsites.net/edubase/downloads/public';
const ymd = d => `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCDate()).padStart(2, '0')}`;
const giasUrls = () => [0, 1, 2, 3, 4].map(back => `${GIAS_BASE}/edubasealldata${ymd(new Date(Date.now() - back * 864e5))}.csv`);

// Report-card area name -> a short stable key ("Safeguarding standards" ->
// rcSafeguardingStandards). Must produce schema.RC_FIELDS, in order.
const cardKey = a => 'rc' + a.replace(/[^a-zA-Z]+(.)/g, (_, c) => c.toUpperCase())
                              .replace(/[^a-zA-Z]/g, '')
                              .replace(/^./, c => c.toUpperCase());
if (REPORT_CARD_AREAS.map(cardKey).join() !== RC_FIELDS.join()) {
  throw new Error('Ofsted report-card areas no longer match schema RC_FIELDS — update both together');
}

// GIAS is a register of every educational ESTABLISHMENT, not of schools. It
// includes universities, offshore schools and an explicit "Miscellaneous" bin.
// Leaving them in put Falmouth University on a schools map — found by clicking
// a pin, not by reading the data. Further education and post-16 institutions
// stay, because 16-19 provision is a real choice a family makes.
const NOT_A_SCHOOL = new Set([
  'Higher education institutions',
  'Miscellaneous',
  'Offshore schools',          // outside England and Wales entirely
  // Ministry of Defence schools abroad (Tehran, Sakhalin, Huiyang...). GIAS
  // registers them to one Canary Wharf postcode, so they were four pins in
  // east London for schools thousands of miles away.
  "Service children's education",
]);

// PhaseOfEducation is literally "Not applicable" for every independent school,
// so phase has to come from the age range or half the private pins lose their
// most useful filter.
function derivePhase(phase, lo, hi) {
  if (phase && phase !== 'Not applicable') return phase;
  const a = parseInt(lo, 10), b = parseInt(hi, 10);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return '';
  if (b <= 11) return 'Primary';
  if (a >= 16) return 'Sixth form';
  if (a >= 11) return 'Secondary';
  return 'All-through';
}

// GIAS writes CensusDate as DD-MM-YYYY; every other date on the map is ISO.
const dmyToIso = v => { const m = /^(\d{2})[-/](\d{2})[-/](\d{4})$/.exec(v); return m ? `${m[3]}-${m[2]}-${m[1]}` : ''; };

// Ages: shown only when both ends are published, exactly as before v2. NOTE a
// pre-existing quirk kept on purpose in a no-data-change refactor: GIAS's
// StatutoryLowAge of 0 (nursery-from-birth schools) is read as "not published",
// so those schools show no age range.
const spanOf = (lo, hi) => (lo && hi ? `${lo}–${hi}` : '');

// ── the v2 row, shared by the live build and the v1-tile reader ─────────────
function v2Row(s) {
  return {
    src: 'gias', id: String(s.urn), name: s.name, postcode: s.postcode, lat: s.lat, lng: s.lng,
    // Explicit, not inferred: GIAS files every Welsh school under this one type.
    juris: s.type === 'Welsh establishment' ? 'GB-WLS' : 'GB-ENG',
    type: s.type,
    // The public/private toggle, decided once here rather than in the browser.
    sector: /independent/i.test(s.type) ? 'private' : 'state',
    stage: giasStage(s), phase: s.phase, tags: '',
    gender: s.gender, boarding: s.boarding,
    span: spanOf(s.ageLow, s.ageHigh),
    pupils: s.pupils, pupilsAsOf: s.censusDate, capacity: s.capacity, teachers: null,
    meals: s.fsm, mealsKind: s.fsm != null ? 'fsm' : '',
    admissions: s.admissions, la: s.la, trust: s.trust, area: s.ward,
    ratingScheme: s.ratingScheme, rv: '', rd: '', ru: '',
    sixthForm: s.sixthForm, nursery: s.nursery, inspectorate: s.inspectorate,
    oeifGrade: s.oeifGrade, oeifDate: s.oeifDate, cardDate: s.cardDate,
    ...Object.fromEntries(RC_FIELDS.map(k => [k, s[k] ?? ''])),
  };
}

async function fetchRows(ctx) {
  const { header, rows } = parseCsv(await ctx.download('gias-edubasealldata.csv', giasUrls, { maxAgeH: 12, timeoutMs: 180_000 }),
    { encoding: 'windows-1252' });   // GIAS is Windows-1252, not UTF-8
  const need = ['URN', 'EstablishmentName', 'EstablishmentStatus (name)', 'Easting', 'Northing', 'TypeOfEstablishment (name)',
    'PhaseOfEducation (name)', 'StatutoryLowAge', 'StatutoryHighAge', 'Gender (name)', 'NumberOfPupils', 'SchoolCapacity',
    'PercentageFSM', 'CensusDate', 'OfficialSixthForm (name)', 'BoardingEstablishment (name)', 'Boarders (name)',
    'NurseryProvision (name)', 'AdmissionsPolicy (name)', 'Trusts (name)', 'LA (name)', 'AdministrativeWard (name)',
    'Postcode', 'InspectorateName (name)'];
  const col = columns(header, need, 'GIAS extract');
  const g = (r, name) => (r[col[name]] ?? '').trim();

  const out = [];
  for (const r of rows) {
    if (r.length < header.length - 2) continue;
    if (g(r, 'EstablishmentStatus (name)') !== 'Open') { ctx.stat('dropped.notOpen'); continue; }
    const E = parseFloat(g(r, 'Easting')), N = parseFloat(g(r, 'Northing'));
    // A school with no coordinate cannot go on a map. Counted, not hidden.
    if (!Number.isFinite(E) || !Number.isFinite(N) || E === 0 || N === 0) { ctx.stat('unmapped.noCoordinates'); continue; }
    const [lat, lng] = osgb36ToWgs84(E, N);
    // Great Britain bounding sanity — catches a transposed or junk grid ref
    // rather than dropping a pin in the Atlantic.
    if (lat < 49.8 || lat > 61 || lng < -8.7 || lng > 2.1) { ctx.stat('unmapped.noCoordinates'); continue; }

    const type = g(r, 'TypeOfEstablishment (name)');
    if (NOT_A_SCHOOL.has(type)) { ctx.stat('dropped.notASchool'); continue; }

    out.push({
      urn: +g(r, 'URN'),
      name: g(r, 'EstablishmentName'),
      lat: +lat.toFixed(5), lng: +lng.toFixed(5),
      type,
      phase: derivePhase(g(r, 'PhaseOfEducation (name)'), g(r, 'StatutoryLowAge'), g(r, 'StatutoryHighAge')),
      ageLow: +g(r, 'StatutoryLowAge') || null,
      ageHigh: +g(r, 'StatutoryHighAge') || null,
      gender: g(r, 'Gender (name)'),
      pupils: +g(r, 'NumberOfPupils') || null,
      capacity: +g(r, 'SchoolCapacity') || null,
      fsm: parseFloat(g(r, 'PercentageFSM')) || null,
      censusDate: dmyToIso(g(r, 'CensusDate')),
      sixthForm: g(r, 'OfficialSixthForm (name)') === 'Has a sixth form',
      // GIAS never says "boarding" in BoardingEstablishment: its values are "Has
      // boarders" / "Does not have boarders" (and blank for most schools). The
      // "Boarders" field names boarding schools directly; either one is enough.
      boarding: g(r, 'BoardingEstablishment (name)') === 'Has boarders' || g(r, 'Boarders (name)') === 'Boarding school',
      nursery: /has nursery/i.test(g(r, 'NurseryProvision (name)')),
      admissions: g(r, 'AdmissionsPolicy (name)'),
      trust: g(r, 'Trusts (name)'),
      la: g(r, 'LA (name)'),
      ward: g(r, 'AdministrativeWard (name)'),
      postcode: g(r, 'Postcode'),
      // Which inspectorate — Ofsted for state, ISI and others for independent.
      // Without this the pane cannot explain why a private school has no Ofsted
      // grade, and an empty badge reads as "bad" rather than "not applicable".
      inspectorate: g(r, 'InspectorateName (name)'),
      ratingScheme: 'none', oeifGrade: '', oeifDate: '', cardDate: '',
    });
  }

  // ── Ofsted join ───────────────────────────────────────────────────────────
  // Join on URN, the only stable key between GIAS and Ofsted. No overall grade
  // is synthesised for a report-card school by averaging its areas: Ofsted
  // deliberately abolished the single judgement, and re-deriving one would be
  // inventing data. THREE DIFFERENT THINGS, not one:
  //   'none'        in Ofsted's remit, but carries no grade right now — the
  //                 modal English state school
  //   'not-ofsted'  outside Ofsted's remit entirely: Wales (Estyn inspects),
  //                 and independent schools inspected by ISI
  //   'oeif' / 'reportcard' / 'both'  graded, under either framework
  const ofsted = await loadOfsted(ctx);
  let matched = 0, graded = 0;
  for (const s of out) {
    const o = ofsted.get(s.urn);
    if (!o) { s.ratingScheme = 'not-ofsted'; continue; }
    matched++;
    s.ratingScheme = o.scheme;
    s.oeifGrade = o.oeifGrade;
    s.oeifDate = o.oeifDate;
    s.cardDate = Object.keys(o.card).length ? o.cardDate : '';
    for (const a of REPORT_CARD_AREAS) s[cardKey(a)] = o.card[a] || '';
    if (o.scheme !== 'none') graded++;
  }
  ctx.stat('ofsted.matched', matched);
  ctx.stat('ofsted.graded', graded);
  ctx.stat('ofsted.outOfRemit', out.length - matched);
  ctx.log(`  Ofsted matched ${matched.toLocaleString()} of ${out.length.toLocaleString()}; any grade ${graded.toLocaleString()}` +
    ` (${(100 * graded / matched).toFixed(1)}% — half with none is normal, not missing)`);

  const giasFile = ctx.provenance.find(p => p.file === 'gias-edubasealldata.csv')?.url?.match(/edubasealldata(\d{8})\.csv/)?.[1];
  const ofUrl = ctx.provenance.find(p => p.file === 'ofsted-state-funded-latest.csv')?.url;
  const ofDate = ofUrl ? new Date(dateFromName(ofUrl)).toISOString().slice(0, 10) : null;
  ctx.vintage([giasFile && `GIAS ${giasFile.slice(0, 4)}-${giasFile.slice(4, 6)}-${giasFile.slice(6)}`,
               ofDate && `Ofsted MI as at ${ofDate}`].filter(Boolean).join('; ') || null);

  return out.map(v2Row);
}

// A v1 tile row (the pre-v2 field names) as a v2 row. Used to read the last v1
// tile set as this source's snapshot, and to prove the refactor changed no data.
// v1 stored country and sector; they are carried over as stored, not recomputed.
export function fromV1(o) {
  return { ...v2Row(o), juris: o.country === 'Wales' ? 'GB-WLS' : 'GB-ENG', sector: o.sector };
}

// ── position check (verify-schools) ──────────────────────────────────────────
// build: osgb36ToWgs84 is hand-rolled, so a wrong datum shift would fail
// SILENTLY — every pin ~100m out, in a consistent direction. Check it against an
// independent lineage: postcodes.io's WGS84 centroid of each school's own
// postcode (ONS data). A right conversion leaves each school within a short
// walk of its centroid, scattered in no particular direction.
const SAMPLE = 100;          // postcodes.io bulk endpoint caps at 100
const MEDIAN_LIMIT_M = 200;  // above this, suspect the projection, not the data

const JURIS = ['GB-ENG', 'GB-WLS'];
async function verify(rows, { haversine }) {
  const checks = [];
  for (const juris of JURIS) {
    // Sample the length of the country, not one city: a projection error can
    // vary with distance from the central meridian.
    const list = rows.filter(r => r.juris === juris).sort((a, b) => a.lat - b.lat);
    const stride = Math.max(1, Math.floor(list.length / SAMPLE));
    const picked = [];
    for (let i = 0; i < list.length && picked.length < SAMPLE; i += stride) {
      const r = list[i];
      if (r.postcode && /^[A-Z]{1,2}\d/i.test(r.postcode)) picked.push(r);
    }
    const res = await fetch('https://api.postcodes.io/postcodes', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ postcodes: picked.map(p => p.postcode) }), signal: AbortSignal.timeout(60_000),
    });
    if (!res.ok) throw new Error(`postcodes.io HTTP ${res.status}`);
    const found = new Map();
    for (const r of (await res.json()).result || []) if (r.result?.latitude != null) found.set(r.query.toUpperCase(), r.result);
    const off = picked.map(p => { const ref = found.get(p.postcode.toUpperCase()); return ref && { name: p.name, m: haversine(p.lat, p.lng, ref.latitude, ref.longitude) }; })
      .filter(Boolean).sort((a, b) => a.m - b.m);
    if (off.length < 20) { checks.push({ juris, check: 'position', pass: false, message: `only ${off.length} postcodes resolved — too few to conclude anything` }); continue; }
    const median = off[Math.floor(off.length / 2)].m, p90 = off[Math.floor(off.length * 0.9)].m, worst = off[off.length - 1];
    checks.push({
      juris, check: 'position', reference: 'postcodes.io postcode centroids (ONS)', pass: median <= MEDIAN_LIMIT_M,
      message: `${off.length} schools: median ${median.toFixed(0)} m, p90 ${p90.toFixed(0)} m, worst ${worst.m.toFixed(0)} m (${worst.name}); limit median ${MEDIAN_LIMIT_M} m` +
        (median > MEDIAN_LIMIT_M ? ' — a centroid is never that far from its own building: suspect the Helmert parameters / datum shift' : ''),
    });
  }
  return checks;
}

// ── wording (copied into index.json) ─────────────────────────────────────────
const OGL = 'Open Government Licence v3.0';
const ofstedScheme = {
  kind: 'ofsted', title: 'Ofsted inspection', publisher: 'Ofsted', url: OFSTED_LANDING,
};

export default {
  id: 'gias',
  juris: JURIS,
  cadence: 'monthly',
  meta: {
    name: 'Get Information About Schools (DfE) and Ofsted management information',
    publisher: 'Department for Education; Ofsted',
    licence: OGL,
    licenceUrl: 'https://www.nationalarchives.gov.uk/doc/open-government-licence/version/3/',
    attribution: `URN {id} · DfE Get Information About Schools and Ofsted management information, ${OGL}.`,
    recordUrl: 'https://get-information-schools.service.gov.uk/Establishments/Establishment/Details/{id}',
    recordLabel: 'Full DfE record',
    where: 'England & Wales',
    publishes: ['gender', 'boarding'],
    labels: {
      type: 'Type', phase: 'Phase', span: 'Ages', gender: 'Gender', pupils: 'Pupils', capacityOf: 'places',
      meals: { fsm: 'Free school meals' }, sixthForm: 'Sixth form', boarding: 'Boarding', nursery: 'Nursery',
      admissions: 'Admissions', la: 'Local authority', trust: 'Trust', pupilsAsOf: 'Pupil numbers as at {date}.',
    },
  },
  schemes: {
    none: ofstedScheme, oeif: ofstedScheme, reportcard: ofstedScheme, both: ofstedScheme,
    // Outside Ofsted's remit. First matching note wins; the last is the default.
    'not-ofsted': {
      kind: 'none',
      notes: [
        { when: { juris: 'GB-WLS' }, html: 'This school is in <b>Wales</b>, where <b>Estyn</b> inspects rather than Ofsted. Estyn outcomes are not in this dataset.' },
        { when: { sector: 'private', inspectorate: 'ISI' }, html: 'Inspected by the <b>Independent Schools Inspectorate</b>, not Ofsted. ISI publishes reports school by school rather than as open data, so no grade is shown here.' },
        { when: { sector: 'private' }, html: 'A private school. Independent schools are inspected separately from state schools, and those outcomes are not published as open data.' },
        { html: 'No Ofsted inspection outcome is published for this establishment in the state-funded dataset.' },
      ],
    },
  },
  fetch: fetchRows,
  fromV1,
  verify,
};
