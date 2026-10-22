// The crime source line under a /check/ score (check/index.html, between
// "BEGIN crimeSource" and "END crimeSource"); this test runs that exact block.
//   - Denver: the City of Denver Open Data Catalog's Terms of Use ask for the
//     credit "City of Denver Open Data Catalog" linked to data.denvergov.org
//     and "CC BY 3.0" linked to the licence. Both become links, with the new
//     backend and with one that predates the credit.
//   - Nashville: Metro's Executive Order 018 asks for the URL and the date the
//     data was retrieved; the backend's dated text is shown as it comes.
//   - Charlotte's notice and every unlicensed city are unchanged.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const page = readFileSync(join(ROOT, 'check', 'index.html'), 'utf8');
const a = page.indexOf('// ── BEGIN crimeSource'), b = page.indexOf('// ── END crimeSource ──');
const helper = (name) => {
  const m = new RegExp(`^function ${name}\\(.*$`, 'm').exec(page);
  assert.ok(m, `${name} not found in check/index.html`);
  return m[0];
};
const { crimeSourceHtml } = new Function(
  `${helper('esc')}\n${helper('monthName')}\n${page.slice(a, b)}; return { crimeSourceHtml };`)();

const BY3 = 'https://creativecommons.org/licenses/by/3.0/';
const DENVER = 'City of Denver Open Data Catalog (data.denvergov.org), CC BY 3.0: creativecommons.org/licenses/by/3.0';
const DENVER_LICENCE = {
  name: 'CC BY 3.0', url: BY3,
  attribution: { name: 'City of Denver Open Data Catalog', url: 'https://data.denvergov.org/' },
};
const link = (url, text) => `<a href="${url}" target="_blank" rel="noopener">${text}</a>`;

test('the page carries the crimeSource block', () => {
  assert.ok(a > 0 && b > a, 'markers not found in check/index.html');
});

test('Denver: the catalog credit and the licence are both links', () => {
  const h = crimeSourceHtml({ region: 'denver', dataSource: DENVER, licence: DENVER_LICENCE, crimeDate: '2026-09' });
  assert.equal(h,
    `${link('https://data.denvergov.org/', 'City of Denver Open Data Catalog')}, ${link(BY3, 'CC BY 3.0')}.` +
    ' Data through September 2026. Locations are anonymised by the source. Informational only.');
});

test('Denver: a backend from before the credit still gets it, linked', () => {
  const h = crimeSourceHtml({ region: 'denver', dataSource: 'Open Data Denver', licence: null, crimeDate: '2026-09' });
  assert.ok(h.includes(link('https://data.denvergov.org/', 'City of Denver Open Data Catalog')), h);
  assert.ok(h.includes(link(BY3, 'CC BY 3.0')), h);
});

test('Nashville: the dated credit with its URL is shown as the backend sends it', () => {
  const ds = 'Metro Nashville Police Department Incidents (data.nashville.gov), retrieved 2026-10-22';
  const h = crimeSourceHtml({ region: 'nashville', dataSource: ds, licence: null, crimeDate: '2026-10' });
  assert.equal(h, `${ds} · through October 2026. Locations are anonymised by the source. Informational only.`);
});

test('Charlotte and an unlicensed city are unchanged', () => {
  const ds = 'Charlotte-Mecklenburg Police Department, via City of Charlotte Open Data. ' +
    'Charlotte scores and maps are adapted from this data and offered under ' +
    'CC BY-NC-SA 4.0 (share-alike): creativecommons.org/licenses/by-nc-sa/4.0';
  const nc = 'https://creativecommons.org/licenses/by-nc-sa/4.0/';
  const h = crimeSourceHtml({ region: 'charlotte', dataSource: ds, licence: { name: 'CC BY-NC-SA 4.0', url: nc }, crimeDate: '2026-09' });
  assert.equal(h, 'Charlotte-Mecklenburg Police Department, via City of Charlotte Open Data. ' +
    `Charlotte scores and maps are adapted from this data and offered under ${link(nc, 'CC BY-NC-SA 4.0')} (share-alike).` +
    ' Data through September 2026. Locations are anonymised by the source. Informational only.');
  assert.equal(crimeSourceHtml({ region: 'nyc', dataSource: 'NYC Open Data', licence: null, crimeDate: '2026-09' }),
    'NYC Open Data · through September 2026. Locations are anonymised by the source. Informational only.');
});
