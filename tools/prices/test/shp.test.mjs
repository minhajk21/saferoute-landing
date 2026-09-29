// node --test tools/prices/test/
// lib/shp.mjs, offline, over tiny shapefiles built byte by byte here: record
// parsing (Polygon, PolygonZ, Null), ring grouping by winding and containment,
// .dbf field decoding and codepages, deleted rows, the `where` pre-filter, and
// the Lambert Conformal Conic inverse against the EPSG worked example.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readShapefile, readDbf, dbfEncoding, projectionFromPrj, groupRings, ringArea2 } from '../lib/shp.mjs';

// ── fixture writers ─────────────────────────────────────────────────────────
// A ring is written exactly as given; the shapefile spec wants outer rings
// clockwise and holes counter-clockwise, so the fixtures say which they are.
const cw = (w, s, e, n) => [[w, s], [w, n], [e, n], [e, s], [w, s]];           // clockwise square
const ccw = (w, s, e, n) => [[w, s], [e, s], [e, n], [w, n], [w, s]];          // counter-clockwise square

function shpFile(type, records) {
  const bodies = records.map(rec => {
    if (!rec) { const b = Buffer.alloc(4); b.writeInt32LE(0, 0); return b; }
    const pts = rec.flat();
    const xs = pts.map(p => p[0]), ys = pts.map(p => p[1]);
    const z = type === 15;
    const size = 44 + 4 * rec.length + 16 * pts.length + (z ? 32 + 16 * pts.length : 0);
    const b = Buffer.alloc(size);
    b.writeInt32LE(type, 0);
    [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)].forEach((v, i) => b.writeDoubleLE(v, 4 + 8 * i));
    b.writeInt32LE(rec.length, 36); b.writeInt32LE(pts.length, 40);
    let start = 0;
    rec.forEach((ring, i) => { b.writeInt32LE(start, 44 + 4 * i); start += ring.length; });
    let o = 44 + 4 * rec.length;
    for (const [x, y] of pts) { b.writeDoubleLE(x, o); b.writeDoubleLE(y, o + 8); o += 16; }
    if (z) {                                                              // Z range + Z array, M range + M array
      b.writeDoubleLE(0, o); b.writeDoubleLE(99, o + 8); o += 16;
      for (let i = 0; i < pts.length; i++, o += 8) b.writeDoubleLE(99, o);
      b.writeDoubleLE(0, o); b.writeDoubleLE(0, o + 8); o += 16;
      for (let i = 0; i < pts.length; i++, o += 8) b.writeDoubleLE(0, o);
    }
    return b;
  });
  const parts = [];
  bodies.forEach((body, i) => {
    const h = Buffer.alloc(8); h.writeInt32BE(i + 1, 0); h.writeInt32BE(body.length / 2, 4);
    parts.push(h, body);
  });
  const head = Buffer.alloc(100);
  const len = 100 + parts.reduce((s, b) => s + b.length, 0);
  head.writeInt32BE(9994, 0); head.writeInt32BE(len / 2, 24); head.writeInt32LE(1000, 28); head.writeInt32LE(type, 32);
  return Buffer.concat([head, ...parts]);
}

