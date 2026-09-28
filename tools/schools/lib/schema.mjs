// The v2 school row: ONE field list for every country.
//
// Tiles are row arrays in exactly this order, and index.json carries the list
// once (index.fields), so a reader looks fields up by name and never by
// position. Fields only England & Wales fill sit at the end: gzip turns their
// runs of "" into a few bytes on every other country's rows.
//
// Every source module emits plain objects with these keys (see
// tools/schools/README.md for what each one means and who fills it). A key a
// source does not publish is left out or set to its EMPTY value below; toRow()
// fills the gap, so no source has to spell out forty blanks.
//
// NOT HERE ON PURPOSE — do not add them back through a side door:
//   religion, denomination, diocese, faith or religious-character fields of any
//   kind (the owner removed religion from the map; PSS's religious columns are
//   stripped at parse); addresses and websites (the record link covers them);
//   test scores that are not an official rating (EQAO, BC FSA, SAER).

export const SCHEMA_VERSION = 2;

// England & Wales report-card area keys, in Ofsted's own order. They travel in
// every tile, are read by the /check/ pane, and are empty for every non-E&W row.
export const RC_FIELDS = [
  'rcSafeguardingStandards', 'rcInclusion', 'rcCurriculumAndTeaching', 'rcAchievement',
  'rcAttendanceAndBehaviour', 'rcPersonalDevelopmentAndWellbeing', 'rcLeadershipAndGovernance',
];

export const FIELDS = [
  'src',          // source id (tools/schools/sources/<src>.mjs): picks attribution, record link, pane labels
  'id',           // the official ID as published (URN, NCESSCH, PPIN, DE ref, BSID, MINCODE, CCT) — a STRING
  'name',         // as published
  'postcode',     // postcode / ZIP / postal code / código postal
  'lat', 'lng',   // WGS84, 5 decimal places
  'juris',        // ISO 3166-2: GB-ENG GB-WLS GB-NIR US-TX … CA-ON CA-BC MX-CMX
  'type',         // official type label, in its own words
  'sector',       // 'state' | 'private' (private = hollow pin)
  'stage',        // 'Nursery' | 'Primary' | 'Secondary' | '' (not published) — computed at build, lib/stage.mjs
  'phase',        // official level label (GIAS phase, NCES level, SEP nivel, DE type…)
  'tags',         // space-separated codes: charter grammar prep irish-medium french-immersion francophone
  'gender',       // DECLARED only: 'Boys' | 'Girls' | 'Mixed' (| GIAS's own 'Not applicable'); never derived from counts
  'boarding',     // boolean
  'span',         // the span in its own system: "4–11" (ages), "PK–5" (grades), "Years 1–7"
  'pupils',       // integer or null
  'pupilsAsOf',   // ISO date or school year ("2024-25"); '' = the source's default (sources[src].pupilsAsOf)
  'capacity',     // places / approved enrolment / design capacity (label from the source)
  'teachers',     // FTE or headcount (label from the source), or null
  'meals',        // a percentage, or null
  'mealsKind',    // 'fsm' | 'fsme' | 'frl' | 'dc' — set exactly when meals is
  'admissions',   // admissions policy (GIAS)
  'la',           // education authority: LA, school district, board, BC district, SEP operating body
  'trust',        // GIAS trust / US charter authorizer
  'area',         // ward / city / "colonia, alcaldía" / town
  'ratingScheme', // scheme id; its wording is index.schemes[id]
  'rv',           // rating value in the scheme's own words ('' = none)
  'rd',           // rating year or date
  'ru',           // per-row link slug, where a record link cannot be derived from the id
  // England & Wales only
  'sixthForm', 'nursery', 'inspectorate', 'oeifGrade', 'oeifDate', 'cardDate', ...RC_FIELDS,
];

// The value a field takes when a source does not publish it.
const BOOL = new Set(['boarding', 'sixthForm', 'nursery']);
const NUM = new Set(['lat', 'lng', 'pupils', 'capacity', 'teachers', 'meals']);
export const EMPTY = Object.fromEntries(FIELDS.map(f => [f, BOOL.has(f) ? false : NUM.has(f) ? null : '']));

export const STAGES = ['Nursery', 'Primary', 'Secondary'];
export const SECTORS = ['state', 'private'];
export const MEALS_KINDS = ['fsm', 'fsme', 'frl', 'dc'];

// Field names that must never appear in the schema (verify-schools checks it).
export const FORBIDDEN_FIELD = /relig|denomin|faith|diocese|typology|orient/i;

export function toRow(o) {
  return FIELDS.map(f => (o[f] === undefined ? EMPTY[f] : o[f]));
}

// fields: the list the tile was written with (index.fields), so an older tile
// set can still be read field-by-name.
export function fromRow(row, fields = FIELDS) {
  const o = {};
  for (let i = 0; i < fields.length; i++) o[fields[i]] = row[i];
  return o;
}

// Cheap structural checks on one row, before it is tiled. Returns a list of
// problems ('' when clean). `source` is the source module that produced it.
export function rowProblems(o, source) {
  const p = [];
  if (o.src !== source.id) p.push(`src "${o.src}" is not "${source.id}"`);
  if (typeof o.id !== 'string' || !o.id) p.push('id must be a non-empty string');
  if (!o.name) p.push('no name');
  if (!Number.isFinite(o.lat) || !Number.isFinite(o.lng)) p.push('lat/lng not numbers');
  else if (+o.lat.toFixed(5) !== o.lat || +o.lng.toFixed(5) !== o.lng) p.push('lat/lng not rounded to 5 dp');
  if (!source.juris.includes(o.juris)) p.push(`juris "${o.juris}" not in the source's juris [${source.juris}]`);
  if (!SECTORS.includes(o.sector)) p.push(`sector "${o.sector}"`);
  if (o.stage !== '' && !STAGES.includes(o.stage)) p.push(`stage "${o.stage}"`);
  // Left out = not published (toRow fills false), as for every other field.
  if (o.boarding !== undefined && typeof o.boarding !== 'boolean') p.push('boarding not boolean');
  for (const f of ['pupils', 'capacity', 'teachers', 'meals']) {
    if (o[f] != null && !Number.isFinite(o[f])) p.push(`${f} not a number or null`);
  }
  if ((o.meals != null) !== !!o.mealsKind) p.push('meals and mealsKind must be set together');
  if (o.mealsKind && !MEALS_KINDS.includes(o.mealsKind)) p.push(`mealsKind "${o.mealsKind}"`);
  const pub = new Set(source.meta?.publishes || []);
  if (o.gender && !pub.has('gender')) p.push('gender set but the source does not publish gender');
  if (o.boarding && !pub.has('boarding')) p.push('boarding set but the source does not publish boarding');
  if (o.sector === 'private' && o.rv) p.push('a private school carries a public-school rating value');
  if (!o.ratingScheme) p.push('no ratingScheme');
  for (const k of Object.keys(o)) if (FORBIDDEN_FIELD.test(k)) p.push(`forbidden field "${k}"`);
  return p;
}
