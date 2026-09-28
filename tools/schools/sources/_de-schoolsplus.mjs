// Northern Ireland: DE's "Schools Plus" institution register
// (apps.education-ni.gov.uk/appinstitutes) — the live list of open schools, and
// the per-school map page that is the source of the vendored coordinates.
// A helper of sources/de.mjs; also the CLI that (re)builds the vendored
// coordinate table tools/data/schools/ni/ni-coords.json.
//
// HOW THE REGISTER IS READ. Schools Plus has no API. Its own ASP.NET form is
// replayed exactly as a browser would: GET the search page, POST "Find"
// (type = Schools, status = Open), POST "Export" as Text. Three requests. The
// session cookie is carried by hand. Node's default user agent: DE's hosts
// refuse a spoofed browser UA (DESIGN.md §7 R3).
//
// COORDINATES (owner decision, Q4): DE's own Open Government Licence points
// only.
//   1. OpenDataNI "locate-a-school" (DE, Feb 2016, UK OGL) — the Schools+
//      extract with latitude/longitude, static since 2017;
//   2. for schools registered since then, the Schools Plus map page
//      (showmap.aspx), which prints DE's latitude/longitude for the school.
// Each point is stored with the postcode DE had for the school when the point
// was taken. A school whose current postcode differs has probably moved since
// and is NOT drawn ("location not published"), and neither is a school with no
// DE point. Nothing is geocoded and no other source's coordinates are used
// (the DfC "DE_Schools_2023_24" layer has no stated licence).
//
// WITHHELD POINTS. A DE point can be stale: the 2016 extract predates some
// moves, and the map page shows the same frozen point. So each point is also
// checked, INTERNALLY, against two independent references that are never
// published or drawn: the centroid of the school's current postcode
// (postcodes.io, ONS/LPS) and DfC's "DE_Schools_2023_24" layer (DE-supplied
// 2023/24 building points; no stated licence, so used only as a check). A
// point more than 1 km from BOTH, where those two agree with each other within
// 1 km, is recorded under meta.withheld and not drawn. One reference alone is
// not enough: rural NI postcodes can have centroids kilometres from a school
// that DE and DfC both place exactly.
//
// CLI:  node tools/schools/sources/_de-schoolsplus.mjs --coords [--out tools/data/schools/ni/ni-coords.json]
//       node tools/schools/sources/_de-schoolsplus.mjs --withhold [--out …]   re-run only the location check
//       node tools/schools/sources/_de-schoolsplus.mjs --register <file.csv>   (just export the register)

import { writeFileSync, mkdirSync, renameSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { records } from '../lib/csv.mjs';

export const SP = 'https://apps.education-ni.gov.uk/appinstitutes/';
export const LOCATE_2016 = 'https://admin.opendatani.gov.uk/dataset/39cd6af4-8fed-4ac9-9620-577a2190bb34/resource/d0947faf-5d84-4ce4-80dd-ce4fa0e1c0d5/download/locate-a-school-open-data-feb-2016.csv';
export const LOCATE_2016_PAGE = 'https://admin.opendatani.gov.uk/dataset/locate-a-school';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
export const COORDS = join(ROOT, 'tools', 'data', 'schools', 'ni', 'ni-coords.json');

const sleep = ms => new Promise(r => setTimeout(r, ms));
const unhtml = s => s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&#039;/g, "'")
  .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n)).replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)));
