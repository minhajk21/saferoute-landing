// node --test tools/app-packs/test/
// Every O1 gate (RELEASE-1.4-SCOPE.md §4.4) fails on a fixture made to break
// it: the real published inputs with one thing changed, built through the
// real pack builder, plus the gate functions on hand-made fixtures. And on the
// real data every gate passes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { realSchools, realPrices, copyInput, editTile, fieldIndex, LANDING } from './helpers.mjs';
import { packSchools, makeTransform, reproductionProblems as schoolsRepro } from '../lib/schools.mjs';
import { packPrices, reproductionProblems as pricesRepro } from '../lib/prices.mjs';
import { assemble, packJson, openPack, sha256 } from '../lib/container.mjs';
import { GateError, forbiddenFieldProblems, filterProblems, licenceUrlProblems, sourceIdProblems, noteHtmlProblems, ratingLicenceProblems } from '../lib/gates.mjs';
import { LICENSED_RATINGS, ratingLicensed } from '../../schools/licence.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCHOOL_GATES = ['forbidden-fields', 'filter-ids', 'licence-urls', 'source-ids', 'note-html', 'rating-licence', 'totals', 'reproduction'];
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

// ── the real data passes every gate ─────────────────────────────────────────
test('real data: every schools gate runs and passes', async () => {
  const { input, rules } = await realSchools();
  const b = packSchools(input, rules, LANDING);
  assert.deepEqual(b.gates.map(g => g.name), SCHOOL_GATES);
  assert.ok(b.gates.every(g => g.ok));
});
test('real data: every home-values gate runs and passes', async () => {
  const { input, rules } = await realPrices();
  const b = packPrices(input, rules, LANDING);
  assert.deepEqual(b.gates.map(g => g.name), PRICE_GATES);
  assert.ok(b.gates.every(g => g.ok));
});

// ── 1. forbidden fields ─────────────────────────────────────────────────────
test('forbidden-fields: the gate function, on each forbidden stem', () => {
  for (const k of ['religion', 'Denomination', 'faithGroup', 'diocese', 'typology', 'religiousCharacter', 'orientation', 'sexualOrientation']) {
    assert.equal(forbiddenFieldProblems({ fields: ['src', k] }).length, 1, k);
    assert.equal(forbiddenFieldProblems({ fields: [], sources: { x: { labels: { [k]: 'x' } } } }).length, 1, k);
  }
  assert.deepEqual(forbiddenFieldProblems({ fields: ['src', 'trust', 'gender'], sources: { x: { labels: { trust: 'Management type' } } } }), []);
});
test('forbidden-fields: schools, a row field named for religion', async () => {
  fails(await schools(i => { i.index.fields[i.index.fields.indexOf('admissions')] = 'faithAdmissions'; }), 'forbidden-fields', /faithAdmissions/);
});
test('forbidden-fields: schools, a key deep in the index', async () => {
  fails(await schools(i => { i.index.sources.de.labels.religion = 'Religion'; }), 'forbidden-fields', /religion/);
  fails(await schools(i => { i.index.regions[0].orientation = 'north'; }), 'forbidden-fields', /orientation/);
});
test('forbidden-fields: home values, a source key and a context key', async () => {
  fails(await prices(i => { i.index.sources['acs-tract'].denomination = 'x'; }), 'forbidden-fields', /denomination/);
  const ti = (await realPrices()).input.tiles.findIndex(([, t]) => JSON.parse(t).c.length);
  fails(await prices(i => editTile(i, ti, t => { t.c[0].dioceseShare = 1; })), 'forbidden-fields', /dioceseShare/);
});

