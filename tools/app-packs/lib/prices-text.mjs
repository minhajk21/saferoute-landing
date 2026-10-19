// The home-values pack's Spanish display text (RELEASE-1.4-SCOPE.md §4.6 H5):
// prices.es.json, written next to prices-pack.json/.bin, in the same shape as
// schools.es.json (lib/schools-text.mjs) so the app reads both with one loader
// (SafeRoute/Core/Overlays/PackTextOverlay.swift).
//
// WHAT IS TRANSLATED. Exactly the pack strings the app passes through
// PriceDataText.display (SafeRoute/Core/Overlays/PriceDataText.swift), found
// here by the same paths (displayStrings):
//   index.where, index.scope
//   sources.<id>.metric, .unitNoun (and its one-form, "sales" -> "sale", as the
//     web's prOne makes it), .areaNoun, .notes[j]
//   scales[i].name, scales[i].metric
//   regions[i].name, regions[i].outside[j]
//   juris.<id>.name, juris.<id>.area
//   missing[i].name, missing[i].reason
// KEPT IN ENGLISH (`keep`, HD12): licence names, and each source's dataset
// name, publisher and credit, which sit beside the attribution lines they
// name. ATTRIBUTION LINES are not display text at all: verbatim English.
// PERIODS AND CONTEXT LABELS are not keyed: the app rebuilds them in the
// interface language from their fields (lib/prices-periods.mjs, gate
// pr-periods).
//
// THE KEY is schools-text.mjs's: the first 16 hex of SHA-256 over the
// English's UTF-8. THE SOURCE is tools/app-packs/i18n/prices.es.src.json
// (es-MX, informal tú), read from the builder's committed HEAD; textCommit is
// the last commit that changed that file (TEXT_SOURCES).
//
// A display string with no entry is "missing" (shown in English, marked
// "(en inglés)"), and fails only under --strict-es. A refreshed pack whose
// note changed (Hennepin's months and amounts move with each rebuild) has a
// new key, so its old translation becomes an orphan: the build fails until
// the source is updated. Everything below fails the build.

import { sha256 } from './container.mjs';
import { gate } from './gates.mjs';
import { textKey, keyProblems, orphanProblems, formProblems, glossaryProblems, licenceNames, HASH_RULE } from './schools-text.mjs';
import { periodProblems } from './prices-periods.mjs';

export const PRICES_TEXT_FILE = 'prices.es.json';
export const PRICES_TEXT_VERSION = 1;
export const PRICES_TEXT_LANGUAGE = 'es-MX';
// The gates buildPricesText adds to the prices pack's (O2 requires each).
export const PRICES_TEXT_GATES = Object.freeze(['pr-periods', 'pr-es-keys', 'pr-es-orphans', 'pr-es-form', 'pr-es-words', 'pr-es-money', 'pr-es-shared', 'pr-es-licences', 'pr-es-glossary']);

// Kinds kept in English (HD12): licence names, dataset names, publishers, credits.
export const KEEP_KINDS = Object.freeze(['source.licence', 'source.licences', 'source.name', 'source.publisher', 'source.credit']);
// Labels: where an owners' estimate may never be called a price.
const LABEL_KINDS = new Set(['source.metric', 'source.unitNoun', 'source.unitNoun.one', 'source.areaNoun', 'scale.name', 'scale.metric']);
const ANON = /an[oó]nim/i;
const FORMAL = /\busted(es)?\b/i;
const PROMEDIO = /promedio/i;
// The standalone word "media"/"medias" (the mean), never "mediana"; "medio"
// ("por medio de", "en medio") is ordinary Spanish and allowed (§4.6 H5
// bans "media").
const MEDIA = /(?<!\p{L})medias?(?!\p{L})/iu;
const PRECIO = /precio/i;
const PRICE_EN = /price/i;
const AVERAGE = /average/i;

const hasLetter = s => /\p{L}/u.test(s);
const show = s => JSON.stringify(s.length > 70 ? `${s.slice(0, 67)}…` : s);
const isEstimate = src => /estimate/i.test(src?.metric || '');
// prOne: "sales" -> "sale".
export const oneForm = noun => noun.replace(/s$/, '');

