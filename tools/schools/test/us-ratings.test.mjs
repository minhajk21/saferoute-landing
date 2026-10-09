// node --test tools/schools/test/us-ratings.test.mjs
// The US state rating maps (tools/schools/ratings/us-*.mjs ->
// tools/data/schools/ratings/<scheme>.json): the zero-dependency zip/xlsx
// readers they parse with, the wording rules every scheme record must keep,
// and the committed maps themselves (floors met, values allowed, ids that
// can only be US public schools of the right state, no secrets in provenance).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { deflateRawSync, crc32 } from 'node:zlib';
import { unzip, xlsx, sheetRecords, xmlText, nameKey, stars, num } from '../ratings/_us.mjs';
import { loadRatings, schemeProblems } from '../lib/modules.mjs';
import { readRowsFromTiles } from '../lib/tiles.mjs';
import { applyRatingMaps, composeSchemes } from '../lib/ratings-apply.mjs';
import { LICENSED_RATINGS, ratingLicensed } from '../licence.mjs';
import ccdSource from '../sources/ccd.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const MAPS = join(ROOT, 'tools', 'data', 'schools', 'ratings');

// A minimal ZIP writer for fixtures: stored or deflated members, real CRCs.
function zip(files) {
  const locals = [], centrals = [];
  let off = 0;
  for (const [name, content, deflate] of files) {
    const data = Buffer.from(content), body = deflate ? deflateRawSync(data) : data;
    const n = Buffer.from(name), crc = crc32(data) >>> 0;
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(deflate ? 8 : 0, 8);
    lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(body.length, 18); lh.writeUInt32LE(data.length, 22); lh.writeUInt16LE(n.length, 26);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(deflate ? 8 : 0, 10);
    ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(body.length, 20); ch.writeUInt32LE(data.length, 24); ch.writeUInt16LE(n.length, 28); ch.writeUInt32LE(off, 42);
    locals.push(lh, n, body); centrals.push(ch, n);
    off += 30 + n.length + body.length;
  }
  const cd = Buffer.concat(centrals), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(off, 16);
  return Buffer.concat([...locals, cd, end]);
}

const WORKBOOK = zip([
  ['xl/workbook.xml', '<workbook><sheets><sheet name="Notes" sheetId="1" r:id="rId2"/><sheet name="Data &amp; more" sheetId="2" r:id="rId1"/></sheets></workbook>'],
  ['xl/_rels/workbook.xml.rels', '<Relationships><Relationship Id="rId1" Type="x/worksheet" Target="worksheets/sheet2.xml"/><Relationship Id="rId2" Type="x/worksheet" Target="/xl/worksheets/sheet1.xml"/></Relationships>'],
  ['xl/sharedStrings.xml', '<sst><si><t>Campus Number</t></si><si><t xml:space="preserve">2026 Overall Rating </t></si><si><r><t>Not </t></r><r><t>Rated</t></r><rPh><t>ignored</t></rPh></si><si><t>A&amp;M_x000D_</t></si></sst>', true],
  ['xl/worksheets/sheet1.xml', '<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>notes</t></is></c></row></sheetData></worksheet>'],
  ['xl/worksheets/sheet2.xml', '<worksheet><sheetData>' +
    '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="C1" t="s"><v>1</v></c></row>' +
    '<row r="2" spans="1:3"/>' +
    '<row r="3"><c r="A3"><v>057905001</v></c><c r="C3" t="s"><v>2</v></c></row>' +
    '<row r="4"><c r="A4" t="str"><f>X</f><v>101912188</v></c><c r="B4" t="b"><v>1</v></c><c r="C4" t="s"><v>3</v></c></row>' +
    '</sheetData></worksheet>', true],
]);

test('zip: stored and deflated members, by name', () => {
  const z = unzip(WORKBOOK);
  assert.ok(z.names.includes('xl/sharedStrings.xml'));
  assert.match(z.read('xl/worksheets/sheet1.xml').toString(), /notes/);
  assert.throws(() => z.read('nope.xml'), /no member/);
  assert.throws(() => unzip(Buffer.from('not a zip at all, definitely not')), /not a zip/);
});

test('xlsx: sheets by relationship (not file order), shared/inline/rich strings, sparse cells', () => {
  const wb = xlsx(WORKBOOK);
  assert.deepEqual(wb.sheets, ['Notes', 'Data & more']);
  assert.deepEqual(wb.rows('Notes'), [['notes']]);
  const rows = wb.rows('Data & more');
  assert.deepEqual(rows[0], ['Campus Number', '', '2026 Overall Rating ']);
  assert.deepEqual(rows[1], []);                                     // an empty row keeps its place
  assert.deepEqual(rows[2], ['057905001', '', 'Not Rated']);           // rich runs joined, phonetic run dropped
  assert.deepEqual(rows[3], ['101912188', 'TRUE', 'A&M\r']);           // formula string, boolean, entity + _x000D_
  const recs = sheetRecords(rows, 0, ['Campus Number', '2026 Overall Rating'], 't');
  assert.deepEqual(recs.map(r => r['2026 Overall Rating']), ['Not Rated', 'A&M']);   // header trimmed; blank row skipped
  assert.throws(() => sheetRecords(rows, 0, ['Campus #'], 't'), /missing column/);
  assert.throws(() => sheetRecords(rows, h => h.includes('nope'), [], 't'), /header row not found/);
  assert.throws(() => wb.rows('Missing'), /no sheet/);
});

