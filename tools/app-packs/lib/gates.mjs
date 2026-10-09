// The O1 gates (RELEASE-1.4-SCOPE.md §4.4). Each is a pure function over the
// pack being built, returning a list of problems; any problem fails the build
// and nothing is written. They are separate functions so each can be proved
// against a fixture that must fail (test/gates.test.mjs).
//
// The rules they compare against (filter definitions, field lists, the
// licence allow-list, the loaded modules) come from lib/landing.mjs, which
// reads them from the builder's committed HEAD as well as the data commit.

// Religion is never a field, a filter or a colour (schools house rule), and
// the same names never enter either pack under any key or label.
export const FORBIDDEN_KEY = /relig|denomin|faith|diocese|typology|orient/i;

// The only optional school filters the app may offer. Sector and phase are
// fixed controls, not filters.
export const ALLOWED_FILTERS = Object.freeze(['gender', 'boarding', 'charter']);
// The only values a select filter may offer (gender is declared, never derived;
// GIAS's "Not applicable" is excluded by tools/schools/filters.mjs).
export const SELECT_OPTIONS = Object.freeze({ gender: Object.freeze(['Boys', 'Girls', 'Mixed']) });
// What a published filter carries beyond its definition in filters.mjs.
const FILTER_EXTRA_KEYS = ['id', 'publishedBy', 'where', 'options'];

// School rating fields only England & Wales fill. A US row off a licensed
// state scheme carries none of them (nor rv).
export const EW_RATING_FIELD = /^(rd|inspectorate|oeifGrade|oeifDate|cardDate|rc[A-Z]\w*)$/;

const MAX_SHOWN = 8;

export class GateError extends Error {
  constructor(layer, gates) {
    const failed = gates.filter(g => !g.ok);
    super(`${layer} pack: ${failed.length} gate(s) failed:\n` + failed.map(g => `  ${g.name}: ${g.problems.slice(0, MAX_SHOWN).join(' | ')}${g.problems.length > MAX_SHOWN ? ` | … ${g.problems.length - MAX_SHOWN} more` : ''}`).join('\n'));
    this.layer = layer;
    this.gates = gates;
    this.failed = failed.map(g => g.name);
  }
}

export const gate = (name, problems, detail = '') => ({ name, ok: problems.length === 0, problems, detail });

const isEmpty = v => v === '' || v == null || v === false;
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// Every object key at any depth, with its path.
function* keysDeep(o, path = '') {
  if (Array.isArray(o)) { for (let i = 0; i < o.length; i++) yield* keysDeep(o[i], `${path}[${i}]`); return; }
  if (!o || typeof o !== 'object') return;
  for (const k of Object.keys(o)) { yield [k, `${path}.${k}`]; yield* keysDeep(o[k], `${path}.${k}`); }
}
// Every string at any depth, with its path.
export function* stringsDeep(o, path = '') {
  if (typeof o === 'string') { yield [o, path]; return; }
  if (Array.isArray(o)) { for (let i = 0; i < o.length; i++) yield* stringsDeep(o[i], `${path}[${i}]`); return; }
  if (!o || typeof o !== 'object') return;
  for (const k of Object.keys(o)) yield* stringsDeep(o[k], `${path}.${k}`);
}

// 1. No field, and no key anywhere in the pack's index, names religion,
//    denomination, faith, diocese, typology or orientation. `fields` are the
//    row fields (index.fields), checked by name.
export function forbiddenFieldProblems(index, extraFieldLists = []) {
  const p = [];
  for (const list of [index.fields || [], ...extraFieldLists]) for (const f of list) if (FORBIDDEN_KEY.test(f)) p.push(`row field "${f}"`);
  for (const [k, path] of keysDeep(index)) if (FORBIDDEN_KEY.test(k)) p.push(`key ${path}`);
  return p;
}

// 1b. The row fields are exactly the layer's contract (tools/<layer>/lib/
//     schema.mjs FIELDS), so no field can be renamed to carry something else.
export function fieldListProblems(fields, FIELDS) {
  return same(fields, FIELDS) ? [] : [`index.fields is not tools/…/lib/schema.mjs FIELDS: ${(fields || []).filter(f => !FIELDS.includes(f)).map(f => `+${f}`).concat(FIELDS.filter(f => !(fields || []).includes(f)).map(f => `-${f}`)).join(' ') || 'same names, different order'}`];
}

