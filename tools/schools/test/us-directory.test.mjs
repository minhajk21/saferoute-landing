// node --test tools/schools/test/
// The US directory sources (sources/ccd.mjs, sources/pss.mjs) and their
// helpers (sources/_nces.mjs), run end to end on small synthetic NCES files so
// every filter, join and label is pinned without touching the network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { crc32, deflateRawSync } from 'node:zlib';
import { unzipEntry, ccdSpan, pssSpan, count, fte, ccdTable, zipInState, positionChecks } from '../sources/_nces.mjs';
import ccd from '../sources/ccd.mjs';
import pss, { RELIGIOUS } from '../sources/pss.mjs';
import { rowProblems } from '../lib/schema.mjs';
import { loadCoverage } from '../lib/coverage.mjs';
import { schemeProblems } from '../lib/modules.mjs';

// A minimal zip writer (deflate), the mirror of _nces.mjs's reader.
function zip(files, { stored = false } = {}) {
  const locals = [], centrals = [];
  let off = 0;
  const method = stored ? 0 : 8;
  for (const [name, text] of Object.entries(files)) {
    const data = Buffer.from(text, 'latin1'), comp = stored ? data : deflateRawSync(data), n = Buffer.from(name);
    const lh = Buffer.alloc(30); lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(method, 8);
    lh.writeUInt32LE(crc32(data) >>> 0, 14); lh.writeUInt32LE(comp.length, 18); lh.writeUInt32LE(data.length, 22); lh.writeUInt16LE(n.length, 26);
    const ch = Buffer.alloc(46); ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(method, 10);
    ch.writeUInt32LE(crc32(data) >>> 0, 16); ch.writeUInt32LE(comp.length, 20); ch.writeUInt32LE(data.length, 24); ch.writeUInt16LE(n.length, 28); ch.writeUInt32LE(off, 42);
    locals.push(lh, n, comp); centrals.push(ch, n);
    off += 30 + n.length + comp.length;
  }
  const cd = Buffer.concat(centrals), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(centrals.length / 2, 8); end.writeUInt16LE(centrals.length / 2, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(off, 16);
  return Buffer.concat([...locals, cd, end]);
}
const csv = (head, rows) => [head.join(','), ...rows.map(r => head.map(h => r[h] ?? '').join(','))].join('\r\n') + '\r\n';

// Coverage limited to Chicago: the synthetic layer has schools nowhere else,
// and the source (rightly) refuses a covered city with no schools at all.
function chicagoOnly() {
  const cov = loadCoverage();
  const regions = cov.regions.filter(r => r.id === 'chicago');
  return { regions, regionFor: (la, lo, j) => { const r = cov.regionFor(la, lo, j); return r?.id === 'chicago' ? r : null; } };
}
function fakeCtx(files) {
  const stats = {}, provenance = [];
  return {
    stats, provenance, log() {}, warn() {}, coverage: chicagoOnly(), snapshot: [], prev: null,
    stat: (k, n = 1) => { stats[k] = (stats[k] || 0) + n; },
    vintage() {},
    async download(file, url) {
      const key = Object.keys(files).find(k => file.startsWith(k));
      if (!key) throw new Error(`unexpected download ${file}`);
      const body = typeof files[key] === 'function' ? files[key](url) : files[key];
      const buf = Buffer.isBuffer(body) ? body : Buffer.from(body);
      provenance.push({ file, url, bytes: buf.length, fetchedAt: '2026-09-27T00:00:00Z' });
      return buf;
    },
  };
}

test('_nces: zip reader reads what it should and refuses a damaged file', () => {
  const z = zip({ 'readme.txt': 'hi', 'data.csv': 'a,b\n1,2\n' });
  assert.equal(unzipEntry(z, /\.csv$/).toString(), 'a,b\n1,2\n');
  assert.throws(() => unzipEntry(z, /\.xlsx$/), /expected one entry/);
  const bad = Buffer.from(z); bad[40] ^= 0xff;         // flip a byte inside the first entry's data
  assert.throws(() => unzipEntry(bad, /readme/), /damaged|CRC/);
  const s = zip({ 'data.csv': 'a,b\n1,2\n' }, { stored: true });
  assert.equal(unzipEntry(s, 'data.csv').toString(), 'a,b\n1,2\n');
  const bad2 = Buffer.from(s); bad2[39] ^= 0x01;       // a stored byte: inflates fine, only the CRC can catch it
  assert.throws(() => unzipEntry(bad2, 'data.csv'), /CRC/);
});

test('_nces: grade spans in US terms, and nothing guessed from one end', () => {
  assert.equal(ccdSpan('PK', '05'), 'PK–5');
  assert.equal(ccdSpan('KG', '08'), 'K–8');
  assert.equal(ccdSpan('09', '12'), '9–12');
  assert.equal(ccdSpan('09', '13'), '9–13');
  assert.equal(ccdSpan('PK', 'PK'), 'PK');
  assert.equal(ccdSpan('UG', 'UG'), 'Ungraded');
  assert.equal(ccdSpan('AE', 'AE'), 'Adult education');
  assert.equal(ccdSpan('M', 'M'), '');
  assert.equal(ccdSpan('N', 'N'), '');
  assert.equal(ccdSpan('KG', 'M'), '');
  assert.equal(pssSpan('2', '13'), 'PK–8');
  assert.equal(pssSpan('3', '17'), 'K–12');
  assert.equal(pssSpan('2', '4'), 'PK–TK');
  assert.equal(pssSpan('1', '1'), 'Ungraded');
  assert.equal(pssSpan('14', '17'), '9–12');
});

test('_nces: NCES missing/suppressed codes are never counts', () => {
  for (const v of [-1, -2, -3, -9, '-1', 0, '', null, undefined, 'M']) { assert.equal(count(v), null); assert.equal(fte(v), null); }
  assert.equal(count('412'), 412);
  assert.equal(fte(23.456), 23.5);
});

test('pss: religious columns are recognised and never read', () => {
  for (const c of ['TYPOLOGY', 'RELIG', 'ORIENT', 'DIOCESE', 'P430', 'P435', 'P440', 'P445', 'P455', 'P492', 'P500', 'P535', 'F_P440', 'F_RELIG']) assert.ok(RELIGIOUS.test(c), c);
  for (const c of ['P335', 'P411', 'P415', 'P425', 'P450', 'P540', 'LEVEL', 'PPIN']) assert.ok(!RELIGIOUS.test(c), c);
});

test('ccd/pss: scheme records are well-formed and every US jurisdiction has its line', () => {
  for (const src of [ccd, pss]) for (const [id, s] of Object.entries(src.schemes)) assert.deepEqual(schemeProblems(id, s), [], id);
  const pending = new Set(ccd.schemes['us-pending'].notes.map(n => n.when.juris));
  for (const j of ccd.juris) assert.ok(pending.has(j) || j === 'US-MO' || j === 'US-MN', `${j} has no rating line`);
  for (const n of ccd.schemes['us-pending'].notes) {
    assert.match(n.html, /href="https:\/\/[^"]+" target="_blank" rel="noopener">Source: /, n.when.juris);
    assert.match(n.html, /not shown on this map yet/, n.when.juris);
  }
  // The ESSA statuses are never worded as ratings.
  for (const j of ['US-NY', 'US-PA']) assert.match(ccd.schemes['us-pending'].notes.find(n => n.when.juris === j).html, /not a rating/);
  assert.match(ccd.schemes['us-pending'].notes.find(n => n.when.juris === 'US-CA').html, /does not give its schools an overall rating/);
});

// ── ccd end to end on a synthetic city ─────────────────────────────────────
// Six schools in the Chicago rectangle (41.6..42.05, -87.95..-87.5) and one
// Indiana school in the same rectangle: only the operating, in-person,
// still-open Illinois ones survive.
const CCD_HEAD = ['NCESSCH', 'LSTATE', 'SCH_NAME', 'LEA_NAME', 'LSTREET1', 'LCITY', 'LZIP', 'SY_STATUS_TEXT', 'SCH_TYPE_TEXT', 'CHARTER_TEXT', 'CHARTAUTHN1', 'GSLO', 'GSHI', 'LEVEL', 'ST_SCHID', 'ST_LEAID', 'LEAID', 'SCHID', 'ST'];
const base = { LSTATE: 'IL', ST: 'IL', LEA_NAME: 'City of Chicago SD 299', LSTREET1: '100 N Main St', LCITY: 'Chicago', LZIP: '60601', SY_STATUS_TEXT: 'Open', SCH_TYPE_TEXT: 'Regular School', CHARTER_TEXT: 'No', GSLO: 'PK', GSHI: '08', LEVEL: 'Elementary' };
const SCHOOLS = [
  { NCESSCH: '170993000001', SCH_NAME: 'Kept Elementary', ST_SCHID: 'IL-15-016-2990-25-0001', ...base },
  { NCESSCH: '170993000002', SCH_NAME: 'Kept Charter High', ST_SCHID: 'IL-15-016-2990-25-0002', ...base, CHARTER_TEXT: 'Yes', CHARTAUTHN1: 'CHICAGO PUBLIC SCHOOLS DISTRICT 299', GSLO: '09', GSHI: '12', LEVEL: 'High' },
  { NCESSCH: '170993000003', SCH_NAME: 'Future School', ...base, SY_STATUS_TEXT: 'Future' },
  { NCESSCH: '170993000004', SCH_NAME: 'Online Academy', ...base },
  { NCESSCH: '170993000005', SCH_NAME: 'Closed Next Year', ...base },
  { NCESSCH: '180001000006', SCH_NAME: 'Hammond Indiana School', ...base, LSTATE: 'IN', ST: 'IN', LZIP: '46320' },
];
const POINTS = { '170993000001': [41.88, -87.63], '170993000002': [41.9, -87.65], '170993000003': [41.8, -87.6], '170993000004': [41.85, -87.7], '170993000005': [41.95, -87.7], '180001000006': [41.62, -87.52] };
function arcgis(url) {
  const q = new URL(url).searchParams;
  if (!q.get('geometry')) return JSON.stringify({ editingInfo: { dataLastEditDate: 1783000000000 } });
  const [w, s, e, n] = q.get('geometry').split(',').map(Number);
  const features = Object.entries(POINTS).filter(([, [la, lo]]) => la >= s && la <= n && lo >= w && lo <= e).map(([id, [la, lo]]) => ({
    attributes: { NCESSCH: id, SURVYEAR: '2024-2025', LSTATE: `${id.startsWith('18') ? 'IN' : 'IL'} `, MEMBER: id.endsWith('1') ? 400 : -2, FTE: id.endsWith('1') ? 25.04 : -1,
      TOTFRL: id.endsWith('1') ? 300 : -9, DIRECTCERT: -1, LATCOD: la, LONCOD: lo },
  }));
  return JSON.stringify({ features, exceededTransferLimit: false });
}
function ccdFiles(extra = {}) {
  return {
    'arcgis-': url => arcgis(url),
    'ccd_sch_029_2425': zip({ 'ccd_sch_029_2425_w_1a_073025.csv': csv(CCD_HEAD, SCHOOLS) }),
    'ccd_sch_129_2425': zip({ 'ccd_sch_129_2425_w_1a_073025.csv': csv(['NCESSCH', 'VIRTUAL', 'VIRTUAL_TEXT'], SCHOOLS.map(s => ({ NCESSCH: s.NCESSCH, ...(s.NCESSCH.endsWith('4') ? { VIRTUAL: 'FULLVIRTUAL', VIRTUAL_TEXT: 'Exclusively virtual' } : { VIRTUAL: 'NOTVIRTUAL', VIRTUAL_TEXT: 'No virtual instruction' }) }))) }),
    'ccd_sch_029_2526': zip({ 'ccd_sch_029_2526_w_0a_050626.csv': csv(['NCESSCH', 'LSTATE', 'LSTREET1', 'LZIP', 'SY_STATUS_TEXT'], [
      // school 2 is listed at a new address for 2025-26; school 1's differs only in spelling
      ...SCHOOLS.map(s => ({ NCESSCH: s.NCESSCH, LSTATE: s.LSTATE, LSTREET1: s.NCESSCH.endsWith('2') ? '35 Starr St' : '100 North Main Street', LZIP: s.LZIP, SY_STATUS_TEXT: s.NCESSCH.endsWith('5') ? 'Closed' : 'Open' })),
      { NCESSCH: '170993000099', LSTATE: 'IL', LZIP: '60601', SY_STATUS_TEXT: 'New' },          // new in 2025-26, no point yet
    ]) }),
    ...extra,
  };
}

test('ccd: status, virtual, closure and state filters; fields as published', async () => {
  const ctx = fakeCtx(ccdFiles());
  const rows = await ccd.fetch(ctx);
  assert.deepEqual(rows.map(r => r.id), ['170993000001', '170993000002']);
  assert.equal(ctx.stats['dropped.notOperating'], 1);
  assert.equal(ctx.stats['dropped.exclusivelyVirtual'], 1);
  assert.equal(ctx.stats['dropped.closed2025-26'], 1);
  assert.equal(ctx.stats['dropped.otherState'], 1);
  assert.equal(ctx.stats['unmapped.new2025-26NoLocationYet'], 1);
  for (const r of rows) assert.deepEqual(rowProblems(r, ccd), [], r.id);
  const [a, b] = rows;
  assert.equal(a.juris, 'US-IL'); assert.equal(a.sector, 'state'); assert.equal(a.stage, 'Primary'); assert.equal(a.span, 'PK–8');
  assert.equal(a.pupils, 400); assert.equal(a.teachers, 25); assert.equal(a.meals, 75); assert.equal(a.mealsKind, 'frl');
  assert.equal(a.tags, ''); assert.equal(a.trust, ''); assert.equal(a.ratingScheme, 'us-pending');
  assert.equal(b.tags, 'charter new-address-2025-26'); assert.equal(ctx.stats['flagged.newAddress2025-26'], 1); assert.equal(b.trust, 'CHICAGO PUBLIC SCHOOLS DISTRICT 299'); assert.equal(b.stage, 'Secondary');
  assert.equal(b.pupils, null); assert.equal(b.teachers, null); assert.equal(b.meals, null); assert.equal(b.mealsKind, '');
  // ~27 query pages collapse to ONE provenance record for the layer.
  assert.equal(ctx.provenance.filter(p => /^arcgis-/.test(p.file)).length, 0);
  assert.equal(ctx.provenance[0].url.endsWith('/FeatureServer/1'), true);
});

test('ccd: refuses to join two different NCES years, and an ArcGIS error body', async () => {
  const wrongYear = url => arcgis(url).replace(/2024-2025/g, '2025-2026');
  await assert.rejects(ccd.fetch(fakeCtx(ccdFiles({ 'arcgis-': wrongYear }))), /SURVYEAR 2025-2026/);
  const error = url => (new URL(url).searchParams.get('geometry') ? JSON.stringify({ error: { code: 400, message: 'Invalid query' } }) : arcgis(url));
  await assert.rejects(ccd.fetch(fakeCtx(ccdFiles({ 'arcgis-': error }))), /Invalid query/);
});

// ── pss end to end ─────────────────────────────────────────────────────────
test('pss: drops home-based, virtual-only and cross-state; never carries religion', async () => {
  const head = ['PPIN', 'PINST', 'PCITY', 'PSTABB', 'PZIP', 'PL_CIT', 'PL_STABB', 'PL_ZIP', 'LATITUDE24', 'LONGITUDE24', 'LEVEL', 'LOGR2024', 'HIGR2024',
    'NUMSTUDS', 'NUMTEACH', 'P335', 'P415', 'P411', 'P425', 'TYPOLOGY', 'RELIG', 'ORIENT', 'DIOCESE', 'P430', 'P440'];
  const rel = { TYPOLOGY: '1', RELIG: '1', ORIENT: '5', DIOCESE: 'CHICAGO', P430: '1', P440: '5' };
  const b = { PCITY: 'CHICAGO', PSTABB: 'IL', PZIP: '60614', LEVEL: '1', LOGR2024: '2', HIGR2024: '13', NUMSTUDS: '210', NUMTEACH: '18.5', P335: '2', P415: '1', P411: '1', P425: '2', ...rel };
  const rows = [
    { PPIN: 'A0000001', PINST: 'ST EXAMPLE ACADEMY', LATITUDE24: '41.92', LONGITUDE24: '-87.65', ...b },
    { PPIN: 'A0000002', PINST: 'HOME SCHOOL', LATITUDE24: '41.93', LONGITUDE24: '-87.66', ...b, P425: '1' },
    { PPIN: 'A0000003', PINST: 'ONLINE ONLY', LATITUDE24: '41.94', LONGITUDE24: '-87.67', ...b, P411: '2' },
    { PPIN: 'A0000004', PINST: 'INDIANA SCHOOL', LATITUDE24: '41.62', LONGITUDE24: '-87.52', ...b, PSTABB: 'IN' },
    // mailing address in Indiana, school physically in Illinois: judged by location
    { PPIN: 'A0000005', PINST: 'LOCATED IN IL', LATITUDE24: '41.8', LONGITUDE24: '-87.6', ...b, PSTABB: 'IN', PL_STABB: 'IL', PL_CIT: 'CHICAGO', PL_ZIP: '60615', LEVEL: '3', P335: '1' },
  ];
  // pad to a national-sized file so the short-read guard is satisfied
  const filler = Array.from({ length: 15000 }, (_, i) => ({ PPIN: `Z${i}`, PINST: 'FAR AWAY', LATITUDE24: '45.5', LONGITUDE24: '-100.1', ...b }));
  const ctx = fakeCtx({ 'pss2324_pu_csv.zip': zip({ 'pss2324_pu.csv': csv(head, [...rows, ...filler]) }) });
  const out = await pss.fetch(ctx);
  assert.deepEqual(out.map(r => r.id), ['A0000001', 'A0000005']);
  assert.equal(ctx.stats['dropped.homeBased'], 1);
  assert.equal(ctx.stats['dropped.noInPersonClasses'], 1);
  assert.equal(ctx.stats['dropped.otherState'], 1);
  for (const r of out) assert.deepEqual(rowProblems(r, pss), [], r.id);
  const [x, y] = out;
  assert.equal(x.gender, 'Girls'); assert.equal(x.span, 'PK–8'); assert.equal(x.stage, 'Primary'); assert.equal(x.pupils, 210); assert.equal(x.teachers, 18.5);
  assert.equal(x.sector, 'private'); assert.equal(x.ratingScheme, 'us-private'); assert.equal(x.rv ?? '', '');
  assert.equal(y.juris, 'US-IL'); assert.equal(y.postcode, '60615'); assert.equal(y.gender, 'Mixed'); assert.equal(y.stage, 'Secondary');
  // Nothing religious reached a row: no such key, and no value from those columns.
  for (const r of out) {
    for (const k of Object.keys(r)) assert.ok(!RELIGIOUS.test(k) && !/relig|orient|dioc|typolog/i.test(k), k);
    assert.ok(!Object.values(r).includes('CHICAGO') || r.area === 'CHICAGO', 'the DIOCESE value leaked');
  }
});

test('ccd: the directory helper exposes ST_SCHID for the rating modules', () => {
  const z = zip({ 'x.csv': csv(CCD_HEAD, SCHOOLS) });
  const m = ccdTable(z, ['NCESSCH', 'ST_SCHID'], 'x');
  assert.equal(m.get('170993000001').ST_SCHID, 'IL-15-016-2990-25-0001');
  assert.throws(() => ccdTable(z, ['NCESSCH', 'NOPE'], 'x'), /missing column/);
});

test('_nces: a ZIP from another state is recognised as damaged', () => {
  assert.equal(zipInState('02184', 'US-MA'), true);
  assert.equal(zipInState('21841', 'US-MA'), false);      // PSS: Braintree with its leading zero lost
  assert.equal(zipInState('20001', 'US-DC'), true);
  assert.equal(zipInState('20166', 'US-DC'), false);      // 201 is Dulles, Virginia
  assert.equal(zipInState('75208', 'US-TX'), true);
  assert.equal(zipInState('', 'US-TX'), false);
  assert.throws(() => zipInState('07030', 'US-NJ'), /no ZIP prefixes/);
});

test('_nces: position check passes a sound set and fails a shifted one', async () => {
  const haversine = (a, b, c, d) => { const R = 6371000, t = x => x * Math.PI / 180; const h = Math.sin(t(c - a) / 2) ** 2 + Math.cos(t(a)) * Math.cos(t(c)) * Math.sin(t(d - b) / 2) ** 2; return 2 * R * Math.asin(Math.sqrt(h)); };
  const zcta = new Map([['60601', { lat: 41.886, lng: -87.622, radius: 1000 }]]);
  const good = Array.from({ length: 40 }, (_, i) => ({ juris: 'US-IL', postcode: '60601', name: `s${i}`, lat: 41.886 + (i % 10 - 5) * 0.0008, lng: -87.622 }));
  const [ok] = await positionChecks(good, { haversine, zcta }, 't');
  assert.equal(ok.pass, true, ok.message);
  const shifted = good.map(r => ({ ...r, lat: r.lat + 0.1 }));        // every pin ~11 km out
  const [bad] = await positionChecks(shifted, { haversine, zcta }, 't');
  assert.equal(bad.pass, false, bad.message);
  const unresolved = good.map(r => ({ ...r, postcode: '99999' }));
  const [none] = await positionChecks(unresolved, { haversine, zcta }, 't');
  assert.equal(none.pass, false);
});
