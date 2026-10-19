// The schools pack's Spanish display text (RELEASE-1.4-SCOPE.md §4.5 S7):
// schools.es.json, a third file next to schools-pack.json/.bin.
//
// WHAT IS TRANSLATED. Exactly the pack strings the app passes through
// SchoolDataText.display (SafeRoute/Core/Overlays/SchoolFilters.swift), found
// here by the same paths (displayStrings): the coverage line, the filters'
// nouns and places, the regions' "outside" names, the jurisdictions' names,
// areas, rules and labels, the sources' record labels, attributions, licences
// and labels, and per scheme kind:
//   ofsted          the publisher (in "Source: … ↗"), when the scheme links one
//   none            the notes (html, caveat, link label), text, the link label
//   rating, status  title, short, miss, scale, measures, caveat, year, the
//                   notes, the link label, the publisher (when it has a url)
//                   and the licence (when it has a licenceUrl)
// Row values are NOT display text: official category values (ratings,
// grades, governance words such as "Roman Catholic Maintained") stay as
// published. The one exception is Mexico City's English gloss on SEP's own
// Spanish type/phase values ("Primaria general (primary)"), which the Spanish
// app drops: an explicit table (`values`), checked against the rows.
//
// THE KEY of a string is the first 16 hex characters of SHA-256 over its exact
// UTF-8 bytes, as the app passes it (a template is keyed before it is filled).
// Nothing is normalised at run time: the build fails on text that is not NFC.
//
// THE SOURCE is tools/app-packs/i18n/schools.es.src.json (es-MX, informal tú,
// the glossary subset it carries), read from the builder's committed HEAD
// like the rules; `textCommit` is the last commit that changed THAT FILE (not
// the whole i18n/ directory: the home values' prices.es.src.json sits beside
// it, and a commit to one must never restamp the other's text). TEXT_SOURCES
// names each output file's source, for the builder and for O2's check.
//
// THE OUTPUT (schools.es.json, deterministic):
//   { version, language, hash, forPack: { landingCommit, indexSha256, binSha256 },
//     textCommit, strings: { key: { en, es } }, keep: [key], values: { key: { en, es, field } },
//     display: [key], stats: { translated, keep, identity, missing, missingKeys, values, valuesMissing } }
// `display` is every display string's key; `keep` the licence names, which
// stay English (glossary); a string with no letters passes through as it is.
// A display string with no entry is "missing": the app shows it in English
// marked "(en inglés)". Missing text does not fail the build unless
// --strict-es; everything else below does (an orphaned key first of all).

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { sha256 } from './container.mjs';
import { gate, FORBIDDEN_KEY } from './gates.mjs';

export const TEXT_FILE = 'schools.es.json';
export const TEXT_VERSION = 1;
export const TEXT_LANGUAGE = 'es-MX';
export const I18N_DIR = 'tools/app-packs/i18n';
export const SOURCE_PATH = `${I18N_DIR}/schools.es.src.json`;
// Each Spanish text file and the one source file its textCommit is taken from
// (lib/prices-text.mjs writes prices.es.json from the second).
export const TEXT_SOURCES = Object.freeze({
  'schools.es.json': SOURCE_PATH,
  'prices.es.json': `${I18N_DIR}/prices.es.src.json`,
});
export const HASH_RULE = 'sha256(utf8(en)) hex, first 16';

export const textKey = s => sha256(Buffer.from(s, 'utf8')).slice(0, 16);

// Kinds whose strings are licence names: they stay English.
export const LICENCE_KINDS = Object.freeze(['source.licence', 'scheme.licence']);
// Kinds the forbidden-word check applies to in Spanish too (what a user reads
// as a label, a title or a filter word).
const LABEL_KINDS = /^(label|label\..+|scheme\.title|scheme\.short|filter\.noun|filter\.where|source\.recordLabel)$/;
// Spanish forms of the forbidden words (FORBIDDEN_KEY is English).
export const FORBIDDEN_ES = /religi|confesi|denominaci|di[oó]cesis|creencia|fe religiosa/i;
const ANON = /an[oó]nim/i;
const FORMAL = /\busted(es)?\b/i;
const PLACEHOLDER = /\{([A-Za-z0-9_]+)\}/g;
const ARROW = ' ↗';

