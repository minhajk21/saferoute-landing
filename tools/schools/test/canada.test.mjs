// node --test tools/schools/test/
// The Canada lane (sources/on-sif.mjs, on-priv.mjs, bc.mjs), offline: the
// zero-dependency .xlsx reader, the helpers, the point-vs-address check, the
// BC level/enrolment logic, and each module's fetch() end to end over tiny
// synthetic fixtures served by a fake ctx (no network).
import test from 'node:test';
import assert from 'node:assert/strict';
import { deflateRawSync } from 'node:zlib';
import onSif, { readXlsx, sheetRecords, excelDate, fmtPostal, cityName, coarsePoint, spanOf, normName, locationDoubts, fsaOf } from '../sources/on-sif.mjs';
import onPriv from '../sources/on-priv.mjs';
import bc, { enrolmentBySchool, levelOf } from '../sources/bc.mjs';
import { rowProblems } from '../lib/schema.mjs';
import { loadSources, schemeProblems } from '../lib/modules.mjs';
import { loadCoverage } from '../lib/coverage.mjs';

// ── a minimal .xlsx writer for fixtures ─────────────────────────────────────
function zip(files) {
  const locals = [], centrals = [];
  let off = 0;
  for (const [name, text, deflate] of files) {
    const raw = Buffer.from(text, 'utf8'), data = deflate ? deflateRawSync(raw) : raw, nm = Buffer.from(name);
    const lh = Buffer.alloc(30); lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(deflate ? 8 : 0, 8);
    lh.writeUInt32LE(data.length, 18); lh.writeUInt32LE(raw.length, 22); lh.writeUInt16LE(nm.length, 26);
    const ch = Buffer.alloc(46); ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(deflate ? 8 : 0, 10);
    ch.writeUInt32LE(data.length, 20); ch.writeUInt32LE(raw.length, 24); ch.writeUInt16LE(nm.length, 28); ch.writeUInt32LE(off, 42);
    locals.push(lh, nm, data); centrals.push(ch, nm); off += 30 + nm.length + data.length;
  }
  const cd = Buffer.concat(centrals), eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(files.length, 8); eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(cd.length, 12); eocd.writeUInt32LE(off, 16);
  return Buffer.concat([...locals, cd, eocd]);
}
const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;');
const col = i => { let s = ''; for (i++; i; i = Math.floor((i - 1) / 26)) s = String.fromCharCode(65 + (i - 1) % 26) + s; return s; };
// rows: arrays of strings (shared strings) or numbers (numeric cells); '' = no cell
function xlsx(sheetName, rows) {
  const ss = [], idx = new Map();
  const si = v => { if (!idx.has(v)) { idx.set(v, ss.length); ss.push(v); } return idx.get(v); };
  const body = rows.map((r, y) => `<row r="${y + 1}">${r.map((v, x) => v === '' ? '' : typeof v === 'number'
    ? `<c r="${col(x)}${y + 1}"><v>${v}</v></c>` : `<c r="${col(x)}${y + 1}" t="s"><v>${si(v)}</v></c>`).join('')}</row>`).join('');
  return zip([
    ['xl/workbook.xml', `<workbook xmlns:r="r"><sheets><sheet name="${esc(sheetName)}" sheetId="1" r:id="rId1"/></sheets></workbook>`, false],
    ['xl/_rels/workbook.xml.rels', '<Relationships><Relationship Id="rId1" Type="t" Target="worksheets/sheet1.xml"/></Relationships>', false],
    ['xl/sharedStrings.xml', `<sst>${ss.map(s => `<si><t>${esc(s)}</t></si>`).join('')}</sst>`, true],
    ['xl/worksheets/sheet1.xml', `<worksheet><sheetData>${body}</sheetData></worksheet>`, true],
  ]);
}

