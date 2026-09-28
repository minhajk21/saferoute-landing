// Nevada: Nevada School Performance Framework (NSPF) star rating, 2025-26 (Las Vegas).
//   node tools/schools/ratings.mjs --scheme us-nv-nspf
// File: Nevada Report Card "NSPF Disaggregated Data File.zip" -> "NSPF
// Disaggregated Data File (2026).xlsx", sheet "Totals&Points": one row per
// school AND level (Sch_level 1 Elementary, 2 Middle, 3 High), StarRating
// 0-5 where 0 = not rated. Use the zip, not the per-school pages (DESIGN.md §1b).
// Join: 5-digit schoolID = last ST_SCHID segment ("NV-02-02060").
// Verified: Las Vegas 322/342.
import { xlsx, sheetRecords, unzip, stateIds, joinRatings, lastSeg, assertValues, stars, MISS } from './_us.mjs';

const YEAR = '2025-26';
const URL = 'https://nevadareportcard.nv.gov/DI/MoreDownload?filename=NSPF%20Disaggregated%20Data%20File.zip';
const LEVEL = { 1: 'Elementary', 2: 'Middle', 3: 'High' };

// One level: "3 stars". Several: "Elementary: 3 stars · Middle: 2 stars".
// All levels 0: "Not rated". A 0 beside a rated level reads "not rated".
function words(levels) {
  const ls = [...levels.entries()].sort((a, b) => a[0] - b[0]);
  if (ls.every(([, s]) => s === 0)) return 'Not rated';
  if (ls.length === 1) return stars(ls[0][1]);
  return ls.map(([l, s]) => `${LEVEL[l]}: ${s ? stars(s) : 'not rated'}`).join(' · ');
}

export default {
  scheme: 'us-nv-nspf', juris: ['US-NV'], sources: ['ccd'], floor: 0.85,
  record: {
    kind: 'rating',
    title: 'Nevada school star rating (NSPF)',
    short: 'Nevada School Performance Framework star rating',
    scale: '1 to 5 stars (5 is highest), rated separately for each school level (elementary, middle, high) a school serves.',
    measures: 'State test proficiency and growth, closing opportunity gaps, English learner progress, attendance and, for high schools, graduation and college and career readiness.',
    caveat: '"Not rated" means Nevada gave that level no stars (0 in its file).',
    year: YEAR,
    publisher: 'Nevada Department of Education',
    attribution: 'Nevada Department of Education, Nevada Report Card, NSPF Disaggregated Data File (2026).',
    url: 'https://nevadareportcard.nv.gov/',
    miss: MISS('star rating'),
  },
  async build(ctx) {
    const ids = await stateIds(ctx);
    const z = unzip(await ctx.download('NSPF-Disaggregated-Data-File.zip', URL, { maxAgeH: 24 * 30 }));
    const member = z.names.find(n => /\(2026\)\.xlsx$/i.test(n));
    if (!member) throw new Error(`no "(2026).xlsx" in the NSPF zip (${z.names.join(', ')})`);
    const recs = sheetRecords(xlsx(z.read(member)).rows('Totals&Points'), 0, ['year', 'schoolID', 'Sch_level', 'StarRating'], 'NV Totals&Points');
    const bySchool = new Map();
    for (const r of recs) {
      if (r.year !== '2026') continue;
      const lvl = +r.Sch_level, s = +r.StarRating;
      if (!LEVEL[lvl] || !(Number.isInteger(s) && s >= 0 && s <= 5)) throw new Error(`NV row ${r.schoolID}: level ${r.Sch_level} stars ${r.StarRating}`);
      const k = r.schoolID.padStart(5, '0');
      if (!bySchool.has(k)) bySchool.set(k, new Map());
      bySchool.get(k).set(lvl, s);
    }
    if (bySchool.size < 600) throw new Error(`only ${bySchool.size} NV schools — layout changed?`);
    const values = joinRatings(ctx, ids, s => lastSeg(s).padStart(5, '0'), k => (bySchool.has(k) ? words(bySchool.get(k)) : undefined));
    assertValues(values, /^(Not rated|[1-5] stars?|((Elementary|Middle|High): ([1-5] stars?|not rated))( · (Elementary|Middle|High): ([1-5] stars?|not rated))+)$/, 'NV NSPF');
    return { values, vintage: `${YEAR} (NSPF Disaggregated Data File (2026))` };
  },
};
