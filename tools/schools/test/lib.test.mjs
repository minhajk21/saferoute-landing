// node --test tools/schools/test/
// Unit tests for the shared schools libraries: the pieces every source lane
// builds on, so a change that breaks one lane's assumptions fails here first.
import test from 'node:test';
import assert from 'node:assert/strict';
import { giasStage, niStage, usPublicStage, usPrivateStage, ontarioStage, bcStage, mxStage } from '../lib/stage.mjs';
import { cellKey, parseKey, tileRows, sortRows, BASE, MAX_ROWS, MIN_CELL } from '../lib/tiles.mjs';
import { FIELDS, EMPTY, toRow, fromRow, rowProblems } from '../lib/schema.mjs';
import { parseCsv, records } from '../lib/csv.mjs';
import { loadCoverage, inBox } from '../lib/coverage.mjs';
import { composeWhere, joinAnd } from '../lib/meta.mjs';

test('stage: GIAS grouping and the name rule (moved verbatim from /check/)', () => {
  assert.equal(giasStage({ phase: 'Middle deemed secondary' }), 'Secondary');
  assert.equal(giasStage({ phase: 'Middle deemed primary' }), 'Primary');
  assert.equal(giasStage({ phase: '16 plus' }), 'Secondary');
  assert.equal(giasStage({ phase: '', type: 'Special post 16 institution' }), 'Secondary');
  assert.equal(giasStage({ phase: '', name: 'Ysgol Gynradd Aberaeron' }), 'Primary');
  assert.equal(giasStage({ phase: '', name: 'Primary and Nursery School' }), 'Primary');
  assert.equal(giasStage({ phase: '', name: 'Ysgol Cei Newydd' }), '');     // not guessed
});
test('stage: other systems (DESIGN.md §3)', () => {
  assert.equal(niStage('Preps'), 'Primary');
  assert.equal(niStage('Grammar'), 'Secondary');
  assert.equal(niStage('Special'), '');
  assert.equal(usPublicStage('Middle', '06'), 'Primary');
  assert.equal(usPublicStage('Middle', '08'), 'Secondary');
  assert.equal(usPublicStage('Other', '12'), 'Secondary');
  assert.equal(usPublicStage('Prekindergarten', 'PK'), 'Nursery');
  assert.equal(usPublicStage('Not reported', ''), '');
  assert.equal(usPrivateStage('1'), 'Primary');
  assert.equal(usPrivateStage(3), 'Secondary');
  assert.equal(ontarioStage('Elementary'), 'Primary');
  assert.equal(ontarioStage('Elem/Sec'), 'Secondary');
  assert.equal(bcStage('Middle School'), 'Secondary');
  assert.equal(mxStage('INICIAL'), 'Nursery');
  assert.equal(mxStage('CAM'), '');
});

test('tiles: keys nest exactly (powers of two, negatives too)', () => {
  for (const [lat, lng] of [[51.5074, -0.1278], [-0.1, -0.1], [19.4326, -99.1332], [40.75, -73.98]]) {
    const b = parseKey(cellKey(lat, lng, 0)), q = parseKey(cellKey(lat, lng, 1)), qq = parseKey(cellKey(lat, lng, 2));
    assert.equal(Math.floor(q.y / 2), b.y); assert.equal(Math.floor(q.x / 2), b.x);
    assert.equal(Math.floor(qq.y / 2), q.y); assert.equal(Math.floor(qq.x / 2), q.x);
    for (const k of [b, q, qq]) { const [s, w, n, e] = k.bounds; assert.ok(lat >= s && lat < n && lng >= w && lng < e); }
  }
  assert.equal(cellKey(51.51, -0.12, 1), 'q412_-1');
});
test('tiles: split over maxRows, stop at minCell, leaves disjoint and complete', () => {
  const rows = [];
  // 3,000 points in one 0.0625° cell (cannot split further) + 700 spread over a 0.25° cell
  for (let i = 0; i < 3000; i++) rows.push({ src: 't', id: `a${i}`, lat: 51.51 + (i % 50) * 0.0001, lng: -0.12 + Math.floor(i / 50) * 0.0001 });
  for (let i = 0; i < 700; i++) rows.push({ src: 't', id: `b${i}`, lat: 52.0 + (i % 26) * 0.0095, lng: 1.0 + Math.floor(i / 26) * 0.0092 });
  sortRows(rows);
  const leaves = tileRows(rows, { base: BASE, maxRows: MAX_ROWS, minCell: MIN_CELL });
  assert.equal(leaves.reduce((a, [, l]) => a + l.length, 0), rows.length);
  const keys = new Set(leaves.map(([k]) => k));
  for (const [k, l] of leaves) {
    const { level, y, x, bounds: [s, w, n, e] } = parseKey(k);
    assert.ok(l.length <= MAX_ROWS || level === 2, `${k} has ${l.length}`);
    for (const r of l) assert.ok(r.lat >= s && r.lat < n && r.lng >= w && r.lng < e);
    for (let lv = 0; lv < level; lv++) { const d = 2 ** (level - lv); assert.ok(!keys.has('q'.repeat(lv) + `${Math.floor(y / d)}_${Math.floor(x / d)}`)); }
  }
  assert.ok([...keys].some(k => k.startsWith('qq')), 'the dense cell reached the minimum size');
});