const hasLetter = s => /\p{L}/u.test(s);
const isNFC = s => s === s.normalize('NFC');

// ── the display strings ────────────────────────────────────────────────────
// index: the pack's slimmed index (notes split). Returns Map en -> { kinds, paths }
// in first-seen order.
export function displayStrings(index) {
  const out = new Map();
  const add = (s, kind, path) => {
    if (typeof s !== 'string' || s === '') return;
    let e = out.get(s);
    if (!e) out.set(s, (e = { kinds: [], paths: [] }));
    if (!e.kinds.includes(kind)) e.kinds.push(kind);
    e.paths.push(path);
  };
  const labels = (o, path) => {
    for (const [k, v] of Object.entries(o || {})) {
      if (typeof v === 'string') add(v, k === 'pupilsAsOf' ? 'label.template' : 'label', `${path}.${k}`);
      else if (v && typeof v === 'object') for (const [t, s] of Object.entries(v)) add(s, `label.${k}`, `${path}.${k}.${t}`);
    }
  };
  add(index.where, 'coverage.where', 'where');
  (index.filters || []).forEach((f, i) => { add(f.noun, 'filter.noun', `filters[${i}].noun`); add(f.where, 'filter.where', `filters[${i}].where`); });
  (index.regions || []).forEach((r, i) => (r.outside || []).forEach((o, j) => add(o, 'region.outside', `regions[${i}].outside[${j}]`)));
  for (const [id, j] of Object.entries(index.juris || {})) {
    add(j.name, 'juris.name', `juris.${id}.name`);
    add(j.area, 'juris.area', `juris.${id}.area`);
    add(j.rules, 'juris.rules', `juris.${id}.rules`);
    labels(j.labels, `juris.${id}.labels`);
  }
  for (const [id, s] of Object.entries(index.sources || {})) {
    if (s.recordUrl) add(s.recordLabel, 'source.recordLabel', `sources.${id}.recordLabel`);
    add(s.attribution, 'source.attribution', `sources.${id}.attribution`);
    add(s.licence, 'source.licence', `sources.${id}.licence`);
    labels(s.labels, `sources.${id}.labels`);
  }
  for (const [id, sc] of Object.entries(index.schemes || {})) {
    const p = `schemes.${id}`;
    const notes = () => (sc.notes || []).forEach((n, i) => {
      add(n.html, 'note.html', `${p}.notes[${i}].html`);
      add(n.caveat, 'note.caveat', `${p}.notes[${i}].caveat`);
      add(n.link?.label, 'note.link', `${p}.notes[${i}].link.label`);
    });
    if (sc.kind === 'ofsted') {
      if (sc.url) add(sc.publisher || 'Ofsted', 'scheme.publisher', `${p}.publisher`);
    } else if (sc.kind === 'none') {
      notes();
      add(sc.text, 'scheme.text', `${p}.text`);
      if (sc.link?.url) add(sc.link.label, 'scheme.link', `${p}.link.label`);
    } else if (sc.kind === 'rating' || sc.kind === 'status') {
      for (const f of ['title', 'short', 'miss', 'scale', 'measures', 'caveat', 'year']) add(sc[f], `scheme.${f}`, `${p}.${f}`);
      notes();
      if (sc.link?.url) add(sc.link.label, 'scheme.link', `${p}.link.label`);
      if (sc.url) add(sc.publisher, 'scheme.publisher', `${p}.publisher`);
      if (sc.licenceUrl) add(sc.licence, 'scheme.licence', `${p}.licence`);
    }
  }
  return out;
}

