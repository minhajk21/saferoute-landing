// Adaptive polygon tiles: the one output shape of the home-prices build, and
// also each source's SNAPSHOT (readAreasFromTiles).
//
// KEYS are the schools keys (tools/schools/lib/tiles.mjs cellKey/parseKey):
// "206_-1" at 0.25°, "q412_-2" at 0.125°, "qq825_-3" at 0.0625°, so the page
// walks both layers' tiles with the same code.
//
// WHY AN AREA IS IN EVERY LEAF ITS BBOX TOUCHES. A point sits in one cell; a
// polygon can cross several. Putting it in each cell its bbox touches means
// the page only ever loads the leaves under the view (padded 10%) and still
// gets every area that shows there. It dedupes by `src:id` across leaves.
//
// SPLITTING. A leaf with more than MAX_AREAS areas or more than MAX_BYTES of
// JSON is cut into its four quadrants, recursively, down to MIN_CELL. The
// byte limit matters more than the count: census tracts at a city's edge are
// few but large, and a dense core is many small ones.
//
// TILE FILE: { "a": [row, ...], "c": [context, ...] }. Rows are arrays in
// FIELDS order (lib/schema.mjs), sorted by (source, id), so the same inputs
// give byte-identical files and the monthly diff shows only real changes.
// A row's ctx is an index into the same tile's `c`. A context is
// { label, value, n } plus, only when it has them, `moe` and `flags` (bits,
// as a row's): the NI wider-area lines written before those existed stay
// byte-identical.
//
// ATOMIC WRITE. index.json and tiles/ are written into a staging directory
// that replaces the live one in two renames. A build that dies part-way
// leaves the old set intact, and a tile no longer listed cannot linger.

import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync, rmSync, readdirSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { gzipSync } from 'node:zlib';
import { cellKey, parseKey } from '../../schools/lib/tiles.mjs';
import { FIELDS, ADDED_FIELDS, flagsToBits, bitsToFlags } from './schema.mjs';
import { bboxOfEncoded } from './geo.mjs';

export { cellKey, parseKey };
export const BASE = 0.25, MAX_AREAS = 350, MAX_BYTES = 45 * 1024, MIN_CELL = 0.0625;

// Keys of every cell at `level` that bbox [s, w, n, e] touches, optionally
// limited to the children of one parent cell.
export function cellsForBbox([s, w, n, e], level, base = BASE, within = null) {
  const size = base / 2 ** level;
  let y0 = Math.floor(s / size), y1 = Math.floor(n / size), x0 = Math.floor(w / size), x1 = Math.floor(e / size);
  if (within) {
    y0 = Math.max(y0, 2 * within.y); y1 = Math.min(y1, 2 * within.y + 1);
    x0 = Math.max(x0, 2 * within.x); x1 = Math.min(x1, 2 * within.x + 1);
  }
  const out = [];
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) out.push('q'.repeat(level) + `${y}_${x}`);
  return out;
}

const ID_CMP = new Intl.Collator('en', { numeric: true }).compare;
export const sortAreas = list => list.sort((a, b) => a.srcIdx - b.srcIdx || ID_CMP(a.id, b.id));

// Area object (with srcIdx, regionIdx, scaleIdx, enc) -> row + its context.
export function toRow(a, ctxIdx) {
  return [a.srcIdx, a.id, a.name ?? null, a.regionIdx, a.scaleIdx, a.value ?? null, a.moe ?? null, a.n ?? null,
    flagsToBits(a.flags), ctxIdx, a.enc, a.iqr ?? null];
}

// A context as the tile stores it (see TILE FILE).
export function contextJson(x) {
  const bits = flagsToBits(x.flags || []);
  return { label: x.label, value: x.value ?? null, n: x.n ?? null, ...(x.moe != null ? { moe: x.moe } : {}), ...(bits ? { flags: bits } : {}) };
}

