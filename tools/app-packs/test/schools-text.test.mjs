// node --test tools/app-packs/test/*.test.mjs
// S7: the schools pack's Spanish display text (lib/schools-text.mjs). On the
// real pack and the committed source every gate passes and nothing is
// missing; each gate fails on a fixture made to break it; a missing
// translation is counted (and fails only under --strict-es); the file is
// deterministic and tied to the pack it was built with.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { REPO } from '../lib/landing.mjs';
import { packSchools } from '../lib/schools.mjs';
import { sha256 } from '../lib/container.mjs';
import {
  displayStrings, buildSchoolsText, readTextSource, openTextSource, textKey, licenceNames, linksLicence,
  keyProblems, orphanProblems, formProblems, licenceProblems, wordProblems, glossaryProblems, glossProblems, ratingValueProblems,
  SOURCE_PATH, I18N_DIR, TEXT_SOURCES,
} from '../lib/schools-text.mjs';
import { realSchools, LANDING } from './helpers.mjs';

const TEXT_GATES = ['es-keys', 'es-orphans', 'es-form', 'es-licences', 'es-words', 'es-glossary', 'es-gloss', 'es-rating-values'];

let built;
async function real() {
  if (built) return built;
  const { input, rules } = await realSchools();
  const b = packSchools(input, rules, LANDING);
  const { pack, ...index } = JSON.parse(b.json);
  built = { b, index, display: displayStrings(index), source: readTextSource(REPO) };
  return built;
}
const copy = s => structuredClone(s);
const run = (b, source, o = {}) => buildSchoolsText({ json: b.json, bin: b.bin, rows: b.rows, source, landingCommit: LANDING.landingCommit, textCommit: 'c'.repeat(40), ...o });
// The entry for an English string, in a copy of the source.
const entry = (src, en) => { const e = src.strings[textKey(en)]; assert.ok(e, `no entry for ${en}`); return e; };
const failsGate = (r, name, re) => {
  const g = r.gates.find(x => x.name === name);
  assert.ok(g && !g.ok, `${name} should fail`);
  if (re) assert.match(g.problems.join('\n'), re);
  for (const o of r.gates) if (o.name !== name) assert.ok(o.ok, `only ${name} should fail, ${o.name} did: ${o.problems.slice(0, 2)}`);
};

// ── the real pack ───────────────────────────────────────────────────────────
test('real pack: every Spanish gate passes, nothing is missing, licence names stay English', async () => {
  const { b, display, source } = await real();
  const r = run(b, source, { strictEs: true });
  assert.deepEqual(r.gates.map(g => g.name), [...TEXT_GATES, 'es-complete']);
  for (const g of r.gates) assert.ok(g.ok, `${g.name}: ${g.problems.slice(0, 3).join(' | ')}`);
  const doc = JSON.parse(r.text);
  assert.equal(doc.stats.missing, 0);
  assert.equal(doc.stats.valuesMissing, 0);
  assert.equal(doc.display.length, display.size);
  assert.equal(doc.stats.translated + doc.stats.keep + doc.stats.identity, display.size);
  // Licence names are kept, never translated, and every one is a display string.
  for (const k of doc.keep) assert.ok(!doc.strings[k]);
  assert.ok(doc.keep.length >= 5);
  // Every entry is keyed by its English and is shown by the pack.
  for (const [k, e] of Object.entries(doc.strings)) { assert.equal(textKey(e.en), k); assert.ok(display.has(e.en)); }
  assert.deepEqual(new Set(doc.display), new Set([...display.keys()].map(textKey)));
  // The Mexico City gloss: Spanish values only, for SEP type/phase.
  for (const e of Object.values(doc.values)) { assert.ok(['type', 'phase'].includes(e.field)); assert.ok(e.en.startsWith(`${e.es} (`)); }
});

