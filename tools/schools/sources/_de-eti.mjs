// Northern Ireland: the Education and Training Inspectorate's (ETI) published
// inspection reports, joined to schools by DE reference. A helper of
// sources/de.mjs (the leading "_" keeps the build from loading it as a source),
// and a CLI for the one-off full crawl whose result is vendored in
// tools/data/schools/ni/eti-reports.json.
//
// WHAT IS SHOWN, AND WHAT IS NOT. Only the latest report's type, its
// publication date and a link to it. ETI stopped publishing performance-level
// grades with its new framework (published 5 September 2024, after a pilot
// from September 2023); older reports did carry them, and many reports made
// during teachers' action short of strike (ASOS) carry no judgement at all.
// So no conclusion, grade or "unable to assure" wording is ever parsed or
// shown — only which kind of report it is and when it was published.
//
// POLITENESS. etini.gov.uk rate-limits hard: three concurrent threads got
// HTTP 429 and a 13-minute block in the research. Everything here goes through
// ONE polite getter: one request at a time, at least GAP_MS between the end of
// one response and the start of the next request, exponential back-off on 429.
// Node's default fetch user agent (a spoofed browser UA is refused by the DE
// hosts; see DESIGN.md §7 R3).
//
// FILTER ON THE PAGE, NOT THE TITLE. The research's title regex dropped 175
// real school reports ("College" matched both FE colleges and schools). Which
// publications are school inspection reports is decided from each detail
// page's own "Type: Inspection reports" and "Organisational phase" fields, and
// the school from its "Reference" (the DE institution reference).
//
// CLI (the first crawl, by hand — about 2,900 requests, over an hour):
//   node tools/schools/sources/_de-eti.mjs --full [--since 2016-01-01]
//        [--cache <details.jsonl>]  resume file for parsed detail pages (default: OS tmp)
//        [--out tools/data/schools/ni/eti-reports.json] [--gap-ms 2500]
//        [--seed a.jsonl,b.jsonl --check-seeded 100]  reuse pages already fetched
//        and parsed by an earlier crawl, re-fetching a random sample to prove them

import { readFileSync, writeFileSync, existsSync, appendFileSync, mkdirSync, renameSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

export const ETI = 'https://www.etini.gov.uk';
export const LISTING_URL = `${ETI}/publications/type/inspection-reports`;
export const REPORT_URL = `${ETI}/publications/{ru}`;       // {ru} = the publication slug
export const GAP_MS = 2500;   // never below 1200 (DESIGN.md §1a); 1.3 s drew HTTP 429 after ~20 listing pages on 2026-09-27
export const SINCE = '2016-01-01';
// "Empowering Improvement – New Framework for Inspection", date published
// 05 September 2024 (etini.gov.uk). Its foreword: reports "will no longer have
// any published performance level gradings". The model was piloted from
// September 2023 to June 2024 ("Pilot Inspection" reports).
export const FRAMEWORK_DATE = '2024-09-05';
// The organisational phases whose reports can be about a school on the DE
// register. Pre-school covers nursery schools; playgroups carry letter refs.
export const SCHOOL_PHASES = ['Primary', 'Post-primary', 'Pre-school', 'Special Education', 'Independent'];
const NOT_REPORTS = new Set(['Surveys / Evaluations', 'Support Material']);

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
export const VENDORED = join(ROOT, 'tools', 'data', 'schools', 'ni', 'eti-reports.json');

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── HTML helpers (the pages are server-rendered Drupal; no DOM needed) ───────
const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', ndash: '–', mdash: '—', hellip: '…', szlig: 'ß' };
// Accented letters as named entities (Irish-language school names: "Náile", "Ó").
for (const [mark, comb] of [['acute', '\u0301'], ['grave', '\u0300'], ['circ', '\u0302'], ['uml', '\u0308'], ['tilde', '\u0303']]) {
  for (const v of 'aeiouyAEIOUYnN') ENT[v + mark] = (v + comb).normalize('NFC');
}
Object.assign(ENT, { ccedil: 'ç', Ccedil: 'Ç' });
export const decodeEntities = s => s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) =>
  e[0] === '#' ? String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : +e.slice(1)) : (ENT[e] ?? ENT[e.toLowerCase()] ?? m));
