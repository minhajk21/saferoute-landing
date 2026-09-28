// Toronto: Ontario's private schools, from the Ministry of Education's
// Private School Location List (every site a private school declared in its
// notice of intention to operate, with the Ministry's latitude/longitude),
// LEFT-joined by school number to the Ministry's private school contact list
// for one fact: whether the school offers credits toward the Ontario
// Secondary School Diploma (OSSD).
//
// WHAT THE PANE SAYS, and why. Ontario's Ministry says "We do not endorse
// private schools. Do not read these lists as endorsements.", and it does not
// license, accredit or oversee them. It inspects only private high schools that grant
// OSSD credits, and lets them grant credits only after a successful
// inspection (ontario.ca/page/private-schools). So the pane states the OSSD
// status in the Ministry's own words, with that caveat, and never as a
// rating. A private school carries no rating value (verify fails if it does).
//
// CADENCE: monthly. Both lists are small (about 260 KB and 430 KB) and change
// through the year as schools open, close and file notices.
//
// Dropped: sites whose program type is "Online Only" (no school building).
// Held back and counted: points given to 2 decimal places on both axes (a
// ~1 km cell, not a building), and sites whose published point contradicts
// the postal code of their published address (on-sif.mjs locationDoubts: 12
// Toronto sites in Sept 2026). NOT CARRIED: principal names, e-mail and phone
// (personal information, which the Ontario licence excludes), addresses,
// websites, and "Association Membership" (it names religious bodies; religion
// is never carried).
//
// A school with more than one site has one school number. The main location
// (the Ministry's "School Main Location Flag" = T) keeps the bare number; each
// other site is "<number> (location 2)", "(location 3)" … in a stable order,
// so every pin has a unique id and the attribution still prints the number.

import { records } from '../lib/csv.mjs';
import { ontarioStage } from '../lib/stage.mjs';
import { readXlsx, sheetRecords, ckanResources, fmtPostal, cityName, coarsePoint, r5, positionCheck, torontoSchoolLayer, TORONTO_CITIES,
  loadSif, sifPoints, locationDoubts } from './on-sif.mjs';

const ON_DATA = 'https://data.ontario.ca';

async function locationUrl() {
  const r = (await ckanResources(ON_DATA, 'private-school-location-list'))
    .find(x => /xlsx/i.test(x.format || '') && (/english/i.test(x.language || '') || /_en[_.]/i.test(x.url || '')));
  if (!r) throw new Error('private-school-location-list: no English .xlsx resource');
  return r.url;
}
async function contactUrl() {
  const r = (await ckanResources(ON_DATA, 'private-school-contact-information'))
    .find(x => /csv/i.test(x.format || '') && /contact/i.test(x.url || '') && !/international/i.test(`${x.name} ${x.url}`) &&
      (/english/i.test(x.language || '') || /_eng?[_.]/i.test(x.url || '')));
  if (!r) throw new Error('private-school-contact-information: no English .csv resource');
  return r.url;
}

const LOC_COLUMNS = ['NOI Year', 'School Main Location Flag', 'School Number', 'School Name', 'School Level',
  'School Special Condition Type', 'Latitude', 'Longitude', 'City', 'Postal Code', 'Province', 'Program Type'];

// The contact list's OSSD column, in the Ministry's words -> a tag the pane's
// scheme notes key on. Anything else is reported, never guessed.
function ossdTag(v) {
  if (!v) return '';
  if (/^offers credits toward the ontario secondary school diploma/i.test(v)) return 'ossd';
  if (/^applied to offer credits toward the ontario secondary school diploma/i.test(v)) return 'ossd-applied';
  return null;
}

