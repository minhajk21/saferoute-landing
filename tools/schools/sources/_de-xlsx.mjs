// A minimal, dependency-free .xlsx reader for the Northern Ireland workbooks
// (DE school census and available places). The repo has no package.json and
// the schools build avoids dependencies, so this reads the zip's central
// directory, inflates the parts it needs with node:zlib, and parses the sheet
// XML with regular expressions. Values only: no styles, no formulas (cached
// results are read), no dates (none are needed here).
//
// DESIGN.md §6a plans a shared tools/schools/lib/xlsx.mjs; until that exists
// this lives beside its only user, sources/de.mjs. It is deliberately the same
// shape (readXlsx(buf) -> { sheets, sheet(name) }) so it can be swapped.
//
//   const wb = readXlsx(buffer);
//   wb.sheets                -> ['Cover sheet', 'Reference Data', ...]
//   wb.sheet('FSM')          -> rows: arrays of cell values (string | number | ''),
//                               indexed by column (A = 0), empty cells ''
//   table(rows, 'DENI ref')  -> objects keyed by the header row that contains
//                               the given first-column heading

import { inflateRawSync } from 'node:zlib';

function unzip(buf) {
  // End of central directory: signature 0x06054b50, within the last 64KB.
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error('not a zip file (no end of central directory)');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const files = new Map();
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('bad zip central directory');
    const method = buf.readUInt16LE(p + 10), size = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28), extraLen = buf.readUInt16LE(p + 30), commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    files.set(name, { method, size, local });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return name => {
    const f = files.get(name);
    if (!f) return null;
    const lp = f.local;
    if (buf.readUInt32LE(lp) !== 0x04034b50) throw new Error(`bad local header for ${name}`);
    const start = lp + 30 + buf.readUInt16LE(lp + 26) + buf.readUInt16LE(lp + 28);
    const data = buf.subarray(start, start + f.size);
    if (f.method === 0) return data.toString('utf8');
    if (f.method === 8) return inflateRawSync(data).toString('utf8');
    throw new Error(`${name}: unsupported zip method ${f.method}`);
  };
}

const XML_ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const unxml = s => s.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (m, e) =>
  e[0] === '#' ? String.fromCodePoint(e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : +e.slice(1)) : XML_ENT[e.toLowerCase()]);
const texts = xml => [...xml.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>|<t(?:\s[^>]*)?\/>/g)].map(m => unxml(m[1] || '')).join('');
const colIndex = ref => { let n = 0; for (const ch of /^[A-Z]+/.exec(ref)[0]) n = n * 26 + ch.charCodeAt(0) - 64; return n - 1; };

export function readXlsx(buf) {
  const part = unzip(buf);
  const wbXml = part('xl/workbook.xml');
  if (!wbXml) throw new Error('not an xlsx workbook (no xl/workbook.xml)');
  const rels = new Map([...(part('xl/_rels/workbook.xml.rels') || '').matchAll(/<Relationship\b[^>]*>/g)]
    .map(m => [/Id="([^"]+)"/.exec(m[0])?.[1], /Target="([^"]+)"/.exec(m[0])?.[1]]));
  const sheets = [...wbXml.matchAll(/<sheet\b[^>]*>/g)].map(m => ({
    name: unxml(/name="([^"]*)"/.exec(m[0])[1]),
    target: rels.get(/r:id="([^"]+)"/.exec(m[0])?.[1]) || '',
  }));
  const ssXml = part('xl/sharedStrings.xml') || '';
  const shared = [...ssXml.matchAll(/<si>([\s\S]*?)<\/si>/g)].map(m => texts(m[1]));
  const cache = new Map();
  function sheet(name) {
    if (cache.has(name)) return cache.get(name);
    const s = sheets.find(x => x.name === name);
    if (!s) throw new Error(`workbook has no sheet "${name}" (has: ${sheets.map(x => x.name).join(', ')})`);
    const path = s.target.startsWith('/') ? s.target.slice(1) : `xl/${s.target.replace(/^\.\//, '')}`;
    const xml = part(path);
    if (xml == null) throw new Error(`sheet "${name}": part ${path} missing`);
    const rows = [];
    for (const rm of xml.matchAll(/<row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/row>)/g)) {
      const r = +/\br="(\d+)"/.exec(rm[1])?.[1] || rows.length + 1;
      const row = [];
      for (const cm of (rm[2] || '').matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const attrs = cm[1], body = cm[2] || '';
        const ref = /\br="([A-Z]+)\d+"/.exec(attrs)?.[1];
        const t = /\bt="([^"]+)"/.exec(attrs)?.[1] || 'n';
        const v = /<v>([\s\S]*?)<\/v>/.exec(body)?.[1];
        let val = '';
        if (t === 's') val = v != null ? shared[+v] ?? '' : '';
        else if (t === 'inlineStr') val = texts(body);
        else if (t === 'str' || t === 'e') val = v != null ? unxml(v) : '';
        else if (t === 'b') val = v === '1';
        else val = v != null && v !== '' ? +v : '';
        const c = ref ? colIndex(ref) : row.length;
        while (row.length < c) row.push('');
        row[c] = val;
      }
      rows[r - 1] = row;
    }
    for (let i = 0; i < rows.length; i++) if (!rows[i]) rows[i] = [];
    cache.set(name, rows);
    return rows;
  }
  return { sheets: sheets.map(s => s.name), sheet };
}

// Rows under the first header row whose first cell is `firstHeading`
// (case/space-insensitive), as objects keyed by that header. Stops at the
// first row whose first cell is empty.
export function table(rows, firstHeading) {
  const norm = s => String(s ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
  const h = rows.findIndex(r => norm(r[0]) === norm(firstHeading));
  if (h < 0) throw new Error(`no header row starting "${firstHeading}"`);
  const head = rows[h].map(c => String(c ?? '').replace(/\s+/g, ' ').trim());
  const out = [];
  for (let i = h + 1; i < rows.length; i++) {
    const r = rows[i];
    if (!r || r[0] === '' || r[0] == null) break;
    out.push(Object.fromEntries(head.map((k, j) => [k, r[j] ?? ''])));
  }
  return out;
}
