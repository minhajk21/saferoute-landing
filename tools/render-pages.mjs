#!/usr/bin/env node
// tools/render-pages.mjs
//
// Renders the /safety/ programmatic pages from tools/data-cache/<city>/*.json
// (produced by generate-data.mjs): one static page per neighborhood for every
// city with a gazetteer + data, a per-city hub with a client-side area checker,
// the /safety/ root, sitemap.xml and robots.txt.
//
// Design constraints, in order:
//   1. Every page must be genuinely informative from DATA (score, breakdown,
//      time-of-day, comparisons) — never a thin template with the name swapped.
//   2. Framing discipline (mirrors the app): "reported incidents", dated,
//      sourced, informational-only — routes and times, never area verdicts.
//   3. Fully static output. No runtime backend calls, no JS required to read
//      a page (the hub checker is the only progressive enhancement).
//
// Per-city copy (agency, spelling, sources, boundaries) lives in CITIES below —
// London pages read in British English against data.police.uk sourcing; NYC
// pages are unchanged from the original NYC-only renderer.
//
// Run: node tools/render-pages.mjs

import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SITE = 'https://safe-route.app';
const APP_ID = '6768244297';

// App Store campaign attribution. Without a campaign token, an install that
// started on safe-route.app is indistinguishable in App Analytics from one that
// started in App Store search — which is exactly the hole found on 2026-08-05:
// "Web Referrer" was the ONLY source type with no data at all, while the site
// was serving ~2,500 views a month. That could have meant nobody clicks the CTA
// OR that clicks simply aren't attributed, and there was no way to tell.
//
// `pt` is the provider token from the App Store Connect campaign-link generator
// (Analytics → Acquisition → Campaigns); it is not a secret — it appears in
// every public campaign URL. `mt=8` is the media type (apps).
//
// DELIBERATELY COARSE: three campaigns for the whole site, not one per city.
// Apple hides a campaign until at least FIVE individual Apple Accounts install
// from it, and the app takes ~72 installs a MONTH in total — so per-city tokens
// would guarantee every one stayed below the threshold and reported nothing.
const APP_PT = '128877797';
const appStoreURL = (campaign) =>
  `https://apps.apple.com/app/apple-store/id${APP_ID}?pt=${APP_PT}&ct=${campaign}&mt=8`;
const APP_URL = appStoreURL('web-safety-pages');