// ── the display strings ────────────────────────────────────────────────────
// index: the pack's slimmed index. Returns Map en -> { kinds, paths, estimate }
// in first-seen order; `estimate`: reached from an owners'-estimate source.
export function displayStrings(index) {
  const out = new Map();
  const add = (s, kind, path, estimate = false) => {
    if (typeof s !== 'string' || s === '') return;
    let e = out.get(s);
    if (!e) out.set(s, (e = { kinds: [], paths: [], estimate: false }));
    if (!e.kinds.includes(kind)) e.kinds.push(kind);
    e.paths.push(path);
    if (estimate) e.estimate = true;
  };
  add(index.where, 'coverage.where', 'where');
  add(index.scope, 'coverage.scope', 'scope');
  const sources = index.sources || {};
  for (const [id, s] of Object.entries(sources)) {
    const p = `sources.${id}`, est = isEstimate(s);
    add(s.metric, 'source.metric', `${p}.metric`, est);
    add(s.unitNoun, 'source.unitNoun', `${p}.unitNoun`, est);
    if (typeof s.unitNoun === 'string' && oneForm(s.unitNoun) !== s.unitNoun) add(oneForm(s.unitNoun), 'source.unitNoun.one', `${p}.unitNoun(one)`, est);
    add(s.areaNoun, 'source.areaNoun', `${p}.areaNoun`, est);
    (s.notes || []).forEach((n, j) => add(n, 'source.note', `${p}.notes[${j}]`, est));
    add(s.name, 'source.name', `${p}.name`);
    add(s.publisher, 'source.publisher', `${p}.publisher`);
    add(s.credit, 'source.credit', `${p}.credit`);
    add(s.licence, 'source.licence', `${p}.licence`);
    (s.licences || []).forEach((l, j) => add(l?.licence, 'source.licences', `${p}.licences[${j}].licence`));
  }
  (index.scales || []).forEach((sc, i) => {
    const est = isEstimate(sources[sc.source]) || isEstimate(sc);
    add(sc.name, 'scale.name', `scales[${i}].name`, est);
    add(sc.metric, 'scale.metric', `scales[${i}].metric`, est);
  });
  (index.regions || []).forEach((r, i) => {
    add(r.name, 'region.name', `regions[${i}].name`);
    (r.outside || []).forEach((o, j) => add(o, 'region.outside', `regions[${i}].outside[${j}]`));
  });
  for (const [id, j] of Object.entries(index.juris || {})) {
    add(j.name, 'juris.name', `juris.${id}.name`);
    add(j.area, 'juris.area', `juris.${id}.area`);
  }
  (index.missing || []).forEach((m, i) => {
    add(m.name, 'missing.name', `missing[${i}].name`);
    add(m.reason, 'missing.reason', `missing[${i}].reason`);
  });
  return out;
}

// The attribution lines (verbatim, never display text).
export function attributionLines(index) {
  const out = [];
  for (const s of Object.values(index.sources || {})) {
    const a = s.attribution;
    for (const l of Array.isArray(a) ? a : a ? [a] : []) if (typeof l === 'string' && l) out.push(l);
  }
  return out;
}

// ── the gates (each a pure function returning problems) ────────────────────

// Never "promedio" or a standalone "media" in Spanish; never "average" in the
// English; tú, never usted; never "anónimo"; and in a LABEL reached from an
// owners'-estimate source never "precio" (nor "price" in its English). Notes
// may say "no son precios de venta": the rule is the labels' (§4.6 H5).
export function priceWordProblems(source, display) {
  const p = [];
  for (const [en, e] of display) {
    if (AVERAGE.test(en)) p.push(`display string says "average": ${show(en)}`);
    if (e.estimate && e.kinds.some(k => LABEL_KINDS.has(k)) && PRICE_EN.test(en)) p.push(`an owners'-estimate label says "price": ${show(en)}`);
  }
  for (const [k, { en, es } = {}] of Object.entries(source.strings || {})) {
    if (typeof es !== 'string') continue;
    if (PROMEDIO.test(es)) p.push(`${k}: "promedio" (never; the figure is a median): ${show(es)}`);
    if (MEDIA.test(es)) p.push(`${k}: the standalone word "media" (the mean; a median is "mediana"): ${show(es)}`);
    if (AVERAGE.test(en ?? '')) p.push(`${k}: "average" in the English: ${show(en)}`);
    const d = display.get(en);
    if (d?.estimate && d.kinds.some(x => LABEL_KINDS.has(x)) && PRECIO.test(es)) p.push(`${k}: "precio" in an owners'-estimate label: ${show(es)}`);
    if (ANON.test(es)) p.push(`${k}: "anónimo" (never): ${show(es)}`);
    if (FORMAL.test(es)) p.push(`${k}: formal "usted" (es-MX uses tú): ${show(es)}`);
  }
  return p;
}

