// Illinois: ISBE Summative Designation, 2025 (school year 2024-25) (Chicago).
//   node tools/schools/ratings.mjs --scheme us-il-sd
// File: ISBE "2025 Report Card Public Data Set" (40MB workbook; revised up to
// v8, 2026-05-14), sheet "General", column "Summative Designation".
// Join: RCDTS without hyphens = the last ST_SCHID segment, KEEPING a trailing
// "C" where both carry one (the verifier's fix: 996/1,081 in the box, not 876).
import { xlsx, sheetRecords, stateIds, joinRatings, lastSeg, MISS } from './_us.mjs';

const YEAR = '2025';
const URL = 'https://www.isbe.net/Documents/2025-Report-Card-Public-Data-Set.xlsx';
const VALUES = ['Exemplary', 'Commendable', 'Targeted', 'Comprehensive', 'Intensive'];

export default {
  scheme: 'us-il-sd', juris: ['US-IL'], sources: ['ccd'], floor: 0.85,
  record: {
    kind: 'rating',
    title: 'Illinois summative designation (ISBE)',
    short: 'summative designation',
    scale: 'Exemplary (top 10%), Commendable, Targeted, Comprehensive or Intensive; the last three mean the school is identified for support.',
    measures: 'State test proficiency and growth, English learner progress, chronic absence, graduation, ninth-grade on-track and school climate.',
    caveat: 'Most Illinois schools are Commendable.',
    year: YEAR,
    publisher: 'Illinois State Board of Education',
    attribution: 'Illinois State Board of Education, 2025 Report Card Public Data Set.',
    url: 'https://www.illinoisreportcard.com/',
    values: VALUES,
    miss: MISS('designation'),
  },
  async build(ctx) {
    const ids = await stateIds(ctx);
    const wb = xlsx(await ctx.download('2025-Report-Card-Public-Data-Set.xlsx', URL, { maxAgeH: 24 * 30, timeoutMs: 600_000 }));
    const recs = sheetRecords(wb.rows('General'), 0, ['RCDTS', 'Level', 'School Name', 'Summative Designation'], 'IL General');
    const byKey = new Map();
    for (const r of recs) {
      if (r.Level !== 'School') continue;
      const v = r['Summative Designation'];
      if (v && !VALUES.includes(v)) throw new Error(`IL designation "${v}" is new`);
      byKey.set(r.RCDTS.replace(/-/g, '').toUpperCase(), v);
    }
    if (byKey.size < 3500) throw new Error(`only ${byKey.size} IL schools — layout changed?`);
    const values = joinRatings(ctx, ids, s => lastSeg(s).toUpperCase(), k => byKey.get(k));
    return { values, vintage: `${YEAR} (ISBE Report Card Public Data Set, General)` };
  },
};
