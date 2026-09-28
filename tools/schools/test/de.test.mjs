// node --test tools/schools/test/de.test.mjs
// Northern Ireland (sources/de.mjs and its helpers): the parsers and the
// wording rules, offline, plus consistency checks on the two vendored files
// (tools/data/schools/ni/ni-coords.json and eti-reports.json).
import test from 'node:test';
import assert from 'node:assert/strict';
import { deflateRawSync } from 'node:zlib';
import { existsSync, readFileSync } from 'node:fs';
import {
  parseListing, parseDetail, refsOf, reportType, framework, isAsos, reportRecord, REPORT_TYPES, FRAMEWORK_DATE, VENDORED,
} from '../sources/_de-eti.mjs';
import { readXlsx, table } from '../sources/_de-xlsx.mjs';
import { normRef, tidyPostcode, COORDS } from '../sources/_de-schoolsplus.mjs';
import de, { pct, titleNames, resolveEti, TYPE_LABEL, COMPAT } from '../sources/de.mjs';
import { schemeProblems } from '../lib/modules.mjs';
import { niStage } from '../lib/stage.mjs';
import { FORBIDDEN_FIELD } from '../lib/schema.mjs';

// ── ETI pages (trimmed from real etini.gov.uk markup, Sept 2026) ─────────────
const LISTING = `
<ul><li><a class="card card--plain no-ext-icon" href="/publications/skills-insights-report-x">
  <h3 class="card__title"><span>Skills Insights Report - X</span>
</h3>  <div class="card__meta"><span class="card__meta-item field-published-date">Published   <time datetime="2026-09-23T12:00:00Z">23 September 2026</time></span>
  <span class="card__meta-item field-publication-type"><p class="field"><span class="site-topics--item">Surveys / Evaluations</span></p></span></div>
</a></li>
<li><a class="card card--plain no-ext-icon" href="/publications/report-primary-inspection-st-nailes-primary-school-kinawley">
  <h3 class="card__title"><span>Report of a Primary Inspection - St N&aacute;ile&#039;s Primary School, Kinawley</span>
</h3><div class="card__meta"><span>Published <time datetime="2026-09-02T12:00:00Z">02 September 2026</time></span>
  <span class="card__meta-item field-publication-type"><p><span class="site-topics--item">Inspection reports</span></p></span></div>
</a></li></ul>`;
const DETAIL = `<html><body><main class="container" id="main-content"><article>
  <h1 class="page-title">
  Report of a Primary Inspection - Abercorn Primary School, Banbridge
</h1>
  <p class="published-date"><span>Date published: </span><span><time datetime="2026-09-07T12:00:00Z">07 September 2026</time></span></p>
  <div class="field field--name-field-publication-type field--type-entity-reference site-topics">
    <span class="site-topics--label field__label">Type: </span>
        <span class="site-topics--list">
                    <span class="site-topics--item">Inspection reports</span>
                </span>
      </div>
  <div class="field field--name-field-site-topics field--type-entity-reference site-topics">
    <span class="site-topics--label field__label">Organisational phase: </span>
        <span class="site-topics--list">
                    <span class="site-topics--item">Primary</span>
                </span>
      </div>
  <p class="reference">
    <span>Reference: </span>
          <span>501-1594</span>
      </p>
</article></main></body></html>`;