export const textOf = s => decodeEntities(String(s || '').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();

// A listing page: [{ slug, title, date, ptype }] in page order (newest first).
export function parseListing(html) {
  const out = [];
  for (const m of html.matchAll(/<a class="card[^"]*" href="\/publications\/([^"?#]+)">([\s\S]*?)<\/a>/g)) {
    const inner = m[2];
    const title = textOf(/card__title[^>]*>([\s\S]*?)<\/h3>/.exec(inner)?.[1]);
    const date = /<time datetime="(\d{4}-\d{2}-\d{2})/.exec(inner)?.[1] || '';
    const ptype = textOf(/site-topics--item">([\s\S]*?)<\/span>/.exec(inner)?.[1]);
    if (title) out.push({ slug: m[1], title, date, ptype });
  }
  return out;
}

// A publication page: its own title, date published, type, phases and DE reference.
export function parseDetail(html) {
  const main = /<main[\s\S]*?<\/main>/.exec(html)?.[0] || html;
  const field = name => {
    const m = new RegExp(`field--name-${name}[\\s\\S]*?<span class="site-topics--list">([\\s\\S]*?)</span>\\s*</div>`).exec(main);
    return m ? [...m[1].matchAll(/site-topics--item">([\s\S]*?)<\/span>/g)].map(x => textOf(x[1])) : [];
  };
  return {
    title: textOf(/<h1 class="page-title">([\s\S]*?)<\/h1>/.exec(main)?.[1]),
    date: /class="published-date">[\s\S]*?<time datetime="(\d{4}-\d{2}-\d{2})/.exec(main)?.[1] || '',
    type: field('field-publication-type'),
    phases: field('field-site-topics'),
    reference: textOf(/<p class="reference">\s*<span>Reference:\s*<\/span>\s*<span>([\s\S]*?)<\/span>/.exec(main)?.[1]),
  };
}

// DE institution references in a page's Reference field, normalised to the
// register's form: "101-0012" (and "113- 6353" → "113-6353"), "IS89, IS88",
// two refs separated by a space. Pre-school playgroups carry letter refs
// ("1AB-0427"); they are kept here and simply never match a school.
export function refsOf(reference) {
  const out = new Set();
  for (const m of String(reference || '').matchAll(/\b([0-9][0-9A-Z]{2})\s*-\s*(\d{4})\b/g)) out.add(`${m[1]}-${m[2]}`);
  for (const m of String(reference || '').matchAll(/\bIS\s*(\d{1,4})\b/gi)) out.add(`IS${m[1]}`);
  return [...out];
}

// ── what kind of report, in ETI's own words ──────────────────────────────────
// The report title before " - {school}", with "Report of a" and the ASOS
// parenthesis removed, mapped onto a closed list so the scheme can declare its
// allowed values (verify-schools checks every row against them).
export const REPORT_TYPES = [
  'Primary inspection', 'Post-primary inspection', 'Pre-school inspection', 'Special school inspection',
  'Follow-up inspection', 'Sustaining improvement inspection', 'Monitoring inspection', 'Baseline monitoring inspection',
  'Pilot inspection', 'Pilot baseline inspection', 'Unannounced inspection',
  'Independent school inspection', 'Independent school initial registration inspection',
  'Independent school re-registration inspection', 'Re-registration inspection',
  'Education other than at school inspection', 'Inspection',
];
const TYPE_KEYS = REPORT_TYPES.map(t => [t.toLowerCase(), t]).sort((a, b) => b[0].length - a[0].length);
// ETI's titles misspell it now and then ("Acton Short of Strike", "Action
// Schort of Strike", "Action Short Strike"): one miss each in 850 titles.
const ASOS_RE = /\bacti?on\s+s[c]?hort\s+(?:of\s+)?strike\b/i;
export const isAsos = title => ASOS_RE.test(title || '');

export function reportPrefix(title) {
  const t = String(title || '').replace(/[–—]/g, '-');
  return (t.includes(' - ') ? t.slice(0, t.indexOf(' - ')) : t)
    .replace(/\(?(?:involving\s+)?acti?on\s+s[c]?hort\s+(?:of\s+)?strike\)/i, '')
    .replace(/\binpsection\b/i, 'inspection')
    .replace(/^report of (?:an?\s+)?/i, '')
    .replace(/\s+/g, ' ').trim();
}
export function reportType(title) {
  let p = reportPrefix(title).toLowerCase();
  if (p === 'inspection report') p = 'inspection';
  if (/^re-registration inspection( visit)?$/.test(p)) return 'Re-registration inspection';
  // Old titles sometimes run the school name on without " - "
  // ("Primary Inspection Kells and Connor Primary School"): longest known prefix.
  const hit = TYPE_KEYS.find(([k]) => p === k || p.startsWith(k + ' '));
  return hit ? hit[1] : 'Inspection';
}

// Which framework a report was made under, from its title and publication
// date only (never from its contents):
//   'current'  — published on or after 5 Sept 2024, or a "Pilot" report (the
//                new model's pilot, Sept 2023 – June 2024)
//   'previous' — everything else
// A follow-up published on or after 5 Sept 2024 is 'current' whatever the
// style of its title. The two with an old-style "Follow-up Inspection -" title
// (Dundonald High School, 17 Jan 2025; Oakwood School and Assessment Centre,
// 25 Jun 2025) were read in full in the Sept 2026 repair: both are in the new
// framework's format — no performance levels, ending in a "Conclusion" — though
// each follows up an inspection made under the previous framework (May 2022,
// Jan 2023). Calling them "made under the previous framework" was untrue.
export function framework(date, title) {
  if (/^pilot\b/i.test(reportPrefix(title))) return 'current';
  if (!date || date < FRAMEWORK_DATE) return 'previous';
  return 'current';
}

// ── the polite getter ────────────────────────────────────────────────────────
// On HTTP 429 it waits (the site's block lasted about 13 minutes in the
// research), then carries on with its gap doubled, up to 20 s: it slows down
// for good rather than retrying at the rate that was refused.
export function politeGetter({ gapMs = GAP_MS, log = () => {}, timeoutMs = 60_000, max429 = 8, blockWaitMs = 900_000 } = {}) {
  if (gapMs < 1200) throw new Error(`gapMs ${gapMs} is below the 1.2 s floor for etini.gov.uk`);
  let last = 0, requests = 0, n429 = 0, errors = 0;
  async function get(url) {
    let backoff = Math.min(60_000, blockWaitMs);
    for (let attempt = 0; ; attempt++) {
      const wait = last + gapMs - Date.now();
      if (wait > 0) await sleep(wait);
      requests++;
      let res, text;
      try {
        res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });   // Node's default UA, on purpose
        text = await res.text();
      } catch (e) {
        last = Date.now(); errors++;
        if (attempt < 4) { log(`  ETI: ${e.message} on ${url}; retrying`); await sleep(5_000 * (attempt + 1)); continue; }
        throw new Error(`ETI ${url}: ${e.message}`);
      }
      last = Date.now();
      if (res.status === 429) {
        n429++;
        if (n429 > max429) throw new Error(`ETI answered HTTP 429 ${n429} times; stopping to stay polite`);
        gapMs = Math.min(gapMs * 2, 20_000);
        log(`  ETI: HTTP 429 — waiting ${Math.round(backoff / 1000)}s, then continuing at ${gapMs / 1000}s between requests`);
        await sleep(backoff); backoff = Math.min(backoff * 2, blockWaitMs); continue;
      }
      if (res.status >= 500 && attempt < 3) { errors++; await sleep(10_000 * (attempt + 1)); continue; }
      if (!res.ok) throw new Error(`ETI ${url}: HTTP ${res.status}`);
      return text;
    }
  }
  return { get, stats: () => ({ requests, n429, errors, gapMs }) };
}

// ── the crawl (full and incremental share it) ────────────────────────────────
// Listing pages newest first until a whole page is older than `since`; then
// every publication dated `since` or later is opened ONCE (cache permitting)
// and classified by its own Type / Organisational phase / Reference fields.
// Publications the listing card itself types as Surveys / Evaluations or
// Support Material are not opened: that is the site's own classification, not
// a title guess. Every other type (and an untyped card) is opened, and the
// publication page's own Type decides.
export async function crawl({ since = SINCE, get, log = () => {}, cached = () => null, onDetail = () => {}, maxPages = 400 }) {
  const listing = [];
  for (let page = 0; page < maxPages; page++) {
    const items = parseListing(await get(`${LISTING_URL}?page=${page}`));
    if (!items.length) break;
    listing.push(...items);
    if (page % 20 === 0) log(`  ETI listing page ${page}: ${listing.length} items, oldest ${items[items.length - 1].date}`);
    if (items.every(x => x.date && x.date < since)) break;
  }
  const want = listing.filter(x => x.date >= since && !NOT_REPORTS.has(x.ptype));
  log(`  ETI: ${listing.length} listing items; ${want.length} inspection reports since ${since} to open`);
  const details = [];
  let n = 0;
  for (const x of want) {
    let d = cached(x.slug);
    // A record seeded from an earlier crawl of the same page that did not keep
    // the page's Type field takes the listing card's type (the same field).
    if (d && !d.type?.length) d = { ...d, type: x.ptype ? [x.ptype] : [], typeFrom: 'listing' };
    if (!d) {
      d = { slug: x.slug, listDate: x.date, ...parseDetail(await get(`${ETI}/publications/${x.slug}`)) };
      onDetail(d);
    }
    details.push(d);
    if (++n % 100 === 0) log(`  ETI details ${n}/${want.length} (${x.date})`);
  }
  return { listing, details };
}

// A detail page → the compact record that is vendored and joined to schools,
// or null when it is not a school inspection report with a DE reference.
// [date, slug, "ref ref", phase, title]
export function reportRecord(d) {
  if (!d.type.includes('Inspection reports')) return null;
  const phases = d.phases.filter(p => SCHOOL_PHASES.includes(p));
  if (!phases.length) return null;
  const refs = refsOf(d.reference).filter(r => /^\d{3}-\d{4}$|^IS\d+$/.test(r));
  if (!refs.length) return null;
  return [d.date || d.listDate, d.slug, refs.join(' '), phases.join(', '), d.title];
}

export function readVendored(path = VENDORED) {
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, 'utf8'));
}

// ── CLI: the full first crawl ───────────────────────────────────────────────
async function main() {
  const argv = process.argv.slice(2);
  const arg = (n, d) => (argv.includes(n) ? argv[argv.indexOf(n) + 1] : d);
  if (!argv.includes('--full')) { console.log('usage: node tools/schools/sources/_de-eti.mjs --full [--since 2016-01-01] [--cache file.jsonl] [--out file.json] [--gap-ms 2500]'); process.exit(2); }
  const since = arg('--since', SINCE);
  const cacheFile = resolve(arg('--cache', join(tmpdir(), 'saferoute-schools', 'de', 'eti-details.jsonl')));
  const out = resolve(arg('--out', VENDORED));
  const gapMs = +arg('--gap-ms', GAP_MS);
  mkdirSync(dirname(cacheFile), { recursive: true });
  const cache = new Map();
  if (existsSync(cacheFile)) for (const l of readFileSync(cacheFile, 'utf8').split('\n')) if (l.trim()) { const d = JSON.parse(l); cache.set(d.slug, d); }
  // --seed a.jsonl,b.jsonl: publication pages already fetched and parsed earlier
  // (the Sept 2026 research crawl: {href, title, date, reference, phase}). They
  // are used instead of re-fetching, and --check-seeded N re-fetches a random N
  // of them to prove they still read the same.
  let seeded = 0;
  for (const f of (arg('--seed', '') || '').split(',').filter(Boolean)) {
    for (const l of readFileSync(f, 'utf8').split('\n')) {
      if (!l.trim()) continue;
      const r = JSON.parse(l), slug = String(r.href || '').replace(/^\/publications\//, '');
      if (!slug || cache.has(slug) || r.status !== 200) continue;
      cache.set(slug, { slug, listDate: r.date, title: r.title, date: r.date, type: [], phases: r.phase ? r.phase.split(', ') : [], reference: r.reference || '', seeded: true });
      seeded++;
    }
  }
  const started = new Date().toISOString();
  const client = politeGetter({ gapMs, log: console.log });
  console.log(`ETI full crawl since ${since}, gap ${gapMs} ms, ${cache.size} detail pages already cached in ${cacheFile}`);
  const { listing, details } = await crawl({
    since, get: client.get, log: console.log,
    cached: slug => cache.get(slug) || null,
    onDetail: d => appendFileSync(cacheFile, JSON.stringify(d) + '\n'),
  });
  // Re-fetch a random sample of the seeded pages: they must read the same now.
  const checkN = +arg('--check-seeded', 0);
  const seededUsed = details.filter(d => d.seeded);
  const check = { sampled: 0, identical: 0, differences: [] };
  if (checkN && seededUsed.length) {
    let x = 20260927;
    const rnd = () => ((x = (x * 1103515245 + 12345) % 2147483648) / 2147483648);
    const pool = [...seededUsed];
    for (let i = pool.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [pool[i], pool[j]] = [pool[j], pool[i]]; }
    for (const d of pool.slice(0, checkN)) {
      const now = parseDetail(await client.get(`${ETI}/publications/${d.slug}`));
      check.sampled++;
      const same = now.title === d.title && now.date === d.date && now.reference === d.reference && now.phases.join(', ') === d.phases.join(', ') && now.type.join() === d.type.join();
      if (same) check.identical++; else check.differences.push({ slug: d.slug, was: { title: d.title, date: d.date, reference: d.reference, phases: d.phases, type: d.type }, now });
    }
    console.log(`seeded-page check: ${check.identical}/${check.sampled} identical`);
  }
  const reports = details.map(reportRecord).filter(Boolean).sort((a, b) => (a[0] < b[0] ? 1 : a[0] > b[0] ? -1 : a[1] < b[1] ? -1 : 1));
  const s = client.stats();
  const doc = {
    meta: {
      what: 'Education and Training Inspectorate (ETI) inspection reports with a DE school reference, one record per publication: [date published, publication slug, DE reference(s), organisational phase, title]. Crawled from the site\'s own listing and publication pages; the phase and reference come from each publication page.',
      publisher: 'Education and Training Inspectorate (Northern Ireland)',
      licence: 'Open Government Licence v3.0 (etini.gov.uk Crown copyright page)',
      listing: LISTING_URL, reportUrl: REPORT_URL,
      since, crawlStarted: started, crawlFinished: new Date().toISOString(),
      newestListingDate: listing[0]?.date || null,
      listingItems: listing.length,
      inspectionReportsSince: details.length,
      schoolReports: reports.length,
      requests: s.requests, http429: s.n429, gapMs: s.gapMs,
      detailPagesFetched: details.filter(d => !d.seeded).length,
      detailPagesSeeded: seededUsed.length,
      seededFrom: seeded ? 'the same publication pages fetched and parsed on 2026-09-27 by the schools research crawl (single thread, 1.2-1.5 s gap); their Type taken from the listing card' : null,
      seededCheck: checkN ? check : null,
      tool: 'node tools/schools/sources/_de-eti.mjs --full',
    },
    reports,
  };
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out + '.tmp', JSON.stringify(doc, null, 0).replace(/\],\[/g, '],\n['));
  renameSync(out + '.tmp', out);
  console.log(`wrote ${out}: ${reports.length} school reports from ${details.length} inspection reports (${listing.length} listing items); ${s.requests} requests, ${s.n429} × 429`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(e => { console.error('ETI crawl failed:', e.message); process.exit(1); });
}
