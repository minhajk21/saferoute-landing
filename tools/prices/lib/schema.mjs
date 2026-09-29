// The home-prices contract in code: the tile row, the flags, what a source
// module must declare, and what every area it returns must look like.
// tools/prices/README.md is the prose version; build-prices, run-source and
// verify-prices all check against THIS file, so the three can never disagree.
//
// Discovery is by file, not a registry (the schools rule): a source is
// tools/prices/sources/<id>.mjs, and files starting with "_" are helpers.

import { readdirSync, existsSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { processPolys, bboxOf, bboxIntersects } from './geo.mjs';
import { WINDOW_BY, MIN_COLOUR_N, MAX_WINDOW_MONTHS, CONTEXT_FLAGS } from './sales.mjs';
import { scalesFor } from '../regions.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
export const SOURCES_DIR = join(HERE, '..', 'sources');
export const INDEX_VERSION = 1;

// One tile row, in this order (index.json `fields`). Indices, not names, for
// src/region/scale/context: a row repeats none of the long strings.
//   src      index into Object.keys(index.sources) — insertion order, which
//            JSON.parse keeps for these non-numeric keys
//   region   index into index.regions;  scale: index into index.scales
//   ctx      index into the tile's own `c` array, or null
//   polys    [[outerRing, hole, ...], ...] encoded rings (lib/geo.mjs)
//   iqr      [25th, 75th percentile] of a sale-price area's sales (the pane's
//            "Middle half"), else null. Added after the first release, at the
//            END of the row, so every earlier index still resolves by name.
export const FIELDS = ['src', 'id', 'name', 'region', 'scale', 'value', 'moe', 'n', 'flags', 'ctx', 'polys', 'iqr'];
// Fields added since the first published tile set. A snapshot written before
// one existed lacks it and reads it as null (readAreasFromTiles); the page
// reads rows by name, so it takes either.
export const ADDED_FIELDS = ['iqr'];
// What a context line may carry: its label, the figure, its 90% margin of
// error, a count, and flags about the figure (top- or bottom-coded, too
// uncertain), all of the context's own source.
export const CONTEXT_KEYS = ['label', 'value', 'moe', 'n', 'flags'];

// Flags travel as one integer. Suppressed, uncertain, few and bottom-coded
// make an area NEUTRAL (the "no figure" fill); top-coded still takes its class
// (the top). Bottom-coded (16, beyond the contract's four) is ACS's "less than
// $10,000": the value is kept as published (9,999) so the page can say that,
// but a figure known only to be under a floor is not coloured.
export const FLAG_BITS = { suppressed: 1, uncertain: 2, topcoded: 4, few: 8, bottomcoded: 16 };
export const NEUTRAL_BITS = FLAG_BITS.suppressed | FLAG_BITS.uncertain | FLAG_BITS.few | FLAG_BITS.bottomcoded;
export const flagsToBits = flags => flags.reduce((b, f) => b | FLAG_BITS[f], 0);
export const bitsToFlags = bits => Object.keys(FLAG_BITS).filter(f => bits & FLAG_BITS[f]);
export const isColoured = a => a.value != null && !(flagsToBits(a.flags) & NEUTRAL_BITS);
// No figure and no flag: the publisher gives nothing for the area (an ACS
// jam value, a StatCan blank), which the page does not draw at all ("not
// drawn if nothing was published"); a withheld figure is flagged suppressed
// and drawn grey. Kept in the tiles so the report can say "no figure".
export const isUnpublished = a => a.value == null && !a.flags.length;

// An ACS-style margin of error is at the 90% level: CV = MOE / 1.645 / value.
// Above this the value is shown with its margin but never coloured.
export const MAX_CV = 0.30;
export const cvOf = a => (a.moe != null && a.value > 0 ? a.moe / 1.645 / a.value : null);

// Never in a tile, whatever a source's raw file calls it (house rule 9, and
// the PPD address-data clause), nor anything of a single sale: where it is,
// when, for how much, or the parcel it was (SPEC2 §B.6).
const FORBIDDEN = 'address|postcode|paon|saon|street|lat|lng|lon|latitude|longitude|bbl|ssl|parcel|parcelid|pin|price|date|sales';
export const FORBIDDEN_FIELD = new RegExp(`^(${FORBIDDEN})$`, 'i');
export const FORBIDDEN_IN_TEXT = new RegExp(`"(${FORBIDDEN})"\\s*:`, 'i');

// ── what index.json sources[id] may carry ──────────────────────────────────
// An ALLOWLIST, not a denylist: a source entry is copied from the module's
// meta, which a module can add to at fetch time (nyc-dof-sales rewrites its
// meta with the versions it read), so a field nobody listed here would reach
// the published index unchecked, and a sample of sales under an innocent name
// ("examples") would pass every forbidden-name check. The build refuses an
// entry with anything else (nothing written), and verify-prices re-checks the
// published copy against the same lists.
//   meta     the module's own fields (the contract's, and the optional ones)
//   build    what the build adds about the build
//   upstream one downloaded file's provenance (ctx.download's record, plus
//            where / item / queries: dc-cama-sales describes an ArcGIS query
//            it made page by page as one record)
export const META_KEYS = ['name', 'publisher', 'url', 'licence', 'licenceUrl', 'attribution', 'metric', 'unitNoun', 'currency', 'period',
  'notes', 'areaNoun', 'colourMinN', 'credit', 'nEstimate', 'licences', 'contextLabel', 'window'];
export const ENTRY_BUILD_KEYS = ['kind', 'geometry', 'covers', 'cadence', 'regions', 'vintage', 'status', 'fetched', 'upstream', 'inputs', 'stats'];
export const UPSTREAM_KEYS = ['file', 'url', 'status', 'lastModified', 'etag', 'fetchedAt', 'bytes', 'sha256', 'ua', 'where', 'item', 'queries'];
export const STATS_KEYS = ['areas', 'coloured', 'neutral', 'unpublished', 'dropped', 'sales', 'replaced'];
const WINDOW_KEYS = ['months', 'by', 'lagMonths', 'from', 'to', 'span'];
const isCount = v => Number.isInteger(v) && v >= 0;
const isCounts = o => !!o && typeof o === 'object' && !Array.isArray(o) && Object.values(o).every(isCount);
// Single-sale detail in a sale source's own words (notes, attribution): an
// exact money amount (not a whole thousand: "$812,345"), a run of 9+ digits
// (a parcel id such as a BBL), or a code of 8+ capitals and digits holding 5+
// digits (Mecklenburg's 8-character PIDs, "07101234", "17332C99"). The rules'
// own figures ("$10,000", "$1,000") pass. A heuristic for text; the lists
// above are the real guard. (A bare "$1"-"$999" is no home's price: it is
// where "$1.5 million" stops.)
const SALE_DETAIL_IN_TEXT = /[$£]\s?\d{1,3}(?:,\d{3})*(?:\.\d+)?(?<!,000)(?!,?\d)(?! (?:thousand|million))|\d{9,}|\b(?=(?:[0-9A-Z]*\d){5})[0-9A-Z]{8,}\b/g;
const saleDetail = t => [...t.matchAll(SALE_DETAIL_IN_TEXT)].map(m => m[0]).find(x => !/^[$£]\s?\d{1,3}$/.test(x)) ?? null;
// A sale's day in a sale source's NOTES ("2026-05-15", "15 May 2026", "May
// 15, 2026", "5/15/2026"): a note speaks of months and periods, never of the
// day something sold. (Attribution lines may date a dataset's version: NYC's
// "data as of 2026-09-15".)
const MONTHS = '(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)[a-z]*';
const DAY_IN_TEXT = new RegExp(`\\b\\d{4}-\\d{2}-\\d{2}\\b|\\b\\d{1,2}/\\d{1,2}/\\d{2,4}\\b|\\b\\d{1,2}(?:st|nd|rd|th)? ${MONTHS} \\d{4}\\b|\\b${MONTHS} \\d{1,2}(?:st|nd|rd|th)?,? \\d{4}\\b`);
// Where a merged or query-string upstream record could carry a sale's parcel:
// its query (the URL after "?", decoded, and `where`). Ids in a query are a
// run of 9+ digits (Denver's schedule numbers, Hennepin's PIDs), a quoted
// code of 8+ capitals and digits with 5+ digits (Mecklenburg's PIDs), or an
// IN (...) list holding any code with 5+ digits. Maryland's IN list of county
// codes ('ANNE', 'BACO', …) and CT's town names pass.
// (A query that will not decode is read as it stands, never skipped.)
const queryOf = url => {
  const q = String(url).includes('?') ? String(url).slice(String(url).indexOf('?') + 1) : '';
  try { return decodeURIComponent(q.replace(/\+/g, ' ')); } catch { return q; }
};
function idsInQuery(q) {
  const hit = q.match(/\d{9,}/) || q.match(/'(?=(?:[0-9A-Z]*\d){5})[0-9A-Z]{8,}'/);
  if (hit) return hit[0];
  for (const m of q.matchAll(/\bIN\s*\(([^)]*)\)/gi)) {
    const id = m[1].split(',').map(x => x.trim().replace(/^'|'$/g, '')).find(x => (x.match(/\d/g) || []).length >= 5);
    if (id) return `IN (…${id}…)`;
  }
  return null;
}

