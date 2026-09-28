// Arizona: ADE A–F school letter grade, 2024-25 (Tucson). Shown WITH CAVEATS
// (owner decision, DESIGN.md Q7).
//   node tools/schools/ratings.mjs --scheme us-az-af
// Source: the Arizona Department of Education's own AZ School Report Cards
// site (azreportcards.azed.gov), through the data service its search page
// calls: /api/Search/GetNearestSchools?…&fiscalYear=N. The API is undocumented
// and azed.gov itself sits behind a Cloudflare challenge, so this is fragile
// (DESIGN.md §7 R4): if it fails, the committed map stays.
// YEAR OFFSET (checked in the site's app.min.js): the year picker shows
// "{fy-1}-{fy}" for GetFiscalYears' active fy (2025 -> "2024-2025"), and the
// search sends fiscalYear: fy + 1. So fiscalYear=2026 returns the 2024-25
// grades. When fiscalYear=2027 starts returning schools, 2025-26 grades are
// out: the build warns, and FY/YEAR below move on together.
// Join: educationOrganizationId = last ST_SCHID segment ("AZ-4421-5860").
// Verified: Tucson 273/292 (283 of 303 in the verifier's box).
import { stateIds, joinRatings, lastSeg, MISS } from './_us.mjs';
import { loadCoverage } from '../lib/coverage.mjs';

const FY = 2026, YEAR = '2024-25';
const API = 'https://azreportcards.azed.gov/api/Search/GetNearestSchools';
const GRADE = { A: 'A', B: 'B', C: 'C', D: 'D', F: 'F', NR: 'Not rated' };

// Miles from a box's centre to its farthest corner, plus a margin.
const radiusMiles = ([s, w, n, e]) => {
  const lat = (s + n) / 2, dy = (n - s) / 2 * 69.05, dx = (e - w) / 2 * 69.17 * Math.cos(lat * Math.PI / 180);
  return Math.ceil(Math.hypot(dx, dy) * 1.25) + 2;
};

export default {
  scheme: 'us-az-af', juris: ['US-AZ'], sources: ['ccd'], floor: 0.85,
  record: {
    kind: 'rating',
    title: 'Arizona school letter grade (ADE)',
    short: 'A–F letter grade',
    scale: 'A (highest) to F. "Not rated" (NR) means the school does not have the parts of ADE\u2019s model needed to receive a grade.',
    measures: 'Mostly state test proficiency and growth; high schools also count graduation and college and career readiness.',
    caveat: 'This is the Arizona Department of Education’s official A–F letter grade for the 2024-25 school year, as published on its AZ School Report Cards site. Alternative schools are graded under a separate model.',
    year: YEAR,
    publisher: 'Arizona Department of Education (AZ School Report Cards)',
    attribution: 'Arizona Department of Education, AZ School Report Cards (2024-25 letter grades).',
    url: 'https://azreportcards.azed.gov/',
    values: Object.values(GRADE),
    miss: MISS('letter grade'),
  },
  async build(ctx) {
    const ids = await stateIds(ctx);
    const regions = loadCoverage().regions.filter(r => r.juris.includes('US-AZ'));
    const byKey = new Map();
    for (const reg of regions) {
      const [s, w, n, e] = reg.bbox;
      const q = (fy, f) => ctx.download(f, `${API}?originLatitude=${((s + n) / 2).toFixed(4)}&originLongitude=${((w + e) / 2).toFixed(4)}&distance=${radiusMiles(reg.bbox)}&fiscalYear=${fy}`, { maxAgeH: 24 * 7 });
      const list = JSON.parse(await q(FY, `az-nearest-${reg.id}-fy${FY}.json`));
      if (!Array.isArray(list) || list.length < 200) throw new Error(`AZ API returned ${list?.length} entities for ${reg.id} — changed?`);
      for (const x of list) {
        if (x.entityType !== 'School') continue;                    // skip LEAs and private schools (grade "NA")
        const g = String(x.grade ?? '').trim();
        if (g && GRADE[g] === undefined) throw new Error(`AZ grade "${g}" not understood`);
        byKey.set(String(x.educationOrganizationId), GRADE[g] ?? '');
      }
      try {
        const next = JSON.parse(await q(FY + 1, `az-nearest-${reg.id}-fy${FY + 1}.json`));
        if (Array.isArray(next) && next.length) ctx.warn(`ADE now answers fiscalYear=${FY + 1} (${next.length} entities): newer grades are out — move FY/YEAR on after checking the site`);
      } catch (e) { ctx.warn(`probe of fiscalYear=${FY + 1} failed: ${e.message}`); }
    }
    const values = joinRatings(ctx, ids, s => String(+lastSeg(s)), k => byKey.get(k));
    return { values, vintage: `${YEAR} (AZ School Report Cards, fiscalYear=${FY})` };
  },
};
