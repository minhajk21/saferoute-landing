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
  'philly': {
    name: 'Philadelphia',
    hubName: 'Philadelphia',
    rankPool: 'Philadelphia neighborhoods',
    // Multi-district city (like NYC/DC/Toronto/Seattle): the city's 158 published
    // neighbourhoods — minus six with no residents — grouped under the 18 PCPC
    // Planning Districts, so the hub ranks within each district. No rankHeading.
    areaWord: 'neighborhood', areaWordPlural: 'neighborhoods',
    centre: 'center', centreLabel: 'neighborhood center',
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
  sf: 'sf', seattle: 'seattle', toronto: 'toronto', dc: 'dc', boston: 'boston', philly: 'philly' };
// Region ids with a live tonight layer — drives the hub strip. NOLA is live but
// has no SEO hub; SF joins this list the day its layer ships.
const TONIGHT_REGIONS = new Set(['neworleans']);
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
  if (bm && (bm.land?.length || bm.water?.length)) {
    ground = bm.land?.length
      ? `<rect width="${W}" height="${H}" fill="#D7E3E8"/><path d="${path(bm.land, true)}" fill="#F7F3E8" fill-rule="evenodd"/>`
      : `<rect width="${W}" height="${H}" fill="#F7F3E8"/><path d="${path(bm.water, true)}" fill="#D7E3E8" fill-rule="evenodd"/>`;
    ground +=
      (bm.parks?.length ? `<path d="${path(bm.parks, true)}" fill="#E4EDDA" fill-rule="evenodd"/>` : '') +
      (bm.stMinor?.length ? `<path d="${path(bm.stMinor)}" fill="none" stroke="#DCD3BF" stroke-width="1"/>` : '') +
      (bm.stMajor?.length ? `<path d="${path(bm.stMajor)}" fill="none" stroke="#C9BC9F" stroke-width="1.8"/>` : '');
    streetLabels = (bm.labels || [])
      .filter(l => l.x >= 24 && l.x <= W - 24 && l.y >= 20 && l.y <= H - 20)
      .map(l =>
        `<text x="${l.x}" y="${l.y}" transform="rotate(${l.a} ${l.x} ${l.y})" text-anchor="middle" dy="-3" font-family="IBM Plex Mono,monospace" font-size="9.5" fill="#7D7666" stroke="#F7F3E8" stroke-width="3" paint-order="stroke">${esc(l.t)}</text>`).join('');
  }

  return `<svg viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Map of reported crime locations within ${a.radiusMetres} metres of the ${cfg.centre} of ${esc(a.name)}, over the local street network">
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
function todSVG(a) {
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
  return `<svg viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="When reported incidents happen in ${esc(a.name)}: severity-weighted share by time of day, weekdays versus weekends">${out}</svg>`;
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
    pct <= 0.25 ? `${a.name} sits at the safer end of ${cfg.hubName} by reported crime.`
    : pct <= 0.60 ? `${a.name} shows a typical level of reported crime ${cfg.forCity}.`
    : pct <= 0.85 ? `${a.name} records more reported crime than most ${cfg.name} ${cfg.areaWordPlural}.`
    : `${a.name} records a high level of reported crime ${cfg.forCity}.`;

  const cmp = Math.abs(diff) <= 3
    ? `right at the ${cfg.medianLabel} of ${median}`
    : `${Math.abs(diff)} points ${diff > 0 ? 'above' : 'below'} the ${cfg.medianLabel} of ${median}`;

  // State the span alongside the count wherever the feed reports one: "3,228
  // incidents ... over the 7 months to August 2026" is a claim a reader can
  // actually judge, where the bare count plus an end date was not.
  const span = windowPhrase(windowDays);
  const period = span ? `over ${span} to ${monthName(a.crimeDate)}` : `(data through ${monthName(a.crimeDate)})`;
  const lead = `${bandLead} Its SafeRoute safety index is <strong>${a.safetyScore} out of 100</strong> — ${cmp}, ranking ${ord(rank)} of ${count} ${cfg.rankPool} — based on ${fmt(a.totalIncidents)} incidents ${cfg.reportedTo} within 1 km of the ${cfg.areaWord} ${cfg.centre} ${period}.`;

  let mix = '';
  if (top) {
    const violent = ['violent-crime', 'robbery', 'sexual-offences', 'possession-of-weapons'].includes(top.category);
    mix = violent
      ? `The largest reported category here is <strong>${catName(top.category).toLowerCase()}</strong> (${topShare}% of reports) — worth taking seriously when walking at night; the full mix is broken down below.`
      : `Most of what's reported here is property-related — <strong>${catName(top.category).toLowerCase()}</strong> alone is ${topShare}% of reports — rather than violence against strangers, though the full mix below is worth a look.`;
  }

  let when = '';
  if (night != null) {
    const nightPct = Math.round(night * 100), evePct = Math.round(evening * 100);
    when = night >= 0.30
      ? `Timing matters here: about ${nightPct}% of severity-weighted incidents are reported overnight (midnight–6 a.m.), so route choice late at night matters more than the headline number suggests.`
      : night <= 0.15
        ? `Reported incidents here skew to daytime and evening hours — only about ${nightPct}% of severity-weighted reports fall overnight (midnight–6 a.m.).`
        : `Incidents spread across the day here — roughly ${evePct}% of severity-weighted reports come in the evening (6 p.m.–midnight) and ${nightPct}% overnight.`;
  }

  const neighbors = (g.neighbors || []).map(s => bySlug.get(s)).filter(Boolean);

  const faq = [
    {
      q: `Is ${a.name} safe at night?`,
      a: night != null
        ? `${bandWord[a.band]} overall (safety index ${a.safetyScore}/100). About ${Math.round((night + evening) * 100)}% of severity-weighted incidents in ${a.name} are reported between 6 p.m. and 6 a.m. ${a.band === 'low' ? `Reported crime is low ${cfg.forCity}, but stick to lit, busier streets late.` : 'At night, prefer lit, busier streets — a block or two of detour often avoids the clusters on the map above.'}`
        : `${bandWord[a.band]} overall (safety index ${a.safetyScore}/100). ${a.band === 'low' ? `Reported crime is low ${cfg.forCity}, but stick to lit, busier streets late.` : 'At night, prefer lit, busier streets — a short detour often avoids the clusters on the map above.'}`,
    },
    {
      q: `What is the most common crime in ${a.name}?`,
      a: top
        ? `${catName(top.category)} — ${fmt(top.count)} of ${fmt(a.totalIncidents)} incidents (${topShare}%) reported within 1 km of the ${cfg.areaWord} ${cfg.centre} ${span ? `over ${span} to` : 'through'} ${monthName(a.crimeDate)}.`
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
<meta property="og:type" content="article">
<meta property="og:url" content="${canonical}">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600&family=IBM+Plex+Sans:wght@400;500;600;700&display=swap" rel="stylesheet">
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
<p><strong>About this data.</strong> Figures are incidents <em>reported</em> to police within 1&nbsp;km of each ${cfg.areaWord}'s ${cfg.centre} — reporting practices vary and not all crime is reported. This is informational only and not a guarantee of safety, a prediction, or a judgment of any community. Use it the way the app does: to pick better-lit, lower-incident routes and times.</p>
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
  const areas = readdirSync(cacheDir).filter(f => f.endsWith('.json'))
    .map(f => JSON.parse(readFileSync(join(cacheDir, f))));
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
      ? ` Reports cluster toward the ${shape.dirWord} of the map — the area immediately around the ${cfg.centreLabel} is comparatively quiet.`
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
    const desc = `${a.name} safety index: ${a.safetyScore}/100 (${bandWord[a.band].toLowerCase()}) — ${fmt(a.totalIncidents)} reported incidents within 1 km (through ${monthName(a.crimeDate)}). Crime map, what's reported, and how it compares ${cfg.acrossCity}.`;
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
<div class="tod">${todSVG(a)}</div>
<p style="font-size:14px;color:var(--ink-3);margin-top:8px">Severity-weighted share of reported incidents by time of day, from ${cfg.dataName === 'NYPD data' ? 'NYPD incident timestamps' : 'police incident timestamps'}.</p>
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
<figcaption>${fmt(a.totalIncidents)} incidents reported within 1 km of the ${esc(a.name)} ${cfg.centre}${(a.incidents || []).length < a.totalIncidents ? ` (${fmt((a.incidents || []).length)} shown)` : ''} · ${cfg.dataName} through ${monthName(a.crimeDate)}${bm ? ` · ${cfg.basemapCredit}` : ''}.${clusterNote}</figcaption>
</figure>
<a class="checkmap" href="/check/?lat=${a.lat}&lng=${a.lng}&name=${encodeURIComponent(a.name)}"><span class="dot"></span>Open ${esc(a.name)} on the live interactive map →</a>

<div class="grid2">
<section>
<h2>What's reported here</h2>
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
<p style="font-size:15px;color:var(--ink-2)">More cities from SafeRoute's 30-city coverage (Vancouver, Denver, Mexico City…) are on the way.</p>
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
