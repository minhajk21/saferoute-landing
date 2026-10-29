// node --test tools/app-packs/test/*.test.mjs
// H5: the home-values pack's Spanish display text (lib/prices-text.mjs) and
// the periods the app rebuilds (lib/prices-periods.mjs). On the real pack and
// the committed sources every gate passes and nothing is missing; each gate
// fails on a fixture made to break it, and only that gate; the file is
// deterministic and tied to the pack it was built with.
import test from 'node:test';
import assert from 'node:assert/strict';
import { packPrices } from '../lib/prices.mjs';
import { openPack, sha256 } from '../lib/container.mjs';
import { REPO } from '../lib/landing.mjs';
import { textKey, readTextSource, TEXT_SOURCES } from '../lib/schools-text.mjs';
import {
  displayStrings, buildPricesText, priceWordProblems, moneyProblems, sharedProblems, stopProblems, oneForm, PRICES_TEXT_GATES, KEEP_KINDS, attributionLines,
  attributionTextProblems,
} from '../lib/prices-text.mjs';
import { periodProblems } from '../lib/prices-periods.mjs';
import { realPrices, LANDING } from './helpers.mjs';

let built;
async function real() {
  if (built) return built;
  const { input, rules } = await realPrices();
  const b = packPrices(input, rules, LANDING);
  const { pack, ...index } = JSON.parse(b.json);
  built = {
    b, index, display: displayStrings(index),
    source: readTextSource(REPO, TEXT_SOURCES['prices.es.json']),
    schools: readTextSource(REPO),
  };
  return built;
}
const copy = s => structuredClone(s);
const run = (b, source, schools, o = {}) => buildPricesText({ json: b.json, bin: b.bin, source, schoolsSource: schools, landingCommit: LANDING.landingCommit, textCommit: 'c'.repeat(40), openPack, ...o });
const entry = (src, en) => { const e = src.strings[textKey(en)]; assert.ok(e, `no entry for ${en}`); return e; };
const failsGate = (r, name, re) => {
  const g = r.gates.find(x => x.name === name);
  assert.ok(g && !g.ok, `${name} should fail`);
  if (re) assert.match(g.problems.join('\n'), re);
  for (const o of r.gates) if (o.name !== name) assert.ok(o.ok, `only ${name} should fail, ${o.name} did: ${o.problems.slice(0, 2)}`);
};
// The pack JSON with its index changed (the .bin, and so its sha256, untouched).
const withIndex = (b, fn) => {
  const doc = JSON.parse(b.json);
  fn(doc);
  return { ...b, json: JSON.stringify(doc) };
};

// ── the real pack ───────────────────────────────────────────────────────────
test('real pack: every gate passes, nothing is missing, names and licences stay English', async () => {
  const { b, index, display, source, schools } = await real();
  const r = run(b, source, schools, { strictEs: true });
  assert.deepEqual(r.gates.map(g => g.name), [...PRICES_TEXT_GATES, 'pr-es-complete']);
  for (const g of r.gates) assert.ok(g.ok, `${g.name}: ${g.problems.slice(0, 3).join(' | ')}`);
  const doc = JSON.parse(r.text);
  assert.equal(doc.stats.missing, 0);
  assert.equal(doc.display.length, display.size);
  assert.equal(doc.stats.translated + doc.stats.keep + doc.stats.identity, display.size);
  for (const k of doc.keep) assert.ok(!doc.strings[k]);
  // The kept strings are exactly the names, publishers, credits and licences.
  for (const [en, e] of display) assert.equal(doc.keep.includes(textKey(en)), e.kinds.every(x => KEEP_KINDS.includes(x)), en);
  assert.deepEqual(doc.values, {});
  // The shape the app's one loader reads (as schools.es.json's), plus the
  // Spanish beside a disclaimer line, which that loader does not read.
  assert.deepEqual(Object.keys(doc), ['version', 'language', 'hash', 'forPack', 'textCommit', 'strings', 'keep', 'values', 'attribution', 'display', 'stats']);
  assert.equal(doc.language, 'es-MX');
  // Hennepin County's disclaimer (its second attribution line) has Spanish
  // beside it, and is still no display string; no other line has any.
  const hen = index.sources['hennepin-sales'].attribution;
  assert.equal(hen.length, 2);
  assert.match(hen[1], /^Hennepin County’s disclaimer for its GIS open data: “This data \(i\) is furnished ‘AS IS’/);
  assert.deepEqual(Object.keys(doc.attribution), [textKey(hen[1])]);
  const d = doc.attribution[textKey(hen[1])];
  assert.equal(d.en, hen[1]);
  assert.equal(d.source, 'hennepin-sales');
  assert.match(d.es, /^Aviso de exención de responsabilidad del condado de Hennepin .*‘TAL CUAL’ \(AS IS\).* sin garantía de ningún tipo/);
  assert.match(d.review, /native review/);
  assert.equal(doc.stats.attribution, 1);
  assert.ok(!display.has(hen[1]) && !doc.display.includes(textKey(hen[1])) && !doc.strings[textKey(hen[1])]);
});

