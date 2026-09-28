// US PUBLIC SCHOOLS (src "ccd"), for the US crime-data cities under scope R2
// (each city's rectangle, limited to its own state; see tools/schools/regions.mjs).
//
// Two NCES products, joined on the NCES school id (NCESSCH):
//
//   1. NCES EDGE "School_Characteristics_Current" ArcGIS layer (2024-25): the
//      school's point, and the counts the directory file does not carry —
//      membership (MEMBER), teachers (FTE), free/reduced-price lunch (TOTFRL),
//      direct certification (DIRECTCERT). One envelope query per region,
//      paged; ArcGIS Online, no key, CORS *.
//   2. The CCD school directory files, because the layer has no state school
//      id and no charter authorizer, so the join is MANDATORY:
//        029 2024-25 v1a   ST_SCHID (every state rating joins on it — see
//                          _nces.mjs ccdDirectory), LEVEL, SCH_TYPE_TEXT,
//                          CHARTER_TEXT, CHARTAUTHN1, GSLO/GSHI, SY_STATUS_TEXT
//        129 2024-25 v1a   VIRTUAL_TEXT (the layer's own VIRTUAL is "M" for
//                          ~10,000 schools, so it cannot be used)
//        029 2025-26 v0a   preliminary: which of these schools have since closed
//
// Kept: schools that are operating (status Open, New, Added, Reopened or
// Changed Boundary/Agency), not exclusively virtual, not closed in the 2025-26
// preliminary directory, and inside a region rectangle whose home state is the
// school's own location state. Every drop is counted (index.sources.ccd.stats).
//
// Annual snapshot: the build re-emits these rows from the tiles every month;
// probe() warns when NCES publishes a newer final directory. Taking it is a
// deliberate `node tools/build-schools.mjs --refresh ccd` after updating the
// file names in _nces.mjs, so a new vintage never changes shape unreviewed.
//
// Ratings: none here. A US state rating map (tools/schools/ratings/us-*.mjs,
// joined through ST_SCHID) replaces `us-pending` on this state's rows when its
// committed map exists. Until then the pane says, truthfully, that the state
// publishes one and that the map does not show it yet. Missouri and Minnesota
// publish no single school rating, so their line is final.

