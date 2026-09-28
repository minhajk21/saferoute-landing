// California: ESSA assistance status, 2025-26 — a STATUS, NOT A RATING
// (Los Angeles, Long Beach, San Diego, San Francisco).
//   node tools/schools/ratings.mjs --scheme us-ca-essa
// California gives schools no overall rating. Its School Dashboard shows each
// indicator separately in colours; those colours are NEVER collapsed into a
// rating here (DESIGN.md §4). What is shown is whether the state identified
// the school for federal support under ESSA.
// File: CDE "essaassistance25.xlsx", sheet "2025-26 ESSA State Schools",
// column AssistanceStatus2025 (ReportingYear 2025 = statuses for 2025-26).
// www.cde.ca.gov sits behind an intermittent Radware check: the URL is retried.
// Join: 14-digit CDS = ST_SCHID segments 2 + 3 ("CA-1964733-1930064"). A
// charter's CDS starts with its AUTHORISING district, which CCD may not share,
// so a miss falls back to the 7-digit school code alone when that code is
// unique in CDE's file (counted in meta.stats.schoolCodeMatch).
// Verified (14-digit only): LA 1,131/1,421, SD 409/491, SF 111/137, LB 127/135.
import { xlsx, sheetRecords, stateIds, joinRatings } from './_us.mjs';

const YEAR = '2025-26';
const URL = 'https://www.cde.ca.gov/sp/sw/t1/documents/essaassistance25.xlsx';
const WORDS = {
  'No Status': 'Not identified for support',
  'TSI': 'Targeted Support and Improvement (TSI)',
  'ATSI': 'Additional Targeted Support and Improvement (ATSI)',
  'CSI Low Perform': 'Comprehensive Support and Improvement (CSI): low performance',
  'CSI Grad': 'Comprehensive Support and Improvement (CSI): low graduation rate',
};

export default {
  scheme: 'us-ca-essa', juris: ['US-CA'], sources: ['ccd'], floor: 0.75,
  record: {
    kind: 'status',
    title: 'California federal support status (CDE)',
    short: 'ESSA assistance status — not a rating',
    scale: 'California does not give schools an overall rating. Under the federal Every Student Succeeds Act it identifies some schools for support: Comprehensive (CSI), Targeted (TSI) or Additional Targeted (ATSI) Support and Improvement. Most schools are not identified.',
    measures: 'Identification comes from the California School Dashboard indicators (test results, graduation, chronic absence, suspensions, English learner progress, college and career readiness).',
    caveat: 'This is not a rating. The Dashboard reports each indicator separately and does not combine them.',
    year: YEAR,
    publisher: 'California Department of Education',
    attribution: 'California Department of Education, 2025-26 ESSA Assistance Status data file.',
    url: 'https://www.cde.ca.gov/sp/sw/t1/essaassistdatafiles.asp',
    values: Object.values(WORDS),
    miss: '{place} publishes this status for its public schools, but this school is not in its {year} file.',
    notes: [{ when: {}, html: 'See the <a href="https://www.caschooldashboard.org/" target="_blank" rel="noopener">California School Dashboard ↗</a> for the separate indicators.' }],
  },
  async build(ctx) {
    const ids = await stateIds(ctx);
    let buf;
    for (let i = 0; i < 4 && !buf; i++) {
      try {
        buf = await ctx.download('essaassistance25.xlsx', URL, { maxAgeH: 24 * 30 });
        if (buf.subarray(0, 2).toString() !== 'PK') throw new Error('not an xlsx (a Radware challenge page?)');
      } catch (e) { buf = null; ctx.warn(`attempt ${i + 1}: ${e.message}`); await new Promise(r => setTimeout(r, 5000)); }
    }
    if (!buf) throw new Error('CDE essaassistance25.xlsx unreachable — keep the committed map');
    const wb = xlsx(buf);
    const sheet = wb.sheets.find(s => /ESSA State Schools/i.test(s));
    if (!sheet) throw new Error(`CA workbook: no "ESSA State Schools" sheet (${wb.sheets.join(', ')})`);
    const recs = sheetRecords(wb.rows(sheet), h => h[0] === 'cds', ['cds', 'schoolname', 'AssistanceStatus2025', 'ReportingYear'], 'CA ESSA');
    const byCds = new Map(), bySchool = new Map();
    for (const r of recs) {
      if (r.ReportingYear !== '2025' || !/^\d{14}$/.test(r.cds)) continue;
      const v = WORDS[r.AssistanceStatus2025];
      if (v === undefined) throw new Error(`CA status "${r.AssistanceStatus2025}" is new — add its wording`);
      byCds.set(r.cds, v);
      const sc = r.cds.slice(7);
      if (sc !== '0000000') bySchool.set(sc, bySchool.has(sc) ? null : v);   // null = not unique: never used
    }
    if (byCds.size < 9000) throw new Error(`only ${byCds.size} CA schools — layout changed?`);
    const values = joinRatings(ctx, ids, s => (s.parts.length === 3 ? `${s.parts[1]}${s.parts[2]}` : null), k => {
      if (byCds.has(k)) return byCds.get(k);
      const v = bySchool.get(k.slice(7));
      if (v == null) return undefined;
      ctx.stat('schoolCodeMatch');
      return v;
    });
    return { values, vintage: `${YEAR} (CDE essaassistance25.xlsx, ReportingYear 2025)` };
  },
};
