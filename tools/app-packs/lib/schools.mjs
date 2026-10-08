// The schools pack (RELEASE-1.4-SCOPE.md §4.4 O1, for S1–S9).
//
// INPUT: the published v2 tiles (schools/data/tiles/index.json + one file per
// leaf), read as the served bytes.
//
// CHUNKS: one per leaf, in index.cells order (chunk i is leaf cells[i]). A
// chunk is the leaf's rows as a JSON array of arrays in index.fields order,
// in the tile's own row order: the web tile, with two changes made here so
// the app needs no port of either rule:
//   - DISPLAY CASE: name, area and la through the page's schCase for a source
//     that declares meta.displayCase; trust through schCase for such a source,
//     else through the page's trustName (GIAS capitals). Exactly what the
//     /check/ pane shows (schShow / trustName). Only letter case changes.
//   - THE RATING LICENCE (Q4 b): a US school's value survives only under a
//     scheme tools/schools/licence.mjs licenses. Any other is stripped (rv and
//     rd emptied, the row put back on its source's defaultScheme). The
//     published tiles already follow the rule (W12), so this normally strips
//     nothing; the rating-licence gate then proves the result.
//
// THE SLIMMED INDEX: the web index.json without what the app has no use for
// (each source's `upstream` download records) and with:
//   - sources[].displayCase removed (already applied; pack.displayCase records it);
//   - schemes limited to those the rows use;
//   - each scheme note's trailing `<span class="caveat">…<a …>label</a></span>`
//     split into plain fields, so no HTML but <b> reaches the app:
//       { when?, html, caveat?, link?: { url, label } }
//     and the gate re-renders each note to the published HTML byte for byte.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { assemble, packJson, openPack, sha256, PACK_VERSION } from './container.mjs';
import { gate, GateError, forbiddenFieldProblems, filterProblems, licenceUrlProblems, sourceIdProblems, noteHtmlProblems, ratingLicenceProblems } from './gates.mjs';

export const LAYER = 'schools';
export const CASED_FIELDS = Object.freeze(['name', 'area', 'la', 'trust']);
export const RATING_FIELDS = Object.freeze(['ratingScheme', 'rv', 'rd']);

export function readSchoolsInput(root) {
  const dir = join(root, 'schools', 'data', 'tiles');
  const index = JSON.parse(readFileSync(join(dir, 'index.json'), 'utf8'));
  if (index.version !== 2) throw new Error(`schools index.json is version ${index.version}; the pack builder reads v2`);
  const tiles = index.cells.map(k => [k, readFileSync(join(dir, `${k}.json`), 'utf8')]);
  return { index, tiles };
}

// ── notes ──────────────────────────────────────────────────────────────────
const CAVEAT_RE = /^([\s\S]*?) <span class="caveat">([\s\S]*?)(?:<a class="ext" href="(https:\/\/[^"<>]+)" target="_blank" rel="noopener">([^<]*)<\/a>)?<\/span>$/;
export function splitNote(note) {
  const m = CAVEAT_RE.exec(note.html || '');
  if (!m) return { ...note };
  const out = { ...note, html: m[1] };
  if (m[2]) out.caveat = m[2];
  if (m[3]) out.link = { url: m[3], label: m[4] };
  return out;
}
export function joinNote(n) {
  if (n.caveat == null && !n.link) return n.html;
  const a = n.link ? `<a class="ext" href="${n.link.url}" target="_blank" rel="noopener">${n.link.label}</a>` : '';
  return `${n.html} <span class="caveat">${n.caveat ?? ''}${a}</span>`;
}

// ── rows ───────────────────────────────────────────────────────────────────
const obj = (row, fields) => Object.fromEntries(fields.map((f, i) => [f, row[i]]));

// Does the licence rule take this row's value (or scheme) away?
const needsStrip = (o, rules) => /^US-/.test(o.juris || '') && (
  (o.rv !== '' && o.rv != null && !rules.ratingLicensed(o.ratingScheme)) ||
  (rules.ratingSchemes.includes(o.ratingScheme) && !rules.ratingLicensed(o.ratingScheme)));

