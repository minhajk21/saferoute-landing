// US PRIVATE SCHOOLS (src "pss"), for the US crime-data cities under scope R2.
//
// Source: the NCES Private School Universe Survey (PSS) 2023-24 public-use
// file. It lists the 22,510 private schools that ANSWERED the survey (NCES's
// readme: "the files only include the interviewed cases"); NCES's own weights
// put the country's private schools at about 30,550, so about 3 in 4 are here
// and the rest cannot be shown. PSS runs every two years; 2025-26 is due in
// spring 2027 (probe() watches for it).
//
// Its coordinates (LATITUDE24/LONGITUDE24) are NCES EDGE's private-school
// geocodes, identical to EDGE_GEOCODE_PRIVATESCH_2324 (checked for all
// 22,510, max difference 3e-14 degrees).
//
// RELIGION IS NEVER READ. PSS carries a school's religious orientation,
// affiliation, typology and diocese (TYPOLOGY, RELIG, ORIENT, DIOCESE,
// P430–P445, P455–P535 and their imputation flags). This module reads only
// the columns in NEED, which a check below keeps free of every one of them;
// the rest of each line is discarded as it is parsed. School names can still
// say it ("St. Mary's"); nothing else on the map does.
//
// Dropped (and counted): schools located in a private home used mainly as a
// family residence (P425 = 1) and schools with no in-person classes (P411 = 2).
// Kept schools must sit in a region rectangle whose home state is the
// school's own location state (PL_STABB, which PSS fills only when the
// location differs from the mailing address; else PSTABB).

import { unzipEntry, count, fte, r5, pssSpan, zipInState, positionChecks } from './_nces.mjs';
import { parseCsv, columns } from '../lib/csv.mjs';
import { usPrivateStage } from '../lib/stage.mjs';
import { REGIONS } from '../regions.mjs';

const ID = 'pss';
const YEAR = '2023-24';
const ZIP = { file: 'pss2324_pu_csv.zip', url: 'https://nces.ed.gov/surveys/pss/zip/pss2324_pu_csv.zip' };
const NEXT = 'https://nces.ed.gov/surveys/pss/zip/pss2526_pu_csv.zip';

const NEED = ['PPIN', 'PINST', 'PCITY', 'PSTABB', 'PZIP', 'PL_CIT', 'PL_STABB', 'PL_ZIP', 'LATITUDE24', 'LONGITUDE24',
  'LEVEL', 'LOGR2024', 'HIGR2024', 'NUMSTUDS', 'NUMTEACH', 'P335', 'P415', 'P411', 'P425'];
// The religious columns of PSS 2023-24 (codebook): never in NEED, and so never read.
export const RELIGIOUS = /^(F_)?(TYPOLOGY|RELIG|ORIENT|DIOCESE|P43[0-9]|P44[0-9]|P4(5[5-9]|[6-9]\d)|P5([0-2]\d|3[0-5]))$/;
for (const c of NEED) if (RELIGIOUS.test(c)) throw new Error(`pss.mjs: ${c} is a religious column and must never be read`);

// Codebook labels, in NCES's own words.
const LEVEL = { 1: 'Elementary', 2: 'Secondary', 3: 'Combined elementary and secondary' };
const TYPE = {
  1: 'Regular', 2: 'Montessori', 3: 'Special program emphasis', 4: 'Special education',
  5: 'Career/technical/vocational', 6: 'Alternative/other', 7: 'Early childhood program/child care center',
};
// P335 "Is this school coeducational?": 1 yes, 2 all-female, 3 all-male. The
// declared answer, in the map's shared filter words.
const GENDER = { 1: 'Mixed', 2: 'Girls', 3: 'Boys' };

const US_JURIS = [...new Set(Object.values(REGIONS).flatMap(r => r.juris).filter(j => j.startsWith('US-')))].sort();