test('schema: toRow/fromRow round-trip and empty values', () => {
  const o = { src: 'gias', id: '100000', name: 'X', lat: 51.5, lng: -0.1, juris: 'GB-ENG', sector: 'state', stage: 'Primary', ratingScheme: 'none' };
  const back = fromRow(toRow(o));
  assert.equal(back.id, '100000'); assert.equal(back.boarding, false); assert.equal(back.pupils, null); assert.equal(back.tags, '');
  assert.equal(Object.keys(EMPTY).length, FIELDS.length);
  const src = { id: 'gias', juris: ['GB-ENG'], meta: { publishes: [] } };
  assert.deepEqual(rowProblems({ ...EMPTY, ...o }, src), []);
  assert.ok(rowProblems({ ...EMPTY, ...o, gender: 'Girls' }, src).some(p => /gender/.test(p)));
  assert.ok(rowProblems({ ...EMPTY, ...o, sector: 'private', rv: 'A' }, src).some(p => /private/.test(p)));
  assert.ok(rowProblems({ ...EMPTY, ...o, meals: 12.5 }, src).some(p => /mealsKind/.test(p)));
  assert.ok(rowProblems({ ...EMPTY, ...o, religion: 'x' }, src).some(p => /forbidden/.test(p)));
});

test('csv: quotes, separators, encodings, BOM', () => {
  const { header, rows } = parseCsv('﻿a,b\r\n"x, y","he said ""hi"""\n1,2', {});
  assert.deepEqual(header, ['a', 'b']);
  assert.deepEqual(rows, [['x, y', 'he said "hi"'], ['1', '2']]);
  const pipe = parseCsv('1|"A \\| B"|3\n', { sep: '|', header: false });
  assert.deepEqual(pipe.rows[0], ['1', 'A \\| B', '3']);
  const cp = parseCsv(Buffer.from([0x6e, 0x0a, 0x92, 0x0a]), { encoding: 'windows-1252' });   // ’
  assert.equal(cp.rows[0][0], '’');
  assert.deepEqual(records('k,v\n a , b \n'), [{ k: 'a', v: 'b' }]);
});

test('coverage R2: rectangle AND home jurisdiction, backend order', () => {
  const cov = loadCoverage();
  assert.equal(cov.regionFor(51.5, -0.12, 'GB-ENG')?.id, 'uk');
  assert.equal(cov.regionFor(40.73, -74.03, 'US-NJ'), null);          // Hoboken: in the NYC box, not New York State
  assert.equal(cov.regionFor(40.75, -73.98, 'US-NY')?.id, 'nyc');
  assert.equal(cov.regionFor(33.80, -118.20, 'US-CA')?.id, 'longbeach'); // LB before LA in the overlap
  assert.equal(cov.regionFor(19.43, -99.13, 'MX-CMX')?.id, 'mexicocity');
  assert.equal(cov.regionFor(19.55, -99.0, 'MX-MEX'), null);           // Estado de México
  assert.ok(inBox([0, 0, 1, 1], 1, 1));
});

test('where phrase', () => {
  assert.equal(joinAnd(['A']), 'A');
  assert.equal(joinAnd(['A', 'B', 'C']), 'A, B and C');
  const r = (id, country, name, jurisPresent = []) => ({ id, country, name, jurisPresent });
  assert.equal(composeWhere([r('uk', 'gb', 'United Kingdom', ['GB-ENG', 'GB-WLS'])]), 'England and Wales');
  assert.equal(composeWhere([r('uk', 'gb', 'UK', ['GB-ENG', 'GB-WLS', 'GB-NIR']), r('nyc', 'us', 'New York City'), r('chicago', 'us', 'Chicago'),
    r('sf', 'us', 'San Francisco'), r('toronto', 'ca', 'Toronto'), r('mexicocity', 'mx', 'Mexico City')]),
  'England, Wales, Northern Ireland, 3 US cities, Toronto and Mexico City');
});
