// node --test tools/prices/test/
// Polygon tiling: an area must be in EVERY leaf its bbox touches (the page
// loads only the leaves in view), leaves never overlap, and a tile row
// round-trips through the published format.
import test from 'node:test';
import assert from 'node:assert/strict';
import { tileAreas, cellsForBbox, parseKey, tileJson, areasFromTile, removeLeftovers, readableFields, BASE, MIN_CELL } from '../lib/tiles.mjs';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { cellKey } from '../../schools/lib/tiles.mjs';
import { processPolys } from '../lib/geo.mjs';
import { FIELDS } from '../lib/schema.mjs';

const square = (s, w, d) => [[w, s], [w + d, s], [w + d, s + d], [w, s + d], [w, s]];
const mk = (id, s, w, d, extra = {}) => {
  const { enc, bbox } = processPolys([[square(s, w, d)]]);
  return { src: 'x', srcIdx: 0, id, name: null, region: 'nyc', regionIdx: 0, scale: 'nyc', scaleIdx: 0, value: 1, moe: null, n: null, flags: [], context: null, enc, bbox, ...extra };
};

test('cellsForBbox: every cell a bbox touches, and only those', () => {
  assert.deepEqual(cellsForBbox([40.6, -74.1, 40.7, -74.01], 0), ['162_-297']);
  // An edge exactly on a cell line touches the cell beyond it.
  assert.deepEqual(cellsForBbox([40.6, -74.1, 40.7, -74.0], 0), ['162_-297', '162_-296']);
  assert.deepEqual(cellsForBbox([40.6, -74.1, 40.8, -73.9], 0).sort(), ['162_-296', '162_-297', '163_-296', '163_-297'].sort());
  // Matches the schools key of each corner.
  for (const [lat, lng] of [[40.6, -74.1], [40.8, -73.9]]) assert.ok(cellsForBbox([40.6, -74.1, 40.8, -73.9], 1).includes(cellKey(lat, lng, 1)));
  // Limited to one parent's children.
  const p = parseKey('162_-297');
  assert.deepEqual(cellsForBbox([40, -75, 41, -73], 1, BASE, p).sort(), ['q324_-594', 'q324_-593', 'q325_-594', 'q325_-593'].sort());
});

test('tiling assigns an area to every leaf its bbox touches (and splits dense cells)', () => {
  const areas = [];
  // A dense cluster that forces splits down to the minimum cell...
  for (let i = 0; i < 30; i++) for (let j = 0; j < 30; j++) areas.push(mk(`d${i}_${j}`, 40.70 + i * 0.004, -74.00 + j * 0.004, 0.003));
  // ...areas straddling cell edges at every level...
  areas.push(mk('big', 40.55, -74.2, 0.5));                  // crosses several 0.25° cells
  areas.push(mk('edge', 40.7475, -73.9425, 0.01));           // crosses the 0.0625° lines at 40.75 and -73.9375
  // ...and a sparse one far away that stays at 0.25°.
  areas.push(mk('far', 41.9, -87.7, 0.01));
  const leaves = tileAreas(areas, { maxAreas: 100, maxBytes: 1e9 });
  const leafKeys = new Set(leaves.map(([k]) => k));
  const byKey = new Map(leaves.map(([k, l]) => [k, new Set(l.map(a => a.id))]));

  // Leaves are disjoint: no leaf is an ancestor of another.
  for (const k of leafKeys) {
    const { level, y, x } = parseKey(k);
    for (let l = 0; l < level; l++) {
      const d = 2 ** (level - l);
      assert.ok(!leafKeys.has('q'.repeat(l) + `${Math.floor(y / d)}_${Math.floor(x / d)}`), `${k} has a leaf ancestor`);
    }
  }
  assert.ok([...leafKeys].some(k => k.startsWith('qq')), 'the dense cell was split to the minimum');
  assert.ok(leaves.every(([k, l]) => l.length <= 100 || parseKey(k).size <= MIN_CELL), 'no leaf over the threshold above the minimum cell');

  // Every leaf the bbox overlaps holds the area; no leaf it does not touch
  // does. (A bbox edge lying exactly on a cell line may or may not bring the
  // cell beyond it: a zero-width touch shows nothing either way.)
  const cellsOf = (a, strict) => [...leafKeys].filter(k => {
    const [s, w, n, e] = parseKey(k).bounds;
    return strict ? a.bbox[0] < n && a.bbox[2] > s && a.bbox[1] < e && a.bbox[3] > w
      : a.bbox[0] <= n && a.bbox[2] >= s && a.bbox[1] <= e && a.bbox[3] >= w;
  });
  for (const a of areas) {
    for (const k of cellsOf(a, true)) assert.ok(byKey.get(k).has(a.id), `${a.id} missing from ${k}`);
    const touched = cellsOf(a, false);
    for (const [k, ids] of byKey) if (ids.has(a.id)) assert.ok(touched.includes(k), `${a.id} is in ${k}, which its bbox does not touch`);
  }
  assert.ok([...byKey.values()].filter(s => s.has('big')).length >= 4, 'the big area is in all its cells');
  assert.ok([...byKey.values()].filter(s => s.has('edge')).length >= 2, 'the edge area is on both sides');
  assert.deepEqual([...byKey.entries()].filter(([, s]) => s.has('far')).map(([k]) => k), ['167_-351']);
});

