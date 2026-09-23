// Ofsted inspection outcomes, joined to schools by URN.
//
// THE CENTRAL FACT, measured on the real file rather than assumed:
//
//     no grade at all   10,993  (50.1%)   <- the MODAL state
//     legacy OEIF        9,775  (44.5%)
//     new report card    2,451  (11.2%)
//     both                1,262  (5.7%)
//
// Half of England's state schools currently carry no Ofsted grade. Ofsted
// withdrew the single-word overall judgement in September 2024 and is working
// through re-inspection under report cards, so "no rating" is not missing data
// and must never render as a blank badge, a dash, or a neutral grey pin that
// reads as "unrated" — it is the normal condition of half the map.
//
// TWO FRAMEWORKS COEXIST IN ONE FILE and they are not comparable:
//   - Legacy OEIF: ONE overall grade, 1-4 (Outstanding/Good/RI/Inadequate).
//     Verified: 9,775 of 9,775 schools carrying one — 100% — were inspected
//     BEFORE September 2024, spanning back to 2019. Graded inspections did
//     continue into 2024-25, but they no longer award an overall word, so those
//     rows sit in the file with a date and a NULL grade. Any single-word badge
//     on this map is therefore at least a year old and comes from a framework
//     that has been withdrawn, and the UI has to say so next to the word.
//   - Report card: NO overall grade by design. Separate grades per area on a
//     five-point scale. Collapsing them into one number would re-invent exactly
//     the thing Ofsted abolished, so this does not do that.
//
// TRAP: the file writes the literal string "NULL", not an empty cell. A naive
// truthiness check marks all 21,957 schools as rated, which is the precise
// shape of the falsely-reassuring bug this repo has already shipped once with
// crime counts. isGraded() is the only place that judgement is made.
//
// Usage:  node tools/fetch-ofsted.mjs        (prints a coverage summary)
//         import { loadOfsted } from './fetch-ofsted.mjs'