// Money stays in the source currency and is never converted: the same
// numbers in both languages (as a multiset, grouping ignored, so a Spanish
// sentence may reorder them); every US dollar amount written "US$" in
// Spanish (HD1: a bare "$" reads as pesos in Mexico), never a bare "$"; "£"
// and "CA$" as many times as in the English.
const NUMBER = /\d+(?:[.,]\d+)*/g;
const numbers = s => (s.match(NUMBER) || []).map(n => n.replace(/,/g, '')).sort();
const count = (s, re) => (s.match(re) || []).length;
const BARE_DOLLAR = /(?<![A-Za-z])\$/g;
export function moneyProblems(source) {
  const p = [];
  for (const [k, { en, es } = {}] of Object.entries(source.strings || {})) {
    if (typeof en !== 'string' || typeof es !== 'string') continue;
    const a = numbers(en), b = numbers(es);
    if (a.join('|') !== b.join('|')) p.push(`${k}: numbers ${JSON.stringify(a)} in English, ${JSON.stringify(b)} in Spanish (never converted or dropped)`);
    if (count(es, BARE_DOLLAR)) p.push(`${k}: a bare "$" in Spanish (write US$): ${show(es)}`);
    if (count(en, BARE_DOLLAR) !== count(es, /US\$/g)) p.push(`${k}: ${count(en, BARE_DOLLAR)} US dollar amount(s) in English, ${count(es, /US\$/g)} "US$" in Spanish`);
    if (count(en, /£/g) !== count(es, /£/g)) p.push(`${k}: "£" ${count(en, /£/g)} times in English, ${count(es, /£/g)} in Spanish`);
    if (count(en, /CA\$/g) !== count(es, /CA\$/g)) p.push(`${k}: "CA$" ${count(en, /CA\$/g)} times in English, ${count(es, /CA\$/g)} in Spanish`);
    if (count(en, /€/g) || count(es, /€/g)) p.push(`${k}: "€" (no source is in euros)`);
  }
  return p;
}

// SD18: a string the schools text also translates has the same Spanish
// (England, Wales, Northern Ireland, New York, the District of Columbia…).
export function sharedProblems(source, schoolsSource) {
  const p = [], S = schoolsSource?.strings || {};
  for (const [k, { en, es } = {}] of Object.entries(source.strings || {})) {
    const o = S[k];
    if (o && o.en === en && o.es !== es) p.push(`${k}: ${show(en)} is ${show(es)} here but ${show(o.es)} in schools.es.src.json (SD18)`);
  }
  return p;
}

// Licence names stay English: no kept string has a translation; a licence
// name (or the short form in its last brackets) in an English string is in
// its Spanish too; and no attribution line is translated (they are verbatim,
// so each still names, and links, its licence).
export function priceLicenceProblems(source, display, index) {
  const p = [], S = source.strings || {};
  for (const [en, e] of display) {
    if (e.kinds.every(k => KEEP_KINDS.includes(k)) && S[textKey(en)]?.en === en) p.push(`kept string ${show(en)} has a translation (it stays English: ${e.kinds.join(', ')})`);
  }
  const names = licenceNames(index);
  for (const [k, e] of Object.entries(S)) {
    if (typeof e?.en !== 'string' || typeof e?.es !== 'string') continue;
    for (const n of names) if (e.en.includes(n) && !e.es.includes(n)) p.push(`${k}: the licence name ${show(n)} is in the English but not the Spanish`);
  }
  for (const l of attributionLines(index)) if (S[textKey(l)]?.en === l) p.push(`attribution line ${show(l)} has a translation (attribution stays verbatim)`);
  return p;
}

