# Home-prices data: how the Map's Prices layer is built

The Prices layer on `/check/` shades official statistical areas (census tracts,
MSOAs, wards) by their published home-value statistic. It reads
`prices/data/index.json` and adaptive polygon tiles in `prices/data/tiles/`,
which `tools/build-prices.mjs` writes from one module per data source. This
file is the contract those modules implement (enforced in code by
`lib/schema.mjs`). Read it before adding a source or a region.

Contents: [house rules](#house-rules-non-negotiable) · [sources](#sources-phase-1) ·
[sale prices](#sale-prices-kind-point-sales-phase-2) ·
[pipeline](#pipeline) · [files](#files) · [source modules](#source-modules) · [ctx](#ctx) ·
[scope R2](#scope-r2-and-regionsmjs) · [geometry](#geometry) · [tiles](#tiles) ·
[scales](#colour-scales) · [index.json](#indexjson-v1) · [cadence and snapshots](#cadence-and-the-snapshot-rule) ·
[verify](#verify-pricesmjs) · [commands](#commands) · [adding a source](#adding-a-source-checklist) ·
[workflows](#workflows)

## House rules (non-negotiable)

1. **Official open data only, every claim true.** Every source carries its licence, a link to the licence, and the publisher's exact attribution lines. The pane and the address report print them for every area; while a source's areas are on the map the legend credits it ("Data: ONS, HM Land Registry, OS", `meta.credit`) with a link to the full lines of every source.
2. **Name the metric exactly.** A sale-price median is "Median price paid" / "Median sale price". ACS and StatCan values are "Median home value (owners' estimate)". Never call an owners' estimate a price, and never say "average" for a median. (`lib/schema.mjs` `metricProblems` refuses both.)
3. **Show the period and the count**, with each source's noun ("sales", "owner-occupied homes", "owner households"). A count that is itself a survey estimate (ACS B25003, the census's owner households: `meta.nEstimate`) is labelled as one, never as the sample a figure is "based on". Wording that covers both kinds of figure says "home values"; "home prices" only where the figure is a sale price.
4. **Suppress, never guess.** A withheld value (flag `suppressed`) is the neutral "no figure" fill; a null with no flag (nothing published at all: an ACS jam value, a StatCan blank) is not drawn, though the tiles keep the area so the address report can say "no … is published" for it (`stats.unpublished`; the page's `prDrawn`). Per source:
   - ONS: `[x]` rows (fewer than 5 sales) are suppressed. Areas with n < 10 (`colourMinN`) are not coloured: neutral, with the value and "only N sales" in the pane.
   - NI: a ward with no median (LPS: fewer than 30 eligible sales) is neutral; the pane gives the DEA median as a clearly labelled "wider area" context line.
   - ACS: -666666666 or null is not drawn. A CV (MOE / 1.645 / value) above 0.30 is "too uncertain to colour": neutral, value ± MOE in the pane. The top code (2,000,001) prints as "$2,000,000 or more" and takes the top class. The bottom code (9,999) is flagged `bottomcoded`: it prints as "Less than $10,000" and is neutral.
   - StatCan: flags x / F / .. or null: neutral or not drawn.
   - Recorded sales (kind `point-sales`): a tract with fewer than **3** sales has no figure at all, not even in the pane (`suppressed`, n kept), so a single sale's price is never shown as a "median"; fewer than **10** (`colourMinN`) is shown but not coloured. See [sale prices](#sale-prices-kind-point-sales-phase-2).
5. **Never compare across countries or cities.** One colour scale per scale region, city-relative quintile breaks computed at build time. No cross-region legend, rank, "most expensive" list or national average. Price never sits next to the safety score as if the two were related.
6. **No user data leaves the site.** Static tiles on our own host; the page never calls a price provider.
7. **Raw downloads never go into the repo.** They go through `ctx.download` into the OS temp dir. Only derived tiles, `index.json` and small vendored lookups (`tools/data/prices/`) are committed.
8. **A failed source never empties a region.** It re-emits its areas from the current tiles (`status: 'snapshot-after-failure'`, with a `::warning::`). A fetch that looks wrong (nothing in scope, an emptied city, a tenth of the areas gone unasked) counts as failed.
9. **Out of scope:** religion, ethnicity or any demographic field. An area carries only value, moe, n, flags and an optional context line. No address, postcode, paon, saon or street field ever reaches a tile.

## Sources (phase 1)

| source id | serves | metric | geography | vintage | licence |
|---|---|---|---|---|---|
| `ons-msoa` | uk (England + Wales) | Median price paid | MSOA 2021 (7,264), BGC polygons | 12 months to Mar 2026 | OGL v3 |
| `ni-ward` | uk (Northern Ireland) | Median sale price | NI electoral wards (462, OSNI 2012) | calendar year 2025 | OGL v3 |
| `acs-tract` | the 26 US cities | Median home value (owners' estimate) | 2020 census tracts, TIGER `cb_2024_SS_tract_500k` | ACS 2020–2024 5-year, B25077 (+ B25003) | US public domain |
| `statcan-ct` | toronto, vancouver | Median home value (owners' estimate) | 2021 census tracts | 2021 Census | Statistics Canada Open Licence |

**Mexico City has no source**, by decision: "No open data gives home prices for areas smaller than the whole city." It is listed under `missing` in index.json and the page says so. Not in phase 1 (owner decisions): Land Registry Price Paid Data (Royal Mail address-data clause), Vancouver assessed values (BC Assessment third-party rights), Zillow / Redfin / Realtor.com (licences fail). City recorded-sales feeds came in phase 2 (below): inside the area a sale feed covers it REPLACES ACS tract for tract, and the ACS tracts left in its region get their own colour scale, never mixed into the sale prices'.

## Sale prices (kind `point-sales`, phase 2)

| source id | serves | data | licence |
|---|---|---|---|
| `nyc-dof-sales` | nyc (the five boroughs) | NYC Dept of Finance Rolling / Annualized Sales, lots located through PLUTO | NYC Open Data (Local Law 11 of 2012) |
| `dc-cama-sales` | dc | DC Tax System Property Sales (CAMA), qualified sales, joined by SSL | CC BY 4.0 |
| `ct-opm-sales` | hartford | CT OPM Real Estate Sales (data.ct.gov `5mzw-sjtu`) | public domain |
| `md-sdat-sales` | baltimore (Baltimore City and the county tracts in the rectangle) | SDAT sales segments, opendata.maryland.gov `ed4q-f8tm`, MDP parcel points | public domain (re-verified 29 Sep 2026) |
| `denver-sales` — **PARKED**, not in the build (`tools/prices/parked/`); Denver shows ACS | would serve denver (Denver County, 08031; the rectangle's Adams, Arapahoe and Jefferson tracts ACS on `denver-outer`) | Real Property Sales and Transfers (Denver Open Data Catalog, services1.arcgis.com), warranty and special-warranty deeds, joined PARID = SCHEDNUM to the Parcels layer's centroids | CC BY 3.0 from the catalog, BUT the same Terms of Use card binds users to the denvergov.org website terms, whose Copyright Notice forbids mirroring the information "to another server without permission" and says "Commercial use of the materials is prohibited without the written permission of the City" (read live 29 Sep 2026), and each item carries an indemnity. Not "commercial use allowed" until the City confirms in writing |
| `charlotte-sales` | charlotte (Mecklenburg, 37119; the neighbouring counties' tracts stay ACS on `charlotte-outer`) | City of Charlotte Parcel Look Up (the county's LAST sale of each parcel) placed in the City's Parcels polygons, gis.charlottenc.gov | CC BY 4.0 (re-verified 29 Sep 2026) |
| `hennepin-sales` | minneapolis (Hennepin, 27053; the rectangle's Ramsey and Anoka tracts stay ACS on `minneapolis-outer`) | Hennepin County Parcels (the LAST sale of each parcel, by MONTH of sale) at the county's parcel centroids, gis.hennepin.us | licensing waived (Board Resolution 14-0036; re-verified 29 Sep 2026) |

NYC keeps DOF's own floor for one-to-three-family homes ($200,000, the heading of its citywide summary of those sales) as well as SPEC2's $10,000 for every sale: at $10,000 alone, a two-family house at $10,000 and another at $25,000 set one Brooklyn tract's median. Maryland also drops a portfolio split evenly over properties bought separately (three or more sales in one jurisdiction on one day at one uneven price).

**Last sale per parcel.** Charlotte's and Hennepin's tables are parcel records, not transaction logs: each keeps only the newest sale of a parcel. A parcel sold twice in the window counts once, at its later price, and a sale followed by any later transfer is invisible, so the older months of a window are under-counted. One snapshot cannot measure it, and comparing a window with the year before it is no bound (a change in the market's volume moves it too): in Sept 2026 the older year held about 3% fewer kept sales in Mecklenburg, 9% fewer across Hennepin County and 1% more in the Minneapolis tracts, where closings fell about 4% over the same years. Denver's full transfers table (the parked `denver-sales`) is a stand-in: there a last-sale feed would hide about 9% of a 12-month window's sales (12–14% of its oldest months) and raise tract medians slightly (median +1.5%, 90th percentile +7%), since what it loses is often a quick resale's first, lower, price. Both sources' notes say so (a few percent, perhaps up to about one in ten; figures may lean slightly high), and both use 12 months, not 24, to keep it small. Charlotte's table carries no arm's-length flag (Mecklenburg's own sales layer has one, but is not openly licensed), and Hennepin only its assessor's ratio-study exclusion (which it drops), so each keeps warranty and special-warranty deeds (Hennepin: warranty deeds and contracts for deed) at $10,000 or more, and says so; Hennepin's notes also give the size of the "other" deeds it leaves out (about one in eight home sales, which the county did not exclude). Hennepin dates a sale by month only (the 1st of it); each measures its own last complete month (`through`) from the data, because each feed posts a month's sales late.

**Parked sources.** A finished sale module whose licence is not yet clean waits in `tools/prices/parked/` with its tests (which import it from there): the build loads only `sources/`, and `regions.mjs` keeps the city on ACS. `denver-sales` is parked so (see its header for the steps back); it also drops the first of two sales of one home within 30 days (a double closing through a middleman, `quickResale`), which a full transfers log shows and a last-sale feed hides by construction.

**How a sale source joins a city.** `regions.mjs` names it for the region in the same change as its module, and the build FAILS on any source `regions.mjs` names that has no module (unless `--partial`, for tests): a deleted or never-written module never quietly falls back to ACS. So Baltimore lists `md-sdat-sales` because its module exists and its licence was re-verified; had it not been, Baltimore would have stayed `acs()` in `regions.mjs`. The reverse is refused too: a module serving a region that `regions.mjs` does not give it.

A sale source returns **individual arm's-length residential sales as points**, and nothing else. The orchestrator (`lib/sales.mjs`, the same code for every city) turns them into tract figures, so no two sale sources can window, place, round or suppress differently, and no source writes a figure of its own:

```js
export default {
  id: 'nyc-dof-sales', kind: 'point-sales', regions: ['nyc'], cadence: 'monthly',
  geometry: 'acs-tract',                  // its sales are placed in THIS source's tract polygons, same regions
  meta: { name, publisher, url, licence, licenceUrl, attribution, credit?,
          metric: 'Median sale price',    // must name a sale price
          unitNoun: 'sales', currency: 'USD',
          window: { months: 12,           // 12 or 24, chosen from measured coverage (below)
                    by: 'sale',           // REQUIRED: 'sale' (date of sale) or 'recording' (date the deed was recorded)
                    lagMonths: 0 },       // the source's documented recording lag, in months (default 0)
          colourMinN: 10,                 // at least 10
          notes: ['the exact filters, in plain words', …] },
          // period and areaNoun are NOT given: the build fills them (see below)
  async fetch(ctx) {
    return {
      covers: { juris: ['US-NY'], counties: ['36005', '36047', '36061', '36081', '36085'] },
      sales: [{ lat, lng, price, date: 'YYYY-MM-DD', type }],   // build-time only; never reaches a tile
      dropped: { nonArmsLength: 812, nonResidential: 4033, noLocation: 57, … },   // every row the source read and left out, by reason (0s included)
      through: '2026-08',   // optional: the last complete month by the publisher's own statement
    };
  },
};
```

- **`covers`** is where the source is AUTHORITATIVE, and must be where its sales are COMPLETE: `juris` (ISO 3166-2), optionally narrowed to `counties` (5-digit state+county FIPS, matched against the first five digits of the tract GEOID). Every geometry tract inside it becomes a sale tract, with 0 sales if none were returned, so a source that downloads only some towns must not cover the others.
- **Filters are the source's** (SPEC2 §C), each stated in `meta.notes` in plain words and counted in `dropped`: residential only (say which classes or codes), arm's-length only (the publisher's own qualified / arm's-length flag where one exists; for NYC, transfers under $10,000, one-to-three-family homes under DOF's own $200,000 floor for them, and one price repeated across several lots of one sale), a location only from a published coordinate or an official join (never geocoded, never guessed), and the date the window is by. A malformed sale (no lat/lng, price ≤ 0, a date that is not a real YYYY-MM-DD) is a contract violation: filter it in the source and count it. "Every row" means every row the source READ: a source that queries by place (Maryland's, outside Baltimore City) never sees, so cannot count, the sales there that have no location, and says so in its header.
- **Window**: `meta.window.months` months ending at the latest COMPLETE month in the data (the data runs past it, or has a sale on its last day, or `through` says so; a `through` later than the newest sale's month says nothing about that month, which is then judged by the data alone), pushed back `lagMonths`. A sale dated after the build day is a typo and is dropped (`futureDate`). Prefer 12 months unless that leaves more than 30% of covered tracts under 10 sales. The build writes the `period` ("Sales recorded Sep 2025 – Aug 2026", or "Sales dated …" for a window by date of sale), `meta.window.from / to / span`, and the `vintage` (`2025-09..2026-08`).
- **Placing**: point-in-polygon into the geometry source's tracts **as they ship** (the encoded, 8 m simplified rings), in id order, so a sale counts where the page's own point-in-polygon would put it. A sale in no tract is dropped (`outsideTracts`), one in a tract outside `covers` too (`outsideCovers`).
- **Figures**: per tract n, the median, and the 25th / 75th percentiles (linear interpolation), each **rounded to the nearest 1,000**. `value` is the median, `moe` null, `iqr` `[p25, p75]` (the pane's "Middle half"). **Privacy: n < 3 → no figure at all** (`suppressed`, no value, no middle half, even in the pane; n kept, as a count reveals no price); n = 0 with no context line → nothing published (not drawn, like an ACS jam value). The middle half only from `colourMinN` sales (on fewer it spans only a few sales). n < `colourMinN` → `few` (shown, not coloured). The build adds this rule to the source's notes (`privacyNote`) unless a note already states it ("at least 3 sales"). What the rule promises is how many sales a figure rests on, and no more: with an odd count the median IS one sale's price (rounded to the 1,000, and a round price stays exact), so no note, comment or page may say that no single sale's price is ever published.
- **Context**: every sale tract carries the geometry source's own figure as its context line, `{ label: 'Median home value (owners’ estimate), 2020–24 survey' (acs-tract meta.contextLabel: the metric, named), value, moe, flags }` (flags: topcoded / bottomcoded / uncertain, so it prints "$2,000,000 or more", with the survey's caveat). It is the reading where a tract has too few sales. It is never coloured and never enters a sale-price scale. The pane and the report credit it: the geometry source's attribution lines follow the sale source's wherever a context line is shown.
- **Precedence**: in a region whose `sources` (regions.mjs) list a sale source and it has tracts, those tracts REPLACE the same tract ids from the geometry source. The geometry source keeps the region's other tracts, moved to the region's **second scale key** (`nyc-outer`, named in `SCALE_NAMES`: "Nassau and Westchester"), so one scale is still one source, one metric, one period. A leftover tract in a region with no second key stops the build. A geometry tract INSIDE the covers that the sale source does not show (the sale source re-emitted its snapshot, from before a new tract vintage or a moved rectangle, in a month its fetch failed) is left off the map and counted (`stats.dropped.awaitingSaleSource`, with a `::warning::`), never shown as an owners' estimate on the sale-price scale; the geometry source is then fetched again on the next build, so the tract is handed over once the sale source is back. Where no sale source has tracts (never published, or `--partial` without its module), the geometry source keeps the whole region on its first key, as in phase 1. `index.sources[geometry].stats.replaced` counts the tracts handed over.
- **Snapshots**: a sale source re-emits its tract rows like any source. A geometry source re-emitting its snapshot no longer holds the tracts a sale source showed, so the sale source's refetch places its sales in its geometry source's snapshot tracts plus its own published tracts (same polygons, old context line). When the geometry source's data changes (a new ACS vintage), the sale source's `inputs` change too and it is re-aggregated. A fetch that places no sale (a swapped lng/lat), or, unasked, fewer than half the sales behind the published figures, is refused like a failure.
- **Stats**: `sources[id].stats.dropped` holds the source's reasons and the build's (`futureDate`, `outOfWindow`, `outsideTracts`, `outsideCovers`); `stats.sales = { received, used }`, where received = used + the build's drops, and used = the sum of the tracts' n. verify checks both.

The page: the legend reads "Median sale price · Sales recorded Sep 2025 – Aug 2026" (NYC's "Sales dated …", its window being by date of sale; the months never split across its two lines), and its hatch "No figure, or fewer than 10 sales"; the report reads "$845,000 — median sale price, from 412 sales recorded Sep 2025 – Aug 2026."; the pane adds a "Middle half of sales: $610,000 – $1,150,000" row and prints the context line with its ± margin of error, not in bold beside a sale median (every range's dash is read as "to"). Where the kinds of figure meet (New York City beside Nassau and Westchester) the owners'-estimate tracts are outlined dashed on the map, the legend's seam line carries the same dashed swatch by the words for that side ("Nassau and Westchester: owners’ estimates, own scale." / "Owners’ estimates here; New York City: sale prices, own scale."; one line of the wide legend, so it fits a phone on its side; on an upright phone, whose legend drops its metric line, the one-line "Owners’ estimates, own scale." by the swatch), the hover line names each figure's kind, a Nassau or Westchester tract's pane is headed "Nassau and Westchester", and a change of kind under the centre is announced once. "Here the map shows home values in New York State only, not New Jersey." counts a park or cemetery tract with nothing published as the city's own ground, not as bare map. "Colours restart at the … boundary." stays where only the scale changes.

## Pipeline

```
tools/data/coverage.json ─┐   (backend covers() rectangles, shared with schools)
tools/schools/regions.mjs ┤   (name, home jurisdictions, view, tz, outside)
tools/prices/regions.mjs ─┤   (per region: sources or none+reason, currency, scale keys)
                          ▼
sources/<id>.mjs ── fetch(ctx) ─► { vintage, areas } ─┐
   … on failure, or upstream unchanged: areas from the current tiles (snapshot)
                                                      ▼
      validate (lib/schema.mjs) → R2 scope → few-flag (colourMinN) → dedupe
                                                      ▼
      geometry: simplify 8 m → drop specks → orient → quantize 1e-5° → encode
                                                      ▼
sources/<sales>.mjs ── fetch(ctx) ─► { covers, sales, dropped } ─┐   (after every areas source)
      window → place in the geometry source's tracts → n / median / middle half,
      rounded, n < 3 withheld → ACS context line (lib/sales.mjs)
                                                      ▼
      precedence: sale tracts replace the geometry source's inside covers;
      its tracts left in the region move to the second scale key
                                                      ▼
      colour scales: quintile breaks per scale region (lib/scale.mjs)
                                                      ▼
      adaptive polygon tiles + index.json v1 (lib/tiles.mjs, atomic write)
                                                      ▼
      verify-prices.mjs gates the commit
```

## Files

```
tools/build-prices.mjs          orchestrator (knows no country)
tools/verify-prices.mjs         the commit gate
tools/prices/regions.mjs        per coverage region: sources | none + reason, currency, scale keys; ITL1 names; SCOPE_NOTE
tools/prices/run-source.mjs     dev runner for one source (prints stats + 3 samples; writes nothing)
tools/prices/probe-hosts.mjs    one polite GET per upstream host (probe-price-hosts.yml)
tools/prices/lib/ctx.mjs        makeCtx(): the ctx every source gets; politeFetch; loadRegions
tools/prices/lib/schema.mjs     the contract in code: FIELDS, flags, meta + area checks, loadSources, prepareAreas
tools/prices/lib/geo.mjs        simplify, orient, quantize, encode/decode, bbox, pointInPolygon
tools/prices/lib/scale.mjs      quintile breaks (2 sig figs, strictly increasing), classOf
tools/prices/lib/tiles.mjs      polygon tiling (schools cellKey/parseKey), tile JSON, atomic write, snapshot reader
tools/prices/lib/sales.mjs      kind point-sales: window, point-in-polygon, figures, privacy, context (buildSaleAreas)
tools/prices/lib/shp.mjs        zero-dependency .shp/.dbf reader (+ Lambert for StatCan)
tools/prices/sources/<id>.mjs   one module per source ("_" files are helpers, never loaded)
tools/prices/parked/<id>.mjs    a finished module the build does not load (licence pending; see "Parked sources")
tools/prices/test/*.test.mjs    node --test tools/prices/test/*.test.mjs
tools/data/prices/              small vendored lookups only (e.g. ni-ward-crosswalk.json)
prices/data/index.json          published index (generated)
prices/data/tiles/<key>.json    published tiles (generated; the whole prices/data/ dir is replaced on each build)
```

Reused as they are from `tools/schools/lib`: `download.mjs` (makeDownloader; its optional `fetchImpl` is how ctx paces requests), `csv.mjs`, `coverage.mjs`, `tiles.mjs` (cellKey, parseKey), `meta.mjs` (joinAnd), and `unzip` / `xlsx` / `sheetRecords` from `ratings/_us.mjs`.

## Source modules

Two kinds: `kind: 'areas'` (the default: the source publishes a figure per area, as below) and `kind: 'point-sales'` (individual sales the build aggregates; [sale prices](#sale-prices-kind-point-sales-phase-2)).

```js
export default {
  id: 'acs-tract',                       // = the file name; lower-case, starts with a letter
  regions: ['nyc', 'chicago', /* … */],  // coverage ids it serves; regions.mjs must give it each one
  cadence: 'annual',                     // 'annual' | 'semiannual' | 'monthly' | 'static' (see cadence)
  meta: {
    name, publisher,
    url,                                 // landing page
    licence, licenceUrl,                 // licenceUrl must be https: the pane links it
    attribution: ['…'],                  // the publisher's exact lines, printed verbatim
    metric: 'Median home value (owners’ estimate)',   // exact label; legend + pane
    unitNoun: 'owner-occupied homes',    // the noun for n
    currency: 'USD',                     // ISO 4217; must equal every served region's currency
    period: '2020–2024 (5-year survey)', // human period label
    notes: ['…'],                        // plain-language caveats for the pane
    areaNoun: 'census tract',
    colourMinN: null,                    // e.g. 10: an area with n below it is flagged few (neutral) by the build
    // optional:
    credit: 'U.S. Census Bureau',        // short credit for the map's legend (default: publisher)
    nEstimate: true,                     // n is a survey estimate of the area's homes, not the figure's sample
    licences: [{ licence, licenceUrl }], // further licences an attribution line names (linked there too)
    contextLabel: 'Median home value (owners’ estimate), 2020–24 survey',  // how this figure is labelled as a sale tract's context line
  },
  async fetch(ctx) { return { vintage: '2020-2024', areas: [/* … */] }; },
  async probe(ctx, prevMeta) { return { changed: false, vintage: null }; },   // optional, see cadence
};
```

Each area:

```js
{ id: '36047011300',                          // stable official code (string)
  name: 'Census Tract 113, Kings County, NY', // official name as published, or null; never invented
  region: 'nyc',                              // coverage id
  juris: 'US-NY',                             // ISO 3166-2 (R2 uses it)
  scale: 'nyc',                               // scale key: one of regions.mjs scalesFor(region)
  value: 845000 | null,                       // currency units
  moe: 52300 | null,                          // 90% margin of error, if published
  n: 1240 | null,                             // count: sales behind the figure, or (nEstimate) the area's homes
  flags: [],                                  // any of 'suppressed', 'uncertain', 'topcoded', 'few', 'bottomcoded'
  context: null | { label, value, moe?, n, flags? },  // e.g. NI's "Median sale price, wider area (… DEA …), 2025" line;
                                              // flags: any of uncertain / topcoded / bottomcoded, about the context's own figure
  iqr: null | [p25, p75],                     // a sale-price area's middle half (the build computes it; never a source's)
  polys: [ [ [[lng, lat], …] /*outer*/, [[lng, lat], …] /*hole*/ ], … ] }   // MultiPolygon, WGS84, full precision
```

Only these fields reach `index.sources[id]`: the meta fields above (`lib/schema.mjs` `META_KEYS`), what the build adds (`ENTRY_BUILD_KEYS`), upstream records of `UPSTREAM_KEYS` and counts of `STATS_KEYS` (`entryProblems`). A module that adds anything else to its meta, even at fetch time, stops the build: a sample of sales under an innocent name must never reach the published index.

A module must: **filter to scope itself** (right country and jurisdiction, extent overlapping the region's rectangle; for the UK all of England, Wales and NI, never Scotland); **throw loudly** on a renamed column or format drift (the orchestrator then snapshots it); and **strip every field not in the contract** at parse (the build also keeps only these fields).

What the build refuses (a contract violation stops the build, exit 1, nothing written): a malformed area; a value ≤ 0; `suppressed` with a value; `uncertain` / `few` / `topcoded` / `bottomcoded` without one; a margin of error with CV > 0.30 that is not flagged `uncertain`; a region that `regions.mjs` does not give the source, or a region `regions.mjs` gives a source that does not list it (that city would silently get nothing); **a source `regions.mjs` names that has no module** (unless `--partial`: a deleted or unwritten module is never a quiet fallback, so a source joins `regions.mjs` in the same change as its module); a scale key the region does not allow; two sources, or two jurisdictions, on one scale; a scale with fewer than 5 coloured areas; a currency that differs from the region's; a source entry with a field `lib/schema.mjs` does not list, a sale source's note that reads like a single sale's detail (an exact price, a parcel number of 9+ digits or of 8+ capitals and digits, a day of sale), an upstream record whose `url` query or `where` names parcels (a run of 9+ digits, a quoted parcel code, an `IN (...)` list of codes) or that merges queries (`queries`) under one query's URL, a drop reason that is not a camelCase word, or `covers` codes that are not ISO 3166-2 / 5-digit FIPS; for a sale source, a malformed sale, a geometry source that does not serve its regions, two sale sources in one region, or a tract left to the geometry source in a region with no second scale key.

## ctx

`makeCtx({ rawDir, frozen, log })` (lib/ctx.mjs):

- `ctx.download(file, urls, opts)`: the schools downloader. Cached in `rawDir` (default `$TMPDIR/saferoute-prices-raw`, shared by all sources and runs; `maxAgeH` default 12), with a `<file>.meta.json` provenance sidecar (URL, Last-Modified, ETag, sha256). `urls` is a string, a list tried in order, or an async function returning either.
  - **User agent:** every request sends `SafeRouteBuild/1.0 (+https://safe-route.app; minhaj@safe-route.app)` unless `opts.ua` says otherwise: `ua: null` = Node's default (admin.opendatani.gov.uk refuses ours), a string = that string. A non-default choice is recorded in the provenance as `ua`, so the upstream check asks that host the same way.
  - **Politeness:** requests are paced per host (www.ons.gov.uk 800 ms apart; it 429s past ~15 in 10 s), and a 429/503 is waited out (its Retry-After, up to 2 minutes) and retried up to 4 times. Sources must not add retries on top.
- `ctx.provenance`: what was downloaded (becomes `index.sources[id].upstream`). A source may leave out a file that is only a directory listing it resolves a URL from.
- `ctx.discard(file)`: forget a cached file that failed the source's format check (a firewall's block page served with HTTP 200), so the next run downloads it afresh instead of reading it from the cache until its `maxAgeH` runs out. Call it before throwing. `--frozen` never changes the cache.
- `ctx.log`, `ctx.warn`, `ctx.frozen`, `ctx.rawDir`, `ctx.UA`.
- `ctx.coverage`: `[{ id, country, bbox: [s, w, n, e] }]` in the backend's order.
- `ctx.regions`: `{ id: { name, juris, outside, view, viewName, tz, country, bbox, sources | none, currency, scales } }`.
- `ctx.inBox(bbox, lat, lng)`.
- `ctx.readers`: `{ parseCsv, records, columns, unzip, xlsx, sheetRecords, shp }` (`shp` is the lib/shp.mjs module: `readShapefile`, `readDbf`, …).

## Scope R2 and regions.mjs

An area is on the map only inside a crime-coverage rectangle **and** in that region's own jurisdiction (from the source's own code, never from geometry), exactly as for schools: New Jersey tracts never enter New York's scale. The build drops out-of-scope areas (`stats.dropped.outsideScope`); an area crossing the rectangle's edge is kept and drawn whole.

`regions.mjs` gives every coverage region either `sources: [...]` (+ `currency`, optional `scales`) or `none: '<reason as printed>'`. **The build fails if coverage.json gains a region with no decision.** Scale keys: the region's id by default; the UK uses ITL1 codes (`TLC` … `TLL`, `TLN` Northern Ireland; no `TLM`, Scotland being outside R2); Los Angeles and Long Beach share `la-area` because their rectangles overlap.

## Geometry

Per ring (lib/geo.mjs): Douglas-Peucker at **8 m** in local metres; drop rings with fewer than 3 distinct corners or under **200 m²** (an outer ring takes its holes with it); holes kept; outer rings counter-clockwise, holes clockwise; quantize to **1e-5°**. An area left with no ring is dropped (`dropped.noGeometry`).

**Encoding.** Each ring is one flat integer array: the first point absolute `[lat*1e5, lng*1e5]`, then `[dlat, dlng]` deltas. Rings are stored **open** (the first point is not repeated). Note the order: lat first.

```js
function decodeRing(a) {            // -> [[lat, lng], ...] for Leaflet
  const out = []; let la = 0, lg = 0;
  for (let i = 0; i < a.length; i += 2) { la += a[i]; lg += a[i + 1]; out.push([la / 1e5, lg / 1e5]); }
  return out;
}
```

`pointInPolygon` (even-odd over all rings of a polygon) is what the address report uses; holes and islands in holes come out right.

## Tiles

Keys are the schools keys (`206_-1` at 0.25°, `q412_-2` at 0.125°, `qq825_-3` at 0.0625°; `tools/schools/lib/tiles.mjs`). Base 0.25°; a cell is split into quadrants while it holds more than **350 areas or 45 KB of JSON**, down to **0.0625°**. **An area is in every leaf its bbox touches**; the page loads the leaves under the view (padded 10%) and dedupes by `src:id`.

Tile file: `{ "a": [row, …], "c": [context, …] }`. A row, in `index.fields` order:

```
[srcIdx, id, nameOrNull, regionIdx, scaleIdx, value|null, moe|null, n|null, flagsBits, ctxIdx|null, polys, iqr|null]
```

`iqr` (a sale-price area's `[p25, p75]`) was added after the first release, at the end of the row: every reader resolves fields by name, and the snapshot reader takes an older tile set that lacks it (read as null; `ADDED_FIELDS` in lib/schema.mjs). A context in `c` is `{ label, value, n }` plus `moe` and `flags` (bits, as a row's) only when it has them.

- `srcIdx`: index into `Object.keys(index.sources)` (insertion order; source ids never look numeric).
- `regionIdx` into `index.regions`; `scaleIdx` into `index.scales`.
- `flagsBits`: 1 suppressed, 2 uncertain, 4 topcoded, 8 few, 16 bottomcoded (beyond the phase-1 contract's four). **Coloured** = value is not null and no bit of 1 | 2 | 8 | 16 is set (top-coded is coloured, in the top class).
- `ctxIdx` into the tile's own `c` (`{ label, value, n, moe?, flags? }`).
- `polys`: `[[outerRing, hole, …], …]` encoded rings.
- An area's jurisdiction is not in the row: its scale's `juris` gives it (one scale region lies in one jurisdiction).

Rows are sorted by (source, id): the same inputs give byte-identical files.

## Colour scales

One per scale region (lib/scale.mjs): breaks are the 20/40/60/80th percentiles (linear interpolation) of the **coloured** areas' values, one area one vote, rounded to 2 significant figures and forced strictly increasing (a collision is raised one unit in its own 2nd figure). Class of a value: 0 below `breaks[0]`, k when `breaks[k-1] ≤ v < breaks[k]`, 4 at or above `breaks[3]`. **Invariant: one scale region = one source = one metric = one period = one currency = one jurisdiction.**

## index.json (v1)

```json
{ "version": 1, "generated": "2026-09-29",
  "fields": ["src","id","name","region","scale","value","moe","n","flags","ctx","polys"],
  "tiles": { "base": 0.25, "split": { "maxAreas": 350, "maxBytes": 46080, "minCell": 0.0625 }, "cells": ["…leaf keys…"] },
  "minZoom": 11,
  "regions": [{ "id": "nyc", "name": "New York City", "country": "us", "currency": "USD", "sources": ["acs-tract"],
                "view": [[s, w], [n, e]], "viewName": "Midtown Manhattan", "tz": "…", "bbox": [s, w, n, e],
                "juris": ["US-NY"], "outside": ["New Jersey"], "areas": 2450 }],
  "juris": { "US-NY": { "name": "New York", "area": "New York State" }, … },
  "scales": [{ "key": "nyc", "name": "New York City", "source": "acs-tract", "metric": "…", "period": "…",
               "currency": "USD", "juris": "US-NY", "breaks": [4 numbers], "min": …, "max": …, "median": …, "areas": N }],
  "sources": { "acs-tract": { …meta, "cadence": "annual", "regions": [...], "vintage": "2020-2024",
               "status": "fetched | snapshot | snapshot-after-failure", "fetched": "2026-09-28",
               "upstream": [{ "file", "url", "lastModified", "etag", "sha256", "bytes", "fetchedAt", "ua"? }],
               "inputs": "16 hex: the module, its lookups, its regions, the pipeline",
               "stats": { "areas": …, "coloured": …, "neutral": …, "unpublished": …, "dropped": { "outsideScope": …, "rings": … } } } },
  "missing": [{ "region": "mexicocity", "name": "Mexico City", "reason": "No open data gives home prices for areas smaller than the whole city.",
               "bbox": [s, w, n, e], "tz": "…" }],
  "where": "England, Wales and Northern Ireland; 26 US cities; Toronto and Vancouver",
  "scope": "…R2 sentence (regions.mjs SCOPE_NOTE)…" }
```

`stats.neutral` counts every uncoloured area; `stats.unpublished` is the part of it with no value and no flag (nothing published, nothing withheld), which the page does not draw but the report still names. Only regions and sources with areas appear; `regions[].areas` is for verify's per-city drift check; `juris` names each region's own jurisdictions for the map's "Here the map shows home values in New York State only, not New Jersey." A `missing` entry carries its coverage rectangle, so the page can say which covered city it is over, and its time zones, so a visitor from there is told why the layer starts elsewhere. `scales[].median` exists for verify's drift check, not for display (house rule 5). `where` is derived from the areas actually built; `tools/sync-site-facts.mjs` copies it into `data-fact="prices-where"`.

## Cadence and the snapshot rule

The areas sources are annual and semi-annual statistics, so the monthly run does not refetch them by habit; sale sources are `monthly`. For each source (`tools/build-prices.mjs`; the areas sources run first, then the sale sources, which need their geometry source's tracts):

1. `--only <ids>`: fetch exactly those; every other source re-emits its snapshot.
2. `--refresh <ids|all>`: fetch those whatever upstream says.
3. Nothing published yet: fetch.
4. **Its inputs changed**: fetch (from the raw cache where it can, so this works with `--frozen` too). `sources[id].inputs` fingerprints what the areas are made from besides upstream data: the module file, its vendored lookups (`tools/data/prices/<id>*`), the rectangle, jurisdictions, decision, currency and scale keys of every region it serves, and `PIPELINE` in build-prices.mjs, **bumped by hand** whenever shared code changes what a fetched area becomes (lib/geo.mjs, lib/schema.mjs `prepareAreas`, lib/shp.mjs, a tools/schools reader). A code, lookup or coverage change therefore reaches the map without a `--refresh`.
5. `--frozen`: no network, so no upstream check: snapshot.
6. `cadence: 'static'` (the 2021 Census): never asked; only `--refresh` fetches it.
7. `cadence: 'monthly'` (the sale feeds): fetched every run. Their window moves with the data, and their query endpoints rarely carry a validator worth asking; a failed fetch is a missed update (`snapshot-after-failure`), and identical bytes with identical inputs still keep the snapshot byte-identical. A sale source's `inputs` also cover what its geometry source's areas were made from.
8. Otherwise ask upstream. The module's `probe(ctx, prevMeta)`, if it has one, may report `{ changed: true, vintage }` (a new release at a NEW URL, which no check of the old files can see; acs-tract's asks for the next year's tables AND its tract boundaries, as its fetch needs both). Then each recorded upstream file is asked, with the user agent it was fetched with: a HEAD (retried once) for its ETag, else Last-Modified; where a host refuses HEAD (OpenDataNI's storage: 403) or answers without either, a GET of its first byte (`Range: bytes=0-0`); where there is still neither and the file is small (NISRA's 22 KB PxStat metadata), the file itself, compared by sha256. Pages of one ArcGIS layer share an ETag and are asked once. A different validator, a 404/410 or different bytes means changed; all the same means unchanged → **snapshot, tiles byte-identical**. A file whose host cannot be reached at all is counted unchanged, with a warning (a network blip is not a reason to download hundreds of megabytes). If some file still cannot tell, the source is fetched, and if every downloaded file is byte-identical (sha256) to the ones behind the current tiles (and the inputs are the same), the fetched areas are discarded and the snapshot kept.

**A suspicious fetch is a failed one.** A fetch that keeps no area in scope (a swapped lng/lat), has no areas for a region it serves that had some, or loses more than 10% of the areas published without `--refresh` is treated like a throw. `--refresh` accepts a smaller set, never an emptied region.

**No churn.** When every source reuses its snapshot and the result is the published index (but for its `generated` date) over byte-identical tiles, the build keeps the published `generated` date, so a month in which nothing changed commits nothing. (The first no-op month after a fetch still commits once: each source's `status` goes from `fetched` to `snapshot`.)

A **snapshot** re-emits the source's areas from the current tiles with their encoded rings untouched (byte-identical rows) and keeps the meta, vintage, provenance, inputs and dropped-stats **it was published with**: the period and attribution belong to that data, not to whatever the module says now. A source that **fails** does the same with a `::warning::`. Its status is `snapshot-after-failure` (verify WARNs "stale", and /check/ tells readers its latest update could not be used) only when something newer was known to be out: a changed upstream, a `--refresh`, or nothing published. A speculative fetch that fails (upstream could not say, or only the inputs changed) keeps plain `snapshot`, except for a `monthly` sale feed: it always has a newer month out, so its failure is always `snapshot-after-failure`, whatever else changed (else a module edit or a new ACS vintage would hide the notice for the rest of the outage). R2 still applies to snapshot areas (a moved rectangle or decision drops them).

A build killed part-way leaves `prices/data.staging-<pid>` or `prices/data.old-<pid>`; the next build removes them (restoring `.old-<pid>` if it holds the only copy of the output), and `/prices/data.*` is git-ignored.

## verify-prices.mjs

Gates the commit; any FAIL exits 1.

- **Structure**: fields = the contract; every listed leaf exists, no strays, leaves disjoint; every row index resolves; every area touches each leaf it is in, is in **every** leaf its bbox touches, and is identical in each; split thresholds hold (above them only at the minimum cell).
- **Source fields**: every `index.sources[id]` holds only the fields `lib/schema.mjs` lists, at every depth (`entryProblems`: meta, build fields, upstream records, counts), with no sale-level field name anywhere but `stats.sales` (the counts), and no parcel in an upstream record's query, a drop reason, `covers` or a sale source's notes (the same checks as the build's).
- **Honesty**: no value ≤ 0; suppressed has no value; nothing neutral is coloured (n below `colourMinN`, CV > 0.30, suppressed/uncertain/few/bottomcoded flags); every source's meta complete, licence linked, metric honest; each scale one source / metric / currency / jurisdiction with 4 strictly increasing breaks that its own areas reproduce; each region's area count and jurisdiction names match its tiles; no address-type or sale-level field (location, date, price, parcel id) in any tile and no day-precise date; no price for a `none` region, which is listed under `missing`.
- **Sale prices** (each point-sales source): nothing coloured under 10 sales, no figure under 3 (nor a middle half, nor any flag but suppressed), figures and middle halves to the 1,000, the middle half only from `colourMinN` and around the median, no margin of error, ids are tract GEOIDs, a tract's name is that census tract's official name (its number is the GEOID's) or null, the context line is the geometry source's own figure under the geometry source's own `contextLabel`; every sale received is placed or counted (`received = used + futureDate + outOfWindow + outsideTracts + outsideCovers`) and the tracts' n add up to `used`; **precedence**: no tract shown by both sources, only the sale source's tracts inside its covers (on the region's first key), only the geometry source's outside them (on its second).
- **Scope R2**: each area's jurisdiction (via its scale) is a home jurisdiction of its region, its bbox reaches the region's rectangle, and the rectangles equal coverage.json.
- **Nothing lost** vs git HEAD's index.json (or `--prev`): a source, a region's areas from a source, or a colour scale the previous build had and `regions.mjs` still gives FAILs, even under `--refresh`. A geometry source whose every tract in a city is now shown by a sale source placed on it (all of DC) has handed the city over, not lost it.
- **Drift** vs the same: ±10% areas per source and per region, ±15% per-scale median, unless `--refresh` names the source. A geometry source counts its tracts plus those handed to sale sources (`stats.replaced`); a scale whose source changed (ACS to sales) is not compared, and the PASS line says so.
- **Size**: FAIL above 60 KB gzipped per tile, WARN above 30 KB.
- **Spot checks** (each prints what it saw): Southwark has more than 30 MSOAs; London's median of MSOA medians is £400k–£900k; NYC has more than 1,500 tracts (whichever source shows them); Toronto more than 400 CTs; `nyc-dof-sales` more than 1,500 tracts and Manhattan's median of coloured tract medians $700k–$3M; `dc-cama-sales` more than 150 tracts; `ct-opm-sales` more than 50 (SPEC2 said 100, but the Hartford rectangle holds only 65 tracts); `md-sdat-sales` more than 150; `charlotte-sales` more than 265 COLOURED tracts (of 305 in Mecklenburg; the build emits every covered tract, so a count of tracts could never fail) and a median of coloured tract medians $280k–$700k; `hennepin-sales` more than 120 coloured (of 144 in Hennepin) and $220k–$550k; the parked `denver-sales` more than 150 coloured (of 175) and $350k–$900k. A phase-1 source missing from the build fails its check; a sale source's check is SKIPPED (printed as SKIP) only while that source is not in the build. `--no-spot` skips them all (tests on fake data).
- **Bands** (WARN only): each scale's five colour bands hold 5–45% of its coloured areas (tied or bunched values can leave one all but empty).

## Commands

```sh
node tools/prices/run-source.mjs acs-tract [--frozen]     # one source, printed, nothing written
node tools/build-prices.mjs                               # monthly: upstream-checked
node tools/build-prices.mjs --refresh acs-tract           # take a new vintage deliberately
node tools/build-prices.mjs --frozen --refresh all        # rebuild everything from the raw cache (reproducible)
node tools/build-prices.mjs --out /tmp/prices-test        # any output dir (tests never write prices/data)
node tools/build-prices.mjs --partial --sources <dir>     # build without modules regions.mjs names but <dir> lacks (tests)
node tools/prices/run-source.mjs nyc-dof-sales            # a sale source: its window, drops, n >= 10 coverage at 12 and 24 months
node tools/verify-prices.mjs [--refresh acs-tract]
node tools/prices/probe-hosts.mjs                         # which hosts answer, one GET each
node --test tools/prices/test/*.test.mjs                 # the glob: Node 24 will not take the bare directory
```

## Adding a source (checklist)

1. Licence first: official, open, commercial use allowed; exact attribution lines; an https licence link.
2. Write `tools/prices/sources/<id>.mjs` to the contract above. Throw on any column rename or format change; never fall back to a guess.
3. Give it its regions in `regions.mjs` in the same change as the module (the build fails on a named source with no module). A better source for a city REPLACES the old one: for a whole region, or, for a sale source, tract for tract inside its `covers`, the rest of the region keeping the old source on the region's second scale key.
4. `node tools/prices/run-source.mjs <id>` until it reports "OK: every area meets the contract", with sensible counts per region and breaks per scale.
5. Add a spot check to verify-prices for something you know to be true, and its host(s) to `KNOWN` in probe-hosts.mjs.
6. Build, verify, then look at the areas on `/check/?prices` in each region it serves.

## Workflows

- `.github/workflows/rebuild-prices.yml`: monthly (`41 5 5 * *`, after the safety pages on the 2nd and schools on the 4th). Build → `verify-prices --reference-optional` → `sync-site-facts` (fills `data-fact="prices-where"`) → scoped `git add prices/ check/index.html tools/data/prices/` (never `-A`) → commit → push with a 3× rebase retry. Dispatch input `refresh`: source ids or `all`.
- `.github/workflows/probe-price-hosts.yml`: dispatch only; runs `tools/prices/probe-hosts.mjs` and writes a table to the run summary. Run it before relying on the monthly job from GitHub's runners.