import { writeFileSync, existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// The landing page, NOT a direct asset URL. GOV.UK asset URLs carry a content
// hash (…/media/6aa0175392e72b8ac437ef37/…) that changes every publication, and
// the filename's month spelling is inconsistent across releases — "31_Mar_2026"
// but "30_June_2026", "31_August_2026". Templating either one breaks silently
// the next time Ofsted publishes. Resolve the link from the page instead.
const LANDING = 'https://www.gov.uk/government/statistical-data-sets/monthly-management-information-ofsteds-school-inspections-outcomes';

const CACHE = join(tmpdir(), 'saferoute-ofsted-state.csv');

// Values that mean "no judgement". "NULL" is the literal text in the file.
const BLANK = new Set(['', 'NULL', 'Not judged', 'NA', 'N/A', 'Not applicable', '-']);
const isGraded = v => { const s = (v ?? '').trim(); return BLANK.has(s) ? '' : s; };

const OEIF_GRADE = { '1': 'Outstanding', '2': 'Good', '3': 'Requires improvement', '4': 'Inadequate' };

// The report-card areas, in the order Ofsted lists them. Kept as separate
// grades because the framework has no overall judgement.
export const REPORT_CARD_AREAS = [
  'Safeguarding standards',
  'Inclusion',
  'Curriculum and teaching',
  'Achievement',
  'Attendance and behaviour',
  'Personal development and wellbeing',
  'Leadership and governance',
];

async function resolveCsvUrl() {
  const res = await fetch(LANDING, { signal: AbortSignal.timeout(60_000) });
  if (!res.ok) throw new Error(`Ofsted landing page HTTP ${res.status}`);
  const html = await res.text();
  // Match the state-funded CSV whatever its hash and however the month is spelt.
  const re = /https:\/\/assets\.publishing\.service\.gov\.uk\/media\/[a-f0-9]+\/Management_information_-_state-funded_schools[^"']*?\.csv/gi;
  const hits = [...new Set(html.match(re) || [])];
  if (!hits.length) throw new Error('no state-funded CSV link found on the Ofsted landing page — the page layout may have changed');
  return hits[0];
}

async function fetchCsv() {
  if (existsSync(CACHE)) {
    const ageH = (Date.now() - statSync(CACHE).mtimeMs) / 36e5;
    if (ageH < 12) return readFileSync(CACHE, 'utf8');
  }
  const url = await resolveCsvUrl();
  const res = await fetch(url, { signal: AbortSignal.timeout(300_000) });
  if (!res.ok) throw new Error(`Ofsted CSV HTTP ${res.status}`);
  const text = await res.text();
  writeFileSync(CACHE, text);
  console.log(`  fetched ${url.split('/').pop()} (${(text.length / 1e6).toFixed(1)}MB)`);
  return text;
}

function parseCsv(text) {
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
  const header = rows.shift().map(h => h.replace(/^﻿/, '').trim());
  return { header, rows };
}

// Ofsted writes DD/MM/YYYY. Stored as ISO so it sorts and so no reader has to
// guess whether 03/04 is March or April.
function isoDate(v) {
  const s = isGraded(v);
  const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(s);
  return m ? `${m[3]}-${m[2]}-${m[1]}` : '';
}

/**
 * @returns {Promise<Map<number, {scheme:string, oeifGrade:string, oeifDate:string,
 *                                card:Record<string,string>, cardDate:string}>>}
 *          keyed by URN. Schools absent from the map have no Ofsted record at
 *          all — distinct from present-with-no-grade, which is scheme:'none'.
 */
export async function loadOfsted() {
  const { header, rows } = parseCsv(await fetchCsv());
  const col = Object.fromEntries(header.map((h, i) => [h, i]));
  const need = ['URN', 'Latest OEIF overall effectiveness', ...REPORT_CARD_AREAS];
  for (const n of need) {
    if (!(n in col)) throw new Error(`Ofsted CSV is missing the column "${n}" — the schema changed, do not publish a partial join`);
  }

  const out = new Map();
  for (const r of rows) {
    const urn = parseInt(r[col['URN']], 10);
    if (!Number.isFinite(urn)) continue;

    const oeifGrade = OEIF_GRADE[isGraded(r[col['Latest OEIF overall effectiveness']])] || '';
    const card = {};
    for (const area of REPORT_CARD_AREAS) {
      const g = isGraded(r[col[area]]);
      if (g) card[area] = g;
    }
    const hasCard = Object.keys(card).length > 0;

    out.set(urn, {
      // 'none' is a real, expected value — see the header comment.
      scheme: hasCard && oeifGrade ? 'both' : hasCard ? 'reportcard' : oeifGrade ? 'oeif' : 'none',
      oeifGrade,
      oeifDate: isoDate(r[col['Inspection start date of latest OEIF graded inspection']]),
      card,
      cardDate: isoDate(r[col['Inspection start date']]),
    });
  }
  return out;
}

// Standalone run: report coverage. The point is to make the 50% visible every
// time anyone touches this, rather than discovering it in the UI.
if (import.meta.url === `file://${process.argv[1]}`) {
  const m = await loadOfsted();
  const all = [...m.values()];
  const pct = n => `${(100 * n / all.length).toFixed(1)}%`;
  const by = s => all.filter(v => v.scheme === s).length;
  console.log(`  schools in Ofsted MI   ${all.length.toLocaleString()}`);
  console.log(`  no grade at all        ${by('none').toLocaleString().padStart(7)}  (${pct(by('none'))})  <- modal`);
  console.log(`  legacy OEIF only       ${by('oeif').toLocaleString().padStart(7)}  (${pct(by('oeif'))})`);
  console.log(`  report card only       ${by('reportcard').toLocaleString().padStart(7)}  (${pct(by('reportcard'))})`);
  console.log(`  both                   ${by('both').toLocaleString().padStart(7)}  (${pct(by('both'))})`);
  const dated = all.map(v => v.oeifDate).filter(Boolean).sort();
  if (dated.length) console.log(`  legacy grades span     ${dated[0]} to ${dated[dated.length - 1]}  (framework withdrawn Sept 2024)`);
}