// Problems with one sources[id] entry as it is (or will be) published.
export function entryProblems(id, e) {
  const p = [], bad = m => p.push(`${id}: ${m}`);
  if (!e || typeof e !== 'object') return [`${id}: not an object`];
  const extra = Object.keys(e).filter(k => !META_KEYS.includes(k) && !ENTRY_BUILD_KEYS.includes(k));
  if (extra.length) bad(`field(s) no contract lists: ${extra.join(', ')} (lib/schema.mjs META_KEYS / ENTRY_BUILD_KEYS)`);
  // Every key at every depth, against the names of single-sale fields (list
  // items as one: examples[].price). The one allowed: stats.sales, the counts
  // { received, used }.
  const named = new Set();
  const walk = (v, path) => {
    if (Array.isArray(v)) { for (const x of v) walk(x, `${path}[]`); return; }
    if (!v || typeof v !== 'object') return;
    for (const [k, x] of Object.entries(v)) {
      const at = path ? `${path}.${k}` : k;
      if (FORBIDDEN_FIELD.test(k) && at !== 'stats.sales') named.add(at);
      walk(x, at);
    }
  };
  walk(e, '');
  if (named.size) bad(`carries field(s) named for sale-level data: ${[...named].slice(0, 8).join(', ')}${named.size > 8 ? ', …' : ''}`);
  if (e.upstream != null) {
    if (!Array.isArray(e.upstream)) bad('upstream must be a list of file records');
    else e.upstream.forEach((r, i) => {
      if (!r || typeof r !== 'object' || Array.isArray(r)) { bad(`upstream[${i}] is not a record`); return; }
      const x = Object.keys(r).filter(k => !UPSTREAM_KEYS.includes(k));
      if (x.length) bad(`upstream[${i}] has field(s) ${x.join(', ')} (allowed: ${UPSTREAM_KEYS.join(', ')})`);
      if (Object.values(r).some(v => v !== null && !['string', 'number', 'boolean'].includes(typeof v))) bad(`upstream[${i}] holds a value that is not a plain string or number`);
      // The free-text fields a module fills. A record that merges many
      // queries (`queries`) names its layer, never one query: an un-merged
      // page list would publish every parcel it looked up.
      if (r.queries != null && typeof r.url === 'string' && r.url.includes('?')) bad(`upstream[${i}] merges ${r.queries} queries but its url carries one query's string; give the bare layer URL`);
      if (r.item != null && !(typeof r.item === 'string' && /^[0-9a-f]{32}$/.test(r.item))) bad(`upstream[${i}].item must be an ArcGIS item id (32 hex characters)`);
      for (const k of ['url', 'where']) {
        if (r[k] == null) continue;
        const id = idsInQuery(k === 'url' ? queryOf(r[k]) : String(r[k]));
        if (id) bad(`upstream[${i}].${k} reads like it names a property ("${id}"): an upstream record may say how a layer was queried, never which parcels`);
      }
    });
  }
  const st = e.stats;
  if (st != null) {
    if (typeof st !== 'object' || Array.isArray(st)) bad('stats must be an object of counts');
    else {
      const x = Object.keys(st).filter(k => !STATS_KEYS.includes(k));
      if (x.length) bad(`stats has field(s) ${x.join(', ')} (allowed: ${STATS_KEYS.join(', ')})`);
      for (const k of ['areas', 'coloured', 'neutral', 'unpublished']) if (st[k] != null && !isCount(st[k])) bad(`stats.${k} is not a count`);
      for (const k of ['dropped', 'replaced']) if (st[k] != null && !isCounts(st[k])) bad(`stats.${k} must be { reason: count }`);
      // A reason is a camelCase word ("outOfWindow"), and a hand-over is
      // counted by source id: neither can be a parcel id or an address.
      if (isCounts(st.dropped)) { const k = Object.keys(st.dropped).find(r => !/^[a-z]+(?:[A-Z][a-z]*)*$/.test(r)); if (k) bad(`stats.dropped reason "${k}" is not a camelCase word`); }
      if (isCounts(st.replaced)) { const k = Object.keys(st.replaced).find(r => !/^[a-z][a-z0-9-]*$/.test(r)); if (k) bad(`stats.replaced key "${k}" is not a source id`); }
      if (st.sales != null && !(isCounts(st.sales) && Object.keys(st.sales).every(k => ['received', 'used'].includes(k)))) bad('stats.sales must be { received, used } counts');
    }
  }
  if (e.window != null && (typeof e.window !== 'object' || Object.keys(e.window).some(k => !WINDOW_KEYS.includes(k)))) bad(`window may hold only ${WINDOW_KEYS.join(', ')}`);
  if (e.covers != null && (typeof e.covers !== 'object' || Object.keys(e.covers).some(k => !['juris', 'counties'].includes(k)) ||
      Object.values(e.covers).some(v => !Array.isArray(v) || v.some(x => typeof x !== 'string')))) bad('covers may hold only juris and counties, lists of codes');
  else if (e.covers != null && ((e.covers.juris || []).some(x => !/^[A-Z]{2}-[A-Z0-9]{1,3}$/.test(x)) || (e.covers.counties || []).some(x => !/^\d{5}$/.test(x)))) bad('covers.juris must be ISO 3166-2 codes and covers.counties 5-digit state+county FIPS codes');
  if (e.licences != null && Array.isArray(e.licences) && e.licences.some(l => !l || Object.keys(l).some(k => !['licence', 'licenceUrl'].includes(k)))) bad('licences entries may hold only licence and licenceUrl');
  if (e.regions != null && (!Array.isArray(e.regions) || e.regions.some(r => typeof r !== 'string'))) bad('regions must be a list of region ids');
  for (const k of ['name', 'publisher', 'url', 'licence', 'licenceUrl', 'metric', 'unitNoun', 'currency', 'period', 'areaNoun', 'credit', 'contextLabel',
    'kind', 'geometry', 'cadence', 'vintage', 'status', 'fetched', 'inputs']) if (e[k] != null && typeof e[k] !== 'string') bad(`${k} must be text`);
  if (e.kind === 'point-sales') {
    for (const t of [...(e.notes || []), ...(e.attribution || [])]) {
      const d = typeof t === 'string' ? saleDetail(t) : null;
      if (d) bad(`a note or attribution line reads like a single sale's detail ("${d}")`);
    }
    for (const t of e.notes || []) {
      const d = typeof t === 'string' ? t.match(DAY_IN_TEXT) : null;
      if (d) bad(`a note names a day ("${d[0]}"): a sale source's notes speak of months, never of the day a sale was made`);
    }
  }
  return p;
}