// The web row -> the pack row (both arrays in index.fields order).
export function makeTransform(index, rules) {
  const F = Object.fromEntries(index.fields.map((f, i) => [f, i]));
  const modules = new Map(rules.sources.map(s => [s.id, s]));
  return row => {
    const out = [...row];
    const src = row[F.src], dc = index.sources?.[src]?.displayCase;
    if (dc) for (const f of CASED_FIELDS) out[F[f]] = rules.schCase(row[F[f]], dc);
    else out[F.trust] = rules.trustName(row[F.trust]);
    let stripped = false, valueRemoved = false;
    const o = obj(row, index.fields);
    if (needsStrip(o, rules)) {
      stripped = true;
      valueRemoved = o.rv !== '' && o.rv != null;
      out[F.rv] = ''; out[F.rd] = '';
      const def = modules.get(src)?.defaultScheme;
      if (typeof def === 'function') out[F.ratingScheme] = def(o);
    }
    return { row: out, stripped, valueRemoved };
  };
}

// Letter case is all the display rules may change.
const sameLetters = (a, b) => typeof a === 'string' && typeof b === 'string' ? a.toLowerCase() === b.toLowerCase() : a === b;

// R2: the region a school counts under (index.regions order, first match).
export const regionOf = (regions, o) => regions.find(r => r.juris.includes(o.juris) && o.lat >= r.bbox[0] && o.lat <= r.bbox[2] && o.lng >= r.bbox[1] && o.lng <= r.bbox[3]);

// ── build ──────────────────────────────────────────────────────────────────
// input: readSchoolsInput(); rules: loadPageRules() + loadSchoolsRules();
// landing: { landingCommit, generated }. Returns { json, bin, gates, report }
// or throws GateError with every gate's result.
export function packSchools(input, rules, landing) {
  const web = input.index;
  const fields = web.fields;
  const F = Object.fromEntries(fields.map((f, i) => [f, i]));
  const transform = makeTransform(web, rules);

  // Rows, leaf by leaf, in the tile's own order.
  const leaves = input.tiles.map(([key, text]) => {
    const rows = JSON.parse(text);
    let stripped = 0, valuesRemoved = 0;
    const out = rows.map(r => { const t = transform(r); if (t.stripped) stripped++; if (t.valueRemoved) valuesRemoved++; return t.row; });
    return { key, text, rows, out, stripped, valuesRemoved };
  });
  const packRows = leaves.flatMap(l => l.out.map(r => obj(r, fields)));
  const stripped = leaves.reduce((n, l) => n + l.stripped, 0);
  const valuesRemoved = leaves.reduce((n, l) => n + l.valuesRemoved, 0);

  // The slimmed index.
  const index = structuredClone(web);
  const displayCase = {};
  for (const [id, s] of Object.entries(index.sources || {})) {
    delete s.upstream;
    if (s.displayCase) { displayCase[id] = s.displayCase; delete s.displayCase; }
  }
  const used = new Set(packRows.map(o => o.ratingScheme));
  const schemes = {};
  for (const [id, sc] of Object.entries(index.schemes || {})) if (used.has(id)) schemes[id] = sc;
  for (const id of used) if (!schemes[id]) {
    const def = rules.sources.map(s => s.schemes?.[id]).find(Boolean);
    if (def) schemes[id] = structuredClone(def);
  }
  for (const sc of Object.values(schemes)) if (sc.notes) sc.notes = sc.notes.map(splitNote);
  index.schemes = schemes;

  // The container.
  const { bin, table } = assemble(leaves.map(l => ({ raw: Buffer.from(JSON.stringify(l.out)), rows: l.out.length })));
  const pack = {
    version: PACK_VERSION, layer: LAYER,
    generated: landing.generated, landingCommit: landing.landingCommit,
    sha256: sha256(bin), bytes: bin.length,
    chunkOf: 'cells',
    chunks: table,
    displayCase: { applied: true, fields: [...CASED_FIELDS], sources: displayCase, rule: 'check/index.html schCase (sources with displayCase), trustName (trust, other sources)' },
    ratingLicence: { licensed: [...rules.licensed], rowsReset: stripped, valuesRemoved },
  };
  const json = packJson(index, pack);

  // ── gates ──
  const gates = [];
  const idxAndPack = { ...index, pack };
  gates.push(gate('forbidden-fields', forbiddenFieldProblems(idxAndPack), `${fields.length} row fields and every index key`));
  gates.push(gate('filter-ids', filterProblems(index), (index.filters || []).map(f => f.id).join(', ')));
  gates.push(gate('licence-urls', licenceUrlProblems(index), `${Object.keys(index.sources || {}).length} sources`));
  const refs = [...new Set(packRows.map(o => o.src))].map(id => ['a row', id]);
  for (const f of index.filters || []) for (const id of f.publishedBy || []) refs.push([`filter ${f.id}.publishedBy`, id]);
  gates.push(gate('source-ids', sourceIdProblems(index, rules.sourceIds, refs), `${Object.keys(index.sources || {}).join(', ')} ⊆ ${rules.sourceIds.length} loaded modules`));
  gates.push(gate('note-html', noteHtmlProblems(index), `every string in the index; ${Object.values(index.schemes || {}).reduce((n, s) => n + (s.notes?.length || 0), 0)} notes`));
  gates.push(gate('rating-licence', ratingLicenceProblems(packRows, rules.ratingLicensed, rules.ratingSchemes), `US values only under ${rules.licensed.join(', ')} (tools/schools/licence.mjs); ${valuesRemoved} values stripped, ${stripped} rows reset`));
  gates.push(gate('totals', totalsProblems(index, json, bin), `${packRows.length} rows = index.count ${index.count}; per source, jurisdiction, region`));
  gates.push(gate('reproduction', reproductionProblems({ web, leaves, index, json, bin, transform, rules }), `${leaves.length} leaves, ${packRows.length} rows re-expanded from the .bin`));
  if (gates.some(g => !g.ok)) throw new GateError(LAYER, gates);

  // ── report ──
  const sizes = table.map(([, len, rows, raw], i) => ({ key: index.cells[i], len, rows, raw }));
  const largest = sizes.reduce((a, b) => (b.len > a.len ? b : a));
  return {
    json, bin, gates,
    report: {
      layer: LAYER, chunks: table.length, rows: packRows.length, rawBytes: sizes.reduce((n, s) => n + s.raw, 0),
      binBytes: bin.length, jsonBytes: Buffer.byteLength(json), sha256: pack.sha256, largest, stripped, valuesRemoved,
      displayCased: countCased(leaves, F), landingCommit: landing.landingCommit, generated: landing.generated,
    },
  };
}