// ── per-city configuration ───────────────────────────────────────────────────
const CITIES = {
  'new-york': {
    name: 'New York',
    hubName: 'New York City',
    rankPool: 'NYC neighborhoods',
    areaWord: 'neighborhood', areaWordPlural: 'neighborhoods',
    centre: 'center', centreLabel: 'neighborhood center',
    reportedTo: 'reported to the NYPD',
    dataName: 'NYPD data',
    medianLabel: 'citywide median',
    forCity: 'for New York City',
    acrossCity: 'across NYC',
    faqCalc: (name) => `SafeRoute weights each incident reported to the NYPD by severity (violence weighs more than shoplifting), sums the last available period within 1 km of the ${name} center, and normalizes against citywide crime rates onto a 0–100 scale — higher is safer. It describes reported crime only; it is not a guarantee of safety.`,
    sources: (dateLine) => `Crime data: NYPD complaint data via <a href="https://opendata.cityofnewyork.us/">NYC Open Data</a>${dateLine}. Neighborhood boundaries: NYC 2020 Neighborhood Tabulation Areas. Basemap (streets, parks, shoreline): NYC Open Data. Analysis © SafeRoute.`,
    basemapCredit: 'basemap: NYC Open Data',
    hub: {
      title: (n) => `New York Neighborhood Safety Map & Rankings (${n} areas) — SafeRoute`,
      desc: (n, date) => `How safe is your NYC neighborhood? Safety index (0–100) for ${n} New York neighborhoods from NYPD reported-crime data through ${date} — ranked by borough, with crime maps and night-time patterns.`,
      h1: 'How safe is your New York neighborhood?',
      lead: `SafeRoute scores every NYC neighborhood 0–100 from incidents reported to the NYPD — severity-weighted, within 1 km of each neighborhood's center, normalized citywide. Higher is safer. The same data powers the SafeRoute app's crime-aware walking routes.`,
      placeholder: 'Check a neighborhood — e.g. Harlem, Bushwick, Astoria…',
      notice: (median) => `These figures describe <strong>reported</strong> crime around each neighborhood's center — they are informational, not a judgment of any community. Citywide median index: <strong>${median}/100</strong>.`,
      methodology: `Each incident reported to the NYPD (via NYC Open Data) is weighted by severity — violence counts for more than shoplifting. For every neighborhood we sum weighted incidents within 1 km of its center (2020 Neighborhood Tabulation Area centroids), and normalize against citywide crime rates onto a 0–100 index, higher&nbsp;=&nbsp;safer. Time-of-day charts use NYPD incident timestamps, severity-weighted. Pages regenerate as new data is published.`,
    },
  },
  'london': {
    name: 'London',
    hubName: 'Inner London',
    rankPool: 'Inner London areas',
    areaWord: 'neighbourhood', areaWordPlural: 'neighbourhoods',
    centre: 'centre', centreLabel: 'neighbourhood centre',
    reportedTo: 'reported to the police',
    dataName: 'Police data',
    medianLabel: 'Inner London median',
    forCity: 'for Inner London',
    acrossCity: 'across Inner London',
    faqCalc: (name) => `SafeRoute weights each police-recorded incident by severity (violence weighs more than shoplifting), sums the last available period within 1 km of the ${name} centre, and normalises against national crime rates onto a 0–100 scale — higher is safer. It describes reported crime only; it is not a guarantee of safety.`,
    sources: (dateLine) => `Crime data: street-level crime via <a href="https://data.police.uk/">data.police.uk</a> (Open Government Licence v3.0)${dateLine}. Ward boundaries: ONS, December 2025. Basemap © <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors (ODbL). Analysis © SafeRoute.`,
    basemapCredit: 'basemap © OpenStreetMap contributors',
    hub: {
      title: (n) => `London Neighbourhood Safety Map & Rankings (${n} Inner London areas) — SafeRoute`,
      desc: (n, date) => `How safe is your London neighbourhood? Safety index (0–100) for ${n} Inner London wards from police street-level crime data through ${date} — ranked by borough, with crime maps.`,
      h1: 'How safe is your London neighbourhood?',
      lead: `SafeRoute scores every Inner London ward 0–100 from street-level incidents reported to the police — severity-weighted, within 1 km of each area's centre. Higher is safer. The same data powers the SafeRoute app's crime-aware walking routes.`,
      placeholder: 'Check an area — e.g. Camden Town, Brixton, Shoreditch…',
      notice: (median) => `These figures describe <strong>reported</strong> crime around each area's centre — they are informational, not a judgment of any community. Note: data.police.uk anonymises incident locations to the nearest of ~750k snap points, so dots mark streets, not addresses. Inner London median index: <strong>${median}/100</strong>.`,
      methodology: `Each incident published by the police (via data.police.uk, Open Government Licence) is weighted by severity — violence counts for more than shoplifting. For every ward we sum weighted incidents within 1 km of its centre (ONS December 2025 ward centroids), and normalise onto a 0–100 index, higher&nbsp;=&nbsp;safer. Incident locations are anonymised by the police to nearby snap points, so the maps show streets rather than exact addresses. Pages regenerate as new data is published.`,
    },
  },
  'chicago': {
    name: 'Chicago',
    hubName: 'Chicago',
    rankPool: 'Chicago community areas',
    // Chicago's official unit is the "community area", but people search
    // "neighborhood" — so the prose says neighborhood and the methodology
    // states plainly that the boundaries are the city's 77 community areas.
    areaWord: 'neighborhood', areaWordPlural: 'neighborhoods',
    centre: 'center', centreLabel: 'neighborhood center',
    reportedTo: 'reported to the Chicago Police Department',
    dataName: 'Chicago PD data',
    medianLabel: 'citywide median',
    forCity: 'for Chicago',
    acrossCity: 'across Chicago',
    faqCalc: (name) => `SafeRoute weights each incident reported to the Chicago Police Department by severity (violence weighs more than shoplifting), sums the last available period within 1 km of the ${name} center, and normalizes against citywide crime rates onto a 0–100 scale — higher is safer. It describes reported crime only; it is not a guarantee of safety.`,
    sources: (dateLine) => `Crime data: Chicago Police Department "Crimes — 2001 to Present" via the <a href="https://data.cityofchicago.org/">Chicago Data Portal</a>${dateLine}. Neighborhood boundaries: City of Chicago community areas (all 77). Basemap © <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors (ODbL). Analysis © SafeRoute.`,
    basemapCredit: 'basemap © OpenStreetMap contributors',
    hub: {
      title: (n) => `Chicago Neighborhood Safety Map & Rankings (${n} community areas) — SafeRoute`,
      desc: (n, date) => `How safe is your Chicago neighborhood? Safety index (0–100) for all ${n} Chicago community areas from Chicago PD reported-crime data through ${date} — ranked citywide, with crime maps and night-time patterns.`,
      h1: 'How safe is your Chicago neighborhood?',
      lead: `SafeRoute scores all 77 Chicago community areas 0–100 from incidents reported to the Chicago Police Department — severity-weighted, within 1 km of each area's center, normalized citywide. Higher is safer. The same data powers the SafeRoute app's crime-aware walking routes.`,
      placeholder: 'Check a neighborhood — e.g. Lincoln Park, Hyde Park, Logan Square…',
      rankHeading: (n) => `All ${n} community areas, safest first`,
      notice: (median) => `These figures describe <strong>reported</strong> crime around each neighborhood's center — they are informational, not a judgment of any community. Note: to protect victims' privacy, the Chicago Police Department publishes incident locations at block level, so dots mark blocks, not addresses. Citywide median index: <strong>${median}/100</strong>.`,
      methodology: `Each incident reported to the Chicago Police Department (via the Chicago Data Portal) is weighted by severity — violence counts for more than shoplifting. For every neighborhood we sum weighted incidents within 1 km of its center, and normalize against citywide crime rates onto a 0–100 index, higher&nbsp;=&nbsp;safer. Boundaries are the City of Chicago's 77 official community areas, the stable units the city itself reports on. Time-of-day charts use Chicago PD incident timestamps, severity-weighted. Locations are published at block level for victim privacy. Pages regenerate as new data is published.`,
    },
  },
  'la': {
    name: 'Los Angeles',
    hubName: 'Los Angeles',
    rankPool: 'LA neighborhoods',
    // Boundaries are the City of LA's 99 Neighborhood Councils, chosen because —
    // unlike the LA Times "Mapping L.A." set — they sit only inside city limits,
    // so no page covers Santa Monica / Beverly Hills / Culver City, each policed
    // by its own department (LAPD data is near-empty there; see the backend
    // enclave exclusions). People search "neighborhood", so the prose says so.
    areaWord: 'neighborhood', areaWordPlural: 'neighborhoods',
    centre: 'center', centreLabel: 'neighborhood center',
    reportedTo: 'reported to the LAPD',
    dataName: 'LAPD data',
    medianLabel: 'citywide median',
    forCity: 'for Los Angeles',
    acrossCity: 'across LA',
    faqCalc: (name) => `SafeRoute weights each incident reported to the LAPD by severity (violence weighs more than shoplifting), sums the last available period within 1 km of the ${name} center, and normalizes against citywide crime rates onto a 0–100 scale — higher is safer. It describes reported crime only; it is not a guarantee of safety.`,
    sources: (dateLine) => `Crime data: LAPD crime incidents via <a href="https://data.lacity.org/">Los Angeles Open Data</a>${dateLine}. Neighborhood boundaries: City of Los Angeles Neighborhood Councils (EmpowerLA), all 99. Basemap © <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors (ODbL). Analysis © SafeRoute.`,
    basemapCredit: 'basemap © OpenStreetMap contributors',
    hub: {
      title: (n) => `Los Angeles Neighborhood Safety Map & Rankings (${n} neighborhoods) — SafeRoute`,
      desc: (n, date) => `How safe is your LA neighborhood? Safety index (0–100) for ${n} Los Angeles neighborhoods from LAPD reported-crime data through ${date} — ranked citywide, with crime maps and night-time patterns.`,
      h1: 'How safe is your Los Angeles neighborhood?',
      lead: `SafeRoute scores every City of LA neighborhood 0–100 from incidents reported to the LAPD — severity-weighted, within 1 km of each area's center, normalized citywide. Higher is safer. The same data powers the SafeRoute app's crime-aware walking routes.`,
      placeholder: 'Check a neighborhood — e.g. Silver Lake, Venice, Highland Park…',
      rankHeading: (n) => `All ${n} LA neighborhoods, safest first`,
      notice: (median) => `These figures describe <strong>reported</strong> crime around each neighborhood's center — they are informational, not a judgment of any community. Note: the LAPD publishes incident locations to the nearest hundred block for privacy, so dots mark blocks, not addresses. Citywide median index: <strong>${median}/100</strong>.`,
      methodology: `Each incident reported to the LAPD (via LA Open Data) is weighted by severity — violence counts for more than shoplifting. For every neighborhood we sum weighted incidents within 1 km of its center, and normalize against citywide crime rates onto a 0–100 index, higher&nbsp;=&nbsp;safer. Boundaries are the City of LA's 99 Neighborhood Councils; neighboring cities with their own police (Santa Monica, Beverly Hills, Culver City and others) are outside LAPD's data and are not scored. Where a council spans large parkland, the map centers on its populated core rather than its geometric middle. Time-of-day charts use LAPD incident timestamps, severity-weighted. Locations are published to the nearest hundred block for privacy. Pages regenerate as new data is published.`,
    },
  },
  'sf': {
    name: 'San Francisco',
    hubName: 'San Francisco',
    rankPool: 'SF neighborhoods',
    // Boundaries are DataSF's 41 "Analysis Neighborhoods" — the same unit SFPD
    // tags every incident with, so the map and the score describe the same area.
    areaWord: 'neighborhood', areaWordPlural: 'neighborhoods',
    centre: 'center', centreLabel: 'neighborhood center',
    // The Presidio scores 99 \u2014 the highest in San Francisco \u2014 on 6 incidents,
    // with its surroundings 26x busier. It is a national park with a small
    // residential population, not a quiet neighbourhood: the centroid is
    // correctly placed, so this is a land-use caveat, not a centroid fix.
    // Three of San Francisco's Analysis Neighborhoods are parks, not places
    // people live, and all three ranked near the top: Presidio 99 (#1), Lincoln
    // Park 84 (#4) and Golden Gate Park 75 (#10). In each case the centroid is
    // CORRECTLY placed — the score is manufactured entirely by the residential
    // fringe. Golden Gate Park has 3 of its 248 incidents within 400 m of the
    // centre; Lincoln Park, which is a golf course, Lands End and the VA campus,
    // has 5 of 145, with zero across its whole northern and western half
    // (ocean and cliff). Nothing to move to; the page has to say what it is.
    // McLaren Park added for consistency: SF's own builder already flags it
    // PARK_LIKE alongside the other three, and it ranks 11/41 at 71/100.
    sparseAreas: new Set(['presidio', 'golden-gate-park', 'lincoln-park', 'mclaren-park']),
    // "national parkland" was true of the Presidio alone. Golden Gate Park is a
    // city park and Lincoln Park is a municipal golf course, so a note shared
    // across the set has to say "parkland" — the Cleveland lesson again.
    sparseNote: 'Most of this area is parkland rather than housing, so a low count reflects how few people live here rather than how safe the streets are.',
    reportedTo: 'reported to the SFPD',
    dataName: 'SFPD data',
    medianLabel: 'citywide median',
    forCity: 'for San Francisco',
    acrossCity: 'across SF',
    faqCalc: (name) => `SafeRoute weights each incident reported to the SFPD by severity (violence weighs more than shoplifting), sums the last available period within 1 km of the ${name} center, and normalizes against citywide crime rates onto a 0–100 scale — higher is safer. It describes reported crime only; it is not a guarantee of safety.`,
    sources: (dateLine) => `Crime data: SFPD incident reports via <a href="https://data.sfgov.org/">DataSF</a>${dateLine}. Neighborhood boundaries: DataSF Analysis Neighborhoods (all 41). Basemap © <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors (ODbL). Analysis © SafeRoute.`,
    basemapCredit: 'basemap © OpenStreetMap contributors',
    hub: {
      title: (n) => `San Francisco Neighborhood Safety Map & Rankings (${n} neighborhoods) — SafeRoute`,
      desc: (n, date) => `How safe is your SF neighborhood? Safety index (0–100) for all ${n} San Francisco neighborhoods from SFPD reported-crime data through ${date} — ranked citywide, with crime maps and night-time patterns.`,
      h1: 'How safe is your San Francisco neighborhood?',
      lead: `SafeRoute scores all 41 San Francisco neighborhoods 0–100 from incidents reported to the SFPD — severity-weighted, within 1 km of each area's center, normalized citywide. Higher is safer. The same data powers the SafeRoute app's crime-aware walking routes.`,
      placeholder: 'Check a neighborhood — e.g. the Mission, Sunset, North Beach…',
      rankHeading: (n) => `All ${n} SF neighborhoods, safest first`,
      notice: (median) => `These figures describe <strong>reported</strong> crime around each neighborhood's center — they are informational, not a judgment of any community. Citywide median index: <strong>${median}/100</strong>.`,
      methodology: `Each incident reported to the SFPD (via DataSF) is weighted by severity — violence counts for more than shoplifting. For every neighborhood we sum weighted incidents within 1 km of its center, and normalize against citywide crime rates onto a 0–100 index, higher&nbsp;=&nbsp;safer. Boundaries are DataSF's 41 Analysis Neighborhoods, the same unit SFPD tags each report with. Because San Francisco's dense downtown far outweighs its residential west side, the index is calibrated to the citywide median so a typical neighborhood reads mid-scale. Time-of-day charts use SFPD incident timestamps, severity-weighted. Pages regenerate as new data is published.`,
    },
  },
  'seattle': {
    name: 'Seattle',
    hubName: 'Seattle',
    rankPool: 'Seattle neighborhoods',
    // Multi-district city (like NYC/London): 94 Neighborhood Map Atlas
    // neighborhoods grouped under 20 districts, so the hub ranks within each
    // district. No rankHeading → default borough-grouped tables.
    areaWord: 'neighborhood', areaWordPlural: 'neighborhoods',
    centre: 'center', centreLabel: 'neighborhood center',
    // Land that is not housing tops a per-AREA index, because the score counts
    // incidents per square kilometre and not per person. Named explicitly, never
    // by a low-count threshold — a threshold sweeps in genuinely safe, affluent
    // neighborhoods and tells readers nobody lives there. Not dropped either:
    // these are real places people visit, and a page that explains the number
    // beats a page that is silently missing.
    sparseAreas: new Set(['harbor-island', 'industrial-district']),
    sparseNote: 'Almost all of this area is industrial port land rather than homes, so a low count reflects how few people are here rather than how safe the streets are.',
    reportedTo: 'reported to the SPD',
    dataName: 'SPD data',
    medianLabel: 'citywide median',
    forCity: 'for Seattle',
    acrossCity: 'across Seattle',
    faqCalc: (name) => `SafeRoute weights each incident reported to the Seattle Police Department by severity (violence weighs more than shoplifting), sums the last available period within 1 km of the ${name} center, and normalizes against citywide crime rates onto a 0–100 scale — higher is safer. It describes reported crime only; it is not a guarantee of safety.`,
    sources: (dateLine) => `Crime data: SPD Crime Data (2008–present) via <a href="https://data.seattle.gov/">Seattle Open Data</a>${dateLine}. Neighborhood boundaries: Seattle City GIS Neighborhood Map Atlas (94 neighborhoods, 20 districts). Basemap © <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors (ODbL). Analysis © SafeRoute.`,
    basemapCredit: 'basemap © OpenStreetMap contributors',
    hub: {
      title: (n) => `Seattle Neighborhood Safety Map & Rankings (${n} neighborhoods) — SafeRoute`,
      desc: (n, date) => `How safe is your Seattle neighborhood? Safety index (0–100) for ${n} Seattle neighborhoods from SPD reported-crime data through ${date} — ranked by district, with crime maps and night-time patterns.`,
      h1: 'How safe is your Seattle neighborhood?',
      lead: `SafeRoute scores every Seattle neighborhood 0–100 from incidents reported to the Seattle Police Department — severity-weighted, within 1 km of each area's center, normalized citywide. Higher is safer. The same data powers the SafeRoute app's crime-aware walking routes.`,
      placeholder: 'Check a neighborhood — e.g. Ballard, Fremont, Belltown…',
      notice: (median) => `These figures describe <strong>reported</strong> crime around each neighborhood's center — they are informational, not a judgment of any community. Citywide median index: <strong>${median}/100</strong>.`,
      methodology: `Each incident reported to the Seattle Police Department (via Seattle Open Data) is weighted by severity — violence counts for more than shoplifting. For every neighborhood we sum weighted incidents within 1 km of its center, and normalize against citywide crime rates onto a 0–100 index, higher&nbsp;=&nbsp;safer. Boundaries are the Seattle City GIS Neighborhood Map Atlas — 94 neighborhoods grouped into 20 districts (so Capitol Hill and West Seattle, which are districts, appear as section headings). Because Seattle's dense downtown far outweighs its residential neighborhoods, the index is calibrated to the citywide median so a typical neighborhood reads mid-scale. Time-of-day charts use SPD incident timestamps, severity-weighted. Pages regenerate as new data is published.`,
    },
  },
  'detroit': {
    name: 'Detroit',
    hubName: 'Detroit',
    rankPool: 'Detroit neighborhoods',
    // Multi-district city: the City of Detroit's own 205 official neighborhoods
    // (the set behind theneighborhoods.org), grouped under the 7 City Council
    // districts that ship in the same layer — the city's own second tier, not
    // one we invented. 201 are scored; four are dropped as places nobody lives
    // (Belle Isle and the three named industrial belts), because there a
    // near-zero score describes empty land while reading as a finding of safety.
    // The drop is a LAND-USE test, never a low-count one: dropping on counts
    // would delete quiet residential neighborhoods, which is the same bias that
    // keeps ShotSpotter and officer-initiated calls out of the app.
    //
    // Detroit's neighborhoods are small and adjacent — median centre spacing
    // 868 m, and 22% of centres sit within 700 m of a neighbour — so 1 km
    // circles overlap and adjacent areas read similarly. Disclosed in the
    // methodology, the same as Boston.
    areaWord: 'neighborhood', areaWordPlural: 'neighborhoods',
    centre: 'center', centreLabel: 'neighborhood center',
    // Detroit is a shrinking city: Delray, Poletown East and Oakwood Heights
    // were largely cleared for a refinery, a plant and a bridge, so they carry
    // almost no incidents and float to the top of a per-area index. Their pages
    // would otherwise read "low risk" about places nobody lives. They are NOT
    // dropped — they are real named neighborhoods with residents, and erasing
    // them is the worse error — so the thin ones that a ranking flatters say
    // what a low count can actually mean.
    // Named because each is a documented clearance, not because it scored low:
    // Delray (Gordie Howe bridge approach and the refinery belt), Poletown East
    // (razed for the GM assembly plant), Oakwood Heights (bought out by
    // Marathon), Carbon Works (industrial). Their scores are real; what they
    // measure is emptiness.
    sparseAreas: new Set(['delray', 'poletown-east', 'oakwood-heights', 'carbon-works',
                          'rouge-park', 'detroit-golf']),
    // Widened for Rouge Park (1,181 acres of city park, ranked 9/201) and
    // Detroit Golf (a private course, 79/100) — neither was "cleared", both are
    // simply not housing. A large park at night is exactly the question this app
    // exists to answer, and 0 of Rouge Park's incidents fall within 400 m of its
    // centre, so the page was answering it wrong.
    sparseNote: 'Much of this area is parkland, or was cleared for industry or infrastructure, so the low count reflects how few people are here as much as how safe the street is.',
    reportedTo: 'reported to the DPD',
    dataName: 'DPD data',
    medianLabel: 'citywide median',
    forCity: 'for Detroit',
    acrossCity: 'across Detroit',
    faqCalc: (name) => `SafeRoute weights each incident reported to the Detroit Police Department by severity (violence weighs more than shoplifting), sums the last available period within 1 km of the ${name} center, and normalizes against citywide crime rates onto a 0\u2013100 scale \u2014 higher is safer. It describes reported crime only; it is not a guarantee of safety.`,
    sources: (dateLine) => `Crime data: Detroit Police Department RMS crime incidents via <a href="https://data.detroitmi.gov/">City of Detroit Open Data</a>${dateLine}. Neighborhood boundaries: City of Detroit official neighborhoods (205), grouped by City Council district. Basemap \u00a9 <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors (ODbL). Analysis \u00a9 SafeRoute.`,
    basemapCredit: 'basemap \u00a9 OpenStreetMap contributors',
    hub: {
      title: (n) => `Detroit Neighborhood Safety Map & Rankings (${n} neighborhoods) \u2014 SafeRoute`,
      desc: (n, date) => `How safe is your Detroit neighborhood? Safety index (0\u2013100) for ${n} Detroit neighborhoods from DPD reported-crime data through ${date} \u2014 ranked by council district, with crime maps and night-time patterns.`,
      h1: 'How safe is your Detroit neighborhood?',
      lead: `SafeRoute scores every Detroit neighborhood 0\u2013100 from incidents reported to the Detroit Police Department \u2014 severity-weighted, within 1 km of each neighborhood's center, normalized citywide. Higher is safer. The same data powers the SafeRoute app's crime-aware walking routes.`,
      placeholder: 'Check a neighborhood \u2014 e.g. Corktown, Indian Village, Brightmoor\u2026',
      notice: (median) => `These figures describe <strong>reported</strong> crime around each neighborhood's center \u2014 they are informational, not a judgment of any community. Citywide median index: <strong>${median}/100</strong>.`,
      methodology: `Each incident reported to the Detroit Police Department (RMS crime incidents, via City of Detroit Open Data) is weighted by severity \u2014 violence counts for more than shoplifting. For every neighborhood we sum weighted incidents within 1 km of its center, and normalize against citywide rates onto a 0\u2013100 index, higher&nbsp;=&nbsp;safer. Boundaries are the city's own 205 official neighborhoods, grouped by the 7 City Council districts published in the same layer. Four are not scored because nobody lives in them \u2014 Belle Isle, the state park island in the river, and the Conner Creek, Russell and West Side industrial belts \u2014 where near-zero reported crime would read as falsely "safe" rather than as empty land. Detroit's neighborhoods are small and closely spaced, so the 1&nbsp;km circles around adjacent centers overlap and neighbouring areas will show similar figures. Time-of-day charts use DPD incident timestamps, severity-weighted. Pages regenerate as new data is published.`,
    },
  },
  'minneapolis': {
    name: 'Minneapolis',
    hubName: 'Minneapolis',
    rankPool: 'Minneapolis neighborhoods',
    // Multi-district city, and both tiers are the city's own: 87 official
    // neighborhoods (Minneapolis_Neighborhoods) grouped under the official 11
    // communities (Minneapolis_Communities). The layers ship separately with no
    // shared key, so the community is assigned by point-in-polygon of each
    // neighborhood's centroid.
    areaWord: 'neighborhood', areaWordPlural: 'neighborhoods',
    centre: 'center', centreLabel: 'neighborhood center',
    reportedTo: 'reported to the MPD',
    dataName: 'MPD data',
    medianLabel: 'citywide median',
    forCity: 'for Minneapolis',
    acrossCity: 'across Minneapolis',
    faqCalc: (name) => `SafeRoute weights each incident reported to the Minneapolis Police Department by severity (violence weighs more than shoplifting), sums the last available period within 1 km of the ${name} center, and normalizes against citywide crime rates onto a 0\u2013100 scale \u2014 higher is safer. It describes reported crime only; it is not a guarantee of safety.`,
    sources: (dateLine) => `Crime data: Minneapolis Police Department incidents via <a href="https://opendata.minneapolismn.gov/">Minneapolis Open Data</a>${dateLine}. Neighborhood boundaries: City of Minneapolis official neighborhoods (87), grouped by the city's 11 communities. Basemap \u00a9 <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors (ODbL). Analysis \u00a9 SafeRoute.`,
    basemapCredit: 'basemap \u00a9 OpenStreetMap contributors',
    hub: {
      title: (n) => `Minneapolis Neighborhood Safety Map & Rankings (${n} neighborhoods) \u2014 SafeRoute`,
      desc: (n, date) => `How safe is your Minneapolis neighborhood? Safety index (0\u2013100) for ${n} Minneapolis neighborhoods from MPD reported-crime data through ${date} \u2014 ranked by community, with crime maps and night-time patterns.`,
      h1: 'How safe is your Minneapolis neighborhood?',
      lead: `SafeRoute scores every Minneapolis neighborhood 0\u2013100 from incidents reported to the Minneapolis Police Department \u2014 severity-weighted, within 1 km of each neighborhood's center, normalized citywide. Higher is safer. The same data powers the SafeRoute app's crime-aware walking routes.`,
      placeholder: 'Check a neighborhood \u2014 e.g. Uptown, Linden Hills, Powderhorn Park\u2026',
      notice: (median) => `These figures describe <strong>reported</strong> crime around each neighborhood's center \u2014 they are informational, not a judgment of any community. Citywide median index: <strong>${median}/100</strong>.`,
      methodology: `Each incident reported to the Minneapolis Police Department (via Minneapolis Open Data) is weighted by severity \u2014 violence counts for more than shoplifting. For every neighborhood we sum weighted incidents within 1 km of its center, and normalize against citywide rates onto a 0\u2013100 index, higher&nbsp;=&nbsp;safer. Boundaries are the city's own 87 neighborhoods, grouped by its own 11 communities. Minneapolis wraps its neighborhoods around real lakes, so a centre that would otherwise land on open water is moved to the built-up part of the same neighborhood \u2014 never onto a neighbouring one. Time-of-day charts use MPD incident timestamps, severity-weighted. Pages regenerate as new data is published.`,
    },
  },
  'cleveland': {
    name: 'Cleveland',
    hubName: 'Cleveland',
    rankPool: 'Cleveland neighborhoods',
    // The city's own 34 Statistical Planning Areas, from the SAME ArcGIS org
    // that publishes the CPD crime feed — boundaries and incidents share a
    // publisher. Single ranked table: the layer's `DIST` is a planning-district
    // id rather than a geography Clevelanders use, so grouping on it would
    // invent one. Spacing is the roomiest of any city here (median 1,790 m),
    // so the 1 km circles barely touch.
    areaWord: 'neighborhood', areaWordPlural: 'neighborhoods',
    centre: 'center', centreLabel: 'neighborhood center',
    // Cleveland's two top-ranked areas are an airport and an industrial river
    // valley. NOTE the numeric audit did NOT catch them: the "<25% of the city
    // median" screen sits at 193 incidents here, and Hopkins (219) and Cuyahoga
    // Valley (317) clear it — an airport and a mill district generate enough
    // theft to look populated while housing almost nobody. The screen is a net,
    // not an oracle; the names still have to be read.
    sparseAreas: new Set(['hopkins', 'cuyahoga-valley']),
    sparseNote: 'Most of this area is airport or industrial land rather than housing, so the count reflects how few people live here rather than how safe the streets are.',
    reportedTo: 'reported to the Cleveland Division of Police',
    dataName: 'Cleveland Division of Police data',
    medianLabel: 'citywide median',
    forCity: 'for Cleveland',
    acrossCity: 'across Cleveland',
    faqCalc: (name) => `SafeRoute weights each incident reported to the Cleveland Division of Police by severity (violence weighs more than shoplifting), sums the last available period within 1 km of the ${name} center, and normalizes against citywide crime rates onto a 0\u2013100 scale \u2014 higher is safer. It describes reported crime only; it is not a guarantee of safety.`,
    sources: (dateLine) => `Crime data: Cleveland Division of Police crime incidents via the <a href="https://data.clevelandohio.gov/">City of Cleveland</a> open data${dateLine}. Neighborhood boundaries: City of Cleveland Statistical Planning Areas (34). Basemap \u00a9 <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors (ODbL). Analysis \u00a9 SafeRoute.`,
    basemapCredit: 'basemap \u00a9 OpenStreetMap contributors',
    hub: {
      title: (n) => `Cleveland Neighborhood Safety Map & Rankings (${n} neighborhoods) \u2014 SafeRoute`,
      desc: (n, date) => `How safe is your Cleveland neighborhood? Safety index (0\u2013100) for ${n} Cleveland neighborhoods from Cleveland Division of Police data through ${date} \u2014 ranked citywide, with crime maps and night-time patterns.`,
      h1: 'How safe is your Cleveland neighborhood?',
      lead: `SafeRoute scores every Cleveland neighborhood 0\u2013100 from incidents reported to the Cleveland Division of Police \u2014 severity-weighted, within 1 km of each neighborhood's center, normalized citywide. Higher is safer. The same data powers the SafeRoute app's crime-aware walking routes.`,
      placeholder: 'Check a neighborhood \u2014 e.g. Tremont, Ohio City, Glenville\u2026',
      rankHeading: (n) => `All ${n} Cleveland neighborhoods, safest first`,
      notice: (median) => `These figures describe <strong>reported</strong> crime around each neighborhood's center \u2014 they are informational, not a judgment of any community. Citywide median index: <strong>${median}/100</strong>.`,
      methodology: `Each incident reported to the Cleveland Division of Police is weighted by severity \u2014 violence counts for more than shoplifting. For every neighborhood we sum weighted incidents within 1 km of its center, and normalize against citywide rates onto a 0\u2013100 index, higher&nbsp;=&nbsp;safer. Boundaries are the city's own 34 Statistical Planning Areas, published by the same office as the crime data. Cleveland's neighborhoods sit further apart than any other city here, so the 1&nbsp;km circles barely overlap and each figure describes its own area. Time-of-day charts use incident timestamps, severity-weighted. Pages regenerate as new data is published.`,
    },
  },
  'kansascity': {
    name: 'Kansas City',
    hubName: 'Kansas City',
    rankPool: 'Kansas City neighborhoods',
    // The city's own 246 neighborhood boundaries, grouped by the city's own 18
    // Area Plans — both from the same KCMO ArcGIS org, so the second tier is
    // real planning geography rather than one invented here. Two areas are
    // dropped in the gazetteer: KCI & 2nd Creek (135 km2 of airport) and
    // Longview (30 km2 wrapped around Longview Lake, with 0-1 incidents at every
    // interior point probed — the Lake Catherine case). 244 published across 16
    // districts; spacing median 1,009 m.
    //
    // KC's normaliser was RECALIBRATED (597 -> 212 per-30d) when these pages
    // first produced real per-neighborhood medians: the old grid sample put the
    // median at 77.5 with 149 of 244 reading "low risk". It is now 55.0.
    areaWord: 'neighborhood', areaWordPlural: 'neighborhoods',
    centre: 'center', centreLabel: 'neighborhood center',
    // Flagged by the neighbour-ratio audit (West Bottoms 0.05, Northeast
    // Industrial 0.11) and by name-screening the top of the ranking, which the
    // ratio misses when an area's NEIGHBOURS are also empty — the river bottoms
    // and the undeveloped Northland tracts all sat in the top ten "safest".
    // Swope Park added 2026-09 by the all-cities audit: 1,800 acres of park,
    // zoo and golf reading 88/100 at rank 14/244, with all four ring probes
    // confirming the whole circle is empty. The existing note fits verbatim.
    sparseAreas: new Set(['west-bottoms', 'northeast-industrial-district',
                          'birmingham-bottoms', 'little-blue', 'shoal-creek',
                          'swope-park']),
    sparseNote: 'Much of this area is industrial, river-bottom or undeveloped land rather than housing, so a low count reflects how few people are here rather than how safe the streets are.',
    reportedTo: 'reported to the KCPD',
    dataName: 'Kansas City Police data',
    medianLabel: 'citywide median',
    forCity: 'for Kansas City',
    acrossCity: 'across Kansas City',
    faqCalc: (name) => `SafeRoute weights each incident reported to the Kansas City Police Department by severity (violence weighs more than shoplifting), sums the last available period within 1 km of the ${name} center, and normalizes against citywide crime rates onto a 0\u2013100 scale \u2014 higher is safer. It describes reported crime only; it is not a guarantee of safety.`,
    sources: (dateLine) => `Crime data: Kansas City Police Department crime incidents via <a href="https://data.kcmo.org/">Open Data KC</a>${dateLine}. Neighborhood boundaries: City of Kansas City, Missouri (246 neighborhoods), grouped by the city's 18 Area Plans. Basemap \u00a9 <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors (ODbL). Analysis \u00a9 SafeRoute.`,
    basemapCredit: 'basemap \u00a9 OpenStreetMap contributors',
    hub: {
      title: (n) => `Kansas City Neighborhood Safety Map & Rankings (${n} neighborhoods) \u2014 SafeRoute`,
      desc: (n, date) => `How safe is your Kansas City neighborhood? Safety index (0\u2013100) for ${n} KC neighborhoods from Kansas City Police data through ${date} \u2014 ranked by Area Plan district, with crime maps and night-time patterns.`,
      h1: 'How safe is your Kansas City neighborhood?',
      lead: `SafeRoute scores every Kansas City neighborhood 0\u2013100 from incidents reported to the KCPD \u2014 severity-weighted, within 1 km of each neighborhood's center, normalized citywide. Higher is safer. The same data powers the SafeRoute app's crime-aware walking routes.`,
      placeholder: 'Check a neighborhood \u2014 e.g. River Market, Crossroads, Waldo\u2026',
      notice: (median) => `These figures describe <strong>reported</strong> crime around each neighborhood's center \u2014 they are informational, not a judgment of any community. Citywide median index: <strong>${median}/100</strong>.`,
      methodology: `Each incident reported to the Kansas City Police Department is weighted by severity \u2014 violence counts for more than shoplifting. For every neighborhood we sum weighted incidents within 1 km of its center, and normalize against citywide rates onto a 0\u2013100 index, higher&nbsp;=&nbsp;safer. Boundaries are the city's own 246 neighborhoods, grouped by the 18 Area Plans the city itself plans against. Two are not scored: KCI &amp; 2nd Creek, which is the airport, and Longview, which wraps Longview Lake and carries almost no recorded incidents anywhere inside it \u2014 a page there could only have said &ldquo;0 incidents, 100/100&rdquo;, which is missing data dressed as proven safety. Kansas City covers a lot of ground, and several neighborhoods along the Missouri and Blue river bottoms are industrial or largely undeveloped; those pages say so rather than letting an empty count read as a quiet street. Time-of-day charts use KCPD incident timestamps, severity-weighted. Pages regenerate as new data is published.`,
    },
  },
  'birmingham': {
    name: 'Birmingham',
    hubName: 'Birmingham',
    rankPool: 'Birmingham wards',
    // The city council's own 69 ONS wards — the same national ward layer London
    // uses, filtered to Birmingham City Council (not the wider West Midlands).
    // Single ranked table: Birmingham has no official sub-city grouping that
    // people actually use, so inventing one would be the New Orleans call.
    //
    // THREE CENTROIDS WERE MOVED OUT OF PARKLAND. The ONS LAT/LONG attributes
    // are GEOMETRIC centroids, not population-weighted as first assumed, so a
    // ward containing a big park scores an empty circle: Sutton Vesey's landed
    // in Sutton Park (3 incidents, 98/100), Walmley & Minworth's in the Minworth
    // green belt, Edgbaston's in the university and botanical-gardens belt (33
    // against 429 at the Calthorpe Estate). All three are now asserted inside
    // their own ward. London was audited for the same defect and is clean — its
    // wards are small and uniformly built up.
    areaWord: 'ward', areaWordPlural: 'wards',
    centre: 'centre', centreLabel: 'ward centre',
    reportedTo: 'reported to West Midlands Police',
    dataName: 'West Midlands Police data',
    medianLabel: 'Birmingham median',
    forCity: 'for Birmingham',
    acrossCity: 'across Birmingham',
    faqCalc: (name) => `SafeRoute weights each police-recorded incident by severity (violence weighs more than shoplifting), sums the last published month within 1 km of the ${name} centre, and normalises against Birmingham rates onto a 0\u2013100 scale \u2014 higher is safer. It describes reported crime only; it is not a guarantee of safety.`,
    sources: (dateLine) => `Crime data: West Midlands Police street-level crime via <a href="https://data.police.uk/">data.police.uk</a>${dateLine}, Open Government Licence v3.0. Ward boundaries: ONS Wards (December 2025) Boundaries UK, Office for National Statistics, OGL v3.0. Basemap \u00a9 <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors (ODbL). Analysis \u00a9 SafeRoute.`,
    basemapCredit: 'basemap \u00a9 OpenStreetMap contributors',
    hub: {
      title: (n) => `Birmingham Ward Safety Map & Rankings (${n} wards) \u2014 SafeRoute`,
      desc: (n, date) => `How safe is your Birmingham ward? Safety index (0\u2013100) for all ${n} Birmingham wards from West Midlands Police data through ${date} \u2014 ranked citywide, with crime maps and night-time patterns.`,
      h1: 'How safe is your Birmingham ward?',
      lead: `SafeRoute scores every Birmingham ward 0\u2013100 from street-level incidents reported to West Midlands Police \u2014 severity-weighted, within 1 km of each ward's centre, normalised against Birmingham. Higher is safer. The same data powers the SafeRoute app's crime-aware walking routes.`,
      placeholder: 'Check a ward \u2014 e.g. Ladywood, Handsworth, Moseley\u2026',
      rankHeading: (n) => `All ${n} Birmingham wards, safest first`,
      notice: (median) => `These figures describe <strong>reported</strong> crime around each ward's centre \u2014 they are informational, not a judgment of any community. Birmingham median index: <strong>${median}/100</strong>.`,
      methodology: `Each street-level incident published by West Midlands Police is weighted by severity \u2014 violence counts for more than shoplifting. For every ward we sum weighted incidents within 1 km of its centre, and normalise against Birmingham's own rates onto a 0\u2013100 index, higher&nbsp;=&nbsp;safer. Boundaries are the 69 Birmingham City Council wards from the ONS ward set. <strong>The scale is calibrated to Birmingham and cannot be read against another city's number</strong> \u2014 a Birmingham 55 and a London 55 both mean &ldquo;typical for this city&rdquo;, not the same amount of crime. data.police.uk publishes one calendar month at a time, so these pages describe a single month rather than a year, and a typical Birmingham ward carries fewer incidents than a typical inner-London one \u2014 which means figures here move more from month to month, and small differences between neighbouring wards are not meaningful. Three ward centres (Sutton Vesey, Sutton Walmley &amp; Minworth, Edgbaston) sit in large parks or green belt and have been moved to the built-up part of the same ward, because a circle drawn over parkland reads as safe when it is really empty. Time-of-day charts use the category mix, as data.police.uk does not publish incident times. Pages regenerate as new data is published.`,
    },
  },
  'liverpool': {
    name: 'Liverpool',
    hubName: 'Liverpool',
    rankPool: 'Liverpool wards',
    // Liverpool City Council's 64 ONS wards. Single ranked table — Liverpool has
    // no official sub-city grouping locals use, so inventing one would be the
    // New Orleans call rather than the Detroit one.
    //
    // Merseyside got its own area normaliser (backend f5e47ff, 1520) because
    // against the UK-wide constant Liverpool's median ward scored 81, with 39 of
    // 64 reading "low" and none "high".
    areaWord: 'ward', areaWordPlural: 'wards',
    centre: 'centre', centreLabel: 'ward centre',
    // Croxteth Country Park is a country park; Waterfront North is the north
    // dock estate. Both are named for what they are and both carry almost no
    // residents, so a quiet circle there is emptiness, not safety. Speke is
    // deliberately NOT caveated — it contains the airport and a commerce park
    // but is also a real residential estate of some 15,000 people, and telling
    // them their neighbourhood is empty would be its own error.
    sparseAreas: new Set(['croxteth-country-park', 'waterfront-north']),
    sparseNote: 'Most of this ward is parkland or dock estate rather than housing, so a low count reflects how few people are here rather than how safe the streets are.',
    reportedTo: 'reported to Merseyside Police',
    dataName: 'Merseyside Police data',
    medianLabel: 'Liverpool median',
    forCity: 'for Liverpool',
    acrossCity: 'across Liverpool',
    faqCalc: (name) => `SafeRoute weights each police-recorded incident by severity (violence weighs more than shoplifting), sums the last published month within 1 km of the ${name} centre, and normalises against Liverpool rates onto a 0\u2013100 scale \u2014 higher is safer. It describes reported crime only; it is not a guarantee of safety.`,
    sources: (dateLine) => `Crime data: Merseyside Police street-level crime via <a href="https://data.police.uk/">data.police.uk</a>${dateLine}, Open Government Licence v3.0. Ward boundaries: ONS Wards (December 2025) Boundaries UK, Office for National Statistics, OGL v3.0. Basemap \u00a9 <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors (ODbL). Analysis \u00a9 SafeRoute.`,
    basemapCredit: 'basemap \u00a9 OpenStreetMap contributors',
    hub: {
      title: (n) => `Liverpool Ward Safety Map & Rankings (${n} wards) \u2014 SafeRoute`,
      desc: (n, date) => `How safe is your Liverpool ward? Safety index (0\u2013100) for all ${n} Liverpool wards from Merseyside Police data through ${date} \u2014 ranked citywide, with crime maps and night-time patterns.`,
      h1: 'How safe is your Liverpool ward?',
      lead: `SafeRoute scores every Liverpool ward 0\u2013100 from street-level incidents reported to Merseyside Police \u2014 severity-weighted, within 1 km of each ward's centre, normalised against Liverpool. Higher is safer. The same data powers the SafeRoute app's crime-aware walking routes.`,
      placeholder: 'Check a ward \u2014 e.g. Anfield, Toxteth, Woolton\u2026',
      rankHeading: (n) => `All ${n} Liverpool wards, safest first`,
      notice: (median) => `These figures describe <strong>reported</strong> crime around each ward's centre \u2014 they are informational, not a judgment of any community. Liverpool median index: <strong>${median}/100</strong>.`,
      methodology: `Each street-level incident published by Merseyside Police is weighted by severity \u2014 violence counts for more than shoplifting. For every ward we sum weighted incidents within 1 km of its centre, and normalise against Liverpool's own rates onto a 0\u2013100 index, higher&nbsp;=&nbsp;safer. Boundaries are the 64 Liverpool City Council wards from the ONS ward set. <strong>The scale is calibrated to Liverpool and cannot be read against another city's number</strong> \u2014 a Liverpool 55 and a London 55 both mean &ldquo;typical for this city&rdquo;, not the same amount of crime. data.police.uk publishes one calendar month at a time, so these pages describe a single month rather than a year, and a typical Liverpool ward carries fewer incidents than a typical inner-London one \u2014 so figures here move more from month to month, and small differences between neighbouring wards are not meaningful. Liverpool sits on the Mersey and several waterfront wards have a 1&nbsp;km circle that is partly river or dock water; where a ward is mostly parkland or dock rather than housing its page says so, because an empty circle reads as a quiet street when it is really no street at all. Time-of-day charts use the category mix, as data.police.uk does not publish incident times. Pages regenerate as new data is published.`,
    },
  },
  'bristol': {
    name: 'Bristol',
    hubName: 'Bristol',
    rankPool: 'Bristol wards',
    areaWord: 'ward', areaWordPlural: 'wards',
    centre: 'centre', centreLabel: 'ward centre',
    // Avonmouth and Lawrence Weston's centroid landed in the container port —
    // 6 incidents, 99/100, top of the city. Moved to the Lawrence Weston
    // housing estate the ward's other half is named for (94 incidents).
    reportedTo: 'reported to Avon and Somerset Police',
    dataName: 'Avon and Somerset Police data',
    medianLabel: 'Bristol median',
    forCity: 'for Bristol',
    acrossCity: 'across Bristol',
    faqCalc: (name) => `SafeRoute weights each police-recorded incident by severity (violence weighs more than shoplifting), sums the last published month within 1 km of the ${name} centre, and normalises against Bristol rates onto a 0\u2013100 scale \u2014 higher is safer. It describes reported crime only; it is not a guarantee of safety.`,
    sources: (dateLine) => `Crime data: Avon and Somerset Police street-level crime via <a href="https://data.police.uk/">data.police.uk</a>${dateLine}, Open Government Licence v3.0. Ward boundaries: ONS Wards (December 2025) Boundaries UK, Office for National Statistics, OGL v3.0. Basemap \u00a9 <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors (ODbL). Analysis \u00a9 SafeRoute.`,
    basemapCredit: 'basemap \u00a9 OpenStreetMap contributors',
    hub: {
      title: (n) => `Bristol Ward Safety Map & Rankings (${n} wards) \u2014 SafeRoute`,
      desc: (n, date) => `How safe is your Bristol ward? Safety index (0\u2013100) for all ${n} Bristol wards from Avon and Somerset Police data through ${date} \u2014 ranked citywide, with crime maps and night-time patterns.`,
      h1: 'How safe is your Bristol ward?',
      lead: `SafeRoute scores every Bristol ward 0\u2013100 from street-level incidents reported to Avon and Somerset Police \u2014 severity-weighted, within 1 km of each ward's centre, normalised against Bristol. Higher is safer. The same data powers the SafeRoute app's crime-aware walking routes.`,
      placeholder: 'Check a ward \u2014 e.g. Clifton, Bedminster, Easton\u2026',
      rankHeading: (n) => `All ${n} Bristol wards, safest first`,
      notice: (median) => `These figures describe <strong>reported</strong> crime around each ward's centre \u2014 they are informational, not a judgment of any community. Bristol median index: <strong>${median}/100</strong>.`,
      methodology: `Each street-level incident published by Avon and Somerset Police is weighted by severity \u2014 violence counts for more than shoplifting. For every ward we sum weighted incidents within 1 km of its centre, and normalise against Bristol's own rates onto a 0\u2013100 index, higher&nbsp;=&nbsp;safer. Boundaries are the Bristol council wards from the ONS ward set. <strong>The scale is calibrated to Bristol and cannot be read against another city's number</strong> \u2014 a Bristol 55 and a London 55 both mean &ldquo;typical for this city&rdquo;, not the same amount of crime. data.police.uk publishes one calendar month at a time, so these pages describe a single month rather than a year. A typical Bristol ward carries fewer incidents than a typical inner-London one, so figures here move more from month to month and small differences between neighbouring wards are not meaningful. Bristol runs down to the Severn and one ward centre sat in the container port rather than the housing the ward is half named for; it has been moved to the built-up part of the same ward, because a circle drawn over a dock reads as safe when it is really empty. Time-of-day charts use the category mix, as data.police.uk does not publish incident times. Pages regenerate as new data is published.`,
    },
  },
  'cardiff': {
    name: 'Cardiff',
    hubName: 'Cardiff',
    rankPool: 'Cardiff wards',
    areaWord: 'ward', areaWordPlural: 'wards',
    centre: 'centre', centreLabel: 'ward centre',
    // Pentyrch and St Fagans is 28.8 km2 — a fifth of the whole council area —
    // and overwhelmingly farmland and village rather than town. 8 incidents put
    // it top of the city, which says nothing about walking anywhere in Cardiff.
    sparseAreas: new Set(['pentyrch-and-st-fagans']),
    sparseNote: 'Most of this ward is farmland and village rather than town, so a low count reflects how few people are here rather than how safe the streets are.',
    reportedTo: 'reported to South Wales Police',
    dataName: 'South Wales Police data',
    medianLabel: 'Cardiff median',
    forCity: 'for Cardiff',
    acrossCity: 'across Cardiff',
    faqCalc: (name) => `SafeRoute weights each police-recorded incident by severity (violence weighs more than shoplifting), sums the last published month within 1 km of the ${name} centre, and normalises against Cardiff rates onto a 0\u2013100 scale \u2014 higher is safer. It describes reported crime only; it is not a guarantee of safety.`,
    sources: (dateLine) => `Crime data: South Wales Police street-level crime via <a href="https://data.police.uk/">data.police.uk</a>${dateLine}, Open Government Licence v3.0. Ward boundaries: ONS Wards (December 2025) Boundaries UK, Office for National Statistics, OGL v3.0. Basemap \u00a9 <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors (ODbL). Analysis \u00a9 SafeRoute.`,
    basemapCredit: 'basemap \u00a9 OpenStreetMap contributors',
    hub: {
      title: (n) => `Cardiff Ward Safety Map & Rankings (${n} wards) \u2014 SafeRoute`,
      desc: (n, date) => `How safe is your Cardiff ward? Safety index (0\u2013100) for all ${n} Cardiff wards from South Wales Police data through ${date} \u2014 ranked citywide, with crime maps and night-time patterns.`,
      h1: 'How safe is your Cardiff ward?',
      lead: `SafeRoute scores every Cardiff ward 0\u2013100 from street-level incidents reported to South Wales Police \u2014 severity-weighted, within 1 km of each ward's centre, normalised against Cardiff. Higher is safer. The same data powers the SafeRoute app's crime-aware walking routes.`,
      placeholder: 'Check a ward \u2014 e.g. Roath, Canton, Grangetown\u2026',
      rankHeading: (n) => `All ${n} Cardiff wards, safest first`,
      notice: (median) => `These figures describe <strong>reported</strong> crime around each ward's centre \u2014 they are informational, not a judgment of any community. Cardiff median index: <strong>${median}/100</strong>.`,
      methodology: `Each street-level incident published by South Wales Police is weighted by severity \u2014 violence counts for more than shoplifting. For every ward we sum weighted incidents within 1 km of its centre, and normalise against Cardiff's own rates onto a 0\u2013100 index, higher&nbsp;=&nbsp;safer. Boundaries are the Cardiff council wards from the ONS ward set. <strong>The scale is calibrated to Cardiff and cannot be read against another city's number</strong> \u2014 a Cardiff 55 and a London 55 both mean &ldquo;typical for this city&rdquo;, not the same amount of crime. data.police.uk publishes one calendar month at a time, so these pages describe a single month rather than a year. <strong>Cardiff is the thinnest city published here</strong> \u2014 a typical ward sees about 126 incidents a month against inner London's 476 \u2014 so these figures move more from month to month than any other city's, and a small difference between two neighbouring wards is not meaningful. Where a ward is mostly farmland rather than town its page says so, because an empty circle reads as a quiet street when it is really no street at all. Time-of-day charts use the category mix, as data.police.uk does not publish incident times. Pages regenerate as new data is published.`,
    },
  },
  'toronto': {
    name: 'Toronto',
    hubName: 'Toronto',
    rankPool: 'Toronto neighbourhoods',
    // First Canadian SEO city. Boundaries are the City of Toronto's 158 official
    // neighbourhoods, grouped under the six former municipalities (Old Toronto,
    // North York, Scarborough, Etobicoke, East York, York) — a multi-district
    // hub like NYC/London/Seattle. No rankHeading → district-grouped tables.
    // Canadian spelling: neighbourhood/centre, but -ize endings (normalize).
    areaWord: 'neighbourhood', areaWordPlural: 'neighbourhoods',
    centre: 'centre', centreLabel: 'neighbourhood centre',
    reportedTo: 'reported to the Toronto Police Service',
    dataName: 'Toronto Police data',
    medianLabel: 'citywide median',
    forCity: 'for Toronto',
    acrossCity: 'across Toronto',
    faqCalc: (name) => `SafeRoute weights each incident reported to the Toronto Police Service by severity (violence weighs more than shoplifting), sums the last available period within 1 km of the ${name} centre, and normalizes against citywide crime rates onto a 0–100 scale — higher is safer. It describes reported crime only; it is not a guarantee of safety.`,
    sources: (dateLine) => `Crime data: Toronto Police Service Major Crime Indicators via the <a href="https://data.torontopolice.on.ca/">TPS Public Safety Data Portal</a>${dateLine}. Neighbourhood and former-municipality boundaries: <a href="https://open.toronto.ca/">City of Toronto Open Data</a> (158 neighbourhoods). Basemap © <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors (ODbL). Analysis © SafeRoute.`,
    basemapCredit: 'basemap © OpenStreetMap contributors',
    hub: {
      title: (n) => `Toronto Neighbourhood Safety Map & Rankings (${n} neighbourhoods) — SafeRoute`,
      desc: (n, date) => `How safe is your Toronto neighbourhood? Safety index (0–100) for all ${n} Toronto neighbourhoods from Toronto Police Service reported-crime data through ${date} — ranked by district, with crime maps and night-time patterns.`,
      h1: 'How safe is your Toronto neighbourhood?',
      lead: `SafeRoute scores all 158 City of Toronto neighbourhoods 0–100 from incidents reported to the Toronto Police Service — severity-weighted, within 1 km of each area's centre, normalized citywide. Higher is safer. The same data powers the SafeRoute app's crime-aware walking routes.`,
      placeholder: 'Check a neighbourhood — e.g. The Annex, Leslieville, Liberty Village…',
      notice: (median) => `These figures describe <strong>reported</strong> crime around each neighbourhood's centre — they are informational, not a judgment of any community. Citywide median index: <strong>${median}/100</strong>.`,
      methodology: `Each incident reported to the Toronto Police Service (Major Crime Indicators — assault, robbery, break &amp; enter, auto theft and theft over, via the TPS Public Safety Data Portal) is weighted by severity — violence counts for more than shoplifting. For every neighbourhood we sum weighted incidents within 1 km of its centre, and normalize against citywide crime rates onto a 0–100 index, higher&nbsp;=&nbsp;safer. Boundaries are the City of Toronto's 158 official neighbourhoods, grouped under the six former municipalities (Old Toronto, North York, Scarborough, Etobicoke, East York and York) that people still use as districts. Time-of-day charts use TPS occurrence timestamps, severity-weighted. Pages regenerate as new data is published.`,
    },
  },
  'dc': {
    name: 'Washington, D.C.',
    hubName: 'Washington, D.C.',
    rankPool: 'D.C. neighborhoods',
    // 132 named neighbourhoods (DCGIS "Neighborhood Names") grouped by the 8
    // city Wards — a multi-district hub like NYC/Toronto. No rankHeading.
    areaWord: 'neighborhood', areaWordPlural: 'neighborhoods',
    centre: 'center', centreLabel: 'neighborhood center',
    // Land that is not housing tops a per-AREA index, because the score counts
    // incidents per square kilometre and not per person. Named explicitly, never
    // by a low-count threshold — a threshold sweeps in genuinely safe, affluent
    // neighborhoods and tells readers nobody lives there. Not dropped either:
    // these are real places people visit, and a page that explains the number
    // beats a page that is silently missing.
    sparseAreas: new Set(['monumental-core', 'georgetown-reservoir']),
    sparseNote: 'Most of this area is federal parkland, monuments and water rather than homes, so a low count reflects how few people live here rather than how safe the streets are.',
    reportedTo: 'reported to the DC Metropolitan Police',
    dataName: 'DC Police data',
    medianLabel: 'citywide median',
    forCity: 'for Washington, D.C.',
    acrossCity: 'across D.C.',
    faqCalc: (name) => `SafeRoute weights each incident reported to the DC Metropolitan Police by severity (violence weighs more than shoplifting), sums the last available period within 1 km of the ${name} center, and normalizes against citywide crime rates onto a 0–100 scale — higher is safer. It describes reported crime only; it is not a guarantee of safety.`,
    sources: (dateLine) => `Crime data: DC Metropolitan Police crime incidents via <a href="https://opendata.dc.gov/">Open Data DC</a>${dateLine}. Neighborhood and ward boundaries: DCGIS Open Data (132 named neighborhoods, 8 wards). Basemap © <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors (ODbL). Analysis © SafeRoute.`,
    basemapCredit: 'basemap © OpenStreetMap contributors',
    hub: {
      title: (n) => `Washington DC Neighborhood Safety Map & Rankings (${n} neighborhoods) — SafeRoute`,
      desc: (n, date) => `How safe is your DC neighborhood? Safety index (0–100) for all ${n} Washington, D.C. neighborhoods from Metropolitan Police reported-crime data through ${date} — ranked by ward, with crime maps and night-time patterns.`,
      h1: 'How safe is your DC neighborhood?',
      lead: `SafeRoute scores every Washington, D.C. neighborhood 0–100 from incidents reported to the DC Metropolitan Police — severity-weighted, within 1 km of each area's center, normalized citywide. Higher is safer. The same data powers the SafeRoute app's crime-aware walking routes.`,
      placeholder: 'Check a neighborhood — e.g. Georgetown, Columbia Heights, Anacostia…',
      notice: (median) => `These figures describe <strong>reported</strong> crime around each neighborhood's center — they are informational, not a judgment of any community. Note: the Metropolitan Police publish incident locations at block level for privacy, so dots mark blocks, not addresses. Citywide median index: <strong>${median}/100</strong>.`,
      methodology: `Each incident reported to the DC Metropolitan Police (via Open Data DC) is weighted by severity — violence counts for more than shoplifting. For every neighborhood we sum weighted incidents within 1 km of its center, and normalize against citywide crime rates onto a 0–100 index, higher&nbsp;=&nbsp;safer. Boundaries are DCGIS's 132 named neighborhoods, grouped by the 8 city wards. Time-of-day charts use MPD report timestamps, severity-weighted. Locations are published at block level for privacy. Pages regenerate as new data is published.`,
    },
  },
  'boston': {
    name: 'Boston',
    hubName: 'Boston',
    rankPool: 'Boston neighborhoods',
    // Compact city, small official set (25 BPDA neighbourhoods after excluding
    // the uninhabited Harbor Islands) → ONE ranked table, no district tier.
    areaWord: 'neighborhood', areaWordPlural: 'neighborhoods',
    centre: 'center', centreLabel: 'neighborhood center',
    reportedTo: 'reported to the Boston Police',
    dataName: 'Boston Police data',
    medianLabel: 'citywide median',
    forCity: 'for Boston',
    acrossCity: 'across Boston',
    faqCalc: (name) => `SafeRoute weights each incident reported to the Boston Police Department by severity (violence weighs more than shoplifting), sums the last available period within 1 km of the ${name} center, and normalizes against citywide crime rates onto a 0–100 scale — higher is safer. It describes reported crime only; it is not a guarantee of safety.`,
    sources: (dateLine) => `Crime data: Boston Police Department incident reports via <a href="https://data.boston.gov/">Analyze Boston</a>${dateLine}. Neighborhood boundaries: BPDA Neighborhood Boundaries (25 neighborhoods; the uninhabited Harbor Islands are excluded). Basemap © <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors (ODbL). Analysis © SafeRoute.`,
    basemapCredit: 'basemap © OpenStreetMap contributors',
    hub: {
      title: (n) => `Boston Neighborhood Safety Map & Rankings (${n} neighborhoods) — SafeRoute`,
      desc: (n, date) => `How safe is your Boston neighborhood? Safety index (0–100) for all ${n} Boston neighborhoods from Boston Police reported-crime data through ${date} — ranked citywide, with crime maps and night-time patterns.`,
      h1: 'How safe is your Boston neighborhood?',
      lead: `SafeRoute scores every Boston neighborhood 0–100 from incidents reported to the Boston Police Department — severity-weighted, within 1 km of each area's center, normalized citywide. Higher is safer. The same data powers the SafeRoute app's crime-aware walking routes.`,
      placeholder: 'Check a neighborhood — e.g. Back Bay, South End, Jamaica Plain…',
      rankHeading: (n) => `All ${n} Boston neighborhoods, safest first`,
      notice: (median) => `These figures describe <strong>reported</strong> crime around each neighborhood's center — they are informational, not a judgment of any community. Citywide median index: <strong>${median}/100</strong>.`,
      methodology: `Each incident reported to the Boston Police Department (via Analyze Boston) is weighted by severity — violence counts for more than shoplifting. For every neighborhood we sum weighted incidents within 1 km of its center, and normalize against citywide crime rates onto a 0–100 index, higher&nbsp;=&nbsp;safer. Boundaries are the BPDA's official neighborhood set; the Harbor Islands are excluded because the uninhabited park has no reported crime and would read as falsely "safe". Because Boston is compact and densely built, neighborhood centers sit close together and their 1&nbsp;km circles overlap — adjacent areas will show similar figures. Time-of-day charts use BPD incident timestamps, severity-weighted. Pages regenerate as new data is published.`,
    },
  },
  'baltimore': {
    name: 'Baltimore',
    hubName: 'Baltimore',
    rankPool: 'Baltimore community statistical areas',
    // CSAs, not the 256 neighbourhood statistical areas: at 566 m median centre
    // spacing the NSA set is finer than the 1 km index radius, so adjacent
    // pages would describe overlapping circles. The 56 CSAs land at 1,469 m —
    // wider than NYC or Toronto. See build-gazetteer-baltimore.mjs.
    areaWord: 'area', areaWordPlural: 'areas',
    centre: 'center', centreLabel: 'area center',
    // Baltimore had no sparseAreas key until the 2026-09 all-cities audit.
    // "Southeastern" is a CSA that is largely marine terminal and industrial
    // frontage, published at 91/100 and 3rd-safest of 56. Its incident cloud
    // sits 644 m north-east of the centre, so this is NOT a void a centroid
    // move fixes — the surroundings are genuinely mixed. The land is mostly port.
    sparseAreas: new Set(['southeastern']),
    sparseNote: 'Much of this area is marine terminal and industrial land rather than housing, so a low count reflects how few people are here rather than how safe the streets are.',
    reportedTo: 'reported to the Baltimore Police',
    dataName: 'Baltimore Police data',
    medianLabel: 'citywide median',
    forCity: 'for Baltimore',
    acrossCity: 'across Baltimore',
    faqCalc: (name) => `SafeRoute weights each incident reported to the Baltimore Police Department by severity (violence weighs more than shoplifting), sums the last available period within 1 km of the ${name} center, and normalizes against citywide crime rates onto a 0\u2013100 scale \u2014 higher is safer. It describes reported crime only; it is not a guarantee of safety.`,
    sources: (dateLine) => `Crime data: Baltimore Police Department Part 1 crime via <a href="https://data.baltimorecity.gov/">Open Baltimore</a>${dateLine}. Area boundaries: Community Statistical Areas (2020) from <a href="https://bniajfi.org/">BNIA-JFI</a>, the Jacob France Institute at the University of Baltimore \u2014 the geography the city's own indicator reporting uses. Basemap \u00a9 <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors (ODbL). Analysis \u00a9 SafeRoute.`,
    basemapCredit: 'basemap \u00a9 OpenStreetMap contributors',
    hub: {
      title: (n) => `Baltimore Neighborhood Safety Map & Rankings (${n} areas) \u2014 SafeRoute`,
      desc: (n, date) => `How safe is your Baltimore neighborhood? Safety index (0\u2013100) for all ${n} Baltimore community statistical areas from Baltimore Police data through ${date} \u2014 ranked citywide, with crime maps and night-time patterns.`,
      h1: 'How safe is your Baltimore neighborhood?',
      lead: `SafeRoute scores every Baltimore community statistical area 0\u2013100 from incidents reported to the Baltimore Police Department \u2014 severity-weighted, within 1 km of each area's center, normalized citywide. Higher is safer. Each area groups several neighborhoods, the way the city's own reporting does. The same data powers the SafeRoute app's crime-aware walking routes.`,
      placeholder: 'Check an area \u2014 e.g. Canton, Fells Point, Hampden\u2026',
      rankHeading: (n) => `All ${n} Baltimore areas, safest first`,
      notice: (median) => `These figures describe <strong>reported</strong> crime around each area's center \u2014 they are informational, not a judgment of any community. Citywide median index: <strong>${median}/100</strong>.`,
      methodology: `Each incident reported to the Baltimore Police Department (via Open Baltimore) is weighted by severity \u2014 violence counts for more than shoplifting. For every area we sum weighted incidents within 1 km of its center, and normalize against citywide crime rates onto a 0\u2013100 index, higher&nbsp;=&nbsp;safer. Boundaries are BNIA-JFI's 56 Community Statistical Areas rather than Baltimore's 256 neighborhood statistical areas: the neighborhood set is finer than the 1&nbsp;km radius this index measures over, so neighboring pages would describe almost the same circle. CSAs group those neighborhoods on census-tract lines \u2014 the same geography the city uses for its own indicator reporting \u2014 so each page covers a distinct part of the city. Time-of-day charts use BPD incident timestamps, severity-weighted. Pages regenerate as new data is published.`,
    },
  },
  'denver': {
    name: 'Denver',
    hubName: 'Denver',
    rankPool: 'Denver neighborhoods',
    // Denver's 78 official statistical neighborhoods are large by US standards
    // (median centre spacing 1.4 km, wider than NYC's), so 1 km circles stay
    // meaningfully distinct and one ranked table is enough.
    areaWord: 'neighborhood', areaWordPlural: 'neighborhoods',
    centre: 'center', centreLabel: 'neighborhood center',
    reportedTo: 'reported to the Denver Police',
    dataName: 'Denver Police data',
    medianLabel: 'citywide median',
    forCity: 'for Denver',
    acrossCity: 'across Denver',
    faqCalc: (name) => `SafeRoute weights each incident reported to the Denver Police Department by severity (violence weighs more than shoplifting), sums the last available period within 1 km of the ${name} center, and normalizes against citywide crime rates onto a 0\u2013100 scale \u2014 higher is safer. It describes reported crime only; it is not a guarantee of safety.`,
    sources: (dateLine) => `Crime data: Denver Police Department offense records via <a href="https://opendata-geospatialdenver.hub.arcgis.com/">Denver Open Data</a>${dateLine}. Neighborhood boundaries: City and County of Denver official statistical neighborhoods. Basemap \u00a9 <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors (ODbL). Analysis \u00a9 SafeRoute.`,
    basemapCredit: 'basemap \u00a9 OpenStreetMap contributors',
    hub: {
      title: (n) => `Denver Neighborhood Safety Map & Rankings (${n} neighborhoods) \u2014 SafeRoute`,
      desc: (n, date) => `How safe is your Denver neighborhood? Safety index (0\u2013100) for ${n} Denver neighborhoods from Denver Police offense data through ${date} \u2014 ranked citywide, with crime maps and night-time patterns.`,
      h1: 'How safe is your Denver neighborhood?',
      lead: `SafeRoute scores every Denver neighborhood 0\u2013100 from offenses reported to the Denver Police Department \u2014 severity-weighted, within 1 km of each area's center, normalized citywide. Higher is safer. The same data powers the SafeRoute app's crime-aware walking routes.`,
      placeholder: 'Check a neighborhood \u2014 e.g. Five Points, Capitol Hill, Baker\u2026',
      rankHeading: (n) => `All ${n} Denver neighborhoods, safest first`,
      notice: (median) => `These figures describe <strong>reported</strong> crime around each neighborhood's center \u2014 they are informational, not a judgment of any community. Citywide median index: <strong>${median}/100</strong>.`,
      methodology: `Each offense reported to the Denver Police Department (via Denver Open Data) is weighted by severity \u2014 violence counts for more than shoplifting. For every neighborhood we sum weighted offenses within 1 km of its center, and normalize against citywide crime rates onto a 0\u2013100 index, higher&nbsp;=&nbsp;safer. Boundaries are the City and County of Denver's official statistical neighborhoods. Denver's neighborhoods are relatively large, so 1&nbsp;km circles overlap less than in denser cities and adjacent areas separate more cleanly. Time-of-day charts use DPD offense timestamps, severity-weighted. Pages regenerate as new data is published.`,
    },
  },
  'longbeach': {
    name: 'Long Beach',
    hubName: 'Long Beach',
    rankPool: 'Long Beach neighborhoods',
    // 98 official neighborhoods. The city's boundary file carries 123, but 25
    // of those are "Unassigned (...)" fragments — marinas, the entrance
    // channel, regional parks, two power stations. They are not neighborhoods,
    // nobody walks them, and pages for them would be thin content, so they are
    // excluded. Doing so also widens median centre spacing 709 m → 780 m,
    // clearing DC (700 m), the tightest city published here.
    areaWord: 'neighborhood', areaWordPlural: 'neighborhoods',
    centre: 'center', centreLabel: 'neighborhood center',
    // Land that is not housing tops a per-AREA index, because the score counts
    // incidents per square kilometre and not per person. Named explicitly, never
    // by a low-count threshold — a threshold sweeps in genuinely safe, affluent
    // neighborhoods and tells readers nobody lives there. Not dropped either:
    // these are real places people visit, and a page that explains the number
    // beats a page that is silently missing.
    sparseAreas: new Set(['port-of-long-beach', 'airport-area']),
    sparseNote: 'Almost all of this area is working port, airport and terminal land rather than homes, so a low count reflects how few people are here rather than how safe the streets are.',
    reportedTo: 'reported to the Long Beach Police',
    dataName: 'Long Beach Police data',
    medianLabel: 'citywide median',
    forCity: 'for Long Beach',
    acrossCity: 'across Long Beach',
    faqCalc: (name) => `SafeRoute weights each incident reported to the Long Beach Police Department by severity (violence weighs more than shoplifting), sums the last available period within 1 km of the ${name} center, and normalizes against citywide crime rates onto a 0\u2013100 scale \u2014 higher is safer. It describes reported crime only; it is not a guarantee of safety.`,
    sources: (dateLine) => `Crime data: Long Beach Police Department incident records via <a href="https://datalb.longbeach.gov/">City of Long Beach Open Data</a>${dateLine}. Neighborhood boundaries: City of Long Beach official neighborhoods. Basemap \u00a9 <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors (ODbL). Analysis \u00a9 SafeRoute.`,
    basemapCredit: 'basemap \u00a9 OpenStreetMap contributors',
    hub: {
      title: (n) => `Long Beach Neighborhood Safety Map & Rankings (${n} neighborhoods) \u2014 SafeRoute`,
      desc: (n, date) => `How safe is your Long Beach neighborhood? Safety index (0\u2013100) for ${n} Long Beach neighborhoods from Long Beach Police incident data through ${date} \u2014 ranked citywide, with crime maps and night-time patterns.`,
      h1: 'How safe is your Long Beach neighborhood?',
      lead: `SafeRoute scores every Long Beach neighborhood 0\u2013100 from incidents reported to the Long Beach Police Department \u2014 severity-weighted, within 1 km of each area's center, normalized citywide. Higher is safer. The same data powers the SafeRoute app's crime-aware walking routes.`,
      placeholder: 'Check a neighborhood \u2014 e.g. Belmont Shore, Bixby Knolls, Alamitos Beach\u2026',
      rankHeading: (n) => `All ${n} Long Beach neighborhoods, safest first`,
      notice: (median) => `These figures describe <strong>reported</strong> crime around each neighborhood's center \u2014 they are informational, not a judgment of any community. Citywide median index: <strong>${median}/100</strong>.`,
      methodology: `Each incident reported to the Long Beach Police Department (via City of Long Beach Open Data) is weighted by severity \u2014 violence counts for more than shoplifting. For every neighborhood we sum weighted incidents within 1 km of its center, and normalize against citywide crime rates onto a 0\u2013100 index, higher&nbsp;=&nbsp;safer. Boundaries are the City of Long Beach's official neighborhoods; 25 unnamed fragments in the city's boundary file \u2014 marinas, the entrance channel, regional parks and two power stations \u2014 are excluded, because they are not places anyone lives or walks. Long Beach neighborhoods are compact, so 1&nbsp;km circles around adjacent centers overlap more than in a sprawling city; read neighbouring pages together rather than as sharp borders. The dataset records the date an incident was reported rather than when it occurred, so time-of-day patterns are not shown. Pages regenerate as new data is published.`,
    },
  },
  'neworleans': {
    name: 'New Orleans',
    hubName: 'New Orleans',
    rankPool: 'New Orleans neighborhoods',
    // 70 of the city's 72 Neighborhood Statistical Areas (the GNOCDC set).
    // "U.S. Naval Base" is dropped — a military installation, not a
    // neighborhood anybody walks, the same call San Diego's military parcels
    // got. "Lake Catherine" is dropped because the dispatch feed carries
    // nothing anywhere inside it, so its page could only have said "0
    // incidents, 100/100" — an absence of data dressed as a finding of safety.
    // The former public-housing developments (B. W. Cooper, Iberville,
    // Fischer, Florida, St. Thomas) are deliberately KEPT: they are real
    // residential neighborhoods, and dropping them would erase exactly the
    // places most likely to be talked about and least likely to be described
    // carefully. Spacing: 1,184 m median centre separation, 524 m minimum.
    //
    // ⚠ THIS IS THE ONE CITY WHOSE SCORE IS NOT BUILT ON POLICE REPORTS.
    // NOPD's incident-report series carries no coordinates and no current-year
    // data, so the only fresh geocoded feed is OPCD's 911 dispatch log,
    // filtered through a strict crime whitelist. A dispatch is not a
    // substantiated crime, and this under-counts against a true report feed.
    // Every string below says "911 calls" rather than "reported incidents"
    // because saying otherwise would be untrue, and the methodology states the
    // limitation outright rather than burying it.
    areaWord: 'neighborhood', areaWordPlural: 'neighborhoods',
    centre: 'center', centreLabel: 'neighborhood center',
    // Shared page furniture says "reported incidents" / "reported crime" by
    // default, which would quietly re-assert the exact claim this city cannot
    // make. These are the only overrides; every other city keeps the defaults.
    incidentNoun: 'crime-related 911 calls',
    incidentNounCap: 'Crime-related 911 calls',
    recordedWord: 'dispatched',
    lowCrimeNote: 'Few crime-related 911 calls are dispatched here, but stick to lit, busier streets late.',
    aboutData: 'Figures are crime-related 911 calls police were <em>dispatched to</em> within 1&nbsp;km of each neighborhood&rsquo;s center — a dispatch means officers were sent, not that an offense was confirmed, and not every crime generates a call.',
    reportsNounCap: 'Calls',
    figIncidents: 'crime-related 911 calls',
    crimeNoun: 'dispatched 911 calls',
    mapNoun: 'dispatched 911 call',
    reportsNoun: 'calls',
    whatReported: 'what police were called to',
    reportedHeading: 'What police were called to here',
    todTimestamps: 'NOPD dispatch timestamps',
    // Land that is not housing tops a per-AREA index, because the score counts
    // incidents per square kilometre and not per person. Named explicitly, never
    // by a low-count threshold — a threshold sweeps in genuinely safe, affluent
    // neighborhoods and tells readers nobody lives there. Not dropped either:
    // these are real places people visit, and a page that explains the number
    // beats a page that is silently missing.
    sparseAreas: new Set(['city-park', 'new-aurora-english-turn']),
    sparseNote: 'Most of this area is parkland and undeveloped ground rather than homes, so a low count reflects how few people live here rather than how safe the streets are.',
    reportedTo: 'dispatched to the NOPD',
    dataName: 'NOPD dispatch data',
    medianLabel: 'citywide median',
    forCity: 'for New Orleans',
    acrossCity: 'across New Orleans',
    faqCalc: (name) => `SafeRoute weights each crime-related 911 call the NOPD was dispatched to by severity (violence weighs more than shoplifting), sums the last available period within 1 km of the ${name} center, and normalizes against citywide rates onto a 0–100 scale — higher is safer. New Orleans is scored on dispatch calls rather than filed reports, because NOPD's report series carries no location data — so a call here means police were sent, not that an offense was confirmed. It is not a guarantee of safety.`,
    sources: (dateLine) => `Crime data: Orleans Parish Communication District 911 calls for service, filtered to crime call types, via <a href="https://data.nola.gov/">City of New Orleans Open Data</a>${dateLine}. Neighborhood boundaries: City of New Orleans Neighborhood Statistical Areas (GNOCDC). Basemap © <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors (ODbL). Analysis © SafeRoute.`,
    basemapCredit: 'basemap © OpenStreetMap contributors',
    hub: {
      title: (n) => `New Orleans Neighborhood Safety Map & Rankings (${n} neighborhoods) — SafeRoute`,
      desc: (n, date) => `How safe is your New Orleans neighborhood? Safety index (0–100) for ${n} New Orleans neighborhoods from NOPD 911 dispatch data through ${date} — ranked citywide, with crime maps and night-time patterns.`,
      h1: 'How safe is your New Orleans neighborhood?',
      lead: `SafeRoute scores every New Orleans neighborhood 0–100 from crime-related 911 calls the NOPD was dispatched to — severity-weighted, within 1 km of each neighborhood's center, normalized citywide. Higher is safer. The same data powers the SafeRoute app's crime-aware walking routes.`,
      placeholder: 'Check a neighborhood — e.g. French Quarter, Bywater, Garden District…',
      rankHeading: (n) => `All ${n} New Orleans neighborhoods, safest first`,
      notice: (median) => `These figures describe <strong>911 calls police were dispatched to</strong> around each neighborhood's center — they are informational, not a judgment of any community. Citywide median index: <strong>${median}/100</strong>.`,
      methodology: `New Orleans is the one city here not scored on filed police reports. NOPD's incident-report series carries no coordinates and no current-year data, so the only fresh geocoded feed is the Orleans Parish Communication District's 911 dispatch log. That log is mostly NOT crime — its largest call types are area checks, alarms, medical calls and traffic — so we keep only genuine offense call types (battery, robbery, burglary, theft, auto theft, weapons, drugs and similar) and discard the rest. Each surviving call is weighted by severity, summed within 1 km of a neighborhood's center, and normalized against citywide rates onto a 0–100 index, higher&nbsp;=&nbsp;safer. <strong>A dispatch means police were sent, not that an offense was confirmed</strong>, and this under-counts against a true report feed — so New Orleans scores are comparable within the city but should not be read against another city's number. Boundaries are the city's 72 Neighborhood Statistical Areas, less the U.S. Naval Base and Lake Catherine — the latter because the dispatch feed records nothing anywhere inside it, and a page reading &ldquo;0 incidents, 100/100&rdquo; would present missing data as proven safety. Time-of-day charts use the real dispatch clock time. Pages regenerate as new data is published.`,
    },
  },
  'sandiego': {
    name: 'San Diego',
    hubName: 'San Diego',
    rankPool: 'San Diego communities',
    // 53 of the city's 61 COMMUNITY PLAN AREAS. Eight are excluded: six are
    // not neighbourhoods at all and mostly say so in their own name (five
    // "RESERVE AREA-Not a community plan", plus "MILITARY FACILITIES"), and
    // two more — East Elliott and San Pasqual — are undeveloped land and an
    // agricultural valley where SDPD reports NO incidents at all. Those two
    // scored a perfect 100 precisely because there is no data, which would
    // have published "the safest place in San Diego" about empty backcountry.
    // Community plan areas are also the coarsest boundary set here after
    // Chicago and LA: 2,642 m median centre spacing, 1,103 m at the closest,
    // so no two pages describe overlapping ground.
    areaWord: 'community', areaWordPlural: 'communities',
    centre: 'center', centreLabel: 'community center',
    // Land that is not housing tops a per-AREA index, because the score counts
    // incidents per square kilometre and not per person. Named explicitly, never
    // by a low-count threshold — a threshold sweeps in genuinely safe, affluent
    // neighborhoods and tells readers nobody lives there. Not dropped either:
    // these are real places people visit, and a page that explains the number
    // beats a page that is silently missing.
    // NCFUA Subarea II is undeveloped; Mission Bay Park is parkland and the
    // Tijuana River Valley is open river-valley and agricultural land. The note
    // has to be true of all three, so it says "open land" rather than naming
    // any one of them — the Cleveland lesson about a shared note over-claiming.
    sparseAreas: new Set(['ncfua-subarea-ii', 'mission-bay-park', 'tijuana-river-valley']),
    sparseNote: 'Most of this area is open land \u2014 park, river valley or undeveloped \u2014 rather than homes, so a low count reflects how few people are here rather than how safe the streets are.',
    reportedTo: 'reported to the San Diego Police',
    dataName: 'San Diego Police data',
    medianLabel: 'citywide median',
    forCity: 'for San Diego',
    acrossCity: 'across San Diego',
    faqCalc: (name) => `SafeRoute weights each incident reported to the San Diego Police Department by severity (violence weighs more than shoplifting), sums the last available period within 1 km of the ${name} center, and normalizes against citywide crime rates onto a 0\u2013100 scale \u2014 higher is safer. It describes reported crime only; it is not a guarantee of safety.`,
    sources: (dateLine) => `Crime data: San Diego Police Department incident records via <a href="https://data.sandiego.gov/">City of San Diego Open Data</a>${dateLine}. Community boundaries: SANDAG / City of San Diego Community Plan Areas. Basemap \u00a9 <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors (ODbL). Analysis \u00a9 SafeRoute.`,
    basemapCredit: 'basemap \u00a9 OpenStreetMap contributors',
    hub: {
      title: (n) => `San Diego Community Safety Map & Rankings (${n} communities) \u2014 SafeRoute`,
      desc: (n, date) => `How safe is your San Diego community? Safety index (0\u2013100) for ${n} San Diego communities from San Diego Police incident data through ${date} \u2014 ranked citywide, with crime maps and night-time patterns.`,
      h1: 'How safe is your San Diego community?',
      lead: `SafeRoute scores every San Diego community 0\u2013100 from incidents reported to the San Diego Police Department \u2014 severity-weighted, within 1 km of each area's center, normalized citywide. Higher is safer. The same data powers the SafeRoute app's crime-aware walking routes.`,
      placeholder: 'Check a community \u2014 e.g. North Park, Pacific Beach, La Jolla\u2026',
      rankHeading: (n) => `All ${n} San Diego communities, safest first`,
      notice: (median) => `These figures describe <strong>reported</strong> crime around each community's center \u2014 they are informational, not a judgment of any community. Citywide median index: <strong>${median}/100</strong>.`,
      methodology: `Each incident reported to the San Diego Police Department (via City of San Diego Open Data) is weighted by severity \u2014 violence counts for more than shoplifting. For every community we sum weighted incidents within 1 km of its center, and normalize against citywide crime rates onto a 0\u2013100 index, higher&nbsp;=&nbsp;safer. Boundaries are SANDAG's Community Plan Areas \u2014 the areas San Diegans actually name. Eight of the city's 61 are excluded: six are not neighbourhoods (five reserve areas that say so in their own name, plus military facilities), and two \u2014 East Elliott and San Pasqual \u2014 are undeveloped backcountry where no incidents are reported at all, which would otherwise publish a perfect score built on an absence of data rather than on safety. The dataset records the date an incident occurred but not the time, so time-of-day patterns are not shown. Pages regenerate as new data is published.`,
    },
  },
  'vancouver': {
    name: 'Vancouver',
    hubName: 'Vancouver',
    rankPool: 'Vancouver local areas',
    // Canadian spelling: neighbourhood/centre, but -ize endings (normalize).
    // 22 official local areas, the widest centre spacing of any city here
    // (1.9 km), so each page describes a genuinely distinct part of the city.
    areaWord: 'neighbourhood', areaWordPlural: 'neighbourhoods',
    centre: 'centre', centreLabel: 'neighbourhood centre',
    reportedTo: 'reported to the Vancouver Police',
    dataName: 'Vancouver Police data',
    medianLabel: 'citywide median',
    forCity: 'for Vancouver',
    acrossCity: 'across Vancouver',
    faqCalc: (name) => `SafeRoute weights each incident reported to the Vancouver Police Department by severity (violence weighs more than shoplifting), sums the last available period within 1 km of the ${name} centre, and normalizes against citywide crime rates onto a 0\u2013100 scale \u2014 higher is safer. It describes reported crime only; it is not a guarantee of safety.`,
    sources: (dateLine) => `Crime data: Vancouver Police Department public crime incidents via the <a href="https://geodash.vpd.ca/">VPD GeoDASH open data service</a>${dateLine}. Neighbourhood boundaries: City of Vancouver official local areas (22). Basemap \u00a9 <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors (ODbL). Analysis \u00a9 SafeRoute.`,
    basemapCredit: 'basemap \u00a9 OpenStreetMap contributors',
    hub: {
      title: (n) => `Vancouver Neighbourhood Safety Map & Rankings (${n} local areas) \u2014 SafeRoute`,
      desc: (n, date) => `How safe is your Vancouver neighbourhood? Safety index (0\u2013100) for all ${n} Vancouver local areas from VPD crime data through ${date} \u2014 ranked citywide, with crime maps and night-time patterns.`,
      h1: 'How safe is your Vancouver neighbourhood?',
      lead: `SafeRoute scores every Vancouver local area 0\u2013100 from incidents reported to the Vancouver Police Department \u2014 severity-weighted, within 1 km of each area's centre, normalized citywide. Higher is safer. The same data powers the SafeRoute app's crime-aware walking routes, and Vancouver's live street cameras in the app's Live tab.`,
      placeholder: 'Check a neighbourhood \u2014 e.g. Downtown, Mount Pleasant, Kitsilano\u2026',
      rankHeading: (n) => `All ${n} Vancouver local areas, safest first`,
      notice: (median) => `These figures describe <strong>reported</strong> crime around each area's centre \u2014 they are informational, not a judgment of any community. Citywide median index: <strong>${median}/100</strong>.`,
      methodology: `Each incident reported to the Vancouver Police Department (via the VPD GeoDASH open data service) is weighted by severity \u2014 violence counts for more than shoplifting. For every local area we sum weighted incidents within 1 km of its centre, and normalize against citywide crime rates onto a 0\u2013100 index, higher&nbsp;=&nbsp;safer. Boundaries are the City of Vancouver's 22 official local areas \u2014 the coarsest set on this site, so each page covers a genuinely distinct part of the city rather than a block or two. VPD anonymises incident locations to the nearest block, so maps show the reported block, not an exact address. Time-of-day charts use VPD incident timestamps, severity-weighted. Pages regenerate as new data is published.`,
    },
  },
  'philly': {
    name: 'Philadelphia',
    hubName: 'Philadelphia',
    rankPool: 'Philadelphia neighborhoods',
    // Multi-district city (like NYC/DC/Toronto/Seattle): the city's 158 published
    // neighbourhoods — minus six with no residents — grouped under the 18 PCPC
    // Planning Districts, so the hub ranks within each district. No rankHeading.
    areaWord: 'neighborhood', areaWordPlural: 'neighborhoods',
    centre: 'center', centreLabel: 'neighborhood center',
    // Land that is not housing tops a per-AREA index, because the score counts
    // incidents per square kilometre and not per person. Named explicitly, never
    // by a low-count threshold — a threshold sweeps in genuinely safe, affluent
    // neighborhoods and tells readers nobody lives there. Not dropped either:
    // these are real places people visit, and a page that explains the number
    // beats a page that is silently missing.
    sparseAreas: new Set(['navy-yard', 'byberry', 'stadium-district']),
    sparseNote: 'Most of this area is industrial, institutional, stadium and commercial land rather than housing, so a low count reflects how few people live here rather than how safe the streets are.',
    reportedTo: 'reported to the Philadelphia Police',
    dataName: 'Philadelphia Police data',
    medianLabel: 'citywide median',
    forCity: 'for Philadelphia',
    acrossCity: 'across Philadelphia',
    faqCalc: (name) => `SafeRoute weights each incident reported to the Philadelphia Police Department by severity (violence weighs more than shoplifting), sums the last available period within 1 km of the ${name} center, and normalizes against citywide crime rates onto a 0–100 scale — higher is safer. It describes reported crime only; it is not a guarantee of safety.`,
    sources: (dateLine) => `Crime data: Philadelphia Police Department crime incidents via <a href="https://opendataphilly.org/">OpenDataPhilly</a>${dateLine}. Neighborhood boundaries: City of Philadelphia neighborhoods (151 of 158; parkland, airfields and one industrial zone are excluded), grouped by Philadelphia City Planning Commission Planning Districts. Basemap © <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors (ODbL). Analysis © SafeRoute.`,
    basemapCredit: 'basemap © OpenStreetMap contributors',
    hub: {
      title: (n) => `Philadelphia Neighborhood Safety Map & Rankings (${n} neighborhoods) — SafeRoute`,
      desc: (n, date) => `How safe is your Philadelphia neighborhood? Safety index (0–100) for ${n} Philly neighborhoods from Philadelphia Police reported-crime data through ${date} — ranked by planning district, with crime maps and night-time patterns.`,
      h1: 'How safe is your Philadelphia neighborhood?',
      lead: `SafeRoute scores every Philadelphia neighborhood 0–100 from incidents reported to the Philadelphia Police Department — severity-weighted, within 1 km of each area's center, normalized citywide. Higher is safer. The same data powers the SafeRoute app's crime-aware walking routes.`,
      placeholder: 'Check a neighborhood — e.g. Rittenhouse, Fishtown, Old City…',
      notice: (median) => `These figures describe <strong>reported</strong> crime around each neighborhood's center — they are informational, not a judgment of any community. Note: the Philadelphia Police publish incident locations at block level for privacy, so dots mark blocks, not addresses. Citywide median index: <strong>${median}/100</strong>.`,
      methodology: `Each incident reported to the Philadelphia Police Department (via OpenDataPhilly) is weighted by severity — violence counts for more than shoplifting. For every neighborhood we sum weighted incidents within 1 km of its center, and normalize against citywide crime rates onto a 0–100 index, higher&nbsp;=&nbsp;safer. Boundaries are the 158 neighborhoods the city publishes, grouped by the 18 Planning Districts the City Planning Commission uses; seven are not scored because nobody lives in them — both halves of Fairmount Park, Wissahickon and Pennypack Parks, the two airports, and the Southwest refinery belt labelled "Industrial" — where near-zero reported crime would read as falsely "safe" rather than as empty land. Time-of-day charts use PPD dispatch timestamps, severity-weighted. Locations are published at block level for privacy. Pages regenerate as new data is published.`,
    },
  },
};