// ── 2. filter ids ───────────────────────────────────────────────────────────
test('filter-ids: the gate function', () => {
  assert.deepEqual(filterProblems({ filters: [{ id: 'gender' }, { id: 'boarding' }, { id: 'charter' }], options: { gender: [] } }), []);
  assert.equal(filterProblems({ filters: [{ id: 'sector' }] }).length, 1);
  assert.equal(filterProblems({ filters: [], options: { management: [] } }).length, 1);
});
test('filter-ids: schools, a filter outside gender/boarding/charter', async () => {
  fails(await schools(i => { i.index.filters.push({ id: 'management', type: 'select', field: 'trust', label: 'Management', publishedBy: ['de'], where: 'Northern Ireland' }); }), 'filter-ids', /management/);
  fails(await schools(i => { i.index.options.rating = ['A', 'B']; }), 'filter-ids', /rating/);
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
});
test('licence-urls: schools, an http licence and a missing one', async () => {
  fails(await schools(i => { i.index.sources.gias.licenceUrl = i.index.sources.gias.licenceUrl.replace('https:', 'http:'); }), 'licence-urls', /gias/);
  fails(await schools(i => { delete i.index.sources.sep.licenceUrl; }), 'licence-urls', /sep/);
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

// ── 5. note html ────────────────────────────────────────────────────────────
test('note-html: the gate function allows <b> only', () => {
  assert.deepEqual(noteHtmlProblems({ schemes: { a: { notes: [{ html: '<b>Bold</b> and n < 3, 4 > 2' }] } } }), []);
  for (const h of ['<i>x</i>', '<a href="https://x.org">x</a>', '<script>alert(1)</script>', '<span class="caveat">x</span>', '<br>', '<b class="x">x</b>', '<img src=x onerror=alert(1)>']) {
    assert.ok(noteHtmlProblems({ schemes: { a: { notes: [{ html: h }] } } }).length >= 1, h);
  }
});
test('note-html: schools, a link outside the caveat pattern, and an http source link', async () => {
  fails(await schools(i => { i.index.schemes['mx-none'].notes[0].html += ' <a href="https://www.planea.sep.gob.mx/">PLANEA</a>'; }), 'note-html', /mx-none/);
  fails(await schools(i => { const n = i.index.schemes['us-pending'].notes[0]; n.html = n.html.replace('href="https://', 'href="http://'); }), 'note-html', /us-pending/);
  fails(await schools(i => { i.index.schemes['not-ofsted'].notes[0].html += '<script>x</script>'; }), 'note-html', /script/);
});
test('note-html: home values, a tag in a source note', async () => {
  fails(await prices(i => { i.index.sources['acs-tract'].notes.push('See <a href="https://www.census.gov">the Census</a>.'); }), 'note-html', /acs-tract/);
});

// ── 8. the rating licence (schools) ─────────────────────────────────────────
test('rating-licence: the gate function', () => {
  const rows = [
    { juris: 'US-CT', ratingScheme: 'us-ct-ngas', rv: 'Category 1' },     // licensed
    { juris: 'GB-NIR', ratingScheme: 'ni-eti', rv: 'Good' },              // not a US value
    { juris: 'US-NY', ratingScheme: 'us-pending', rv: '' },
  ];
  assert.deepEqual(ratingLicenceProblems(rows, ratingLicensed, ['us-ct-ngas', 'us-tx-af']), []);
  assert.equal(ratingLicenceProblems([{ juris: 'US-TX', ratingScheme: 'us-tx-af', rv: 'B' }], ratingLicensed, ['us-tx-af']).length, 1);
  assert.equal(ratingLicenceProblems([{ juris: 'US-AZ', ratingScheme: 'us-az-af', rv: '' }], ratingLicensed, ['us-az-af']).length, 1);   // stranded on it
  assert.equal(ratingLicenceProblems([{ juris: 'US-NY', ratingScheme: 'us-pending', rv: 'x' }], ratingLicensed, []).length, 1);         // a value under a non-licensed scheme
});
test('rating-licence: an unlicensed Texas value on a public school is stripped back to the link-out', async () => {
  const { input, rules } = await realSchools();
  const i = copyInput(input), F = fieldIndex(i.index);
  editTile(i, 0, rows => { const r = rows.find(r => r[F.juris] === 'US-TX' && r[F.src] === 'ccd'); r[F.ratingScheme] = 'us-tx-af'; r[F.rv] = 'B'; r[F.rd] = '2026'; });
  const b = packSchools(i, rules, LANDING);
  assert.equal(b.report.stripped, 1);
  assert.equal(b.report.valuesRemoved, 1);
  const { chunk } = openPack(b.json, b.bin);
  const got = JSON.parse(chunk(0)).find(r => r[F.juris] === 'US-TX' && r[F.src] === 'ccd');
  assert.deepEqual([got[F.ratingScheme], got[F.rv], got[F.rd]], ['us-pending', '', '']);
  assert.ok(b.gates.every(g => g.ok));
});
test('rating-licence: a value that cannot be stripped back to a source scheme fails the build', async () => {
  // pss (private schools) declares no defaultScheme, so the row stays on the
  // unlicensed scheme and the gate stops the build.
  fails(await schools(i => editTile(i, 0, rows => { const F = fieldIndex(i.index); const r = rows.find(r => r[F.src] === 'pss'); r[F.ratingScheme] = 'us-tx-af'; r[F.rv] = 'A'; })), 'rating-licence', /us-tx-af/);
});
test('rating-licence: the allow-list is tools/schools/licence.mjs, not a second list', async () => {
  const { rules } = await realSchools();
  assert.equal(rules.ratingLicensed, ratingLicensed);
  assert.deepEqual(rules.licensed, Object.keys(LICENSED_RATINGS));
  for (const f of ['gates.mjs', 'schools.mjs', 'landing.mjs', 'prices.mjs', 'container.mjs']) {
    const src = readFileSync(join(HERE, '..', 'lib', f), 'utf8');
    assert.ok(!/us-(ct|wa)-|LICENSED_RATINGS\s*=/.test(src), `lib/${f} hard-codes a licensed scheme`);
  }
  // Withdraw every licence (as licence.mjs would) and the CT/WA values go too.
  const { input } = await realSchools();
  const b = packSchools(input, { ...rules, ratingLicensed: () => false, licensed: [] }, LANDING);
  assert.equal(b.report.valuesRemoved, 46 + 142);   // the us-ct-ngas + us-wa-wsif values at c97230057
  assert.ok(b.report.stripped >= b.report.valuesRemoved);   // + their rows with no value, all back on us-pending
  const { index } = openPack(b.json, b.bin);
  assert.ok(!index.schemes['us-ct-ngas'] && !index.schemes['us-wa-wsif']);
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