function countCased(leaves, F) {
  const n = {};
  for (const l of leaves) for (let i = 0; i < l.rows.length; i++) for (const f of CASED_FIELDS) if (l.rows[i][F[f]] !== l.out[i][F[f]]) n[f] = (n[f] || 0) + 1;
  return n;
}

// Totals in the pack (read back from the .bin) against the index: the whole,
// per source, per jurisdiction and per region (R2), and one chunk per leaf.
export function totalsProblems(index, json, bin) {
  const p = [];
  const { pack, chunk } = openPack(json, bin);
  if (pack.chunks.length !== index.cells.length) p.push(`${pack.chunks.length} chunks for ${index.cells.length} leaves`);
  const bySrc = {}, byJuris = {}, byRegion = {};
  let total = 0, tableRows = 0;
  pack.chunks.forEach(([, , rows], i) => {
    tableRows += rows;
    const list = JSON.parse(chunk(i));
    if (list.length !== rows) p.push(`chunk ${i} holds ${list.length} rows, the table says ${rows}`);
    for (const r of list) {
      const o = obj(r, index.fields);
      total++;
      bySrc[o.src] = (bySrc[o.src] || 0) + 1;
      byJuris[o.juris] = (byJuris[o.juris] || 0) + 1;
      const g = regionOf(index.regions || [], o);
      byRegion[g ? g.id : '(none)'] = (byRegion[g ? g.id : '(none)'] || 0) + 1;
    }
  });
  if (total !== index.count) p.push(`${total} rows, index.count ${index.count}`);
  if (tableRows !== index.count) p.push(`chunk table rows ${tableRows}, index.count ${index.count}`);
  for (const [id, s] of Object.entries(index.sources || {})) if ((bySrc[id] || 0) !== s.rows) p.push(`source ${id}: ${bySrc[id] || 0} rows, index says ${s.rows}`);
  for (const id of Object.keys(bySrc)) if (!index.sources?.[id]) p.push(`rows of source ${id}, which the index does not list`);
  for (const [j, x] of Object.entries(index.juris || {})) if ((byJuris[j] || 0) !== x.count) p.push(`juris ${j}: ${byJuris[j] || 0} rows, index says ${x.count}`);
  for (const r of index.regions || []) if ((byRegion[r.id] || 0) !== r.count) p.push(`region ${r.id}: ${byRegion[r.id] || 0} rows, index says ${r.count}`);
  if (byRegion['(none)']) p.push(`${byRegion['(none)']} rows in no region`);
  return p;
}