async function fetchRows(ctx) {
  const buf = await ctx.download(ZIP.file, ZIP.url, { maxAgeH: 24 * 30 });
  const { header, rows } = parseCsv(unzipEntry(buf, /^pss2324_pu\.csv$/i), { encoding: 'latin1' });
  const col = columns(header, NEED, ZIP.file);
  const usRegions = ctx.coverage.regions.filter(r => r.juris.some(j => j.startsWith('US-')));
  const inUsBox = (lat, lng) => usRegions.some(r => lat >= r.bbox[0] && lat <= r.bbox[2] && lng >= r.bbox[1] && lng <= r.bbox[3]);
  const out = [];
  let read = 0;
  for (const line of rows) {
    if (line.length < header.length - 1) continue;
    read++;
    // Only the NEED columns are copied out of the line.
    const r = {};
    for (const c of NEED) r[c] = (line[col[c]] ?? '').trim();
    if (!r.LATITUDE24 || !Number.isFinite(+r.LATITUDE24) || !Number.isFinite(+r.LONGITUDE24) || !+r.LATITUDE24 || !+r.LONGITUDE24) { ctx.stat('unmapped.noCoordinates'); continue; }
    // Scope is judged on the published (5-dp) point, as the build judges it.
    const lat = r5(r.LATITUDE24), lng = r5(r.LONGITUDE24);
    if (!inUsBox(lat, lng)) continue;
    // Same order as the design prototype, so the drop counts compare.
    if (r.P425 === '1') { ctx.stat('dropped.homeBased'); continue; }
    if (r.P411 === '2') { ctx.stat('dropped.noInPersonClasses'); continue; }
    const juris = `US-${r.PL_STABB || r.PSTABB}`;
    if (!ctx.coverage.regionFor(lat, lng, juris)) { ctx.stat('dropped.otherState'); continue; }
    // A ZIP from another state's range is a damaged value (a few MA schools
    // lost the leading zero): not shown rather than shown wrong.
    let zip = (r.PL_ZIP || r.PZIP).slice(0, 5);
    if (!zipInState(zip, juris)) { ctx.stat('omitted.zipNotInState'); zip = ''; }
    out.push({
      src: ID, id: r.PPIN, name: r.PINST, postcode: zip,
      lat, lng, juris,
      type: TYPE[r.P415] || '', sector: 'private', stage: usPrivateStage(r.LEVEL), phase: LEVEL[r.LEVEL] || '',
      gender: GENDER[r.P335] || '', boarding: false, span: pssSpan(r.LOGR2024, r.HIGR2024),
      pupils: count(r.NUMSTUDS), teachers: fte(r.NUMTEACH),
      area: r.PL_CIT || r.PCITY,
      ratingScheme: 'us-private',
    });
  }
  // The file is the whole country (22,510 in 2023-24): a short read is a broken download.
  if (read < 15000) throw new Error(`${ZIP.file}: only ${read} rows — refusing a partial build`);
  ctx.vintage(`PSS ${YEAR} public-use file (${read.toLocaleString('en-GB')} responding schools nationally)`);
  return out;
}

// A new PSS edition is a new file name; NCES answers 404 until it exists.
async function probe() {
  const res = await fetch(NEXT, { method: 'HEAD', signal: AbortSignal.timeout(60_000) });
  return { vintage: res.ok ? 'PSS 2025-26' : `PSS ${YEAR}`, changed: res.ok };
}

export default {
  id: ID,
  juris: US_JURIS,
  cadence: 'annual',
  meta: {
    name: `NCES Private School Universe Survey (PSS) ${YEAR}`,
    publisher: 'U.S. Department of Education, National Center for Education Statistics (NCES)',
    licence: 'Public domain (U.S. federal government work)',
    licenceUrl: 'https://resources.data.gov/open-licenses/',
    attribution: `NCES private school ID {id} · U.S. Department of Education, NCES, Private School Universe Survey (PSS), ${YEAR}.`,
    recordUrl: 'https://nces.ed.gov/surveys/pss/privateschoolsearch/school_detail.asp?ID={id}',
    recordLabel: 'NCES private school record',
    // PSS prints every name and city in capitals; /check/ shows them in title
    // case (its schCase, 'en' rules). The data stays as published.
    displayCase: 'en',
    where: 'US private schools',
    publishes: ['gender'],
    pupilsAsOf: YEAR,
    labels: {
      type: 'Type', phase: 'Level (PSS)', span: 'Grades', gender: 'Gender', pupils: 'Students (K–12)', teachers: 'Teachers (FTE)',
      ratio: 'Students per teacher',
      pupilsAsOf: 'Details as reported to NCES for the {date} school year; the student count leaves out pre-kindergarten.',
    },
  },
  schemes: {
    'us-private': {
      kind: 'none',
      notes: [{
        html: 'No official rating is published for this private school. <span class="caveat">US private schools come from NCES’s 2023-24 ' +
          'Private School Universe Survey, which lists only the schools that answered it (about 3 in 4), so some private schools are not on this map.</span>',
      }],
    },
  },
  fetch: fetchRows,
  probe,
  verify: (rows, h) => positionChecks(rows, h, 'NCES private'),
};