test('the display paths: what PriceDataText shows, never an attribution line or a period', async () => {
  const { index, display } = await real();
  const kinds = new Set([...display.values()].flatMap(e => e.kinds));
  for (const k of ['coverage.where', 'coverage.scope', 'source.metric', 'source.unitNoun', 'source.unitNoun.one', 'source.areaNoun', 'source.note',
    'source.name', 'source.publisher', 'source.credit', 'source.licence', 'source.licences', 'scale.name', 'scale.metric',
    'region.name', 'region.outside', 'juris.name', 'juris.area', 'missing.name', 'missing.reason']) assert.ok(kinds.has(k), k);
  for (const l of attributionLines(index)) assert.ok(!display.has(l), l);
  for (const s of Object.values(index.sources)) assert.ok(!display.has(s.period), s.period);
  // 38 notes, 33 distinct (the five sale sources share their "Each figure…" note).
  const notes = Object.values(index.sources).flatMap(s => s.notes || []);
  assert.equal(notes.length, 38);
  assert.equal(new Set(notes).size, 33);
  // The one-forms prOne makes.
  assert.equal(oneForm('verified sales'), 'verified sale');
  assert.ok(display.has('owner household') && display.has('sale'));
  // "New York State" (prOnlyHere's home) is a display string.
  assert.ok(display.get('New York State').kinds.includes('juris.area'));
});

// ── periods ─────────────────────────────────────────────────────────────────
test('pr-periods fails on a changed window, a new form, or a label the rebuild does not know', async () => {
  const { b, source, schools } = await real();
  failsGate(run(withIndex(b, d => { d.sources['dc-cama-sales'].window.to = '2026-09'; }), source, schools), 'pr-periods', /dc-cama-sales: period .* rebuild gives "Sales recorded Sep 2025 – Sep 2026"/);
  failsGate(run(withIndex(b, d => { d.sources['ni-ward'].cadence = 'monthly'; }), source, schools), 'pr-periods', /ni-ward: a period form the rebuild does not know/);
  failsGate(run(withIndex(b, d => { d.scales[0].period = '12 months to Mar 2026'; }), source, schools), 'pr-periods', /scale TLC: period/);
  failsGate(run(withIndex(b, d => { d.sources['nyc-dof-sales'].window.span = 'Aug 2024 – Jul 2026 '; }), source, schools), 'pr-periods', /window\.span/);
  // A context label of a new shape (the pure gate; the rows come from the .bin).
  const p = periodProblems(JSON.parse(b.json), [['ni-ward', { label: 'Median sale price, district (X), 2025' }], ['dc-cama-sales', { label: 'Median home value (owners’ estimate), 2020–2024 survey' }]]);
  assert.equal(p.problems.length, 2);
});