// Re-expand every chunk from the .bin and compare with the web tiles:
//  - same leaves, same row count and order;
//  - every row equals the transform of its web row;
//  - fields outside the display-case and rating-licence fields are identical
//    to the web row's, and the display-case fields differ in letter case only;
//  - the slimmed index equals the web index but for the documented changes,
//    and every split note re-renders to the published HTML.
export function reproductionProblems({ web, leaves, index, json, bin, transform, rules }) {
  const p = [];
  const { index: packed, chunk, pack } = openPack(json, bin);
  const fields = web.fields;
  const F = Object.fromEntries(fields.map((f, i) => [f, i]));
  if (JSON.stringify(packed.cells) !== JSON.stringify(web.cells)) p.push('index.cells differs from the web index');
  if (pack.chunks.length !== leaves.length) p.push(`${pack.chunks.length} chunks for ${leaves.length} web leaves`);
  const free = new Set(fields.map((f, i) => i).filter(i => !CASED_FIELDS.includes(fields[i]) && !RATING_FIELDS.includes(fields[i])));
  let rows = 0;
  leaves.forEach(({ key, text }, i) => {
    if (i >= pack.chunks.length) return;
    const webRows = JSON.parse(text);
    let got;
    try { got = JSON.parse(chunk(i)); } catch (e) { p.push(`leaf ${key}: chunk ${i} does not decode (${e.message})`); return; }
    if (got.length !== webRows.length) { p.push(`leaf ${key}: ${got.length} rows in the pack, ${webRows.length} on the web`); return; }
    for (let j = 0; j < webRows.length; j++) {
      rows++;
      const w = webRows[j], g = got[j];
      if (JSON.stringify(g) !== JSON.stringify(transform(w).row)) { p.push(`leaf ${key} row ${j} (${w[F.src]}:${w[F.id]}) is not the web row's pack form`); continue; }
      for (const k of free) if (JSON.stringify(g[k]) !== JSON.stringify(w[k])) p.push(`leaf ${key} row ${j}: ${fields[k]} changed`);
      for (const f of CASED_FIELDS) if (!sameLetters(g[F[f]], w[F[f]])) p.push(`leaf ${key} row ${j}: ${f} changed beyond letter case`);
      const stripped = g[F.rv] !== w[F.rv] || g[F.rd] !== w[F.rd] || g[F.ratingScheme] !== w[F.ratingScheme];
      if (stripped && !needsStrip(obj(w, fields), rules)) p.push(`leaf ${key} row ${j}: rating fields changed on a row the licence rule does not touch`);
    }
  });
  const webRowCount = leaves.reduce((n, l) => n + JSON.parse(l.text).length, 0);
  if (rows !== webRowCount) p.push(`${rows} of ${webRowCount} web rows compared`);

  // The index: the web index, less upstream and displayCase, schemes limited
  // to those used, notes split. Re-render the notes and compare.
  const expect = structuredClone(web);
  for (const s of Object.values(expect.sources || {})) { delete s.upstream; delete s.displayCase; }
  const back = structuredClone(packed);
  for (const sc of Object.values(back.schemes || {})) if (sc.notes) sc.notes = sc.notes.map(n => { const { caveat, link, ...rest } = n; return { ...rest, html: joinNote(n) }; });
  const usedWeb = Object.fromEntries(Object.entries(expect.schemes || {}).filter(([id]) => back.schemes?.[id]));
  for (const id of Object.keys(back.schemes || {})) if (!usedWeb[id]) usedWeb[id] = back.schemes[id];   // a default scheme a strip added
  expect.schemes = usedWeb;
  for (const k of new Set([...Object.keys(expect), ...Object.keys(back)])) {
    if (JSON.stringify(expect[k]) !== JSON.stringify(back[k])) p.push(`index.${k} differs from the web index beyond the documented slimming`);
  }
  return p;
}