test('xlsx: shared, rich-text and inline strings, sparse cells, entities, stored + deflated entries', () => {
  const buf = zip([
    ['xl/workbook.xml', '<workbook><sheets><sheet name="A &amp; B" sheetId="1" r:id="rId7"/></sheets></workbook>', false],
    ['xl/_rels/workbook.xml.rels', '<Relationships><Relationship Id="rId7" Target="/xl/worksheets/sheet9.xml"/></Relationships>', false],
    ['xl/sharedStrings.xml', '<sst><si><t>École</t></si><si><r><t>St </t></r><r><t xml:space="preserve">Mary&apos;s</t></r><rPh><t>x</t></rPh></si><si/></sst>', true],
    ['xl/worksheets/sheet9.xml', '<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="C1" t="s"><v>1</v></c></row>' +
      '<row r="2"/><row r="3"><c r="B3" t="inlineStr"><is><t>M6A&#x20;3M7</t></is></c><c r="AA3"><v>46.534770000000002</v></c><c r="AB3" s="2"/></row></sheetData></worksheet>', true],
  ]);
  const b = readXlsx(buf);
  assert.deepEqual(b.sheets, ['A & B']);
  const rows = b.rows();
  assert.deepEqual(rows[0], ['École', '', "St Mary's"]);
  assert.deepEqual(rows[1], []);
  assert.equal(rows[2][1], 'M6A 3M7');
  assert.equal(rows[2][26], '46.534770000000002');
  assert.throws(() => b.rows('nope'), /no sheet "nope"/);
});

test('helpers: records need their columns; formats', () => {
  assert.throws(() => sheetRecords([['A', 'B'], ['1', '2']], ['A', 'C'], 'fixture'), /missing column\(s\) "C"/);
  assert.deepEqual(sheetRecords([['A ', 'B'], ['1', ' 2 '], ['', '']], ['A', 'B'], 'f'), [{ A: '1', B: '2' }]);
  assert.equal(excelDate('46220'), '2026-07-17');
  assert.equal(fmtPostal('m6a3m7'), 'M6A 3M7');
  assert.equal(fmtPostal(''), '');
  assert.equal(cityName('NORTH YORK'), 'North York');
  assert.equal(cityName('Richmond hill'), 'Richmond hill');   // mixed case is left as published
  assert.equal(spanOf('JK-8'), 'JK–8');
  assert.equal(coarsePoint('43.65', '-79.42'), true);
  assert.equal(coarsePoint('43.649999999999999', '-79.420000000000002'), true);
  assert.equal(coarsePoint('43.717489999999998', '-79.44'), false);           // one short axis = real point ending in zeros
  assert.equal(normName('St. Thomas More Catholic School'), normName('ST THOMAS MORE'));
  assert.equal(normName('École élémentaire Mathieu-da-Costa'), normName('ECOLE ELEMENTAIRE MATHIEU DA COSTA'));
  assert.equal(fsaOf('k8v 2j2'), 'K8V');
});

test('locationDoubts: far from its postal district, and shared placeholder points', () => {
  const ref = [
    { id: 'p1', postcode: 'M3H 1M1', lat: 43.745, lng: -79.44 },   // North York
    { id: 'p2', postcode: 'K8V 5P4', lat: 44.10, lng: -77.58 },    // Trenton
    { id: 'p3', postcode: 'M4V 1A1', lat: 43.686, lng: -79.40 },
    { id: 'p4', postcode: 'M9R 1A1', lat: 43.68, lng: -79.56 },
  ];
  const rows = [
    { id: 'ok', postcode: 'M3H 5A1', lat: 43.75, lng: -79.44 },
    { id: 'trenton', postcode: 'K8V 2J2', lat: 43.74414, lng: -79.4353 },  // 150 km from Trenton
    { id: 'nofsa', postcode: '', lat: 43.74414, lng: -79.4353 },
    { id: 'unknownfsa', postcode: 'L0J 1C0', lat: 43.74414, lng: -79.4353 },
    // three schools, three postal districts, one point
    { id: 'c1', postcode: 'M4V 2W6', lat: 43.65107, lng: -79.34701 },    // ~5.2 km from M4V
    { id: 'c2', postcode: 'M9R 2Y8', lat: 43.65107, lng: -79.34701 },    // ~17 km from M9R
    { id: 'c3', postcode: 'M3H 9Z9', lat: 43.65107, lng: -79.34701 },    // ~11 km from M3H
  ];
  const d = locationDoubts(rows, ref);
  const by = id => d.get(rows.find(r => r.id === id))?.reason;
  assert.equal(by('ok'), undefined);
  assert.equal(by('trenton'), 'unmapped.pointConflictsWithAddress');
  assert.equal(by('nofsa'), undefined);          // no evidence either way
  assert.equal(by('unknownfsa'), undefined);
  assert.equal(by('c1'), 'unmapped.sharedPlaceholderPoint');
  assert.equal(by('c2'), 'unmapped.sharedPlaceholderPoint');
  assert.equal(by('c3'), 'unmapped.sharedPlaceholderPoint');
  // the same far-ish point shared by only two schools is NOT a placeholder
  const two = [rows[4], rows[5]].map(r => ({ ...r }));
  assert.equal(locationDoubts(two, ref).size, 0);
});