const hidden = html => Object.fromEntries([...html.matchAll(/<input type="hidden" name="([^"]+)"([^>]*)>/g)]
  .map(m => [m[1], unhtml(/\bvalue="([^"]*)"/.exec(m[2])?.[1] || '')]));
const b64 = s => Buffer.from(s).toString('base64');

export const normRef = r => String(r || '').replace(/\s+/g, '').toUpperCase();          // "IS 106 " -> "IS106"
export const normPostcode = p => String(p || '').replace(/\s+/g, '').toUpperCase();
export const tidyPostcode = p => { const n = normPostcode(p); return n.length > 3 ? `${n.slice(0, -3)} ${n.slice(-3)}` : n; };

// One browser-like session: cookies carried by hand, redirects followed as GET,
// at least gapMs between requests (DE's servers are small; be gentle).
export function session({ gapMs = 1200, timeoutMs = 120_000 } = {}) {
  const jar = new Map();
  let last = 0, requests = 0;
  async function req(url, { form } = {}) {
    let method = form ? 'POST' : 'GET', body = form ? new URLSearchParams(form).toString() : undefined;
    for (let hop = 0; hop < 5; hop++) {
      const wait = last + gapMs - Date.now(); if (wait > 0) await sleep(wait);
      const headers = {};
      if (jar.size) headers.cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
      if (body) headers['content-type'] = 'application/x-www-form-urlencoded';
      requests++;
      const res = await fetch(url, { method, headers, body, redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) });
      for (const c of res.headers.getSetCookie?.() || []) { const kv = c.split(';')[0]; const i = kv.indexOf('='); if (i > 0) jar.set(kv.slice(0, i).trim(), kv.slice(i + 1)); }
      const buf = Buffer.from(await res.arrayBuffer());
      last = Date.now();
      if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
        url = new URL(res.headers.get('location'), url).href; method = 'GET'; body = undefined; continue;
      }
      if (!res.ok) throw new Error(`Schools Plus ${url.split('/').pop()}: HTTP ${res.status}`);
      return { url, buf, text: buf.toString('utf8'), headers: res.headers };
    }
    throw new Error('Schools Plus: too many redirects');
  }
  return { req, stats: () => ({ requests }) };
}

const FORM = {
  'ctl00$ContentPlaceHolder1$instTown': '', 'ctl00$ContentPlaceHolder1$instCounty': '', 'ctl00$ContentPlaceHolder1$instMgt': '',
  'ctl00$ContentPlaceHolder1$instRef$instRef_hfv': '', 'ctl00$ContentPlaceHolder1$instName$instName_hfv': '',
  'ctl00$ContentPlaceHolder1$instAddr$instAddr_hfv': '', 'ctl00$ContentPlaceHolder1$instPostcode$instPostcode_hfv': '',
  'ctl00$ContentPlaceHolder1$instPhone$instPhone_hfv': '',
};

// The register export: every open school (DE type "Schools" = -1, status Open = 0).
// Returns the CSV bytes exactly as DE served them.
export async function exportRegister({ gapMs = 1200 } = {}) {
  const s = session({ gapMs });
  const home = await s.req(SP + 'default.aspx');
  const criteria = { ...FORM, 'ctl00$ContentPlaceHolder1$instType': '-1', 'ctl00$ContentPlaceHolder1$instStatus': '0' };
  const found = await s.req(SP + 'default.aspx', { form: { ...hidden(home.text), ...criteria,
    __EVENTTARGET: 'ctl00$ContentPlaceHolder1$findButton', __EVENTARGUMENT: '' } });
  const matched = /([\d,]+)\s*(?:<\/span>)?\s*institutions? matched/.exec(found.text)?.[1];
  if (!matched) throw new Error('Schools Plus: the Find postback returned no result count (page changed?)');
  const exp = await s.req(SP + 'default.aspx', { form: { ...hidden(found.text), ...criteria,
    __EVENTTARGET: 'ctl00$ContentPlaceHolder1$lvSchools$btnDoExport', __EVENTARGUMENT: '',
    'ctl00$ContentPlaceHolder1$lvSchools$exportType': '2',
    'ctl00$ContentPlaceHolder1$lvSchools$exportFilename$exportFilename_hfv': b64('schools_plus_export') } });
  if (!/^Institution Reference Number,/.test(exp.text)) throw new Error('Schools Plus: the export did not return the register CSV (page changed?)');
  const rows = records(exp.buf, { encoding: 'utf-8' });
  if (Math.abs(rows.length - +matched.replace(/,/g, '')) > 0) throw new Error(`Schools Plus: export has ${rows.length} rows but Find matched ${matched}`);
  return { buf: exp.buf, matched: +matched.replace(/,/g, ''), requests: s.stats().requests };
}

