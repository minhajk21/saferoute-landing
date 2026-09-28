// Pennsylvania: ESSA school designation, 2024-25 — a STATUS, NOT A RATING (Philadelphia).
//   node tools/schools/ratings.mjs --scheme us-pa-essa
// File: PDE Future Ready PA "School Fast Facts for SY 2024-2025"
// (getdatafile?id=58), column ESSASchoolDesignation (DFLT = no designation).
// Designation meanings are PDE's own (futurereadypa.org glossary): ACSI =
// Title I schools designated A-TSI that did not meet exit criteria within 4
// years.
// Join: (AUN, school number) = ST_SCHID "PA-126515001-7904" segments 2 + 3.
// Verified: Philadelphia 367/367.
import { xlsx, sheetRecords, stateIds, joinRatings } from './_us.mjs';

const YEAR = '2024-25';
const URL = 'https://www.futurereadypa.org/home/getdatafile?id=58';
const WORDS = {
  DFLT: 'No federal support designation',
  TSI: 'Targeted Support and Improvement (TSI)',
  ATSI: 'Additional Targeted Support and Improvement (A-TSI)',
  CSI: 'Comprehensive Support and Improvement (CSI)',
  ACSI: 'Additional Comprehensive Support and Improvement (ACSI)',
};

export default {
  scheme: 'us-pa-essa', juris: ['US-PA'], sources: ['ccd'], floor: 0.9,
  record: {
    kind: 'status',
    title: 'Pennsylvania federal school designation (PDE)',
    short: 'ESSA school designation — not a rating',
    scale: 'Under the federal Every Student Succeeds Act, Pennsylvania designates some schools for support: CSI (among the lowest-performing Title I schools, or a low graduation rate), A-TSI or TSI (one or more student groups performing at or below set levels), and ACSI (A-TSI schools that did not meet exit criteria within 4 years). Most schools have no designation.',
    measures: 'Designations come from the Future Ready PA Index: state test proficiency and growth, graduation, English learner progress and chronic absence.',
    caveat: 'This is not a rating.',
    year: YEAR,
    publisher: 'Pennsylvania Department of Education',
    attribution: 'Pennsylvania Department of Education, Future Ready PA Index, School Fast Facts 2024-25.',
    url: 'https://futurereadypa.org/',
    values: Object.values(WORDS),
    miss: '{place} publishes this designation for its public schools, but this school is not in its {year} file.',
  },
  async build(ctx) {
    const ids = await stateIds(ctx);
    const wb = xlsx(await ctx.download('SchoolFastFacts_20242025.xlsx', URL, { maxAgeH: 24 * 30 }));
    const recs = sheetRecords(wb.rows(0), 0, ['Name', 'AUN', 'Schl', 'ESSASchoolDesignation'], 'PA Fast Facts');
    const byKey = new Map();
    for (const r of recs) {
      const d = r.ESSASchoolDesignation;
      if (d && WORDS[d] === undefined) throw new Error(`PA designation "${d}" is new — add its wording`);
      byKey.set(`${+r.AUN}-${+r.Schl}`, d ? WORDS[d] : '');
    }
    if (byKey.size < 2500) throw new Error(`only ${byKey.size} PA schools — layout changed?`);
    const values = joinRatings(ctx, ids, s => (s.parts.length === 3 ? `${+s.parts[1]}-${+s.parts[2]}` : null), k => byKey.get(k));
    return { values, vintage: `${YEAR} (PDE School Fast Facts 2024-25)` };
  },
};
