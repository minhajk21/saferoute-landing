// Shared helpers for the US state rating maps (tools/schools/ratings/us-*.mjs).
// The leading "_" keeps this file from being loaded as a ratings module.
//
// What is here, and why it is here rather than in tools/schools/lib/:
//   unzip(buf)          a zero-dependency ZIP reader (central directory + zlib),
//                       for the zipped state files and for .xlsx workbooks
//   xlsx(buf)           a zero-dependency .xlsx sheet reader (sharedStrings,
//                       inline strings, sparse cells placed by their A1 ref)
//   stateIds(ctx)       NCES CCD 029 (the `ccd` source's own directory file, via
//                       sources/_nces.mjs): NCESSCH -> ST_SCHID, the key every
//                       state rating file is joined on (the ArcGIS layer the
//                       `ccd` source reads has no ST_SCHID, DESIGN.md §1a)
//   joinRatings(...)    the one join loop every scheme uses, with honest stats
//   words / numbers     small formatting helpers ("3.5 stars", "Category 2")
// The xlsx/zip readers are written to be promoted to lib/ unchanged if another
// lane needs them (tools/schools/README.md lists lib/xlsx.mjs as planned).
//
// RULES these maps obey (DESIGN.md §4, tools/schools/README.md):
//   - A value is the state's own words, never a colour, rank or comparison.
//   - Only STATE schools of the `ccd` source are rated; the runner keeps only
//     ids it was given, so a private school can never receive a value.
//   - A school the state lists WITHOUT a rating gets no value here: the pane's
//     miss line ("... has no {year} rating for this school") covers it honestly.
//     Where the state itself publishes a "not rated" outcome in words (TEA "Not
//     Rated", Tennessee "Not Eligible for a Letter Grade"), that IS the value.

import { inflateRawSync } from 'node:zlib';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { columns } from '../lib/csv.mjs';
import { makeDownloader } from '../lib/download.mjs';
import { CCD_029, CCD_YEAR, ccdTable } from '../sources/_nces.mjs';

// ── ZIP ─────────────────────────────────────────────────────────────────────
// Reads the central directory (so data-descriptor entries and zip64 sizes are
// handled), then inflates one member on demand. Stored (0) and deflate (8) only.
export function unzip(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('not a zip file (no end-of-central-directory record)');
  let count = buf.readUInt16LE(eocd + 10), cdSize = buf.readUInt32LE(eocd + 12), cdOff = buf.readUInt32LE(eocd + 16);
  if (cdOff === 0xffffffff || count === 0xffff) {                       // zip64
    const loc = eocd - 20;
    if (loc >= 0 && buf.readUInt32LE(loc) === 0x07064b50) {
      const z64 = Number(buf.readBigUInt64LE(loc + 8));
      count = Number(buf.readBigUInt64LE(z64 + 32)); cdSize = Number(buf.readBigUInt64LE(z64 + 40)); cdOff = Number(buf.readBigUInt64LE(z64 + 48));
    }
  }
  const entries = new Map();
  let p = cdOff;
  for (let n = 0; n < count && p < cdOff + cdSize; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('corrupt zip central directory');
    const method = buf.readUInt16LE(p + 10);
    let csize = buf.readUInt32LE(p + 20), usize = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28), extraLen = buf.readUInt16LE(p + 30), commentLen = buf.readUInt16LE(p + 32);
    let local = buf.readUInt32LE(p + 42);
    const flags = buf.readUInt16LE(p + 8);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString(flags & 0x800 ? 'utf8' : 'latin1');
    let e = p + 46 + nameLen;
    const extraEnd = e + extraLen;
    while (e + 4 <= extraEnd) {                                          // zip64 extended information
      const id = buf.readUInt16LE(e), len = buf.readUInt16LE(e + 2);
      if (id === 0x0001) {
        let q = e + 4;
        if (usize === 0xffffffff) { usize = Number(buf.readBigUInt64LE(q)); q += 8; }
        if (csize === 0xffffffff) { csize = Number(buf.readBigUInt64LE(q)); q += 8; }
        if (local === 0xffffffff) { local = Number(buf.readBigUInt64LE(q)); q += 8; }
      }
      e += 4 + len;
    }
    entries.set(name, { name, method, csize, usize, local });
    p = extraEnd + commentLen;
  }
  const dataStart = ent => {
    if (buf.readUInt32LE(ent.local) !== 0x04034b50) throw new Error(`corrupt zip local header for ${ent.name}`);
    return ent.local + 30 + buf.readUInt16LE(ent.local + 26) + buf.readUInt16LE(ent.local + 28);
  };
  return {
    names: [...entries.keys()],
    entry: name => entries.get(name),
    dataStart,
    read(name) {
      const ent = entries.get(name);
      if (!ent) throw new Error(`zip has no member "${name}" (has: ${[...entries.keys()].slice(0, 12).join(', ')})`);
      const raw = buf.subarray(dataStart(ent), dataStart(ent) + ent.csize);
      if (ent.method === 0) return Buffer.from(raw);
      if (ent.method === 8) return inflateRawSync(raw);
      throw new Error(`zip member ${name}: compression method ${ent.method} not supported`);
    },
  };
}