// ── reading the source ─────────────────────────────────────────────────────
const git = (repo, args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', maxBuffer: 1 << 26, stdio: ['ignore', 'pipe', 'pipe'] });

// The committed translation source at the builder's HEAD, and the last commit
// that changed it. `path` is the source file (schools by default; the home
// values pass TEXT_SOURCES['prices.es.json']): the dirty check and the commit
// are that file's alone, so each text is refused, and stamped, on its own.
// A working tree that differs is refused unless allowDirty (never with
// --commit), and then read and recorded "+dirty".
export function openTextSource({ repo, allowDirty = false, commit = null, path = SOURCE_PATH } = {}) {
  const dirty = git(repo, ['status', '--porcelain', '--', path]).trim();
  if (dirty && (commit != null || !allowDirty)) throw new Error(`${path} differs from HEAD (commit the translations first${commit == null ? ', or --allow-dirty' : ''}):\n${dirty.split('\n').slice(0, 10).join('\n')}`);
  let last = '';
  try { last = git(repo, ['log', '-1', '--format=%H', 'HEAD', '--', path]).trim(); } catch { /* no commits yet */ }
  if (dirty) {
    const p = join(repo, path);
    if (!existsSync(p)) throw new Error(`${path} is missing`);
    return { source: JSON.parse(readFileSync(p, 'utf8')), textCommit: `${last || 'none'}+dirty` };
  }
  if (!last) throw new Error(`${path} is not committed at HEAD`);
  let text;
  try { text = git(repo, ['show', `HEAD:${path}`]); } catch { throw new Error(`${path} is not committed at HEAD`); }
  return { source: JSON.parse(text), textCommit: last };
}

// The working-tree source (the tests read it; on a clean tree it is HEAD's).
export const readTextSource = (repo, path = SOURCE_PATH) => JSON.parse(readFileSync(join(repo, path), 'utf8'));

// ── the gates (each a pure function returning problems) ────────────────────
const show = s => JSON.stringify(s.length > 70 ? `${s.slice(0, 67)}…` : s);
const placeholders = s => [...s.matchAll(PLACEHOLDER)].map(m => m[1]).sort();
// The <b> structure: the sequence of <b>/</b> tags, which must alternate.
function markup(s) {
  const tags = [], p = [];
  for (const m of s.matchAll(/<[^>]*>?/g)) {
    if (m[0] === '<b>' || m[0] === '</b>') tags.push(m[0]);
    else p.push(`tag or raw "<": ${show(m[0])}`);
  }
  tags.forEach((t, i) => { if (t !== (i % 2 ? '</b>' : '<b>')) p.push('unbalanced <b>'); });
  if (tags.length % 2) p.push('unclosed <b>');
  if (/&(#\d+|#x[0-9a-f]+|[a-z]+);/i.test(s)) p.push('an HTML entity');
  return { tags: tags.length, p: [...new Set(p)] };
}
// The licence names a string may carry, and their bracketed short forms (the
// page's linkLicence).
export function licenceNames(index) {
  const names = new Set();
  const addName = l => {
    if (typeof l !== 'string' || !l) return;
    names.add(l);
    const m = /\(([^()]+)\)\s*$/.exec(l.trim());
    if (m) names.add(m[1]);
  };
  for (const s of Object.values(index.sources || {})) { addName(s.licence); for (const l of s.licences || []) addName(l.licence); }
  for (const sc of Object.values(index.schemes || {})) addName(sc.licence);
  return [...names];
}
// linkLicence: does the line name the licence (or its short form)?
export function linksLicence(line, licence) {
  if (!line || !licence) return false;
  const names = [licence];
  const m = /\(([^()]+)\)\s*$/.exec(licence.trim());
  if (m) names.push(m[1]);
  return names.some(n => line.includes(n));
}

// 1. Keys, hashing and text form: every key is the hash of its English; NFC;
//    no edge whitespace; no key collision among the display strings.
export function keyProblems(source, display) {
  const p = [];
  for (const [k, e] of Object.entries(source.strings || {})) {
    if (typeof e?.en !== 'string' || typeof e?.es !== 'string') { p.push(`${k}: not { en, es } strings`); continue; }
    if (textKey(e.en) !== k) p.push(`${k}: is not the hash of its English (${textKey(e.en)}) ${show(e.en)}`);
    for (const [lang, s] of [['en', e.en], ['es', e.es]]) {
      if (!isNFC(s)) p.push(`${k}: ${lang} is not NFC`);
      if (s !== s.trim()) p.push(`${k}: ${lang} has edge whitespace`);
      if (!s) p.push(`${k}: ${lang} is empty`);
    }
  }
  const seen = new Map();
  for (const en of display.keys()) {
    if (!isNFC(en)) p.push(`display string is not NFC: ${show(en)}`);
    if (en !== en.trim()) p.push(`display string has edge whitespace: ${show(en)}`);
    const k = textKey(en);
    if (seen.has(k) && seen.get(k) !== en) p.push(`key collision ${k}: ${show(en)} and ${show(seen.get(k))}`);
    seen.set(k, en);
  }
  return p;
}

// 2. Orphans: a source entry whose English is not shown by the pack.
export function orphanProblems(source, display) {
  return Object.entries(source.strings || {}).filter(([, e]) => typeof e?.en === 'string' && !display.has(e.en)).map(([k, e]) => `orphaned key ${k}: ${show(e.en)} is not a display string of this pack`);
}

// 3–5. Same placeholders, same <b> structure (no other tag, no raw "<"), the
//      same trailing " ↗".
export function formProblems(source) {
  const p = [];
  for (const [k, { en, es } = {}] of Object.entries(source.strings || {})) {
    if (typeof en !== 'string' || typeof es !== 'string') continue;
    if (placeholders(en).join() !== placeholders(es).join()) p.push(`${k}: placeholders {${placeholders(en)}} in English, {${placeholders(es)}} in Spanish`);
    const a = markup(en), b = markup(es);
    for (const x of b.p) p.push(`${k}: Spanish has ${x}`);
    if (a.tags !== b.tags) p.push(`${k}: ${a.tags / 2} <b> runs in English, ${b.tags / 2} in Spanish`);
    if (en.endsWith(ARROW) !== es.endsWith(ARROW)) p.push(`${k}: the trailing " ↗" is in one language only`);
  }
  return p;
}

// 6. Licence names stay English: a licence string's Spanish equals its
//    English; every licence name (or short form) in an English string is in
//    its Spanish too; and each source's attribution links its licence in
//    Spanish wherever it does in English (linkLicence).
export function licenceProblems(source, display, index) {
  const p = [], S = source.strings || {};
  const es = en => S[textKey(en)]?.en === en ? S[textKey(en)].es : null;
  for (const [en, e] of display) {
    if (e.kinds.some(k => LICENCE_KINDS.includes(k)) && es(en) != null && es(en) !== en) p.push(`licence name ${show(en)} is translated (it stays English)`);
  }
  const names = licenceNames(index);
  for (const [k, e] of Object.entries(S)) {
    if (typeof e?.en !== 'string' || typeof e?.es !== 'string') continue;
    for (const n of names) if (e.en.includes(n) && !e.es.includes(n)) p.push(`${k}: the licence name ${show(n)} is in the English but not the Spanish`);
  }
  for (const [id, s] of Object.entries(index.sources || {})) {
    const line = s.attribution, lineEs = line && es(line);
    if (!line || lineEs == null) continue;
    const lic = s.licence;
    if (linksLicence(line, lic) && !linksLicence(lineEs, lic)) p.push(`source ${id}: the Spanish attribution no longer names its licence, so it would not be linked`);
    if (!linksLicence(line, lic) && linksLicence(lineEs, lic)) p.push(`source ${id}: the Spanish attribution names a licence the English does not`);
  }
  return p;
}

// 7–9. No religion word in a Spanish label, title or filter word; never
//      "anónimo"; never the formal usted/ustedes (es-MX informal tú).
export function wordProblems(source, display) {
  const p = [];
  for (const [k, { en, es } = {}] of Object.entries(source.strings || {})) {
    if (typeof es !== 'string') continue;
    const kinds = display.get(en)?.kinds || [];
    if (kinds.some(x => LABEL_KINDS.test(x)) && (FORBIDDEN_KEY.test(es) || FORBIDDEN_ES.test(es))) p.push(`${k}: a forbidden word in a label: ${show(es)}`);
    if (ANON.test(es)) p.push(`${k}: "anónimo" (never): ${show(es)}`);
    if (FORMAL.test(es)) p.push(`${k}: formal "usted" (es-MX uses tú): ${show(es)}`);
  }
  return p;
}

// 10. The glossary, used consistently: where the English has a term, the
//     Spanish has its rendering; and every acronym or brand in capitals stays,
//     or is spelled out as the glossary's acronymExpansions say (BC is
//     "Columbia Británica": to a Mexican reader BC is Baja California).
export function glossaryProblems(source) {
  const p = [];
  const terms = (source.glossary?.terms || []).map(t => ({ ...t, enRe: new RegExp(t.enPattern, 'iu'), esRe: new RegExp(t.esPattern, 'iu') }));
  const except = new Set(source.glossary?.acronymExceptions || []);
  const expand = source.glossary?.acronymExpansions || {};
  for (const [k, { en, es } = {}] of Object.entries(source.strings || {})) {
    if (typeof en !== 'string' || typeof es !== 'string') continue;
    for (const t of terms) if (t.enRe.test(en) && !t.esRe.test(es)) p.push(`${k}: "${t.en}" should be "${t.es}" (glossary): ${show(es)}`);
    for (const a of new Set(en.match(/\b[A-Z][A-Z0-9]+\b/g) || [])) {
      if (except.has(a) || new RegExp(`\\b${a}\\b`).test(es)) continue;
      const x = expand[a]?.es;
      if (x && es.includes(x)) continue;
      p.push(`${k}: ${a} (a name) is missing from the Spanish${x ? ` (and not spelled out as "${x}")` : ''}`);
    }
  }
  return p;
}

// 11. The Mexico City gloss table: each entry is a SEP type/phase value with
//     exactly one trailing " ( … )", its Spanish is that value without it, and
//     the English occurs as no other value (another source, another field).
//     Also returns the SEP values of that shape the table does not cover.
const GLOSS = /^([^()]*\S) \(([^()]+)\)$/;
export const GLOSS_FIELDS = Object.freeze(['type', 'phase']);
export function glossProblems(source, rows) {
  const p = [];
  const sepValues = new Map(GLOSS_FIELDS.map(f => [f, new Set()]));
  const elsewhere = new Set();
  for (const r of rows) {
    for (const [f, v] of Object.entries(r)) {
      if (typeof v !== 'string' || !v) continue;
      if (r.src === 'sep' && GLOSS_FIELDS.includes(f)) sepValues.get(f).add(v);
      else elsewhere.add(v);
    }
  }
  const covered = new Set();
  for (const [k, e] of Object.entries(source.values || {})) {
    if (typeof e?.en !== 'string' || typeof e?.es !== 'string') { p.push(`value ${k}: not { en, es } strings`); continue; }
    if (textKey(e.en) !== k) p.push(`value ${k}: is not the hash of its English ${show(e.en)}`);
    if (!GLOSS_FIELDS.includes(e.field)) p.push(`value ${k}: field "${e.field}" (the gloss is dropped from SEP type and phase only)`);
    else if (!sepValues.get(e.field).has(e.en)) p.push(`value ${k}: ${show(e.en)} is not a SEP ${e.field} value in this pack`);
    const m = GLOSS.exec(e.en);
    if (!m) p.push(`value ${k}: ${show(e.en)} does not end in exactly one " (…)"`);
    else if (e.es !== m[1]) p.push(`value ${k}: Spanish ${show(e.es)} is not the value without its gloss (${show(m[1])})`);
    if (elsewhere.has(e.en)) p.push(`value ${k}: ${show(e.en)} is also a value outside SEP's type/phase`);
    if (!isNFC(e.en) || !isNFC(e.es)) p.push(`value ${k}: not NFC`);
    covered.add(e.en);
  }
  const uncovered = [];
  for (const [, vs] of sepValues) for (const v of vs) if (GLOSS.test(v) && !covered.has(v)) uncovered.push(v);
  return { problems: p, uncovered: [...new Set(uncovered)].sort() };
}

// 12. Rating values stay as published: no display string, and no translated
//     or gloss entry, is ever equal to a row's rating value (rv).
export function ratingValueProblems(source, display, rows) {
  const rvs = new Set(rows.map(r => r.rv).filter(v => typeof v === 'string' && v));
  const p = [];
  for (const en of display.keys()) if (rvs.has(en)) p.push(`display string ${show(en)} is a rating value`);
  for (const [k, e] of [...Object.entries(source.strings || {}), ...Object.entries(source.values || {})]) if (rvs.has(e?.en)) p.push(`${k}: ${show(e.en)} is a rating value; it stays as published`);
  return p;
}

// ── build ──────────────────────────────────────────────────────────────────
// pack: packSchools()'s result ({ json, bin }); rows: the pack's rows as
// objects; source: the parsed source; landingCommit/textCommit: strings.
// Returns { text, gates, report }; the caller fails the build on any gate.
export function buildSchoolsText({ json, bin, rows, source, landingCommit, textCommit, strictEs = false }) {
  const { pack, ...index } = JSON.parse(json);
  const display = displayStrings(index);
  const S = source.strings || {};
  const strings = {}, keep = [], all = [], missingKeys = [];
  let identity = 0;
  for (const [en, e] of display) {
    const k = textKey(en);
    all.push(k);
    if (e.kinds.every(x => LICENCE_KINDS.includes(x))) { keep.push(k); continue; }
    if (!hasLetter(en)) { identity++; continue; }
    if (S[k]?.en === en && typeof S[k].es === 'string') strings[k] = { en, es: S[k].es };
    else missingKeys.push(k);
  }
  const gloss = glossProblems(source, rows);
  const values = {};
  for (const [k, e] of Object.entries(source.values || {}).sort(([, a], [, b]) => (a.field + a.en < b.field + b.en ? -1 : 1))) values[k] = { en: e.en, es: e.es, field: e.field };
  const stats = { translated: Object.keys(strings).length, keep: keep.length, identity, missing: missingKeys.length, missingKeys, values: Object.keys(values).length, valuesMissing: gloss.uncovered.length };

  const gates = [
    gate('es-keys', keyProblems(source, display), `${display.size} display strings, ${Object.keys(S).length} source entries; keys = ${HASH_RULE}; NFC; no collision`),
    gate('es-orphans', orphanProblems(source, display), 'every source entry is a display string of this pack'),
    gate('es-form', formProblems(source), 'same {placeholders}, same <b> runs (no other tag), same trailing " ↗"'),
    gate('es-licences', licenceProblems(source, display, index), `${keep.length} licence names kept in English; each attribution still links its licence`),
    gate('es-words', wordProblems(source, display), 'no religion word in a label, title or filter word; never "anónimo"; tú, never usted'),
    gate('es-glossary', glossaryProblems(source), `${(source.glossary?.terms || []).length} glossary terms; names in capitals kept`),
    gate('es-gloss', gloss.problems, `${stats.values} Mexico City values lose their English gloss in Spanish (SEP type/phase only)`),
    gate('es-rating-values', ratingValueProblems(source, display, rows), 'rating values are never display text'),
  ];
  const enOf = new Map([...display.keys()].map(en => [textKey(en), en]));
  if (strictEs) gates.push(gate('es-complete', [...missingKeys.map(k => `missing ${k}: ${show(enOf.get(k))}`), ...gloss.uncovered.map(v => `gloss not covered: ${show(v)}`)], 'every display string and Mexico City gloss translated (--strict-es)'));

  const doc = {
    version: TEXT_VERSION, language: source.language || TEXT_LANGUAGE, hash: HASH_RULE,
    forPack: { landingCommit, indexSha256: sha256(Buffer.from(json)), binSha256: sha256(bin) },
    textCommit,
    strings, keep, values, display: all, stats,
  };
  const text = `${JSON.stringify(doc, null, 1)}\n`;
  return {
    text, gates,
    report: { file: TEXT_FILE, sha256: sha256(Buffer.from(text)), bytes: Buffer.byteLength(text), textCommit, language: doc.language, stats, forPack: doc.forPack },
  };
}
