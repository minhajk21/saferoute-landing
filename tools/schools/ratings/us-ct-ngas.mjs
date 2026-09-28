// Connecticut: Next Generation Accountability System category, 2024-25 (Hartford).
//   node tools/schools/ratings.mjs --scheme us-ct-ngas
// Source: CSDE "Next Generation Accountability" open data on data.ct.gov
// (Socrata h28j-iix5, Public Domain), rows schoolyear=2024-25, field finalcategory.
// Join: 7-digit schoolcode = last ST_SCHID segment ("CT-0640011-0641311").
// Verified: Hartford 46/51 (the misses are juvenile-justice and pre-K centres).
import { stateIds, joinRatings, lastSeg, MISS } from './_us.mjs';

const YEAR = '2024-25';
const API = 'https://data.ct.gov/resource/h28j-iix5.json';

export default {
  scheme: 'us-ct-ngas', juris: ['US-CT'], sources: ['ccd'], floor: 0.8,
  record: {
    kind: 'rating',
    title: 'Connecticut accountability category (CSDE)',
    short: 'Next Generation Accountability category',
    scale: 'Category 1 (highest) to Category 5. Categories 1 to 3 follow the school\u2019s accountability index; schools identified for state support (Focus or Turnaround) are in Categories 4 and 5.',
    measures: 'Twelve indicators: test achievement and growth, attendance, graduation, college and career readiness, arts access and physical fitness.',
    caveat: 'A lower category number is better.',
    year: YEAR,
    publisher: 'Connecticut State Department of Education',
    attribution: 'Connecticut State Department of Education, Next Generation Accountability System 2024-25 (data.ct.gov).',
    licence: 'Public Domain (data.ct.gov dataset licence)',
    url: 'https://portal.ct.gov/sde/performance/performance-and-accountability/next-generation-accountability-system',
    values: ['Category 1', 'Category 2', 'Category 3', 'Category 4', 'Category 5'],
    miss: MISS('category'),
  },
  async build(ctx) {
    const ids = await stateIds(ctx);
    const q = `${API}?$limit=50000&schoolyear=${encodeURIComponent(YEAR)}`;
    const rows = JSON.parse(await ctx.download(`ngas-${YEAR}.json`, q, { maxAgeH: 24 * 30 }));
    if (!Array.isArray(rows) || rows.length < 900) throw new Error(`CT NGAS returned ${rows?.length} rows — API changed?`);
    const byKey = new Map();
    for (const r of rows) {
      if (!r.schoolcode) continue;
      const c = String(r.finalcategory ?? '').trim();
      byKey.set(r.schoolcode.padStart(7, '0'), /^[1-5]$/.test(c) ? `Category ${c}` : '');
    }
    const values = joinRatings(ctx, ids, s => lastSeg(s).padStart(7, '0'), k => byKey.get(k));
    return { values, vintage: `${YEAR} (data.ct.gov h28j-iix5)` };
  },
};