// 'areas': the source publishes a figure per area (ONS, ACS, StatCan, NI).
// 'point-sales': it returns individual sales, which the build places in a
// geometry source's areas and aggregates (lib/sales.mjs).
export const KINDS = ['areas', 'point-sales'];
export const isSales = s => s?.kind === 'point-sales';
// monthly: sale feeds, refetched every run (see tools/build-prices.mjs CADENCE).
export const CADENCES = ['annual', 'semiannual', 'monthly', 'static'];
const META_REQUIRED = ['name', 'publisher', 'url', 'licence', 'licenceUrl', 'attribution', 'metric', 'unitNoun', 'currency', 'period', 'areaNoun'];
// A sale source's period is the window the build finds in its data, and its
// area noun is its geometry source's: neither is the module's to state.
const SALES_FILLED = ['period', 'areaNoun'];

// Honesty checks on a metric label (house rule 2): a median is never called
// an average or a mean, and an owners' estimate is never called a price.
export function metricProblems(metric) {
  const p = [];
  if (/\b(average|mean)\b/i.test(metric)) p.push(`metric "${metric}" says average/mean; these are medians`);
  if (/estimate/i.test(metric) && /\bprice/i.test(metric)) p.push(`metric "${metric}" calls an owners’ estimate a price`);
  if (!/median/i.test(metric)) p.push(`metric "${metric}" does not say median`);
  return p;
}