async function fetchRows(ctx) {
  const book = readXlsx(await ctx.download('private-school-location-list-en.xlsx', locationUrl, { maxAgeH: 12 }));
  const locs = sheetRecords(book.rows(book.sheets[0]), LOC_COLUMNS, `private school location list sheet "${book.sheets[0]}"`);
  const cbuf = await ctx.download('private-school-contact-information-eng.csv', contactUrl, { maxAgeH: 12 });
  // The contact CSV is Windows-1252 (research); only its school number and
  // OSSD columns are read, so a switch to UTF-8 could not garble either.
  const utf8 = cbuf[0] === 0xef && cbuf[1] === 0xbb && cbuf[2] === 0xbf;
  const contacts = records(cbuf, { encoding: utf8 ? 'utf-8' : 'windows-1252' });
  if (!contacts.length || !('OSSD Credits Offered' in contacts[0]) || !('School Number' in contacts[0])) {
    throw new Error('private school contact list: "School Number" / "OSSD Credits Offered" columns not found — the file changed; refusing to publish a partial build');
  }
  const ossd = new Map(contacts.map(c => [c['School Number'], c['OSSD Credits Offered']]));

  // The newest notice-of-intention year only (the list normally holds one).
  const noi = locs.map(r => r['NOI Year']).filter(Boolean).sort().pop();

  // Stable per-school site numbering, over the whole province (so a pin's id
  // never depends on which sites fall inside the box).
  const bySchool = new Map();
  for (const r of locs) {
    if (r['NOI Year'] !== noi) { ctx.stat('dropped.olderNoticeYear'); continue; }
    (bySchool.get(r['School Number']) || bySchool.set(r['School Number'], []).get(r['School Number'])).push(r);
  }
  const out = [];
  for (const [num, sites] of bySchool) {
    sites.sort((a, b) => (a['School Main Location Flag'] === 'T' ? 0 : 1) - (b['School Main Location Flag'] === 'T' ? 0 : 1) ||
      +a.Latitude - +b.Latitude || +a.Longitude - +b.Longitude || a['Postal Code'].localeCompare(b['Postal Code']));
    sites.forEach((r, i) => {
      if (r['Program Type'] === 'Online Only') { ctx.stat('dropped.onlineOnly'); return; }
      if (r.Province !== 'ON') { ctx.stat('dropped.notOntario'); return; }
      const lat = parseFloat(r.Latitude), lng = parseFloat(r.Longitude);
      if (!Number.isFinite(lat) || !Number.isFinite(lng) || !lat || !lng) {
        ctx.stat(TORONTO_CITIES.has(r.City.toLowerCase()) ? 'unmapped.noCoordinates' : 'dropped.noCoordinatesOutsideToronto');
        return;
      }
      if (!ctx.coverage.regionFor(lat, lng, 'CA-ON')) { ctx.stat('dropped.outsideScope'); return; }
      if (coarsePoint(r.Latitude, r.Longitude)) { ctx.stat('unmapped.coarseLocation'); return; }

      // LEFT join: a site whose school is missing from the contact list keeps
      // its pin; the pane then says its OSSD status is not in the list.
      let tag;
      if (!ossd.has(num)) tag = 'ossd-unknown';
      else {
        tag = ossdTag(ossd.get(num));
        // New wording from the Ministry is reported and shown as "not read",
        // never mapped to a status by guesswork.
        if (tag == null) { ctx.warn(`school ${num}: unrecognised OSSD wording "${ossd.get(num)}" — the pane says its status is not shown`); tag = 'ossd-unread'; }
      }
      const cond = r['School Special Condition Type'], prog = r['Program Type'];
      const level = r['School Level'];
      out.push({
        src: 'on-priv', id: i ? `${num} (location ${i + 1})` : num,
        name: r['School Name'], postcode: fmtPostal(r['Postal Code']),
        lat: r5(lat), lng: r5(lng), juris: 'CA-ON',
        // "Private school · All Year Round · Online/Site Based" — the Ministry's own terms
        type: ['Private school', cond && cond !== 'Not applicable' ? cond : '', prog === 'Online/Site Based' ? prog : ''].filter(Boolean).join(' · '),
        sector: 'private', stage: ontarioStage(level), phase: level, boarding: false,
        tags: tag, area: cityName(r.City),
        ratingScheme: 'ca-on-private',
      });
    });
  }
  // The published point against the published address (on-sif.mjs
  // locationDoubts), measured against every located Ontario public school.
  // Today this holds back 12 Toronto private sites: e.g. two Trenton schools
  // and a Markham one drawn on one North York point, a Burlington school in
  // Lake Ontario.
  const { recs: sif } = await loadSif(ctx);
  const doubts = locationDoubts(out, sifPoints(sif));
  for (const [r, d] of doubts) { ctx.stat(d.reason); ctx.log(`     held back ${r.id} ${r.name}: ${d.reason} (${d.km} km from its postal district${d.shared ? `; ${d.shared} schools share the point` : ''})`); }
  const contactDate = (ctx.provenance.find(p => p.file === 'private-school-contact-information-eng.csv')?.lastModified || '');
  const cd = contactDate ? new Date(contactDate).toISOString().slice(0, 10) : '';
  ctx.vintage(`location list ${noi} notices of intention; contact list${cd ? ` updated ${cd}` : ''}`);
  const kept = out.filter(r => !doubts.has(r));
  // What the published pins say: OSSD status and extra sites, after hold-backs.
  for (const r of kept) {
    ctx.stat(`ossd.${{ ossd: 'offers', 'ossd-applied': 'applied', 'ossd-unknown': 'noContactRecord', 'ossd-unread': 'unrecognisedWording' }[r.tags] || 'notListed'}`);
    if (/\(location \d+\)$/.test(r.id)) ctx.stat('additionalLocations');
  }
  return kept;
}

