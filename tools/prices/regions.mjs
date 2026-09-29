// Prices-side facts about each crime-data region: the ONE place that decides
// what the home-prices layer shows there. The rectangles are the backend's
// (tools/data/coverage.json); name, juris (scope rule R2), view, viewName, tz
// and outside are the schools layer's (tools/schools/regions.mjs) and are not
// repeated here. This file adds only:
//
//   sources   the source module(s) (tools/prices/sources/<id>.mjs) whose
//             areas the region shows. The UK has two: England and Wales from
//             ONS, Northern Ireland from LPS/NISRA. A city with recorded sale
//             prices lists its sale source first, then acs-tract, which gives
//             the sales their tract polygons and keeps the tracts outside the
//             sale source's `covers` (tools/prices/lib/sales.mjs).
//             EVERY SOURCE NAMED HERE MUST HAVE ITS MODULE: the build fails on
//             one that does not (a deleted or unwritten module is never a
//             quiet fallback), so a source is added here in the same change
//             as its module, never ahead of it.
//   none      instead of sources: the reason there is NO price data, as the
//             page prints it. Never a guess or a proxy (tools/prices/README.md).
//   currency  ISO 4217. Every source serving the region must publish in it:
//             nothing anywhere converts currencies.
//   scales    the colour-scale keys an area in this region may carry. Default
//             [id]: one city, one scale. The UK splits by ITL1 region (one
//             UK-wide scale would paint London one bright blob); Los Angeles
//             and Long Beach share one because their rectangles overlap. Beside
//             a sale source the first key is the sale prices' and the second
//             is for acs-tract's tracts outside the sale source's covers (a
//             different metric and period, so a different scale): NYC's
//             Nassau and Westchester edges. A region the sale source covers
//             whole needs no second key; the build fails if one is missing.
//
// THE BUILD FAILS if coverage.json has a region with no entry here: a new
// crime city forces a prices decision instead of silently getting none (the
// schools guard, tools/schools/lib/coverage.mjs).

const acs = extra => ({ sources: ['acs-tract'], currency: 'USD', ...extra });
// A city with a recorded-sales source: it first, then acs-tract (see sources).
const sales = (id, scales) => ({ sources: [id, 'acs-tract'], currency: 'USD', ...(scales ? { scales } : {}) });
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
  // Recorded sale prices (phase 2): the five boroughs from the Department of
  // Finance; the rectangle's Nassau and Westchester tracts stay ACS, on their
  // own scale.
  nyc:         sales('nyc-dof-sales', ['nyc', 'nyc-outer']),
  chicago: acs(), sf: acs(), boston: acs(), seattle: acs(), philly: acs(),
  dc:          sales('dc-cama-sales'),
  // Denver stays ACS: its recorded-sales module is PARKED
  // (tools/prices/parked/denver-sales.mjs), not published. The catalog grants
  // CC BY 3.0, but its Terms of Use card also binds users to the denvergov.org
  // terms, whose copyright notice says "Commercial use of the materials is
  // prohibited without the written permission of the City" and forbids
  // mirroring (read live 29 Sep 2026); house rule: commercial use allowed.
  // Once the City confirms in writing, move the module back to sources/ and
  // make this sales('denver-sales', ['denver', 'denver-outer']), with
  // 'denver-outer': 'Counties around Denver' in SCALE_NAMES.
  denver:      acs(), sandiego: acs(),
  longbeach:   acs({ scales: ['la-area'] }),
  la:          acs({ scales: ['la-area'] }),
  dallas:      acs(), detroit: acs(), memphis: acs(),
  // The City of Charlotte's copy of Mecklenburg's last sale of each parcel
  // (CC BY 4.0, re-verified 29 Sep 2026); the rectangle's tracts in the
  // neighbouring counties stay ACS, on their own scale.
  charlotte:   sales('charlotte-sales', ['charlotte', 'charlotte-outer']),
  // SDAT recorded sales (licence re-verified 29 Sep 2026: public domain),
  // covering every Maryland county the rectangle's tracts are in.
  baltimore:   sales('md-sdat-sales'),
  nashville:   acs(), cleveland: acs(), tucson: acs(), fortworth: acs(),
  // Hennepin County's last sale of each parcel (licence waiver re-verified 29
  // Sep 2026); the rectangle's Ramsey and Anoka tracts stay ACS, on their own scale.
  minneapolis: sales('hennepin-sales', ['minneapolis', 'minneapolis-outer']),
  hartford:    sales('ct-opm-sales'),
  kansascity: acs(), houston: acs(), neworleans: acs(), lasvegas: acs(),
  toronto:     statcan,
  vancouver:   statcan,
  // Checked Sept 2026: the only open figures are city-wide (SHF) or loan
  // amounts by alcaldía (CNBV). Neither is a home price for a local area.
  mexicocity:  { none: 'No open data gives home prices for areas smaller than the whole city.' },
};

// Names for scale keys that are not a region id. Any other key is its
// region's own id and takes the region's name. The -outer keys hold the
// acs-tract tracts of a sale-price region outside its sale source's covers.
// An -outer name is printed in the legend's seam note ("<name>:
// owners’ estimates, own scale.") and heads those tracts' panes, so it stays
// at most SEAM_NAME_MAX characters: at 38 ("Adams, Arapahoe and Jefferson
// counties", Sept 2026) the note grew the legend into the zoom control on a
// phone on its side (844x390, tools/audit-viewports.mjs), where 27 ("Counties
// around Mecklenburg") fits. A tract's pane still names its own county.
// Tract counts measured Sept 2026:
// nyc-outer: every NYC-rectangle tract outside the five boroughs is in Nassau
// (36059) or Westchester (36119) — New Jersey is outside R2 (72 and 54).
// charlotte-outer: outside Mecklenburg (37119), in Cabarrus, Union, Gaston,
// Lincoln, Rowan and Iredell (44, 28, 26, 7, 4 and 3).
// minneapolis-outer: outside Hennepin (27053), in Ramsey (27123) and Anoka
// (27003) (15 and 7).
// (denver-outer, while Denver's sales are parked: outside Denver County
// (08031), in Arapahoe (08005), Jefferson (08059) and Adams (08001): 106, 63
// and 34.)
export const SEAM_NAME_MAX = 28;
export const SCALE_NAMES = {
  ...ITL1,
  'la-area': 'Los Angeles area',
  'nyc-outer': 'Nassau and Westchester',
  'charlotte-outer': 'Counties around Mecklenburg',
  'minneapolis-outer': 'Ramsey and Anoka counties',
};

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
    if (d.scales && new Set(d.scales).size !== d.scales.length) p.push(`${id}: a scale key is listed twice`);
  }
  return p;
}

// The scale keys an area of region `id` may carry.
export const scalesFor = (id, table = PRICE_REGIONS) => table[id]?.scales || [id];