// The tile JSON for a list of areas (sorted here, so the caller need not).
export function tileJson(areas) {
  const c = [], seen = new Map();
  const rows = sortAreas([...areas]).map(a => {
    let ci = null;
    if (a.context) {
      const cj = contextJson(a.context), k = JSON.stringify(cj);
      if (!seen.has(k)) { seen.set(k, c.length); c.push(cj); }
      ci = seen.get(k);
    }
    return toRow(a, ci);
  });
  return JSON.stringify({ a: rows, c });
}

// Cut areas (each with a bbox) into adaptive leaves. Returns [[key, areas], ...]
// in key order. `measure(areas)` -> bytes of that leaf's JSON (default: tileJson).
export function tileAreas(areas, { base = BASE, maxAreas = MAX_AREAS, maxBytes = MAX_BYTES, minCell = MIN_CELL, measure = l => Buffer.byteLength(tileJson(l)) } = {}) {
  const leaves = [];
  const place = (items, level, parent) => {
    const groups = new Map();
    for (const a of items) {
      for (const k of cellsForBbox(a.bbox, level, base, parent)) {
        if (!groups.has(k)) groups.set(k, []);
        groups.get(k).push(a);
      }
    }
    const canSplit = base / 2 ** (level + 1) >= minCell - 1e-12;
    for (const [k, l] of groups) {
      if (canSplit && (l.length > maxAreas || measure(l) > maxBytes)) place(l, level + 1, parseKey(k, base));
      else leaves.push([k, l]);
    }
  };
  place(areas, 0, null);
  return leaves.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
}

// Size of every leaf as it will be served. gz is what a visitor downloads.
export function tileStats(leaves) {
  const st = leaves.map(([key, areas]) => {
    const j = tileJson(areas);
    return { key, areas: areas.length, level: parseKey(key).level, raw: Buffer.byteLength(j), gz: gzipSync(Buffer.from(j)).length };
  });
  const byGz = [...st].sort((a, b) => a.gz - b.gz);
  return {
    files: st.length,
    byLevel: st.reduce((a, t) => (a[t.level] = (a[t.level] || 0) + 1, a), {}),
    rawBytes: st.reduce((a, t) => a + t.raw, 0), gzBytes: st.reduce((a, t) => a + t.gz, 0),
    medianGz: byGz.length ? byGz[Math.floor(byGz.length / 2)].gz : 0,
    worst: byGz.slice(-5).reverse(),
  };
}

// Write <outDir>/index.json and <outDir>/tiles/<key>.json atomically. outDir
// is wholly generated: anything else in it is replaced.
export function writeOutput(outDir, leaves, index) {
  const stage = `${outDir}.staging-${process.pid}`, old = `${outDir}.old-${process.pid}`;
  removeLeftovers(outDir);
  rmSync(stage, { recursive: true, force: true });
  mkdirSync(join(stage, 'tiles'), { recursive: true });
  for (const [key, areas] of leaves) writeFileSync(join(stage, 'tiles', `${key}.json`), tileJson(areas));
  writeFileSync(join(stage, 'index.json'), JSON.stringify(index));
  if (existsSync(outDir)) renameSync(outDir, old);
  renameSync(stage, outDir);
  rmSync(old, { recursive: true, force: true });
}

// A build killed part-way (Ctrl-C, a crash) leaves <outDir>.staging-<pid> or
// <outDir>.old-<pid> beside the output: ~30 MB each that a later
// `git add prices/` would publish (the repo also ignores them, /prices/data.*).
// Removed here, except those of a build that is still running. One killed
// between writeOutput's two renames left the published set ONLY in .old-<pid>:
// that one is put back, never deleted. build-prices calls this before it reads
// its snapshot. Returns what it did, for the log.
export function removeLeftovers(outDir) {
  const dir = dirname(outDir), base = basename(outDir);
  if (!existsSync(dir)) return [];
  const alive = pid => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
  const done = [];
  for (const f of readdirSync(dir).sort()) {
    const m = f.startsWith(`${base}.`) && /^(staging|old)-(\d+)$/.exec(f.slice(base.length + 1));
    if (!m || (+m[2] !== process.pid && alive(+m[2]))) continue;
    if (m[1] === 'old' && !existsSync(outDir)) { renameSync(join(dir, f), outDir); done.push(`restored ${f}`); continue; }
    rmSync(join(dir, f), { recursive: true, force: true });
    done.push(`removed ${f}`);
  }
  return done;
}