// fields: [name, type, length, decimals]; rows: arrays of Buffers/strings, one
// per field (padded here), or { deleted: true, values }.
function dbfFile(fields, rows, { ldid = 0, encode = s => Buffer.from(s, 'utf8') } = {}) {
  const headLen = 32 + 32 * fields.length + 1;
  const recLen = 1 + fields.reduce((s, f) => s + f[2], 0);
  const head = Buffer.alloc(headLen);
  head[0] = 0x03; head.writeUInt32LE(rows.length, 4); head.writeUInt16LE(headLen, 8); head.writeUInt16LE(recLen, 10); head[29] = ldid;
  fields.forEach(([name, type, len, dec], i) => {
    const p = 32 + 32 * i;
    head.write(name, p, 'latin1'); head.write(type, p + 11, 'latin1'); head[p + 16] = len; head[p + 17] = dec;
  });
  head[headLen - 1] = 0x0d;
  const recs = rows.map(r => {
    const values = Array.isArray(r) ? r : r.values;
    const b = Buffer.alloc(recLen, 0x20);
    if (r.deleted) b[0] = 0x2a;
    let o = 1;
    fields.forEach(([, type, len], i) => {
      const raw = Buffer.isBuffer(values[i]) ? values[i] : encode(String(values[i]));
      if (type === 'N' || type === 'F') raw.copy(b, o + len - raw.length); else raw.copy(b, o);
      o += len;
    });
    return b;
  });
  return Buffer.concat([head, ...recs, Buffer.from([0x1a])]);
}

const FIELDS = [['NAME', 'C', 20, 0], ['VAL', 'N', 10, 2], ['BLANK', 'N', 8, 0], ['OVER', 'N', 4, 0], ['OK', 'L', 1, 0], ['DAY', 'D', 8, 0]];
const row = name => [name, '12.50', '', '****', 'T', '20240131'];

// Five records: a two-part multipolygon with a hole, a Null shape, a lone
// counter-clockwise ring (a hole with no owner), an island in a lake in an
// island, and a square whose .dbf row is deleted.
const RECORDS = [
  [cw(0, 0, 10, 10), ccw(2, 2, 4, 4), cw(20, 0, 22, 2)],
  null,
  [ccw(30, 30, 31, 31)],
  [cw(0, 0, 10, 10), ccw(1, 1, 9, 9), cw(3, 3, 7, 7), ccw(4, 4, 6, 6)],
  [cw(50, 50, 51, 51)],
];
const DBF_ROWS = [row('Montréal'), row('null shape'), row('orphan'), row('nested'), { deleted: true, values: row('gone') }];
const WGS84 = 'GEOGCS["GCS_WGS_1984",DATUM["D_WGS_1984",SPHEROID["WGS_1984",6378137.0,298.257223563]],PRIMEM["Greenwich",0.0],UNIT["Degree",0.0174532925199433]]';

const fixture = (type = 5) => ({
  'x/tracts.shp': shpFile(type, RECORDS),
  'x/tracts.dbf': dbfFile(FIELDS, DBF_ROWS),
  'x/tracts.prj': Buffer.from(WGS84),
  'x/tracts.cpg': Buffer.from('UTF-8'),
});

// ── tests ───────────────────────────────────────────────────────────────────
test('polygon records: rings grouped into polygons, holes kept, RFC 7946 winding', () => {
  const { features, stats, projection } = readShapefile(fixture());
  assert.equal(projection, 'GCS_WGS_1984');
  assert.deepEqual(stats, { records: 5, deleted: 1, nullShapes: 1, skipped: 0, orphanHoles: 1 });
  assert.equal(features.length, 3);

  const [multi, orphan, nested] = features;
  assert.equal(multi.props.NAME, 'Montréal');
  assert.equal(multi.polys.length, 2);
  assert.equal(multi.polys[0].length, 2, 'the hole stays with the outer ring that contains it');
  assert.equal(multi.polys[1].length, 1);
  assert.deepEqual(multi.bbox, [0, 0, 10, 22], 'bbox is [south, west, north, east]');
  for (const [outer, ...holes] of multi.polys) {
    assert.ok(ringArea2(outer) > 0, 'outer ring counter-clockwise');
    for (const h of holes) assert.ok(ringArea2(h) < 0, 'hole clockwise');
  }
  assert.deepEqual(multi.polys[0][0][0], multi.polys[0][0].at(-1), 'rings stay closed');

  assert.equal(orphan.polys.length, 1, 'a hole no outer ring contains is kept as an outer ring');
  assert.ok(ringArea2(orphan.polys[0][0]) > 0);

  // outer 0-10 with lake 1-9; island 3-7 in the lake with its own pond 4-6
  assert.equal(nested.polys.length, 2);
  const byArea = nested.polys.map(p => [Math.abs(ringArea2(p[0])) / 2, p.length]).sort((a, b) => b[0] - a[0]);
  assert.deepEqual(byArea, [[100, 2], [16, 2]], 'each hole goes to the smallest outer ring containing it');
});