test('ETI listing: slug, title (entities decoded), date and the card type', () => {
  const l = parseListing(LISTING);
  assert.equal(l.length, 2);
  assert.deepEqual(l[0], { slug: 'skills-insights-report-x', title: 'Skills Insights Report - X', date: '2026-09-23', ptype: 'Surveys / Evaluations' });
  assert.equal(l[1].date, '2026-09-02');
  assert.equal(l[1].ptype, 'Inspection reports');
  assert.match(l[1].title, /St N.ile's Primary School/);
});

test('ETI publication page: type, phase and reference come from the page itself', () => {
  const d = parseDetail(DETAIL);
  assert.deepEqual(d, { title: 'Report of a Primary Inspection - Abercorn Primary School, Banbridge', date: '2026-09-07',
    type: ['Inspection reports'], phases: ['Primary'], reference: '501-1594' });
  assert.deepEqual(reportRecord({ ...d, slug: 's' }), ['2026-09-07', 's', '501-1594', 'Primary', d.title]);
  assert.equal(reportRecord({ ...d, slug: 's', type: ['Surveys / Evaluations'] }), null);          // not an inspection report
  assert.equal(reportRecord({ ...d, slug: 's', phases: ['Youth'] }), null);                        // not a school phase
  assert.equal(reportRecord({ ...d, slug: 's', phases: ['Pre-school'], reference: '1AB-0427' }), null); // a playgroup's letter ref
});

test('ETI references are normalised to the register form', () => {
  assert.deepEqual(refsOf('113- 6353'), ['113-6353']);
  assert.deepEqual(refsOf('IS89, IS88'), ['IS89', 'IS88']);
  assert.deepEqual(refsOf('162-0022 162-0023'), ['162-0022', '162-0023']);
  assert.deepEqual(refsOf('IS 106'), ['IS106']);
  assert.deepEqual(refsOf(''), []);
  assert.equal(normRef('IS 106 '), 'IS106');
  assert.equal(tidyPostcode('BT4  2AG'), 'BT4 2AG');
  assert.equal(tidyPostcode('bt6 0ja '), 'BT6 0JA');
});

test('ETI report kind: title prefix mapped onto the closed list', () => {
  const cases = {
    'Report of a Primary Inspection - A': 'Primary inspection',
    'Primary Inspection (Involving Action Short of Strike) - B, Ballymoney': 'Primary inspection',
    'Report of a Post-primary Inspection - Belfast Royal Academy': 'Post-primary inspection',
    'Inspection Report - Barbour Nursery School': 'Inspection',
    'Report of an Inspection - Edendork Primary School': 'Inspection',
    'Primary Inspection Kells and Connor Primary School, Ballymena, County Antrim': 'Primary inspection',
    'Follow-up Inpsection - X': 'Follow-up inspection',
    'Report of a Follow-up Inspection - Elmgrove Primary School, Belfast': 'Follow-up inspection',
    'Sustaining Improvement Inspection (Involving Action Short of Strike) - Z': 'Sustaining improvement inspection',
    'Re-registration Inspection Visit - OneSchool Global': 'Re-registration inspection',
    'Report of an Independent School Initial Registration Inspection - Scoil na Seolta, Belfast': 'Independent school initial registration inspection',
    'Pilot Baseline Inspection - Ballymoney High School': 'Pilot baseline inspection',
    'Something ETI has never titled a report': 'Inspection',
  };
  for (const [t, want] of Object.entries(cases)) assert.equal(reportType(t), want, t);
  for (const t of Object.keys(cases)) assert.ok(REPORT_TYPES.includes(reportType(t)));
});

test('ETI framework and ASOS: from the title and the publication date only', () => {
  assert.equal(FRAMEWORK_DATE, '2024-09-05');
  assert.equal(framework('2026-09-07', 'Report of a Primary Inspection - A'), 'current');
  assert.equal(framework('2024-09-04', 'Report of an Inspection - A'), 'previous');
  assert.equal(framework('2024-06-27', 'Pilot Inspection - Dungannon Primary School'), 'current');     // the new model's pilot
  // A follow-up published after the new framework began is in its format (Dundonald's report, read in
  // full: no performance levels, ends in a Conclusion), whatever the style of its title.
  assert.equal(framework('2025-01-17', 'Follow-up Inspection - Dundonald High School, Belfast'), 'current');
  assert.equal(framework('2024-07-05', 'Follow-up Inspection - Campbell College, Belfast'), 'previous');
  assert.equal(framework('2025-11-19', 'Report of a Follow-up Inspection - Elmgrove Primary School'), 'current');
  assert.equal(framework('2019-11-25', 'Primary Inspection - Belmont Primary School'), 'previous');
  assert.ok(isAsos('Primary Inspection (Involving Action Short of Strike) - Belmont Primary School, Belfast'));
  assert.ok(!isAsos('Report of a Primary Inspection - A'));
  // ETI's own misspellings (one each in the crawl)
  for (const t of ['Primary Inspection (Involving Acton Short of Strike) - Carrickfergus Central Primary School',
    'Primary Inspection (Involving Action Schort of Strike) - A', 'Post-Primary Inspection (Involving Action Short Strike) - A',
    'Primary Inspection (Involving Action Short of Strike - A']) assert.ok(isAsos(t), t);
});

test('ETI scheme per school: sector, framework and ASOS pick the wording; private rows never carry rv', () => {
  const rec = (date, title) => [date, 'slug', '101-0012', 'Primary', title];
  assert.deepEqual(resolveEti(rec('2026-09-07', 'Report of a Primary Inspection - A'), 'state'), { ratingScheme: 'ni-eti', rv: 'Primary inspection', rd: '2026-09-07', ru: 'slug' });
  assert.equal(resolveEti(rec('2019-11-25', 'Primary Inspection (Involving Action Short of Strike) - A'), 'state').ratingScheme, 'ni-eti-asos');
  assert.equal(resolveEti(rec('2019-11-25', 'Primary Inspection - A'), 'state').ratingScheme, 'ni-eti-prev');
  assert.equal(resolveEti(rec('2026-11-02', 'Report of a Primary Inspection (Involving Action Short of Strike) - A'), 'state').ratingScheme, 'ni-eti-asos-cur');
  const p = resolveEti(rec('2025-04-03', 'Report of an Independent School Re-registration Inspection - Harmony'), 'private');
  assert.equal(p.ratingScheme, 'ni-eti-indep'); assert.equal(p.rv, '');
});

test('ETI join guard: a mis-referenced report is taken only if its title names the school', () => {
  assert.ok(titleNames("Sustaining Improvement Inspection (Involving Action Short of Strike) - St Jarlath's Primary School, Blackwatertown", "St Jarlath's Primary School"));
  assert.ok(!titleNames('Sustaining Improvement Inspection - Belfast Royal Academy', 'Harding Memorial Primary School'));
  assert.ok(!titleNames('Primary Inspection - X', 'Primary School'));   // nothing distinctive to match: never taken on name
  assert.deepEqual(COMPAT.Preps, ['Primary']);
});

test('stage and type: DE types grouped by lib/stage.mjs; every DE type has a pane label', () => {
  for (const t of ['Primary', 'Secondary', 'Grammar', 'Nursery', 'Special', 'Independent', 'Preps']) assert.ok(TYPE_LABEL[t], t);
  assert.equal(niStage('Preps'), 'Primary');
  assert.equal(niStage('Special'), '');
  assert.equal(niStage('Independent'), '');
});

test('FSME share: DE text form only ("5.4%"), suppressed "*" is null', () => {
  assert.equal(pct('5.4%'), 5.4);
  assert.equal(pct('0.0%'), 0);
  assert.equal(pct('*'), null);
  assert.equal(pct('!'), null);
  assert.equal(pct(0.054), null);      // a bare number is ambiguous, never read
});

test('scheme records: well-formed, status (never "rating"), not-comparable wording intact', () => {
  for (const [id, s] of Object.entries(de.schemes)) {
    assert.deepEqual(schemeProblems(id, s), [], id);
    assert.notEqual(s.kind, 'rating', `${id} must not be worded as a rating`);
    if (s.kind === 'status') { assert.match(s.scale, /not a rating/); assert.deepEqual(s.values, REPORT_TYPES); assert.match(s.link.url, /\{ru\}/); }
  }
  assert.match(de.meta.attribution, /\{id\}/);
  assert.match(de.meta.attribution, /Open Government Licence v3\.0/);
  assert.deepEqual(de.meta.publishes, []);
  assert.equal(de.meta.labels.trust, 'Management type');
});

// ── the minimal xlsx reader, on a workbook built here ───────────────────────
function zip(files) {
  const locals = [], centrals = []; let off = 0;
  for (const [name, text] of Object.entries(files)) {
    const data = deflateRawSync(Buffer.from(text)), n = Buffer.from(name);
    const lh = Buffer.alloc(30); lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(8, 8);
    lh.writeUInt32LE(data.length, 18); lh.writeUInt32LE(text.length, 22); lh.writeUInt16LE(n.length, 26);
    const ch = Buffer.alloc(46); ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(8, 10);
    ch.writeUInt32LE(data.length, 20); ch.writeUInt32LE(text.length, 24); ch.writeUInt16LE(n.length, 28); ch.writeUInt32LE(off, 42);
    locals.push(lh, n, data); centrals.push(ch, n); off += 30 + n.length + data.length;
  }
  const cd = Buffer.concat(centrals), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(centrals.length / 2, 8); end.writeUInt16LE(centrals.length / 2, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(off, 16);
  return Buffer.concat([...locals, cd, end]);
}
test('xlsx reader: shared strings, inline strings, numbers, sparse cells, header search', () => {
  const buf = zip({
    'xl/workbook.xml': '<workbook><sheets><sheet name="Cover" sheetId="1" r:id="rId1"/><sheet name="FSM &amp; more" sheetId="2" r:id="rId2"/></sheets></workbook>',
    'xl/_rels/workbook.xml.rels': '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Target="worksheets/sheet2.xml"/></Relationships>',
    'xl/sharedStrings.xml': '<sst><si><t>DENI ref</t></si><si><r><t>% </t></r><r><t>fsme</t></r></si><si><t>1010012</t></si><si><t>5.4%</t></si></sst>',
    'xl/worksheets/sheet1.xml': '<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>Cover &lt;sheet&gt;</t></is></c></row></sheetData></worksheet>',
    'xl/worksheets/sheet2.xml': '<worksheet><sheetData><row r="2"><c r="A2" t="inlineStr"><is><t>Notes</t></is></c></row>' +
      '<row r="4"><c r="A4" t="s"><v>0</v></c><c r="C4" t="s"><v>1</v></c></row>' +
      '<row r="5"><c r="A5" t="s"><v>2</v></c><c r="B5"><v>222</v></c><c r="C5" t="s"><v>3</v></c></row><row r="6"/></sheetData></worksheet>',
  });
  const wb = readXlsx(buf);
  assert.deepEqual(wb.sheets, ['Cover', 'FSM & more']);
  assert.equal(wb.sheet('Cover')[0][0], 'Cover <sheet>');
  const rows = wb.sheet('FSM & more');
  assert.deepEqual(rows[4], ['1010012', 222, '5.4%']);
  assert.deepEqual(table(rows, 'DENI ref'), [{ 'DENI ref': '1010012', '': 222, '% fsme': '5.4%' }]);
  assert.throws(() => wb.sheet('Religion'), /no sheet "Religion"/);
});

// ── the vendored files ──────────────────────────────────────────────────────
test('vendored ni-coords.json: DE points only, inside Northern Ireland, with the postcode they were taken at', { skip: !existsSync(COORDS) && 'not built yet' }, () => {
  const doc = JSON.parse(readFileSync(COORDS, 'utf8'));
  assert.match(doc.meta.licence, /Open Government Licence/);
  const entries = Object.entries(doc.coords);
  assert.equal(entries.length, doc.meta.counts.points);
  assert.equal(doc.meta.counts.from2016 + doc.meta.counts.fromShowmap, doc.meta.counts.points);
  for (const [ref, [lat, lng, pc, from]] of entries) {
    assert.match(ref, /^\d{3}-\d{4}$|^IS\d+$/, ref);
    assert.ok(lat > 54.0 && lat < 55.35 && lng > -8.2 && lng < -5.4, `${ref} ${lat},${lng} is not in Northern Ireland`);
    assert.equal(+lat.toFixed(5), lat); assert.equal(+lng.toFixed(5), lng);
    assert.match(pc, /^BT\d{1,2} ?[0-9A-Z]{3}$|^BT\d{1,2} ?[A-Z0-9]+$/, `${ref} postcode ${pc}`);
    assert.ok(['2016', 'showmap'].includes(from), `${ref} source ${from}`);
  }
  // Withheld points: each one a DE point, with the reason from the internal check.
  for (const [ref, why] of Object.entries(doc.meta.withheld || {})) {
    assert.ok(doc.coords[ref], `withheld ${ref} has no DE point`);
    assert.match(why, /km from the current postcode's centroid and .* km from DfC/);
  }
  assert.equal(Object.keys(doc.meta.withheld || {}).length, doc.meta.locationCheck?.withheld ?? 0);
});

test('vendored eti-reports.json: well-formed, newest first, school references only', { skip: !existsSync(VENDORED) && 'not crawled yet' }, () => {
  const doc = JSON.parse(readFileSync(VENDORED, 'utf8'));
  assert.equal(doc.reports.length, doc.meta.schoolReports);
  assert.equal(doc.meta.http429 >= 0, true);
  assert.ok(doc.meta.gapMs >= 1200, 'crawled faster than 1.2 s a request');
  let prev = '9999';
  const slugs = new Set();
  for (const r of doc.reports) {
    const [date, slug, refs, phases, title] = r;
    assert.match(date, /^\d{4}-\d{2}-\d{2}$/);
    assert.ok(date >= doc.meta.since && date <= prev, `${slug} out of order`); prev = date;
    assert.match(slug, /^[a-z0-9][a-z0-9-]*$/, slug);
    assert.ok(!slugs.has(slug), `duplicate ${slug}`); slugs.add(slug);
    for (const ref of refs.split(' ')) assert.match(ref, /^\d{3}-\d{4}$|^IS\d+$/, `${slug}: ${ref}`);
    assert.ok(phases.split(', ').every(p => ['Primary', 'Post-primary', 'Pre-school', 'Special Education', 'Independent'].includes(p)), `${slug}: ${phases}`);
    assert.ok(title.length > 5);
  }
});

test('no religion anywhere in what this source emits or vendors', () => {
  const src = readFileSync(new URL('../sources/de.mjs', import.meta.url), 'utf8');
  assert.ok(!/sheet\(['"](Religion|Sex)/.test(src), 'de.mjs must never read the census Religion or Sex sheets');
  for (const k of Object.keys(de.meta.labels)) assert.ok(!FORBIDDEN_FIELD.test(k));
});

test('ETI reports filed under a school\'s earlier reference (management type changed) are found, and only those', async () => {
  const { earlierReferenceReports } = await import('../sources/de.mjs');
  const byRef = new Map([
    ['311-0037', [['2018-06-06', 'pre-school-inspection-ballymena-nursery-school-ballymena-county-antrim', '311-0037', 'Pre-school', 'Pre-School Inspection - Ballymena Nursery School, Ballymena, County Antrim']]],
    ['111-0028', [['2017-01-30', 'follow-brefne', '111-0028', 'Pre-school', 'Follow-up Inspection - Brefne Nursery School, Belfast'],
                  ['2017-01-19', 'shaftesbury', '111-0028', 'Pre-school', 'Pre-School Inspection - Shaftesbury Nursery School, Belfast']]],
    ['301-0841', [['2017-06-22', 'carrick', '301-0841', 'Primary', 'Primary Inspection (Involving Acton Short of Strike) - Carrickfergus Central Primary School, Carrickfergus, County Antrim']]],
    ['401-3024', [['2018-12-11', 'cairnshill', '401-3024', 'Post-primary', 'Post-Primary Inspection - Cairnshill Primary School']]],
  ]);
  const none = new Set();
  // the Sept 2026 repair's example: 311-0037 became 315-0037 on becoming Controlled Integrated
  assert.deepEqual(earlierReferenceReports({ id: '315-0037', type: 'Nursery', name: 'Ballymena Integrated Nursery School' }, byRef, none).map(r => r[1]),
    ['pre-school-inspection-ballymena-nursery-school-ballymena-county-antrim']);
  // a report under the old reference whose title names another school is not taken
  assert.deepEqual(earlierReferenceReports({ id: '115-0028', type: 'Nursery', name: 'Brefne Integrated Nursery School' }, byRef, none).map(r => r[1]), ['follow-brefne']);
  assert.equal(earlierReferenceReports({ id: '305-0841', type: 'Primary', name: 'Central Integrated Primary School' }, byRef, none).length, 1);
  // not while the old reference is still a school on the register
  assert.equal(earlierReferenceReports({ id: '315-0037', type: 'Nursery', name: 'Ballymena Integrated Nursery School' }, byRef, new Set(['311-0037'])).length, 0);
  // not a report of the wrong phase
  assert.equal(earlierReferenceReports({ id: '405-3024', type: 'Primary', name: 'Cairnshill Integrated Primary School' }, byRef, none).length, 0);
  // an independent school's reference ("IS106") has no management digit
  assert.equal(earlierReferenceReports({ id: 'IS106', type: 'Independent', name: 'X' }, byRef, none).length, 0);
});
