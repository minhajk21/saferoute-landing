// Raw downloads for school sources: cached OUTSIDE the repo, with provenance.
//
// RAW FILES NEVER GO INTO THE REPO. The monthly page rebuild commits with
// `git add -A`; a 62MB GIAS CSV left in the tree would be published. Every
// download lands in rawDir — the OS temp dir by default, or --raw-dir.
//
// Each download writes a sidecar <file>.meta.json recording where the bytes
// came from (URL, HTTP Last-Modified/ETag, sha256, size, when). The build copies
// that into index.json's sources[src].upstream, so every published school can
// be traced to the exact upstream file it was built from.
//
//   const dl = makeDownloader({ rawDir, frozen, log });
//   const buf = await dl.download('gias.csv', urls, { maxAgeH: 12, ua, timeoutMs });
//   dl.provenance  -> [{ file, url, sha256, bytes, lastModified, etag, fetchedAt, cached }]
//
// urls: a string, an array tried in order (first HTTP 200 wins), or an async
// function returning either — so a source can resolve a date-stamped filename
// only when it actually has to fetch.
//
// ua: undefined = Node's default fetch user agent (what most hosts in the
// research accepted); '' = send an empty User-Agent (michigan.gov); any other
// string is sent as-is. Never set one global browser string: hosts disagree
// (DESIGN.md §7 R3), and a spoofed Chrome UA is refused by education-ni.gov.uk.
//
// frozen: never touch the network; use whatever is in rawDir whatever its age,
// and fail if a file is missing. For reproducible before/after comparisons.
//
// fetchImpl: optional stand-in for the global fetch (same signature). The
// home-prices build passes one that paces requests per host and waits out a
// 429's Retry-After (tools/prices/lib/ctx.mjs); schools passes nothing, so its
// requests are exactly as before.

import { existsSync, readFileSync, writeFileSync, statSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

const sha256 = buf => createHash('sha256').update(buf).digest('hex');

export function makeDownloader({ rawDir, frozen = false, log = () => {}, fetchImpl = null }) {
  mkdirSync(rawDir, { recursive: true });
  const provenance = [];

  async function download(file, urls, { maxAgeH = 12, ua, timeoutMs = 180_000, headers = {} } = {}) {
    const path = join(rawDir, file), side = `${path}.meta.json`;
    if (existsSync(path)) {
      const ageH = (Date.now() - statSync(path).mtimeMs) / 36e5;
      if (frozen || ageH < maxAgeH) {
        const buf = readFileSync(path);
        let meta = {};
        try { meta = JSON.parse(readFileSync(side, 'utf8')); } catch {}
        const rec = { ...meta, file, bytes: buf.length, sha256: sha256(buf), cached: true };
        provenance.push(rec);
        log(`  using cached ${file} (${ageH.toFixed(1)}h old${frozen ? ', frozen' : ''})`);
        return buf;
      }
    }
    if (frozen) throw new Error(`--frozen: ${file} is not in ${rawDir}`);

    let list = typeof urls === 'function' ? await urls() : urls;
    list = Array.isArray(list) ? list : [list];
    const tried = [];
    for (const url of list) {
      const h = { ...headers };
      if (ua !== undefined) h['user-agent'] = ua;
      let res;
      try { res = await (fetchImpl || fetch)(url, { headers: h, signal: AbortSignal.timeout(timeoutMs) }); }
      catch (e) { tried.push(`${url.split('/').pop()}: ${e.message}`); continue; }
      if (!res.ok) { tried.push(`${url.split('/').pop()}: HTTP ${res.status}`); continue; }
      const buf = Buffer.from(await res.arrayBuffer());
      const rec = {
        file, url, status: res.status,
        lastModified: res.headers.get('last-modified') || null,
        etag: res.headers.get('etag') || null,
        fetchedAt: new Date().toISOString(),
        bytes: buf.length, sha256: sha256(buf),
      };
      writeFileSync(path, buf);
      writeFileSync(side, JSON.stringify(rec, null, 1));
      provenance.push({ ...rec, cached: false });
      log(`  fetched ${url.split('/').pop()} (${(buf.length / 1e6).toFixed(1)}MB)`);
      return buf;
    }
    throw new Error(`${file}: no URL answered (${tried.join('; ') || 'none tried'})`);
  }

  return { download, provenance };
}
