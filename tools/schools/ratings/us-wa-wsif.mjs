// Washington: Washington School Improvement Framework (WSIF), 2025 (Seattle).
//   node tools/schools/ratings.mjs --scheme us-wa-wsif
// Source: OSPI "WSIF" open data on data.wa.gov (Socrata u25x-vdun, CC BY 4.0),
// rows student_group = All Students: _2025_annual_identification (the support
// tier) and _2025_score (the WSIF score, 1-10).
// Join: 4-digit school_code = last ST_SCHID segment ("WA-17001-3456").
// Verified: Seattle 144/150 matched, 138 scored.
import { stateIds, joinRatings, lastSeg, assertValues, num, MISS } from './_us.mjs';

const YEAR = '2025';
const API = 'https://data.wa.gov/resource/u25x-vdun.json';

// OSPI's identification labels -> the words shown. Every label in the file must
// be listed here (an unknown one fails the build rather than being guessed).
const TIER = {
  'Foundational': 'Foundational supports',
  'Foundational - 2 Yr Enr Req Not Met': 'Foundational supports',
  'Tier 1: Targeted 1-2': 'Tier 1 targeted support',
  'Tier 2: Targeted 3+': 'Tier 2 targeted support',
  'Tier 2: Targeted_EL Progress': 'Tier 2 targeted support (English learner progress)',
  'Tier 3: Comprehensive': 'Tier 3 comprehensive support',
  'Tier 3: Comprehensive_LowGrad': 'Tier 3 comprehensive support (low graduation rate)',
  'Tier 3: Comprehensive_LowGrad_OptOutEligible': 'Tier 3 comprehensive support (low graduation rate)',
  'Closed': '',
};

export default {
  scheme: 'us-wa-wsif', juris: ['US-WA'], sources: ['ccd'], floor: 0.85,
  record: {
    kind: 'rating',
    title: 'Washington School Improvement Framework (OSPI)',
    short: 'WSIF support tier and score (1–10)',
    scale: 'Foundational supports (not identified), or identified for support: Tier 1 (one or two student groups), Tier 2 (three or more groups) or Tier 3 (all students, or a low graduation rate). The score runs from 1 to 10.',
    measures: 'State test proficiency and growth, graduation, English learner progress, regular attendance, ninth-grade on-track and dual credit.',
    caveat: 'Each measure is scored by decile among Washington schools, so the score shows where a school stands among them; it is not a percentage. Data from OSPI under CC BY 4.0; tier labels lightly reworded.',
    year: YEAR,
    publisher: 'Washington Office of Superintendent of Public Instruction',
    attribution: 'Washington Office of Superintendent of Public Instruction, Washington School Improvement Framework 2025 (data.wa.gov); labels lightly reworded by SafeRoute.',
    licence: 'CC BY 4.0 (data.wa.gov dataset licence)',
    licenceUrl: 'https://creativecommons.org/licenses/by/4.0/',
    url: 'https://ospi.k12.wa.us/policy-funding/grants-management/every-student-succeeds-act-essa/washington-school-improvement-framework',
    miss: MISS('tier'),
  },
  async build(ctx) {
    const ids = await stateIds(ctx);
    const q = `${API}?$limit=50000&student_group=${encodeURIComponent('All Students')}`;
    const rows = JSON.parse(await ctx.download(`wsif-${YEAR}.json`, q, { maxAgeH: 24 * 30 }));
    if (!Array.isArray(rows) || rows.length < 2000) throw new Error(`WA WSIF returned ${rows?.length} rows — API changed?`);
    const unknown = [...new Set(rows.map(r => r._2025_annual_identification).filter(t => t && !(t in TIER)))];
    if (unknown.length) throw new Error(`WA WSIF has identification label(s) not mapped: ${unknown.join(' | ')}`);
    const byKey = new Map();
    for (const r of rows) {
      if (r.wsif_year !== YEAR || !r.school_code) continue;
      const tier = TIER[r._2025_annual_identification] || '';
      const score = num(r._2025_score, 2);
      byKey.set(r.school_code.padStart(4, '0'), tier ? (score ? `${tier} · score ${score}` : tier) : '');
    }
    const values = joinRatings(ctx, ids, s => lastSeg(s).padStart(4, '0'), k => byKey.get(k));
    assertValues(values, /^(Foundational supports|Tier [123] (targeted|comprehensive) support( \([a-z ]+\))?)( · score \d+(\.\d+)?)?$/, 'WA WSIF');
    return { values, vintage: `${YEAR} (data.wa.gov u25x-vdun)` };
  },
};