// ── XLSX ────────────────────────────────────────────────────────────────────
const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
export const xmlText = s => s
  .replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (m, e) => e[0] === '#'
    ? String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : +e.slice(1))
    : ENT[e.toLowerCase()])
  .replace(/_x([0-9A-F]{4})_/g, (_, h) => String.fromCharCode(parseInt(h, 16)));   // OOXML escapes (_x000D_)
const attrs = s => Object.fromEntries([...s.matchAll(/([\w:]+)="([^"]*)"/g)].map(m => [m[1], xmlText(m[2])]));
const colIndex = ref => { let n = 0; for (const ch of ref) { const c = ch.charCodeAt(0); if (c < 65 || c > 90) break; n = n * 26 + c - 64; } return n - 1; };

// xlsx(buf).sheets -> ['General', ...]; .rows('General') -> string[][] (every
// cell as the text Excel stores: numbers keep their stored digits, e.g. "0.582").
export function xlsx(buf) {
  const z = unzip(buf);
  const text = n => z.read(n).toString('utf8');
  const wb = text('xl/workbook.xml');
  const rels = Object.fromEntries([...text('xl/_rels/workbook.xml.rels').matchAll(/<Relationship\b([^>]*?)\/?>/g)]
    .map(m => attrs(m[1])).map(a => [a.Id, a.Target]));
  const sheets = [...wb.matchAll(/<sheet\b([^>]*?)\/?>/g)].map(m => attrs(m[1]))
    .map(a => ({ name: a.name, path: (t => (t.startsWith('/') ? t.slice(1) : `xl/${t}`))(rels[a['r:id']] || '') }));
  let shared = null;
  const sharedStrings = () => {
    if (shared) return shared;
    shared = [];
    if (!z.names.includes('xl/sharedStrings.xml')) return shared;
    for (const m of text('xl/sharedStrings.xml').matchAll(/<si>([\s\S]*?)<\/si>/g)) {
      const body = m[1].replace(/<rPh\b[\s\S]*?<\/rPh>/g, '');             // drop phonetic runs
      shared.push([...body.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map(t => xmlText(t[1])).join(''));
    }
    return shared;
  };
  return {
    sheets: sheets.map(s => s.name),
    rows(which) {
      const sh = typeof which === 'number' ? sheets[which] : sheets.find(s => s.name === which);
      if (!sh) throw new Error(`workbook has no sheet ${JSON.stringify(which)} (has: ${sheets.map(s => s.name).join(', ')})`);
      const xml = text(sh.path), ss = sharedStrings(), out = [];
      for (const rm of xml.matchAll(/<row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/row>)/g)) {
        const ra = attrs(rm[1]);
        const rIdx = ra.r ? +ra.r - 1 : out.length;
        while (out.length < rIdx) out.push([]);
        const row = [];
        let next = 0;
        for (const cm of (rm[2] || '').matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
          const ca = attrs(cm[1]), body = cm[2] || '';
          const ci = ca.r ? colIndex(ca.r) : next;
          next = ci + 1;
          let v = '';
          if (ca.t === 'inlineStr') v = [...body.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map(t => xmlText(t[1])).join('');
          else {
            const vm = /<v>([\s\S]*?)<\/v>/.exec(body);
            const raw = vm ? xmlText(vm[1]) : '';
            v = ca.t === 's' ? (ss[+raw] ?? '') : ca.t === 'b' ? (raw === '1' ? 'TRUE' : 'FALSE') : raw;
          }
          while (row.length < ci) row.push('');
          row[ci] = v;
        }
        out[rIdx] = row;
      }
      return out;
    },
  };
}

// Objects keyed by a header row. Header text is whitespace-collapsed and
// trimmed ("2025 Letter Grade " -> "2025 Letter Grade"). headerAt: a row index,
// or a function that picks the header row (the first row it returns true for).
export const cleanHeader = h => String(h ?? '').replace(/\s+/g, ' ').trim();
export function sheetRecords(rows, headerAt = 0, need = [], what = 'sheet') {
  const hi = typeof headerAt === 'function' ? rows.findIndex(r => headerAt((r || []).map(cleanHeader))) : headerAt;
  if (hi < 0) throw new Error(`${what}: header row not found — the layout changed; refusing to guess`);
  const header = (rows[hi] || []).map(cleanHeader);
  columns(header, need, what);
  const out = [];
  for (const r of rows.slice(hi + 1)) {
    if (!r || !r.some(v => String(v).trim())) continue;
    out.push(Object.fromEntries(header.map((k, i) => [k, String(r[i] ?? '').trim()])));
  }
  return out;
}

// ── Shared download cache (for files several schemes need) ─────────────────
// The runner gives each scheme its own cache dir (rating-<scheme>/). The CCD
// directory is the same 13MB file for every state, so it is cached once, in
// rating-_shared/ under the same --raw-dir, and its provenance is appended to
// the scheme's own (ctx.provenance -> meta.upstream).
const argvOpt = (n, d) => (process.argv.includes(n) ? process.argv[process.argv.indexOf(n) + 1] : d);
// The runner's cache dir for one scheme (<--raw-dir or OS tmp>/saferoute-schools/rating-<scheme>),
// for a scheme that must put a derived file (NY's extracted .mdb) beside its download.
export const rawDirFor = scheme => join(resolve(argvOpt('--raw-dir', join(tmpdir(), 'saferoute-schools'))), `rating-${scheme}`);
export function sharedDownload(ctx) {
  const rawDir = rawDirFor('_shared');
  const dl = makeDownloader({ rawDir, frozen: process.argv.includes('--frozen'), log: ctx.log });
  return async (file, urls, opts) => {
    const before = dl.provenance.length;
    const buf = await dl.download(file, urls, opts);
    ctx.provenance.push(...dl.provenance.slice(before));
    return buf;
  };
}

// ── NCES CCD 029: NCESSCH -> ST_SCHID ───────────────────────────────────────
// The SAME directory file the `ccd` source's rows come from (CCD_029 and
// ccdTable in sources/_nces.mjs, owned by that source), so the two can never
// drift apart by a year. Cached once for every scheme (sharedDownload). A row
// whose id the directory lacks is counted under meta.stats.noStateId.
export { CCD_029, CCD_YEAR };
export async function stateIds(ctx) {
  const buf = await sharedDownload(ctx)(CCD_029.file, CCD_029.url, { maxAgeH: 24 * 365 });
  const dir = ccdTable(buf, ['NCESSCH', 'ST', 'ST_LEAID', 'ST_SCHID', 'SCH_NAME'], `CCD 029 ${CCD_YEAR}`);
  const map = new Map();
  for (const row of ctx.rows) {
    const d = dir.get(row.id);
    if (!d) continue;
    map.set(row.id, { st: d.ST_SCHID, parts: d.ST_SCHID.split('-'), leaid: d.ST_LEAID, name: d.SCH_NAME, state: d.ST });
  }
  return map;
}
// The last hyphen segment of ST_SCHID ("TX-057804-057804001" -> "057804001").
export const lastSeg = s => s.parts[s.parts.length - 1];

// ── The join ────────────────────────────────────────────────────────────────
// For every in-scope row: its state id (via stateIds) -> the state's key ->
// the state's published value. Counts, for meta.stats and the lane report:
//   matched          the state's file lists the school and gives it a value
//   listedNoRating   the file lists the school but publishes no rating for it
//   notInFile        the file does not list the school
//   noStateId        the CCD directory has no ST_SCHID for it (should be 0)
// lookup(key, row, sid) returns: a string (the value), '' (listed, no rating),
// or undefined (not listed).
export function joinRatings(ctx, ids, keyOf, lookup) {
  const values = {};
  for (const row of ctx.rows) {
    const sid = ids.get(row.id);
    if (!sid || !sid.st) { ctx.stat('noStateId'); continue; }
    const k = keyOf(sid, row);
    const v = k == null ? undefined : lookup(k, row, sid);
    if (v === undefined) { ctx.stat('notInFile'); continue; }
    if (v === '') { ctx.stat('listedNoRating'); continue; }
    values[row.id] = { rv: v };
    ctx.stat('matched');
  }
  return values;
}

// Check every value against a pattern before the runner sees it (for schemes
// whose values are numbers and so cannot be listed in record.values).
export function assertValues(values, re, what) {
  const bad = Object.entries(values).filter(([, v]) => !re.test(v.rv));
  if (bad.length) throw new Error(`${what}: ${bad.length} value(s) not in the expected form, e.g. ${bad.slice(0, 3).map(([k, v]) => `${k}="${v.rv}"`).join('; ')}`);
}

// ── Words ───────────────────────────────────────────────────────────────────
// A published number as the state printed it, without float noise: "2.4170000000000003" -> "2.417".
export const num = (s, dp = 3) => { const n = Number(s); return Number.isFinite(n) ? String(+n.toFixed(dp)) : ''; };
export const stars = n => `${n} ${+n === 1 ? 'star' : 'stars'}`;
// Exact-name fallback key: case, punctuation and spacing only — never fuzzy.
export const nameKey = s => String(s || '').toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').trim();
// The pane's line for a rated state's school with no value. {place} {year} are
// filled by the page. True whether the school is absent from the file or listed
// without a rating.
export const MISS = (what = 'rating') =>
  `{place} publishes this ${what}, but has none for this school in its {year} file. Special education, alternative, pre-K and career centres are often not rated.`;