test('bc: enrolment span/total/mask, and the level the enrolment count contradicts', () => {
  const E = (g, n, s = '03939001') => ({ SCHOOL_YEAR: '2025/2026', DATA_LEVEL: 'School Level', SCHOOL_NUMBER: s, GRADE: g, TOTAL_ENROLMENT: n });
  const m = enrolmentBySchool([E('08', '117'), E('12', 'Msk'), E('All Secondary', '623'), E('All Grades', '623'), E('Graduated Adult', '40'),
    E('KF', '20', 'x'), E('07', '30', 'x'), E('All Grades', 'Msk', 'y'), E('03', 'Msk', 'y'), { ...E('KF', '99', 'x'), SCHOOL_YEAR: '2024/2025' }], '2025/2026');
  assert.deepEqual({ ...m.get('03939001') }, { total: 623, masked: false, lo: 8, hi: 12, span: '8–12' });
  assert.equal(m.get('x').span, 'K–7');
  assert.equal(m.get('y').total, null); assert.equal(m.get('y').masked, true); assert.equal(m.get('y').span, '3');
  assert.deepEqual(levelOf('Elementary', { lo: 8, hi: 12 }), { level: 'Secondary', fixed: 'elementaryButGrades8to12' });
  assert.deepEqual(levelOf('Elementary', { lo: 0, hi: 8 }), { level: 'Elementary', fixed: null });   // a K–8 stays as published
  assert.deepEqual(levelOf('Secondary', { lo: 0, hi: 7 }), { level: 'Elementary', fixed: 'secondaryButGradesKto7' });
  assert.deepEqual(levelOf('Middle School', { lo: 6, hi: 7 }), { level: 'Middle School', fixed: null });
  assert.deepEqual(levelOf('Elementary', undefined), { level: 'Elementary', fixed: null });
});

test('modules: discovered, contract-valid, licence statements verbatim, no rating on private rows', async () => {
  const all = await loadSources();
  for (const id of ['on-sif', 'on-priv', 'bc']) assert.ok(all.some(s => s.id === id), `${id} discovered`);
  for (const s of [onSif, onPriv, bc]) for (const [k, sc] of Object.entries(s.schemes)) assert.deepEqual(schemeProblems(k, sc), []);
  assert.match(onSif.meta.attribution, /Contains information licensed under the Open Government Licence – Ontario\.$/);
  assert.match(onPriv.meta.attribution, /Contains information licensed under the Open Government Licence – Ontario\.$/);
  assert.match(bc.meta.attribution, /Contains information licensed under the Open Government Licence – British Columbia\.$/);
  // "no single school rating" wording, and the Ministry's no-endorsement caveat on every private note
  assert.match(onSif.schemes['ca-on-none'].notes[0].html, /Ontario publishes no single school rating/);
  assert.match(bc.schemes['ca-bc-none'].notes[0].html, /British Columbia publishes no single school rating/);
  for (const n of onPriv.schemes['ca-on-private'].notes) assert.match(n.html, /does not license, accredit or endorse private schools/);
});

