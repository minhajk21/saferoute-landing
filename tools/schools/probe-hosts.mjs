#!/usr/bin/env node
// Phase 0 of the schools design: can a DATACENTER reach every host the schools
// build depends on? Every reachability result in the research came from a
// residential IP, and several of these hosts filter by IP or user agent
// (DESIGN.md §7 R2/R3): datos.gob.mx is behind Akamai, michigan.gov answers 403
// to curl, education-ni.gov.uk refuses a spoofed Chrome, cde.ca.gov serves a
// Radware challenge. Run from GitHub's runner by probe-school-hosts.yml
// (dispatch only); a host that fails there becomes a "refresh by hand" source,
// which the build already survives (a failed fetch re-emits the tiles).
//
// Each probe is ONE request with the user agent the build itself uses for that
// host (undefined = Node's default fetch UA). Big files are not downloaded: the
// body is cancelled as soon as the status and headers arrive.
//
// Usage: node tools/schools/probe-hosts.mjs [--json out.json] [--strict]
//   --strict  exit 1 if any MONTHLY-build host fails (the default never fails:
//             this reports, it does not gate)
// Writes a Markdown table to $GITHUB_STEP_SUMMARY when that is set.

import { appendFileSync, writeFileSync } from 'node:fs';
import { loadRatings } from './lib/modules.mjs';

const argv = process.argv.slice(2);
const arg = n => (argv.includes(n) ? argv[argv.indexOf(n) + 1] : null);

// role: 'monthly' = fetched by the monthly build (gias, de, on-priv, bc);
//       'annual'  = fetched only on a deliberate --refresh (ccd, pss, on-sif, sep) or probed for a new vintage;
//       'verify'  = a position reference verify-schools reads;
//       'rating'  = a US rating map, rebuilt by hand (tools/schools/ratings.mjs).
const today = new Date().toISOString().slice(0, 10).replace(/-/g, '');
const PROBES = [
  // England & Wales (gias)
  { src: 'gias', role: 'monthly', url: `https://ea-edubase-api-prod.azurewebsites.net/edubase/downloads/public/edubasealldata${today}.csv`, expect: 'a CSV' },
  { src: 'gias', role: 'monthly', url: 'https://www.gov.uk/government/statistical-data-sets/monthly-management-information-ofsteds-school-inspections-outcomes' },
  { src: 'gias', role: 'verify', url: 'https://api.postcodes.io/postcodes/SW1A1AA', expect: 'JSON' },
  // Northern Ireland (de)
  { src: 'de', role: 'monthly', url: 'https://apps.education-ni.gov.uk/appinstitutes/default.aspx' },
  { src: 'de', role: 'monthly', url: 'https://www.education-ni.gov.uk/articles/school-enrolments-school-level-data' },
  { src: 'de', role: 'monthly', url: 'https://www.etini.gov.uk/publications/type/inspection-reports' },
  { src: 'de', role: 'verify', url: 'https://api.postcodes.io/postcodes/BT15GS', expect: 'JSON' },
  // US (ccd, pss)
  { src: 'ccd', role: 'annual', url: 'https://services1.arcgis.com/Ua5sjt3LWTPigjyD/arcgis/rest/services/School_Characteristics_Current/FeatureServer/1?f=json', expect: 'JSON' },
  { src: 'ccd', role: 'annual', url: 'https://nces.ed.gov/ccd/datatables/api/File/2/7/0/0/0/0', expect: 'JSON' },
  { src: 'ccd', role: 'annual', url: 'https://nces.ed.gov/ccd/Data/zip/ccd_sch_029_2425_w_1a_073025.zip', expect: 'a zip' },
  { src: 'pss', role: 'annual', url: 'https://nces.ed.gov/surveys/pss/zip/pss2324_pu_csv.zip', expect: 'a zip' },
  { src: 'ccd', role: 'verify', url: 'https://www2.census.gov/geo/docs/maps-data/data/gazetteer/2025_Gazetteer/2025_Gaz_zcta_national.zip', expect: 'a zip' },
  // Toronto (on-sif, on-priv) and Vancouver (bc)
  { src: 'on-sif', role: 'annual', url: 'https://data.ontario.ca/api/3/action/package_show?id=school-information-and-student-demographics', expect: 'JSON' },
  { src: 'on-priv', role: 'monthly', url: 'https://data.ontario.ca/api/3/action/package_show?id=private-school-location-list', expect: 'JSON' },
  { src: 'on-priv', role: 'monthly', url: 'https://data.ontario.ca/api/3/action/package_show?id=private-school-contact-information', expect: 'JSON' },
  { src: 'on-sif', role: 'verify', url: 'https://ckan0.cf.opendata.inter.prod-toronto.ca/api/3/action/package_show?id=school-locations-all-types', expect: 'JSON' },
  { src: 'bc', role: 'monthly', url: 'https://catalogue.data.gov.bc.ca/api/3/action/package_show?id=bc-schools-k-12-with-francophone-indicators', expect: 'JSON' },
  { src: 'bc', role: 'verify', url: 'https://opendata.vancouver.ca/api/explore/v2.1/catalog/datasets/schools/records?limit=1', expect: 'JSON' },
  // Mexico City (sep): Node's default UA is required (Akamai refuses curl/python)
  { src: 'sep', role: 'annual', url: 'https://www.datos.gob.mx/api/3/action/package_show?id=catalogo_centros_trabajo_sep', expect: 'JSON' },
  { src: 'sep', role: 'annual', url: 'https://www.datos.gob.mx/api/3/action/datastore_search?resource_id=3457e135-e83c-43d3-b721-f7fb93c5280c&limit=0', expect: 'JSON' },
];