// DE's point for one school, from its Schools Plus map page: search by
// reference, open the single result, then showmap.aspx. { lat, lng, postcode }
// or { nodata: true } ("There is no map data stored for this institution").
export async function showmap(ref, { gapMs = 1200 } = {}) {
  const s = session({ gapMs });
  const home = await s.req(SP + 'default.aspx');
  let r = await s.req(SP + 'default.aspx', { form: { ...hidden(home.text), ...FORM,
    'ctl00$ContentPlaceHolder1$instType': '-2', 'ctl00$ContentPlaceHolder1$instStatus': '0',
    'ctl00$ContentPlaceHolder1$instRef$instRef_hfv': b64(String(ref).trim()),   // as the register writes it ("IS 106")
    __EVENTTARGET: 'ctl00$ContentPlaceHolder1$findButton', __EVENTARGUMENT: '' } });
  if (!/showinstitution/.test(r.url)) {
    r = await s.req(SP + 'default.aspx', { form: { ...hidden(r.text), __EVENTTARGET: 'ctl00$ContentPlaceHolder1$lvSchools$ctrl0$jumpButton', __EVENTARGUMENT: '' } });
  }
  // The detail page prints the reference in its own display form: "[101-0012]",
  // and independent schools as "[IS1-03]" for IS103.
  const shown = /\[\s*([0-9A-Z \-]+?)\s*\]/.exec(r.text.replace(/<[^>]+>/g, ' '))?.[1];
  const bare = x => normRef(x).replace(/-/g, '');
  if (!shown || bare(shown) !== bare(ref)) throw new Error(`showmap ${ref}: search opened ${shown || 'nothing'}`);
  const m = await s.req(SP + 'showmap.aspx');
  const txt = unhtml(m.text.replace(/<script[\s\S]*?<\/script>/g, '').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ');
  if (/no map data stored/i.test(txt)) return { ref, nodata: true };
  const lat = +/Latitude:\s*(-?[\d.]+)/.exec(txt)?.[1], lng = +/Longitude:\s*(-?[\d.]+)/.exec(txt)?.[1];
  const postcode = /Address\s.*?\b(BT\d{1,2}\s*\d[A-Z]{2})\b/i.exec(txt)?.[1] || '';
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || !lat) throw new Error(`showmap ${ref}: no coordinates on the page`);
  return { ref, lat, lng, postcode: tidyPostcode(postcode), x: +/X:\s*(\d+)/.exec(txt)?.[1] || null, y: +/Y:\s*(\d+)/.exec(txt)?.[1] || null };
}

export const DFC_LAYER = 'https://services2.arcgis.com/BdBkthNLO9mzGAMO/arcgis/rest/services/DE_Schools_2023_24/FeatureServer/0';
const WITHHOLD_M = 1000;
const hav = (a, b, c, d) => { const R = 6371000, r = x => x * Math.PI / 180; const h = Math.sin(r(c - a) / 2) ** 2 + Math.cos(r(a)) * Math.cos(r(c)) * Math.sin(r(d - b) / 2) ** 2; return 2 * R * Math.asin(Math.sqrt(h)); };