async function verify(rows, { haversine }) {
  const ref = (await torontoSchoolLayer()).filter(p => /private/i.test(p.kind || ''));
  return [positionCheck(rows.filter(r => r.juris === 'CA-ON'), ref, {
    haversine, juris: 'CA-ON', minMatched: 60,
    reference: 'City of Toronto "School Locations – All Types" (private schools; internal check only, not published)',
  })];
}

const OGL_ON = 'Open Government Licence – Ontario';
const NO_ENDORSE = "Ontario's Ministry of Education does not license, accredit or endorse private schools, and publishes no rating for them.";

export default {
  id: 'on-priv',
  juris: ['CA-ON'],
  cadence: 'monthly',
  meta: {
    name: 'Private School Location List and private school contact information (Ontario Ministry of Education)',
    publisher: 'Ontario Ministry of Education',
    licence: OGL_ON,
    licenceUrl: 'https://www.ontario.ca/page/open-government-licence-ontario',
    attribution: `Ontario private school number {id} · Ontario Ministry of Education, Private School Location List and private school contact information. Contains information licensed under the ${OGL_ON}.`,
    where: 'Toronto private schools',
    publishes: [],
    labels: { type: 'Type', phase: 'Level' },
  },
  schemes: {
    // Not a rating: the OSSD status is a fact about which credits a school may
    // grant. First matching note wins (row.tags carries the status).
    'ca-on-private': {
      kind: 'none',
      notes: [
        { when: { tags: 'ossd' }, html: `<b>Offers credits toward the Ontario Secondary School Diploma (OSSD)</b>, according to the Ministry of Education's private school list. The Ministry inspects the OSSD credit courses of private high schools and lets them grant credits only after a successful inspection; it does not inspect premises, health and safety or staffing. ${NO_ENDORSE}` },
        { when: { tags: 'ossd-applied' }, html: `<b>Applied to offer credits toward the Ontario Secondary School Diploma (OSSD)</b>, according to the Ministry of Education's private school list. The Ministry lets a private high school grant credits only after a successful inspection. ${NO_ENDORSE}` },
        { when: { tags: 'ossd-unread' }, html: `The Ministry of Education's private school contact list describes this school's Ontario Secondary School Diploma (OSSD) credits in wording this map does not yet recognise, so its status is not shown here. ${NO_ENDORSE}` },
        { when: { tags: 'ossd-unknown' }, html: `This school is not in the Ministry of Education's private school contact list, which records whether a school offers credits toward the Ontario Secondary School Diploma. ${NO_ENDORSE}` },
        { html: `<b>A private school not listed as offering credits toward the Ontario Secondary School Diploma (OSSD).</b> The Ministry of Education does not inspect private elementary schools, or private high schools that do not offer OSSD credits. ${NO_ENDORSE}` },
      ],
    },
  },
  fetch: fetchRows,
  verify,
};