test('the display paths: every kind the app shows, nothing it does not', async () => {
  const { index, display } = await real();
  const kinds = new Set([...display.values()].flatMap(e => e.kinds));
  for (const k of ['coverage.where', 'coverage.scope', 'source.where', 'source.name', 'source.publisher', 'source.vintage', 'filter.noun', 'filter.where', 'region.outside', 'juris.name', 'juris.area', 'source.attribution', 'source.licence', 'source.recordLabel',
    'label', 'label.template', 'label.meals', 'label.tags', 'note.html', 'note.link', 'scheme.title', 'scheme.short', 'scheme.scale', 'scheme.measures', 'scheme.caveat', 'scheme.miss', 'scheme.publisher', 'scheme.licence']) {
    assert.ok(kinds.has(k), k);
  }
  // Not display text: the filters' own label/any/options, region names, row values.
  for (const f of index.filters) { assert.ok(!display.has(f.any)); for (const o of f.options || []) assert.ok(!display.has(o)); }
  const places = new Set(Object.values(index.juris).flatMap(j => [j.name, j.area]).concat(index.regions.flatMap(r => r.outside || [])));
  const wheres = new Set(Object.values(index.sources).map(s => s.where));
  for (const r of index.regions) if (!places.has(r.name) && !wheres.has(r.name)) assert.ok(!display.has(r.name), r.name);
  // About (O5): the dataset names are kept in English (SD19), with the licences.
  const { b, source } = await real();
  const doc = JSON.parse(run(b, source).text);
  for (const s of Object.values(index.sources)) assert.ok(doc.keep.includes(textKey(s.name)), s.name);
  // A source's attribution is a per-school template ({id}): About never prints it.
  for (const s of Object.values(index.sources)) assert.match(s.attribution, /\{id\}/);
  // Ofsted shows only its publisher.
  assert.ok(display.get('Ofsted').kinds.includes('scheme.publisher'));
});

// ── each gate fails on a fixture made to break it ───────────────────────────
test('es-keys: a key that is not the hash of its English, non-NFC or padded text', async () => {
  const { b, source } = await real();
  let s = copy(source);
  const [k0] = Object.keys(s.strings);
  s.strings['0000000000000000'] = s.strings[k0];
  delete s.strings[k0];
  failsGate(run(b, s), 'es-keys', /not the hash of its English/);
  s = copy(source);
  entry(s, 'Nursery').es = 'Prescolar'.replace('c', 'c') + 'é';          // "é" decomposed
  failsGate(run(b, s), 'es-keys', /es is not NFC/);
  s = copy(source);
  entry(s, 'Nursery').es = 'Preescolar ';
  failsGate(run(b, s), 'es-keys', /edge whitespace/);
});

test('es-orphans: an entry whose English the pack does not show fails the build', async () => {
  const { b, source } = await real();
  const s = copy(source);
  const en = 'Texas publishes an A–F accountability rating for its public schools.';
  s.strings[textKey(en)] = { en, es: 'Texas publica una calificación para sus escuelas públicas.' };
  failsGate(run(b, s), 'es-orphans', /orphaned key/);
});

