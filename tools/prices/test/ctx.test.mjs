// node --test tools/prices/test/
// The ctx every source gets: the named user agent by default (and Node's when
// a source asks for it, recorded for the upstream check), a 429 waited out
// for exactly as long as the host asked, and the readers in place.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { makeCtx, retryAfterMs, politeFetch, UA } from '../lib/ctx.mjs';

test('retryAfterMs reads seconds and HTTP dates, and ignores junk', () => {
  assert.equal(retryAfterMs('2'), 2000);
  assert.equal(retryAfterMs(' 0 '), 0);
  const now = Date.parse('Mon, 28 Sep 2026 12:00:00 GMT');
  assert.equal(retryAfterMs('Mon, 28 Sep 2026 12:00:05 GMT', now), 5000);
  assert.equal(retryAfterMs('soon'), null);
  assert.equal(retryAfterMs(null), null);
});

test('ctx.download: named UA by default, Node UA on request (recorded), 429 honoured', async t => {
  const tmp = mkdtempSync(join(tmpdir(), 'prices-ctx-test-'));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  const seen = [];
  let limited = 1;
  const server = createServer((req, res) => {
    seen.push({ path: req.url, ua: req.headers['user-agent'], at: Date.now() });
    if (req.url === '/limited' && limited-- > 0) { res.writeHead(429, { 'retry-after': '1' }); return res.end('slow down'); }
    res.writeHead(200, { etag: '"x"' });
    res.end(`body of ${req.url}`);
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const logs = [];
  const ctx = makeCtx({ rawDir: tmp, log: m => logs.push(m) });

  assert.equal((await ctx.download('a.txt', `${base}/a`)).toString(), 'body of /a');
  assert.equal(seen.at(-1).ua, UA, 'the named user agent by default');
  assert.equal(ctx.provenance.at(-1).ua, undefined, 'the default is not recorded');

  await ctx.download('b.txt', `${base}/b`, { ua: null });
  assert.notEqual(seen.at(-1).ua, UA, "ua: null sends Node's own");
  assert.equal(ctx.provenance.at(-1).ua, null, 'and is recorded for the upstream check');

  const t0 = Date.now();
  assert.equal((await ctx.download('c.txt', `${base}/limited`)).toString(), 'body of /limited');
  const hits = seen.filter(s => s.path === '/limited');
  assert.equal(hits.length, 2, 'one 429, then the retry');
  assert.ok(hits[1].at - hits[0].at >= 950, `waited ${hits[1].at - hits[0].at} ms for Retry-After: 1`);
  assert.ok(Date.now() - t0 < 10_000);
  assert.ok(logs.some(l => /answered 429; waiting 1s/.test(l)));

  // Cached: the second ask does not reach the host.
  const n = seen.length;
  await ctx.download('a.txt', `${base}/a`);
  assert.equal(seen.length, n);
  assert.equal(ctx.provenance.at(-1).cached, true);
});

test('ctx carries coverage, merged regions and every reader', () => {
  const ctx = makeCtx({ rawDir: mkdtempSync(join(tmpdir(), 'prices-ctx-test-')) });
  rmSync(ctx.rawDir, { recursive: true, force: true });
  assert.equal(ctx.coverage.length, Object.keys(ctx.regions).length);
  assert.deepEqual(ctx.coverage[0], { id: 'uk', country: 'gb', bbox: ctx.regions.uk.bbox });
  assert.deepEqual(ctx.regions.uk.juris, ['GB-ENG', 'GB-WLS', 'GB-NIR']);
  assert.deepEqual(ctx.regions.uk.sources, ['ons-msoa', 'ni-ward']);
  assert.deepEqual(ctx.regions.longbeach.scales, ['la-area']);
  assert.equal(ctx.regions.nyc.name, 'New York City');
  assert.ok(ctx.regions.mexicocity.none);
  assert.equal(ctx.inBox(ctx.regions.nyc.bbox, 40.75, -73.98), true);
  for (const r of ['parseCsv', 'records', 'columns', 'unzip', 'xlsx', 'sheetRecords']) assert.equal(typeof ctx.readers[r], 'function', r);
  assert.ok(ctx.readers.shp, 'the shapefile reader');
});

test('politeFetch spaces callers that arrive together, a gap apart', async t => {
  const at = [];
  const server = createServer((req, res) => { at.push(Date.now()); res.end('ok'); });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  const url = `http://127.0.0.1:${server.address().port}/x`;
  await Promise.all([1, 2, 3, 4, 5].map(async () => (await politeFetch(url)).text()));
  at.sort((a, b) => a - b);
  const gaps = at.slice(1).map((x, i) => x - at[i]);
  assert.equal(at.length, 5);
  assert.ok(gaps.every(g => g >= 130), `gaps ${gaps.join(', ')} ms (want >= the 150 ms spacing, less timer slack)`);
});