// ── helpers ──────────────────────────────────────────────────────────────────
const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
// City hubs show two facts sourced from the transparency dataset (D): the
// feed's own transparency score, and which region id the hub maps to. Guarded:
// a missing dataset just hides the chips, it never fails a 1,222-page build.
const SLUG_TO_REGION = { 'new-york': 'nyc', london: 'uk', chicago: 'chicago', la: 'la',
  sf: 'sf', seattle: 'seattle', toronto: 'toronto', dc: 'dc', boston: 'boston', philly: 'philly',
  denver: 'denver', vancouver: 'vancouver', baltimore: 'baltimore', longbeach: 'longbeach',
  sandiego: 'sandiego' };
// Region ids with a live tonight layer — drives the hub strip. NOLA is live but
// has no SEO hub; SF joins this list the day its layer ships.
const TONIGHT_REGIONS = new Set(['neworleans', 'sf']);   // sf added 2026-08-22 (near real-time dispatch)
let TRANSPARENCY = null;
try {
  const t = JSON.parse(readFileSync(join(ROOT, 'tools', 'data', 'transparency-index.json')));
  TRANSPARENCY = Object.fromEntries(t.regions.map(r => [r.id, r]));
} catch { /* chips simply don't render */ }

const monthName = ym => {
  const [y, m] = String(ym).split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });
};
const ord = n => n + (n % 100 >= 11 && n % 100 <= 13 ? 'th' : ['th', 'st', 'nd', 'rd'][Math.min(n % 10, 4)] || 'th');
const fmt = n => Number(n).toLocaleString('en-US');

