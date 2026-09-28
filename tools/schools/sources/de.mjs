// Northern Ireland: every open school on the Department of Education's (DE)
// register, drawn where DE has published a location for it, with DE's school
// census and available-places figures, the school's management type, and the
// Education and Training Inspectorate's (ETI) latest inspection report.
//
// SOURCES (all Crown copyright, Open Government Licence v3.0):
//   register      DE "Schools Plus" (live; _de-schoolsplus.mjs) — which schools
//                 are open, their type, management, town and postcode
//   locations     tools/data/schools/ni/ni-coords.json, VENDORED: DE's own
//                 points (OpenDataNI locate-a-school Feb 2016, plus the Schools
//                 Plus map page for schools registered since). Owner decision
//                 Q4: DE points only. A school with no DE point, whose
//                 postcode has changed since its point was taken (it has
//                 probably moved), or whose point two independent internal
//                 checks both put over 1 km away (meta.withheld), is counted
//                 and NOT drawn
//   census        DE school census 2025/26 (10 October 2025), school-level
//                 workbooks: pupils, year groups, free school meals
//                 entitlement, Irish-medium status
//   places        DE available places 2025/26: approved enrolment
//   inspection    ETI publications (_de-eti.mjs): the latest inspection
//                 report's kind, publication date and link. Vendored first
//                 crawl in tools/data/schools/ni/eti-reports.json; each monthly
//                 run only reads the listing back to the newest report already
//                 published (plus a margin) — a handful of polite requests
//
// WHAT IS DELIBERATELY NOT HERE
//   - Any grade or judgement from an ETI report. ETI stopped publishing
//     performance-level grades in September 2024, many reports made during
//     teachers' action short of strike give no judgement, and an old grade out
//     of context misleads. The pane names the kind of report and links to it.
//   - Religion. The census "Religion" sheets are never read. Management type
//     (Controlled, Roman Catholic Maintained, Voluntary, Controlled Integrated,
//     Grant Maintained Integrated, Other Maintained) is statutory GOVERNANCE,
//     shown in the pane only (owner decision Q3) — never a filter or a colour.
//   - Gender: DE declares none, and it is never derived from pupil counts (the
//     census "Sex" sheets are never read). Nor SAER exam tables (DE: "not a
//     valid basis for comparing"), addresses, phone numbers or e-mail addresses.
//   - Free school meals for NURSERY schools: their census sheet counts pupils
//     "entitled to free school meals / JSA / IS", a different measure from the
//     FSME the other workbooks publish, so it is not shown under that label.
//
// Row fields: id = DE reference as on the register ("101-0012", "IS106");
// type = DE's institution type in words; phase = DE's type code; trust = management type
// (label "Management type"); capacity = approved enrolment; span = year groups
// with pupils on census day; ratingScheme ni-eti* with rv = the kind of report,
// rd = its publication date, ru = its slug on etini.gov.uk.

