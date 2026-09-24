// Build the school data behind the Schools layer on /check/ — every open,
// geocoded school in England and Wales, cut into 0.25° geographic tiles so the
// map fetches only the schools around the address being looked at.
//
// ONE OUTPUT SHAPE. This used to also write a national schools.json plus a
// row-aligned schools-labels.json for a standalone /schools/ page. That page is
// now a redirect into /check/, which reads tiles; the national files had no
// reader but this repo's own verifier, so they are gone. If a whole-country
// view is ever wanted again, build it from the tiles rather than resurrecting a
// second format that has to be kept in step with the first.
//
// RAW DOWNLOADS GO TO /tmp, NEVER INTO THE REPO. The monthly page rebuild
// commits with `git add -A`; a 62MB CSV left in the tree would be published.
//
// Usage:  node tools/build-schools.mjs
// Output: schools/data/tiles/{y}_{x}.json + schools/data/tiles/index.json

import { writeFileSync, mkdirSync, existsSync, readFileSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { tmpdir } from 'node:os';
import { loadOfsted, REPORT_CARD_AREAS } from './fetch-ofsted.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = join(ROOT, 'schools', 'data');

// GIAS publishes a fresh all-establishments extract every morning under a
// date-stamped filename. There is no "latest" alias, so walk back a few days:
// the file for today usually exists, but not always before ~07:00 UK.
const GIAS_BASE = 'https://ea-edubase-api-prod.azurewebsites.net/edubase/downloads/public';

function ymd(d) {
  return `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCDate()).padStart(2, '0')}`;
}

async function fetchGias() {
  const cached = join(tmpdir(), 'saferoute-gias.csv');
  // A same-day cache purely so re-running while developing does not re-pull
  // 62MB. Anything older is refetched rather than trusted.
  if (existsSync(cached)) {
    const ageH = (Date.now() - statSync(cached).mtimeMs) / 36e5;
    if (ageH < 12) {
      console.log(`  using cached GIAS (${ageH.toFixed(1)}h old)`);
      return readFileSync(cached);
    }
  }
  for (let back = 0; back < 5; back++) {
    const d = new Date(Date.now() - back * 864e5);
    const url = `${GIAS_BASE}/edubasealldata${ymd(d)}.csv`;
    const res = await fetch(url, { signal: AbortSignal.timeout(180_000) });
    if (!res.ok) continue;
    const buf = Buffer.from(await res.arrayBuffer());
    console.log(`  fetched ${url.split('/').pop()} (${(buf.length / 1e6).toFixed(1)}MB)`);
    writeFileSync(cached, buf);
    return buf;
  }
  throw new Error('GIAS: no extract found in the last 5 days');
}

// ── coordinates ─────────────────────────────────────────────────────────────
// GIAS gives OSGB36 Easting/Northing. Leaflet needs WGS84. Two steps, and both
// are needed — skipping the datum shift leaves pins ~100m out, which in a dense
// city puts a school on the wrong side of a road.
//
// 1. Inverse Transverse Mercator off the Airy 1830 ellipsoid → OSGB36 lat/lon
// 2. Helmert 7-parameter transform → WGS84 (~5m, far below pin precision)
//
// Hand-rolled rather than pulling in proj4 (~1MB) for one projection. The
// constants are Ordnance Survey's published values and the result is checked
// against postcodes.io in verify-schools.mjs, not taken on trust.
function osgb36ToWgs84(E, N) {
  const a = 6377563.396, b = 6356256.909;          // Airy 1830
  const F0 = 0.9996012717;                          // National Grid scale factor
  const lat0 = 49 * Math.PI / 180, lon0 = -2 * Math.PI / 180;
  const E0 = 400000, N0 = -100000;
  const e2 = 1 - (b * b) / (a * a);
  const n = (a - b) / (a + b), n2 = n * n, n3 = n2 * n;

  let lat = lat0, M = 0;
  do {
    lat = (N - N0 - M) / (a * F0) + lat;
    const dLat = lat - lat0, sLat = lat + lat0;
    const Ma = (1 + n + 1.25 * n2 + 1.25 * n3) * dLat;
    const Mb = (3 * n + 3 * n2 + 2.625 * n3) * Math.sin(dLat) * Math.cos(sLat);
    const Mc = (1.875 * n2 + 1.875 * n3) * Math.sin(2 * dLat) * Math.cos(2 * sLat);
    const Md = (35 / 24) * n3 * Math.sin(3 * dLat) * Math.cos(3 * sLat);
    M = b * F0 * (Ma - Mb + Mc - Md);
  } while (Math.abs(N - N0 - M) >= 0.00001);

  const cosLat = Math.cos(lat), sinLat = Math.sin(lat);
  const nu = a * F0 / Math.sqrt(1 - e2 * sinLat * sinLat);
  const rho = a * F0 * (1 - e2) / Math.pow(1 - e2 * sinLat * sinLat, 1.5);
  const eta2 = nu / rho - 1;
  const tanLat = Math.tan(lat), tan2 = tanLat * tanLat, tan4 = tan2 * tan2, tan6 = tan4 * tan2;
  const secLat = 1 / cosLat;
  const nu3 = nu * nu * nu, nu5 = nu3 * nu * nu, nu7 = nu5 * nu * nu;

  const VII = tanLat / (2 * rho * nu);
  const VIII = tanLat / (24 * rho * nu3) * (5 + 3 * tan2 + eta2 - 9 * tan2 * eta2);
  const IX = tanLat / (720 * rho * nu5) * (61 + 90 * tan2 + 45 * tan4);
  const X = secLat / nu;
  const XI = secLat / (6 * nu3) * (nu / rho + 2 * tan2);
  const XII = secLat / (120 * nu5) * (5 + 28 * tan2 + 24 * tan4);
  const XIIA = secLat / (5040 * nu7) * (61 + 662 * tan2 + 1320 * tan4 + 720 * tan6);

  const dE = E - E0, dE2 = dE * dE, dE3 = dE2 * dE, dE4 = dE2 * dE2,
        dE5 = dE3 * dE2, dE6 = dE4 * dE2, dE7 = dE5 * dE2;
  const latO = lat - VII * dE2 + VIII * dE4 - IX * dE6;
  const lonO = lon0 + X * dE - XI * dE3 + XII * dE5 - XIIA * dE7;

  return helmertToWgs84(latO, lonO);
}

// OSGB36 → WGS84. OS publish the parameters for WGS84→OSGB36; these are those
// values negated, which is the standard inverse for a transform this small.
function helmertToWgs84(lat, lon) {
  const aFrom = 6377563.396, bFrom = 6356256.909;   // Airy 1830
  const aTo = 6378137.000, bTo = 6356752.3142;      // WGS84
  const tx = 446.448, ty = -125.157, tz = 542.060;  // metres
  const rx = 0.1502 / 3600 * Math.PI / 180;         // arcsec → rad
  const ry = 0.2470 / 3600 * Math.PI / 180;
  const rz = 0.8421 / 3600 * Math.PI / 180;
  const s = -20.4894 / 1e6 + 1;                     // ppm → scale factor

  const e2From = 1 - (bFrom * bFrom) / (aFrom * aFrom);
  const sinLat = Math.sin(lat), cosLat = Math.cos(lat);
  const nu = aFrom / Math.sqrt(1 - e2From * sinLat * sinLat);
  const x1 = nu * cosLat * Math.cos(lon);
  const y1 = nu * cosLat * Math.sin(lon);
  const z1 = (1 - e2From) * nu * sinLat;

  const x2 = tx + s * x1 - rz * y1 + ry * z1;
  const y2 = ty + rz * x1 + s * y1 - rx * z1;
  const z2 = tz - ry * x1 + rx * y1 + s * z1;

  const e2To = 1 - (bTo * bTo) / (aTo * aTo);
  const p = Math.sqrt(x2 * x2 + y2 * y2);
  let latT = Math.atan2(z2, p * (1 - e2To)), nuT;
  for (let i = 0; i < 10; i++) {
    nuT = aTo / Math.sqrt(1 - e2To * Math.sin(latT) * Math.sin(latT));
    const next = Math.atan2(z2 + e2To * nuT * Math.sin(latT), p);
    if (Math.abs(next - latT) < 1e-12) { latT = next; break; }
    latT = next;
  }
  return [latT * 180 / Math.PI, Math.atan2(y2, x2) * 180 / Math.PI];
}

// ── CSV ─────────────────────────────────────────────────────────────────────
// GIAS is Windows-1252, not UTF-8: school names carry curly apostrophes and the
// occasional é. Decoding as UTF-8 mangles them into replacement characters.
function parseCsv(buf) {
  const text = new TextDecoder('windows-1252').decode(buf);
  const rows = [];
  let row = [], field = '', inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else inQ = false; }
      else field += c;
    } else if (c === '"') inQ = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (c !== '\r') field += c;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  const header = rows.shift();
  return { header, rows };
}