test('the byte limit splits too, and the output is deterministic', () => {
  const areas = [];
  for (let i = 0; i < 40; i++) areas.push(mk(`a${i}`, 40.70 + (i % 8) * 0.02, -74.0 + Math.floor(i / 8) * 0.02, 0.015));
  const one = tileAreas(areas, { maxAreas: 1000, maxBytes: 1e9 });
  const split = tileAreas(areas, { maxAreas: 1000, maxBytes: 500 });
  assert.ok(split.length > one.length, 'a byte limit forces a split');
  const again = tileAreas([...areas].reverse(), { maxAreas: 1000, maxBytes: 500 });
  assert.deepEqual(split.map(([k, l]) => [k, tileJson(l)]), again.map(([k, l]) => [k, tileJson(l)]), 'input order does not change a byte');
});

test('tile rows round-trip, contexts deduplicated per tile', () => {
  const ctxA = { label: 'Wider area (Titanic DEA), 2025', value: 180000, n: 212 };
  const a = [
    mk('N08000102', 54.6, -5.9, 0.01, { name: 'Ward B', value: null, flags: ['suppressed'], context: ctxA, scale: 'TLN' }),
    mk('N08000101', 54.6, -5.92, 0.01, { name: 'Ward A', value: 150000, n: 40, flags: [], context: null, scale: 'TLN' }),
    mk('N08000103', 54.61, -5.9, 0.01, { name: null, value: 2000001, moe: 1500, n: 7, flags: ['topcoded', 'few'], context: { ...ctxA }, scale: 'TLN' }),
  ];
  const text = tileJson(a);
  const t = JSON.parse(text);
  assert.deepEqual(Object.keys(t), ['a', 'c']);
  assert.equal(t.c.length, 1, 'the shared context is stored once');
  assert.deepEqual(t.a.map(r => r[1]), ['N08000101', 'N08000102', 'N08000103'], 'rows sorted by id');
  assert.ok(t.a.every(r => r.length === FIELDS.length));
  assert.equal(t.a[2][FIELDS.indexOf('flags')], 4 | 8);
  // A context without a margin of error or flags is stored as it always was.
  assert.deepEqual(t.c[0], ctxA, 'the NI line keeps its phase-1 shape, byte for byte');
  const index = { fields: FIELDS, sources: { x: {} }, regions: [{ id: 'uk' }], scales: [{ key: 'TLN' }] };
  const back = areasFromTile(text, index);
  const ctxRead = { ...ctxA, moe: null, flags: [] };
  assert.deepEqual(back.map(b => [b.id, b.name, b.value, b.n, b.flags, b.context, b.iqr]), [
    ['N08000101', 'Ward A', 150000, 40, [], null, null],
    ['N08000102', 'Ward B', null, null, ['suppressed'], ctxRead, null],
    ['N08000103', null, 2000001, 7, ['topcoded', 'few'], ctxRead, null],
  ]);
  assert.equal(tileJson(back.map((b, i) => ({ ...b, srcIdx: 0, regionIdx: 0, scaleIdx: 0 }))), text, 'read back and written again: byte-identical');
  assert.deepEqual(back[0].enc, a[1].enc);
  assert.equal(back[0].src, 'x');
  assert.equal(back[0].region, 'uk');
  assert.equal(back[0].scale, 'TLN');
});