// How long a period a page's incident counts cover, in words.
//
// A raw count is unreadable without this. The feeds genuinely differ — the UK
// publishes a rolling month, NYPD runs year-to-date, Las Vegas a trailing
// twelve — so "3,228 incidents" says nothing about how busy an area is until
// you know whether that is a month's worth or a year's. Every page states a
// count; none of them stated the span.
//
// Null outside a fortnight-to-two-years band: below that a rounded month
// overstates the period, above it the feed is something other than the recent
// window the copy implies, and in both cases saying nothing beats saying
// something wrong.
const windowPhrase = days => {
  if (!(days > 0) || days < 14 || days > 760) return null;
  const months = Math.max(1, Math.round(days / 30.44));
  return months === 1 ? 'the month' : `the ${months} months`;
};
const CAT_NAMES = {
  'violent-crime': 'Violent crime', 'sexual-offences': 'Sexual offences', 'robbery': 'Robbery',
  'possession-of-weapons': 'Weapons possession', 'burglary': 'Burglary',
  'criminal-damage-arson': 'Criminal damage & arson', 'public-order': 'Public order',
  'theft-from-the-person': 'Theft from a person', 'drugs': 'Drugs',
  'anti-social-behaviour': 'Anti-social behaviour', 'vehicle-crime': 'Vehicle crime',
  'other-theft': 'Other theft', 'other-crime': 'Other', 'shoplifting': 'Shoplifting',
  'bicycle-theft': 'Bicycle theft', 'miscellaneous-incidents': 'Miscellaneous',
};
const catName = c => CAT_NAMES[c] || c.replace(/-/g, ' ').replace(/^./, ch => ch.toUpperCase());
const bandWord = { low: 'Low risk', moderate: 'Moderate', elevated: 'Elevated', high: 'High risk' };
const bandColor = { low: '#2E8B40', moderate: '#B0703C', elevated: '#9C5220', high: '#BC3B2E' };