// Parse one tile file into area objects (names resolved against the index
// it was written with).
export function areasFromTile(text, index) {
  const t = JSON.parse(text), srcIds = Object.keys(index.sources);
  const f = Object.fromEntries(index.fields.map((k, i) => [k, i]));
  return t.a.map(r => ({
    src: srcIds[r[f.src]], id: r[f.id], name: r[f.name],
    region: index.regions[r[f.region]]?.id, scale: index.scales[r[f.scale]]?.key,
    // Not in the row: one scale region lies in one jurisdiction (build-prices
    // enforces it), so the scale says which.
    juris: index.scales[r[f.scale]]?.juris,
    value: r[f.value], moe: r[f.moe], n: r[f.n], flags: bitsToFlags(r[f.flags]),
    context: r[f.ctx] == null ? null : contextOfTile(t.c[r[f.ctx]]),
    enc: r[f.polys],
    // Absent from a tile set written before the field existed.
    iqr: f.iqr == null ? null : r[f.iqr] ?? null,
  }));
}
const contextOfTile = c => ({ label: c.label, value: c.value ?? null, moe: c.moe ?? null, n: c.n ?? null, flags: bitsToFlags(c.flags || 0) });

// Can tiles written with these fields be read by this code? The same list, or
// an older one that lacks only fields added since (ADDED_FIELDS), which read
// as null. Anything else would be misread.
export const readableFields = fields => Array.isArray(fields) && fields.length <= FIELDS.length &&
  fields.every((k, i) => k === FIELDS[i]) && FIELDS.slice(fields.length).every(k => ADDED_FIELDS.includes(k));

// THE SNAPSHOT READER: every area currently published, once each, grouped by
// source, with its encoded rings kept as they are, so a source that re-emits
// its snapshot produces byte-identical rows.
export function readAreasFromTiles(outDir) {
  const idxPath = join(outDir, 'index.json');
  if (!existsSync(idxPath)) return { index: null, bySrc: new Map() };
  const index = JSON.parse(readFileSync(idxPath, 'utf8'));
  if (!readableFields(index.fields)) throw new Error(`snapshot: index.fields ${JSON.stringify(index.fields)} is not this build's ${JSON.stringify(FIELDS)} (nor an earlier list of it) — refusing to misread the tiles`);
  const bySrc = new Map(), seen = new Set();
  for (const key of index.tiles.cells) {
    const path = join(outDir, 'tiles', `${key}.json`);
    if (!existsSync(path)) throw new Error(`snapshot: tiles/${key}.json is listed in index.json but missing — refusing to treat a partial tile set as the snapshot`);
    for (const a of areasFromTile(readFileSync(path, 'utf8'), index)) {
      const k = `${a.src}\u0000${a.id}`;
      if (seen.has(k)) continue;
      seen.add(k);
      a.bbox = bboxOfEncoded(a.enc);
      if (!bySrc.has(a.src)) bySrc.set(a.src, []);
      bySrc.get(a.src).push(a);
    }
  }
  return { index, bySrc };
}

// Tile files on disk that index.json does not list (a verify check).
export function orphanTiles(outDir, index) {
  const dir = join(outDir, 'tiles');
  if (!existsSync(dir)) return [];
  const listed = new Set(index.tiles.cells.map(k => `${k}.json`));
  return readdirSync(dir).filter(f => !listed.has(f));
}
