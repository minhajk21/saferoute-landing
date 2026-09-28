// Michigan: Michigan School Index, 2024-25 (Detroit).
//   node tools/schools/ratings.mjs --scheme us-mi-index
// File: MDE "202425_School_Index_Results.xlsx" (OverallIndex 0-100, and the
// federal support category). michigan.gov's Akamai refuses curl/python user
// agents; an EMPTY user agent is accepted (DESIGN.md §7 R3).
// Join: 5-digit BuildingCode = last ST_SCHID segment ("MI-82015-02479").
// Verified: Detroit 285/290.
import { xlsx, sheetRecords, stateIds, joinRatings, lastSeg, assertValues, num, MISS } from './_us.mjs';

const YEAR = '2024-25';
const URL = 'https://www.michigan.gov/mde/-/media/Project/Websites/mde/OEAA/Accountability/Index/202425_School_Index_Results.xlsx';
const SUPPORT = ['Comprehensive Support and Improvement', 'Targeted Support and Improvement', 'Additional Targeted Support'];

export default {
  scheme: 'us-mi-index', juris: ['US-MI'], sources: ['ccd'], floor: 0.9,
  record: {
    kind: 'rating',
    title: 'Michigan School Index (MDE)',
    short: 'Michigan School Index, 0–100',
    scale: 'An index from 0 to 100. Where Michigan also identifies the school for federal support (Comprehensive, Targeted or Additional Targeted), that is shown after the index.',
    measures: 'Growth, proficiency, graduation, English learner progress, school quality (such as attendance) and test participation.',
    caveat: '',
    year: YEAR,
    publisher: 'Michigan Department of Education',
    attribution: 'Michigan Department of Education, 2024-25 School Index Results.',
    url: 'https://www.michigan.gov/mde/services/school-performance-supports/accountability',
    miss: MISS('index'),
  },
  async build(ctx) {
    const ids = await stateIds(ctx);
    const wb = xlsx(await ctx.download('202425_School_Index_Results.xlsx', URL, { maxAgeH: 24 * 30, ua: '' }));
    const recs = sheetRecords(wb.rows(0), 0, ['SchoolYear', 'BuildingCode', 'BuildingName', 'OverallIndex', 'SupportCategoryName', 'SchoolStatus'], 'MI School Index');
    const byKey = new Map();
    for (const r of recs) {
      if (r.SchoolYear !== '2024-2025') continue;
      const idx = num(r.OverallIndex, 2);
      const sup = r.SupportCategoryName;
      if (sup && sup !== 'Universal Support' && !SUPPORT.includes(sup)) throw new Error(`MI support category "${sup}" is new`);
      byKey.set(r.BuildingCode.padStart(5, '0'), idx ? (SUPPORT.includes(sup) ? `${idx} · ${sup}` : idx) : '');
    }
    if (byKey.size < 3000) throw new Error(`only ${byKey.size} MI schools — layout changed?`);
    const values = joinRatings(ctx, ids, s => lastSeg(s).padStart(5, '0'), k => byKey.get(k));
    assertValues(values, new RegExp(`^\\d{1,3}(\\.\\d{1,2})?( · (${SUPPORT.join('|')}))?$`), 'MI index');
    return { values, vintage: `${YEAR} (MDE School Index results)` };
  },
};
