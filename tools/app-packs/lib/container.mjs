// The app-pack container, shared by the schools and home-values packs
// (RELEASE-1.4-SCOPE.md §4.4 O1).
//
//   <layer>-pack.bin   the chunks, each compressed on its own with RAW DEFLATE
//                      (RFC 1951: no zlib header, no checksum), concatenated.
//                      That is exactly what Apple's Compression framework calls
//                      COMPRESSION_ZLIB, so the app inflates a chunk with one
//                      compression_decode_buffer call. Nothing else is in the
//                      file: no header, no timestamp.
//   <layer>-pack.json  the layer's slimmed index, plus `pack`:
//                      { version, layer, generated, landingCommit, sha256,
//                        bytes, chunks: [[offset, length, rows, rawLength], …], … }
//                      offset/length locate the compressed chunk in the .bin,
//                      rows is the number of rows it holds, rawLength the size
//                      of the inflated chunk (the decode buffer the app needs).
//                      sha256 is the .bin's.
//
// DETERMINISM. Chunks are compressed with fixed parameters and the JSON is
// written from data whose order is fixed by the inputs, so the same landing
// commit gives byte-identical files (on the same zlib; Node bundles its own).
// `generated` is the landing commit's date, never the time of the run.

import { deflateRawSync, inflateRawSync, constants } from 'node:zlib';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';

export const PACK_VERSION = 1;

// Fixed, so a rebuild is byte-identical. Level 9: the packs ship in the app.
export const DEFLATE_OPTS = Object.freeze({ level: 9, memLevel: 8, windowBits: 15, strategy: constants.Z_DEFAULT_STRATEGY });

export const sha256 = buf => createHash('sha256').update(buf).digest('hex');
export const deflate = buf => deflateRawSync(buf, DEFLATE_OPTS);
export const inflate = buf => inflateRawSync(buf);

// chunks: [{ raw: Buffer, rows: n }] -> { bin, table }
export function assemble(chunks) {
  const parts = [], table = [];
  let offset = 0;
  for (const { raw, rows } of chunks) {
    const z = deflate(raw);
    parts.push(z);
    table.push([offset, z.length, rows, raw.length]);
    offset += z.length;
  }
  return { bin: Buffer.concat(parts), table };
}

// The pack JSON: the index's own keys first, then `pack`.
export function packJson(index, pack) {
  return JSON.stringify({ ...index, pack });
}

// Reads a pack back (JSON + bin) and checks the container itself: the sha256,
// a table that tiles the .bin exactly, and every chunk inflating to its
// declared length. Returns { index, pack, bin, chunk(i) -> Buffer }.
export function openPack(jsonText, bin) {
  const doc = JSON.parse(jsonText);
  const { pack, ...index } = doc;
  const problems = [];
  if (!pack) throw new Error('no `pack` in the pack JSON');
  if (pack.version !== PACK_VERSION) problems.push(`pack.version ${pack.version} (want ${PACK_VERSION})`);
  if (sha256(bin) !== pack.sha256) problems.push('the .bin sha256 differs from pack.sha256');
  if (bin.length !== pack.bytes) problems.push(`the .bin is ${bin.length} bytes, pack.bytes says ${pack.bytes}`);
  let at = 0;
  pack.chunks.forEach(([o, l], i) => { if (o !== at) problems.push(`chunk ${i} starts at ${o}, expected ${at}`); at = o + l; });
  if (at !== bin.length) problems.push(`the chunk table covers ${at} of ${bin.length} bytes`);
  if (problems.length) throw new Error(`pack container: ${problems.join('; ')}`);
  const chunk = i => {
    const [o, l, , rawLength] = pack.chunks[i];
    const raw = inflate(bin.subarray(o, o + l));
    if (raw.length !== rawLength) throw new Error(`chunk ${i} inflates to ${raw.length} bytes, the table says ${rawLength}`);
    return raw;
  };
  return { index, pack, bin, chunk };
}

// Writes both files of one layer into outDir, atomically per file.
export function writePack(outDir, layer, jsonText, bin) {
  mkdirSync(outDir, { recursive: true });
  const out = {};
  for (const [ext, data] of [['bin', bin], ['json', jsonText]]) {
    const path = join(outDir, `${layer}-pack.${ext}`), tmp = `${path}.tmp-${process.pid}`;
    rmSync(tmp, { force: true });
    writeFileSync(tmp, data);
    renameSync(tmp, path);
    out[ext] = path;
  }
  return out;
}

export const readPackFiles = (jsonPath, binPath) => openPack(readFileSync(jsonPath, 'utf8'), readFileSync(binPath));
