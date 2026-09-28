// Maryland: Maryland School Report Card star rating, 2025 (2024-25) (Baltimore).
//   node tools/schools/ratings.mjs --scheme us-md-stars
// File: MSDE Report Card data download 572 = a zip holding
// 2025_Accountability_Schools.csv. Its "School Name" and "School" headers are
// SWAPPED (the code sits under "School Name"), so columns are found by what
// they hold, not trusted by name. Without a session the download answers HTTP
// 500 (the site's error page; checked 2026-09-27: 500 every time cold, 200
// three times out of three after one GET of the home page), so the build first
// opens a session, then retries. The file ID changes every year: find the next
// one on reportcard.msde.maryland.gov > Data Downloads.
// Join: (LEA, 4-digit school) = ST_SCHID "MD-30-300307" -> ("30", "0307").
// Verified: Baltimore 163/168.
import { unzip, stateIds, joinRatings, stars, MISS } from './_us.mjs';
import { parseCsv } from '../lib/csv.mjs';

const YEAR = '2024-25';
const HOME = 'https://reportcard.msde.maryland.gov/';
const URL = `${HOME}DataDownloads/FileDownload/572`;

// The site's own session cookies (ASP.NET_SessionId and its load-balancer
// cookies), from one plain GET of the home page.
async function session() {
  const res = await fetch(HOME, { signal: AbortSignal.timeout(60_000) });
  await res.arrayBuffer();
  return res.headers.getSetCookie().map(c => c.split(';')[0]).join('; ');
}

export default {
  scheme: 'us-md-stars', juris: ['US-MD'], sources: ['ccd'], floor: 0.9,
  record: {
    kind: 'rating',
    title: 'Maryland school star rating (MSDE)',
    short: 'Maryland School Report Card star rating',
    scale: '1 to 5 stars (5 is highest), set by the share of possible points the school earned.',
    measures: 'Academic indicators (test achievement and progress, graduation, English learner progress) make up 65% of the points; school quality and student success measures, such as chronic absence, make up 35%.',
    caveat: '',
    year: YEAR,
    publisher: 'Maryland State Department of Education',
    attribution: 'Maryland State Department of Education, Maryland Report Card 2025 Accountability Schools.',
    url: 'https://reportcard.msde.maryland.gov/',
    values: ['1 star', '2 stars', '3 stars', '4 stars', '5 stars'],
    miss: MISS('star rating'),
  },
  async build(ctx) {
    const ids = await stateIds(ctx);
    let buf;
    for (let i = 0; i < 5 && !buf; i++) {
      try { buf = await ctx.download('md-accountability-572.zip', URL, { maxAgeH: 24 * 30, headers: { cookie: await session(), referer: `${HOME}Graphs/` } }); }
      catch (e) { ctx.warn(`attempt ${i + 1}: ${e.message}`); await new Promise(r => setTimeout(r, 3000)); }
    }
    if (!buf) throw new Error('MSDE download 572 failed 5 times — keep the committed map');
    const z = unzip(buf);
    const member = z.names.find(n => /Accountability_Schools\.csv$/i.test(n));
    if (!member) throw new Error(`no *Accountability_Schools.csv in download 572 (has ${z.names.join(', ')})`);
    const { header, rows } = parseCsv(z.read(member), { encoding: 'utf-8' });
    const h = header.map(x => x.trim());
    const at = n => h.indexOf(n);
    if (at('Year') < 0 || at('LEA') < 0 || at('Rating') < 0) throw new Error(`MD CSV header changed: ${h.join(',')}`);
    // The 4-digit school code is whichever of "School Name"/"School" holds digits.
    const codeCol = [at('School Name'), at('School')].find(c => c >= 0 && rows.slice(0, 50).every(r => /^\d{4}$/.test((r[c] || '').trim())));
    if (codeCol == null) throw new Error('MD CSV: no column of 4-digit school codes under "School Name" or "School"');
    const byKey = new Map();
    for (const r of rows) {
      if ((r[at('Year')] || '').trim() !== '2025') continue;
      const lea = (r[at('LEA')] || '').trim().padStart(2, '0'), sch = (r[codeCol] || '').trim();
      const n = (r[at('Rating')] || '').trim();
      byKey.set(`${lea}-${sch}`, /^[1-5]$/.test(n) ? stars(n) : '');
    }
    if (byKey.size < 1200) throw new Error(`only ${byKey.size} MD schools — layout changed?`);
    const values = joinRatings(ctx, ids, s => (s.parts.length === 3 ? `${s.parts[1].padStart(2, '0')}-${s.parts[2].slice(-4)}` : null), k => byKey.get(k));
    return { values, vintage: `${YEAR} (MSDE 2025 Accountability Schools, download 572)` };
  },
};
