// node --test tools/app-packs/test/*.test.mjs
// Every O1 gate (RELEASE-1.4-SCOPE.md §4.4) fails on a fixture made to break
// it: the real published inputs with one thing changed, built through the
// real pack builder, plus the gate functions on hand-made fixtures. And on the
// real data every gate passes. Expected counts are computed from the input,
// never pinned, so the monthly data refreshes do not break these tests.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { realSchools, realPrices, copyInput, editTile, fieldIndex, LANDING } from './helpers.mjs';
import { packSchools, makeTransform, reproductionProblems as schoolsRepro } from '../lib/schools.mjs';
import { packPrices, reproductionProblems as pricesRepro, sourceOrderProblems } from '../lib/prices.mjs';
import { assemble, packJson, openPack, sha256 } from '../lib/container.mjs';
import { combineLicences } from '../lib/landing.mjs';
import {
  GateError, forbiddenFieldProblems, fieldListProblems, labelProblems, filterProblems, licenceUrlProblems, sourceIdProblems,
  noteHtmlProblems, ratingLicenceProblems, ratingSchemeProblems,
} from '../lib/gates.mjs';
import * as licence from '../../schools/licence.mjs';
import { FILTERS } from '../../schools/filters.mjs';
import { FIELDS as SCHOOL_FIELDS } from '../../schools/lib/schema.mjs';

const { LICENSED_RATINGS } = licence;
const HERE = dirname(fileURLToPath(import.meta.url));
const SCHOOL_GATES = ['forbidden-fields', 'filter-ids', 'licence-urls', 'source-ids', 'note-html', 'rating-licence', 'rating-schemes', 'totals', 'reproduction'];
const PRICE_GATES = ['forbidden-fields', 'filter-ids', 'licence-urls', 'source-ids', 'note-html', 'totals', 'reproduction'];

// Build must throw a GateError in which `name` failed. Returns the error.
function fails(build, name, msg) {
  let err;
  assert.throws(build, e => { err = e; return e instanceof GateError; }, `expected a GateError for ${name}`);
  assert.ok(err.failed.includes(name), `${name} should fail, failed: ${err.failed.join(', ')}`);
  if (msg) assert.match(err.gates.find(g => g.name === name).problems.join('\n'), msg);
  return err;
}
const schools = async mutate => { const { input, rules } = await realSchools(); const i = copyInput(input); const r = { ...rules }; await mutate(i, r); return () => packSchools(i, r, LANDING); };
const prices = async mutate => { const { input, rules } = await realPrices(); const i = copyInput(input); const r = { ...rules }; await mutate(i, r); return () => packPrices(i, r, LANDING); };

// The first leaf holding a row that matches, and that row's index there.
function findRow(input, pred) {
  const F = fieldIndex(input.index);
  for (let li = 0; li < input.tiles.length; li++) {
    const ri = JSON.parse(input.tiles[li][1]).findIndex(r => pred(r, F));
    if (ri >= 0) return { li, ri, F };
  }
  throw new Error('no such row in the input');
}
// Edit that row in a copy of the input.
const editRow = (i, pred, fn) => { const { li, ri, F } = findRow(i, pred); editTile(i, li, rows => fn(rows[ri], F)); return li; };
const isTx = (r, F) => r[F.juris] === 'US-TX' && r[F.src] === 'ccd';

// ── the real data passes every gate ─────────────────────────────────────────
test('real data: every schools gate runs and passes', async () => {
  const { input, rules } = await realSchools();
  const b = packSchools(input, rules, LANDING);
  assert.deepEqual(b.gates.map(g => g.name), SCHOOL_GATES);
  assert.ok(b.gates.every(g => g.ok), b.gates.filter(g => !g.ok).map(g => `${g.name}: ${g.problems.slice(0, 3)}`).join('\n'));
});
test('real data: every home-values gate runs and passes', async () => {
  const { input, rules } = await realPrices();
  const b = packPrices(input, rules, LANDING);
  assert.deepEqual(b.gates.map(g => g.name), PRICE_GATES);
  assert.ok(b.gates.every(g => g.ok));
});