test('PolygonZ reads the same x/y as Polygon', () => {
  const a = readShapefile(fixture(5)).features, b = readShapefile(fixture(15)).features;
  assert.deepEqual(b.map(f => f.polys), a.map(f => f.polys));
});

test('.dbf fields decode by type; blank and overflowed numbers are null', () => {
  const { features, fields } = readShapefile(fixture());
  assert.deepEqual(fields.map(f => `${f.name}:${f.type}`), ['NAME:C', 'VAL:N', 'BLANK:N', 'OVER:N', 'OK:L', 'DAY:D']);
  assert.deepEqual(features[0].props, { NAME: 'Montréal', VAL: 12.5, BLANK: null, OVER: null, OK: true, DAY: '2024-01-31' });
});

test('codepage: .cpg first, then the language driver byte, else Windows-1252', () => {
  const cp1252 = dbfFile([['NAME', 'C', 10, 0]], [['Québec']], { ldid: 0x57, encode: s => Buffer.from(s, 'latin1') });
  assert.equal(dbfEncoding(cp1252, null), 'windows-1252');
  assert.equal(readDbf(cp1252, { encoding: dbfEncoding(cp1252, null) }).records[0].NAME, 'Québec');
  assert.equal(dbfEncoding(cp1252, 'UTF-8\r\n'), 'utf-8');
  assert.throws(() => dbfEncoding(cp1252, 'KOI8-R'), /does not know/);
});

test('where() skips records before their geometry is read', () => {
  const { features, stats } = readShapefile(fixture(), { where: p => p.NAME === 'nested' });
  assert.equal(features.length, 1);
  assert.equal(stats.skipped, 2);
});

test('member access: unzip() result, Map, or object; layer picks one .shp', () => {
  const f = fixture();
  const z = { names: Object.keys(f), read: n => f[n] };
  assert.equal(readShapefile(z).features.length, 3);
  assert.equal(readShapefile(new Map(Object.entries(f))).features.length, 3);
  const two = { ...f, 'y/other.shp': f['x/tracts.shp'], 'y/other.dbf': f['x/tracts.dbf'] };
  assert.throws(() => readShapefile(two), /expected one \.shp/);
  assert.equal(readShapefile(two, { layer: 'other' }).features.length, 3);
  const noDbf = { 'a.shp': f['x/tracts.shp'] };
  assert.throws(() => readShapefile(noDbf), /no \.dbf/);
});

test('format drift throws instead of guessing', () => {
  const f = fixture();
  assert.throws(() => readShapefile({ ...f, 'x/tracts.prj': Buffer.from('PROJCS["x",GEOGCS["g",SPHEROID["s",6378137,298.25]],PROJECTION["Transverse_Mercator"]]') }), /not supported/);
  const short = { ...f, 'x/tracts.dbf': dbfFile(FIELDS, DBF_ROWS.slice(0, 4)) };
  assert.throws(() => readShapefile(short), /more records than its \.dbf/);
  const bad = Buffer.from(f['x/tracts.shp']); bad.writeInt32BE(1234, 0);
  assert.throws(() => readShapefile({ ...f, 'x/tracts.shp': bad }), /not a \.shp/);
});