// ── SVG: incident dot map over a build-time vector basemap ───────────────────
function mapShape(a) {
  const cosLat = Math.cos(a.lat * Math.PI / 180);
  const pts = (a.incidents || []).map(p => ({
    dx: (p.lng - a.lng) * 111320 * cosLat,
    dy: (p.lat - a.lat) * 111320,
  }));
  if (!pts.length) return { n: 0, edgeClustered: false, dirWord: '' };
  const dists = pts.map(p => Math.hypot(p.dx, p.dy)).sort((x, y) => x - y);
  const medianDist = dists[Math.floor(dists.length / 2)];
  const mx = pts.reduce((s, p) => s + p.dx, 0) / pts.length;
  const my = pts.reduce((s, p) => s + p.dy, 0) / pts.length;
  const bearing = (Math.atan2(mx, my) * 180 / Math.PI + 360) % 360;
  const dirWord = ['north', 'north-east', 'east', 'south-east', 'south', 'south-west', 'west', 'north-west'][Math.round(bearing / 45) % 8];
  return {
    n: pts.length,
    medianDist,
    edgeClustered: medianDist > 0.65 * (a.radiusMetres || 1000) && Math.hypot(mx, my) > 0.2 * (a.radiusMetres || 1000),
    dirWord,
  };
}