test('a sale tract: its middle half and its context moe/flags round-trip; an older tile set reads iqr as null', () => {
  const ctx = { label: 'Owners’ estimate, 2020–24 survey', value: 2000001, moe: null, n: null, flags: ['topcoded'] };
  const ctx2 = { label: 'Owners’ estimate, 2020–24 survey', value: 640000, moe: 52300, n: null, flags: ['uncertain'] };
  const a = [
    mk('36061000100', 40.7, -74.0, 0.01, { name: 'Census Tract 1, New York County, NY', value: 1250000, n: 41, iqr: [890000, 2100000], context: ctx, scale: 'nyc' }),
    mk('36061000200', 40.71, -74.0, 0.01, { name: 'Census Tract 2, New York County, NY', value: null, n: 2, flags: ['suppressed'], context: ctx2, scale: 'nyc' }),
  ];
  const text = tileJson(a), t = JSON.parse(text);
  assert.deepEqual(t.c, [{ label: ctx.label, value: 2000001, n: null, flags: 4 }, { label: ctx2.label, value: 640000, n: null, moe: 52300, flags: 2 }]);
  assert.deepEqual(t.a[0][FIELDS.indexOf('iqr')], [890000, 2100000]);
  const index = { fields: FIELDS, sources: { s: {} }, regions: [{ id: 'nyc' }], scales: [{ key: 'nyc' }] };
  const back = areasFromTile(text, index);
  assert.deepEqual(back.map(b => [b.iqr, b.context]), [[[890000, 2100000], ctx], [null, ctx2]]);
  assert.equal(tileJson(back.map(b => ({ ...b, srcIdx: 0, regionIdx: 0, scaleIdx: 0 }))), text, 'byte-identical when re-emitted');
  // Tiles written before iqr existed: the row is one shorter; it reads as null.
  const old = JSON.stringify({ a: t.a.map(r => r.slice(0, -1)), c: t.c });
  const oldIndex = { ...index, fields: FIELDS.slice(0, -1) };
  assert.ok(readableFields(oldIndex.fields) && readableFields(FIELDS));
  assert.ok(!readableFields([...FIELDS.slice(0, -2), 'iqr', 'polys']) && !readableFields(FIELDS.slice(0, -2)), 'a reordered or shorter list is refused');
  assert.deepEqual(areasFromTile(old, oldIndex).map(b => b.iqr), [null, null]);
});

test('removeLeftovers: a killed build\'s staging goes; its only copy of the output comes back', t => {
  const tmp = mkdtempSync(join(tmpdir(), 'prices-leftovers-'));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  const out = join(tmp, 'data'), dead = 2147483646;
  mkdirSync(out); mkdirSync(`${out}.staging-${dead}`); mkdirSync(`${out}.staging-${process.pid}`);
  mkdirSync(`${tmp}/other.staging-${dead}`);   // not ours
  assert.deepEqual(removeLeftovers(out), [`removed data.staging-${dead}`, `removed data.staging-${process.pid}`]);
  assert.deepEqual(readdirSync(tmp).sort(), ['data', `other.staging-${dead}`]);
  // Killed between the two renames: the published set is only in .old-<pid>.
  rmSync(out, { recursive: true });
  mkdirSync(`${out}.old-${dead}`); writeFileSync(join(`${out}.old-${dead}`, 'index.json'), '{}');
  mkdirSync(`${out}.staging-${dead}`);
  assert.deepEqual(removeLeftovers(out), [`restored data.old-${dead}`, `removed data.staging-${dead}`]);
  assert.ok(existsSync(join(out, 'index.json')));
});