test('es-form: placeholders, <b> runs, other tags, entities and the arrow', async () => {
  const { b, source } = await real();
  const cases = [
    ['Pupil numbers as at {date}.', 'Número de estudiantes.', /placeholders \{date\} in English, \{\} in Spanish/],
    ['Pupil numbers as at {date}.', 'Número de estudiantes al {fecha}.', /placeholders/],
    ['No ETI inspection report since 2016 is linked to this school.', 'Ningún informe de <i>inspección</i> de la ETI.', /Spanish has tag or raw/],
    ['No ETI inspection report since 2016 is linked to this school.', 'Ningún informe < de inspección de la ETI.', /raw "<"/],
    ['No ETI inspection report since 2016 is linked to this school.', 'Ningún informe &amp; inspección de la ETI.', /HTML entity/],
  ];
  for (const [en, es, re] of cases) { const s = copy(source); entry(s, en).es = es; failsGate(run(b, s), 'es-form', re); }
  const s = copy(source);
  const ont = [...(await real()).display.keys()].find(x => x.startsWith('<b>Ontario publishes'));
  entry(s, ont).es = entry(s, ont).es.replace('<b>', '').replace('</b>', '');
  failsGate(run(b, s), 'es-form', /1 <b> runs in English, 0 in Spanish/);
  const s2 = copy(source);
  entry(s2, 'Source: Texas Education Agency (TXschools.gov) ↗').es = 'Fuente: Agencia de Educación de Texas (TXschools.gov)';
  failsGate(run(b, s2), 'es-form', /trailing " ↗"/);
  const s3 = copy(source);
  entry(s3, 'No ETI inspection report since 2016 is linked to this school.').es = '<b>Ningún informe de inspección de la ETI</b>.';
  failsGate(run(b, s3), 'es-form', /0 <b> runs in English, 1 in Spanish/);
});

test('es-licences: a translated licence name, a licence name dropped, an attribution that would lose its link', async () => {
  const { b, index, source } = await real();
  {
    const s = copy(source);
    const name = index.sources.gias.name;
    s.strings[textKey(name)] = { en: name, es: 'Obtener información sobre las escuelas (DfE)' };
    assert.match(run(b, s).gates.find(g => g.name === 'es-licences').problems.join('\n'), /dataset name .* is translated \(it stays English, SD19\)/);
  }
  let s = copy(source);
  const lic = index.sources.gias.licence;
  s.strings[textKey(lic)] = { en: lic, es: 'Licencia de Gobierno Abierto v3.0' };
  let r = run(b, s);
  assert.match(r.gates.find(g => g.name === 'es-licences').problems.join('\n'), /is translated/);
  s = copy(source);
  const att = index.sources.gias.attribution;
  entry(s, att).es = entry(s, att).es.replace('Open Government Licence v3.0', 'Licencia de Gobierno Abierto v3.0');
  r = run(b, s);
  assert.match(r.gates.find(g => g.name === 'es-licences').problems.join('\n'), /source gias: the Spanish attribution no longer names its licence/);
  s = copy(source);
  const wa = index.schemes['us-wa-wsif'].caveat;
  entry(s, wa).es = entry(s, wa).es.replace('CC BY 4.0', 'CC BY');
  failsGate(run(b, s), 'es-licences', /licence name "CC BY 4.0" is in the English but not the Spanish/);
  // The page's linkLicence: the name, or the short form in its last brackets.
  assert.ok(linksLicence('… (datos.gob.mx, CC BY 4.0); adaptado por SafeRoute.', 'Creative Commons Attribution 4.0 International (CC BY 4.0)'));
  assert.ok(!linksLicence('ID de NCES 1 · NCES.', 'Public domain (U.S. federal government work)'));
  assert.ok(licenceNames(index).includes('CC BY 4.0'));
});

test('es-words: religion words in a label, "anónimo", formal usted', async () => {
  const { b, source } = await real();
  const cases = [
    ['Management type', 'Tipo de gestión religiosa', /forbidden word in a label/],
    ['Management type', 'Denominación', /forbidden word in a label/],
    ['Trust', 'Diócesis', /forbidden word in a label/],
    ['No official rating is published for this private school.', 'No se publica ninguna calificación oficial para esta escuela privada anónima.', /anónimo/],
    ['No official rating is published for this private school.', 'Usted no verá ninguna calificación oficial para esta escuela privada.', /formal "usted"/],
  ];
  for (const [en, es, re] of cases) { const s = copy(source); entry(s, en).es = es; failsGate(run(b, s), 'es-words', re); }
});