// EPSG Guidance Note 7-2, Lambert Conic Conformal (2SP) worked example:
// NAD27 / Texas South Central, Clarke 1866, US survey feet.
// E 2963503.91 ftUS, N 254759.80 ftUS  <->  28°30'N, 96°00'W.
test('Lambert Conformal Conic inverse matches the EPSG worked example', () => {
  const wkt = 'PROJCS["NAD_1927_Texas_South_Central",GEOGCS["GCS_North_American_1927",DATUM["D_North_American_1927",' +
    'SPHEROID["Clarke_1866",6378206.4,294.9786982]],PRIMEM["Greenwich",0.0],UNIT["Degree",0.0174532925199433]],' +
    'PROJECTION["Lambert_Conformal_Conic"],PARAMETER["False_Easting",2000000.0],PARAMETER["False_Northing",0.0],' +
    'PARAMETER["Central_Meridian",-99.0],PARAMETER["Standard_Parallel_1",28.38333333333333],' +
    'PARAMETER["Standard_Parallel_2",30.28333333333333],PARAMETER["Latitude_Of_Origin",27.83333333333333],UNIT["Foot_US",0.3048006096012192]]';
  const [lng, lat] = projectionFromPrj(wkt).toLngLat(2963503.91, 254759.80);
  assert.ok(Math.abs(lng - -96) < 1e-7, `lng ${lng}`);
  assert.ok(Math.abs(lat - 28.5) < 1e-7, `lat ${lat}`);
});

// Statistics Canada Lambert (EPSG:3347), the projection of every StatCan
// boundary file: checked against an independent forward implementation.
test('Statistics Canada Lambert round-trips', () => {
  const wkt = 'PROJCS["PCS_Lambert_Conformal_Conic",GEOGCS["GCS_North_American_1983",DATUM["D_North_American_1983",' +
    'SPHEROID["GRS_1980",6378137.0,298.257222101]],PRIMEM["Greenwich",0.0],UNIT["Degree",0.0174532925199433]],' +
    'PROJECTION["Lambert_Conformal_Conic"],PARAMETER["False_Easting",6200000.0],PARAMETER["False_Northing",3000000.0],' +
    'PARAMETER["Central_Meridian",-91.86666666666666],PARAMETER["Standard_Parallel_1",49.0],PARAMETER["Standard_Parallel_2",77.0],' +
    'PARAMETER["Latitude_Of_Origin",63.390675],UNIT["Meter",1.0]]';
  const inv = projectionFromPrj(wkt).toLngLat;
  const a = 6378137, f = 1 / 298.257222101, e = Math.sqrt(2 * f - f * f), r = Math.PI / 180;
  const m = p => Math.cos(p) / Math.sqrt(1 - (e * Math.sin(p)) ** 2);
  const t = p => Math.tan(Math.PI / 4 - p / 2) / ((1 - e * Math.sin(p)) / (1 + e * Math.sin(p))) ** (e / 2);
  const n = (Math.log(m(49 * r)) - Math.log(m(77 * r))) / (Math.log(t(49 * r)) - Math.log(t(77 * r)));
  const F = m(49 * r) / (n * t(49 * r) ** n), rho0 = a * F * t(63.390675 * r) ** n;
  const fwd = (lng, lat) => {
    const rho = a * F * t(lat * r) ** n, th = n * (lng - -91.86666666666666) * r;
    return [6200000 + rho * Math.sin(th), 3000000 + rho0 - rho * Math.cos(th)];
  };
  for (const [lng, lat] of [[-79.3832, 43.6532], [-123.1207, 49.2827], [-52.71, 47.56], [-133.72, 68.36]]) {
    const [x, y] = fwd(lng, lat);
    const [lng2, lat2] = inv(x, y);
    assert.ok(Math.abs(lng2 - lng) < 1e-9 && Math.abs(lat2 - lat) < 1e-9, `${lng},${lat} -> ${lng2},${lat2}`);
  }
});

test('groupRings drops degenerate rings', () => {
  const stats = { orphanHoles: 0 };
  assert.deepEqual(groupRings([[[0, 0], [1, 1], [0, 0]], [[0, 0], [1, 1], [2, 2], [0, 0]]], stats), []);
  assert.equal(stats.orphanHoles, 0);
});