// The internal location check: returns { withheld: {ref: reason}, summary }.
export async function locationCheck(coords, register, { log = console.log } = {}) {
  const dfc = new Map();
  for (let offset = 0; ; offset += 2000) {
    const u = `${DFC_LAYER}/query?where=1%3D1&outFields=DE_Ref,Postcode&outSR=4326&returnGeometry=true&resultOffset=${offset}&resultRecordCount=2000&f=json`;
    const j = await (await fetch(u, { signal: AbortSignal.timeout(120_000) })).json();
    for (const f of j.features || []) if (f.geometry) dfc.set(String(f.attributes.DE_Ref).replace(/\D/g, ''), [f.geometry.y, f.geometry.x]);
    if (!j.exceededTransferLimit) break;
  }
  const pcs = [...new Set(register.map(r => tidyPostcode(r.Postcode)))];
  const centroid = new Map();
  for (let i = 0; i < pcs.length; i += 100) {
    const res = await fetch('https://api.postcodes.io/postcodes', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ postcodes: pcs.slice(i, i + 100) }), signal: AbortSignal.timeout(60_000) });
    for (const x of (await res.json()).result || []) if (x.result) centroid.set(normPostcode(x.query), [x.result.latitude, x.result.longitude]);
  }
  const withheld = {}, dist = [];
  for (const r of register) {
    const ref = normRef(r['Institution Reference Number']), p = coords[ref];
    if (!p || normPostcode(p[2]) !== normPostcode(r.Postcode)) continue;
    const c = centroid.get(normPostcode(r.Postcode)), d = dfc.get(ref.replace(/\D/g, ''));
    const toC = c ? hav(p[0], p[1], c[0], c[1]) : null, toD = d ? hav(p[0], p[1], d[0], d[1]) : null;
    if (toC != null) dist.push(toC);
    if (toC > WITHHOLD_M && toD > WITHHOLD_M && hav(c[0], c[1], d[0], d[1]) <= WITHHOLD_M) {
      withheld[ref] = `DE point ${(toC / 1000).toFixed(1)} km from the current postcode's centroid and ${(toD / 1000).toFixed(1)} km from DfC's 2023/24 point, which agree within ${Math.round(hav(c[0], c[1], d[0], d[1]))} m`;
      log(`  withheld ${ref} ${r['Institution Name'].trim()}: ${withheld[ref]}`);
    }
  }
  dist.sort((a, b) => a - b);
  return { withheld, summary: { checked: new Date().toISOString(), rule: `withheld when > ${WITHHOLD_M} m from both references and the references agree within ${WITHHOLD_M} m`,
    references: ['postcodes.io postcode centroids (ONS/LPS; internal only)', `DfC DE_Schools_2023_24 (${DFC_LAYER}; no stated licence; internal only)`],
    postcodeCentroids: dist.length, medianToCentroidM: Math.round(dist[Math.floor(dist.length / 2)] || 0), dfcPoints: dfc.size, withheld: Object.keys(withheld).length } };
}

export function readCoords(path = COORDS) {
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null;
}

