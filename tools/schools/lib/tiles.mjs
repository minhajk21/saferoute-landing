// Adaptive geographic tiles: the one output shape of the schools build, and
// also each source's SNAPSHOT (see readRowsFromTiles).
//
// WHY ADAPTIVE. /check/ fetches only the schools around the address being
// looked at. Fixed 0.25° cells served that well for England & Wales (median 34
// schools a cell), but density varies by two orders of magnitude between
// countries: at 0.25° central Mexico City would be one 6,461-row, 228KB-gzipped
// tile. So any cell holding more than MAX_ROWS schools is split into its four
// quadrants, recursively, down to MIN_CELL. Measured on every planned source
// (DESIGN.md §2c) that keeps the worst tile near 26KB gzipped, better than the
// old fixed-grid London worst of 50KB.
//
// KEYS. A leaf is named by its level and its cell index at that level:
//   level 0 (0.25°)    "206_-1"      = floor(lat/0.25) _ floor(lng/0.25)
//   level 1 (0.125°)   "q412_-2"     = "q"  + floor(lat/0.125)  _ floor(lng/0.125)
//   level 2 (0.0625°)  "qq825_-3"    = "qq" + floor(lat/0.0625) _ floor(lng/0.0625)
// The cell sizes are powers of two, so floor(lat/0.125) is always 2y or 2y+1 of
// its parent's y — a child never straddles two parents. index.cells lists every
// leaf; a split cell's own key is never listed, so leaves never overlap. The
// client walks down from the 0.25° cells in view (check/index.html cellsInView).
//
// ROWS are arrays in schema FIELDS order (lib/schema.mjs); plain objects would
// repeat every key in every row. Rows are sorted north to south, then west to
// east, then by (src, id), so the same inputs give byte-identical tiles and the
// monthly diff shows only real changes.
//
// ATOMIC WRITE. Tiles are written to a staging directory that then replaces the
// live one in two renames. A build that dies part-way leaves the old tile set
// intact, never a half-written one, and a split cell's stale parent file (or a
// cell that emptied) cannot linger.

import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync, rmSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { FIELDS, toRow, fromRow } from './schema.mjs';

export const BASE = 0.25, MAX_ROWS = 600, MIN_CELL = 0.0625;

export function cellKey(lat, lng, level, base = BASE) {
  const size = base / 2 ** level;
  return 'q'.repeat(level) + `${Math.floor(lat / size)}_${Math.floor(lng / size)}`;
}

// "q412_-2" -> { level: 1, size: 0.125, y: 412, x: -2, bounds: [s, w, n, e] }
export function parseKey(key, base = BASE) {
  const m = /^(q*)(-?\d+)_(-?\d+)$/.exec(key);
  if (!m) throw new Error(`bad tile key "${key}"`);
  const level = m[1].length, size = base / 2 ** level, y = +m[2], x = +m[3];
  return { level, size, y, x, bounds: [y * size, x * size, (y + 1) * size, (x + 1) * size] };
}

// Numeric-aware id comparison so URN 99999 sorts before 100000.
const ID_CMP = new Intl.Collator('en', { numeric: true }).compare;
export function sortRows(list) {
  return list.sort((a, b) => a.lat - b.lat || a.lng - b.lng || (a.src < b.src ? -1 : a.src > b.src ? 1 : 0) || ID_CMP(a.id, b.id));
}

// Cut sorted row objects into adaptive leaves. Returns [[key, rows], ...] in
// key order.
export function tileRows(list, { base = BASE, maxRows = MAX_ROWS, minCell = MIN_CELL } = {}) {
  const leaves = [];
  const place = (items, level) => {
    const size = base / 2 ** level;
    const groups = new Map();
    for (const s of items) {
      const k = cellKey(s.lat, s.lng, level, base);
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(s);
    }
    for (const [k, l] of groups) {
      if (l.length > maxRows && size / 2 >= minCell - 1e-12) place(l, level + 1);
      else leaves.push([k, l]);
    }
  };
  place(list, 0);
  return leaves.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
}

// Size of every leaf as it will be served. gz is what a visitor downloads.
export function tileStats(leaves) {
  const st = leaves.map(([key, rows]) => {
    const j = JSON.stringify(rows.map(toRow));
    return { key, rows: rows.length, level: parseKey(key).level, raw: j.length, gz: gzipSync(Buffer.from(j)).length };
  });
  const byGz = [...st].sort((a, b) => a.gz - b.gz);
  const byRows = [...st].sort((a, b) => a.rows - b.rows);
  const byLevel = st.reduce((a, t) => (a[t.level] = (a[t.level] || 0) + 1, a), {});
  return {
    files: st.length, byLevel,
    rawBytes: st.reduce((a, t) => a + t.raw, 0), gzBytes: st.reduce((a, t) => a + t.gz, 0),
    medianRows: byRows.length ? byRows[Math.floor(byRows.length / 2)].rows : 0,
    medianGz: byGz.length ? byGz[Math.floor(byGz.length / 2)].gz : 0,
    worst: byGz.slice(-8).reverse(),
    all: st,
  };
}

// Write the leaves and index.json atomically (see header).
export function writeTiles(tileDir, leaves, index) {
  const stage = `${tileDir}.staging-${process.pid}`, old = `${tileDir}.old-${process.pid}`;
  rmSync(stage, { recursive: true, force: true });
  mkdirSync(stage, { recursive: true });
  for (const [key, rows] of leaves) writeFileSync(join(stage, `${key}.json`), JSON.stringify(rows.map(toRow)));
  writeFileSync(join(stage, 'index.json'), JSON.stringify(index));
  if (existsSync(tileDir)) renameSync(tileDir, old);
  renameSync(stage, tileDir);
  rmSync(old, { recursive: true, force: true });
}

// THE SNAPSHOT READER. Every row currently published, as v2 objects, grouped by
// source. A source that fails to fetch, or is not due for a refresh, re-emits
// its rows from here — so a failed fetch can never empty a country.
//
// v1 tile sets (England & Wales only, written before the v2 schema) are read
// through the legacy mappers passed in (sources/gias.mjs fromV1), keyed by
// the source they all came from.
export function readRowsFromTiles(tileDir, { legacy = {} } = {}) {
  const idxPath = join(tileDir, 'index.json');
  if (!existsSync(idxPath)) return { index: null, bySrc: new Map() };
  const index = JSON.parse(readFileSync(idxPath, 'utf8'));
  const v1 = index.version !== 2;
  const bySrc = new Map();
  const push = (src, o) => { if (!bySrc.has(src)) bySrc.set(src, []); bySrc.get(src).push(o); };
  if (v1 && !legacy.v1) throw new Error('tiles are v1 but no v1 mapper was given');
  for (const key of index.cells) {
    const path = join(tileDir, `${key}.json`);
    if (!existsSync(path)) throw new Error(`snapshot: ${key}.json is listed in index.json but missing — refusing to treat a partial tile set as the snapshot`);
    for (const row of JSON.parse(readFileSync(path, 'utf8'))) {
      const o = fromRow(row, index.fields);
      if (v1) { const m = legacy.v1(o); push(m.src, m); } else push(o.src, o);
    }
  }
  return { index, bySrc };
}

// Tile files on disk that index.json does not list (a verify check).
export function orphanTiles(tileDir, index) {
  const listed = new Set(index.cells.map(k => `${k}.json`));
  return readdirSync(tileDir).filter(f => f.endsWith('.json') && f !== 'index.json' && !listed.has(f));
}

export { FIELDS };