// ── each fetch() end to end, over fixtures, through a fake ctx ──────────────
function fakeCtx(files, { snapshot = [], refresh = false } = {}) {
  const stats = {}, warnings = [];
  return {
    ctx: {
      coverage: loadCoverage(), snapshot, refresh, prev: null, provenance: [],
      download: async file => { if (!files[file]) throw new Error(`fixture ${file} missing`); return files[file]; },
      stat: (k, n = 1) => { stats[k] = (stats[k] || 0) + n; }, vintage: v => { stats.vintage = v; },
      log: () => {}, warn: m => warnings.push(m),
    },
    stats, warnings,
  };
}
const SIF_HEAD = ['Board Name', 'School Number', 'School Name', 'School Type', 'School Special Condition Code', 'School Level', 'School Language',
  'Grade Range', 'City', 'Province', 'Postal Code', 'Enrolment', 'Latitude', 'Longitude', 'Extract Date'];
const sifRow = (o) => SIF_HEAD.map(h => o[h] ?? '');
const SIF = xlsx('SIF_Final_24-25_EN', [SIF_HEAD,
  sifRow({ 'Board Name': 'Toronto DSB', 'School Number': '019704', 'School Name': 'Anson Park Public School', 'School Type': 'Public', 'School Special Condition Code': 'Not applicable',
    'School Level': 'Elementary', 'School Language': 'English', 'Grade Range': 'JK-8', City: 'Scarborough', Province: 'Ontario', 'Postal Code': 'M1M1X5', Enrolment: '250',
    Latitude: 43.72612, Longitude: -79.241, 'Extract Date': 46220 }),
  sifRow({ 'Board Name': 'Toronto DSB', 'School Number': '901908', 'School Name': 'ALPHA II Alternative School', 'School Type': 'Public', 'School Special Condition Code': 'Alternative',
    'School Level': 'Secondary', 'School Language': 'English', 'Grade Range': '9-12', City: 'NORTH YORK', Province: 'Ontario', 'Postal Code': 'M3L1V5', Enrolment: 'SP',
    Latitude: 43.7379, Longitude: -79.50358, 'Extract Date': 46220 }),
  sifRow({ 'Board Name': 'Algoma DSB', 'School Number': '019186', 'School Name': 'Anna McCrea Public School', 'School Type': 'Public', 'School Special Condition Code': 'Not applicable',
    'School Level': 'Elementary', 'School Language': 'English', 'Grade Range': 'JK-8', City: 'Sault Ste Marie', Province: 'Ontario', 'Postal Code': 'P6A3M7', Enrolment: '295',
    Latitude: 46.50593, Longitude: -84.2873, 'Extract Date': 46220 }),
  sifRow({ 'Board Name': 'TVO', 'School Number': '992038', 'School Name': 'TVO/Independent Learning Centre', 'School Type': 'Public', 'School Special Condition Code': 'Continuing Education',
    'School Level': 'Secondary', 'School Language': 'English', City: 'TORONTO', Province: 'Ontario', Enrolment: 'NA', 'Extract Date': 46220 }),
]);

test('on-sif fetch: rows, stages, suppressed enrolment, scope, drops', async () => {
  const { ctx, stats } = fakeCtx({ 'sif-en.xlsx': SIF });
  const rows = await onSif.fetch(ctx);
  assert.deepEqual(rows.map(r => r.id), ['019704', '901908']);
  for (const r of rows) assert.deepEqual(rowProblems(r, onSif), []);
  const [a, b] = rows;
  assert.equal(a.stage, 'Primary'); assert.equal(a.span, 'JK–8'); assert.equal(a.pupils, 250); assert.equal(a.pupilsAsOf, '2024-25');
  assert.equal(a.type, 'Public · English'); assert.equal(a.la, 'Toronto DSB'); assert.equal(a.postcode, 'M1M 1X5');
  assert.equal(b.stage, 'Secondary'); assert.equal(b.pupils, null); assert.equal(b.type, 'Public · English · Alternative'); assert.equal(b.area, 'North York');
  assert.equal(stats['dropped.outsideScope'], 1); assert.equal(stats['dropped.continuingEducation'], 1); assert.equal(stats['noEnrolment.SP'], 1);
  assert.match(stats.vintage, /^2024-25 final table \(Ministry extract 2026-07-17\)$/);
});

