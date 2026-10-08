// Shared by the app-pack tests: the real published inputs (read once per test
// process) and fresh copies to mutate into failing fixtures.

import { REPO, loadPageRules, loadSchoolsRules, loadPricesRules } from '../lib/landing.mjs';
import { readSchoolsInput } from '../lib/schools.mjs';
import { readPricesInput } from '../lib/prices.mjs';

export const LANDING = Object.freeze({ landingCommit: 'test', generated: '2026-01-01T00:00:00Z' });

let schools, prices;
export async function realSchools() {
  schools ||= { input: readSchoolsInput(REPO), rules: { ...loadPageRules(REPO), ...(await loadSchoolsRules(REPO)) } };
  return schools;
}
export async function realPrices() {
  prices ||= { input: readPricesInput(REPO), rules: await loadPricesRules(REPO) };
  return prices;
}

// A copy whose index and tiles can be changed without touching the cache.
export const copyInput = input => ({ index: structuredClone(input.index), tiles: input.tiles.map(([k, t]) => [k, t]) });

// Edit the rows of one tile (schools: an array of rows; prices: { a, c }).
export function editTile(input, i, fn) {
  const [k, t] = input.tiles[i];
  const parsed = JSON.parse(t);
  fn(parsed);
  input.tiles[i] = [k, JSON.stringify(parsed)];
}

export const fieldIndex = index => Object.fromEntries(index.fields.map((f, i) => [f, i]));

// Fixtures for the DEFLATE round trip, one per kind of stream: stored blocks
// (incompressible), fixed and dynamic Huffman, matches past the 32 KB window.
// The "random" bytes come from a seeded generator, so a failure reproduces.
function noise(n, seed) {
  const out = Buffer.alloc(n);
  let x = seed >>> 0 || 1;
  for (let i = 0; i < n; i++) { x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0; out[i] = x & 0xff; }
  return out;
}
export const FIXTURES = Object.freeze({
  empty: Buffer.alloc(0),
  oneByte: Buffer.from('['),
  shortText: Buffer.from('[["gias","100000","Sir John Cass\'s Foundation Primary School","EC3A 5DE",51.51466,-0.07743]]'),
  unicode: Buffer.from(JSON.stringify(['Escuela Primaria "La Corregidora"', 'Tláhuac', 'Ñuñoa', 'Gustavo A. Madero', '£420,000', 'owners’ estimate', '↗'])),
  repetitive: Buffer.from('[1,2,3,4,5,6,7,8,9,0],'.repeat(60000)),
  random: noise(200_000, 12345),
  pastWindow: Buffer.concat([noise(40_000, 7), Buffer.from('x'.repeat(5000)), noise(40_000, 7)]),
});