// ── normalisation ───────────────────────────────────────────────────────────
// GIAS spells the same religion several ways ("Roman Catholic" / "Catholic",
// "Muslim" / "Islam"). Left raw, a filter dropdown shows both and neither
// selects all the schools it should.
const RELIGION = new Map([
  ['Roman Catholic', 'Catholic'], ['Catholic', 'Catholic'],
  ['Muslim', 'Muslim'], ['Islam', 'Muslim'],
  ['Church of England', 'Church of England'],
  ['None', ''], ['Does not apply', ''], ['Unknown', ''],
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

// Report-card area name -> a short stable key. Ofsted's headings are long and
// contain spaces; the keys travel in every tile and are read by /check/'s
// school pane, which lists all seven areas for a report-card school.
const cardKey = a => 'rc' + a.replace(/[^a-zA-Z]+(.)/g, (_, c) => c.toUpperCase())
                              .replace(/[^a-zA-Z]/g, '')
                              .replace(/^./, c => c.toUpperCase());

// GIAS is a register of every educational ESTABLISHMENT, not of schools. It
// includes universities, offshore schools and an explicit "Miscellaneous" bin.
// Leaving them in put Falmouth University on a schools map — found by clicking
// a pin, not by reading the data. Further education and post-16 institutions
// stay, because 16-19 provision is a real choice a family makes.
const NOT_A_SCHOOL = new Set([
  'Higher education institutions',
  'Miscellaneous',
  'Offshore schools',          // outside England and Wales entirely
]);

const run = async () => {
  const { header, rows } = parseCsv(await fetchGias());
  const col = Object.fromEntries(header.map((h, i) => [h, i]));
  const g = (r, name) => (r[col[name]] ?? '').trim();

  const out = [];
  let skippedClosed = 0, skippedNoGeo = 0, skippedNotSchool = 0;

  for (const r of rows) {
    if (r.length < header.length - 2) continue;
    if (g(r, 'EstablishmentStatus (name)') !== 'Open') { skippedClosed++; continue; }
    const E = parseFloat(g(r, 'Easting')), N = parseFloat(g(r, 'Northing'));
    // A school with no coordinate cannot go on a map. Counted, not hidden.
    if (!Number.isFinite(E) || !Number.isFinite(N) || E === 0 || N === 0) { skippedNoGeo++; continue; }
    const [lat, lng] = osgb36ToWgs84(E, N);
    // Great Britain bounding sanity — catches a transposed or junk grid ref
    // rather than dropping a pin in the Atlantic.
    if (lat < 49.8 || lat > 61 || lng < -8.7 || lng > 2.1) { skippedNoGeo++; continue; }

    const type = g(r, 'TypeOfEstablishment (name)');
    if (NOT_A_SCHOOL.has(type)) { skippedNotSchool++; continue; }
    const religionRaw = g(r, 'ReligiousCharacter (name)');

    out.push({
      urn: +g(r, 'URN'),
      name: g(r, 'EstablishmentName'),
      lat: +lat.toFixed(5), lng: +lng.toFixed(5),
      type,
      group: g(r, 'EstablishmentTypeGroup (name)'),
      // The public/private toggle the map needs, decided once here rather than
      // by string-matching in the browser.
      sector: /independent/i.test(type) ? 'private' : 'state',
      // Explicit, not inferred. The UI previously deduced "not independent and
      // not in the Ofsted file, therefore Wales", which labelled an English
      // university as Welsh. GIAS files every Welsh school under this one type.
      country: type === 'Welsh establishment' ? 'Wales' : 'England',
      phase: derivePhase(g(r, 'PhaseOfEducation (name)'), g(r, 'StatutoryLowAge'), g(r, 'StatutoryHighAge')),
      ageLow: +g(r, 'StatutoryLowAge') || null,
      ageHigh: +g(r, 'StatutoryHighAge') || null,
      gender: g(r, 'Gender (name)'),
      religion: RELIGION.has(religionRaw) ? RELIGION.get(religionRaw) : religionRaw,
      pupils: +g(r, 'NumberOfPupils') || null,
      capacity: +g(r, 'SchoolCapacity') || null,
      fsm: parseFloat(g(r, 'PercentageFSM')) || null,
      censusDate: g(r, 'CensusDate'),
      sixthForm: g(r, 'OfficialSixthForm (name)') === 'Has a sixth form',
      boarding: /boarding/i.test(g(r, 'BoardingEstablishment (name)')),
      nursery: /has nursery/i.test(g(r, 'NurseryProvision (name)')),
      admissions: g(r, 'AdmissionsPolicy (name)'),
      trust: g(r, 'Trusts (name)'),
      la: g(r, 'LA (name)'),
      ward: g(r, 'AdministrativeWard (name)'),
      postcode: g(r, 'Postcode'),
      // Which inspectorate — Ofsted for state, ISI and others for independent.
      // Without this the map cannot explain why a private pin has no Ofsted
      // grade, and an empty badge reads as "bad" rather than "not applicable".
      inspectorate: g(r, 'InspectorateName (name)'),
      // Filled from the Ofsted join below. Declared here so every school has
      // the key whether or not it has a rating — a school missing the field
      // entirely would render differently from one with no grade, and half of
      // them have no grade.
      // NOTE for the UI: rcSafeguardingStandards is binary (Met / Not met),
      // NOT the five-point scale the other report-card areas use. Rendering it
      // on the same colour ramp would show "Met" as if it were a middling
      // grade. It is a pass, and it is the only one of the seven like this.
      ratingScheme: 'none',
      oeifGrade: '',
      oeifDate: '',
      cardDate: '',
      ...Object.fromEntries(REPORT_CARD_AREAS.map(a => [cardKey(a), ''])),
    });
  }

  // ── Ofsted join ───────────────────────────────────────────────────────────
  // Join on URN, which is the only stable key between GIAS and Ofsted. Note
  // what is NOT done here: no overall grade is synthesised for a report-card
  // school by averaging its areas. Ofsted deliberately abolished the single
  // judgement; re-deriving one would be inventing data and would be the most
  // misleading thing this map could do.
  //
  // THREE DIFFERENT THINGS, not one. Collapsing them all to "no rating" would
  // tell a Cardiff parent their school is awaiting inspection when Ofsted has
  // no remit in Wales at all:
  //   'none'        in Ofsted's remit, inspected or not, but carries no grade
  //                 right now — the modal English state school
  //   'not-ofsted'  outside Ofsted's remit entirely: Wales (Estyn inspects),
  //                 and independent schools inspected by ISI
  const ofsted = await loadOfsted();
  let matched = 0, graded = 0, outOfRemit = 0;
  for (const s of out) {
    const o = ofsted.get(s.urn);
    if (!o) {
      // Absent from the state-funded MI. That is Wales, independent schools,
      // and a handful of other establishment types — not a failed join.
      s.ratingScheme = 'not-ofsted';
      outOfRemit++;
      continue;
    }
    matched++;
    s.ratingScheme = o.scheme;
    s.oeifGrade = o.oeifGrade;
    s.oeifDate = o.oeifDate;
    s.cardDate = Object.keys(o.card).length ? o.cardDate : '';
    for (const a of REPORT_CARD_AREAS) s[cardKey(a)] = o.card[a] || '';
    if (o.scheme !== 'none') graded++;
  }
  console.log(`  Ofsted matched       ${matched.toLocaleString()} of ${out.length.toLocaleString()} schools`);
  console.log(`    with any grade     ${graded.toLocaleString()}  (${(100 * graded / matched).toFixed(1)}% of matched)`);
  console.log(`    NO grade           ${(matched - graded).toLocaleString()}  (${(100 * (matched - graded) / matched).toFixed(1)}%)  <- normal, not missing`);
  console.log(`  outside Ofsted remit ${outOfRemit.toLocaleString()}  (Wales/Estyn, ISI-inspected independents)`);

  // Sort north to south so every tile lists its schools in a fixed order. Output
  // is then deterministic — the same inputs produce byte-identical tiles — which
  // keeps the monthly diff to real changes rather than reshuffled rows.
  out.sort((a, b) => a.lat - b.lat || a.lng - b.lng);

  // DELIBERATELY NOT CARRIED, so nobody re-adds them by accident:
  //   SchoolWebsite  — 188KB gzipped, and every school's GIAS page is derivable
  //                    from the URN, so the pin links there instead.
  //   LSOA (code)    — 69KB, only needed to cross-link schools to the crime
  //                    area pages. Add it back with that feature, not before.
  //   DateOfLastInspectionVisit — filled for 310 of 27,173 open schools (1%).
  //                    A date that is absent 99% of the time is not a field.

  // ── geographic tiles ──────────────────────────────────────────────────────
  // /check/ needs the schools around ONE address, not the country. Serving it
  // the national file made every visitor download 728KB to look at a square
  // mile — and three quarters of that page's traffic is US, where the answer is
  // nothing at all.
  //
  // 0.25° cells, chosen from the measured distribution rather than picked:
  // 389 files, median 34 schools, worst case 1,035 in central London. A
  // zoom-14 viewport is about 0.02° tall, so it sits inside one cell and a
  // typical lookup fetches one to four.
  //
  // Tiles carry DECODED strings (no enum dictionary — at ~34 schools per cell a
  // dictionary costs more than it saves) but stay ROW-ARRAY shaped, with the
  // field list held once in index.json. Plain objects were the obvious first
  // cut and produced 20.6MB of raw tiles by repeating every key 26,000 times;
  // this is the same data without that.
  const CELL = 0.25;
  // Everything /check/ needs to draw, FILTER and pop up a school, and nothing
  // else. sixthForm and boarding are here because /check/ now carries the
  // schools filters; fsm, capacity, admissions, trust, ward and censusDate stay
  // out because nothing on that page reads them.
  const TILE_FIELDS = ['urn','name','postcode','lat','lng','type','sector','phase',
                       'gender','pupils','sixthForm','boarding','country',
                       'ratingScheme','oeifGrade','oeifDate',
                       // Detail-pane fields: clicking a school fills the right-hand
                       // pane on /check/, so everything it shows travels in the tile.
                       'ageLow','ageHigh','capacity','fsm','censusDate','nursery',
                       'admissions','la','ward','trust','inspectorate','cardDate',
                       ...REPORT_CARD_AREAS.map(cardKey)];
  // Religious character is deliberately NOT here: the religion filter was removed
  // at the owner's request, and it is not reintroduced through the back door as a
  // detail row. Add 'religion' above if that decision is ever reversed.
  const cellKey = (lat, lng) => `${Math.floor(lat / CELL)}_${Math.floor(lng / CELL)}`;
  const tiles = new Map();
  for (const s of out) {
    const k = cellKey(s.lat, s.lng);
    if (!tiles.has(k)) tiles.set(k, []);
    tiles.get(k).push(TILE_FIELDS.map(f => s[f]));
  }

  const TILE_DIR = join(OUT_DIR, 'tiles');
  mkdirSync(TILE_DIR, { recursive: true });   // recursive: also creates OUT_DIR
  let tileBytes = 0, biggest = 0;
  for (const [k, list] of tiles) {
    const j = JSON.stringify(list);
    writeFileSync(join(TILE_DIR, `${k}.json`), j);
    tileBytes += j.length;
    biggest = Math.max(biggest, gzipSync(Buffer.from(j)).length);
  }
  // An index of populated cells, so the client never requests a 404. Most of
  // the bounding box of England and Wales is sea.
  writeFileSync(join(TILE_DIR, 'index.json'), JSON.stringify({
    cell: CELL,
    generated: new Date().toISOString().slice(0, 10),
    // Read by tools/sync-site-facts.mjs for the homepage's school count, so the
    // number on the homepage is this file's, never a typed copy.
    count: out.length,
    fields: TILE_FIELDS,
    // Filter dropdown values, so the page does not have to fetch every tile to
    // discover what a "phase" can be.
    options: {
      phase: [...new Set(out.map(x => x.phase))].filter(Boolean).sort(),
      gender: [...new Set(out.map(x => x.gender))].filter(v => v && v !== 'Not applicable').sort(),
    },
    cells: [...tiles.keys()].sort(),
  }));

  console.log(`  schools written      ${out.length.toLocaleString()}`);
  console.log(`    state              ${out.filter(s => s.sector === 'state').length.toLocaleString()}`);
  console.log(`    private            ${out.filter(s => s.sector === 'private').length.toLocaleString()}`);
  console.log(`  skipped, closed      ${skippedClosed.toLocaleString()}`);
  console.log(`  skipped, no coords   ${skippedNoGeo.toLocaleString()}`);
  console.log(`  skipped, not a school ${skippedNotSchool.toLocaleString()}  (universities, offshore, misc)`);
  console.log(`  tiles                ${tiles.size} cells at ${CELL}°, ${(tileBytes / 1e6).toFixed(1)}MB raw total, largest ${(biggest / 1024).toFixed(0)}KB gzipped`);
};

run().catch(e => { console.error('build-schools failed:', e.message); process.exit(1); });
