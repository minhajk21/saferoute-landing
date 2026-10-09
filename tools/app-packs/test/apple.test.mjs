// node --test tools/app-packs/test/*.test.mjs
// Apple compatibility, proved on this Mac: test/inflate.swift decodes with the
// Compression framework (compression_decode_buffer, COMPRESSION_ZLIB), the
// call the app will make, and its sha256 must equal Node's inflateRawSync.
//   1. the DEFLATE fixtures (stored, fixed and dynamic Huffman, past the window);
//   2. EVERY chunk of each real pack.
// Skipped where there is no swift (not macOS).
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { FIXTURES, realSchools, realPrices, LANDING } from './helpers.mjs';
import { assemble, openPack, sha256 } from '../lib/container.mjs';
import { packSchools } from '../lib/schools.mjs';
import { packPrices } from '../lib/prices.mjs';

const SWIFT = join(dirname(fileURLToPath(import.meta.url)), 'inflate.swift');
const hasSwift = process.platform === 'darwin' && spawnSync('swift', ['--version'], { encoding: 'utf8' }).status === 0;

// Decode chunks [[offset, length, rawLength], …] of binPath with Apple's decoder.
function appleDecode(binPath, chunks) {
  const r = spawnSync('swift', [SWIFT, binPath, ...chunks.map(([o, l, raw]) => `${o}:${l}:${raw}`)], { encoding: 'utf8', timeout: 300_000 });
  assert.equal(r.status, 0, `swift: ${r.stderr}\n${r.stdout}`);
  return r.stdout.trim().split('\n').map(line => { const [offset, bytes, hex] = line.split(' '); return { offset: +offset, bytes: +bytes, sha256: hex }; });
}

test('Apple COMPRESSION_ZLIB decodes the deflateRawSync fixtures byte for byte', { skip: !hasSwift && 'no swift on this machine' }, () => {
  const named = Object.entries(FIXTURES).filter(([, b]) => b.length > 0);   // a zero-byte chunk has nothing to decode
  const { bin, table } = assemble(named.map(([, raw]) => ({ raw, rows: 1 })));
  const dir = mkdtempSync(join(tmpdir(), 'apple-fixtures-'));
  try {
    const path = join(dir, 'fixtures.bin');
    writeFileSync(path, bin);
    const got = appleDecode(path, table.map(([o, l, , raw]) => [o, l, raw]));
    named.forEach(([name, raw], i) => {
      assert.equal(got[i].bytes, raw.length, name);
      assert.equal(got[i].sha256, sha256(raw), name);
    });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

for (const [layer, real, pack] of [['schools', realSchools, packSchools], ['prices', realPrices, packPrices]]) {
  test(`Apple COMPRESSION_ZLIB decodes EVERY ${layer} chunk to Node's bytes`, { skip: !hasSwift && 'no swift on this machine' }, async () => {
    const { input, rules } = await real();
    const b = pack(input, rules, LANDING);
    const { pack: p, chunk } = openPack(b.json, b.bin);
    const dir = mkdtempSync(join(tmpdir(), `apple-${layer}-`));
    try {
      const path = join(dir, `${layer}-pack.bin`);
      writeFileSync(path, b.bin);
      const got = appleDecode(path, p.chunks.map(([offset, length, , rawLength]) => [offset, length, rawLength]));
      assert.equal(got.length, p.chunks.length);
      p.chunks.forEach(([offset, , , rawLength], i) => {
        assert.equal(got[i].offset, offset, `chunk ${i}`);
        assert.equal(got[i].bytes, rawLength, `chunk ${i}`);
        assert.equal(got[i].sha256, sha256(chunk(i)), `chunk ${i}`);
      });
      const i = p.chunks.reduce((best, c, k) => (c[1] > p.chunks[best][1] ? k : best), 0);
      console.log(`# ${layer}: all ${p.chunks.length} chunks decode with Apple's COMPRESSION_ZLIB to Node's sha256 (largest: chunk ${i}, ${p.chunks[i][1]} bytes deflated, ${p.chunks[i][3]} raw)`);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
}
