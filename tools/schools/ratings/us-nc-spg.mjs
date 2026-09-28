// North Carolina: School Performance Grade (SPG), 2024-25 (Charlotte).
//   node tools/schools/ratings.mjs --scheme us-nc-spg
// File: NCDPI School Report Card "SRC data set 2024-25, 1 of 2" (a 202MB zip)
// -> rcd_acc_spg2.xlsx, rows year=2025 (= school year 2024-25), subgroup ALL,
// column spg_grade. Heavy, so this map is refreshed by hand only (DESIGN.md §0.7).
// 2025-26 grades exist only in an NCDPI dashboard, not as open data (§7 R5).
// Join: agency_code = ST_SCHID segments 2 + 3 ("NC-600-301" -> "600301";
// charters "NC-60D-000" -> "60D000"). Verified: Charlotte 308/308, 299 graded.
// A school NCDPI lists with no grade (alternative-model and K-2 schools,
// masked cells) gets no value: the pane's miss line says so.
import { xlsx, sheetRecords, unzip, stateIds, joinRatings, MISS } from './_us.mjs';

const YEAR = '2024-25';
const URL = 'https://www.dpi.nc.gov/src-data-set-2024-251-2/open';

export default {
  scheme: 'us-nc-spg', juris: ['US-NC'], sources: ['ccd'], floor: 0.9,
  record: {
    kind: 'rating',
    title: 'North Carolina School Performance Grade (NCDPI)',
    short: 'School Performance Grade',
    scale: 'A (highest) to F.',
    measures: 'Mostly achievement: 80% is test scores and other achievement measures, 20% is student growth.',
    caveat: 'Grades closely track how many students are from low-income families.',
    year: YEAR,
    publisher: 'North Carolina Department of Public Instruction',
    attribution: 'North Carolina Department of Public Instruction, School Report Card data set 2024-25 (School Performance Grades).',
    url: 'https://www.dpi.nc.gov/data-reports/school-report-cards/school-report-card-resources-researchers',
    values: ['A', 'B', 'C', 'D', 'F'],
    miss: MISS('grade'),
  },
  async build(ctx) {
    const ids = await stateIds(ctx);
    const zip = unzip(await ctx.download('src_datasets_2425_1_of_2.zip', URL, { maxAgeH: 24 * 90, timeoutMs: 900_000 }));
    const member = zip.names.find(n => /(^|\/)rcd_acc_spg2\.xlsx$/i.test(n));
    if (!member) throw new Error(`rcd_acc_spg2.xlsx not in the SRC zip (has ${zip.names.length} files) — NCDPI moved it`);
    const recs = sheetRecords(xlsx(zip.read(member)).rows(0), 0, ['year', 'agency_code', 'subgroup', 'spg_grade'], 'NC rcd_acc_spg2');
    const byKey = new Map();
    for (const r of recs) if (r.year === '2025' && r.subgroup === 'ALL') byKey.set(r.agency_code.toUpperCase(), r.spg_grade.trim());
    if (byKey.size < 2500) throw new Error(`only ${byKey.size} NC schools for 2025 — layout changed?`);
    const values = joinRatings(ctx, ids, s => (s.parts.length === 3 ? `${s.parts[1]}${s.parts[2]}`.toUpperCase() : null),
      k => byKey.get(k));
    return { values, vintage: `${YEAR} (NCDPI SRC data set, rcd_acc_spg2 year 2025)` };
  },
};