// ── CLI ─────────────────────────────────────────────────────────────────────
async function main() {
  const argv = process.argv.slice(2);
  const arg = (n, d) => (argv.includes(n) ? argv[argv.indexOf(n) + 1] : d);
  const sha = b => createHash('sha256').update(b).digest('hex');
  if (argv.includes('--register')) {
    const { buf, matched } = await exportRegister();
    writeFileSync(resolve(arg('--register')), buf);
    console.log(`register: ${matched} open schools -> ${arg('--register')}`);
    return;
  }
  const out = resolve(arg('--out', COORDS));
  const write = doc => { mkdirSync(dirname(out), { recursive: true }); writeFileSync(out + '.tmp', JSON.stringify(doc, null, 0).replace(/\],"/g, '],\n"')); renameSync(out + '.tmp', out); };
  if (argv.includes('--withhold')) {
    const doc = readCoords(out);
    if (!doc) throw new Error(`${out} does not exist; run --coords first`);
    const reg = await exportRegister();
    const { withheld, summary } = await locationCheck(doc.coords, records(reg.buf, { encoding: 'utf-8' }).filter(r => r.Type !== 'Further Education'));
    doc.meta.withheld = withheld; doc.meta.locationCheck = summary;
    write(doc);
    console.log(`withheld ${Object.keys(withheld).length}: ${JSON.stringify(summary)}`);
    return;
  }
  if (!argv.includes('--coords')) { console.log('usage: --coords [--out file] | --withhold [--out file] | --register <file.csv>'); process.exit(2); }

  const reg = await exportRegister();
  const schools = records(reg.buf, { encoding: 'utf-8' }).filter(r => r.Type !== 'Further Education');
  console.log(`register: ${schools.length} open schools (excluding further education)`);

  const res = await fetch(LOCATE_2016);
  if (!res.ok) throw new Error(`locate-a-school 2016: HTTP ${res.status}`);
  const c16buf = Buffer.from(await res.arrayBuffer());
  const c16 = new Map(records(c16buf, { encoding: 'latin1' }).map(r => [r.Reference, r]));
  console.log(`locate-a-school 2016: ${c16.size} institutions, sha256 ${sha(c16buf).slice(0, 12)}`);

  const coords = {}, notes = { from2016: 0, fromShowmap: 0, showmapNoData: [], showmapError: [] };
  const todo = [];
  for (const r of schools) {
    const ref = normRef(r['Institution Reference Number']);
    const c = c16.get(ref.replace(/-/g, ''));
    if (c && +c.Latitude && +c.Longitude) { coords[ref] = [+(+c.Latitude).toFixed(5), +(+c.Longitude).toFixed(5), tidyPostcode(c.Postcode), '2016']; notes.from2016++; }
    else todo.push([ref, r['Institution Reference Number'].trim()]);
  }
  console.log(`${notes.from2016} points from the 2016 file; ${todo.length} schools to look up on Schools Plus showmap`);
  for (const [ref, asWritten] of todo) {
    try {
      const p = await showmap(asWritten);
      if (p.nodata) { notes.showmapNoData.push(ref); console.log(`  ${ref}: no map data stored`); continue; }
      coords[ref] = [+p.lat.toFixed(5), +p.lng.toFixed(5), p.postcode, 'showmap'];
      notes.fromShowmap++;
      console.log(`  ${ref}: ${p.lat}, ${p.lng} (${p.postcode})`);
    } catch (e) { notes.showmapError.push(`${ref}: ${e.message}`); console.log(`  ${ref}: ERROR ${e.message}`); }
  }
  const check = await locationCheck(coords, schools);
  const doc = {
    meta: {
      what: 'DE (Northern Ireland) school points by DE reference: [lat, lng, postcode DE held for the school when the point was taken, source]. Source "2016" = OpenDataNI locate-a-school (Feb 2016); "showmap" = Schools Plus map page. sources/de.mjs draws a school only when its current register postcode equals the postcode stored here and it is not in meta.withheld.',
      publisher: 'Department of Education (Northern Ireland)',
      licence: 'Open Government Licence v3.0',
      sources: [
        { id: '2016', name: 'locate-a-school (OpenDataNI), Feb 2016', page: LOCATE_2016_PAGE, url: LOCATE_2016, licence: 'UK Open Government Licence (OGL)', sha256: sha(c16buf), bytes: c16buf.length, lastModified: res.headers.get('last-modified') },
        { id: 'showmap', name: 'Schools Plus institution map page (showmap.aspx)', page: SP + 'default.aspx', licence: 'Open Government Licence v3.0 (DE Crown copyright page)', scraped: new Date().toISOString() },
      ],
      built: new Date().toISOString(),
      register: { open: schools.length, requests: reg.requests },
      counts: { points: Object.keys(coords).length, from2016: notes.from2016, fromShowmap: notes.fromShowmap, showmapNoData: notes.showmapNoData.length, showmapErrors: notes.showmapError.length },
      showmapNoData: notes.showmapNoData, showmapErrors: notes.showmapError,
      withheld: check.withheld, locationCheck: check.summary,
      tool: 'node tools/schools/sources/_de-schoolsplus.mjs --coords',
    },
    coords: Object.fromEntries(Object.entries(coords).sort(([a], [b]) => (a < b ? -1 : 1))),
  };
  write(doc);
  console.log(`wrote ${out}: ${doc.meta.counts.points} points (${notes.from2016} from 2016, ${notes.fromShowmap} from showmap; ${notes.showmapNoData.length} with no DE point, ${notes.showmapError.length} errors)`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(e => { console.error('Schools Plus failed:', e.message); process.exit(1); });
}