function mapSVG(a, shape, bm, cfg) {
  const W = 640, H = 430, cx = W / 2, cy = H / 2;
  const scale = (H - 40) / 2 / (a.radiusMetres || 1000);
  const cosLat = Math.cos(a.lat * Math.PI / 180);
  const base = (a.incidents || []).length < 150 ? 3.0 : 2.1;
  const dots = (a.incidents || []).map(p => {
    const x = cx + ((p.lng - a.lng) * 111320 * cosLat) * scale;
    const y = cy - ((p.lat - a.lat) * 111320) * scale;
    if (x < 4 || x > W - 4 || y < 4 || y > H - 4) return '';
    const t = Math.max(0, Math.min(1, ((p.w ?? 4) - 2) / 8));
    const col = `rgb(${Math.round(232 - t * 92)},${Math.round(146 - t * 90)},${Math.round(134 - t * 82)})`;
    return `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${(base + t * 1.6).toFixed(1)}" fill="${col}" fill-opacity="0.78"/>`;
  }).join('');
  const rings = [250, 500, 750, 1000].map(m =>
    `<circle cx="${cx}" cy="${cy}" r="${(m * scale).toFixed(1)}" fill="none" stroke="#B9AF98" stroke-width="${m === 1000 ? 1.4 : 0.7}" ${m < 1000 ? 'stroke-dasharray="3 5"' : ''} fill-opacity="0"/>`).join('');
  const sb = 500 * scale;

  // Two basemap modes: NYC caches LAND polygons (drawn over a water background,
  // shoreline city); London caches WATER polygons (Thames/docks drawn over a
  // land background, inland city). Both fall back to plain paper.
  const path = (rings2, close) => rings2.map(r => 'M' + r.map(p => p.join(',')).join('L') + (close ? 'Z' : '')).join('');
  let ground = `<rect width="${W}" height="${H}" fill="#FBF9F2"/>`;
  let streetLabels = '';
  // The gate must ask "is there ANY basemap geometry", not "is there ground
  // geometry": it used to require land or water polygons, so a fully inland,
  // dry area — no river, no shoreline, no docks — silently lost its entire
  // street grid and rendered as dots on blank paper. That was live on 100
  // pages across 13 cities (San Diego's mesas exposed it: 11 of 53) before
  // being caught here. Dry areas get the land tone as their ground.
  const hasBm = bm && ((bm.land?.length || 0) + (bm.water?.length || 0) +
                       (bm.parks?.length || 0) + (bm.stMinor?.length || 0) +
                       (bm.stMajor?.length || 0)) > 0;
  if (hasBm) {
    ground = bm.land?.length
      ? `<rect width="${W}" height="${H}" fill="#D7E3E8"/><path d="${path(bm.land, true)}" fill="#F7F3E8" fill-rule="evenodd"/>`
      : bm.water?.length
      ? `<rect width="${W}" height="${H}" fill="#F7F3E8"/><path d="${path(bm.water, true)}" fill="#D7E3E8" fill-rule="evenodd"/>`
      : `<rect width="${W}" height="${H}" fill="#F7F3E8"/>`;
    ground +=
      (bm.parks?.length ? `<path d="${path(bm.parks, true)}" fill="#E4EDDA" fill-rule="evenodd"/>` : '') +
      (bm.stMinor?.length ? `<path d="${path(bm.stMinor)}" fill="none" stroke="#DCD3BF" stroke-width="1"/>` : '') +
      (bm.stMajor?.length ? `<path d="${path(bm.stMajor)}" fill="none" stroke="#C9BC9F" stroke-width="1.8"/>` : '');
    streetLabels = (bm.labels || [])
      .filter(l => l.x >= 24 && l.x <= W - 24 && l.y >= 20 && l.y <= H - 20)
      .map(l =>
        `<text x="${l.x}" y="${l.y}" transform="rotate(${l.a} ${l.x} ${l.y})" text-anchor="middle" dy="-3" font-family="IBM Plex Mono,monospace" font-size="9.5" fill="#7D7666" stroke="#F7F3E8" stroke-width="3" paint-order="stroke">${esc(l.t)}</text>`).join('');
  }

  return `<svg viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Map of ${cfg.mapNoun ?? 'reported crime'} locations within ${a.radiusMetres} metres of the ${cfg.centre} of ${esc(a.name)}, over the local street network">
${ground}${rings}${streetLabels}${dots}
<circle cx="${cx}" cy="${cy}" r="4.5" fill="#14564C"/><circle cx="${cx}" cy="${cy}" r="8.5" fill="none" stroke="#14564C" stroke-width="1.5"/>
<text x="${cx}" y="${cy + 24}" text-anchor="middle" font-family="IBM Plex Mono,monospace" font-size="10.5" fill="#14564C" stroke="#F7F3E8" stroke-width="3" paint-order="stroke">${cfg.centreLabel}</text>
<rect x="12" y="8" width="278" height="24" rx="7" fill="#FBF9F2" fill-opacity="0.88"/>
<circle cx="26" cy="20" r="3" fill="#E89286" fill-opacity="0.85"/><circle cx="40" cy="20" r="3.6" fill="#8C1010" fill-opacity="0.85"/>
<text x="52" y="24" font-family="IBM Plex Mono,monospace" font-size="11" fill="#3C514C">1 dot = 1 report · darker = more severe</text>
<rect x="12" y="${H - 36}" width="118" height="28" rx="7" fill="#FBF9F2" fill-opacity="0.88"/>
<line x1="20" y1="${H - 16}" x2="${20 + sb}" y2="${H - 16}" stroke="#052926" stroke-width="2"/>
<text x="${20 + sb / 2}" y="${H - 22}" text-anchor="middle" font-family="IBM Plex Mono,monospace" font-size="11" fill="#3C514C">500 m</text>
<text x="${W - 20}" y="${H - 20}" text-anchor="end" font-family="IBM Plex Mono,monospace" font-size="11" fill="#717F7A" stroke="#F7F3E8" stroke-width="3" paint-order="stroke">N ↑</text>
</svg>`;
}

// ── SVG: time-of-day chart (only for cities with real per-incident times) ────
function todSVG(a, cfg) {
  const tod = a.timeOfDay;
  if (!tod || tod.length < 6) return '';
  const max = Math.max(...tod, 0.0001);
  const W = 300, H = 130, bw = 30, gap = 12, groupGap = 44, base = H - 34;
  const labels = ['6a–6p', '6p–12a', '12a–6a'];
  let x = 14, out = '';
  const group = (idx0, title) => {
    const x0 = x;
    for (let i = 0; i < 3; i++) {
      const t = tod[idx0 + i] / max, h = Math.max(3, t * 72);
      const col = `rgb(${Math.round(232 - t * 92)},${Math.round(146 - t * 90)},${Math.round(134 - t * 82)})`;
      out += `<rect x="${x}" y="${(base - h).toFixed(1)}" width="${bw}" height="${h.toFixed(1)}" rx="3" fill="${col}"/>`;
      out += `<text x="${x + bw / 2}" y="${base + 13}" text-anchor="middle" font-family="IBM Plex Mono,monospace" font-size="8.5" fill="#717F7A">${labels[i]}</text>`;
      x += bw + gap;
    }
    out += `<text x="${(x0 + x - gap) / 2}" y="${base + 27}" text-anchor="middle" font-family="IBM Plex Mono,monospace" font-size="9.5" font-weight="600" fill="#3C514C" letter-spacing="1">${title}</text>`;
    x += groupGap - gap;
  };
  group(0, 'MON–FRI'); group(3, 'SAT–SUN');
  return `<svg viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="When ${cfg.incidentNoun ?? 'reported incidents'} happen in ${esc(a.name)}: severity-weighted share by time of day, weekdays versus weekends">${out}</svg>`;
}

