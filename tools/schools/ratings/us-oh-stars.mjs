// Ohio: School Report Card Overall Star Rating, 2025-26 (Cleveland).
//   node tools/schools/ratings.mjs --scheme us-oh-stars
// Files: ODEW report-card "Download Data" BUILDING_HIGH_LEVEL_2526.xlsx (sheets
// BUILDING_OVERVIEW and DROPOUT_OVERVIEW) and COMMUNITY_SCHOOL_HIGH_LEVEL_2526.xlsx
// (COMMUNITY_SCHOOL_OVERVIEW), column "Overall Star Rating".
// ACCESS IS FRAGILE (DESIGN.md §7 R4): the files sit in an Azure blob container
// that needs the read-only SAS token the public report-card site itself ships
// in its main.<hash>.js ("documentToken", sp=rlx, GET only). The token is read
// from the live site at build time, never stored here.
// Join: 6-digit Building IRN = last ST_SCHID segment ("OH-043786-043786").
// Verified: Cleveland 214/222.
import { xlsx, sheetRecords, stateIds, joinRatings, lastSeg, MISS } from './_us.mjs';

const YEAR = '2025-26';
const SITE = 'https://reportcard.education.ohio.gov/';
const BLOB = 'https://eduprdreportcardstorage1.blob.core.windows.net/data-download-2026/';
const FILES = [
  ['BUILDING_HIGH_LEVEL_2526.xlsx', ['BUILDING_OVERVIEW', 'DROPOUT_OVERVIEW']],
  ['COMMUNITY_SCHOOL_HIGH_LEVEL_2526.xlsx', ['COMMUNITY_SCHOOL_OVERVIEW']],
];
const STAR = ['1', '1.5', '2', '2.5', '3', '3.5', '4', '4.5', '5'];
const word = n => `${n} ${n === '1' ? 'star' : 'stars'}`;
const DROP = ' (dropout-recovery report card)';
const VALUES = [...STAR.map(word), ...STAR.map(n => word(n) + DROP), 'Not rated'];

// The site's public blob token, read from its current main.<hash>.js.
async function sasToken() {
  const html = await (await fetch(SITE, { signal: AbortSignal.timeout(60_000) })).text();
  const js = /src="(main\.[0-9a-f]+\.js)"/.exec(html)?.[1];
  if (!js) throw new Error('Ohio report-card site: main.<hash>.js not found — the site changed');
  const code = await (await fetch(SITE + js, { signal: AbortSignal.timeout(60_000) })).text();
  const tok = /documentToken\s*=\s*"([^"]+)"/.exec(code)?.[1];
  if (!tok || !/sp=r/.test(tok)) throw new Error('Ohio report-card site: no read-only documentToken in its JS — the site changed');
  return tok;
}

export default {
  scheme: 'us-oh-stars', juris: ['US-OH'], sources: ['ccd'], floor: 0.9,
  record: {
    kind: 'rating',
    title: 'Ohio Overall Star Rating (Ohio School Report Cards)',
    short: 'Overall Star Rating',
    scale: '1 to 5 stars in half-star steps (5 is highest).',
    measures: 'Achievement, progress (growth), gap closing, early literacy, graduation and college, career, workforce and military readiness, weighted together.',
    caveat: 'Dropout-recovery schools get a separate report card with different measures; their stars are marked as such.',
    year: YEAR,
    publisher: 'Ohio Department of Education and Workforce',
    attribution: 'Ohio Department of Education and Workforce, Ohio School Report Cards 2025-26 data download.',
    url: SITE,
    values: VALUES,
    miss: MISS('star rating'),
  },
  async build(ctx) {
    const ids = await stateIds(ctx);
    let tok = null, created = '';
    const byKey = new Map();
    for (const [file, sheets] of FILES) {
      const buf = await ctx.download(file, async () => `${BLOB}${file}?${tok ??= await sasToken()}`, { maxAgeH: 24 * 14 });
      // Keep the token out of the committed provenance (meta.upstream).
      for (const p of ctx.provenance) if (p.url?.includes('?sv=')) p.url = `${p.url.split('?')[0]}?<read-only SAS token from ${SITE}main.*.js>`;
      const wb = xlsx(buf);
      if (!created && wb.sheets.includes('Notes')) created = (wb.rows('Notes').flat().join(' ').match(/Created on (\d{4}-\d{2}-\d{2})/) || [])[1] || '';
      for (const sheet of sheets) {
        const recs = sheetRecords(wb.rows(sheet), 0, ['Building IRN', 'Building Name', 'Overall Star Rating'], `OH ${sheet}`);
        for (const r of recs) {
          const raw = r['Overall Star Rating'];
          const m = /^(\d(?:\.5)?) Stars?$/.exec(raw);
          const v = m ? word(m[1]) + (sheet === 'DROPOUT_OVERVIEW' ? DROP : '') : raw === 'NR' ? 'Not rated' : '';
          if (raw && !v) throw new Error(`OH star rating "${raw}" not understood`);
          byKey.set(r['Building IRN'].padStart(6, '0'), v);
        }
      }
    }
    if (byKey.size < 3000) throw new Error(`only ${byKey.size} OH buildings — layout changed?`);
    const values = joinRatings(ctx, ids, s => lastSeg(s).padStart(6, '0'), k => byKey.get(k));
    return { values, vintage: `${YEAR} (ODEW report card download${created ? `, created ${created}` : ''})` };
  },
};