test('on-priv fetch: left join, OSSD tags, extra sites, online and coarse drops, address check', async () => {
  const LOC_HEAD = ['NOI Year', 'School Main Location Flag', 'School Number', 'School Name', 'School Level Code', 'School Level', 'School Special Condition Type Code',
    'School Special Condition Type ', 'Latitude', 'Longitude', 'City', 'Postal Code', 'Province', 'Program Type'];
  const L = (flag, num, name, level, cond, lat, lng, city, pc, prog) => ['2025-2026', flag, num, name, '1', level, '0', cond, lat, lng, city, pc, 'ON', prog];
  const loc = xlsx('Private School Location List', [LOC_HEAD,
    L('T', '887315', 'Associated Hebrew Schools of Toronto', 'Elementary', 'Not applicable', 43.731398, -79.434293, 'Toronto', 'M6A1X1', 'Site based only'),
    L('F', '887315', 'Associated Hebrew Schools of Toronto', 'Elementary', 'Not applicable', 43.775315, -79.438499, 'Toronto', 'M2R1M9', 'Site based only'),
    L('T', '669998', 'Blyth Academy Lawrence Park', 'Secondary', 'All Year Round', 43.71602, -79.40279, 'Toronto', 'M4P2J5', 'Site based only'),
    L('T', '665932', 'Cossara Summers Education Centre', 'Secondary', 'Summer', 43.78047, -79.41567, 'North York', 'M3H5A1', 'Online/Site Based'),
    L('T', '883420', 'Hillcrest Progressive School', 'Elementary', 'Not applicable', 43.74053, -79.39776, 'Toronto', 'M2P1A2', 'Site based only'),
    L('T', '669642', 'The Orchard Montessori School Ltd. (Elem', 'Elementary', 'Not applicable', 43.65, -79.42, 'Toronto', 'M6J3E5', 'Site based only'),
    L('T', '881644', "ASIM'SCHOOL", 'Secondary', 'All Year Round', 43.79, -79.23, 'Toronto', 'M1S4L8', 'Online Only'),
    L('T', '669949', 'Trenton Collegiate Institute', 'Secondary', 'All Year Round', 43.74414, -79.4353, 'Trenton', 'K8V2J2', 'Online/Site Based'),
    L('T', '700001', 'New Wording School', 'Secondary', 'Not applicable', 43.71103, -79.40011, 'Toronto', 'M4P1B2', 'Site based only'),
  ]);
  const contacts = Buffer.from([
    'School Name,School Number,OSSD Credits Offered,Principal Name',
    'Associated Hebrew Schools of Toronto,887315,,A',
    'Blyth Academy Lawrence Park,669998,Offers credits toward the Ontario Secondary School Diploma (OSSD),B',
    'Cossara Summers Education Centre,665932,Applied to offer credits toward the Ontario secondary School Diploma (OSSD),C',
    'Trenton Collegiate Institute,669949,Offers credits toward the Ontario Secondary School Diploma (OSSD),D',
    'New Wording School,700001,May offer OSSD credits from 2027,E',
  ].join('\r\n'), 'latin1');
  // reference public schools for the address check: one in M3H/M2P/M6A/M4P/M2R, one in Trenton (K8V)
  const ref = xlsx('SIF_Final_24-25_EN', [SIF_HEAD, ...[['100001', 'M3H1M1', 43.745, -79.44], ['100002', 'M2P1B1', 43.745, -79.40], ['100003', 'M6A1A1', 43.73, -79.44],
    ['100004', 'M4P1A1', 43.71, -79.40], ['100005', 'M2R1A1', 43.77, -79.44], ['100006', 'K8V5P4', 44.10, -77.58]]
    .map(([n, pc, lat, lng]) => sifRow({ 'School Number': n, 'School Name': n, 'School Level': 'Elementary', Province: 'Ontario', 'Postal Code': pc, Latitude: lat, Longitude: lng, 'Extract Date': 46220 }))]);
  const { ctx, stats, warnings } = fakeCtx({ 'private-school-location-list-en.xlsx': loc, 'private-school-contact-information-eng.csv': contacts, 'sif-en.xlsx': ref });
  const rows = await onPriv.fetch(ctx);
  for (const r of rows) assert.deepEqual(rowProblems(r, onPriv), []);
  const by = Object.fromEntries(rows.map(r => [r.id, r]));
  assert.deepEqual(Object.keys(by).sort(), ['665932', '669998', '700001', '883420', '887315', '887315 (location 2)']);
  assert.equal(by['700001'].tags, 'ossd-unread');                  // new wording: reported, never guessed
  assert.ok(warnings.some(w => /unrecognised OSSD wording/.test(w)));
  assert.equal(by['887315'].postcode, 'M6A 1X1');                 // the main site keeps the bare number
  assert.equal(by['887315 (location 2)'].postcode, 'M2R 1M9');
  assert.equal(by['887315'].tags, '');                             // in the contact list, OSSD blank
  assert.equal(by['669998'].tags, 'ossd');
  assert.equal(by['665932'].tags, 'ossd-applied');
  assert.equal(by['883420'].tags, 'ossd-unknown');                 // not in the contact list: kept (left join)
  assert.equal(by['669998'].type, 'Private school · All Year Round');
  assert.equal(by['665932'].type, 'Private school · Summer · Online/Site Based');
  assert.ok(rows.every(r => r.sector === 'private' && !r.rv));
  assert.equal(stats['dropped.onlineOnly'], 1); assert.equal(stats['unmapped.coarseLocation'], 1);
  assert.equal(stats['unmapped.pointConflictsWithAddress'], 1);    // the Trenton school drawn in North York
  assert.equal(stats['additionalLocations'], 1);
  // the pane's note is picked by row.tags, first match wins
  const note = r => onPriv.schemes['ca-on-private'].notes.find(n => Object.entries(n.when || {}).every(([k, v]) => r[k] === v)).html;
  assert.match(note(by['669998']), /^<b>Offers credits/);
  assert.match(note(by['665932']), /^<b>Applied to offer/);
  assert.match(note(by['883420']), /^This school is not in the Ministry/);
  assert.match(note(by['887315']), /not listed as offering credits/);
  assert.match(note(by['700001']), /wording this map does not yet recognise/);
});