// 1c. No label the app shows names religion either: the schools sources'
//     pane labels, the filters' words, the scheme titles.
export function labelProblems(index) {
  const p = [];
  const scan = (o, path) => { for (const [s, at] of stringsDeep(o, path)) if (FORBIDDEN_KEY.test(s)) p.push(`${at}: "${s.slice(0, 60)}"`); };
  for (const [id, s] of Object.entries(index.sources || {})) { scan(s?.labels, `sources.${id}.labels`); scan(s?.name, `sources.${id}.name`); }
  for (const [i, f] of (index.filters || []).entries()) for (const k of ['label', 'noun', 'any', 'where']) scan(f?.[k], `filters[${i}].${k}`);
  for (const [id, sc] of Object.entries(index.schemes || {})) for (const k of ['title', 'short']) scan(sc?.[k], `schemes.${id}.${k}`);
  return p;
}

// 2. Filters: only gender, boarding and charter, each exactly as
//    tools/schools/filters.mjs defines it (same field, tag, type, words), select
//    options only from SELECT_OPTIONS, and every source's `publishes` only
//    those ids, matching each filter's publishedBy.
export function filterProblems(index, FILTERS = null) {
  const p = [];
  for (const [i, f] of (index.filters || []).entries()) {
    const id = f?.id;
    if (!ALLOWED_FILTERS.includes(id)) { p.push(`filter "${id}"`); continue; }
    if (!FILTERS) continue;
    const def = FILTERS[id];
    if (!def) { p.push(`filter "${id}" is not in tools/schools/filters.mjs`); continue; }
    const keys = Object.keys(def).filter(k => k !== 'exclude');
    for (const k of keys) if (!same(f[k], def[k])) p.push(`filter ${id}.${k} ${JSON.stringify(f[k])}, filters.mjs says ${JSON.stringify(def[k])}`);
    for (const k of Object.keys(f)) if (!keys.includes(k) && !FILTER_EXTRA_KEYS.includes(k)) p.push(`filter ${id} carries "${k}", which filters.mjs does not define`);
    if (f.options != null) p.push(...optionProblems(id, def, f.options, `filters[${i}].options`));
    const by = Object.entries(index.sources || {}).filter(([, s]) => (s?.publishes || []).includes(id)).map(([s]) => s).sort();
    if (!same([...(f.publishedBy || [])].sort(), by)) p.push(`filter ${id}.publishedBy ${JSON.stringify(f.publishedBy)}, but the sources that publish it are ${JSON.stringify(by)}`);
  }
  for (const [k, v] of Object.entries(index.options || {})) {
    if (!ALLOWED_FILTERS.includes(k)) p.push(`options."${k}"`);
    else if (FILTERS) p.push(...optionProblems(k, FILTERS[k], v, `options.${k}`));
  }
  for (const [id, s] of Object.entries(index.sources || {})) for (const f of s?.publishes || []) if (!ALLOWED_FILTERS.includes(f)) p.push(`sources.${id}.publishes "${f}"`);
  return p;
}
function optionProblems(id, def, options, where) {
  if (def?.type !== 'select') return [`${where}: ${id} is not a select filter`];
  const allowed = SELECT_OPTIONS[id] || [];
  return (Array.isArray(options) ? options : [options]).filter(o => !allowed.includes(o) || (def.exclude || []).includes(o)).map(o => `${where}: "${o}" is not one of ${allowed.join(', ')}`);
}

const isHttps = u => typeof u === 'string' && /^https:\/\/[^\s/]+\.[^\s]+$/.test(u);

// 3. Every source links its licence over https (and any further licence a
//    source names, and any scheme that links one). A state rating scheme whose
//    values the pack carries is republished state data: it must carry
//    publisher, attribution, licence and an https licenceUrl.
//    valueSchemes: the state ratings schemes the pack's rows carry values under.
export function licenceUrlProblems(index, valueSchemes = []) {
  const p = [];
  for (const [id, s] of Object.entries(index.sources || {})) {
    if (!isHttps(s?.licenceUrl)) p.push(`source ${id}: licenceUrl ${JSON.stringify(s?.licenceUrl ?? null)}`);
    for (const [i, l] of (s?.licences || []).entries()) if (!isHttps(l?.licenceUrl)) p.push(`source ${id}: licences[${i}].licenceUrl ${JSON.stringify(l?.licenceUrl ?? null)}`);
  }
  for (const [id, sc] of Object.entries(index.schemes || {})) if (sc?.licenceUrl != null && !isHttps(sc.licenceUrl)) p.push(`scheme ${id}: licenceUrl ${JSON.stringify(sc.licenceUrl)}`);
  for (const id of valueSchemes) {
    const sc = index.schemes?.[id];
    if (!sc) { p.push(`scheme ${id}: its values are in the pack but the index does not define it`); continue; }
    for (const k of ['publisher', 'attribution', 'licence']) if (!sc[k]) p.push(`scheme ${id}: no ${k}`);
    if (!isHttps(sc.licenceUrl)) p.push(`scheme ${id}: licenceUrl ${JSON.stringify(sc.licenceUrl ?? null)}`);
  }
  return p;
}