// ── prose (deterministic from data — the content IS the data) ───────────────
function makeProse(a, ctx) {
  const { cfg, gazBySlug, bySlug, rankOf, median, count, windowDays } = ctx;
  const g = gazBySlug.get(a.slug) || {};
  const rank = rankOf.get(a.slug);
  const diff = a.safetyScore - median;
  const top = (a.breakdown || [])[0];
  const topShare = top ? Math.round(100 * top.count / Math.max(1, a.totalIncidents)) : 0;
  const tod = a.timeOfDay || [];
  const night = tod.length >= 6 ? (tod[2] + tod[5]) : null;
  const evening = tod.length >= 6 ? (tod[1] + tod[4]) : null;

  // This sentence makes a COMPARATIVE claim ("than most X"), so it has to come
  // from rank within the city — not from the band, which is absolute incident
  // density. The bands are wide (elevated spans ~25–49) and straddle every city
  // median, so band-driven copy contradicted the very next clause: areas
  // ranking in the top quarter were told they had "more crime than most", then
  // "16 points above the median, ranking 12th of 197". The band badge still
  // shows the absolute reading, which is what it is labelled as.
  const pct = rank / count;                       // rank 1 = safest
  const bandLead =
    pct <= 0.25 ? `${a.name} sits at the safer end of ${cfg.hubName} by ${cfg.crimeNoun ?? 'reported crime'}.`
    : pct <= 0.60 ? `${a.name} shows a typical level of ${cfg.crimeNoun ?? 'reported crime'} ${cfg.forCity}.`
    : pct <= 0.85 ? `${a.name} records more ${cfg.crimeNoun ?? 'reported crime'} than most ${cfg.name} ${cfg.areaWordPlural}.`
    : `${a.name} records a high level of ${cfg.crimeNoun ?? 'reported crime'} ${cfg.forCity}.`;

  // A "safest" ranking built on almost no incidents is the one reading this
  // index can get badly wrong: the score counts incidents per AREA, not per
  // person, so a cleared tract outscores a busy, well-policed street.
  //
  // This is a NAMED LIST, not a low-count threshold, and the difference matters.
  // A bottom-decile rule was tried first and it swept in Palmer Woods and Green
  // Acres — intact, affluent, genuinely safe neighborhoods — telling readers
  // their quiet might mean nobody lives there. Incident count cannot separate
  // "emptied out" from "safe and populated"; only knowing the place can. So the
  // caveat attaches to specific documented cases and nothing else.
  const sparse = cfg.sparseAreas?.has(a.slug) ? ` ${cfg.sparseNote}` : '';

  // A score built on a handful of reports is not wrong, but it is fragile, and
  // the page states it in the same confident voice as a score built on two
  // thousand. This says so — automatically, everywhere, with no per-city list to
  // maintain, because it is a statement about the DATA and not about the place.
  //
  // It is deliberately separate from the sparseAreas caveat above. That one
  // explains why land is empty (a park, a dock, an airport) and would be FALSE
  // here: Long Beach's Island Village and San Diego's Black Mountain Ranch are
  // ordinary residential communities that are simply very quiet. Telling their
  // residents the area is "mostly industrial land" would be its own error.
  const thin = !sparse && (a.totalIncidents ?? 0) > 0 && a.totalIncidents < 5
    ? ` This score rests on just ${a.totalIncidents} recorded ${a.totalIncidents === 1 ? 'incident' : 'incidents'}, so it is far less settled than most and will move more as new data is published.`
    : '';

  const cmp = Math.abs(diff) <= 3
    ? `right at the ${cfg.medianLabel} of ${median}`
    : `${Math.abs(diff)} points ${diff > 0 ? 'above' : 'below'} the ${cfg.medianLabel} of ${median}`;

  // State the span alongside the count wherever the feed reports one: "3,228
  // incidents ... over the 7 months to August 2026" is a claim a reader can
  // actually judge, where the bare count plus an end date was not.
  const span = windowPhrase(windowDays);
  const period = span ? `over ${span} to ${monthName(a.crimeDate)}` : `(data through ${monthName(a.crimeDate)})`;
  const lead = `${bandLead} Its SafeRoute safety index is <strong>${a.safetyScore} out of 100</strong> — ${cmp}, ranking ${ord(rank)} of ${count} ${cfg.rankPool} — based on ${fmt(a.totalIncidents)} incidents ${cfg.reportedTo} within 1 km of the ${cfg.areaWord} ${cfg.centre} ${period}.${sparse}${thin}`;

  let mix = '';
  if (top) {
    const violent = ['violent-crime', 'robbery', 'sexual-offences', 'possession-of-weapons'].includes(top.category);
    mix = violent
      ? `The largest ${cfg.recordedWord ?? 'reported'} category here is <strong>${catName(top.category).toLowerCase()}</strong> (${topShare}% of ${cfg.reportsNoun ?? 'reports'}) — worth taking seriously when walking at night; the full mix is broken down below.`
      : `Most of ${cfg.whatReported ?? "what's reported"} here is property-related — <strong>${catName(top.category).toLowerCase()}</strong> alone is ${topShare}% of ${cfg.reportsNoun ?? 'reports'} — rather than violence against strangers, though the full mix below is worth a look.`;
  }

  let when = '';
  if (night != null) {
    const nightPct = Math.round(night * 100), evePct = Math.round(evening * 100);
    when = night >= 0.30
      ? `Timing matters here: about ${nightPct}% of severity-weighted incidents are reported overnight (midnight–6 a.m.), so route choice late at night matters more than the headline number suggests.`
      : night <= 0.15
        ? `${cfg.incidentNounCap ?? 'Reported incidents'} here skew to daytime and evening hours — only about ${nightPct}% of severity-weighted ${cfg.reportsNoun ?? 'reports'} fall overnight (midnight–6 a.m.).`
        : `Incidents spread across the day here — roughly ${evePct}% of severity-weighted ${cfg.reportsNoun ?? 'reports'} come in the evening (6 p.m.–midnight) and ${nightPct}% overnight.`;
  }

  const neighbors = (g.neighbors || []).map(s => bySlug.get(s)).filter(Boolean);

  const faq = [
    {
      q: `Is ${a.name} safe at night?`,
      a: night != null
        ? `${bandWord[a.band]} overall (safety index ${a.safetyScore}/100). About ${Math.round((night + evening) * 100)}% of severity-weighted incidents in ${a.name} are ${cfg.recordedWord ?? 'reported'} between 6 p.m. and 6 a.m. ${a.band === 'low' ? (cfg.lowCrimeNote ?? `Reported crime is low ${cfg.forCity}, but stick to lit, busier streets late.`) : 'At night, prefer lit, busier streets — a block or two of detour often avoids the clusters on the map above.'}`
        : `${bandWord[a.band]} overall (safety index ${a.safetyScore}/100). ${a.band === 'low' ? `Reported crime is low ${cfg.forCity}, but stick to lit, busier streets late.` : 'At night, prefer lit, busier streets — a short detour often avoids the clusters on the map above.'}`,
    },
    {
      q: `What is the most common crime in ${a.name}?`,
      a: top
        ? `${catName(top.category)} — ${fmt(top.count)} of ${fmt(a.totalIncidents)} incidents (${topShare}%) ${cfg.recordedWord ?? 'reported'} within 1 km of the ${cfg.areaWord} ${cfg.centre} ${span ? `over ${span} to` : 'through'} ${monthName(a.crimeDate)}.`
        : `No dominant category in the current data.`,
    },
    {
      q: `How is the ${a.name} safety index calculated?`,
      // The scale is calibrated per city (a typical area reads mid-scale), so a
      // score only means something against other areas in the same city. The hub
      // says this under Methodology, but almost nobody arrives via the hub —
      // search drops readers straight onto an area page. Appending it here puts
      // it on every page AND inside the FAQPage structured data.
      a: `${cfg.faqCalc(cfg.areaWord)} The scale is calibrated within ${cfg.name}, so scores compare ${cfg.areaWordPlural} to each other and cannot be read against another city's.`,
    },
  ];

  return { lead, mix, when, neighbors, faq, rank, count, diff };
}

// ── page chrome ──────────────────────────────────────────────────────────────
// Cloudflare Web Analytics — cookieless, collects no personal data and sets no
// identifiers, so it needs no consent banner (the site serves UK/EU visitors)
// and keeps the project's PII-free stance. The beacon token is PUBLIC by design
// (it ships in the page source and only identifies which site a hit belongs to)
// — it is not a secret and must not be treated as one.
// Set it here, or override per-build with CF_BEACON_TOKEN=... node render-pages.mjs
// While unset, no script is emitted at all — pages stay clean.
const CF_BEACON_TOKEN = process.env.CF_BEACON_TOKEN || 'a7d4a481ed8b4512a43225404078e7ab';
const analytics = () => CF_BEACON_TOKEN
  ? `<script type="module" src="https://static.cloudflareinsights.com/beacon.min.js" data-cf-beacon='{"token": "${CF_BEACON_TOKEN}"}'></script>\n`
  : '';

const head = (title, desc, canonical, jsonld) => `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${esc(title)}</title>
<meta name="description" content="${esc(desc)}">
<link rel="canonical" href="${canonical}">
<meta name="apple-itunes-app" content="app-id=${APP_ID}">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(desc)}">
<meta property="og:image" content="https://safe-route.app/assets/og-preview.png">
<meta name="twitter:card" content="summary_large_image">
<meta property="og:type" content="article">
<meta property="og:url" content="${canonical}">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600&display=swap" rel="stylesheet">
<meta name="theme-color" content="#0A0D12">
<link rel="stylesheet" href="/assets/sr.css">
<link rel="stylesheet" href="/safety/assets/safety.css">
${jsonld ? `<script type="application/ld+json">${JSON.stringify(jsonld)}</script>` : ''}
${analytics()}</head>
<body>`;

// Shared header: wordmark + the five-destination site nav; breadcrumbs move to
// their own slim bar below so navigation and orientation stop competing for
// the same row.
const chrome = crumbs => `<header class="site"><div class="wrap">
<a class="wordmark" href="/"><svg class="shield" viewBox="0 0 22 26" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path d="M11 1.2 20 4.7v7.6c0 6-4.3 10.2-9 12-4.7-1.8-9-6-9-12V4.7L11 1.2Z" fill="#14564C"/><path d="M6.9 12.7 9.7 15.5 15 9.1" stroke="#F4F0E6" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg><span>SAFEROUTE</span></a>
<nav class="site-nav" aria-label="Site">
<a href="/safety/" class="on">Safety index</a>
<a href="/check/">Check an address</a>
<a href="/tonight/">Tonight</a>
<a class="hide-sm" href="/transparency/">Transparency</a>
<a class="cta" href="https://apps.apple.com/app/apple-store/id6768244297?pt=128877797&ct=web-safety-pages&mt=8">Get the app</a>
</nav>
</div></header><div class="crumbbar"><div class="wrap"><nav class="crumbs">${crumbs}</nav></div></div><main><div class="wrap">`;

const footer = (cfg, a, citySlug, windowDays) => `</div></main><footer class="site"><div class="wrap">
<p><strong>Sources.</strong> ${cfg.sources(!a ? ''
  : windowPhrase(windowDays) ? `, covering ${windowPhrase(windowDays)} to ${monthName(a.crimeDate)}`
  : `, data through ${monthName(a.crimeDate)}`)}</p>
<p><strong>About this data.</strong> ${cfg.aboutData ?? `Figures are incidents <em>reported</em> to police within 1&nbsp;km of each ${cfg.areaWord}'s ${cfg.centre} — reporting practices vary and not all crime is reported.`} This is informational only and not a guarantee of safety, a prediction, or a judgment of any community. Use it the way the app does: to pick better-lit, lower-incident routes and times.</p>
<p><a href="/safety/${citySlug}/">All ${cfg.name} ${cfg.areaWordPlural}</a> · <a href="/">SafeRoute app</a> · <a href="https://minhajk21.github.io/saferoute-privacy/">Privacy</a></p>
</div></footer></body></html>`;

const cta = (name) => `<div class="cta">
<h2>Walking in ${esc(name)} at night?</h2>
<p>SafeRoute scores every walking route against the same live crime data on this page — and shows how much of each route runs on lit streets. Pick the safer way, share your walk, and check in when you arrive. Free, no account.</p>
<a class="btn" href="${APP_URL}">Get SafeRoute on the App Store</a>
</div>`;

// ── render one city (pages + hub); returns summary for root/sitemap ─────────
function renderCity(citySlug) {
  const cfg = CITIES[citySlug];
  const gazFile = join(ROOT, 'tools', 'gazetteer', `${citySlug}.json`);
  const cacheDir = join(ROOT, 'tools', 'data-cache', citySlug);
  if (!cfg || !existsSync(gazFile) || !existsSync(cacheDir)) return null;

  const gaz = JSON.parse(readFileSync(gazFile));
  const allAreas = readdirSync(cacheDir).filter(f => f.endsWith('.json'))
    .map(f => JSON.parse(readFileSync(join(cacheDir, f))));

  // PUBLISH FLOOR — refuse to put a number on almost no data.
  //
  // A score is a claim, and these pages make it in a voice a reader will act on
  // ("ranked 12th of 158", "elevated"). Below a certain amount of data there is
  // nothing behind the claim. New Orleans's Viavant-Venetian Isles was published
  // "elevated" from TWO incidents over a ONE-DAY window; Kansas City's Richards
  // Gebaur from a single incident, also over one day. Those are not findings
  // about those places, they are noise with a rank attached.
  //
  // The floor is deliberately about EVIDENCE, not about safety: an area is
  // dropped when its window is too short or its count too small for any score
  // to mean anything, whichever direction the number happens to point. It is the
  // same call Lake Catherine and Longview got in their gazetteers, generalised
  // so it catches the next one automatically instead of waiting for an audit.
  // The floor is on the WINDOW, not on the count, and the distinction matters.
  // A one-day window means there is no period to have measured anything over —
  // no score computed from it can mean a thing in either direction. A low COUNT
  // over a long window is different: it is a real measurement of a quiet or
  // empty place, and the honest remedy there is the sparseAreas caveat, which
  // says what the emptiness means. Dropping those would delete real pages —
  // Port of Long Beach, Shoal Creek and Tijuana River Valley all carry caveats
  // that explain themselves correctly.
  const FLOOR_DAYS = 7;
  const tooThin = allAreas.filter(a => a.windowDays != null && a.windowDays < FLOOR_DAYS);
  const areas = allAreas.filter(a => !tooThin.includes(a));
  if (tooThin.length) {
    console.log(`  ${citySlug}: ${tooThin.length} area(s) below the ${FLOOR_DAYS}-day publish floor, not rendered — `
      + tooThin.map(a => `${a.name} (${a.totalIncidents} incidents over ${a.windowDays}d)`).join('; '));
  }
  // A long window with almost nothing in it is legitimate, but only if the page
  // SAYS so. Warn when such an area has no caveat — that is the Black Mountain
  // Ranch case: 1 incident, 153 days, published at 99/100 with nothing to
  // explain it.
  const uncaveatedThin = areas.filter(a =>
    (a.totalIncidents ?? 0) < 5 && !(cfg.sparseAreas?.has(a.slug)));
  if (uncaveatedThin.length) {
    console.log(`  ${citySlug}: WARNING — ${uncaveatedThin.length} area(s) under 5 incidents with NO caveat: `
      + uncaveatedThin.map(a => `${a.name} (${a.totalIncidents}, score ${a.safetyScore})`).join('; '));
  }
  if (!areas.length) return null;
  const noBasemap = [];

  const bySlug = new Map(areas.map(a => [a.slug, a]));
  const gazBySlug = new Map(gaz.areas.map(a => [a.slug, a]));
  const scores = areas.map(a => a.safetyScore).sort((x, y) => x - y);
  const median = scores[Math.floor(scores.length / 2)];
  const ranked = [...areas].sort((a, b) => b.safetyScore - a.safetyScore);
  const rankOf = new Map(ranked.map((a, i) => [a.slug, i + 1]));
  // The feed's span is a property of the CITY's feed, not of any one area, so
  // derive one number and use it on every page. Median of whatever the cached
  // records carry: a full rebuild fills it in everywhere, but a partial refresh
  // (or a provider that reports no span at all) must not leave most pages
  // silent while a handful claim a period. Null when nothing reports one — the
  // copy then falls back to the old "data through <month>" wording rather than
  // inventing a window.
  const windows = areas.map(a => a.windowDays).filter(w => w > 0).sort((x, y) => x - y);
  const windowDays = windows.length ? windows[Math.floor(windows.length / 2)] : null;
  const ctx = { cfg, gazBySlug, bySlug, rankOf, median, count: areas.length, windowDays };

  for (const a of areas) {
    const p = makeProse(a, ctx);
    const shape = mapShape(a);
    const clusterNote = shape.edgeClustered
      ? ` ${cfg.reportsNounCap ?? 'Reports'} cluster toward the ${shape.dirWord} of the map — the area immediately around the ${cfg.centreLabel} is comparatively quiet.`
      : '';
    const bmFile = join(ROOT, 'tools', 'data-cache', `${citySlug}-basemap`, `${a.slug}.json`);
    const bm = existsSync(bmFile) ? JSON.parse(readFileSync(bmFile)) : null;
    // A basemap with no geometry renders as blank paper. That has happened for
    // real (a regional Overpass mirror answering 200 with zero elements), so
    // count them here — the last gate before publish — and fail the run below.
    if (!bm || !((bm.water?.length || 0) + (bm.parks?.length || 0) +
                 (bm.stMinor?.length || 0) + (bm.stMajor?.length || 0))) noBasemap.push(a.slug);

    const url = `${SITE}/safety/${citySlug}/${a.slug}/`;
    const title = `Is ${a.name} Safe? Crime Map & Safety Index — SafeRoute`;
    const desc = `${a.name} safety index: ${a.safetyScore}/100 (${bandWord[a.band].toLowerCase()}) — ${fmt(a.totalIncidents)} ${cfg.incidentNoun ?? 'reported incidents'} within 1 km (through ${monthName(a.crimeDate)}). Crime map, ${cfg.whatReported ?? "what's reported"}, and how it compares ${cfg.acrossCity}.`;
    const jsonld = [
      { '@context': 'https://schema.org', '@type': 'BreadcrumbList', itemListElement: [
        { '@type': 'ListItem', position: 1, name: 'Safety', item: `${SITE}/safety/` },
        { '@type': 'ListItem', position: 2, name: cfg.name, item: `${SITE}/safety/${citySlug}/` },
        { '@type': 'ListItem', position: 3, name: a.name, item: url }] },
      { '@context': 'https://schema.org', '@type': 'FAQPage',
        mainEntity: p.faq.map(f => ({ '@type': 'Question', name: f.q, acceptedAnswer: { '@type': 'Answer', text: f.a } })) },
    ];

    const catRows = (a.breakdown || []).slice(0, 6).map(c => {
      const share = Math.round(100 * c.count / Math.max(1, a.totalIncidents));
      return `<tr><td>${esc(catName(c.category))}</td><td style="width:38%"><div class="sharebar"><i style="width:${share}%"></i></div></td><td class="n">${fmt(c.count)} · ${share}%</td></tr>`;
    }).join('');

    const nearbyRows = p.neighbors.map(nb =>
      `<li><a href="/safety/${citySlug}/${nb.slug}/">${esc(nb.name)}</a><span class="s">${nb.safetyScore}/100 · ${bandWord[nb.band]}</span></li>`).join('');

    const hasTod = a.timeOfDay && a.timeOfDay.length >= 6;
    const rightPanel = hasTod ? `
