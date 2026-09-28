// District of Columbia: DC School Report Card accountability score, 2024-25.
//   node tools/schools/ratings.mjs --scheme us-dc-score
// File: OSSE "DC School Report Card Accountability Scores (2025).xlsx", sheet
// "School Scores" (School Score, 0-100; School Year 2024-25). OSSE retired its
// 1-5 star ratings, so the score is the whole summative measure.
// Join: OSSE School Code = ST_SCHID segment 3 ("DC-001-203" -> 203), as integers.
// Verified: 199/243 matched (DC 2025 file has 200 scored schools; alternative,
// adult and some Friendship PCS campuses are not scored).
import { xlsx, sheetRecords, stateIds, joinRatings, assertValues, num } from './_us.mjs';

const YEAR = '2024-25';
const URL = 'https://osse.dc.gov/sites/default/files/dc/sites/osse/page_content/attachments/DC%20School%20Report%20Card%20Accountability%20Scores%20%282025%29.xlsx';

export default {
  scheme: 'us-dc-score', juris: ['US-DC'], sources: ['ccd'], floor: 0.75,
  record: {
    kind: 'rating',
    title: 'DC School Report Card score (OSSE)',
    short: 'accountability score, out of 100',
    scale: 'Points out of 100 on the District of Columbia’s school accountability framework.',
    measures: 'State test achievement and growth, chronic absence and attendance growth, re-enrollment, English learner progress, pre-K classroom observations and, for high schools, graduation, SAT and advanced coursework.',
    caveat: 'DC no longer publishes star ratings.',
    year: YEAR,
    publisher: 'Office of the State Superintendent of Education (OSSE)',
    attribution: 'Office of the State Superintendent of Education, DC School Report Card Accountability Scores (2025).',
    url: 'https://osse.dc.gov/page/dc-school-report-card-resource-library',
    // "Not in the file" was untrue for 30 of the 42 unscored DC schools: OSSE's
    // workbook gives them a score on part of the framework (sheet "Framework
    // Scores", 3-50 of the ~95-100 points possible) but no overall School
    // Score (sheet "School Scores", the one shown). That partial score is never
    // shown as the rating.
    miss: 'OSSE’s {year} file gives this school no overall School Score. Early-childhood and early-grade campuses are often scored on only part of the framework and given no overall score, and alternative, adult and special education settings are often not scored.',
  },
  async build(ctx) {
    const ids = await stateIds(ctx);
    const wb = xlsx(await ctx.download('dc-accountability-scores-2025.xlsx', URL, { maxAgeH: 24 * 30 }));
    const recs = sheetRecords(wb.rows('School Scores'), 0, ['LEA Code', 'School Code', 'School Name', 'School Score', 'School Year'], 'DC School Scores');
    const byKey = new Map();
    for (const r of recs) {
      if (r['School Year'] !== YEAR) continue;
      const s = num(r['School Score'], 1);
      byKey.set(String(+r['School Code']), s ? (s.includes('.') ? s : `${s}.0`) : '');
    }
    if (byKey.size < 150) throw new Error(`only ${byKey.size} DC schools scored — layout changed?`);
    const values = joinRatings(ctx, ids, s => (s.parts.length === 3 ? String(+s.parts[2]) : null), k => byKey.get(k));
    assertValues(values, /^\d{1,3}\.\d$/, 'DC score');
    for (const v of Object.values(values)) if (+v.rv > 100) throw new Error(`DC score ${v.rv} over 100`);
    return { values, vintage: `${YEAR} (OSSE Accountability Scores 2025)` };
  },
};