// ── 1. forbidden fields ─────────────────────────────────────────────────────
test('forbidden-fields: the gate functions, on each forbidden stem', () => {
  for (const k of ['religion', 'Denomination', 'faithGroup', 'diocese', 'typology', 'religiousCharacter', 'orientation', 'sexualOrientation']) {
    assert.equal(forbiddenFieldProblems({ fields: ['src', k] }).length, 1, k);
    assert.equal(forbiddenFieldProblems({ fields: [], sources: { x: { labels: { [k]: 'x' } } } }).length, 1, k);
    assert.equal(labelProblems({ sources: { x: { labels: { trust: k } } } }).length, 1, k);
    assert.equal(labelProblems({ filters: [{ id: 'gender', label: k }] }).length, 1, k);
  }
  assert.deepEqual(forbiddenFieldProblems({ fields: ['src', 'trust', 'gender'], sources: { x: { labels: { trust: 'Management type' } } } }), []);
  assert.deepEqual(fieldListProblems([...SCHOOL_FIELDS], SCHOOL_FIELDS), []);
  assert.match(fieldListProblems(SCHOOL_FIELDS.map(f => (f === 'admissions' ? 'ethos' : f)), SCHOOL_FIELDS).join(), /\+ethos -admissions/);
});
test('forbidden-fields: schools, a row field named for religion', async () => {
  fails(await schools(i => { i.index.fields[i.index.fields.indexOf('admissions')] = 'faithAdmissions'; }), 'forbidden-fields', /faithAdmissions/);
});
test('forbidden-fields: schools, a religion field under another name (not the schema\'s fields)', async () => {
  fails(await schools(i => {
    const F = fieldIndex(i.index), k = F.admissions;
    i.index.fields[k] = 'ethos';
    i.tiles = i.tiles.map(([key, t]) => [key, JSON.stringify(JSON.parse(t).map(r => { if (r[F.src] === 'gias') r[k] = 'Roman Catholic'; return r; }))]);
  }), 'forbidden-fields', /ethos/);
});
test('forbidden-fields: schools, a label naming religion', async () => {
  fails(await schools(i => { i.index.sources.de.labels.trust = 'Religious denomination'; }), 'forbidden-fields', /sources\.de\.labels\.trust/);
  fails(await schools(i => { i.index.sources.gias.labels.type = 'Faith'; }), 'forbidden-fields', /sources\.gias\.labels\.type/);
});
test('forbidden-fields: schools, a key deep in the index', async () => {
  fails(await schools(i => { i.index.sources.de.labels.religion = 'Religion'; }), 'forbidden-fields', /religion/);
  fails(await schools(i => { i.index.regions[0].orientation = 'north'; }), 'forbidden-fields', /orientation/);
});
test('forbidden-fields: home values, a source key, a context key and the row fields', async () => {
  fails(await prices(i => { i.index.sources['acs-tract'].denomination = 'x'; }), 'forbidden-fields', /denomination/);
  const ti = (await realPrices()).input.tiles.findIndex(([, t]) => JSON.parse(t).c.length);
  fails(await prices(i => editTile(i, ti, t => { t.c[0].dioceseShare = 1; })), 'forbidden-fields', /dioceseShare/);
  fails(await prices(i => editTile(i, ti, t => { t.c[0].note = 'x'; })), 'forbidden-fields', /context key "note"/);
  fails(await prices(i => { i.index.fields = i.index.fields.map(f => (f === 'name' ? 'label' : f)); }), 'forbidden-fields', /\+label -name/);
});