test('words: helpers', () => {
  assert.equal(xmlText('&lt;a&gt; &#65;&#x42; _x0009_'), '<a> AB \t');
  assert.equal(nameKey('Martin Behrman Charter Acad. of Creative Arts & Sci'), 'martin behrman charter acad of creative arts and sci');
  assert.equal(stars('1'), '1 star'); assert.equal(stars(3.5), '3.5 stars');
  assert.equal(num('2.4170000000000003'), '2.417'); assert.equal(num('x'), '');
});

// NCES ids start with the state's FIPS code, so a map id that belongs to
// another state (or is a PSS private-school PPIN) cannot slip through.
const FIPS = { 'US-AZ': '04', 'US-CA': '06', 'US-CO': '08', 'US-CT': '09', 'US-DC': '11', 'US-IL': '17', 'US-LA': '22', 'US-MA': '25',
  'US-MD': '24', 'US-MI': '26', 'US-NC': '37', 'US-NV': '32', 'US-NY': '36', 'US-OH': '39', 'US-PA': '42', 'US-TN': '47', 'US-TX': '48', 'US-WA': '53' };

const ratings = await loadRatings();
// SCHOOLS_TILES=<dir> points the last test at another tile set (e.g. a scratch build).
const tiles = readRowsFromTiles(process.env.SCHOOLS_TILES || join(ROOT, 'schools', 'data', 'tiles'));
const ccd = tiles.bySrc.get('ccd') || [];

