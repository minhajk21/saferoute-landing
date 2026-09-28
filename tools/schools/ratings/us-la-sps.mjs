// Louisiana: School Performance Score letter grade, 2025 (2024-25) (New Orleans).
//   node tools/schools/ratings.mjs --scheme us-la-sps
// File: LDOE "2025-school-performance-scores.xlsx": sheets "School" and
// "Alternative School" (new alternative formula), plus "Closed School" and
// "Closed School Alt" (schools graded for 2025 that have since closed).
// Join: 6-character site code = last ST_SCHID segment ("LA-W71-W71001"), then
// an EXACT normalised-name fallback (case, punctuation and spacing only), used
// only when the name is unique in the LDOE file: Orleans charters were
// re-coded, so the code misses many (verifier: 78/123 by code, 117/123 with
// names). Every name match is logged and counted in meta.stats.nameMatch.
import { xlsx, sheetRecords, stateIds, joinRatings, lastSeg, nameKey, MISS } from './_us.mjs';

const YEAR = '2025';
const URL = 'https://doe.louisiana.gov/docs/default-source/data-management/2025-school-performance-scores.xlsx';
const ALT = ' (alternative school formula)';
const VALUES = ['A', 'B', 'C', 'D', 'F', ...['A', 'B', 'C', 'D', 'F'].map(g => g + ALT)];

export default {
  scheme: 'us-la-sps', juris: ['US-LA'], sources: ['ccd'], floor: 0.85,
  record: {
    kind: 'rating',
    title: 'Louisiana school letter grade (LDOE)',
    short: 'School Performance Score letter grade',
    scale: 'A (highest) to F, from the school’s School Performance Score.',
    measures: 'Mostly state test achievement and progress; high schools also count ACT results, strength of diploma and graduation.',
    caveat: 'Alternative schools are graded with a separate formula and are marked as such.',
    year: YEAR,
    publisher: 'Louisiana Department of Education',
    attribution: 'Louisiana Department of Education, 2025 School Performance Scores.',
    url: 'https://doe.louisiana.gov/data-and-reports/performance-scores',
    values: VALUES,
    miss: MISS('letter grade'),
  },
  async build(ctx) {
    const ids = await stateIds(ctx);
    const wb = xlsx(await ctx.download('2025-school-performance-scores.xlsx', URL, { maxAgeH: 24 * 30 }));
    const byCode = new Map(), byName = new Map();
    for (const sheet of ['School', 'Alternative School', 'Closed School', 'Closed School Alt']) {
      if (!wb.sheets.includes(sheet)) throw new Error(`LA workbook has no "${sheet}" sheet (${wb.sheets.join(', ')})`);
      const alt = /Alt/.test(sheet);
      const recs = sheetRecords(wb.rows(sheet), h => h[0] === 'Site Code', ['Site Code', 'School'], `LA ${sheet}`);
      const gradeCol = Object.keys(recs[0] || {}).find(k => /^2025 Letter Grade/.test(k));
      if (!gradeCol) throw new Error(`LA ${sheet}: no "2025 Letter Grade" column`);
      for (const r of recs) {
        if (!/^[A-Z0-9]{6}$/.test(r['Site Code'])) continue;
        const g = r[gradeCol].trim();
        const v = /^[A-F]$/.test(g) && g !== 'E' ? g + (alt ? ALT : '') : '';
        byCode.set(r['Site Code'], v);
        const nk = nameKey(r.School);
        byName.set(nk, byName.has(nk) ? null : v);          // null = ambiguous name: never used
      }
    }
    if (byCode.size < 1200) throw new Error(`only ${byCode.size} LA sites — layout changed?`);
    const names = [];
    const values = joinRatings(ctx, ids, s => lastSeg(s).toUpperCase(), (k, row) => {
      if (byCode.has(k)) return byCode.get(k);
      const v = byName.get(nameKey(row.name));
      if (v == null) return undefined;
      names.push(`${row.id} "${row.name}" (CCD ${k})`);
      ctx.stat('nameMatch');
      return v;
    });
    for (const n of names) ctx.log(`    name match: ${n}`);
    return { values, vintage: `${YEAR} (LDOE 2025 School Performance Scores)` };
  },
};