// ── 2. filter ids ───────────────────────────────────────────────────────────
const filterIndex = () => structuredClone({
  sources: { gias: { publishes: ['gender', 'boarding'] }, pss: { publishes: ['gender'] }, sep: { publishes: ['boarding'] }, ccd: { publishes: ['charter'] } },
  filters: [
    { id: 'gender', type: 'select', label: 'Gender', noun: 'gender', publishedBy: ['gias', 'pss'], where: 'x', field: 'gender', any: 'Any gender', options: ['Boys', 'Girls', 'Mixed'] },
    { id: 'boarding', type: 'check', label: 'Boarding', noun: 'boarding', publishedBy: ['gias', 'sep'], where: 'x', field: 'boarding' },
    { id: 'charter', type: 'check', label: 'Charter', noun: 'charter status', publishedBy: ['ccd'], where: 'x', tag: 'charter' },
  ],
  options: { gender: ['Boys', 'Girls', 'Mixed'] },
});
test('filter-ids: the gate function', () => {
  assert.deepEqual(filterProblems(filterIndex(), FILTERS), []);
  assert.equal(filterProblems({ filters: [{ id: 'sector' }] }).length, 1);
  assert.equal(filterProblems({ filters: [], options: { management: [] } }).length, 1);
  const bent = [
    ix => { ix.filters[0].field = 'trust'; },                                   // gender over the NI management type
    ix => { ix.filters[0].options = ['Roman Catholic Maintained', 'Controlled']; },
    ix => { ix.options.gender = ['Roman Catholic Maintained']; },
    ix => { ix.options.gender.push('Not applicable'); },                         // filters.mjs excludes it
    ix => { ix.filters[2].tag = 'catholic'; },
    ix => { ix.filters[2].label = 'Catholic'; },
    ix => { ix.filters[1].type = 'select'; },
    ix => { ix.filters[1].tag = 'catholic'; },                                  // a key filters.mjs does not define for it
    ix => { ix.sources.gias.publishes.push('religion'); },
    ix => { ix.filters[2].publishedBy = ['ccd', 'pss']; },                       // pss does not publish charter
  ];
  for (const [n, edit] of bent.entries()) { const ix = filterIndex(); edit(ix); assert.ok(filterProblems(ix, FILTERS).length >= 1, `case ${n}`); }
});
test('filter-ids: schools, a filter outside gender/boarding/charter', async () => {
  fails(await schools(i => { i.index.filters.push({ id: 'management', type: 'select', field: 'trust', label: 'Management', publishedBy: ['de'], where: 'Northern Ireland' }); }), 'filter-ids', /management/);
  fails(await schools(i => { i.index.options.rating = ['A', 'B']; }), 'filter-ids', /rating/);
});
test('filter-ids: schools, a religion filter under an allowed id', async () => {
  fails(await schools(i => {
    const f = i.index.filters.find(f => f.id === 'gender');
    f.field = 'trust'; f.label = 'Church'; f.options = ['Roman Catholic Maintained', 'Controlled'];
    i.index.options.gender = ['Roman Catholic Maintained', 'Controlled'];
  }), 'filter-ids', /gender\.field/);
  fails(await schools(i => { i.index.filters.find(f => f.id === 'charter').tag = 'catholic'; }), 'filter-ids', /charter\.tag/);
  fails(await schools(i => { i.index.sources.gias.publishes.push('religion'); }), 'filter-ids', /gias\.publishes "religion"/);
  fails(await schools(i => { i.index.sources.de.publishes.push('gender'); }), 'filter-ids', /publishedBy/);
});
test('filter-ids: home values, any filter at all outside the list', async () => {
  fails(await prices(i => { i.index.filters = [{ id: 'religion' }]; }), 'filter-ids', /religion/);
});