// ── build ──────────────────────────────────────────────────────────────────
// json, bin: packPrices()'s result; source: the parsed prices.es.src.json;
// schoolsSource: the parsed schools.es.src.json (pr-es-shared).
export function buildPricesText({ json, bin, source, schoolsSource, landingCommit, textCommit, strictEs = false, openPack }) {
  const { pack, ...index } = JSON.parse(json);
  const display = displayStrings(index);
  const S = source.strings || {};
  const strings = {}, keep = [], all = [], missingKeys = [];
  let identity = 0;
  for (const [en, e] of display) {
    const k = textKey(en);
    all.push(k);
    if (e.kinds.every(x => KEEP_KINDS.includes(x))) { keep.push(k); continue; }
    if (!hasLetter(en)) { identity++; continue; }
    if (S[k]?.en === en && typeof S[k].es === 'string') strings[k] = { en, es: S[k].es };
    else missingKeys.push(k);
  }
  // Every row's context, for pr-periods.
  const contexts = [];
  if (openPack) {
    const { chunk } = openPack(json, bin);
    const F = Object.fromEntries(index.fields.map((f, i) => [f, i]));
    pack.chunks.forEach((_, ci) => {
      const t = JSON.parse(chunk(ci));
      for (const r of t.a) if (r[F.ctx] != null) contexts.push([pack.sourceIds[r[F.src]], t.c[r[F.ctx]]]);
    });
  }
  const periods = periodProblems(index, contexts);
  const stats = { translated: Object.keys(strings).length, keep: keep.length, identity, missing: missingKeys.length, missingKeys };

  const gates = [
    gate('pr-periods', periods.problems, `every period (${Object.keys(index.sources || {}).length} sources, ${(index.scales || []).length} scales), window span and ${periods.labels} context labels rebuilt from their fields`),
    gate('pr-es-keys', keyProblems(source, display), `${display.size} display strings, ${Object.keys(S).length} source entries; keys = ${HASH_RULE}; NFC; no collision`),
    gate('pr-es-orphans', orphanProblems(source, display), 'every source entry is a display string of this pack'),
    gate('pr-es-form', formProblems(source), 'same {placeholders}, no tag, no entity'),
    gate('pr-es-words', priceWordProblems(source, display), 'never "promedio", a standalone "media" or "average"; no "precio"/"price" in an owners\'-estimate label; tú, never usted; never "anónimo"'),
    gate('pr-es-money', moneyProblems(source), 'the same numbers; US$ for every US dollar amount, never a bare $; £ and CA$ as published'),
    gate('pr-es-shared', sharedProblems(source, schoolsSource), 'a string the schools text translates has the same Spanish (SD18)'),
    gate('pr-es-licences', priceLicenceProblems(source, display, index), `${keep.length} names and licences kept in English; attribution lines verbatim`),
    gate('pr-es-glossary', glossaryProblems(source), `${(source.glossary?.terms || []).length} glossary terms; names in capitals kept`),
  ];
  const enOf = new Map([...display.keys()].map(en => [textKey(en), en]));
  if (strictEs) gates.push(gate('pr-es-complete', missingKeys.map(k => `missing ${k}: ${show(enOf.get(k))}`), 'every display string translated (--strict-es)'));

  const doc = {
    version: PRICES_TEXT_VERSION, language: source.language || PRICES_TEXT_LANGUAGE, hash: HASH_RULE,
    forPack: { landingCommit, indexSha256: sha256(Buffer.from(json)), binSha256: sha256(bin) },
    textCommit,
    strings, keep, values: {}, display: all, stats,
  };
  const text = `${JSON.stringify(doc, null, 1)}\n`;
  return {
    text, gates,
    report: { file: PRICES_TEXT_FILE, sha256: sha256(Buffer.from(text)), bytes: Buffer.byteLength(text), textCommit, language: doc.language, stats, forPack: doc.forPack },
  };
}
