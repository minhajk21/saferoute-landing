// Tennessee: TDOE School Letter Grades, 2024-25 (Memphis, Nashville).
//   node tools/schools/ratings.mjs --scheme us-tn-af
// File: TDOE "2024-25 A-F Letter Grade File" (one sheet, one row per school).
// Join: (system, school) as integers = ST_SCHID "TN-00792-0015" segments 2 + 3.
// Verified (DESIGN.md §1b): Memphis 248/248, Nashville 236/239 matched.
import { xlsx, sheetRecords, stateIds, joinRatings, MISS } from './_us.mjs';

const YEAR = '2024-25';
const URL = 'https://www.tn.gov/content/dam/tn/education/data/2024-25_A-F_Letter_Grade_File.xlsx';

export default {
  scheme: 'us-tn-af', juris: ['US-TN'], sources: ['ccd'], floor: 0.9,
  record: {
    kind: 'rating',
    title: 'Tennessee school letter grade (TDOE)',
    short: 'A–F school letter grade',
    scale: 'A (highest) to F. A school with too few tested students is "Not Eligible for a Letter Grade".',
    measures: 'Half of the grade is achievement on state tests; most of the rest is student growth, and high schools also count college and career readiness.',
    caveat: '',
    year: YEAR,
    publisher: 'Tennessee Department of Education',
    attribution: 'Tennessee Department of Education, 2024-25 A-F Letter Grade File.',
    url: 'https://www.tn.gov/education/schoollettergrades.html',
    values: ['A', 'B', 'C', 'D', 'F', 'Not Eligible for a Letter Grade'],
    miss: MISS('letter grade'),
  },
  async build(ctx) {
    const ids = await stateIds(ctx);
    const wb = xlsx(await ctx.download('2024-25_A-F_Letter_Grade_File.xlsx', URL, { maxAgeH: 24 * 30 }));
    const recs = sheetRecords(wb.rows(0), 0, ['year', 'system', 'school', 'school_name', 'lg_grade'], 'TN A-F file');
    const byKey = new Map();
    for (const r of recs) {
      if (r.year !== '2025') continue;                       // TDOE labels the 2024-25 file year 2025
      byKey.set(`${+r.system}-${+r.school}`, r.lg_grade);
    }
    if (byKey.size < 1500) throw new Error(`only ${byKey.size} TN schools in the file — layout changed?`);
    const values = joinRatings(ctx, ids, s => (s.parts.length === 3 ? `${+s.parts[1]}-${+s.parts[2]}` : null),
      k => (byKey.has(k) ? byKey.get(k).trim() : undefined));
    return { values, vintage: `${YEAR} (TDOE A-F Letter Grade File)` };
  },
};
