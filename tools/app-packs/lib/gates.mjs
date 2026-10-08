// The O1 gates (RELEASE-1.4-SCOPE.md §4.4). Each is a pure function over the
// pack being built, returning a list of problems; any problem fails the build
// and nothing is written. They are separate functions so each can be proved
// against a fixture that must fail (test/gates.test.mjs).

// Religion is never a field, a filter or a colour (schools house rule), and
// the same names never enter either pack under any key.
export const FORBIDDEN_KEY = /relig|denomin|faith|diocese|typology|orient/i;

// The only optional school filters the app may offer. Sector and phase are
// fixed controls, not filters.
export const ALLOWED_FILTERS = Object.freeze(['gender', 'boarding', 'charter']);

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

// Every object key at any depth, with its path.
function* keysDeep(o, path = '') {
  if (Array.isArray(o)) { for (let i = 0; i < o.length; i++) yield* keysDeep(o[i], `${path}[${i}]`); return; }
  if (!o || typeof o !== 'object') return;
  for (const k of Object.keys(o)) { yield [k, `${path}.${k}`]; yield* keysDeep(o[k], `${path}.${k}`); }
}
// Every string at any depth, with its path.
function* stringsDeep(o, path = '') {
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

// 2. Filters: only gender, boarding and charter, in index.filters and in
//    index.options (the select options keyed by filter id).
export function filterProblems(index) {
  const p = [];
  for (const f of index.filters || []) if (!ALLOWED_FILTERS.includes(f?.id)) p.push(`filter "${f?.id}"`);
  for (const k of Object.keys(index.options || {})) if (!ALLOWED_FILTERS.includes(k)) p.push(`options."${k}"`);
  return p;
}

const isHttps = u => typeof u === 'string' && /^https:\/\/[^\s/]+\.[^\s]+$/.test(u);

// 3. Every source links its licence over https (and any further licence a
//    source names, and any scheme that links one).
export function licenceUrlProblems(index) {
  const p = [];
  for (const [id, s] of Object.entries(index.sources || {})) {
    if (!isHttps(s?.licenceUrl)) p.push(`source ${id}: licenceUrl ${JSON.stringify(s?.licenceUrl ?? null)}`);
    for (const [i, l] of (s?.licences || []).entries()) if (!isHttps(l?.licenceUrl)) p.push(`source ${id}: licences[${i}].licenceUrl ${JSON.stringify(l?.licenceUrl ?? null)}`);
  }
  for (const [id, sc] of Object.entries(index.schemes || {})) if (sc?.licenceUrl != null && !isHttps(sc.licenceUrl)) p.push(`scheme ${id}: licenceUrl ${JSON.stringify(sc.licenceUrl)}`);
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

// 5. Any HTML in the index (notes, captions, any string) uses no tag but <b>.
export function noteHtmlProblems(index) {
  const p = [];
  for (const [s, path] of stringsDeep(index)) {
    for (const m of s.matchAll(/<\s*\/?\s*([a-zA-Z][\w:-]*)[^>]*>/g)) {
      if (!/^<\/?b>$/.test(m[0])) p.push(`${path}: ${m[0].slice(0, 60)}`);
    }
  }
  return p;
}

// 8 (schools). A US school carries a rating value only under a scheme the
// licence allow-list names (tools/schools/licence.mjs, the one source of
// truth), and no US school is left on an unlicensed state ratings scheme.
// rows: objects; usRatingSchemes: ids of the state ratings modules.
export function ratingLicenceProblems(rows, ratingLicensed, usRatingSchemes = []) {
  const p = [], bad = new Map(), stranded = new Map();
  const modules = new Set(usRatingSchemes);
  for (const r of rows) {
    if (!/^US-/.test(r.juris || '')) continue;
    if (r.rv !== '' && r.rv != null && !ratingLicensed(r.ratingScheme)) bad.set(r.ratingScheme, (bad.get(r.ratingScheme) || 0) + 1);
    else if (modules.has(r.ratingScheme) && !ratingLicensed(r.ratingScheme)) stranded.set(r.ratingScheme, (stranded.get(r.ratingScheme) || 0) + 1);
  }
  for (const [s, n] of bad) p.push(`${n} US row(s) carry a value under unlicensed scheme ${s}`);
  for (const [s, n] of stranded) p.push(`${n} US row(s) left on unlicensed state scheme ${s}`);
  return p;
}
