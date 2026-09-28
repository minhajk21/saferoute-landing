// Massachusetts: DESE accountability classification, 2026 (Boston box).
//   node tools/schools/ratings.mjs --scheme us-ma-class
// File: DESE "2026 Accountability Determinations" workbook, sheet
// "Table 2 - Schools": School Overall Classification + Reason for School
// Classification, shown together in DESE's own words (DESE's summary tables
// print them as "Not requiring assistance or intervention: Meeting or
// exceeding targets").
// Join: 8-digit School Code = last ST_SCHID segment ("MA-0035-00350012").
// Verified: 232/238 in the box (2025 file: 238/238).
import { xlsx, sheetRecords, stateIds, joinRatings, lastSeg, MISS } from './_us.mjs';

const YEAR = '2026';
const URL = 'https://www.doe.mass.edu/accountability/lists-tools/accountability-data-2026.xlsx';

const NOT = 'Not requiring assistance or intervention', REQ = 'Requiring assistance or intervention';
const VALUES = [
  ...['School of Recognition', 'Meeting or exceeding targets', 'Substantial progress toward targets', 'Moderate progress toward targets', 'Limited or no progress toward targets']
    .map(r => `${NOT}: ${r}`),
  ...['In need of focused/targeted support', 'In need of broad/comprehensive support'].map(r => `${REQ}: ${r}`),
  'Insufficient data',
];

export default {
  scheme: 'us-ma-class', juris: ['US-MA'], sources: ['ccd'], floor: 0.9,
  record: {
    kind: 'rating',
    title: 'Massachusetts accountability classification (DESE)',
    short: 'accountability classification',
    scale: 'Schools are "Not requiring assistance or intervention" (from School of Recognition and meeting targets down to limited or no progress) or "Requiring assistance or intervention" (focused/targeted or broad/comprehensive support).',
    measures: 'Progress toward state targets on test achievement and growth, English learner progress, chronic absence, graduation and advanced coursework.',
    caveat: 'Based on progress toward targets, not a ranking.',
    year: YEAR,
    publisher: 'Massachusetts Department of Elementary and Secondary Education',
    attribution: 'Massachusetts Department of Elementary and Secondary Education, 2026 Accountability Determinations.',
    url: 'https://www.doe.mass.edu/accountability/lists-tools/',
    values: VALUES,
    miss: MISS('classification'),
  },
  async build(ctx) {
    const ids = await stateIds(ctx);
    const wb = xlsx(await ctx.download('accountability-data-2026.xlsx', URL, { maxAgeH: 24 * 30 }));
    const recs = sheetRecords(wb.rows('Table 2 - Schools'), h => h.includes('School Code') && h.includes('School Overall Classification'),
      ['School Code', 'School Name', 'School Overall Classification', 'Reason for School Classification'], 'MA Table 2');
    const byKey = new Map();
    for (const r of recs) {
      const cls = r['School Overall Classification'], why = r['Reason for School Classification'];
      if (!/^\d{8}$/.test(r['School Code'])) continue;
      const v = cls === 'Insufficient data' ? 'Insufficient data' : cls && why ? `${cls}: ${why}` : '';
      if (v && !VALUES.includes(v)) throw new Error(`MA classification "${v}" is new — add it to VALUES after checking DESE's wording`);
      byKey.set(r['School Code'], v);
    }
    if (byKey.size < 1500) throw new Error(`only ${byKey.size} MA schools — layout changed?`);
    const values = joinRatings(ctx, ids, s => lastSeg(s), k => byKey.get(k));
    return { values, vintage: `${YEAR} (DESE accountability determinations, Table 2)` };
  },
};
