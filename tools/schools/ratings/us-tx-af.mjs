// Texas: TEA A–F accountability rating, 2026 (school year 2025-26)
// (Dallas, Fort Worth, Houston). SHOWN with TEA attribution and a link: the
// owner accepted the risk in TEA's copyright notice (DESIGN.md Q2).
//   node tools/schools/ratings.mjs --scheme us-tx-af
// File: TEA "2026 statewide multi-year ratings spreadsheet" (18.6MB), first
// sheet ("2011-2026 Summary"), campus rows, column "2026 Overall Rating".
// 2026 ratings can change on appeal: re-run after TEA posts final appeal results.
// Join: 9-digit campus number = last ST_SCHID segment ("TX-057905-057905116").
// Verified: Dallas 677/699, Houston 1,253/1,288, Fort Worth 301/314.
import { xlsx, sheetRecords, stateIds, joinRatings, lastSeg, MISS } from './_us.mjs';

const YEAR = '2026';
const URL = 'https://tea.texas.gov/school-and-district-leaders/accountability/academic-accountability/performance-reporting/2026-statewide-multi-year-ratings-spreadsheet.xlsx';
const VALUES = ['A', 'B', 'C', 'D', 'F', 'Not Rated'];

export default {
  scheme: 'us-tx-af', juris: ['US-TX'], sources: ['ccd'], floor: 0.9,
  record: {
    kind: 'rating',
    title: 'Texas school rating (TEA)',
    short: 'A–F accountability rating',
    scale: 'A (highest) to F, or Not Rated.',
    measures: 'Mostly STAAR test results (achievement, progress and closing gaps between student groups); high schools also count graduation and college, career and military readiness.',
    caveat: '2026 ratings can still change on appeal. Alternative-education campuses are rated under different rules. Rating data © Texas Education Agency.',
    year: YEAR,
    publisher: 'Texas Education Agency',
    attribution: '\u00a9 Texas Education Agency, 2026 statewide multi-year ratings.',
    licence: '\u00a9 Texas Education Agency (TEA copyright notice; shown with attribution and a link, by owner decision)',
    url: 'https://tea.texas.gov/school-and-district-leaders/accountability/academic-accountability/performance-reporting/2026-accountability-rating-system',
    values: VALUES,
    miss: MISS('rating'),
  },
  async build(ctx) {
    const ids = await stateIds(ctx);
    const wb = xlsx(await ctx.download('2026-statewide-multi-year-ratings-spreadsheet.xlsx', URL, { maxAgeH: 24 * 14 }));
    const recs = sheetRecords(wb.rows(0), 0, ['Campus Number', 'Campus', '2026 Overall Rating'], 'TX multi-year summary');
    const byKey = new Map(), odd = new Set();
    for (const r of recs) {
      if (!/^\d{9}$/.test(r['Campus Number'])) continue;              // district rows have no campus number
      const raw = r['2026 Overall Rating'];
      // TEA words every unrated campus "Not Rated" (sometimes with a reason after a colon).
      const v = VALUES.includes(raw) ? raw : /^Not Rated\b/i.test(raw) ? 'Not Rated' : '';
      if (raw && !v) odd.add(raw);
      byKey.set(r['Campus Number'], v);
    }
    if (odd.size) throw new Error(`TX 2026 rating value(s) not understood: ${[...odd].join(' | ')}`);
    if (byKey.size < 8500) throw new Error(`only ${byKey.size} TX campuses — layout changed?`);
    const values = joinRatings(ctx, ids, s => lastSeg(s).padStart(9, '0'), k => byKey.get(k));
    return { values, vintage: `${YEAR} (TEA 2026 statewide multi-year ratings spreadsheet)` };
  },
};