// Rating maps: each module's human landing page (its download may be on the
// same host). michigan.gov needs an empty UA, as its module sends.
for (const r of await loadRatings()) {
  PROBES.push({ src: r.scheme, role: 'rating', url: r.record.url, ua: /michigan\.gov/.test(r.record.url) ? '' : undefined });
}

async function probe(p) {
  const t0 = Date.now();
  const headers = p.ua === undefined ? {} : { 'user-agent': p.ua };
  try {
    const res = await fetch(p.url, { headers, redirect: 'follow', signal: AbortSignal.timeout(30_000) });
    const ms = Date.now() - t0;
    const len = res.headers.get('content-length');
    const server = res.headers.get('server') || '';
    // A bot challenge is a 200 to fetch but an HTML page, not the data: a
    // probe that expects a file or JSON says so rather than passing.
    const type = res.headers.get('content-type') || '';
    const note = res.ok && p.expect && /text\/html/.test(type) ? `HTML (${type.split(';')[0]}) where ${p.expect} was expected` : '';
    await res.body?.cancel().catch(() => {});
    return { ...p, status: res.status, ok: res.ok && !note, ms, bytes: len ? +len : null, server, note };
  } catch (e) {
    return { ...p, status: 0, ok: false, ms: Date.now() - t0, note: e.cause?.code || e.name || e.message };
  }
}

const results = [];
for (const p of PROBES) results.push(await probe(p));   // one at a time: politeness, and timings stay honest

const host = u => new URL(u).host;
const line = r => `${r.ok ? 'OK  ' : 'FAIL'}  ${String(r.status).padStart(3)}  ${String(r.ms).padStart(5)}ms  ${r.role.padEnd(7)} ${r.src.padEnd(12)} ${host(r.url)}${r.ua === '' ? ' (empty UA)' : ''}${r.note ? `  — ${r.note}` : ''}`;
for (const r of results) console.log(line(r));
const failed = results.filter(r => !r.ok);
console.log(`\n${results.length - failed.length} of ${results.length} reachable; failures: ${failed.map(r => `${r.src}@${host(r.url)}`).join(', ') || 'none'}`);

if (process.env.GITHUB_STEP_SUMMARY) {
  const md = ['| | status | ms | role | source | host | note |', '|---|---|---|---|---|---|---|',
    ...results.map(r => `| ${r.ok ? 'OK' : '**FAIL**'} | ${r.status} | ${r.ms} | ${r.role} | ${r.src} | ${host(r.url)}${r.ua === '' ? ' (empty UA)' : ''} | ${r.note || ''} |`)].join('\n');
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, `## School data hosts from this runner\n\n${md}\n`);
}
if (arg('--json')) writeFileSync(arg('--json'), JSON.stringify(results, null, 1));
if (argv.includes('--strict') && failed.some(r => r.role === 'monthly')) process.exit(1);
