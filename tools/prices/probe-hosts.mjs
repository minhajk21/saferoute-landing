#!/usr/bin/env node
// Can a DATACENTER reach every host the home-prices build depends on? Every
// reachability result in the research came from a residential IP, and some of
// these hosts filter: www.ons.gov.uk sits behind Cloudflare and rate-limits
// (~15 requests per 10 s, then 429), admin.opendatani.gov.uk refuses some user
// agents, www12.statcan.gc.ca is flaky, and self-hosted government servers
// have blocked datacenter IPs before. Run from GitHub's runner by
// probe-price-hosts.yml (dispatch only). A host that fails there makes its
// source a "refresh by hand" source, which the build already survives (a
// failed fetch re-emits the tiles).
//
// ONE polite GET per HOST, with the user agent the build uses for it; the body
// is cancelled as soon as the status and headers arrive, so nothing big is
// downloaded. The URL for each host is the first found among:
//   1. the published index.json: a file the build actually fetched from it
//      (with the user agent recorded for it)
//   2. KNOWN below: what the phase-1 sources fetch, so the probe means
//      something before the first build is published
//   3. each source module's meta.url (its landing page)
//
// Usage: node tools/prices/probe-hosts.mjs [--json out.json] [--strict] [--index <index.json>]
//   --strict  exit 1 if any host fails (the default never fails: this
//             reports, it does not gate)
// Writes a Markdown table to $GITHUB_STEP_SUMMARY when that is set.

import { appendFileSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { UA } from './lib/ctx.mjs';
import { loadSources } from './lib/schema.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const argv = process.argv.slice(2);
const arg = n => (argv.includes(n) ? argv[argv.indexOf(n) + 1] : null);

// ua: undefined = the build's named UA; null = Node's default (as a source asks
// with ua: null); a string = that string.
const KNOWN = [
  { src: 'ons-msoa', url: 'https://www.ons.gov.uk/peoplepopulationandcommunity/housing/datasets/medianhousepricesbymiddlelayersuperoutputarea' },
  { src: 'ons-msoa', url: 'https://services1.arcgis.com/ESMARspQHYMw9BZ9/arcgis/rest/services?f=json', expect: 'JSON' },
  { src: 'ni-ward', url: 'https://www.finance-ni.gov.uk/publications/annual-ward-district-electoral-area-and-local-government-districts-statistics' },
  { src: 'ni-ward', url: 'https://ws-data.nisra.gov.uk/public/api.restful/PxStat.Data.Cube_API.ReadMetadata/NIDHPSATWARD/JSON-stat/2.0/en', expect: 'JSON' },
  { src: 'ni-ward', url: 'https://admin.opendatani.gov.uk/api/3/action/package_show?id=987e16f4-19bb-4765-807c-abee92ee3439', expect: 'JSON', ua: null },
  { src: 'acs-tract', url: 'https://www2.census.gov/geo/tiger/GENZ2024/shp/cb_2024_36_tract_500k.zip', expect: 'a zip' },
  { src: 'statcan-ct', url: 'https://www12.statcan.gc.ca/census-recensement/2021/geo/sip-pis/boundary-limites/files-fichiers/lct_000b21a_e.zip', expect: 'a zip' },
  { src: 'statcan-ct', url: 'https://api.statcan.gc.ca/census-recensement/profile/sdmx/rest/codelist/STC_CP/CL_GEO_CMACA', headers: { 'accept-language': 'en' } },
];

const expectFor = file => (/\.zip$/i.test(file) ? 'a zip' : /\.json$/i.test(file) ? 'JSON' : /\.(csv|dat|xlsx|geojson)$/i.test(file) ? 'a data file' : undefined);

async function candidates() {
  const out = [];
  const idxPath = arg('--index') || join(ROOT, 'prices', 'data', 'index.json');
  if (existsSync(idxPath)) {
    const index = JSON.parse(readFileSync(idxPath, 'utf8'));
    for (const [src, m] of Object.entries(index.sources || {})) {
      for (const u of m.upstream || []) if (/^https?:\/\//.test(u.url || '')) out.push({ src, role: 'fetched', url: u.url, ua: u.ua, expect: expectFor(u.file) });
    }
  }
  out.push(...KNOWN.map(k => ({ role: 'known', ...k })));
  try { for (const s of await loadSources()) out.push({ src: s.id, role: 'landing', url: s.meta.url }); }
  catch (e) { console.log(`(source modules not loaded: ${e.message})`); }
  const seen = new Set();
  return out.filter(p => { const h = new URL(p.url).host; if (seen.has(h)) return false; seen.add(h); return true; });
}

async function probe(p) {
  const t0 = Date.now();
  const headers = { ...(p.headers || {}), ...(p.ua === undefined ? { 'user-agent': UA } : p.ua === null ? {} : { 'user-agent': p.ua }) };
  try {
    const res = await fetch(p.url, { headers, redirect: 'follow', signal: AbortSignal.timeout(30_000) });
    const ms = Date.now() - t0;
    const len = res.headers.get('content-length');
    const type = res.headers.get('content-type') || '';
    // A bot challenge is a 200 to fetch but an HTML page, not the data.
    const note = res.ok && p.expect && /text\/html/.test(type) ? `HTML (${type.split(';')[0]}) where ${p.expect} was expected` : '';
    await res.body?.cancel().catch(() => {});
    return { ...p, status: res.status, ok: res.ok && !note, ms, bytes: len ? +len : null, server: res.headers.get('server') || '', note };
  } catch (e) {
    return { ...p, status: 0, ok: false, ms: Date.now() - t0, note: e.cause?.code || e.name || e.message };
  }
}

const list = await candidates();
const results = [];
for (const p of list) results.push(await probe(p));   // one at a time: politeness, and timings stay honest

const host = u => new URL(u).host;
const uaNote = r => (r.ua === null ? ' (Node UA)' : r.ua !== undefined ? ` (UA "${r.ua}")` : '');
for (const r of results) {
  console.log(`${r.ok ? 'OK  ' : 'FAIL'}  ${String(r.status).padStart(3)}  ${String(r.ms).padStart(5)}ms  ${r.role.padEnd(8)} ${r.src.padEnd(11)} ${host(r.url)}${uaNote(r)}${r.note ? `  — ${r.note}` : ''}`);
}
const failed = results.filter(r => !r.ok);
console.log(`\n${results.length - failed.length} of ${results.length} hosts reachable; failures: ${failed.map(r => `${r.src}@${host(r.url)}`).join(', ') || 'none'}`);

if (process.env.GITHUB_STEP_SUMMARY) {
  const md = ['| | status | ms | role | source | host | note |', '|---|---|---|---|---|---|---|',
    ...results.map(r => `| ${r.ok ? 'OK' : '**FAIL**'} | ${r.status} | ${r.ms} | ${r.role} | ${r.src} | ${host(r.url)}${uaNote(r)} | ${r.note || ''} |`)].join('\n');
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, `## Home-price data hosts from this runner\n\n${md}\n`);
}
if (arg('--json')) writeFileSync(arg('--json'), JSON.stringify(results, null, 1));
if (argv.includes('--strict') && failed.length) process.exit(1);