<section>
<h2>When it happens</h2>
<div class="tod">${todSVG(a, cfg)}</div>
<p style="font-size:14px;color:var(--ink-3);margin-top:8px">Severity-weighted share of ${cfg.incidentNoun ?? 'reported incidents'} by time of day, from ${cfg.todTimestamps ?? (cfg.dataName === 'NYPD data' ? 'NYPD incident timestamps' : 'police incident timestamps')}.</p>
</section>` : '';

    const html = `${head(title, desc, url, jsonld)}${chrome(`<a href="/safety/">Safety</a> › <a href="/safety/${citySlug}/">${cfg.name}</a> › ${esc(a.name)}`)}
<p class="eyebrow">Safety index · ${a.borough === cfg.name ? '' : esc(a.borough) + ', '}${cfg.name} · data through ${monthName(a.crimeDate)}</p>
<h1>Is ${esc(a.name)} safe?</h1>
<p class="lead">${p.lead}</p>

<div class="scorecard">
  <div class="scorenum" style="color:${bandColor[a.band]}">${a.safetyScore}<small>/100</small></div>
  <div style="flex:1">
    <span class="band ${a.band}">${bandWord[a.band]}</span>
    <div class="scoremeta">SafeRoute safety index for the area within 1 km of the ${cfg.centre} of ${esc(a.name)} — higher is safer. ${ord(p.rank)} of ${p.count} ${cfg.rankPool}.</div>
    <div class="gaugebar"><i style="width:${a.safetyScore}%;background:${bandColor[a.band]}"></i></div>
  </div>
</div>
<p class="recency-chip">DATA THROUGH ${monthName(a.crimeDate).toUpperCase()}${windowPhrase(windowDays) ? ` · ${windowPhrase(windowDays).replace(/^the month$/, '1 month').replace(/^the /, '').toUpperCase()} OF DATA` : ''}</p>
<p style="font-size:14px;color:var(--ink-3);margin-top:-6px">The 0–100 scale is calibrated to ${esc(cfg.name)} — a typical ${esc(cfg.name)} ${cfg.areaWord} sits near ${median}. It ranks ${esc(a.name)} against other ${cfg.areaWordPlural} here, and cannot be read against a score in another city.</p>

${p.mix ? `<p>${p.mix}</p>` : ''}
${p.when ? `<p>${p.when}</p>` : ''}

<h2>Where incidents cluster</h2>
<figure class="map">
${mapSVG(a, shape, bm, cfg)}
<figcaption>${fmt(a.totalIncidents)} ${cfg.figIncidents ?? 'incidents reported'} within 1 km of the ${esc(a.name)} ${cfg.centre}${(a.incidents || []).length < a.totalIncidents ? ` (${fmt((a.incidents || []).length)} shown)` : ''} · ${cfg.dataName} through ${monthName(a.crimeDate)}${bm ? ` · ${cfg.basemapCredit}` : ''}.${clusterNote}</figcaption>
</figure>
<a class="checkmap" href="/check/?lat=${a.lat}&lng=${a.lng}&name=${encodeURIComponent(a.name)}"><span class="dot"></span>Open ${esc(a.name)} on the live interactive map →</a>

<div class="grid2">
<section>
<h2>${cfg.reportedHeading ?? "What's reported here"}</h2>
<table class="cats">${catRows}</table>
</section>${rightPanel}
</div>

${cta(a.name)}

<h2>Nearby areas</h2>
<ul class="nearby">${nearbyRows}</ul>

<h2>Common questions</h2>
${p.faq.map(f => `<details><summary>${esc(f.q)}</summary><p>${f.a}</p></details>`).join('\n')}
${footer(cfg, a, citySlug, windowDays)}`;

    const dir = join(ROOT, 'safety', citySlug, a.slug);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'index.html'), html);
  }

  // ── city hub ──
  {
    const url = `${SITE}/safety/${citySlug}/`;
    const date = monthName(areas[0]?.crimeDate || '2026-01');
    const title = cfg.hub.title(areas.length);
    const desc = cfg.hub.desc(areas.length, date);
    const boroughs = [...new Set(areas.map(a => a.borough))].sort();
    const tables = boroughs.map(b => {
      const rows = ranked.filter(a => a.borough === b).map(a =>
        `<tr><td><a href="/safety/${citySlug}/${a.slug}/">${esc(a.name)}</a></td><td class="n" style="color:${bandColor[a.band]}">${a.safetyScore}/100</td><td><span class="band ${a.band}">${bandWord[a.band]}</span></td><td class="n">${fmt(a.totalIncidents)}</td></tr>`).join('');
      // Cities with no sub-city tier (Chicago: 77 community areas, one pool)
      // group into a single table — label it usefully instead of repeating the
      // city name under the h1.
      const heading = boroughs.length === 1 && cfg.hub.rankHeading ? cfg.hub.rankHeading(areas.length) : esc(b);
      return `<h2 id="${b.toLowerCase().replace(/\s+/g, '-')}">${heading}</h2>
<table class="rank"><thead><tr><th>${cfg.areaWord.replace(/^./, c => c.toUpperCase())} (safest first)</th><th style="text-align:right">Index</th><th>Band</th><th style="text-align:right">Incidents</th></tr></thead><tbody>${rows}</tbody></table>`;
    }).join('\n');

    const idx = areas.map(a => ({ s: a.slug, n: a.name, b: a.borough, v: a.safetyScore, band: a.band }));
    const html = `${head(title, desc, url, {
      '@context': 'https://schema.org', '@type': 'BreadcrumbList', itemListElement: [
        { '@type': 'ListItem', position: 1, name: 'Safety', item: `${SITE}/safety/` },
        { '@type': 'ListItem', position: 2, name: cfg.name, item: url }],
    })}${chrome(`<a href="/safety/">Safety</a> › ${cfg.name}`)}
<p class="eyebrow">${cfg.areaWord.replace(/^./, c => c.toUpperCase())} safety · ${cfg.hubName} · data through ${date}</p>
<h1>${cfg.hub.h1}</h1>
<p class="lead">${cfg.hub.lead}</p>

<div class="checker">
<input id="ckr" type="search" placeholder="${cfg.hub.placeholder}" aria-label="Search ${cfg.name} ${cfg.areaWordPlural}">
<ul id="ckr-out"></ul>
</div>

<p class="notice">${cfg.hub.notice(median)}</p>
${(() => {
  // D: the city's data, described in chips — feed recency, window, and the
  // transparency score for the city's own feed, linking to the index.
  const region = TRANSPARENCY?.[SLUG_TO_REGION[citySlug]];
  const newestYm = [...areas].map(a => a.crimeDate).filter(Boolean).sort().pop();
  const chips = [];
  if (newestYm) chips.push(`Feed current to ${monthName(newestYm)}`);
  const span = windowPhrase(windowDays);
  if (span) chips.push(`covers ${span.replace(/^the month$/, '1 month').replace(/^the /, '')}`);
  if (region?.categoryCount) chips.push(`${region.categoryCount} offence categories`);
  if (region?.total != null) chips.push(`<a href="/transparency/">data transparency ${region.total}/100</a>`);
  if (TONIGHT_REGIONS.has(SLUG_TO_REGION[citySlug]))
    chips.push(`<a href="/tonight/" class="tonight">⏺ last 24 hrs live</a>`);
  return chips.length ? `<div class="citychips">${chips.map(c => `<span>${c}</span>`).join('')}</div>` : '';
})()}

${tables}

${cta(cfg.name)}

<h2>Methodology</h2>
<p style="font-size:15.5px;color:var(--ink-2)">${cfg.hub.methodology}</p>
<p style="font-size:15.5px;color:var(--ink-2)">The index compares areas <strong>within ${esc(cfg.hubName)}</strong>. It is not comparable between cities: each police force publishes a different set of offences over a different period — ${esc(cfg.name)}'s figures cannot be read against another city's on the same 0–100 scale.</p>
${footer(cfg, areas[0], citySlug, windowDays)}
<script>
const IDX=${JSON.stringify(idx)};
// The city segment is held in a variable so no complete-looking path literal
// survives in this source. Googlebot lifts URL-shaped strings straight out of
// inline JS and requests them verbatim, so the old hard-coded prefix produced a
// 404 in the Search Console page-indexing report. Keep every path literal here
// to a real 200 page, and never let the surrounding comment spell one out
// either — this comment used to interpolate the city slug and so recreated the
// exact string it was describing.
const CITY=${JSON.stringify(citySlug)};
const inp=document.getElementById('ckr'),out=document.getElementById('ckr-out');
inp.addEventListener('input',()=>{
  const q=inp.value.trim().toLowerCase();out.innerHTML='';
  if(q.length<2)return;
  IDX.filter(a=>a.n.toLowerCase().includes(q)).slice(0,8).forEach(a=>{
    const li=document.createElement('li');
    // Built as its own value so the only complete path literal left in this
    // source is '/safety/', which is a real 200 page. Anything longer here gets
    // lifted verbatim by Googlebot and requested as-is.
    const href='/safety/'+CITY+'/'+a.s+'/';
    li.innerHTML='<a href="'+href+'"><span>'+a.n+' <small style="color:var(--ink-3)">'+a.b+'</small></span><span class="s">'+a.v+'/100</span></a>';
    out.appendChild(li);
  });
});
</script></body></html>`;
    writeFileSync(join(ROOT, 'safety', citySlug, 'index.html'), html);
  }

  return { citySlug, cfg, count: areas.length, median, ranked, sample: areas[0], noBasemap, windowDays };
}

// ── render all cities, then root + sitemap + robots ──────────────────────────
let urlCount = 0;
const rendered = Object.keys(CITIES).map(renderCity).filter(Boolean);
if (!rendered.length) throw new Error('no cities with data');

{
  const url = `${SITE}/safety/`;
  const rows = rendered.map(r =>
    `<tr><td><a href="/safety/${r.citySlug}/">${esc(r.cfg.hubName)}</a></td><td class="n">${r.count} ${r.cfg.areaWordPlural}</td></tr>`).join('\n');
  const html = `${head('Neighborhood Safety Maps & Crime Data — SafeRoute', 'Data-driven neighborhood safety: crime maps, 0–100 safety indexes, and night-time patterns from official police data. Powered by the SafeRoute crime-aware walking app.', url, null)}${chrome('Safety')}
<p class="eyebrow">SafeRoute safety index</p>
<h1>Neighborhood safety, from official police data</h1>
<p class="lead">The data behind SafeRoute's crime-aware walking routes, published as browsable neighborhood pages: a 0–100 safety index, a crime map, what's reported, and when it happens.</p>
<h2>Cities</h2>
<table class="rank"><tbody>
${rows}
</tbody></table>
<p style="font-size:15px;color:var(--ink-2)">More cities from SafeRoute's 30-city coverage are on the way.</p>
${cta('your city')}
${footer(rendered[0].cfg, rendered[0].sample, rendered[0].citySlug, rendered[0].windowDays)}`;
  mkdirSync(join(ROOT, 'safety'), { recursive: true });
  writeFileSync(join(ROOT, 'safety', 'index.html'), html);
}

{
  // Cross-city search index for the marketing homepage's "look up your
  // neighborhood" box and the /check/ page's reverse link (matching a
  // looked-up point to its published page). Lazy-fetched, so no page-load cost.
  // Terse short keys — la/lo are the centroid, rounded to ~11m — because it
  // ships every area in every city.
  const idx = rendered.flatMap(r => r.ranked.map(a => ({
    n: a.name, s: a.slug, c: r.citySlug, cn: r.cfg.name, v: a.safetyScore, b: a.band,
    la: +a.lat.toFixed(4), lo: +a.lng.toFixed(4),
  })));
  writeFileSync(join(ROOT, 'safety', 'search-index.json'), JSON.stringify(idx));
}

{
  // lastmod tracks the DATA, not the build. Stamping every URL with today's
  // date on each monthly rebuild tells crawlers all 1000+ pages changed when
  // most did not, and Google learns to discount the signal. A page's content is
  // a function of its crime data, so lastmod = first of the month the data runs
  // through; it only moves when the page genuinely changes. Hubs/root take the
  // newest date among their areas.
  const lastmodOf = ym => `${ym || '2026-01'}-01`;
  const newest = dates => dates.slice().sort().pop();
  const cityDate = r => newest(r.ranked.map(a => a.crimeDate).filter(Boolean)) || '2026-01';
  const siteDate = newest(rendered.map(cityDate));
  urlCount = 0;
  const urls = [
    { loc: `${SITE}/`, pri: '1.0', mod: lastmodOf(siteDate) },
    { loc: `${SITE}/safety/`, pri: '0.8', mod: lastmodOf(siteDate) },
    // /transparency/ is generated by its own tool (render-transparency.mjs) but
    // belongs in the one sitemap. Its lastmod comes from the dataset's own
    // generation date rather than the crime feeds', because the page is about
    // when we last MEASURED the feeds, not when they last published.
    // /check/ is hand-written rather than generated, which is exactly why it
    // kept missing from the sitemap — the generator only ever listed what it
    // produced itself. It is a real, indexable page and the homepage's primary
    // call to action, so it belongs here like the other hand-written surfaces.
    ...(existsSync(join(ROOT, 'check', 'index.html'))
      ? [{ loc: `${SITE}/check/`, pri: '0.9', mod: lastmodOf(siteDate) }]
      : []),
    ...(existsSync(join(ROOT, 'tonight', 'index.html'))
      ? [{ loc: `${SITE}/tonight/`, pri: '0.8', mod: lastmodOf(siteDate) }]
      : []),
    ...(existsSync(join(ROOT, 'transparency', 'index.html'))
      ? [{ loc: `${SITE}/transparency/`, pri: '0.8',
           mod: JSON.parse(readFileSync(join(ROOT, 'tools', 'data', 'transparency-index.json'))).generatedAt }]
      : []),
    ...rendered.flatMap(r => [
      { loc: `${SITE}/safety/${r.citySlug}/`, pri: '0.9', mod: lastmodOf(cityDate(r)) },
      ...r.ranked.map(a => ({ loc: `${SITE}/safety/${r.citySlug}/${a.slug}/`, pri: '0.7', mod: lastmodOf(a.crimeDate) })),
    ]),
  ];
  urlCount = urls.length;
  writeFileSync(join(ROOT, 'sitemap.xml'),
    `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` +
    urls.map(u => `<url><loc>${u.loc}</loc><lastmod>${u.mod}</lastmod><priority>${u.pri}</priority></url>`).join('\n') +
    `\n</urlset>\n`);
  if (!existsSync(join(ROOT, 'robots.txt')))
    writeFileSync(join(ROOT, 'robots.txt'), `User-agent: *\nAllow: /\n\nSitemap: ${SITE}/sitemap.xml\n`);
  writeFileSync(join(ROOT, '.nojekyll'), '');
}

console.log(rendered.map(r => `${r.citySlug}: ${r.count} pages (median ${r.median})`).join(' · ') +
  ` · sitemap ${urlCount} urls`);

// Blank maps look like a broken page, so treat widespread absence as a build
// failure rather than publishing them. A handful of gaps is tolerated (an area
// genuinely mid-fetch); more than 10% of a city means something is wrong.
for (const r of rendered) {
  if (!r.noBasemap.length) continue;
  const pct = Math.round(r.noBasemap.length / r.count * 100);
  const msg = `${r.citySlug}: ${r.noBasemap.length}/${r.count} (${pct}%) areas have no basemap — ${r.noBasemap.slice(0, 8).join(', ')}${r.noBasemap.length > 8 ? '…' : ''}`;
  if (pct > 10) { console.error(`FAIL ${msg}`); process.exitCode = 1; }
  else console.warn(`warn ${msg}`);
}