// ── 3. licence urls ─────────────────────────────────────────────────────────
test('licence-urls: the gate function', () => {
  assert.deepEqual(licenceUrlProblems({ sources: { a: { licenceUrl: 'https://example.org/l' } } }), []);
  for (const u of ['http://example.org/l', '', null, undefined, 'https://', 'ftp://example.org', 'https:// spaced.org']) {
    assert.equal(licenceUrlProblems({ sources: { a: { licenceUrl: u } } }).length, 1, String(u));
  }
  const sc = { publisher: 'p', attribution: 'a', licence: 'l', licenceUrl: 'https://example.org/l' };
  assert.deepEqual(licenceUrlProblems({ schemes: { s: sc } }, ['s']), []);
  assert.equal(licenceUrlProblems({ schemes: {} }, ['s']).length, 1);
  for (const k of Object.keys(sc)) { const x = { ...sc }; delete x[k]; assert.equal(licenceUrlProblems({ schemes: { s: x } }, ['s']).length, 1, k); }
});
test('licence-urls: schools, an http licence and a missing one', async () => {
  fails(await schools(i => { i.index.sources.gias.licenceUrl = i.index.sources.gias.licenceUrl.replace('https:', 'http:'); }), 'licence-urls', /gias/);
  fails(await schools(i => { delete i.index.sources.sep.licenceUrl; }), 'licence-urls', /sep/);
});
test('licence-urls: schools, a licensed state scheme with values must link its licence', async () => {
  // Published without a link and none in its ratings module either.
  fails(await schools((i, r) => { delete i.index.schemes['us-wa-wsif'].licenceUrl; r.licensedRecords = {}; }), 'licence-urls', /us-wa-wsif: licenceUrl null/);
  // Published with a link its ratings module contradicts.
  fails(await schools(i => { i.index.schemes['us-wa-wsif'].licenceUrl = 'https://example.org/other'; }), 'licence-urls', /us-wa-wsif: published licenceUrl/);
  // No attribution.
  fails(await schools(i => { delete i.index.schemes['us-wa-wsif'].attribution; }), 'licence-urls', /us-wa-wsif: no attribution/);
  // Its definition missing altogether: the values ship with nothing to credit.
  const e = fails(await schools(i => { delete i.index.schemes['us-wa-wsif']; }), 'licence-urls', /us-wa-wsif: its values are in the pack/);
  assert.ok(e.failed.includes('rating-schemes'));
});
test('licence-urls: schools, a licensed scheme published without a link gets its ratings module\'s', async () => {
  const { input, rules } = await realSchools();
  const i = copyInput(input);
  delete i.index.schemes['us-wa-wsif'].licenceUrl;
  const b = packSchools(i, rules, LANDING);
  const { index, pack } = openPack(b.json, b.bin);
  assert.equal(index.schemes['us-wa-wsif'].licenceUrl, rules.licensedRecords['us-wa-wsif'].licenceUrl);
  assert.ok(pack.ratingLicence.licenceUrlAdded.includes('us-wa-wsif'));
});
test('licence-urls: home values, a source and a further licence', async () => {
  fails(await prices(i => { i.index.sources['ni-ward'].licenceUrl = 'http://www.nationalarchives.gov.uk/doc/open-government-licence/version/3/'; }), 'licence-urls', /ni-ward/);
  fails(await prices(i => { i.index.sources['statcan-ct'].licences[0].licenceUrl = 'open.canada.ca/en/open-government-licence-canada'; }), 'licence-urls', /statcan-ct: licences\[0\]/);
});

