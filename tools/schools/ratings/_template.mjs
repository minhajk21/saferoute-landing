// TEMPLATE for a US state rating map — copy to ratings/<scheme>.mjs (the "_"
// keeps this file from being loaded). Contract: tools/schools/README.md.
//
// Run by hand, never in the monthly build:
//   node tools/schools/ratings.mjs --scheme us-xx-af
// which writes tools/data/schools/ratings/us-xx-af.json; build-schools.mjs then
// merges that committed map into the tiles every month.
//
// RULES (DESIGN.md §4): a rating is only ever TEXT in the pane, in the state's
// own words, with its year and source — never a colour, filter, sort or count,
// never compared across states. Status schemes (NY/PA/CA ESSA) use kind
// 'status' and are never worded as ratings. Private schools are never rated.

import { records } from '../lib/csv.mjs';

export default {
  scheme: 'us-xx-af',            // = this file's name = row.ratingScheme
  juris: ['US-XX'],
  sources: ['ccd'],              // row.src values it rates (state schools only)
  floor: 0.9,                    // minimum share of in-scope schools matched, from the verified join
  record: {                      // copied into index.json.schemes[scheme]
    kind: 'rating',              // 'rating' | 'status'
    title: 'Example school rating (XDE)',
    short: 'A–F accountability rating',
    scale: 'A (best) to F.',
    measures: 'Mostly state test results and growth.',
    caveat: '',
    year: '2024-25',
    publisher: 'Example Department of Education',
    url: 'https://example.org/accountability',     // a human landing page; confirm it returns 200
    values: ['A', 'B', 'C', 'D', 'F', 'Not Rated'],  // allowed rv values (verify checks every row)
    // miss: '{place} publishes this rating, but this school is not in the {year} file.',   // optional override
    // notes: [{ when: { phase: 'Alternative' }, html: '…' }],   // optional extra caveats; when = exact field matches
  },
  // ctx.rows: the in-scope rows (current tiles); ctx.download: cached downloader.
  // Return { values: { [row.id]: { rv, rd? } }, vintage }.
  async build(ctx) {
    const buf = await ctx.download('ratings.csv', 'https://example.org/ratings.csv', { maxAgeH: 24 * 30 });
    const values = {};
    for (const r of records(buf)) values[r.NCESSCH] = { rv: r.GRADE };
    return { values, vintage: '2024-25' };
  },
};
