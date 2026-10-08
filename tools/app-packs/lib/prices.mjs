// The home-values pack (RELEASE-1.4-SCOPE.md §4.4 O1, for H1–H8).
//
// INPUT: the published tiles (prices/data/index.json + prices/data/tiles/),
// read as the served bytes. On the web an area is copied into EVERY leaf its
// bbox touches; shipped like that the layer would cost ~12 MB compressed.
//
// CHUNKS: the areas, DEDUPLICATED by (src, id), one chunk per colour scale,
// in index.scales order (chunk i is scales[i]). A chunk is
//   { "a": [row, …], "c": [context, …] }
// exactly the web tile format: rows in index.fields order, a row's ctx an
// index into the chunk's own `c`. Rows sorted by (src index, id), by code
// unit, so the order needs no collation tables.
//
// LEAF MAP: pack.leaves[i] lists leaf tiles.cells[i]'s areas, in the web
// tile's row order, as a flat [chunk, row, chunk, row, …] array. The app
// finds the leaves in view exactly as the page does (tileGrid over
// tiles.cells) and reads their areas from the chunks.
//
// THE SLIMMED INDEX: the web index.json without each source's `upstream`
// download records and `inputs` fingerprint. Everything else is as published.
//
// The reproduction gate rebuilds EVERY web tile from the pack (leaf map,
// chunks, contexts re-indexed per tile as lib/tiles.mjs tileJson does) and
// requires it to equal the served file byte for byte.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { assemble, packJson, openPack, sha256, PACK_VERSION } from './container.mjs';
import { gate, GateError, forbiddenFieldProblems, filterProblems, licenceUrlProblems, sourceIdProblems, noteHtmlProblems } from './gates.mjs';

export const LAYER = 'prices';
// The colour rule of tools/prices/lib/schema.mjs: coloured = a value and no
// suppressed | uncertain | few | bottomcoded bit (top-coded is coloured).
const NEUTRAL_BITS = 1 | 2 | 8 | 16;

export function readPricesInput(root) {
  const dir = join(root, 'prices', 'data');
  const index = JSON.parse(readFileSync(join(dir, 'index.json'), 'utf8'));
  if (index.version !== 1) throw new Error(`prices index.json is version ${index.version}; the pack builder reads v1`);
  const tiles = index.tiles.cells.map(k => [k, readFileSync(join(dir, 'tiles', `${k}.json`), 'utf8')]);
  return { index, tiles };
}

const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const verticesOf = polys => polys.reduce((n, poly) => n + poly.reduce((m, ring) => m + ring.length / 2, 0), 0);

