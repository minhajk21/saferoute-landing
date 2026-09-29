// Prices-side facts about each crime-data region: the ONE place that decides
// what the home-prices layer shows there. The rectangles are the backend's
// (tools/data/coverage.json); name, juris (scope rule R2), view, viewName, tz
// and outside are the schools layer's (tools/schools/regions.mjs) and are not
// repeated here. This file adds only:
//
//   sources   the source module(s) (tools/prices/sources/<id>.mjs) whose
//             areas the region shows. The UK has two: England and Wales from
//             ONS, Northern Ireland from LPS/NISRA.
//   none      instead of sources: the reason there is NO price data, as the
//             page prints it. Never a guess or a proxy (tools/prices/README.md).
//   currency  ISO 4217. Every source serving the region must publish in it:
//             nothing anywhere converts currencies.
//   scales    the colour-scale keys an area in this region may carry. Default
//             [id]: one city, one scale. The UK splits by ITL1 region (one
//             UK-wide scale would paint London one bright blob); Los Angeles
//             and Long Beach share one because their rectangles overlap.
//
// THE BUILD FAILS if coverage.json has a region with no entry here: a new
// crime city forces a prices decision instead of silently getting none (the
// schools guard, tools/schools/lib/coverage.mjs).

const acs = extra => ({ sources: ['acs-tract'], currency: 'USD', ...extra });
const statcan = { sources: ['statcan-ct'], currency: 'CAD' };

// ITL1 regions (ONS International Territorial Levels), as the legend names
// them. TLM (Scotland) is absent on purpose: Scotland is outside R2.
export const ITL1 = {
  TLC: 'North East England', TLD: 'North West England', TLE: 'Yorkshire and the Humber',
  TLF: 'East Midlands', TLG: 'West Midlands', TLH: 'East of England', TLI: 'London',
  TLJ: 'South East England', TLK: 'South West England', TLL: 'Wales', TLN: 'Northern Ireland',
};

export const PRICE_REGIONS = {
  uk:          { sources: ['ons-msoa', 'ni-ward'], currency: 'GBP', scales: Object.keys(ITL1) },
  nyc:         acs(), chicago: acs(), sf: acs(), boston: acs(), seattle: acs(), philly: acs(),
  dc:          acs(), denver: acs(), sandiego: acs(),
  longbeach:   acs({ scales: ['la-area'] }),
  la:          acs({ scales: ['la-area'] }),
  dallas:      acs(), detroit: acs(), baltimore: acs(), memphis: acs(), charlotte: acs(),
  nashville:   acs(), minneapolis: acs(), cleveland: acs(), tucson: acs(), fortworth: acs(),
  hartford:    acs(), kansascity: acs(), houston: acs(), neworleans: acs(), lasvegas: acs(),
  toronto:     statcan,
  vancouver:   statcan,
  // Checked Sept 2026: the only open figures are city-wide (SHF) or loan
  // amounts by alcaldía (CNBV). Neither is a home price for a local area.
  mexicocity:  { none: 'No open data gives home prices for areas smaller than the whole city.' },
};

// Names for scale keys that are not a region id. Any other key is its
// region's own id and takes the region's name.
export const SCALE_NAMES = { ...ITL1, 'la-area': 'Los Angeles area' };

// What scope rule R2 means for a reader of the sources list on /check/
// (index.json `scope`). True by construction: sources keep only areas of the
// region's own jurisdictions whose extent overlaps its rectangle, and an area
// is always drawn whole.
export const SCOPE_NOTE = 'Outside the UK, each city’s home values cover the official areas that overlap the same rectangle as the city’s ' +
  'crime data, and only in the city’s own state or province, so a city’s map can include neighbouring towns in that state. ' +
  'Areas at the edge of the rectangle are shown whole. In the UK they cover England, Wales and Northern Ireland; Scotland is not included.';

// The decision problems for a list of coverage regions (ids), '' when clean.
// A region needs exactly one of `sources` (non-empty) or `none` (a reason).
export function decisionProblems(ids, table = PRICE_REGIONS) {
  const p = [];
  for (const id of ids) {
    const d = table[id];
    if (!d) { p.push(`${id}: no prices decision in tools/prices/regions.mjs (a source, or none with a reason)`); continue; }
    const hasSrc = Array.isArray(d.sources) && d.sources.length > 0;
    if (hasSrc === !!d.none) p.push(`${id}: give exactly one of sources [...] or none: '<reason>'`);
    if (d.none && typeof d.none !== 'string') p.push(`${id}: none must be the reason, as the page prints it`);
    if (hasSrc && !/^[A-Z]{3}$/.test(d.currency || '')) p.push(`${id}: currency must be an ISO 4217 code`);
    for (const s of d.scales || []) if (!/^[A-Za-z][A-Za-z0-9-]*$/.test(s)) p.push(`${id}: bad scale key "${s}"`);
  }
  return p;
}

// The scale keys an area of region `id` may carry.
export const scalesFor = (id, table = PRICE_REGIONS) => table[id]?.scales || [id];