test('every US scheme record is well-formed and worded by the rules', () => {
  const us = ratings.filter(r => r.scheme.startsWith('us-'));
  assert.equal(us.length, 18, 'TN NC CT WA DC MA MI MD CO IL OH LA NV CA NY PA AZ TX');
  for (const r of us) {
    const rec = r.record;
    assert.deepEqual(schemeProblems(r.scheme, rec), [], r.scheme);
    assert.deepEqual(r.sources, ['ccd'], `${r.scheme}: rates US public schools only`);
    assert.equal(r.juris.length, 1);
    assert.ok(FIPS[r.juris[0]], `${r.scheme}: juris ${r.juris}`);
    for (const k of ['title', 'short', 'scale', 'measures', 'year', 'publisher', 'url', 'attribution', 'miss']) assert.ok(rec[k], `${r.scheme}: ${k}`);
    assert.match(rec.url, /^https:\/\//, `${r.scheme}: url`);
    // Status schemes are never worded as ratings (DESIGN.md §4 invariant 3).
    if (rec.kind === 'status') {
      assert.match(rec.short, /not a rating/, `${r.scheme}: status short`);
      assert.match(`${rec.scale} ${rec.caveat}`, /not a rating|no overall rating|does not give schools an overall rating/i, `${r.scheme}: status wording`);
    }
    assert.ok(['us-ny-essa', 'us-pa-essa', 'us-ca-essa'].includes(r.scheme) === (rec.kind === 'status'), `${r.scheme}: kind ${rec.kind}`);
    // No comparison or ranking language beyond the page's own not-comparable line.
    assert.doesNotMatch(`${rec.title} ${rec.short} ${rec.scale} ${rec.measures} ${rec.caveat}`, /\b(better than|worse than|rank(ed|ing)? (first|top)|best school|top schools)\b/i, r.scheme);
  }
});

test('every committed map: present, floor met, values allowed, ids are this state\'s NCES public ids, no secrets', () => {
  for (const r of ratings.filter(x => x.scheme.startsWith('us-'))) {
    const path = join(MAPS, `${r.scheme}.json`);
    assert.ok(existsSync(path), `${r.scheme}: no committed map`);
    const text = readFileSync(path, 'utf8');
    assert.doesNotMatch(text, /[?&]sig=|sv=20\d\d-/, `${r.scheme}: a SAS token leaked into provenance`);
    const { meta, values } = JSON.parse(text);
    assert.equal(meta.scheme, r.scheme);
    assert.deepEqual(meta.juris, r.juris);
    assert.ok(meta.match.share >= r.floor, `${r.scheme}: match ${meta.match.share} under floor ${r.floor}`);
    assert.equal(meta.match.rated, Object.keys(values).length);
    assert.ok(meta.upstream.length >= 2 && meta.upstream.every(u => /^[0-9a-f]{64}$/.test(u.sha256) && u.url), `${r.scheme}: provenance`);
    assert.ok(meta.upstream.some(u => /ccd_sch_029/.test(u.file)), `${r.scheme}: the CCD directory used for the join is recorded`);
    for (const [id, v] of Object.entries(values)) {
      assert.match(id, /^\d{12}$/, `${r.scheme}: ${id} is not an NCES public-school id`);
      assert.ok(id.startsWith(FIPS[r.juris[0]]), `${r.scheme}: ${id} is not in ${r.juris[0]}`);
      assert.ok(typeof v.rv === 'string' && v.rv.trim() === v.rv && v.rv, `${r.scheme}: ${id} rv`);
      if (r.record.values) assert.ok(r.record.values.includes(v.rv), `${r.scheme}: ${id} "${v.rv}" not allowed`);
    }
  }
});

test('committed maps against the current tiles (once the ccd source is in them)', { skip: !ccd.length && 'no ccd rows in schools/data/tiles yet' }, () => {
  for (const r of ratings.filter(x => x.scheme.startsWith('us-'))) {
    const { values } = JSON.parse(readFileSync(join(MAPS, `${r.scheme}.json`), 'utf8'));
    const inScope = ccd.filter(x => x.juris === r.juris[0] && x.sector === 'state');
    const ids = new Set(inScope.map(x => x.id));
    const rated = inScope.filter(x => values[x.id]).length;
    assert.ok(rated / inScope.length >= r.floor, `${r.scheme}: ${rated}/${inScope.length} of today's tiles rated, under floor ${r.floor} — re-run node tools/schools/ratings.mjs --scheme ${r.scheme}`);
    const stray = Object.keys(values).filter(id => !ids.has(id));
    assert.ok(stray.length <= 0.02 * Object.keys(values).length, `${r.scheme}: ${stray.length} map ids are not ${r.juris[0]} ccd rows in the tiles`);
  }
});

// THE LICENCE RULE (tools/schools/licence.mjs): only a licensed map puts values
// on rows, and a value a row carries in from the snapshot cannot outlive its
// licence, even when that state's map is still committed.
test('licence rule: licensed schemes are real modules, and only their values are applied', () => {
  for (const [scheme, l] of Object.entries(LICENSED_RATINGS)) {
    const rm = ratings.find(r => r.scheme === scheme);
    assert.ok(rm, `${scheme} is licensed but has no ratings module`);
    assert.deepEqual(rm.juris, [l.juris], scheme);
    assert.ok(rm.record.licence?.startsWith(l.licence), `${scheme}: its record should name ${l.licence}`);
    assert.match(rm.record.licenceUrl || '', /^https:\/\//, `${scheme}: its record should link its licence (https), which the app packs require`);
  }
  assert.ok(!ratingLicensed('us-tx-af') && !ratingLicensed('us-az-af'));

  const dir = mkdtempSync(join(tmpdir(), 'saferoute-licence-test-'));
  try {
    for (const [scheme, id, rv] of [['us-ct-ngas', 'ct1', 'Category 2'], ['us-tx-af', 'tx1', 'B']]) {
      writeFileSync(join(dir, `${scheme}.json`), JSON.stringify({ meta: { vintage: 'test' }, values: { [id]: { rv } } }));
    }
    const row = (id, juris, ratingScheme = '', rv = '') => ({ src: 'ccd', id, juris, sector: 'state', ratingScheme, rv, rd: '' });
    const rows = [
      row('tx1', 'US-TX', 'us-tx-af', 'A'),          // re-emitted from the tiles with an old value
      row('ct1', 'US-CT', 'us-pending'),
      row('mo1', 'US-MO', 'us-none-mo'),
    ];
    const use = ratings.filter(r => ['us-ct-ngas', 'us-tx-af'].includes(r.scheme));
    const used = applyRatingMaps([{ src: ccdSource, rows }], use, dir, () => {});
    assert.deepEqual(used.map(u => u.rm.scheme), ['us-ct-ngas']);
    assert.deepEqual(rows.map(r => [r.id, r.ratingScheme, r.rv]), [
      ['tx1', 'us-pending', ''], ['ct1', 'us-ct-ngas', 'Category 2'], ['mo1', 'us-none-mo', '']]);
    const schemes = composeSchemes([ccdSource], rows, used);
    assert.deepEqual(Object.keys(schemes), ['us-pending', 'us-none-mo', 'us-ct-ngas']);
    assert.equal(schemes['us-ct-ngas'].vintage, 'test');
    const tx = schemes['us-pending'].notes.find(n => n.when.juris === 'US-TX').html;
    assert.match(tx, /^Texas publishes an A–F accountability rating for its public schools\. This map shows/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
