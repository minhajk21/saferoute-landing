// node --test tools/app-packs/test/*.test.mjs
// Every web tile row comes back exactly from the pack, for both layers, read
// the way the app will read it: only the pack's JSON and .bin, rows by field
// name. Independent of the builder's own reproduction gate.
import test from 'node:test';
import assert from 'node:assert/strict';
import { realSchools, realPrices, LANDING, fieldIndex } from './helpers.mjs';
import { packSchools } from '../lib/schools.mjs';
import { packPrices } from '../lib/prices.mjs';
import { openPack } from '../lib/container.mjs';

test('schools: every web row is in its leaf\'s chunk, in order; only display case differs', async () => {
  const { input, rules } = await realSchools();
  const built = packSchools(input, rules, LANDING);
  const { index, pack, chunk } = openPack(built.json, built.bin);
  assert.equal(index.version, 2);
  assert.equal(pack.chunks.length, input.index.cells.length);
  const F = fieldIndex(index), W = fieldIndex(input.index);
  assert.deepEqual(index.fields, input.index.fields);
  const lang = Object.fromEntries(Object.entries(input.index.sources).map(([id, s]) => [id, s.displayCase]));
  let n = 0, cased = 0;
  input.tiles.forEach(([key, text], i) => {
    assert.equal(index.cells[i], key);
    const web = JSON.parse(text), got = JSON.parse(chunk(i));
    assert.equal(got.length, web.length, key);
    assert.equal(pack.chunks[i][2], web.length, key);
    for (let j = 0; j < web.length; j++) {
      const w = web[j], g = got[j], dc = lang[w[W.src]];
      for (const f of input.index.fields) {
        let want = w[W[f]];
        if (['name', 'area', 'la'].includes(f) && dc) want = rules.schCase(want, dc);
        if (f === 'trust') want = dc ? rules.schCase(want, dc) : rules.trustName(want);
        assert.deepEqual(g[F[f]], want, `${key} row ${j} ${w[W.src]}:${w[W.id]} ${f}`);
        if (g[F[f]] !== w[W[f]]) cased++;
      }
      n++;
    }
  });
  assert.equal(n, input.index.count);
  assert.ok(cased > 10000, `only ${cased} values re-cased`);
});

test('schools: display case is what the /check/ pane shows', async () => {
  const { input, rules } = await realSchools();
  const built = packSchools(input, rules, LANDING);
  const { index, chunk } = openPack(built.json, built.bin);
  const F = fieldIndex(index);
  const all = index.cells.flatMap((_, i) => JSON.parse(chunk(i)));
  const by = (src, f, re) => all.find(r => r[F.src] === src && re.test(r[F[f]]));
  // Mixed case as published is untouched (GIAS names), capitals are re-cased.
  assert.ok(by('gias', 'name', /^[A-Z][a-z]/));
  // Mexico City names in capitals now read in title case; the few left in
  // capitals are wholly initialisms the rule keeps (CENDI IMSS II, CADI).
  const caps = all.filter(r => r[F.src] === 'sep' && r[F.name] === r[F.name].toUpperCase() && /[A-Z]{4}/.test(r[F.name]) && !/\d/.test(r[F.name]));
  assert.ok(caps.length < 20, `${caps.length} Mexico City names still in capitals`);
  // Known pane strings (the page's own test cases, display-case.test.mjs).
  assert.equal(rules.schCase('HOUSTON ISD', 'en'), 'Houston ISD');
  assert.ok(by('ccd', 'la', /^Houston ISD$/), 'Houston ISD as the pane shows it');
  // GIAS trusts: no all-capitals multi-word trust survives.
  assert.equal(all.filter(r => r[F.src] === 'gias' && /^[A-Z]+( [A-Z]+){2,}$/.test(r[F.trust]) && /[AEIOU]/.test(r[F.trust])).length, 0);
  // The index says it was applied and no longer asks the app to apply it.
  assert.ok(Object.values(index.sources).every(s => !('displayCase' in s)));
  assert.deepEqual(JSON.parse(built.json).pack.displayCase.sources, { ccd: 'en', pss: 'en', sep: 'es' });
});

test('prices: every web tile row is rebuilt from the leaf map and the chunks (contexts resolved)', async () => {
  const { input, rules } = await realPrices();
  const built = packPrices(input, rules, LANDING);
  const { index, pack, chunk } = openPack(built.json, built.bin);
  assert.equal(pack.chunks.length, index.scales.length);
  assert.equal(pack.leaves.length, index.tiles.cells.length);
  const F = fieldIndex(index);
  const chunks = pack.chunks.map((_, i) => JSON.parse(chunk(i)));
  // Every area once: no (src, id) in two chunks or twice in one.
  const keys = new Set();
  chunks.forEach((t, ci) => t.a.forEach(r => {
    const k = `${r[F.src]}:${r[F.id]}`;
    assert.ok(!keys.has(k), `duplicate ${k}`);
    keys.add(k);
    assert.equal(r[F.scale], ci, `${k} is in the chunk of another scale`);
  }));
  let rows = 0;
  input.tiles.forEach(([key, text], li) => {
    const web = JSON.parse(text), flat = pack.leaves[li];
    assert.equal(flat.length, web.a.length * 2, key);
    web.a.forEach((w, j) => {
      const t = chunks[flat[2 * j]], g = t.a[flat[2 * j + 1]];
      const resolve = (r, c) => r.map((v, k) => (k === F.ctx && v != null ? c[v] : v));
      assert.deepEqual(resolve(g, t.c), resolve(w, web.c), `${key} row ${j}`);
      rows++;
    });
  });
  assert.equal(rows, input.tiles.reduce((n, [, t]) => n + JSON.parse(t).a.length, 0));   // the web's copies, one per leaf an area touches
  assert.ok(keys.size < rows, 'areas are stored once, not once per leaf');
  assert.equal(keys.size, index.regions.reduce((n, r) => n + r.areas, 0));
});

test('prices: the slimmed index drops only the download records', async () => {
  const { input, rules } = await realPrices();
  const built = packPrices(input, rules, LANDING);
  const { index } = openPack(built.json, built.bin);
  for (const [id, s] of Object.entries(index.sources)) {
    assert.ok(!('upstream' in s) && !('inputs' in s), id);
    const { upstream, inputs, ...rest } = input.index.sources[id];
    assert.deepEqual(s, rest, id);
  }
  // Rows name their source through pack.sourceIds (JSON object order is not
  // something every parser keeps), which is the index's own order.
  assert.deepEqual(JSON.parse(built.json).pack.sourceIds, Object.keys(input.index.sources));
  // The denver region is legitimate: owners' estimates from acs-tract.
  const denver = index.regions.find(r => r.id === 'denver');
  assert.deepEqual(denver?.sources, ['acs-tract']);
  assert.ok(!('denver-sales' in index.sources));
});
