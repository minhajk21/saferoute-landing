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
export const FIELDS = ['src', 'id', 'name', 'region', 'scale', 'value', 'moe', 'n', 'flags', 'ctx', 'polys'];

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
// the PPD address-data clause).
export const FORBIDDEN_FIELD = /^(address|postcode|paon|saon|street)$/i;
export const FORBIDDEN_IN_TEXT = /"(address|postcode|paon|saon|street)"\s*:/i;

export const CADENCES = ['annual', 'semiannual', 'static'];
const META_REQUIRED = ['name', 'publisher', 'url', 'licence', 'licenceUrl', 'attribution', 'metric', 'unitNoun', 'currency', 'period', 'areaNoun'];

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
// which runs it on index.json's copy.
export function metaProblems(m = {}) {
  const p = [];
  for (const k of META_REQUIRED) if (m[k] == null || m[k] === '' || (Array.isArray(m[k]) && !m[k].length)) p.push(`meta.${k} is required`);
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
  if (!Array.isArray(s.regions) || !s.regions.length) bad('regions must list the coverage ids it serves');
  if (!CADENCES.includes(s.cadence)) bad(`cadence "${s.cadence}" (want ${CADENCES.join(' | ')})`);
  if (typeof s.fetch !== 'function') bad('no fetch(ctx)');
  if (s.probe != null && typeof s.probe !== 'function') bad('probe, when given, must be a function');
  const mp = metaProblems(s.meta);
  if (mp.length) bad(mp.join('; '));
  return s;
}

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
    if (!c || typeof c !== 'object' || typeof c.label !== 'string' || !c.label.trim()) p.push('context must be null or { label, value, n }');
    else {
      if (Object.keys(c).some(k => !['label', 'value', 'n'].includes(k))) p.push(`context has field(s) beyond label/value/n: ${Object.keys(c).join(', ')}`);
      if (c.value != null && !(isNum(c.value) && c.value > 0)) p.push('context.value must be a positive number or null');
      if (c.n != null && !(Number.isInteger(c.n) && c.n >= 0)) p.push('context.n must be a non-negative integer or null');
    }
  }
  if (raw) {
    if (!Array.isArray(a.polys) || !a.polys.length) p.push('polys must be a non-empty MultiPolygon');
    else if (!a.polys.every(poly => Array.isArray(poly) && poly.length && poly.every(r => Array.isArray(r) && r.length >= 3 && r.every(isPair)))) p.push('polys must be [[[lng, lat], ...] outer, holes...] per polygon, WGS84');
  }
  return p;
}

// Copy exactly the contract's fields (house rule: strip everything else at
// parse). Missing optional fields become null / [].
export const pickArea = a => ({
  id: a.id, name: a.name ?? null, region: a.region, juris: a.juris, scale: a.scale,
  value: a.value ?? null, moe: a.moe ?? null, n: a.n ?? null, flags: [...(a.flags || [])],
  context: a.context ? { label: a.context.label, value: a.context.value ?? null, n: a.context.n ?? null } : null,
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
