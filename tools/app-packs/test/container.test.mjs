// node --test tools/app-packs/test/
// The container: zlib.deflateRawSync output round-trips (every block type:
// stored, fixed and dynamic Huffman, past the 32 KB window), is deterministic,
// and a pack's table, sizes and sha256 are checked when it is opened.
// (test/apple.test.mjs decodes the same kind of stream with Apple's
// Compression framework.)
import test from 'node:test';
import assert from 'node:assert/strict';
import { deflateRawSync, inflateRawSync } from 'node:zlib';
import { FIXTURES } from './helpers.mjs';
import { deflate, inflate, assemble, packJson, openPack, sha256, DEFLATE_OPTS, PACK_VERSION } from '../lib/container.mjs';

test('deflateRawSync output inflates back to the same bytes (every fixture)', () => {
  for (const [name, buf] of Object.entries(FIXTURES)) {
    const z = deflate(buf);
    assert.ok(Buffer.isBuffer(z), name);
    assert.deepEqual(inflate(z), buf, name);
    assert.deepEqual(inflateRawSync(z), buf, name);
    // Raw DEFLATE: no zlib header (0x78 …) in front of the stream.
    if (buf.length > 100) assert.notEqual(z[0], 0x78, `${name}: looks like a zlib header`);
  }
});

test('the container compresses with the plain deflateRawSync parameters, deterministically', () => {
  for (const buf of Object.values(FIXTURES)) {
    assert.deepEqual(deflate(buf), deflate(buf));
    assert.deepEqual(deflate(buf), deflateRawSync(buf, DEFLATE_OPTS));
  }
});

test('assemble + openPack: offsets tile the bin, every chunk reads back', () => {
  const raws = [FIXTURES.shortText, FIXTURES.unicode, FIXTURES.repetitive, FIXTURES.random];
  const { bin, table } = assemble(raws.map((raw, i) => ({ raw, rows: i + 1 })));
  assert.equal(table.length, raws.length);
  assert.equal(table[0][0], 0);
  for (let i = 1; i < table.length; i++) assert.equal(table[i][0], table[i - 1][0] + table[i - 1][1]);
  assert.equal(table.at(-1)[0] + table.at(-1)[1], bin.length);
  const json = packJson({ version: 2, fields: ['x'] }, { version: PACK_VERSION, sha256: sha256(bin), bytes: bin.length, chunks: table });
  const p = openPack(json, bin);
  assert.deepEqual(p.index, { version: 2, fields: ['x'] });
  raws.forEach((raw, i) => { assert.deepEqual(p.chunk(i), raw); assert.equal(p.pack.chunks[i][2], i + 1); assert.equal(p.pack.chunks[i][3], raw.length); });
});

test('openPack refuses a tampered bin, a wrong size and a table with a gap', () => {
  const { bin, table } = assemble([{ raw: FIXTURES.shortText, rows: 1 }, { raw: FIXTURES.unicode, rows: 1 }]);
  const mk = (b, t = table, extra = {}) => packJson({}, { version: PACK_VERSION, sha256: sha256(bin), bytes: bin.length, chunks: t, ...extra });
  const flipped = Buffer.from(bin); flipped[3] ^= 0xff;
  assert.throws(() => openPack(mk(flipped), flipped), /sha256/);
  assert.throws(() => openPack(mk(bin, [table[0], [table[1][0] + 1, table[1][1] - 1, 1, table[1][3]]]), bin), /starts at/);
  assert.throws(() => openPack(mk(bin, table, { version: 99 }), bin), /pack.version/);
  const short = [[...table[0]], [table[1][0], table[1][1], 1, table[1][3] + 5]];
  assert.throws(() => openPack(mk(bin, short), bin).chunk(1), /inflates to/);
});