export function packPrices(input, rules, landing) {
  const web = input.index;
  const fields = web.fields;
  const F = Object.fromEntries(fields.map((f, i) => [f, i]));
  const srcIds = Object.keys(web.sources || {});
  const dedupProblems = [];

  // Every area once, with its context resolved; each leaf's areas in order.
  const areas = new Map();            // key -> { row, ctx, canon }
  const leafKeys = input.tiles.map(([leaf, text]) => {
    const t = JSON.parse(text);
    return t.a.map(row => {
      const key = `${row[F.src]}\u0000${row[F.id]}`;
      const ctx = row[F.ctx] == null ? null : t.c[row[F.ctx]];
      const resolved = [...row]; resolved[F.ctx] = ctx;
      const canon = JSON.stringify(resolved);
      const had = areas.get(key);
      if (!had) areas.set(key, { row, ctx, canon });
      else if (had.canon !== canon) dedupProblems.push(`area ${srcIds[row[F.src]]}:${row[F.id]} differs between leaves (${leaf})`);
      return key;
    });
  });
  const occurrences = leafKeys.reduce((n, l) => n + l.length, 0);

  // One chunk per scale.
  const byScale = web.scales.map(() => []);
  for (const [key, a] of areas) {
    const s = a.row[F.scale];
    if (!byScale[s]) { dedupProblems.push(`area ${key.replace('\u0000', ':')} names scale ${s}, which the index does not have`); continue; }
    byScale[s].push([key, a]);
  }
  const pos = new Map();
  const chunks = byScale.map((list, ci) => {
    list.sort(([, a], [, b]) => a.row[F.src] - b.row[F.src] || cmp(a.row[F.id], b.row[F.id]));
    const c = [], seen = new Map();
    const rows = list.map(([key, a], ri) => {
      pos.set(key, [ci, ri]);
      const out = [...a.row];
      if (a.ctx != null) {
        const k = JSON.stringify(a.ctx);
        if (!seen.has(k)) { seen.set(k, c.length); c.push(a.ctx); }
        out[F.ctx] = seen.get(k);
      }
      return out;
    });
    return { raw: Buffer.from(JSON.stringify({ a: rows, c })), rows: rows.length };
  });
  const leaves = leafKeys.map(keys => keys.flatMap(k => pos.get(k) || [-1, -1]));

  // The slimmed index.
  const index = structuredClone(web);
  for (const s of Object.values(index.sources || {})) { delete s.upstream; delete s.inputs; }

  const { bin, table } = assemble(chunks);
  const pack = {
    version: PACK_VERSION, layer: LAYER,
    generated: landing.generated, landingCommit: landing.landingCommit,
    sha256: sha256(bin), bytes: bin.length,
    chunkOf: 'scales',
    chunks: table,
    leaves,
  };
  const json = packJson(index, pack);

  // ── gates ──
  const gates = [];
  const ctxKeys = [...new Set([...areas.values()].flatMap(a => (a.ctx ? Object.keys(a.ctx) : [])))];
  gates.push(gate('forbidden-fields', forbiddenFieldProblems({ ...index, pack: { ...pack, leaves: [] } }, [ctxKeys, ['a', 'c']]), `${fields.length} row fields, context keys and every index key`));
  gates.push(gate('filter-ids', filterProblems(index), `${(index.filters || []).length} filters (home values has none)`));
  gates.push(gate('licence-urls', licenceUrlProblems(index), `${srcIds.length} sources`));
  const refs = [];
  for (const s of index.scales || []) refs.push([`scale ${s.key}.source`, s.source]);
  for (const r of index.regions || []) for (const id of r.sources || []) refs.push([`region ${r.id}.sources`, id]);
  for (const [id, s] of Object.entries(index.sources || {})) {
    if (s.geometry) refs.push([`source ${id}.geometry`, s.geometry]);
    for (const k of Object.keys(s.stats?.replaced || {})) refs.push([`source ${id}.stats.replaced`, k]);
  }
  for (const a of areas.values()) refs.push(['a row', srcIds[a.row[F.src]] ?? `#${a.row[F.src]}`]);
  gates.push(gate('source-ids', sourceIdProblems(index, rules.sourceIds, refs), `${srcIds.join(', ')} ⊆ ${rules.sourceIds.length} loaded modules`));
  gates.push(gate('note-html', noteHtmlProblems(index), 'every string in the index'));
  const tot = totals(index, json, bin);
  gates.push(gate('totals', tot.problems, `${tot.areas} areas = Σ regions ${tot.regionSum}; per region, source, scale`));
  gates.push(gate('reproduction', [...dedupProblems, ...reproductionProblems(input, json, bin)], `${input.tiles.length} web tiles (${occurrences} rows) rebuilt byte for byte from ${areas.size} areas`));
  if (gates.some(g => !g.ok)) throw new GateError(LAYER, gates);

  const sizes = table.map(([, len, rows, raw], i) => ({ key: index.scales[i].key, name: index.scales[i].name, len, rows, raw }));
  const largest = sizes.reduce((a, b) => (b.len > a.len ? b : a));
  return {
    json, bin, gates,
    report: {
      layer: LAYER, chunks: table.length, areas: areas.size, occurrences, vertices: tot.vertices,
      rawBytes: sizes.reduce((n, s) => n + s.raw, 0), binBytes: bin.length, jsonBytes: Buffer.byteLength(json),
      leaves: leaves.length, leafMapBytes: Buffer.byteLength(JSON.stringify(leaves)), sha256: pack.sha256, largest,
      landingCommit: landing.landingCommit, generated: landing.generated,
    },
  };
}