// ── each text gate fails on a fixture made to break it ──────────────────────
test('pr-es-words: "promedio", a standalone "media", "precio" in an estimate label, usted; "mediana" and "medio" pass', async () => {
  const { b, source, schools } = await real();
  const note = 'ONS publishes no median for an area with fewer than 5 sales. Areas with fewer than 10 sales show their figure but are not coloured.';
  let s = copy(source); entry(s, note).es = 'La ONS no publica un promedio ni una mediana para las zonas con menos de 5 ventas. Las zonas con menos de 10 ventas muestran su cifra, pero no se colorean.';
  failsGate(run(b, s, schools), 'pr-es-words', /"promedio"/);
  s = copy(source); entry(s, 'London').es = 'Londres (media)';
  failsGate(run(b, s, schools), 'pr-es-words', /standalone word "media"/);
  s = copy(source); entry(s, 'Median home value (owners’ estimate)').es = 'Mediana del precio de la vivienda (estimación de los propietarios)';
  failsGate(run(b, s, schools), 'pr-es-words', /"precio" in an owners'-estimate label/);
  s = copy(source); entry(s, 'owner households').es = 'hogares propietarios de usted';
  failsGate(run(b, s, schools), 'pr-es-words', /formal "usted"/);
  // A sale label may say "precio"; a note may say "no precios de venta".
  assert.deepEqual(priceWordProblems({ strings: { a: { en: 'Median sale price', es: 'Mediana del precio de venta' } } }, new Map([['Median sale price', { kinds: ['source.metric'], estimate: false }]])), []);
  assert.deepEqual(priceWordProblems({ strings: { a: { en: 'x', es: 'por medio de la mediana, en medio' } } }, new Map()), []);
  assert.equal(priceWordProblems({ strings: { a: { en: 'x', es: 'la media' } } }, new Map()).length, 1);
  // "medio" after the figure's nouns says "average" (review 9).
  for (const es of ['el precio medio', 'Valor medio de la vivienda', 'cifras medias']) {
    assert.ok(priceWordProblems({ strings: { a: { en: 'x', es } } }, new Map()).some(m => /after precio, valor or cifra/.test(m)), es);
  }
  assert.deepEqual(priceWordProblems({ strings: { a: { en: 'x', es: 'el valor de la vivienda en medio de la ciudad' } } }, new Map()), []);
  assert.equal(priceWordProblems({ strings: {} }, new Map([['Average home price (owners’ estimate)', { kinds: ['source.metric'], estimate: true }]])).length, 2);
});

test('pr-es-money: a bare $, a converted or dropped amount, a lost CA$ or £', async () => {
  const { b, source, schools } = await real();
  const charlotte = (await real()).index.sources['charlotte-sales'].notes[1];
  let s = copy(source); entry(s, charlotte).es = entry(s, charlotte).es.replace('US$10,000', '$10,000');
  failsGate(run(b, s, schools), 'pr-es-money', /a bare "\$" in Spanish/);
  s = copy(source); entry(s, charlotte).es = entry(s, charlotte).es.replace('US$10,000', 'US$10,500');
  failsGate(run(b, s, schools), 'pr-es-money', /numbers/);
  s = copy(source); entry(s, charlotte).es = entry(s, charlotte).es.replace('US$10,000', 'MX$180,000');
  failsGate(run(b, s, schools), 'pr-es-money', /numbers/);
  // Reordered amounts are fine (a multiset), CA$ and £ are counted.
  assert.deepEqual(moneyProblems({ strings: { a: { en: 'from $1 to $2', es: 'de US$2 a US$1' } } }), []);
  assert.equal(moneyProblems({ strings: { a: { en: 'CA$800,000', es: 'US$800,000' } } }).length, 2);
  assert.equal(moneyProblems({ strings: { a: { en: '£563,500', es: '563,500 libras' } } }).length, 1);
});

test('pr-es-shared, pr-es-licences, pr-es-keys, pr-es-orphans, pr-es-form, pr-es-glossary', async () => {
  const { b, index, source, schools } = await real();
  let s = copy(source); entry(s, 'England').es = 'Inglatera';
  failsGate(run(b, s, schools), 'pr-es-shared', /schools\.es\.src\.json \(SD18\)/);
  assert.deepEqual(sharedProblems({ strings: {} }, schools), []);
  // A licence or a dataset name translated, an attribution line translated.
  s = copy(source); const lic = index.sources['ons-msoa'].licence;
  s.strings[textKey(lic)] = { en: lic, es: 'Licencia de Gobierno Abierto v3.0' };
  failsGate(run(b, s, schools), 'pr-es-licences', /kept string .* has a translation/);
  s = copy(source); const att = index.sources['statcan-ct'].attribution[0];
  s.strings[textKey(att)] = { en: att, es: 'Adaptado de Statistics Canada…' };
  const r = run(b, s, schools);
  assert.match(r.gates.find(g => g.name === 'pr-es-licences').problems.join('\n'), /attribution stays verbatim/);
  assert.match(r.gates.find(g => g.name === 'pr-es-orphans').problems.join('\n'), /orphaned key/);
  // Keys, orphans and form.
  s = copy(source); const [k0] = Object.keys(s.strings); s.strings['0000000000000000'] = s.strings[k0]; delete s.strings[k0];
  failsGate(run(b, s, schools), 'pr-es-keys', /not the hash of its English/);
  s = copy(source); const gone = 'Sales recorded in a county that is not in the pack.'; s.strings[textKey(gone)] = { en: gone, es: 'Ventas.' };
  failsGate(run(b, s, schools), 'pr-es-orphans', /orphaned key/);
  s = copy(source); entry(s, 'London').es = '<i>Londres</i>';
  failsGate(run(b, s, schools), 'pr-es-form', /Spanish has tag/);
  // A doubled full stop (review 3), never an ellipsis.
  s = copy(source); entry(s, 'London').es = 'Londres D. C..';
  failsGate(run(b, s, schools), 'pr-es-form', /doubled full stop in the Spanish/);
  assert.deepEqual(stopProblems({ strings: { a: { en: 'Wait...', es: 'Washington D. C.' } } }), []);
  s = copy(source); entry(s, 'middle layer super output area (MSOA)').es = 'área estadística intermedia';
  failsGate(run(b, s, schools), 'pr-es-glossary', /MSOA \(a name\) is missing/);
  s = copy(source); entry(s, 'census tract').es = 'distrito censal';
  failsGate(run(b, s, schools), 'pr-es-glossary', /"census tract" should be "sector censal"/);
});

test('pr-es-attribution: only a disclaimer line, of its own source in this pack, under the display text\'s rules', async () => {
  const { b, index, display, source, schools } = await real();
  const hen = index.sources['hennepin-sales'].attribution;
  const k = textKey(hen[1]);
  const att = (s, f) => { f(s.attribution[k]); return s; };
  // No section at all: nothing beside any line, and the gate passes.
  let s = copy(source); delete s.attribution;
  let r = run(b, s, schools);
  assert.ok(r.gates.every(g => g.ok));
  assert.deepEqual(JSON.parse(r.text).attribution, {});
  assert.deepEqual(attributionTextProblems({}, index, display), []);
  // A credit line is not a disclaimer: it stays verbatim English (HD12).
  s = copy(source); s.attribution[textKey(hen[0])] = { en: hen[0], es: 'Fuente: el condado de Hennepin.', source: 'hennepin-sales', kind: 'disclaimer' };
  failsGate(run(b, s, schools), 'pr-es-attribution', /is not a disclaimer/);
  // A line the pack does not have (a refreshed or reworded disclaimer), or
  // another source's: an orphan.
  s = copy(source); const old = hen[1].replace('Hennepin County shall', 'The County shall');
  s.attribution[textKey(old)] = { ...s.attribution[k], en: old }; delete s.attribution[k];
  failsGate(run(b, s, schools), 'pr-es-attribution', /orphaned attribution .* is not an attribution line of hennepin-sales/);
  failsGate(run(b, att(copy(source), e => { e.source = 'charlotte-sales'; }), schools), 'pr-es-attribution', /not an attribution line of charlotte-sales/);
  failsGate(run(b, att(copy(source), e => { e.source = 'denver-sales'; }), schools), 'pr-es-attribution', /is not a source of this pack/);
  // Keys and form.
  s = copy(source); s.attribution['0000000000000000'] = s.attribution[k]; delete s.attribution[k];
  failsGate(run(b, s, schools), 'pr-es-attribution', /not the hash of its English/);
  failsGate(run(b, att(copy(source), e => { e.es = ` ${e.es}`; }), schools), 'pr-es-attribution', /es has edge whitespace/);
  failsGate(run(b, att(copy(source), e => { e.es = e.es.replace('TAL CUAL', '<b>TAL CUAL</b>'); }), schools), 'pr-es-attribution', /<b> runs in English/);
  failsGate(run(b, att(copy(source), e => { e.kind = 'credit'; }), schools), 'pr-es-attribution', /kind "credit"/);
  // The display text's words, money and glossary rules.
  failsGate(run(b, att(copy(source), e => { e.es = e.es.replace('Estos datos (i)', 'Usted acepta que estos datos (i)'); }), schools), 'pr-es-attribution', /formal "usted"/);
  failsGate(run(b, att(copy(source), e => { e.es = e.es.replace('sin garantía', 'sin aval'); }), schools), 'pr-es-attribution', /"warranty \(deed\)" should be "\(escritura de\) garantía"/);
  failsGate(run(b, att(copy(source), e => { e.es = e.es.replace(' GIS:', ' SIG:'); }), schools), 'pr-es-attribution', /GIS \(a name\) is missing/);
  failsGate(run(b, att(copy(source), e => { e.es = e.es.replace(' (AS IS)', ''); }), schools), 'pr-es-attribution', /AS \(a name\) is missing/);
  failsGate(run(b, att(copy(source), e => { e.es = e.es.replace('ningún daño', 'ningún daño de más de 1,000 $'); }), schools), 'pr-es-attribution', /numbers/);
  // In `strings` instead, it is display text that no display path shows, and
  // a translated attribution line: the old gates refuse it as before.
  s = copy(source); s.strings[k] = { en: hen[1], es: s.attribution[k].es };
  r = run(b, s, schools);
  assert.match(r.gates.find(g => g.name === 'pr-es-licences').problems.join('\n'), /attribution stays verbatim/);
  assert.match(r.gates.find(g => g.name === 'pr-es-attribution').problems.join('\n'), /also in strings/);
});

// ── missing text ────────────────────────────────────────────────────────────
test('a missing translation is counted, not a failure; --strict-es fails it', async () => {
  const { b, source, schools } = await real();
  const s = copy(source);
  const k = textKey('Nassau and Westchester');
  delete s.strings[k];
  const r = run(b, s, schools);
  assert.ok(r.gates.every(g => g.ok));
  const doc = JSON.parse(r.text);
  assert.equal(doc.stats.missing, 1);
  assert.deepEqual(doc.stats.missingKeys, [k]);
  failsGate(run(b, s, schools, { strictEs: true }), 'pr-es-complete', /missing .*Nassau and Westchester/);
});

// ── the file ────────────────────────────────────────────────────────────────
test('deterministic, and tied to the prices pack it was built with', async () => {
  const { b, source, schools } = await real();
  const x = run(b, source, schools), y = run(b, copy(source), copy(schools));
  assert.equal(x.text, y.text);
  assert.equal(x.report.sha256, sha256(Buffer.from(x.text)));
  assert.equal(x.report.file, 'prices.es.json');
  const doc = JSON.parse(x.text);
  assert.equal(doc.forPack.indexSha256, sha256(Buffer.from(b.json)));
  assert.equal(doc.forPack.binSha256, sha256(b.bin));
  assert.equal(doc.forPack.landingCommit, LANDING.landingCommit);
  assert.deepEqual(Object.keys(doc.strings), doc.display.filter(k => doc.strings[k]));
  const z = run(b, source, schools, { textCommit: 'd'.repeat(40) });
  assert.equal(z.text.replace('d'.repeat(40), 'c'.repeat(40)), x.text);
  // The pack itself does not change with its text.
  const { input, rules } = await realPrices();
  assert.equal(packPrices(input, rules, LANDING).json, b.json);
});
