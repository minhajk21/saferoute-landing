// Stage: the ONE thing a pin's colour says. Computed here, at build time, from
// each system's own published level field — never from a rating, never guessed.
//
// Three stages (Nursery / Primary / Secondary), grouped the way each system's
// own official grouping groups them. A school whose level the system does not
// publish gets '' and is drawn grey as "Not published". The pane always shows
// the official level (row.phase) as well, so the grouping never hides what the
// system actually said.
//
// No new country uses name-based inference. The name rule below is the one
// exception and stays GIAS-only: GIAS publishes no phase for ~1,390 Welsh
// schools (and a few English ones with no ages), and many say their stage
// outright in their name.
//
// Every crosswalk here is from DESIGN.md §3 (schools expansion, Sept 2026).
// Each source calls the one for its own system; nothing calls them by country.

// ── England & Wales (GIAS) ──────────────────────────────────────────────────
// THREE STAGES, NOT EIGHT PHASES. GIAS has eight phase values, and the filter
// once listed them all ("Middle deemed secondary", "16 plus"...). A parent
// searches by stage, so the filter and the pin colours use three, grouped the
// way Ofsted's own "Ofsted phase" groups them: all 161 all-through, 89 middle
// deemed secondary and the 16-plus state schools it inspects are Secondary, and
// middle deemed primary is Primary (checked against its management
// information, Sept 2026). "Sixth form" is sources/gias.mjs's label for
// independents that start at 16, so Secondary too. The pane still shows the
// official phase. (Moved from /check/'s schStage(); the same rule, proven
// school by school in the v2 refactor.)
const GIAS_STAGE = {
  'Nursery': 'Nursery', 'Primary': 'Primary', 'Middle deemed primary': 'Primary',
  'Secondary': 'Secondary', 'Middle deemed secondary': 'Secondary', 'All-through': 'Secondary',
  '16 plus': 'Secondary', 'Sixth form': 'Secondary',
};
// Welsh names that state the stage outright — "Primary", "Infants", "C.P."
// (community primary), "Ysgol Gynradd" (primary school), "High",
// "Comprehensive", "Ysgol Uwchradd"/"Gyfun" (secondary/comprehensive),
// "Nursery"/"Meithrin" — tried in that order, so "Primary and Nursery School"
// is a primary. The ~550 named only "Ysgol …" ("… School") are NOT guessed:
// Wales has secondaries named that way (Ysgol Dyffryn Nantlle, Ysgol
// Brynhyfryd), so they stay "Not published".
const NAME_SEC = /\b(high|comprehensive|secondary|uwchradd|gyfun|college|grammar)\b/i;
const NAME_PRI = /\b(primary|infants?|junior|prep|gynradd|babanod|iau|cp)\b|\bc\.\s?p\b/i;
const NAME_NUR = /\b(nursery|meithrin)\b/i;

export function giasStage({ phase, type, name }) {
  let s = GIAS_STAGE[phase] || null;
  if (!s && type === 'Special post 16 institution') s = 'Secondary';
  if (!s && name) s = NAME_SEC.test(name) ? 'Secondary' : NAME_PRI.test(name) ? 'Primary' : NAME_NUR.test(name) ? 'Nursery' : null;
  return s || '';
}

// ── Northern Ireland (DE `Type`) ────────────────────────────────────────────
// Preps are filed by DE in the primary census. Special schools (the census
// special workbook has no year-group tab) and Independent schools publish no
// level, so they are "Not published".
const NI_STAGE = { Nursery: 'Nursery', Primary: 'Primary', Preps: 'Primary', Secondary: 'Secondary', Grammar: 'Secondary' };
export const niStage = type => NI_STAGE[type] || '';

// ── US public (NCES CCD `LEVEL`) ────────────────────────────────────────────
// Middle schools ending at grade 6 or lower are Primary, because NCES's own
// Elementary schools end at grade 6 too. NCES "Other" is all-through (K–12,
// PK–12): Secondary, the Ofsted all-through precedent. Not reported, Not
// applicable, Ungraded and Adult Education are "Not published".
const US_GRADE = { PK: -1, KG: 0, '01': 1, '02': 2, '03': 3, '04': 4, '05': 5, '06': 6, '07': 7, '08': 8, '09': 9, '10': 10, '11': 11, '12': 12, '13': 13 };
export function usPublicStage(level, gradeHigh) {
  if (level === 'Prekindergarten') return 'Nursery';
  if (level === 'Elementary') return 'Primary';
  if (level === 'Middle') { const g = US_GRADE[gradeHigh]; return g != null && g <= 6 ? 'Primary' : 'Secondary'; }
  if (level === 'High' || level === 'Secondary' || level === 'Other') return 'Secondary';
  return '';
}

// ── US private (PSS `LEVEL`: 1 Elementary, 2 Secondary, 3 Combined) ─────────
// PSS excludes pre-K-only programmes, so there is no Nursery. A 6–8 private
// school is "Elementary" in PSS and so Primary here — PSS's own grouping,
// deliberately not overridden (the pane still shows its grades).
const PSS_STAGE = { '1': 'Primary', '2': 'Secondary', '3': 'Secondary', Elementary: 'Primary', Secondary: 'Secondary', Combined: 'Secondary' };
export const usPrivateStage = level => PSS_STAGE[String(level)] || '';

// ── Ontario (SIF `School Level`; private list `School Level`) ───────────────
// JK/SK sit inside Elementary. Private "Elem/Sec" is all-through: Secondary.
export function ontarioStage(level) {
  if (level === 'Elementary') return 'Primary';
  if (level === 'Secondary' || /elem\w*\s*\/\s*sec/i.test(level || '')) return 'Secondary';
  return '';
}

// ── British Columbia (`SCHOOL_EDUCATION_LEVEL`) ─────────────────────────────
const BC_STAGE = {
  'Elementary': 'Primary', 'Middle School': 'Secondary', 'Junior Secondary': 'Secondary',
  'Senior Secondary': 'Secondary', 'Secondary': 'Secondary', 'Elementary-Secondary': 'Secondary',
  'Elementary Jr. Secondary': 'Secondary',
};
export const bcStage = level => BC_STAGE[level] || '';

// ── Mexico (SEP CNCT `TIPONIVELSUB_C_SERVICION2`) ───────────────────────────
// Inicial (CENDI, 0–3) and Preescolar are Nursery; Secundaria and Media
// Superior are Secondary; CAM special-education centres publish no level.
const MX_STAGE = { 'INICIAL': 'Nursery', 'PREESCOLAR': 'Nursery', 'PRIMARIA': 'Primary', 'SECUNDARIA': 'Secondary', 'MEDIA SUPERIOR': 'Secondary' };
export const mxStage = nivel => MX_STAGE[String(nivel || '').toUpperCase()] || '';