import { createHash } from 'node:crypto';
import { unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { usPublicStage } from '../lib/stage.mjs';
import { REGIONS } from '../regions.mjs';
import { JURIS } from '../juris.mjs';
import {
  CCD_029, CCD_129, CCD_029_NEXT, CCD_YEAR, ccdTable, count, fte, r5, ccdSpan, zipInState, positionChecks,
} from './_nces.mjs';

const ID = 'ccd';
const LAYER = 'https://services1.arcgis.com/Ua5sjt3LWTPigjyD/arcgis/rest/services/School_Characteristics_Current/FeatureServer/1';
const LAYER_YEAR = '2024-2025';            // SURVYEAR the CCD files above belong to
const PAGE = 2000;                         // the layer's maxRecordCount
const PAD = 0.001;                         // degrees; the build clips to the exact rectangle anyway
const OUT_FIELDS = ['NCESSCH', 'SURVYEAR', 'LSTATE', 'MEMBER', 'FTE', 'TOTFRL', 'DIRECTCERT', 'LATCOD', 'LONCOD'];
// NCES SY_STATUS: 1 Open, 3 New, 4 Added, 5 Changed Boundary/Agency, 8 Reopened
// are operating; 2 Closed, 6 Inactive, 7 Future are not.
const OPERATING = new Set(['Open', 'New', 'Added', 'Reopened', 'Changed Boundary/Agency']);
const MAX_AGE_H = 24 * 30;

// Every US jurisdiction a region is limited to (R2). Derived, so a new US city
// in regions.mjs is covered without editing this file.
const US_JURIS = [...new Set(Object.values(REGIONS).flatMap(r => r.juris).filter(j => j.startsWith('US-')))].sort();

// ── rating lines (Phase 2: directory only) ──────────────────────────────────
// Each is one `when: { juris }` note of the `us-pending` scheme (kind 'none').
// Wording: the measure's name in the state's own terms (DESIGN.md §4), who
// publishes it, and the state's landing page (each checked to answer HTTP 200
// in a browser, Sept 2026). NY, PA and CA publish a federal support status,
// which is NOT a rating, and are worded that way.
const PENDING = {
  'US-AZ': ['an A–F letter grade for its public schools', 'Arizona Department of Education', 'https://azreportcards.azed.gov/'],
  'US-CO': ['a School Performance Framework plan type for each public school', 'Colorado Department of Education', 'https://www.cde.state.co.us/accountability/performanceframeworks'],
  'US-CT': ['a Next Generation Accountability category for each public school', 'Connecticut State Department of Education (EdSight)', 'https://edsight.ct.gov/'],
  'US-DC': ['an accountability score for each public school on the DC School Report Card', 'Office of the State Superintendent of Education (OSSE)', 'https://osse.dc.gov/dcschoolreportcard'],
  'US-IL': ['a summative designation for each public school', 'Illinois State Board of Education (Illinois Report Card)', 'https://www.illinoisreportcard.com/'],
  'US-LA': ['a School Performance Score and letter grade for its public schools', 'Louisiana Department of Education', 'https://louisianaschools.com/'],
  'US-MA': ['an accountability classification for each public school', 'Massachusetts Department of Elementary and Secondary Education', 'https://www.doe.mass.edu/accountability/'],
  'US-MD': ['a star rating on each public school’s report card', 'Maryland State Department of Education (Maryland Report Card)', 'https://reportcard.msde.maryland.gov/'],
  'US-MI': ['a Michigan School Index score for each public school', 'Michigan Department of Education', 'https://www.michigan.gov/mde/services/school-performance-supports/accountability'],
  'US-NC': ['an A–F School Performance Grade for its public schools', 'North Carolina Department of Public Instruction (NC School Report Cards)', 'https://ncreports.ondemand.sas.com/src/'],
  'US-NV': ['a star rating for each public school under its School Performance Framework', 'Nevada Department of Education (Nevada Report Card)', 'https://nevadareportcard.nv.gov/'],
  'US-OH': ['an overall star rating on each public school’s report card', 'Ohio Department of Education and Workforce (Ohio School Report Cards)', 'https://reportcard.education.ohio.gov/'],
  'US-TN': ['an A–F letter grade for its public schools', 'Tennessee Department of Education', 'https://tdepublicschools.ondemand.sas.com/'],
  'US-TX': ['an A–F accountability rating for its public schools', 'Texas Education Agency (TXschools.gov)', 'https://txschools.gov/'],
  'US-WA': ['a School Improvement Framework tier and score for each public school', 'Office of Superintendent of Public Instruction (Washington State Report Card)', 'https://washingtonstatereportcard.ospi.k12.wa.us/'],
};
// Federal (ESSA) support statuses: not ratings, and never worded as one.
const PENDING_STATUS = {
  'US-NY': ['New York identifies some public schools for extra support under federal law (its ESSA accountability status). That status is not a rating, and it is not shown on this map yet.', 'New York State Education Department', 'https://data.nysed.gov/'],
  'US-PA': ['Pennsylvania designates some public schools for extra support under federal law (its ESSA school designation). That designation is not a rating, and it is not shown on this map yet.', 'Pennsylvania Department of Education (Future Ready PA Index)', 'https://www.futurereadypa.org/'],
  'US-CA': ['California does not give its schools an overall rating. It identifies some schools for extra support under federal law (its ESSA assistance status); that status is not shown on this map yet.', 'California Department of Education', 'https://www.cde.ca.gov/sp/sw/t1/csi.asp'],
};
const escHtml = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const link = (publisher, url) => `<span class="caveat"><a class="ext" href="${escHtml(url)}" target="_blank" rel="noopener">Source: ${escHtml(publisher)} ↗</a></span>`;
const pendingNote = j => {
  if (PENDING_STATUS[j]) { const [text, pub, url] = PENDING_STATUS[j]; return { when: { juris: j }, html: `${escHtml(text)} ${link(pub, url)}` }; }
  const [what, pub, url] = PENDING[j];
  const name = JURIS[j].name.replace(/^the /, 'The ');
  return { when: { juris: j }, html: `${escHtml(name)} publishes ${escHtml(what)}. It is not shown on this map yet. ${link(pub, url)}` };
};
const SCHEMES = {
  'us-pending': {
    kind: 'none',
    notes: Object.keys({ ...PENDING, ...PENDING_STATUS }).sort().map(pendingNote),
  },
  'us-none-mo': { kind: 'none', notes: [{ html: 'Missouri does not publish an overall rating for each of its schools.' }] },
  'us-none-mn': { kind: 'none', notes: [{ html: 'Minnesota does not publish a single overall rating for its schools.' }] },
};
// A US state with no line here (a new city in a new state) stops the fetch:
// what that state publishes has to be looked up and worded first.
const schemeFor = juris => {
  if (juris === 'US-MO') return 'us-none-mo';
  if (juris === 'US-MN') return 'us-none-mn';
  if (PENDING[juris] || PENDING_STATUS[juris]) return 'us-pending';
  throw new Error(`no rating line for ${juris} in sources/ccd.mjs: say what ${JURIS[juris]?.name || juris} publishes before it can be shown`);
};

// ── the layer, one paged envelope query per region ──────────────────────────
function queryUrl(bbox, offset) {
  const [s, w, n, e] = bbox;
  const q = new URLSearchParams({
    where: '1=1', geometry: [w - PAD, s - PAD, e + PAD, n + PAD].map(v => v.toFixed(4)).join(','),
    geometryType: 'esriGeometryEnvelope', inSR: '4326', spatialRel: 'esriSpatialRelIntersects',
    outFields: OUT_FIELDS.join(','), returnGeometry: 'false', orderByFields: 'OBJECTID',
    resultOffset: String(offset), resultRecordCount: String(PAGE), f: 'json',
  });
  return `${LAYER}/query?${q}`;
}

// ArcGIS answers errors with HTTP 200 and an {error} body; a cached error page
// would then be re-read for a month, so it is deleted before failing.
function parseArcgis(ctx, file, buf) {
  let doc;
  try { doc = JSON.parse(buf.toString('utf8')); } catch { doc = { error: { message: 'not JSON' } }; }
  if (doc.error || !Array.isArray(doc.features)) {
    if (ctx.rawDir) { try { unlinkSync(join(ctx.rawDir, file)); } catch {} }
    throw new Error(`ArcGIS ${file}: ${doc.error?.message || 'no features array'}`);
  }
  return doc;
}

async function fetchLayer(ctx, regions) {
  const meta = JSON.parse((await ctx.download('arcgis-layer.json', `${LAYER}?f=json`, { maxAgeH: MAX_AGE_H })).toString('utf8'));
  if (meta.error) throw new Error(`ArcGIS layer metadata: ${meta.error.message}`);
  const lastEdit = meta.editingInfo?.dataLastEditDate ? new Date(meta.editingInfo.dataLastEditDate).toISOString() : null;
  const byId = new Map();
  for (const reg of regions) {
    let n = 0;
    for (let offset = 0; ; offset += PAGE) {
      // The query's hash is in the cache name, so a changed rectangle or field
      // list can never be answered from an older query's cached page.
      const url = queryUrl(reg.bbox, offset);
      const file = `arcgis-${reg.id}-${createHash('sha1').update(url).digest('hex').slice(0, 8)}-${offset}.json`;
      const doc = parseArcgis(ctx, file, await ctx.download(file, url, { maxAgeH: MAX_AGE_H, timeoutMs: 120_000 }));
      for (const { attributes: a } of doc.features) { byId.set(a.NCESSCH, a); n++; }
      if (!doc.exceededTransferLimit && doc.features.length < PAGE) break;
      if (offset > 20 * PAGE) throw new Error(`ArcGIS ${reg.id}: more than ${20 * PAGE} rows — the query is wrong`);
    }
    // Every covered city has public schools: an empty answer is a failure, not data.
    if (!n) throw new Error(`ArcGIS returned no schools for ${reg.id} — refusing a partial build`);
  }
  const years = new Set([...byId.values()].map(a => a.SURVYEAR));
  if (years.size !== 1 || !years.has(LAYER_YEAR)) {
    throw new Error(`the NCES layer now holds SURVYEAR ${[...years].join('/')}, not ${LAYER_YEAR}: update the CCD files in _nces.mjs to the same year, then --refresh ccd (never join two different years)`);
  }
  // One provenance record for the layer instead of ~30 query URLs, so
  // index.json stays small: the layer, its last data edit, and a hash of
  // exactly the attributes used (sorted), which pins the snapshot.
  const pages = ctx.provenance.filter(p => /^arcgis-/.test(p.file));
  const canon = JSON.stringify([...byId.values()].sort((a, b) => (a.NCESSCH < b.NCESSCH ? -1 : 1)).map(a => OUT_FIELDS.map(f => a[f])));
  const summary = {
    file: 'School_Characteristics_Current/FeatureServer/1 (NCES EDGE, ArcGIS Online)', url: LAYER, status: 200,
    lastModified: lastEdit, etag: null, survyear: LAYER_YEAR, queries: pages.length - 1,
    fetchedAt: pages.map(p => p.fetchedAt).filter(Boolean).sort().pop() || null,
    bytes: pages.reduce((a, p) => a + (p.bytes || 0), 0), sha256: createHash('sha256').update(canon).digest('hex'),
  };
  for (let i = ctx.provenance.length - 1; i >= 0; i--) if (/^arcgis-/.test(ctx.provenance[i].file)) ctx.provenance.splice(i, 1);
  ctx.provenance.unshift(summary);
  ctx.log(`     ArcGIS: ${byId.size.toLocaleString('en-GB')} schools across ${regions.length} region boxes (${summary.queries} queries)`);
  return byId;
}

// Same site? The leading house number and the ZIP, compared as published
// (street names are spelled differently from year to year: "Ave." / "AVE").
const houseNo = s => (/^\s*(\d+(?:-\d+)?)/.exec(s || '') || [])[1] || '';
function movedAddress(a, b) {
  if (!a.LSTREET1 || !b.LSTREET1 || !a.LZIP || !b.LZIP) return false;
  return a.LZIP.slice(0, 5) !== b.LZIP.slice(0, 5) || houseNo(a.LSTREET1) !== houseNo(b.LSTREET1);
}

// ── fetch ───────────────────────────────────────────────────────────────────
async function fetchRows(ctx) {
  const usRegions = ctx.coverage.regions.filter(r => r.juris.some(j => j.startsWith('US-')));
  if (!usRegions.length) throw new Error('coverage has no US regions');
  const layer = await fetchLayer(ctx, usRegions);

  const dir = ccdTable(await ctx.download(CCD_029.file, CCD_029.url, { maxAgeH: MAX_AGE_H }),
    ['NCESSCH', 'LSTATE', 'SCH_NAME', 'LEA_NAME', 'LSTREET1', 'LCITY', 'LZIP', 'SY_STATUS_TEXT', 'SCH_TYPE_TEXT', 'CHARTER_TEXT', 'CHARTAUTHN1', 'GSLO', 'GSHI', 'LEVEL'], CCD_029.file);
  const virt = ccdTable(await ctx.download(CCD_129.file, CCD_129.url, { maxAgeH: MAX_AGE_H }), ['NCESSCH', 'VIRTUAL', 'VIRTUAL_TEXT'], CCD_129.file);
  const next = ccdTable(await ctx.download(CCD_029_NEXT.file, CCD_029_NEXT.url, { maxAgeH: MAX_AGE_H }), ['NCESSCH', 'LSTATE', 'LSTREET1', 'LZIP', 'SY_STATUS_TEXT'], CCD_029_NEXT.file);

  const inUsBox = (lat, lng) => usRegions.some(r => lat >= r.bbox[0] && lat <= r.bbox[2] && lng >= r.bbox[1] && lng <= r.bbox[3]);
  const out = [];
  let orphans = 0;
  for (const [id, a] of [...layer].sort((x, y) => (x[0] < y[0] ? -1 : 1))) {
    // Scope is judged on the published (5-dp) point, exactly as the build and
    // verify-schools judge it, so a school on a rectangle's edge cannot be
    // kept here and dropped there.
    if (!Number.isFinite(+a.LATCOD) || !Number.isFinite(+a.LONCOD) || !+a.LATCOD || !+a.LONCOD) { ctx.stat('unmapped.noCoordinates'); continue; }
    const lat = r5(a.LATCOD), lng = r5(a.LONCOD);
    if (!inUsBox(lat, lng)) continue;                    // only the envelope padding: not in any city's rectangle
    const d = dir.get(id);
    if (!d) { orphans++; ctx.stat('dropped.notInDirectory'); continue; }
    // Same order as the design prototype, so the drop counts compare.
    if (!OPERATING.has(d.SY_STATUS_TEXT)) { ctx.stat('dropped.notOperating'); continue; }
    const v = virt.get(id);
    if (v && (v.VIRTUAL === 'FULLVIRTUAL' || v.VIRTUAL_TEXT === 'Exclusively virtual')) { ctx.stat('dropped.exclusivelyVirtual'); continue; }
    const nx = next.get(id);
    if (nx?.SY_STATUS_TEXT === 'Closed') { ctx.stat('dropped.closed2025-26'); continue; }
    // R2: the school's own LOCATION state (the directory's LSTATE; the
    // layer's copy carries a trailing space), never geometry.
    const juris = `US-${(d.LSTATE || String(a.LSTATE || '')).trim()}`;
    if (!ctx.coverage.regionFor(lat, lng, juris)) { ctx.stat('dropped.otherState'); continue; }

    const member = count(a.MEMBER);
    let meals = null, mealsKind = '';
    // Free/reduced-price lunch eligibility where published, else direct
    // certification (some states report only one), as a share of membership.
    for (const [k, kind] of [[count(a.TOTFRL), 'frl'], [count(a.DIRECTCERT), 'dc']]) {
      if (k == null || !member) continue;
      const pct = +(100 * k / member).toFixed(1);
      // More eligible than enrolled: the two counts come from different
      // collections and disagree, so this one is not shown (the next is tried).
      if (pct > 100) { ctx.stat(`omitted.${kind}Over100pct`); continue; }
      meals = pct; mealsKind = kind; break;
    }
    const charter = d.CHARTER_TEXT === 'Yes';
    // The pin is NCES's 2024-25 geocode; 2025-26 points are not published yet.
    // Where the 2025-26 preliminary directory lists a different address (a new
    // ZIP or house number: a move, or a corrected address), the pane says so
    // rather than let the old site pass for the current one.
    const moved = !!nx && movedAddress(d, nx);
    if (moved) ctx.stat('flagged.newAddress2025-26');
    const zip = zipInState(d.LZIP, juris) ? d.LZIP : '';
    if (!zip) ctx.stat('omitted.zipNotInState');
    out.push({
      src: ID, id, name: d.SCH_NAME, postcode: zip, lat, lng, juris,
      type: d.SCH_TYPE_TEXT, sector: 'state', stage: usPublicStage(d.LEVEL, d.GSHI), phase: d.LEVEL,
      tags: [charter && 'charter', moved && 'new-address-2025-26'].filter(Boolean).join(' '), boarding: false, span: ccdSpan(d.GSLO, d.GSHI),
      pupils: member, teachers: fte(a.FTE), meals, mealsKind,
      la: d.LEA_NAME, trust: charter ? d.CHARTAUTHN1 : '', area: d.LCITY,
      ratingScheme: schemeFor(juris),
    });
  }
  // The layer and the directory are the same NCES year: every layer school
  // must be in the directory. More than a handful missing = a wrong file.
  if (orphans > 25) throw new Error(`${orphans} layer schools are not in ${CCD_029.file}: the two are not the same NCES year`);

  // New schools in the 2025-26 preliminary directory have no published point
  // yet (NCES geocodes lag a year). Counted, not drawn: operating new ids in a
  // covered state whose location ZIP already holds one of the schools above.
  const zips = new Set(out.map(r => `${r.juris}|${r.postcode}`));
  for (const [id, n] of next) {
    if (dir.has(id) || !OPERATING.has(n.SY_STATUS_TEXT)) continue;
    if (zips.has(`US-${n.LSTATE}|${n.LZIP}`)) ctx.stat('unmapped.new2025-26NoLocationYet');
  }
  ctx.vintage(`CCD ${CCD_YEAR} (029 v1a, 129 v1a; closures from ${CCD_029_NEXT.year} preliminary); EDGE locations ${CCD_YEAR}`);
  return out;
}

// ── probe: has NCES published a newer final directory? ──────────────────────
async function probe(ctx) {
  const res = await fetch('https://nces.ed.gov/ccd/datatables/api/File/2/7/0/0/0/0', { signal: AbortSignal.timeout(60_000) });
  if (!res.ok) throw new Error(`NCES file list HTTP ${res.status}`);
  const urls = (JSON.stringify(await res.json()).match(/ccd_sch_029_\d{4}_w_\d[a-z]_\d{6}\.zip/g) || []);
  const final = urls.map(u => /ccd_sch_029_(\d{4})_w_(\d)/.exec(u)).filter(m => +m[2] >= 1).map(m => m[1]).sort();
  const newest = final.pop();
  return { vintage: newest ? `CCD 20${newest.slice(0, 2)}-${newest.slice(2)} directory (final)` : 'unknown', changed: !!newest && newest > '2425' };
}

export default {
  id: ID,
  juris: US_JURIS,
  cadence: 'annual',
  meta: {
    name: 'NCES Common Core of Data (CCD) school directory and EDGE school locations',
    publisher: 'U.S. Department of Education, National Center for Education Statistics (NCES)',
    licence: 'Public domain (U.S. federal government work)',
    licenceUrl: 'https://resources.data.gov/open-licenses/',
    attribution: `NCES ID {id} · U.S. Department of Education, NCES, Common Core of Data ${CCD_YEAR} and EDGE school locations ${CCD_YEAR}.`,
    recordUrl: 'https://nces.ed.gov/ccd/schoolsearch/school_detail.asp?ID={id}',
    recordLabel: 'NCES school record',
    // Several states' NCES records are in capitals (all of NY and TX, most of
    // MO; many cities and districts). /check/ shows an all-capitals value in
    // title case (its schCase, 'en' rules); mixed case is left as published.
    displayCase: 'en',
    where: 'US public schools',
    publishes: ['charter'],
    pupilsAsOf: CCD_YEAR,
    labels: {
      // The span is the 2024-25 directory's, like every detail here; NCES's
      // school record page (the link) already shows the 2025-26 preliminary
      // directory, which differs for about 600 of these schools.
      type: 'Type', phase: 'School level (NCES)', span: `Grades (${CCD_YEAR})`, pupils: 'Students', teachers: 'Teachers (FTE)',
      ratio: 'Students per teacher',
      meals: { frl: 'Free or reduced-price lunch eligible', dc: 'Directly certified for free meals' },
      tags: { charter: 'Charter school', 'new-address-2025-26': 'New address listed for 2025-26 (the pin is the 2024-25 site)' },
      la: 'School district', trust: 'Charter authorizer',
      pupilsAsOf: 'Details as reported to NCES for the {date} school year.',
    },
  },
  schemes: SCHEMES,
  fetch: fetchRows,
  probe,
  verify: (rows, h) => positionChecks(rows, h, 'NCES public'),
};