test('bc fetch: drops, unmapped count, enrolment join, level fix, year pinned to the published one', async () => {
  const H = 'SCHOOL_YEAR,MINCODE,SCHOOL_NAME,DISTRICT_NUMBER,DISTRICT_NAME,PUBLIC_OR_INDEPENDENT,STREET_ADDRESS,PHYSICAL_ADDRESS_CITY,ADDRESS_POSTAL_CODE,FACILITY_TYPE,SCHOOL_EDUCATION_LEVEL,HAS_CORE_FRENCH,HAS_EARLY_FRENCH_IMMERSION,HAS_LATE_FRENCH_IMMERSION,HAS_PROG_FRANCOPHONE,LATITUDE,LONGITUDE,DESIGN_CAPACITY_TOTAL';
  const S = a => a.map(v => `"${v}"`).join(',');
  const k12 = Buffer.from('﻿' + [H,
    S(['2025/2026', '03939006', 'Kitsilano Secondary', '039', 'Vancouver', 'Public School', '2706 Trafalgar St', 'Vancouver', 'V6K2J6', 'Standard School', 'Elementary', 'YES', 'YES', 'NO', 'NO', '49.2621115', '-123.1636044', '1500']),
    S(['2025/2026', '03939053', 'Henry Hudson Elementary', '039', 'Vancouver', 'Public School', '1530 Maple St', 'Vancouver', 'V6J0H8', 'Standard School', 'Elementary', 'YES', 'NO', 'NO', 'NO', '49.2720311', '-123.1490104', '390']),
    S(['2025/2026', '03996764', 'Eaton Arrowsmith School (Vancouver) Ltd', '039', 'Vancouver', 'Independent School', 'x', 'Vancouver', 'V5Z4B3', 'Standard School', 'Elementary Jr. Secondary', 'NO', 'NO', 'NO', 'NO', '49.2551', '-123.1201', '']),
    S(['2025/2026', '03996014', 'St. Lawrence School', '039', 'Vancouver', 'Independent School', '', 'Vancouver', 'V5N1A1', 'Standard School', 'Elementary', 'NO', 'NO', 'NO', 'NO', '', '', '']),
    S(['2025/2026', '03998004', 'Vancouver Learning Network', '039', 'Vancouver', 'Public School', 'x', 'Vancouver', 'V5W1P3', 'Provincial Online Learning School', 'Secondary', 'NO', 'NO', 'NO', 'NO', '49.2319465', '-123.0926047', '']),
    S(['2025/2026', '00501007', 'Jaffray Elem-Jr Secondary', '005', 'Southeast Kootenay', 'Public School', 'x', 'Jaffray', 'V0B1T0', 'Standard School', 'Elementary Jr. Secondary', 'YES', 'NO', 'NO', 'NO', '49.3717011', '-115.3014209', '370']),
  ].join('\n'), 'utf8');
  const EH = 'SCHOOL_YEAR,DATA_LEVEL,PUBLIC_OR_INDEPENDENT,DISTRICT_NUMBER,DISTRICT_NAME,SCHOOL_NUMBER,SCHOOL_NAME,FACILITY_TYPE,GRADE,TOTAL_ENROLMENT';
  const e = (y, s, g, n) => `${y},School Level,Public School,039,Vancouver,${s},x,Standard,${g},${n}`;
  const enrol = Buffer.from([EH,
    e('2025/2026', '03939006', '08', '300'), e('2025/2026', '03939006', '12', '310'), e('2025/2026', '03939006', 'All Grades', '1572'),
    e('2025/2026', '03939053', 'KF', '40'), e('2025/2026', '03939053', '07', '45'), e('2025/2026', '03939053', 'All Grades', '325'),
    e('2025/2026', '03996764', '03', 'Msk'), e('2025/2026', '03996764', '08', 'Msk'), e('2025/2026', '03996764', 'All Grades', 'Msk'),
    e('2026/2027', '03939053', 'All Grades', '999'),
  ].join('\n'), 'latin1');
  const files = { 'bc-k12-schools.csv': k12, 'bc-enrolment-by-grade.csv': enrol };
  // a build whose tiles already publish 2025/26 keeps it, and warns about 2026/27
  const { ctx, stats, warnings } = fakeCtx(files, { snapshot: [{ pupilsAsOf: '2025/26' }] });
  const rows = await bc.fetch(ctx);
  for (const r of rows) assert.deepEqual(rowProblems(r, bc), []);
  const by = Object.fromEntries(rows.map(r => [r.id, r]));
  assert.deepEqual(Object.keys(by).sort(), ['03939006', '03939053', '03996764']);
  assert.equal(by['03939006'].phase, 'Secondary'); assert.equal(by['03939006'].stage, 'Secondary'); assert.equal(by['03939006'].span, '8–12');
  assert.equal(by['03939006'].tags, 'french-immersion'); assert.equal(by['03939006'].capacity, 1500); assert.equal(by['03939006'].la, 'Vancouver');
  assert.equal(by['03939053'].pupils, 325); assert.equal(by['03939053'].pupilsAsOf, '2025/26'); assert.equal(by['03939053'].stage, 'Primary');
  assert.equal(by['03996764'].sector, 'private'); assert.equal(by['03996764'].pupils, null); assert.equal(by['03996764'].la, ''); assert.equal(by['03996764'].capacity, null);
  assert.equal(stats['unmapped.noCoordinates'], 1); assert.equal(stats['dropped.onlineLearning'], 1); assert.equal(stats['dropped.outsideScope'], 1);
  assert.equal(stats['levelFromEnrolment.elementaryButGrades8to12'], 1); assert.equal(stats['enrolment.maskedUnder10'], 1);
  assert.ok(warnings.some(w => /enrolment 2026\/27 is published/.test(w)));
  // a deliberate --refresh takes the newest year
  const r2 = await bc.fetch(fakeCtx(files, { snapshot: [{ pupilsAsOf: '2025/26' }], refresh: true }).ctx);
  assert.equal(r2.find(r => r.id === '03939053').pupils, 999);
});