// Problems with one source's meta block ([] when clean). Shared with verify,
// which runs it on index.json's copy (published: the build's fields are there
// too, so a sale source's period and window are checked in full).
export function metaProblems(m = {}, kind = 'areas', { published = false } = {}) {
  const p = [];
  const sales = kind === 'point-sales';
  for (const k of META_REQUIRED) {
    if (sales && !published && SALES_FILLED.includes(k)) continue;
    if (m[k] == null || m[k] === '' || (Array.isArray(m[k]) && !m[k].length)) p.push(`meta.${k} is required`);
  }
  if (m.licenceUrl && !/^https:\/\//.test(m.licenceUrl)) p.push('meta.licenceUrl must be an https link (the pane links the licence)');
  if (m.url && !/^https?:\/\//.test(m.url)) p.push('meta.url must be a link');
  if (m.attribution && (!Array.isArray(m.attribution) || m.attribution.some(l => typeof l !== 'string' || !l.trim()))) p.push('meta.attribution must be a list of exact lines');
  if (m.notes && (!Array.isArray(m.notes) || m.notes.some(l => typeof l !== 'string'))) p.push('meta.notes must be a list of strings');
  if (m.currency && !/^[A-Z]{3}$/.test(m.currency)) p.push(`meta.currency "${m.currency}" is not ISO 4217`);
  if (m.colourMinN != null && !(Number.isInteger(m.colourMinN) && m.colourMinN > 0)) p.push('meta.colourMinN must be a positive integer or null');
  // Optional, beyond the contract's list:
  //   credit     the short form of the attribution the map's credit line
  //              shows while the source is in view ("ONS, HM Land Registry,
  //              OS"); it links to the full lines. Default: publisher.
  //   nEstimate  true when n is itself a survey estimate (of how many homes
  //              the area has), not the count the figure was computed from, so
  //              the page never writes "based on N".
  //   licences   further licences an attribution line names, [{ licence,
  //              licenceUrl }], linked where the line names them.
  if (m.credit != null && (typeof m.credit !== 'string' || !m.credit.trim())) p.push('meta.credit must be a non-empty string when given');
  if (m.nEstimate != null && typeof m.nEstimate !== 'boolean') p.push('meta.nEstimate must be true or false when given');
  if (m.licences != null && (!Array.isArray(m.licences) || m.licences.some(l => !l?.licence || !/^https:\/\//.test(l.licenceUrl || '')))) p.push('meta.licences must be a list of { licence, licenceUrl (https) }');
  if (m.metric) p.push(...metricProblems(m.metric));
  if (m.contextLabel != null && (typeof m.contextLabel !== 'string' || !m.contextLabel.trim())) p.push('meta.contextLabel must be a non-empty string when given');
  if (sales) p.push(...salesMetaProblems(m, published));
  else if (m.window != null) p.push('meta.window is for point-sales sources only');
  return p;
}

// A sale source's own promises (SPEC2 §B): a window it chose and says the
// date of, colour only from 10 sales, and a metric that is a sale price.
//   window: { months, by: 'sale' | 'recording', lagMonths? }
// published: the build has added from, to and span.
function salesMetaProblems(m, published) {
  const p = [], w = m.window;
  if (!w || typeof w !== 'object') p.push("meta.window is required: { months, by: 'sale' | 'recording', lagMonths? }");
  else {
    if (!(Number.isInteger(w.months) && w.months >= 1 && w.months <= MAX_WINDOW_MONTHS)) p.push(`meta.window.months must be a whole number of months, 1–${MAX_WINDOW_MONTHS}`);
    if (!WINDOW_BY.includes(w.by)) p.push(`meta.window.by must say which date the window is by: ${WINDOW_BY.map(x => `'${x}'`).join(' or ')} (the period label says "recorded" or "dated" from it)`);
    if (w.lagMonths != null && !(Number.isInteger(w.lagMonths) && w.lagMonths >= 0 && w.lagMonths <= 24)) p.push('meta.window.lagMonths must be a whole number of months, 0–24');
    const allowed = ['months', 'by', 'lagMonths', ...(published ? ['from', 'to', 'span'] : [])];
    const extra = Object.keys(w).filter(k => !allowed.includes(k));
    if (extra.length) p.push(`meta.window has field(s) ${extra.join(', ')} (allowed: ${allowed.join(', ')})`);
    if (published && !(/^\d{4}-\d{2}$/.test(w.from || '') && /^\d{4}-\d{2}$/.test(w.to || '') && w.from <= w.to && typeof w.span === 'string')) p.push('meta.window must carry the from/to/span the build found');
  }
  if (!(Number.isInteger(m.colourMinN) && m.colourMinN >= MIN_COLOUR_N)) p.push(`meta.colourMinN must be a whole number of at least ${MIN_COLOUR_N}: no tract is coloured on fewer sales`);
  if (m.metric && !/\b(sale price|price paid)\b/i.test(m.metric)) p.push(`metric "${m.metric}" does not name a sale price ("Median sale price")`);
  if (m.nEstimate) p.push('meta.nEstimate: a sale source counts the sales behind each figure, never an estimate');
  return p;
}

export async function loadSources(dir = SOURCES_DIR) {
  if (!existsSync(dir)) return [];
  const list = [];
  for (const f of readdirSync(dir).filter(f => f.endsWith('.mjs') && !f.startsWith('_')).sort()) list.push(await loadSource(join(dir, f)));
  return list;
}

// One module, checked against the contract (run-source loads just the one it
// is asked for, so a half-written neighbour cannot stop it).
export async function loadSource(path) {
  const f = basename(path);
  const s = (await import(pathToFileURL(path).href)).default;
  const bad = m => { throw new Error(`sources/${f}: ${m} (see tools/prices/README.md)`); };
  if (!s) bad('no default export');
  // A leading letter keeps ids non-numeric, so Object.keys(index.sources)
  // keeps build order (the tile's src index relies on it).
  if (!/^[a-z][a-z0-9-]*$/.test(s.id || '')) bad(`id "${s.id}" must be lower-case letters, digits and "-", starting with a letter`);
  if (basename(f, '.mjs') !== s.id) bad(`the file must be named after its id ("${s.id}.mjs")`);
  if (s.kind != null && !KINDS.includes(s.kind)) bad(`kind "${s.kind}" (want ${KINDS.join(' | ')}; omitted means 'areas')`);
  const kind = s.kind || 'areas';
  if (!Array.isArray(s.regions) || !s.regions.length) bad('regions must list the coverage ids it serves');
  if (!CADENCES.includes(s.cadence)) bad(`cadence "${s.cadence}" (want ${CADENCES.join(' | ')})`);
  if (typeof s.fetch !== 'function') bad('no fetch(ctx)');
  if (s.probe != null && typeof s.probe !== 'function') bad('probe, when given, must be a function');
  if (kind === 'point-sales' && !/^[a-z][a-z0-9-]*$/.test(s.geometry || '')) bad('geometry must name the source whose areas its sales are aggregated onto (e.g. "acs-tract")');
  if (kind !== 'point-sales' && s.geometry != null) bad('geometry is for point-sales sources only');
  const mp = metaProblems(s.meta, kind);
  if (mp.length) bad(mp.join('; '));
  return s;
}
// A source's kind, 'areas' when the module leaves it out.
export const kindOf = s => s?.kind || 'areas';

const isNum = v => typeof v === 'number' && Number.isFinite(v);
const isPair = p => Array.isArray(p) && p.length >= 2 && isNum(p[0]) && isNum(p[1]) && p[0] >= -180 && p[0] <= 180 && p[1] >= -90 && p[1] <= 90;

// Problems with one area as a source returned it ([] when clean). `src` is
// the module; `raw` false skips the polys check (a snapshot area already
// carries encoded rings).
export function areaProblems(a, src, { raw = true } = {}) {
  const p = [];
  if (!a || typeof a !== 'object') return ['not an object'];
  if (typeof a.id !== 'string' || !a.id) p.push('id must be a non-empty string');
  if (a.name !== null && (typeof a.name !== 'string' || !a.name.trim())) p.push('name must be the official name, or null');
  if (!src.regions.includes(a.region)) p.push(`region "${a.region}" is not one of the source's regions`);
  if (typeof a.juris !== 'string' || !/^[A-Z]{2}-[A-Z0-9]{1,3}$/.test(a.juris)) p.push(`juris "${a.juris}" is not ISO 3166-2`);
  if (typeof a.scale !== 'string' || !a.scale) p.push('no scale key');
  if (a.value !== null && !isNum(a.value)) p.push('value must be a number or null');
  if (isNum(a.value) && a.value <= 0) p.push(`value ${a.value} <= 0`);
  if (a.moe !== null && !(isNum(a.moe) && a.moe >= 0)) p.push('moe must be a non-negative number or null');
  if (a.n !== null && !(Number.isInteger(a.n) && a.n >= 0)) p.push('n must be a non-negative integer or null');
  if (!Array.isArray(a.flags) || a.flags.some(f => !(f in FLAG_BITS))) p.push(`flags ${JSON.stringify(a.flags)} (allowed: ${Object.keys(FLAG_BITS).join(', ')})`);
  else {
    if (new Set(a.flags).size !== a.flags.length) p.push('repeated flag');
    if (a.flags.includes('suppressed') && a.value !== null) p.push('a suppressed area carries a value');
    for (const f of ['uncertain', 'topcoded', 'few', 'bottomcoded']) if (a.flags.includes(f) && a.value === null) p.push(`"${f}" without a value`);
    if (a.flags.includes('topcoded') && a.flags.includes('bottomcoded')) p.push('both top- and bottom-coded');
    const cv = cvOf(a);
    if (cv != null && cv > MAX_CV && !a.flags.includes('uncertain') && !a.flags.includes('suppressed')) p.push(`CV ${cv.toFixed(2)} > ${MAX_CV} but not flagged uncertain`);
  }
  if (a.context !== null) {
    const c = a.context;
    if (!c || typeof c !== 'object' || typeof c.label !== 'string' || !c.label.trim()) p.push('context must be null or { label, value, moe?, n, flags? }');
    else {
      if (Object.keys(c).some(k => !CONTEXT_KEYS.includes(k))) p.push(`context has field(s) beyond ${CONTEXT_KEYS.join('/')}: ${Object.keys(c).join(', ')}`);
      if (c.value != null && !(isNum(c.value) && c.value > 0)) p.push('context.value must be a positive number or null');
      if (c.moe != null && !(isNum(c.moe) && c.moe >= 0)) p.push('context.moe must be a non-negative number or null');
      if (c.n != null && !(Number.isInteger(c.n) && c.n >= 0)) p.push('context.n must be a non-negative integer or null');
      if (c.flags != null && (!Array.isArray(c.flags) || c.flags.some(f => !CONTEXT_FLAGS.includes(f)))) p.push(`context.flags ${JSON.stringify(c.flags)} (allowed: ${CONTEXT_FLAGS.join(', ')})`);
    }
  }
  // The middle half of a sale-price area's sales: two ends around its median.
  if (a.iqr != null) {
    const q = a.iqr;
    if (!Array.isArray(q) || q.length !== 2 || !q.every(v => isNum(v) && v > 0) || q[0] > q[1]) p.push(`iqr ${JSON.stringify(q)} must be [25th, 75th percentile], both > 0, in order`);
    else if (a.value == null || a.value < q[0] || a.value > q[1]) p.push(`iqr ${JSON.stringify(q)} does not hold the median ${a.value}`);
  }
  if (raw) {
    if (!Array.isArray(a.polys) || !a.polys.length) p.push('polys must be a non-empty MultiPolygon');
    else if (!a.polys.every(poly => Array.isArray(poly) && poly.length && poly.every(r => Array.isArray(r) && r.length >= 3 && r.every(isPair)))) p.push('polys must be [[[lng, lat], ...] outer, holes...] per polygon, WGS84');
  }
  return p;
}

// Copy exactly the contract's fields (house rule: strip everything else at
// parse). Missing optional fields become null / [].
export const pickContext = c => (c ? { label: c.label, value: c.value ?? null, moe: c.moe ?? null, n: c.n ?? null, flags: [...(c.flags || [])] } : null);
export const pickArea = a => ({
  id: a.id, name: a.name ?? null, region: a.region, juris: a.juris, scale: a.scale,
  value: a.value ?? null, moe: a.moe ?? null, n: a.n ?? null, flags: [...(a.flags || [])],
  context: pickContext(a.context), iqr: a.iqr ? [...a.iqr] : null,
  polys: a.polys,
});

// What the build does with a freshly fetched area list, in one place
// (build-prices and run-source share it): check each area against the
// contract, apply R2 (the region's own jurisdictions, and an extent that
// reaches its rectangle), flag areas under meta.colourMinN as few (neutral,
// value kept), then simplify and encode (lib/geo.mjs). Violations are
// returned, not thrown, so the caller can list them all.
//   regions: { id: region } as lib/ctx.mjs loadRegions() gives them
export function prepareAreas(src, raws, regions, meta = src.meta) {
  const areas = [], violations = [], dropped = {}, seen = new Set();
  const geo = { rings: 0, ringsDropped: 0, pointsIn: 0, pointsOut: 0 };
  let few = 0;
  const drop = (k, n = 1) => { dropped[k] = (dropped[k] || 0) + n; };
  for (const raw of raws) {
    const a = pickArea(raw);
    const p = areaProblems(a, src);
    if (!p.length && !scalesFor(a.region).includes(a.scale)) p.push(`scale "${a.scale}" is not one of ${a.region}'s (${scalesFor(a.region).join(', ')})`);
    if (p.length) { violations.push(`${src.id} ${a.id || '?'}: ${p.join('; ')}`); continue; }
    const reg = regions[a.region];
    if (!reg.juris.includes(a.juris) || !bboxIntersects(bboxOf(a.polys), reg.bbox)) { drop('outsideScope'); continue; }
    if (seen.has(a.id)) { drop('duplicateId'); continue; }
    seen.add(a.id);
    if (meta.colourMinN && a.value != null && a.n != null && a.n < meta.colourMinN && !a.flags.includes('few')) { a.flags.push('few'); few++; }
    const g = processPolys(a.polys);
    for (const k of Object.keys(geo)) geo[k] += g.stats[k];
    if (!g.enc.length) { drop('noGeometry'); continue; }
    const { polys, ...rest } = a;
    areas.push({ ...rest, src: src.id, flags: bitsToFlags(flagsToBits(a.flags)), enc: g.enc, bbox: g.bbox });
  }
  if (geo.ringsDropped) drop('rings', geo.ringsDropped);
  return { areas, violations, dropped, geo, few };
}