test('es-glossary: a term rendered otherwise, a name in capitals dropped', async () => {
  const { b, source } = await real();
  const cases = [
    ['Boarding', 'Residencia', /"boarding \(school\)" should be "internado"/],
    ['Charter school', 'Escuela concertada', /should be "chárter"/],
    ['Gender', 'Género', /should be "alumnado"/],
    ['No official rating is published for this private school.', 'No se publica ninguna nota oficial para esta escuela privada.', /"rating" should be "calificación"/],
    ['No ETI inspection report since 2016 is linked to this school.', 'Ningún informe de inspección desde 2016 está vinculado a esta escuela.', /ETI \(a name\) is missing/],
  ];
  for (const [en, es, re] of cases) { const s = copy(source); entry(s, en).es = es; failsGate(run(b, s), 'es-glossary', re); }
});

test('es-gloss: only SEP type/phase values, exactly the value without its one trailing gloss, never a value elsewhere', async () => {
  const { b, source } = await real();
  const [k0, v0] = Object.entries(source.values)[0];
  let s = copy(source);
  s.values[k0].es = v0.en;
  failsGate(run(b, s), 'es-gloss', /is not the value without its gloss/);
  s = copy(source);
  s.values[k0].field = 'la';
  failsGate(run(b, s), 'es-gloss', /the gloss is dropped from SEP type and phase only/);
  s = copy(source);
  const bach = 'Dirección General del Colegio de Bachilleres (Área Central)';
  s.values[textKey(bach)] = { en: bach, es: 'Dirección General del Colegio de Bachilleres', field: 'type' };
  failsGate(run(b, s), 'es-gloss', /is not a SEP type value in this pack|also a value outside/);
  // A value a non-SEP row also carries.
  const rows = b.rows.map(r => ({ ...r }));
  rows.find(r => r.src === 'gias').type = v0.en;
  const r = buildSchoolsText({ json: b.json, bin: b.bin, rows, source, landingCommit: 'x', textCommit: 'y' });
  failsGate(r, 'es-gloss', /also a value outside SEP's type\/phase/);
  // Uncovered SEP values are counted (and fail only under --strict-es).
  s = copy(source);
  delete s.values[k0];
  const r2 = run(b, s);
  assert.ok(r2.gates.every(g => g.ok));
  assert.equal(JSON.parse(r2.text).stats.valuesMissing, 1);
  failsGate(run(b, s, { strictEs: true }), 'es-complete', /gloss not covered/);
});

test('es-rating-values: a rating value as display text, or as a source entry, fails', async () => {
  const { b, source } = await real();
  const s = copy(source);
  s.strings[textKey('Category 3')] = { en: 'Category 3', es: 'Categoría 3' };
  const r = run(b, s);
  assert.match(r.gates.find(g => g.name === 'es-rating-values').problems.join('\n'), /"Category 3" is a rating value/);
  assert.equal(ratingValueProblems({ strings: {} }, new Map([['Tier 3 comprehensive support (low graduation rate)', {}]]), b.rows).length, 1);
});

// ── missing text ────────────────────────────────────────────────────────────
test('a missing translation is counted and listed, not a failure; --strict-es fails it', async () => {
  const { b, source } = await real();
  const s = copy(source);
  const k = textKey('Free school meals');
  delete s.strings[k];
  const r = run(b, s);
  assert.ok(r.gates.every(g => g.ok));
  const doc = JSON.parse(r.text);
  assert.equal(doc.stats.missing, 1);
  assert.deepEqual(doc.stats.missingKeys, [k]);
  assert.ok(!doc.strings[k] && doc.display.includes(k));
  failsGate(run(b, s, { strictEs: true }), 'es-complete', /missing .*Free school meals/);
});

// ── the file ────────────────────────────────────────────────────────────────
test('deterministic, and tied to the pack it was built with', async () => {
  const { b, source } = await real();
  const x = run(b, source), y = run(b, copy(source));
  assert.equal(x.text, y.text);
  assert.equal(x.report.sha256, sha256(Buffer.from(x.text)));
  const doc = JSON.parse(x.text);
  assert.equal(doc.forPack.indexSha256, sha256(Buffer.from(b.json)));
  assert.equal(doc.forPack.binSha256, sha256(b.bin));
  assert.equal(doc.forPack.landingCommit, LANDING.landingCommit);
  assert.equal(doc.textCommit, 'c'.repeat(40));
  assert.equal(doc.hash, 'sha256(utf8(en)) hex, first 16');
  // Only the source changes the strings; the order is the display order.
  assert.deepEqual(Object.keys(doc.strings), doc.display.filter(k => doc.strings[k]));
  const z = run(b, source, { textCommit: 'd'.repeat(40) });
  assert.equal(z.text.replace('d'.repeat(40), 'c'.repeat(40)), x.text);
});

test('the pure gates on hand-made fixtures', () => {
  const display = new Map([['A {x} <b>b</b> ↗', { kinds: ['note.html'] }], ['Licence X (LX)', { kinds: ['source.licence'] }]]);
  const en = 'A {x} <b>b</b> ↗';
  const src = es => ({ strings: { [textKey(en)]: { en, es } } });
  assert.deepEqual(formProblems(src('Á {x} <b>b</b> ↗')), []);
  assert.equal(formProblems(src('Á <b>b ↗')).length, 3);                   // placeholder, unclosed, runs
  assert.deepEqual(orphanProblems(src('x'), display), []);
  assert.equal(orphanProblems({ strings: { ab: { en: 'gone', es: 'ido' } } }, display).length, 1);
  assert.equal(keyProblems({ strings: { ab: { en: 'gone', es: 'ido' } } }, display).length, 1);
  assert.deepEqual(wordProblems(src('tú'), display), []);
  assert.equal(glossaryProblems({ strings: { k: { en: 'NCES ID', es: 'ID' } }, glossary: { terms: [] } }).length, 1);
  assert.deepEqual(glossaryProblems({ strings: { k: { en: 'US schools', es: 'escuelas de EE. UU.' } }, glossary: { terms: [], acronymExceptions: ['US'] } }), []);
  // An acronym may be spelled out, but only as its glossary expansion says.
  const bc = { acronymExpansions: { BC: { es: 'Columbia Británica' } } };
  assert.deepEqual(glossaryProblems({ strings: { k: { en: 'BC schools', es: 'escuelas de Columbia Británica' } }, glossary: { terms: [], ...bc } }), []);
  assert.equal(glossaryProblems({ strings: { k: { en: 'BC schools', es: 'escuelas de la provincia' } }, glossary: { terms: [], ...bc } }).length, 1);
  const index = { sources: { s: { licence: 'Licence X (LX)', attribution: 'From X, LX.' } } };
  const s2 = { strings: { [textKey('From X, LX.')]: { en: 'From X, LX.', es: 'De X.' } } };
  assert.equal(licenceProblems(s2, new Map([['From X, LX.', { kinds: ['source.attribution'] }]]), index).length, 2);
  const g = glossProblems({ values: {} }, [{ src: 'sep', type: 'Público (public)' }, { src: 'gias', type: 'Academy' }]);
  assert.deepEqual(g, { problems: [], uncovered: ['Público (public)'] });
});

// ── the source is read from HEAD ────────────────────────────────────────────
test('openTextSource: HEAD\'s committed file and its last commit; a dirty i18n/ needs --allow-dirty (recorded +dirty), never with --commit', () => {
  const r = realpathSync(mkdtempSync(join(tmpdir(), 'packs-i18n-')));
  const g = (...a) => execFileSync('git', ['-C', r, ...a], { encoding: 'utf8' }).trim();
  try {
    g('init', '-q'); g('config', 'user.email', 't@example.org'); g('config', 'user.name', 't'); g('config', 'commit.gpgsign', 'false');
    assert.throws(() => openTextSource({ repo: r }), /not committed at HEAD/);
    const put = s => { mkdirSync(join(r, I18N_DIR), { recursive: true }); writeFileSync(join(r, SOURCE_PATH), JSON.stringify(s)); };
    put({ strings: { a: 1 } });
    g('add', '-A'); g('commit', '-q', '-m', 'text');
    const c = g('rev-parse', 'HEAD');
    writeFileSync(join(r, 'other.txt'), 'x'); g('add', '-A'); g('commit', '-q', '-m', 'other');
    assert.deepEqual(openTextSource({ repo: r }), { source: { strings: { a: 1 } }, textCommit: c });
    put({ strings: { a: 2 } });
    assert.throws(() => openTextSource({ repo: r }), /differs from HEAD/);
    assert.throws(() => openTextSource({ repo: r, allowDirty: true, commit: 'HEAD' }), /differs from HEAD/);
    assert.deepEqual(openTextSource({ repo: r, allowDirty: true }), { source: { strings: { a: 2 } }, textCommit: `${c}+dirty` });
  } finally { rmSync(r, { recursive: true, force: true }); }
});

// L1 (H5): each text is stamped by its own source file. A commit that touches
// only the home values' prices.es.src.json leaves the schools text's
// textCommit (and so schools.es.json) as it was; a dirty prices source is
// refused for the prices text and does not touch the schools one.
test('openTextSource: one file each; a prices-only commit or edit leaves the schools text alone', () => {
  assert.deepEqual(TEXT_SOURCES, { 'schools.es.json': SOURCE_PATH, 'prices.es.json': `${I18N_DIR}/prices.es.src.json` });
  const r = realpathSync(mkdtempSync(join(tmpdir(), 'packs-i18n-two-')));
  const g = (...a) => execFileSync('git', ['-C', r, ...a], { encoding: 'utf8' }).trim();
  const put = (path, s) => { mkdirSync(join(r, I18N_DIR), { recursive: true }); writeFileSync(join(r, path), JSON.stringify(s)); };
  const prices = TEXT_SOURCES['prices.es.json'];
  try {
    g('init', '-q'); g('config', 'user.email', 't@example.org'); g('config', 'user.name', 't'); g('config', 'commit.gpgsign', 'false');
    put(SOURCE_PATH, { strings: { a: 1 } });
    g('add', '-A'); g('commit', '-q', '-m', 'schools text');
    const c1 = g('rev-parse', 'HEAD');
    // The prices source does not exist yet: refused for prices, schools fine.
    assert.throws(() => openTextSource({ repo: r, path: prices }), /not committed at HEAD/);
    put(prices, { strings: { p: 1 } });
    // Untracked = dirty: the prices text is refused, the schools text is not.
    assert.throws(() => openTextSource({ repo: r, path: prices }), /prices\.es\.src\.json differs from HEAD/);
    assert.throws(() => openTextSource({ repo: r, path: prices, allowDirty: true, commit: 'HEAD' }), /differs from HEAD/);
    assert.deepEqual(openTextSource({ repo: r }), { source: { strings: { a: 1 } }, textCommit: c1 });
    g('add', '-A'); g('commit', '-q', '-m', 'prices text');
    const c2 = g('rev-parse', 'HEAD');
    assert.deepEqual(openTextSource({ repo: r }), { source: { strings: { a: 1 } }, textCommit: c1 });
    assert.deepEqual(openTextSource({ repo: r, path: prices }), { source: { strings: { p: 1 } }, textCommit: c2 });
    // An edit to the schools source dirties only the schools text.
    put(SOURCE_PATH, { strings: { a: 2 } });
    assert.throws(() => openTextSource({ repo: r }), /schools\.es\.src\.json differs from HEAD/);
    assert.deepEqual(openTextSource({ repo: r, path: prices }), { source: { strings: { p: 1 } }, textCommit: c2 });
  } finally { rmSync(r, { recursive: true, force: true }); }
});
