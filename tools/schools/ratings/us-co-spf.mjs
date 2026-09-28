// Colorado: School Performance Framework (SPF) plan type, 2026 PRELIMINARY (Denver).
//   node tools/schools/ratings.mjs --scheme us-co-spf
// File: CDE "SPF 2026 Preliminary Ratings Over Time" workbook, sheet
// "SPF Ratings 2019-2026", column 2026_PRELIMINARY_RATING. CDE finalises the
// ratings in December 2026: re-run this map then, and change YEAR/wording from
// "preliminary" to final (the same file carries 2025_FINAL_RATING).
// Join: (district, school) as integers = ST_SCHID "CO-0880-1234" segments 2 + 3.
// Verified: Denver box 334/365 (misses are pre-K centres, youth services
// centres and new schools).
import { xlsx, sheetRecords, stateIds, joinRatings, MISS } from './_us.mjs';

const YEAR = '2026 (preliminary)';
const URL = 'https://ed.cde.state.co.us/fs/resource-manager/view/db2f0270-ba47-4b01-b5fb-298da02de1d8';

// CDE's own plan-type words. "School Closed" is not a rating and is dropped.
const VALUES = [
  'Performance Plan', 'Improvement Plan', 'Priority Improvement Plan', 'Turnaround Plan',
  'Improvement Plan: Decreased due to Participation', 'Priority Improvement Plan: Decreased due to Participation',
  'Turnaround Plan: Decreased due to Participation',
  'AEC: Performance', 'AEC: Improvement', 'AEC: Priority Improvement', 'AEC: Turnaround', 'AEC: Insufficient State Data',
  'Insufficient State Data', 'Insufficient State Data: Low Participation', 'Insufficient State Data: Small Tested Population',
  'Insufficient State Data: No Students at Grade Levels Tested for State Assessments', 'New School',
];
const AEC = VALUES.filter(v => v.startsWith('AEC:'));

export default {
  scheme: 'us-co-spf', juris: ['US-CO'], sources: ['ccd'], floor: 0.85,
  record: {
    kind: 'rating',
    title: 'Colorado school plan type (CDE)',
    short: 'School Performance Framework plan type',
    scale: 'Performance, Improvement, Priority Improvement or Turnaround plan (Performance is highest). It sets the kind of improvement plan a school must file; it is a planning category, not a grade.',
    measures: 'State test (CMAS, PSAT and SAT) achievement and growth and, for high schools, graduation, dropout and college matriculation rates.',
    caveat: 'These 2026 ratings are preliminary and may still change through Colorado\u2019s request-to-reconsider process; final ratings are expected at the end of 2026.',
    year: YEAR,
    publisher: 'Colorado Department of Education',
    attribution: 'Colorado Department of Education, 2026 Preliminary School Performance Framework ratings.',
    url: 'https://ed.cde.state.co.us/accountability/performanceframeworks/results',
    values: VALUES,
    miss: MISS('plan type'),
    notes: [{ when: { rv: AEC }, html: '"AEC" means an Alternative Education Campus, rated on a separate framework.' }],
  },
  async build(ctx) {
    const ids = await stateIds(ctx);
    const wb = xlsx(await ctx.download('SPF2026_PreliminaryRatingsOverTime.xlsx', URL, { maxAgeH: 24 * 14 }));
    const sheet = wb.sheets.find(s => /^SPF Ratings/i.test(s));
    if (!sheet) throw new Error(`CO workbook has no "SPF Ratings" sheet (${wb.sheets.join(', ')})`);
    const recs = sheetRecords(wb.rows(sheet), h => h.includes('DISTRICT_NUMBER') && h.includes('SCHOOL_NUMBER'),
      ['DISTRICT_NUMBER', 'SCHOOL_NUMBER', 'SCHOOL_NAME', '2026_PRELIMINARY_RATING'], 'CO SPF');
    const byKey = new Map();
    for (const r of recs) {
      const v = r['2026_PRELIMINARY_RATING'];
      if (v && v !== 'School Closed' && !VALUES.includes(v)) throw new Error(`CO plan type "${v}" is new — add it after checking CDE's wording`);
      byKey.set(`${+r.DISTRICT_NUMBER}-${+r.SCHOOL_NUMBER}`, v === 'School Closed' ? '' : v);
    }
    if (byKey.size < 1600) throw new Error(`only ${byKey.size} CO schools — layout changed?`);
    const values = joinRatings(ctx, ids, s => (s.parts.length === 3 ? `${+s.parts[1]}-${+s.parts[2]}` : null), k => byKey.get(k));
    return { values, vintage: '2026 preliminary (CDE SPF, posted 2026-09)' };
  },
};
