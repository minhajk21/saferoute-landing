// A small, dependency-free delimited-text parser shared by every source.
//
// Quote-aware for any separator (NCES EDGE geocode files are pipe-separated
// with no header, and one school name contains a quoted "|"), and it DECODES
// for you, because the encoding is the thing that goes wrong silently:
//   GIAS                windows-1252  (curly apostrophes, the odd é)
//   PSS, CCD, EDGE      latin1
//   BC, Ontario         cp1252 / UTF-8 with a BOM
// Decoding a windows-1252 file as UTF-8 does not fail — it quietly turns every
// "’" into a replacement character on the map.
//
//   parseCsv(bufOrText, { sep = ',', encoding = 'utf-8', header = true })
//     -> { header: string[] | null, rows: string[][] }
//   records(bufOrText, opts) -> object[] keyed by header (values trimmed)
//
// Rows end at "\n"; a "\r" outside quotes is dropped. A trailing partial row is
// kept. A leading BOM is stripped from the text.

export function decode(input, encoding = 'utf-8') {
  if (typeof input === 'string') return input;
  return new TextDecoder(encoding).decode(input);
}

export function parseCsv(input, { sep = ',', encoding = 'utf-8', header = true } = {}) {
  const text = decode(input, encoding).replace(/^﻿/, '');
  const rows = [];
  let row = [], field = '', inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else inQ = false; }
      else field += c;
    } else if (c === '"') inQ = true;
    else if (c === sep) { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (c !== '\r') field += c;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  if (!header) return { header: null, rows };
  const head = (rows.shift() || []).map(h => h.replace(/^﻿/, '').trim());
  return { header: head, rows };
}

export function records(input, opts = {}) {
  const { header, rows } = parseCsv(input, { ...opts, header: true });
  const minLen = header.length - (opts.slack ?? 1);
  return rows.filter(r => r.length >= minLen)
    .map(r => Object.fromEntries(header.map((k, i) => [k, (r[i] ?? '').trim()])));
}

// Column lookup by header name that FAILS on a missing column, rather than
// quietly reading '' for every row after an upstream rename.
export function columns(header, need, what = 'file') {
  const col = Object.fromEntries(header.map((h, i) => [h, i]));
  const missing = need.filter(n => !(n in col));
  if (missing.length) throw new Error(`${what} is missing column(s) ${missing.map(m => `"${m}"`).join(', ')} — the schema changed; refusing to publish a partial build`);
  return col;
}