// 4. Every source id, wherever the index or a row names one, is a source
//    module the landing build loads (tools/<layer>/sources/*.mjs). A parked
//    module (tools/prices/parked/denver-sales.mjs) is not loaded, so its id can
//    never pass. referenced: [[where, id], …] beyond index.sources' own keys.
export function sourceIdProblems(index, loadedIds, referenced = []) {
  const ok = new Set(loadedIds), p = [];
  for (const id of Object.keys(index.sources || {})) if (!ok.has(id)) p.push(`index.sources.${id} is not a loaded source module`);
  const seen = new Set();
  for (const [where, id] of referenced) {
    if (ok.has(id) || seen.has(`${where}\u0000${id}`)) continue;
    seen.add(`${where}\u0000${id}`);
    p.push(`${where} names "${id}", not a loaded source module`);
  }
  return p;
}

// 5. Any HTML, in the index (notes, captions, any string) or in the rows
//    the chunks hold, uses no tag but <b>. extra: further values to scan
//    (the decoded chunks), as [value, path] pairs.
export function noteHtmlProblems(index, extra = []) {
  const p = [];
  const scan = (o, path) => {
    for (const [s, at] of stringsDeep(o, path)) {
      if (!s.includes('<')) continue;
      for (const m of s.matchAll(/<\s*\/?\s*([a-zA-Z!?][\w:-]*)[^>]*>/g)) if (!/^<\/?b>$/.test(m[0])) p.push(`${at}: ${m[0].slice(0, 60)}`);
    }
  };
  scan(index, '');
  for (const [v, path] of extra) scan(v, path);
  return p;
}

// 8 (schools). THE RATING LICENCE (Q4 b), keyed on the SCHEME, not on a US-
// prefix:
//  - a row on a state ratings scheme (rules.ratingSchemes) is on a licensed
//    one (lib/landing.mjs combineLicences over tools/schools/licence.mjs,
//    the one source of truth) for the row's own jurisdiction;
//  - a US row carries a rating value (rv) only under a licensed scheme, and
//    off one it carries none of the England & Wales rating fields either.
// rows: objects; rules: { ratingSchemes, ratingLicensed, LICENSED }.
export function ratingLicenceProblems(rows, rules) {
  const count = new Map(), add = k => count.set(k, (count.get(k) || 0) + 1);
  const modules = new Set(rules.ratingSchemes || []);
  for (const r of rows) {
    const s = r.ratingScheme, licensed = rules.ratingLicensed(s);
    const hasValue = !isEmpty(r.rv);
    if (modules.has(s) && !licensed) add(hasValue ? `row(s) carry a value under unlicensed state scheme ${s}` : `row(s) left on unlicensed state scheme ${s}`);
    else if (licensed && rules.LICENSED?.[s]?.juris !== r.juris) add(`${r.juris} row(s) on ${s}, which is licensed for ${rules.LICENSED?.[s]?.juris} only`);
    else if (/^US-/.test(r.juris || '') && !licensed) {
      if (hasValue) add(`US row(s) carry a value under unlicensed scheme ${s}`);
      for (const [f, v] of Object.entries(r)) if (EW_RATING_FIELD.test(f) && !isEmpty(v)) add(`US row(s) off a licensed scheme carry ${f}`);
    }
  }
  return [...count].map(([k, n]) => `${n} ${k}`);
}

// 9 (schools). Every row's scheme is defined in the pack's index (the app
// renders a row from index.schemes[row.ratingScheme]) and is either one of
// its own source module's schemes or a licensed state scheme.
export function ratingSchemeProblems(rows, schemes, rules) {
  const count = new Map(), add = k => count.set(k, (count.get(k) || 0) + 1);
  for (const r of rows) {
    const s = r.ratingScheme;
    if (!schemes?.[s]) add(`row(s) on scheme "${s}", which the pack's index does not define`);
    if (!(rules.ownSchemes?.[r.src] || []).includes(s) && !rules.ratingLicensed(s)) add(`${r.src} row(s) on scheme "${s}", neither the source's own nor a licensed state scheme`);
  }
  return [...count].map(([k, n]) => `${n} ${k}`);
}