// Totals read back from the .bin against the index: every area once; per
// region (regions[].areas), per source (stats areas / coloured / neutral /
// unpublished) and per scale (scales[].areas = its coloured areas).
export function totals(index, json, bin) {
  const p = [];
  const { pack, chunk } = openPack(json, bin);
  const F = Object.fromEntries(index.fields.map((f, i) => [f, i]));
  const srcIds = Object.keys(index.sources || {});
  if (pack.chunks.length !== index.scales.length) p.push(`${pack.chunks.length} chunks for ${index.scales.length} scales`);
  const reg = {}, src = {}, scaleCol = {}, seen = new Set();
  let n = 0, vertices = 0, tableRows = 0;
  pack.chunks.forEach(([, , rows], ci) => {
    tableRows += rows;
    const t = JSON.parse(chunk(ci));
    if (t.a.length !== rows) p.push(`chunk ${ci} holds ${t.a.length} rows, the table says ${rows}`);
    for (const r of t.a) {
      const k = `${r[F.src]}\u0000${r[F.id]}`;
      if (seen.has(k)) p.push(`area ${k.replace('\u0000', ':')} is in the pack twice`);
      seen.add(k);
      n++;
      vertices += verticesOf(r[F.polys]);
      if (r[F.scale] !== ci) p.push(`chunk ${ci} holds an area of scale ${r[F.scale]}`);
      reg[r[F.region]] = (reg[r[F.region]] || 0) + 1;
      const s = (src[srcIds[r[F.src]]] ||= { areas: 0, coloured: 0, neutral: 0, unpublished: 0 });
      s.areas++;
      const coloured = r[F.value] != null && !(r[F.flags] & NEUTRAL_BITS);
      if (coloured) { s.coloured++; scaleCol[ci] = (scaleCol[ci] || 0) + 1; } else s.neutral++;
      if (r[F.value] == null && !r[F.flags]) s.unpublished++;
    }
  });
  const regionSum = (index.regions || []).reduce((a, r) => a + r.areas, 0);
  if (n !== regionSum) p.push(`${n} areas, the regions sum to ${regionSum}`);
  if (tableRows !== n) p.push(`chunk table rows ${tableRows}, areas ${n}`);
  (index.regions || []).forEach((r, i) => { if ((reg[i] || 0) !== r.areas) p.push(`region ${r.id}: ${reg[i] || 0} areas, index says ${r.areas}`); });
  for (const [id, s] of Object.entries(index.sources || {})) {
    for (const k of ['areas', 'coloured', 'neutral', 'unpublished']) {
      if ((src[id]?.[k] || 0) !== (s.stats?.[k] ?? -1)) p.push(`source ${id}: ${src[id]?.[k] || 0} ${k}, index says ${s.stats?.[k]}`);
    }
  }
  index.scales.forEach((s, i) => { if ((scaleCol[i] || 0) !== s.areas) p.push(`scale ${s.key}: ${scaleCol[i] || 0} coloured areas, index says ${s.areas}`); });
  return { problems: p, areas: n, regionSum, vertices };
}

// Rebuild each web tile from the pack and compare it with the served bytes.
export function reproductionProblems(input, json, bin) {
  const p = [];
  const { index, pack, chunk } = openPack(json, bin);
  const F = Object.fromEntries(index.fields.map((f, i) => [f, i]));
  if (JSON.stringify(index.tiles.cells) !== JSON.stringify(input.index.tiles.cells)) p.push('tiles.cells differs from the web index');
  if (pack.leaves.length !== input.tiles.length) p.push(`${pack.leaves.length} leaf-map entries for ${input.tiles.length} web tiles`);
  const decoded = pack.chunks.map((_, i) => JSON.parse(chunk(i)));
  const used = decoded.map(t => new Uint8Array(t.a.length));
  input.tiles.forEach(([key, text], li) => {
    const flat = pack.leaves[li] || [];
    const c = [], seen = new Map(), a = [];
    for (let k = 0; k < flat.length; k += 2) {
      const t = decoded[flat[k]], row = t?.a[flat[k + 1]];
      if (!row) { p.push(`leaf ${key}: leaf map points at a missing row (${flat[k]}, ${flat[k + 1]})`); return; }
      used[flat[k]][flat[k + 1]] = 1;
      const out = [...row];
      if (row[F.ctx] != null) {
        const cj = t.c[row[F.ctx]], s = JSON.stringify(cj);
        if (!seen.has(s)) { seen.set(s, c.length); c.push(cj); }
        out[F.ctx] = seen.get(s);
      }
      a.push(out);
    }
    if (JSON.stringify({ a, c }) !== text) p.push(`leaf ${key}: the tile rebuilt from the pack differs from the web tile`);
  });
  used.forEach((u, ci) => { const n = u.length - u.reduce((s, x) => s + x, 0); if (n) p.push(`chunk ${ci}: ${n} area(s) no leaf uses`); });
  // The index: the web index less upstream and inputs.
  const expect = structuredClone(input.index);
  for (const s of Object.values(expect.sources || {})) { delete s.upstream; delete s.inputs; }
  for (const k of new Set([...Object.keys(expect), ...Object.keys(index)])) if (JSON.stringify(expect[k]) !== JSON.stringify(index[k])) p.push(`index.${k} differs from the web index beyond the documented slimming`);
  return p;
}
