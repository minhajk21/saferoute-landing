// New York: ESSA accountability status, 2025-26 — a STATUS, NOT A RATING (NYC).
//   node tools/schools/ratings.mjs --scheme us-ny-essa
// File: NYSED "2025-26 NYS Accountability Statuses" workbook (0.7MB, linked
// from every school's page on data.nysed.gov): one sheet per status — "LSI
// Schools", "TSI Schools", "ATSI Schools", "CSI Schools" — keyed by School
// BEDS Code.
// This REPLACES the design's route (SRC2025.zip, 390MB -> a 1.6GB Access
// database read with Python access-parser): checked 2026-09-27, the workbook
// and the database's "Accountability Status" table (YEAR 2025 = "2025-26
// accountability statuses based on 2024-25 results") list the same 4,660
// schools with 0 differences, so the map needs no Python and no 390MB download.
// Join: 12-digit BEDS code = ENTITY_CD = last ST_SCHID segment
// ("NY-320700010000-320700010154"). Verified: NYC 1,894/1,964 (LSI 1,800,
// CSI 78, TSI 12, ATSI 4).
import { xlsx, sheetRecords, stateIds, joinRatings, lastSeg } from './_us.mjs';

const YEAR = '2025-26';
const URL = 'https://data.nysed.gov/files/essa/24-25/2025-26NYSAccountabilityStatuses.xlsx';
const SHEETS = {
  'LSI Schools': 'Local Support and Improvement',
  'TSI Schools': 'Targeted Support and Improvement (TSI)',
  'ATSI Schools': 'Additional Targeted Support and Improvement (ATSI)',
  'CSI Schools': 'Comprehensive Support and Improvement (CSI)',
};

export default {
  scheme: 'us-ny-essa', juris: ['US-NY'], sources: ['ccd'], floor: 0.9,
  record: {
    kind: 'status',
    title: 'New York federal accountability status (NYSED)',
    short: 'ESSA accountability status — not a rating',
    scale: 'Under the federal Every Student Succeeds Act, New York identifies some schools for extra support: Comprehensive (CSI), Targeted (TSI) or Additional Targeted (ATSI) Support and Improvement. Most schools are in "Local Support and Improvement", meaning they are not identified.',
    measures: 'Identification uses state test performance and growth, graduation, English language proficiency progress, chronic absence and college, career and civic readiness.',
    caveat: 'This is not a rating.',
    year: YEAR,
    publisher: 'New York State Education Department',
    attribution: 'New York State Education Department, 2025-26 NYS Accountability Statuses.',
    url: 'https://data.nysed.gov/',
    values: Object.values(SHEETS),
    miss: '{place} publishes this status for its public schools, but this school is not in its {year} file.',
  },
  async build(ctx) {
    const ids = await stateIds(ctx);
    const wb = xlsx(await ctx.download('2025-26NYSAccountabilityStatuses.xlsx', URL, { maxAgeH: 24 * 30 }));
    const byKey = new Map();
    for (const [sheet, words] of Object.entries(SHEETS)) {
      const recs = sheetRecords(wb.rows(sheet), h => h.includes('School BEDS Code'), ['School BEDS Code', 'School Name'], `NY ${sheet}`);
      for (const r of recs) {
        const k = r['School BEDS Code'];
        if (!/^\d{12}$/.test(k)) continue;
        if (byKey.has(k)) throw new Error(`NY: ${k} is on two status sheets`);
        byKey.set(k, words);
      }
    }
    if (byKey.size < 4000) throw new Error(`only ${byKey.size} NY schools — layout changed?`);
    const values = joinRatings(ctx, ids, s => lastSeg(s), k => byKey.get(k));
    return { values, vintage: `${YEAR} (NYSED 2025-26 NYS Accountability Statuses)` };
  },
};