// ── 4. source ids ───────────────────────────────────────────────────────────
test('source-ids: the gate function', () => {
  assert.deepEqual(sourceIdProblems({ sources: { a: {} } }, ['a', 'b'], [['row', 'b']]), []);
  assert.equal(sourceIdProblems({ sources: { a: {}, z: {} } }, ['a']).length, 1);
  assert.equal(sourceIdProblems({ sources: { a: {} } }, ['a'], [['row', 'q'], ['row', 'q']]).length, 1);
});
test('source-ids: the parked denver-sales can never enter the home-values pack', async () => {
  fails(await prices(i => {
    i.index.sources['denver-sales'] = structuredClone(i.index.sources['hennepin-sales']);
    i.index.regions.find(r => r.id === 'denver').sources.push('denver-sales');
  }), 'source-ids', /denver-sales/);
  // A scale or geometry naming it is caught too.
  fails(await prices(i => { i.index.scales[0].source = 'denver-sales'; }), 'source-ids', /scale .*denver-sales/);
});
test('source-ids: only modules the build loads; the denver region itself is fine', async () => {
  const { rules } = await realPrices();
  assert.ok(!rules.sourceIds.includes('denver-sales'), 'tools/prices/parked is not loaded');
  // A source whose module is gone (not loaded) fails.
  fails(await prices((i, r) => { r.sourceIds = r.sourceIds.filter(id => id !== 'ct-opm-sales'); }), 'source-ids', /ct-opm-sales/);
  fails(await schools((i, r) => { r.sourceIds = r.sourceIds.filter(id => id !== 'pss'); }), 'source-ids', /pss/);
});
test('source-ids: home values spell out the source order (pack.sourceIds) and every row indexes it', async () => {
  const { input, rules } = await realPrices();
  const b = packPrices(input, rules, LANDING);
  const doc = JSON.parse(b.json);
  assert.deepEqual(doc.pack.sourceIds, Object.keys(input.index.sources));
  assert.deepEqual(sourceOrderProblems(b.json, b.bin), []);
  const swapped = structuredClone(doc); [swapped.pack.sourceIds[0], swapped.pack.sourceIds[1]] = [swapped.pack.sourceIds[1], swapped.pack.sourceIds[0]];
  assert.match(sourceOrderProblems(JSON.stringify(swapped), b.bin).join(), /not the index's source order/);
  const short = structuredClone(doc); short.pack.sourceIds = doc.pack.sourceIds.slice(0, 1);
  assert.match(sourceOrderProblems(JSON.stringify(short), b.bin).join(), /src is not an index/);
});

// ── 5. note html ────────────────────────────────────────────────────────────
test('note-html: the gate function allows <b> only, in the index and in extra values', () => {
  assert.deepEqual(noteHtmlProblems({ schemes: { a: { notes: [{ html: '<b>Bold</b> and n < 3, 4 > 2' }] } } }), []);
  for (const h of ['<i>x</i>', '<a href="https://x.org">x</a>', '<script>alert(1)</script>', '<span class="caveat">x</span>', '<br>', '<b class="x">x</b>', '<img src=x onerror=alert(1)>', '<!-- x -->']) {
    assert.ok(noteHtmlProblems({ schemes: { a: { notes: [{ html: h }] } } }).length >= 1, h);
    assert.ok(noteHtmlProblems({}, [[[['gias', '1', `St ${h}`]], 'chunk 0']]).length >= 1, `row: ${h}`);
  }
});
test('note-html: schools, a link outside the caveat pattern, and an http source link', async () => {
  fails(await schools(i => { i.index.schemes['mx-none'].notes[0].html += ' <a href="https://www.planea.sep.gob.mx/">PLANEA</a>'; }), 'note-html', /mx-none/);
  fails(await schools(i => { const n = i.index.schemes['us-pending'].notes[0]; n.html = n.html.replace('href="https://', 'href="http://'); }), 'note-html', /us-pending/);
  fails(await schools(i => { i.index.schemes['not-ofsted'].notes[0].html += '<script>x</script>'; }), 'note-html', /script/);
});
test('note-html: schools, a tag inside a row (in the .bin)', async () => {
  fails(await schools(i => { editTile(i, 0, rows => { rows[0][fieldIndex(i.index).name] += ' <a href="https://example.com">see</a>'; }); }), 'note-html', /chunk 0 .*<a href/);
});
test('note-html: home values, a tag in a source note and in a context label (in the .bin)', async () => {
  fails(await prices(i => { i.index.sources['acs-tract'].notes.push('See <a href="https://www.census.gov">the Census</a>.'); }), 'note-html', /acs-tract/);
  const ti = (await realPrices()).input.tiles.findIndex(([, t]) => JSON.parse(t).c.length);
  fails(await prices(i => editTile(i, ti, t => { t.c[0].label += '<img src="https://example.com/p.png">'; })), 'note-html', /chunk .*<img/);
});

// ── 8. the rating licence (schools) ─────────────────────────────────────────
const LIC = combineLicences(licence, licence);
const R = { ...LIC, ratingSchemes: ['us-ct-ngas', 'us-wa-wsif', 'us-tx-af', 'us-az-af'], ownSchemes: { ccd: ['us-pending', 'us-none-mo'], de: ['ni-eti'], pss: ['us-private'] } };
test('rating-licence: the gate function', () => {
  const ok = [
    { juris: 'US-CT', ratingScheme: 'us-ct-ngas', rv: 'Category 1' },     // licensed, its own state
    { juris: 'GB-NIR', ratingScheme: 'ni-eti', rv: 'Good', rd: '2024' },  // not a state scheme
    { juris: 'US-NY', ratingScheme: 'us-pending', rv: '', rd: '' },
  ];
  assert.deepEqual(ratingLicenceProblems(ok, R), []);
  const bad = [
    { juris: 'US-TX', ratingScheme: 'us-tx-af', rv: 'B' },                // unlicensed state scheme, a value
    { juris: 'US-AZ', ratingScheme: 'us-az-af', rv: '' },                 // stranded on it
    { juris: 'US-NY', ratingScheme: 'us-pending', rv: 'x' },              // a value under a non-licensed scheme
    { juris: 'US-TX', ratingScheme: 'us-ct-ngas', rv: 'Category 1' },     // licensed for CT only
    { juris: 'US-TX', ratingScheme: 'us-ct-ngas', rv: '' },
    { juris: 'GB-ENG', ratingScheme: 'us-tx-af', rv: 'A' },               // not a US row: the scheme decides
    { juris: 'US-TX', ratingScheme: 'us-pending', rv: '', rd: '2026' },   // E&W rating fields off a licensed scheme
    { juris: 'US-TX', ratingScheme: 'us-pending', rv: '', oeifGrade: 'Outstanding' },
    { juris: 'US-TX', ratingScheme: 'us-pending', rv: '', rcInclusion: 'Secure' },
  ];
  for (const r of bad) assert.equal(ratingLicenceProblems([r], R).length, 1, JSON.stringify(r));
});
test('rating-licence: an unlicensed Texas value on a public school is stripped back to the link-out', async () => {
  const { input, rules } = await realSchools();
  const i = copyInput(input);
  const li = editRow(i, isTx, (r, F) => { r[F.ratingScheme] = 'us-tx-af'; r[F.rv] = 'B'; r[F.rd] = '2026'; });
  const F = fieldIndex(i.index);
  const b = packSchools(i, rules, LANDING);
  assert.equal(b.report.stripped, 1);
  assert.equal(b.report.valuesRemoved, 1);
  const { chunk } = openPack(b.json, b.bin);
  const got = JSON.parse(chunk(li))[findRow(i, isTx).ri];
  assert.deepEqual([got[F.ratingScheme], got[F.rv], got[F.rd]], ['us-pending', '', '']);
  assert.ok(b.gates.every(g => g.ok));
});
test('rating-licence: a value that cannot be stripped back to a source scheme fails the build', async () => {
  // pss (private schools) declares no defaultScheme, so the row stays on the
  // unlicensed scheme and the gate stops the build.
  fails(await schools(i => editRow(i, (r, F) => r[F.src] === 'pss', (r, F) => { r[F.ratingScheme] = 'us-tx-af'; r[F.rv] = 'A'; })), 'rating-licence', /us-tx-af/);
});
test('rating-licence: a Texas value under the licensed Connecticut scheme fails', async () => {
  fails(await schools(i => editRow(i, isTx, (r, F) => { r[F.ratingScheme] = 'us-ct-ngas'; r[F.rv] = 'Category 1'; })), 'rating-licence', /US-TX row\(s\) on us-ct-ngas/);
});
test('rating-licence: a Texas link-out row carrying an Ofsted grade or a rating date fails', async () => {
  fails(await schools(i => editRow(i, isTx, (r, F) => { r[F.rd] = '2026'; r[F.oeifGrade] = 'Outstanding'; })), 'rating-licence', /carry (rd|oeifGrade)/);
});
test('rating-licence: the allow-list is tools/schools/licence.mjs, at the data commit AND at HEAD', async () => {
  const { input, rules } = await realSchools();
  assert.deepEqual(rules.licensed, Object.keys(LICENSED_RATINGS));
  for (const f of ['gates.mjs', 'schools.mjs', 'landing.mjs', 'prices.mjs', 'container.mjs', 'build.mjs']) {
    const src = readFileSync(join(HERE, '..', 'lib', f), 'utf8');
    assert.ok(!/us-(ct|wa)-|LICENSED_RATINGS\s*=/.test(src), `lib/${f} hard-codes a licensed scheme`);
  }
  // Both copies must license a scheme, for the same jurisdiction.
  const without = s => { const L = { ...LICENSED_RATINGS }; delete L[s]; return { LICENSED_RATINGS: L, ratingLicensed: x => Object.hasOwn(L, x) }; };
  assert.deepEqual(combineLicences(licence, without('us-wa-wsif')).licensed, ['us-ct-ngas']);      // withdrawn at HEAD
  assert.deepEqual(combineLicences(without('us-ct-ngas'), licence).licensed, ['us-wa-wsif']);      // not yet at the data commit
  const widened = { LICENSED_RATINGS: { ...LICENSED_RATINGS, 'us-tx-af': { juris: 'US-TX' } }, ratingLicensed: () => true };
  assert.ok(!combineLicences(widened, licence).ratingLicensed('us-tx-af'));                        // an old commit cannot widen
  assert.ok(!combineLicences(licence, widened).ratingLicensed('us-tx-af'));
  const moved = { LICENSED_RATINGS: { ...LICENSED_RATINGS, 'us-ct-ngas': { ...LICENSED_RATINGS['us-ct-ngas'], juris: 'US-TX' } }, ratingLicensed: licence.ratingLicensed };
  assert.ok(!combineLicences(moved, licence).ratingLicensed('us-ct-ngas'));
  // Withdraw every licence (as licence.mjs would) and every state value goes too.
  const F = fieldIndex(input.index);
  const values = input.tiles.reduce((n, [, t]) => n + JSON.parse(t).filter(r => rules.licensed.includes(r[F.ratingScheme]) && r[F.rv] !== '').length, 0);
  assert.ok(values > 0);
  const none = combineLicences(licence, { LICENSED_RATINGS: {}, ratingLicensed: () => false });
  const b = packSchools(input, { ...rules, ...none }, LANDING);
  assert.equal(b.report.valuesRemoved, values);
  assert.ok(b.report.stripped >= b.report.valuesRemoved);   // + their rows with no value, all back on us-pending
  const { index } = openPack(b.json, b.bin);
  for (const s of Object.keys(LICENSED_RATINGS)) assert.ok(!index.schemes[s], s);
});

// ── 9. rating schemes (schools) ─────────────────────────────────────────────
test('rating-schemes: the gate function', () => {
  const schemes = { 'us-pending': {}, 'us-ct-ngas': {}, 'us-private': {} };
  assert.deepEqual(ratingSchemeProblems([{ src: 'ccd', ratingScheme: 'us-pending' }, { src: 'ccd', ratingScheme: 'us-ct-ngas' }], schemes, R), []);
  assert.equal(ratingSchemeProblems([{ src: 'ccd', ratingScheme: 'no-such-scheme' }], schemes, R).length, 2);   // undefined, and not its own
  assert.equal(ratingSchemeProblems([{ src: 'ccd', ratingScheme: 'us-private' }], schemes, R).length, 1);       // another source's scheme
});
test('rating-schemes: schools, a row on a scheme defined nowhere fails', async () => {
  fails(await schools(i => editRow(i, (r, F) => r[F.src] === 'gias', (r, F) => { r[F.ratingScheme] = 'no-such-scheme'; })), 'rating-schemes', /no-such-scheme/);
});

// ── 7. totals ───────────────────────────────────────────────────────────────
test('totals: schools count, a source, a jurisdiction and a region', async () => {
  fails(await schools(i => { i.index.count += 1; }), 'totals', /index.count/);
  fails(await schools(i => { i.index.sources.gias.rows -= 1; }), 'totals', /source gias/);
  fails(await schools(i => { i.index.juris['GB-WLS'].count += 2; }), 'totals', /juris GB-WLS/);
  fails(await schools(i => { i.index.regions.find(r => r.id === 'nyc').count -= 1; }), 'totals', /region nyc/);
});
test('totals: home values per region, per source and per scale', async () => {
  fails(await prices(i => { i.index.regions[0].areas += 1; }), 'totals', /regions sum|region /);
  fails(await prices(i => { i.index.sources['ni-ward'].stats.coloured += 1; }), 'totals', /source ni-ward/);
  fails(await prices(i => { i.index.scales[3].areas -= 1; }), 'totals', /scale /);
});

// ── 6. reproduction ─────────────────────────────────────────────────────────
// Rewrite one chunk of a built pack (recomputing the table and sha256, as a
// faulty builder would) and check the gate sees it.
function tamper(json, bin, i, edit) {
  const { index, pack, chunk } = openPack(json, bin);
  const raws = pack.chunks.map((c, k) => {
    if (k !== i) return { raw: chunk(k), rows: c[2] };
    const v = JSON.parse(chunk(k)); edit(v);
    return { raw: Buffer.from(JSON.stringify(v)), rows: Array.isArray(v) ? v.length : v.a.length };
  });
  const a = assemble(raws);
  return { json: packJson(index, { ...pack, chunks: a.table, sha256: sha256(a.bin), bytes: a.bin.length }), bin: a.bin };
}
test('reproduction: schools, a changed, a dropped and a reordered row are caught', async () => {
  const { input, rules } = await realSchools();
  const b = packSchools(input, rules, LANDING);
  const F = fieldIndex(input.index);
  const leaves = input.tiles.map(([key, text]) => ({ key, text }));
  const ctx = t => ({ web: input.index, leaves, index: null, json: t.json, bin: t.bin, transform: makeTransform(input.index, rules), rules });
  assert.deepEqual(schoolsRepro(ctx(b)), []);
  const big = JSON.parse(b.json).pack.chunks.findIndex(c => c[2] > 3);
  assert.match(schoolsRepro(ctx(tamper(b.json, b.bin, big, rows => { rows[1][F.postcode] = 'ZZ1 1ZZ'; }))).join('\n'), /row 1 .*not the web row/);
  assert.match(schoolsRepro(ctx(tamper(b.json, b.bin, big, rows => { rows.pop(); }))).join('\n'), /rows in the pack/);
  assert.match(schoolsRepro(ctx(tamper(b.json, b.bin, big, rows => { [rows[0], rows[1]] = [rows[1], rows[0]]; }))).join('\n'), /row 0/);
  assert.match(schoolsRepro(ctx(tamper(b.json, b.bin, big, rows => { rows[0][F.lat] += 0.00001; }))).join('\n'), /row 0/);
});
test('reproduction: home values, a moved vertex and a lost area are caught', async () => {
  const { input, rules } = await realPrices();
  const b = packPrices(input, rules, LANDING);
  const F = fieldIndex(input.index);
  assert.deepEqual(pricesRepro(input, b.json, b.bin), []);
  assert.match(pricesRepro(input, ...Object.values(tamper(b.json, b.bin, 0, t => { t.a[0][F.polys][0][0][3] += 1; }))).join('\n'), /differs from the web tile/);
  assert.match(pricesRepro(input, ...Object.values(tamper(b.json, b.bin, 5, t => { t.a[2][F.value] = 123456; }))).join('\n'), /differs from the web tile/);
  assert.match(pricesRepro(input, ...Object.values(tamper(b.json, b.bin, 7, t => { t.a.pop(); }))).join('\n'), /missing row/);
});
test('reproduction: home values, an area published differently in two leaves fails the build', async () => {
  // The first area that the web copies into more than one leaf.
  const { input } = await realPrices();
  const seen = new Map();
  let target;
  input.tiles.forEach(([, t], li) => JSON.parse(t).a.forEach((r, ri) => { const k = `${r[0]}:${r[1]}`; if (seen.has(k) && !target) target = { li, ri }; seen.set(k, li); }));
  fails(await prices(i => editTile(i, target.li, t => { t.a[target.ri][5] = (t.a[target.ri][5] ?? 0) + 1000; })), 'reproduction', /differs between leaves/);
});