import { records } from '../lib/csv.mjs';
import { niStage } from '../lib/stage.mjs';
import { readXlsx, table } from './_de-xlsx.mjs';
import { exportRegister, readCoords, normRef, normPostcode, tidyPostcode, SP } from './_de-schoolsplus.mjs';
import {
  LISTING_URL, REPORT_URL, REPORT_TYPES, SINCE, politeGetter, crawl, reportRecord, reportType, framework, isAsos, readVendored,
} from './_de-eti.mjs';
import { existsSync, readFileSync, writeFileSync, statSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';

const JURIS = 'GB-NIR';
const OGL = 'Open Government Licence v3.0';

// ── the census vintage this build reads (a new year is a deliberate change) ──
export const CENSUS = {
  year: '2025/26', date: '2025-10-10',
  page: 'https://www.education-ni.gov.uk/publications/school-enrolment-school-level-data-20252026',
  index: 'https://www.education-ni.gov.uk/articles/school-enrolments-school-level-data',
};
const DE_FILES = 'https://www.education-ni.gov.uk/sites/default/files/';
// Resolved from the publication page's own links (DE re-uploads corrected
// files under new names — "supp_1", "Revised 3 June 2026"); the fallback is the
// link as it stood when this was written.
const WORKBOOKS = {
  primary:     { re: /School(?:%20|\s|_)level(?:%20|\s|_)-(?:%20|\s|_)primary(?:%20|\s|_)schools(?:%20|\s|_)202526[^"]*?\.xlsx/i, fallback: '2026-07/School%20level%20-%20primary%20schools%20202526%20supp_1.xlsx' },
  postPrimary: { re: /School(?:%20|\s|_)level(?:%20|\s|_)-(?:%20|\s|_)post(?:%20|\s|_)primary(?:%20|\s|_)schools(?:%20|\s|_)202526[^"]*?\.xlsx/i, fallback: '2026-07/School%20level%20-%20post%20primary%20schools%20202526%20supp_1.xlsx' },
  nursery:     { re: /School(?:%20|\s|_)level(?:%20|\s|_)-(?:%20|\s|_)nursery(?:%20|\s|_)schools(?:%20|\s|_)202526[^"]*?\.xlsx/i, fallback: '2026-07/School%20level%20-%20nursery%20schools%20202526%20supp_1.xlsx' },
  special:     { re: /School(?:%20|\s|_)level(?:%20|\s|_)-(?:%20|\s|_)special(?:%20|\s|_)schools(?:%20|\s|_)202526[^"]*?\.xlsx/i, fallback: '2026-03/School%20level%20-%20special%20schools%20202526.xlsx' },
  apPrimary:   { re: /Available(?:%20|\s|_)places(?:%20|\s|_)-(?:%20|\s|_)Primary(?:%20|\s|_)202526[^"]*?\.xlsx/i, fallback: '2026-06/Available%20places%20-%20Primary%20202526%20-%20Revised%203%20June%202026.XLSX' },
  apPost:      { re: /Available(?:%20|\s|_)places(?:%20|\s|_)-(?:%20|\s|_)Post-primary(?:%20|\s|_)202526[^"]*?\.xlsx/i, fallback: '2026-03/Available%20places%20-%20Post-primary%20202526.XLSX' },
  apNursery:   { re: /Available(?:%20|\s|_)places(?:%20|\s|_)-(?:%20|\s|_)Nursery[^"]*?202526[^"]*?\.xlsx/i, fallback: '2026-03/Available%20places%20-%20Nursery%20schools%20and%20units%20202526.XLSX' },
};

// DE register type -> the pane's "Type", in DE's own words: the "Institution
// Type" its Schools Plus page prints for each school ("Secondary (grammar)
// school", "Preparatory Schools"...). The register export abbreviates them
// ("Grammar", "Preps"), and row.phase keeps that code. Preps are the
// preparatory departments of grammar schools, filed by DE with primary
// schools; fee-charging is not verified, so the pane never says so.
export const TYPE_LABEL = {
  Primary: 'Primary school', Secondary: 'Secondary (non-grammar) school', Grammar: 'Secondary (grammar) school',
  Nursery: 'Nursery school', Special: 'Special school', Independent: 'Independent school', Preps: 'Preparatory school',
};
// Which ETI organisational phase inspects which DE type. A report whose page
// names a school's reference under a different phase is taken only if its
// title also names the school (the reference on the page can be a typo).
export const COMPAT = { Primary: ['Primary'], Preps: ['Primary'], Secondary: ['Post-primary'], Grammar: ['Post-primary'], Nursery: ['Pre-school'], Special: ['Special Education'], Independent: ['Independent'] };
const ETI_MARGIN_DAYS = 45;

const digits = ref => normRef(ref).replace(/-/g, '');
const num = v => (typeof v === 'number' ? v : /^-?\d+(\.\d+)?$/.test(String(v).trim()) ? +v : null);
// DE writes the FSME share as text ("5.4%", or "*" when suppressed). Only that
// form is read: a bare number would be ambiguous between a fraction and a percentage.
export const pct = v => { const m = /^(\d+(?:\.\d+)?)\s*%$/.exec(String(v).trim()); return m ? +(+m[1]).toFixed(1) : null; };
const titleCase = s => String(s || '').toLowerCase().replace(/(^|[\s\-'(])([a-z])/g, (_, p, c) => p + c.toUpperCase());
const isoMinusDays = (iso, d) => new Date(Date.parse(iso + 'T00:00:00Z') - d * 864e5).toISOString().slice(0, 10);

// A cached non-GET fetch (the register is a postback), with the same cache
// file, provenance sidecar and --frozen behaviour as ctx.download.
async function cachedRaw(ctx, file, url, fn, maxAgeH = 12) {
  const dir = ctx.rawDir || join(tmpdir(), 'saferoute-schools', 'de');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, file), side = `${path}.meta.json`;
  const sha = b => createHash('sha256').update(b).digest('hex');
  if (existsSync(path) && (ctx.frozen || (Date.now() - statSync(path).mtimeMs) / 36e5 < maxAgeH)) {
    const buf = readFileSync(path);
    let meta = {}; try { meta = JSON.parse(readFileSync(side, 'utf8')); } catch {}
    ctx.provenance.push({ ...meta, file, bytes: buf.length, sha256: sha(buf), cached: true });
    ctx.log(`  using cached ${file}${ctx.frozen ? ' (frozen)' : ''}`);
    return buf;
  }
  if (ctx.frozen) throw new Error(`--frozen: ${file} is not in ${dir}`);
  const buf = await fn();
  const rec = { file, url, status: 200, lastModified: null, etag: null, fetchedAt: new Date().toISOString(), bytes: buf.length, sha256: sha(buf) };
  writeFileSync(path, buf); writeFileSync(side, JSON.stringify(rec, null, 1));
  ctx.provenance.push({ ...rec, cached: false });
  return buf;
}

// ── census and available places ─────────────────────────────────────────────
async function loadCensus(ctx) {
  let pageHtml = null;
  const page = async () => (pageHtml ??= (await ctx.download('census-202526.html', CENSUS.page, { maxAgeH: 24 * 7 })).toString('utf8'));
  const get = async key => {
    const w = WORKBOOKS[key];
    return readXlsx(await ctx.download(`census-${key}.xlsx`, async () => {
      const html = await page();
      const m = w.re.exec(html);
      const found = m ? (m[0].startsWith('http') ? m[0] : DE_FILES + m[0].replace(/^.*?\/files\//, '')) : null;
      return [found, DE_FILES + w.fallback].filter(Boolean);
    }, { maxAgeH: 24 * 7 }));
  };
  const byRef = new Map();
  const at = ref => { const k = digits(ref); if (!byRef.has(k)) byRef.set(k, {}); return byRef.get(k); };
  const yearSpan = (e, from, to) => {
    const ys = []; for (let y = from; y <= to; y++) if (num(e[`Total: Year ${y}`]) > 0) ys.push(y);
    if (!ys.length) return '';
    return ys[0] === ys[ys.length - 1] ? `Year ${ys[0]}` : `Years ${ys[0]}–${ys[ys.length - 1]}`;
  };
  const refData = wb => { for (const r of table(wb.sheet('Reference Data'), 'DENI ref')) Object.assign(at(r['DENI ref']), { irish: /^yes$/i.test(r['Irish Medium School']), censusType: r['School Type'] }); };
  const fsm = wb => { for (const r of table(wb.sheet('FSM'), 'DENI ref')) { const p = pct(r['% fsme']); if (p != null) at(r['DENI ref']).fsme = p; else ctx.stat('census.fsmeSuppressed'); } };

  const primary = await get('primary');
  refData(primary);
  for (const e of table(primary.sheet('Enrolments'), 'DENI ref')) {
    const pre = [];
    if ((num(e['Total: Nursery FT']) || 0) + (num(e['Total: Nursery PT']) || 0) + (num(e['Total: Pre-school age']) || 0) > 0) pre.push('Nursery');
    if (num(e['Total: Reception']) > 0) pre.push('Reception');
    const years = yearSpan(e, 1, 7);
    Object.assign(at(e['DENI ref']), { pupils: num(e['Total enrolment']), span: [...pre, years].filter(Boolean).join(', ') });
  }
  fsm(primary);

  const post = await get('postPrimary');
  refData(post);
  for (const e of table(post.sheet('Enrolments'), 'DENI ref')) Object.assign(at(e['DENI ref']), { pupils: num(e['Total enrolment']), span: yearSpan(e, 8, 14) });
  fsm(post);

  const nursery = await get('nursery');
  refData(nursery);
  for (const e of table(nursery.sheet('Enrolments'), 'DENI ref')) at(e['DENI ref']).pupils = num(e['Total pupils']);

  const special = await get('special');
  refData(special);
  // The special-school workbook has no enrolment or year-group sheet; its FSM
  // sheet carries each school's total enrolment.
  for (const e of table(special.sheet('FSM'), 'DENI ref')) at(e['DENI ref']).pupils = num(e['Total enrolment']);
  fsm(special);

  // Approved enrolment, per phase. The nursery file lists nursery UNITS under
  // their host primary's reference: it is read for nursery SCHOOLS only, so a
  // unit's figure can never overwrite its primary's.
  const places = { primary: new Map(), post: new Map(), nursery: new Map() };
  for (const [key, into] of [['apPrimary', places.primary], ['apPost', places.post], ['apNursery', places.nursery]]) {
    const wb = await get(key);
    const rows = wb.sheet(wb.sheets.find(s => /school level data/i.test(s)));
    const h = rows.findIndex(r => r.some(c => /^approved enrolments?$/i.test(String(c).trim())));
    if (h < 0) throw new Error(`available places ${key}: no "Approved enrolments" column`);
    const col = rows[h].findIndex(c => /^approved enrolments?$/i.test(String(c).trim()));
    for (let i = h + 1; i < rows.length; i++) {
      const ref = String(rows[i][0] ?? '').trim();
      if (!/^\d{7}$/.test(ref)) continue;
      const v = num(rows[i][col]);
      if (v != null) into.set(ref, v); else ctx.stat('places.suppressed');
    }
  }
  return { byRef, places };
}

// Is there a census newer than the one this build reads? (A warning only:
// taking a new year is a deliberate change of CENSUS and its labels.)
async function censusProbe(ctx) {
  try {
    const html = (await ctx.download('census-index.html', CENSUS.index, { maxAgeH: 24 * 7 })).toString('utf8');
    const years = [...html.matchAll(/\/publications\/school-enrolments?-school-level-dat[ae]-(\d{4})(\d{2,4})\b/g)].map(m => +m[1]);
    const newest = Math.max(...years);
    if (newest > +CENSUS.year.slice(0, 4)) ctx.warn(`DE has published school-level census data for ${newest}/${String(newest + 1).slice(2)}; this build reads ${CENSUS.year} — refresh CENSUS in sources/de.mjs deliberately`);
  } catch (e) { ctx.log(`  census probe skipped (${e.message})`); }
}

// ── ETI: the latest report per DE reference ─────────────────────────────────
function significant(name) {
  const STOP = new Set(['school', 'schools', 'primary', 'college', 'the', 'of', 'and', 'nursery', 'unit', 'integrated', 'high', 'grammar', 'st', 'saint', 'ps', 'special', 'centre', 'department', 'preparatory', 'prep', 'junior']);
  return String(name).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[’']/g, '').split(/[^a-z0-9]+/).filter(w => w && !STOP.has(w));
}
export function titleNames(title, name) {
  const t = ' ' + String(title).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[’']/g, '').replace(/[^a-z0-9]+/g, ' ') + ' ';
  const words = significant(name);
  return words.length > 0 && words.every(w => t.includes(` ${w} `));
}

async function etiReports(ctx) {
  const vend = readVendored();
  if (!vend) ctx.warn('tools/data/schools/ni/eti-reports.json is missing — run node tools/schools/sources/_de-eti.mjs --full');
  else ctx.provenance.push({ file: 'vendored eti-reports.json', url: vend.meta.listing, licence: vend.meta.licence, fetchedAt: vend.meta.crawlFinished, since: vend.meta.since, schoolReports: vend.meta.schoolReports });
  const recs = [...(vend?.reports || [])];
  let newest = vend?.meta?.newestListingDate || SINCE;
  for (const r of ctx.snapshot) if (r.rd && r.rd > newest) newest = r.rd;
  let crawled = null;
  if (!ctx.frozen) {
    const since = isoMinusDays(newest, ETI_MARGIN_DAYS);
    try {
      const client = politeGetter({ log: ctx.log, max429: 3, blockWaitMs: 180_000 });
      const started = new Date().toISOString();
      const { listing, details } = await crawl({ since, get: client.get, log: ctx.log, maxPages: 40 });
      const found = details.map(reportRecord).filter(Boolean);
      recs.push(...found);
      const s = client.stats();
      crawled = { since, listing: listing.length, opened: details.length, schoolReports: found.length, requests: s.requests, http429: s.n429 };
      ctx.provenance.push({ file: 'eti-listing', url: LISTING_URL, status: 200, fetchedAt: started, since, pages: Math.ceil(listing.length / 20), publicationsOpened: details.length, requests: s.requests });
      ctx.log(`  ETI: ${found.length} school reports published since ${since} (${s.requests} requests)`);
    } catch (e) {
      ctx.warn(`ETI crawl failed (${e.message}) — using the vendored reports and the current tiles`);
      ctx.stat('eti.crawlFailed');
    }
  }
  const byRef = new Map();
  for (const rec of recs) for (const ref of rec[2].split(' ')) {
    if (!byRef.has(ref)) byRef.set(ref, []);
    byRef.get(ref).push(rec);
  }
  return { byRef, vendNewest: vend?.meta?.newestListingDate || null, crawled };
}

// The tag on a row whose report was filed under the school's earlier reference.
export const ETI_EARLIER_REF = 'eti-earlier-ref';
// ETI reports filed under a school's earlier DE reference (see fetchRows):
// same area and number, a different management digit, a reference no longer on
// the register, the school's phase, and a title that names the school.
export function earlierReferenceReports(school, byRef, onRegister) {
  const m = /^(\d\d)(\d)-(\d{4})$/.exec(school.id);
  if (!m) return [];
  const out = [];
  for (let d = 0; d <= 9; d++) {
    if (String(d) === m[2]) continue;
    const old = `${m[1]}${d}-${m[3]}`;
    if (onRegister.has(old)) continue;
    for (const rec of byRef.get(old) || []) {
      if (rec[3].split(', ').some(p => (COMPAT[school.type] || []).includes(p)) && titleNames(rec[4], school.name)) out.push(rec);
    }
  }
  return out;
}

export function resolveEti(rec, sector) {
  const [date, slug, , , title] = rec;
  if (sector === 'private') return { ratingScheme: 'ni-eti-indep', rv: '', rd: date, ru: slug };
  const fw = framework(date, title), asos = isAsos(title);
  return {
    ratingScheme: asos ? (fw === 'current' ? 'ni-eti-asos-cur' : 'ni-eti-asos') : (fw === 'current' ? 'ni-eti' : 'ni-eti-prev'),
    rv: reportType(title), rd: date, ru: slug,
  };
}

// ── the source ──────────────────────────────────────────────────────────────
async function fetchRows(ctx) {
  const coordsDoc = readCoords();
  if (!coordsDoc) throw new Error('tools/data/schools/ni/ni-coords.json is missing — run node tools/schools/sources/_de-schoolsplus.mjs --coords');
  // The vendored tables' own provenance travels into index.json with the downloads.
  for (const s of coordsDoc.meta.sources || []) ctx.provenance.push({ file: `vendored ni-coords.json (${s.id})`, url: s.url || s.page, licence: s.licence, sha256: s.sha256 || null, fetchedAt: s.scraped || coordsDoc.meta.built });
  const regBuf = await cachedRaw(ctx, 'schools-plus-open.csv', `${SP}default.aspx (Find: Schools, Open; Export: Text)`, async () => (await exportRegister()).buf);
  const register = records(regBuf, { encoding: 'utf-8' });
  if (register.length < 1000) throw new Error(`the DE register export has only ${register.length} open institutions — refusing a partial build`);
  const { byRef: census, places } = await loadCensus(ctx);
  await censusProbe(ctx);
  const eti = await etiReports(ctx);
  const snap = new Map(ctx.snapshot.map(r => [r.id, r]));

  // ETI reports per school. A report is taken for the school its page's
  // reference names when its phase fits the school's type, or its title names
  // the school. A report whose reference points at a school of the wrong phase
  // is an ETI typo (a special school's follow-up filed under a primary's
  // reference): it goes to the one open school of a fitting type whose name its
  // title gives, or to no school at all.
  const open = register.filter(r => r.Status === 'Open' && COMPAT[r.Type]).map(r => ({ id: normRef(r['Institution Reference Number']), type: r.Type, name: r['Institution Name'] }));
  const onRegister = new Set(register.map(r => normRef(r['Institution Reference Number'])));
  const reports = new Map(open.map(s => [s.id, []]));
  const misfiled = new Map();
  for (const s of open) for (const rec of eti.byRef.get(s.id) || []) {
    if (rec[3].split(', ').some(p => COMPAT[s.type].includes(p)) || titleNames(rec[4], s.name)) reports.get(s.id).push(rec);
    else misfiled.set(rec[1], rec);
  }
  for (const rec of misfiled.values()) {
    const hits = open.filter(s => rec[3].split(', ').some(p => COMPAT[s.type].includes(p)) && titleNames(rec[4], s.name));
    if (hits.length === 1) { reports.get(hits[0].id).push(rec); ctx.stat('eti.misfiledReassignedByTitle'); ctx.log(`  ETI ${rec[1]}: reference ${rec[2]} is a ${rec[3]} report for "${hits[0].name}" (${hits[0].id})`); }
    else { ctx.stat('eti.misfiledDropped'); ctx.log(`  ETI ${rec[1]}: reference ${rec[2]} does not fit its phase ${rec[3]}; not linked (${hits.length} name matches)`); }
  }
  // Reports under the school's EARLIER reference. The third digit of a DE
  // reference is the management type, so a school that changes it (most often
  // on becoming Controlled Integrated) gets a new reference — 311-0037 Ballymena
  // Nursery School is now 315-0037 Ballymena Integrated Nursery School — and
  // ETI's reports from before the change stay filed under the old one. Without
  // this, the pane said "No ETI inspection report since 2016" for schools ETI
  // had inspected (8 of them, found in the Sept 2026 repair). Taken only for a
  // school with no report under its own reference, from a reference that is
  // the same but for that digit, is not on the current register, fits the
  // school's phase, and whose report title names the school.
  const earlier = new Map();   // school id -> Set of report slugs found under an earlier reference
  for (const s of open) {
    if (reports.get(s.id).length) continue;
    for (const rec of earlierReferenceReports(s, eti.byRef, onRegister)) {
      reports.get(s.id).push(rec);
      if (!earlier.has(s.id)) earlier.set(s.id, new Set());
      earlier.get(s.id).add(rec[1]);
      ctx.log(`  ETI ${rec[1]}: filed under ${rec[2]}, the earlier reference of "${s.name}" (${s.id})`);
    }
  }

  const out = [];
  for (const r of register) {
    const deType = r.Type;
    if (deType === 'Further Education') { ctx.stat('dropped.furtherEducation'); continue; }
    if (!TYPE_LABEL[deType]) { ctx.stat(`dropped.unknownType.${deType}`); ctx.warn(`unknown DE type "${deType}" (${r['Institution Reference Number']}) — not drawn`); continue; }
    if (r.Status !== 'Open') { ctx.stat('dropped.notOpen'); continue; }
    const id = normRef(r['Institution Reference Number']);
    const postcode = tidyPostcode(r.Postcode);
    const point = coordsDoc.coords[id];
    if (!point) { ctx.stat('unmapped.noPublishedLocation'); continue; }
    if (normPostcode(point[2]) !== normPostcode(postcode)) { ctx.stat('unmapped.movedSincePublishedLocation'); continue; }
    // DE's point contradicted by two independent internal references (see
    // _de-schoolsplus.mjs): a stale point is not a published location.
    if (coordsDoc.meta.withheld?.[id]) { ctx.stat('unmapped.publishedLocationContradicted'); continue; }

    const sector = deType === 'Independent' ? 'private' : 'state';
    const c = census.get(digits(id)) || {};
    const approved = ['Primary', 'Preps'].includes(deType) ? places.primary.get(digits(id))
      : ['Secondary', 'Grammar'].includes(deType) ? places.post.get(digits(id))
      : deType === 'Nursery' ? places.nursery.get(digits(id)) : undefined;
    if (census.has(digits(id))) ctx.stat('census.matched'); else ctx.stat('census.notInCensus');

    // The latest of this school's reports (newest date; ties by slug, so the
    // choice is deterministic).
    let best = null;
    for (const rec of reports.get(id) || []) if (!best || rec[0] > best[0] || (rec[0] === best[0] && rec[1] < best[1])) best = rec;
    let rating = best ? resolveEti(best, sector) : { ratingScheme: sector === 'private' ? 'ni-eti-indep' : 'ni-eti-none', rv: '', rd: '', ru: '' };
    let underEarlier = !!best && !!earlier.get(id)?.has(best[1]);
    // A newer report already in the tiles (found by an earlier monthly run)
    // wins over the vendored crawl.
    const prev = snap.get(id);
    if (prev?.rd && prev.ru && prev.rd > (rating.rd || '') && (sector === 'private') === (prev.ratingScheme === 'ni-eti-indep')) {
      rating = { ratingScheme: prev.ratingScheme, rv: prev.rv, rd: prev.rd, ru: prev.ru };
      underEarlier = ` ${prev.tags || ''} `.includes(` ${ETI_EARLIER_REF} `);
      ctx.stat('eti.fromSnapshot');
    }
    ctx.stat(`eti.${rating.ratingScheme}`);
    if (underEarlier) ctx.stat('eti.underEarlierReference');

    // eti-earlier-ref: the report shown was filed under the school's earlier
    // reference (a scheme note says so); it is not a filter and has no pane row.
    const tags = [deType === 'Grammar' && 'grammar', deType === 'Preps' && 'prep', c.irish && 'irish-medium', underEarlier && ETI_EARLIER_REF].filter(Boolean).join(' ');
    out.push({
      src: 'de', id, name: r['Institution Name'].replace(/\s+/g, ' ').trim(), postcode,
      lat: point[0], lng: point[1], juris: JURIS,
      type: TYPE_LABEL[deType], sector, stage: niStage(deType), phase: deType, tags,
      gender: '', boarding: false,   // DE publishes neither as a declared field (never derived from pupil counts)
      span: c.span || '', pupils: c.pupils ?? null, pupilsAsOf: '', capacity: approved ?? null,
      meals: c.fsme ?? null, mealsKind: c.fsme != null ? 'fsme' : '',
      // Governance, shown in the pane only (owner decision Q3). Independent
      // schools are all "Other" on the register, which says nothing.
      trust: sector === 'private' ? '' : r.Management,
      area: titleCase(r.Town),
      ...rating,
    });
  }
  const newest = out.reduce((m, r) => (r.rd > m ? r.rd : m), '');
  const regDate = (ctx.provenance.find(p => p.file === 'schools-plus-open.csv')?.fetchedAt || new Date().toISOString()).slice(0, 10);
  ctx.vintage(`DE register ${regDate}; school census ${CENSUS.year} (${CENSUS.date}); available places ${CENSUS.year}; ETI reports to ${newest || 'n/a'}`);
  return out;
}

// ── position check (verify-schools): DE point vs current postcode centroid ──
// An INTERNAL check only: postcodes.io serves ONS/LPS postcode centroids,
// which are never published on the map. A DE point for the school's own
// building should sit within a short walk of its postcode's centroid.
async function verify(rows, { haversine }) {
  const list = rows.filter(r => r.juris === JURIS && r.postcode);
  const found = new Map();
  for (let i = 0; i < list.length; i += 100) {
    const batch = list.slice(i, i + 100);
    const res = await fetch('https://api.postcodes.io/postcodes', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ postcodes: batch.map(p => p.postcode) }), signal: AbortSignal.timeout(60_000),
    });
    if (!res.ok) throw new Error(`postcodes.io HTTP ${res.status}`);
    for (const r of (await res.json()).result || []) if (r.result?.latitude != null) found.set(normPostcode(r.query), r.result);
  }
  const off = list.map(p => { const ref = found.get(normPostcode(p.postcode)); return ref && { id: p.id, name: p.name, m: haversine(p.lat, p.lng, ref.latitude, ref.longitude) }; })
    .filter(Boolean).sort((a, b) => a.m - b.m);
  if (off.length < 50) return [{ juris: JURIS, check: 'position', pass: false, message: `only ${off.length} of ${list.length} postcodes resolved — too few to conclude anything` }];
  const q = f => off[Math.floor((off.length - 1) * f)].m;
  const far = off.filter(o => o.m > 1000);
  const LIMIT = 200;
  return [{
    juris: JURIS, check: 'position', reference: 'postcodes.io postcode centroids (internal check; not published)', pass: q(0.5) <= LIMIT,
    message: `${off.length} of ${list.length} schools: median ${q(0.5).toFixed(0)} m, p90 ${q(0.9).toFixed(0)} m, worst ${off[off.length - 1].m.toFixed(0)} m (${off[off.length - 1].id} ${off[off.length - 1].name}); ${far.length} over 1 km; limit median ${LIMIT} m`,
  }];
}

// ── offline invariants (verify-schools): no ETI report left unlinked ─────────
// Every drawn school whose pane says "No ETI inspection report since 2016" must
// really have none in the vendored crawl — under its own reference, or under
// an earlier one (same area and number, another management digit) whose title
// names it. And a row tagged eti-earlier-ref must show a report ETI filed
// under such a reference. (The Sept 2026 repair found 8 schools that said "no
// report" while ETI had published one under their earlier reference.)
function invariants(rows) {
  const vend = readVendored();
  if (!vend) return [{ name: 'NI ETI links', problems: ['tools/data/schools/ni/eti-reports.json is missing'], ok: '' }];
  const byRef = new Map(), bySlug = new Map();
  for (const rec of vend.reports) { bySlug.set(rec[1], rec); for (const ref of rec[2].split(' ')) (byRef.get(ref) || byRef.set(ref, []).get(ref)).push(rec); }
  const ids = new Set(rows.map(r => r.id));
  const probs = [];
  let none = 0, earlierN = 0;
  for (const r of rows) {
    const school = { id: r.id, type: r.phase, name: r.name };
    if (r.ratingScheme === 'ni-eti-none') {
      none++;
      const own = (byRef.get(r.id) || []).filter(rec => rec[3].split(', ').some(p => (COMPAT[r.phase] || []).includes(p)));
      const sib = earlierReferenceReports(school, byRef, ids);
      if (own.length) probs.push(`${r.id} ${r.name}: says no report, but ETI filed ${own[0][1]} under its own reference`);
      if (sib.length) probs.push(`${r.id} ${r.name}: says no report, but ETI filed ${sib[0][1]} under ${sib[0][2]}`);
    }
    if (` ${r.tags || ''} `.includes(` ${ETI_EARLIER_REF} `)) {
      earlierN++;
      const rec = bySlug.get(r.ru);
      if (!rec || rec[2].split(' ').includes(r.id) || !earlierReferenceReports(school, byRef, ids).some(x => x[1] === r.ru)) probs.push(`${r.id}: tagged ${ETI_EARLIER_REF}, but its report ${r.ru} is not one filed under an earlier reference`);
    }
  }
  return [{ name: 'NI ETI links', problems: probs,
    ok: `${none} NI schools say "no ETI report since 2016" and none has one under its own or an earlier reference; ${earlierN} show a report filed under their earlier reference` }];
}

// ── wording (copied into index.json) ────────────────────────────────────────
const ETI_BASE = {
  kind: 'status',
  title: 'Latest ETI inspection report',
  short: '(date published)',
  scale: 'An inspection report, not a rating. The Education and Training Inspectorate stopped giving grades in September 2024; each report now ends with its own conclusion and next steps.',
  measures: 'Only the kind of report and the date it was published are shown here; the report itself gives the findings.',
  year: 'since 2016',
  publisher: 'Education and Training Inspectorate',
  url: LISTING_URL,
  values: REPORT_TYPES,
  // For /check/: the per-school report link (row.ru = the publication slug).
  link: { url: REPORT_URL, label: 'Read the report' },
};
const PREVIOUS = "Made under ETI's previous framework, which has been replaced; its conclusions are not shown here.";
const ASOS = "This inspection took place during teachers' action short of strike, and many reports from that period give no judgement.";
// Rows tagged eti-earlier-ref (see earlierReferenceReports).
const EARLIER = { when: { tag: 'eti-earlier-ref' },
  html: "ETI filed this report under the reference the school had before its management type changed, so the report may give the school's name at the time." };

export default {
  id: 'de',
  juris: [JURIS],
  cadence: 'monthly',
  meta: {
    name: 'DE Schools Plus register, school census and available places (Northern Ireland); ETI inspection reports',
    publisher: 'Department of Education (Northern Ireland); Education and Training Inspectorate',
    licence: OGL,
    licenceUrl: 'https://www.nationalarchives.gov.uk/doc/open-government-licence/version/3/',
    attribution: `DE reference {id} · Department of Education (Northern Ireland); Education and Training Inspectorate. Contains public sector information licensed under the ${OGL}.`,
    where: 'Northern Ireland',
    publishes: [],
    pupilsAsOf: CENSUS.date,
    labels: {
      // phase: '' hides the Level row: for Northern Ireland the Type row already
      // gives DE's type, and phase only repeats it.
      type: 'Type', phase: '', span: 'Year groups', pupils: 'Pupils', capacity: `Approved enrolment ${CENSUS.year}`,
      meals: { fsme: 'Free school meals entitlement' }, tags: { 'irish-medium': 'Irish-medium' },
      trust: 'Management type',
      // DE: approved enrolment "for primary schools ... relates to pupils from
      // reception to Year 7 but excludes nursery pupils"; the census total
      // includes them, so the two are not a "pupils of places" pair.
      pupilsAsOf: `Pupils and year groups from the DE school census, {date}. Approved enrolment is for ${CENSUS.year}; for primary schools it excludes nursery classes.`,
    },
  },
  schemes: {
    'ni-eti': { ...ETI_BASE, notes: [EARLIER] },
    'ni-eti-prev': { ...ETI_BASE, caveat: PREVIOUS, notes: [EARLIER] },
    'ni-eti-asos': { ...ETI_BASE, caveat: `${ASOS} ${PREVIOUS}`, notes: [EARLIER] },
    'ni-eti-asos-cur': { ...ETI_BASE, caveat: "ETI's report title says this inspection involved teachers' action short of strike.", notes: [EARLIER] },
    'ni-eti-none': { kind: 'none', notes: [{ html: 'No ETI inspection report since 2016 is linked to this school.' }] },
    'ni-eti-indep': {
      kind: 'none', link: { url: REPORT_URL, label: 'Read the latest ETI report' },
      // ETI's registration inspections check, under Article 38 of the Education
      // and Libraries (NI) Order 1986, whether a school gives efficient and
      // suitable instruction and is safe; they are not graded here.
      notes: [{ html: 'A private (independent) school. The Education and Training Inspectorate inspects independent schools, including when they register with the Department of Education; no grade is shown here.' }],
    },
  },
  fetch: fetchRows,
  verify,
  invariants,
};
