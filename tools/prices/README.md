# Home-prices data: how the Map's Prices layer is built

The Prices layer on `/check/` shades official statistical areas (census tracts,
MSOAs, wards) by their published home-value statistic. It reads
`prices/data/index.json` and adaptive polygon tiles in `prices/data/tiles/`,
which `tools/build-prices.mjs` writes from one module per data source. This
file is the contract those modules implement (enforced in code by
`lib/schema.mjs`). Read it before adding a source or a region.

Contents: [house rules](#house-rules-non-negotiable) · [sources](#sources-phase-1) ·
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

**Mexico City has no source**, by decision: "No open data gives home prices for areas smaller than the whole city." It is listed under `missing` in index.json and the page says so. Not in phase 1 (owner decisions): Land Registry Price Paid Data (Royal Mail address-data clause), Vancouver assessed values (BC Assessment third-party rights), Zillow / Redfin / Realtor.com (licences fail), city recorded-sales feeds (a later phase; one would REPLACE ACS for its whole region, never mix into it).

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
tools/prices/lib/shp.mjs        zero-dependency .shp/.dbf reader (+ Lambert for StatCan)
tools/prices/sources/<id>.mjs   one module per source ("_" files are helpers, never loaded)
tools/prices/test/*.test.mjs    node --test tools/prices/test/*.test.mjs
tools/data/prices/              small vendored lookups only (e.g. ni-ward-crosswalk.json)
prices/data/index.json          published index (generated)
prices/data/tiles/<key>.json    published tiles (generated; the whole prices/data/ dir is replaced on each build)
```

Reused as they are from `tools/schools/lib`: `download.mjs` (makeDownloader; its optional `fetchImpl` is how ctx paces requests), `csv.mjs`, `coverage.mjs`, `tiles.mjs` (cellKey, parseKey), `meta.mjs` (joinAnd), and `unzip` / `xlsx` / `sheetRecords` from `ratings/_us.mjs`.

## Source modules

```js
export default {
  id: 'acs-tract',                       // = the file name; lower-case, starts with a letter
  regions: ['nyc', 'chicago', /* … */],  // coverage ids it serves; regions.mjs must give it each one
  cadence: 'annual',                     // 'annual' | 'semiannual' | 'static' (static: never asked upstream; see cadence)
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
  context: null | { label, value, n },        // e.g. NI's "Median sale price, wider area (… DEA …), 2025" line
  polys: [ [ [[lng, lat], …] /*outer*/, [[lng, lat], …] /*hole*/ ], … ] }   // MultiPolygon, WGS84, full precision
```

A module must: **filter to scope itself** (right country and jurisdiction, extent overlapping the region's rectangle; for the UK all of England, Wales and NI, never Scotland); **throw loudly** on a renamed column or format drift (the orchestrator then snapshots it); and **strip every field not in the contract** at parse (the build also keeps only these fields).

What the build refuses (a contract violation stops the build, exit 1, nothing written): a malformed area; a value ≤ 0; `suppressed` with a value; `uncertain` / `few` / `topcoded` / `bottomcoded` without one; a margin of error with CV > 0.30 that is not flagged `uncertain`; a region that `regions.mjs` does not give the source, or a region `regions.mjs` gives a source that does not list it (that city would silently get nothing); a scale key the region does not allow; two sources, or two jurisdictions, on one scale; a scale with fewer than 5 coloured areas; a currency that differs from the region's.

## ctx

`makeCtx({ rawDir, frozen, log })` (lib/ctx.mjs):

- `ctx.download(file, urls, opts)`: the schools downloader. Cached in `rawDir` (default `$TMPDIR/saferoute-prices-raw`, shared by all sources and runs; `maxAgeH` default 12), with a `<file>.meta.json` provenance sidecar (URL, Last-Modified, ETag, sha256). `urls` is a string, a list tried in order, or an async function returning either.
  - **User agent:** every request sends `SafeRouteBuild/1.0 (+https://safe-route.app; minhaj@safe-route.app)` unless `opts.ua` says otherwise: `ua: null` = Node's default (admin.opendatani.gov.uk refuses ours), a string = that string. A non-default choice is recorded in the provenance as `ua`, so the upstream check asks that host the same way.
  - **Politeness:** requests are paced per host (www.ons.gov.uk 800 ms apart; it 429s past ~15 in 10 s), and a 429/503 is waited out (its Retry-After, up to 2 minutes) and retried up to 4 times. Sources must not add retries on top.
- `ctx.provenance`: what was downloaded (becomes `index.sources[id].upstream`). A source may leave out a file that is only a directory listing it resolves a URL from.
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
[srcIdx, id, nameOrNull, regionIdx, scaleIdx, value|null, moe|null, n|null, flagsBits, ctxIdx|null, polys]
```

- `srcIdx`: index into `Object.keys(index.sources)` (insertion order; source ids never look numeric).
- `regionIdx` into `index.regions`; `scaleIdx` into `index.scales`.
- `flagsBits`: 1 suppressed, 2 uncertain, 4 topcoded, 8 few, 16 bottomcoded (beyond the phase-1 contract's four). **Coloured** = value is not null and no bit of 1 | 2 | 8 | 16 is set (top-coded is coloured, in the top class).
- `ctxIdx` into the tile's own `c` (`{ label, value, n }`).
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

These are annual and semi-annual statistics, so the monthly run does not refetch by habit. For each source (`tools/build-prices.mjs`):

1. `--only <ids>`: fetch exactly those; every other source re-emits its snapshot.
2. `--refresh <ids|all>`: fetch those whatever upstream says.
3. Nothing published yet: fetch.
4. **Its inputs changed**: fetch (from the raw cache where it can, so this works with `--frozen` too). `sources[id].inputs` fingerprints what the areas are made from besides upstream data: the module file, its vendored lookups (`tools/data/prices/<id>*`), the rectangle, jurisdictions, decision, currency and scale keys of every region it serves, and `PIPELINE` in build-prices.mjs, **bumped by hand** whenever shared code changes what a fetched area becomes (lib/geo.mjs, lib/schema.mjs `prepareAreas`, lib/shp.mjs, a tools/schools reader). A code, lookup or coverage change therefore reaches the map without a `--refresh`.
5. `--frozen`: no network, so no upstream check: snapshot.
6. `cadence: 'static'` (the 2021 Census): never asked; only `--refresh` fetches it.
7. Otherwise ask upstream. The module's `probe(ctx, prevMeta)`, if it has one, may report `{ changed: true, vintage }` (a new release at a NEW URL, which no check of the old files can see; acs-tract's asks for the next year's tables AND its tract boundaries, as its fetch needs both). Then each recorded upstream file is asked, with the user agent it was fetched with: a HEAD (retried once) for its ETag, else Last-Modified; where a host refuses HEAD (OpenDataNI's storage: 403) or answers without either, a GET of its first byte (`Range: bytes=0-0`); where there is still neither and the file is small (NISRA's 22 KB PxStat metadata), the file itself, compared by sha256. Pages of one ArcGIS layer share an ETag and are asked once. A different validator, a 404/410 or different bytes means changed; all the same means unchanged → **snapshot, tiles byte-identical**. A file whose host cannot be reached at all is counted unchanged, with a warning (a network blip is not a reason to download hundreds of megabytes). If some file still cannot tell, the source is fetched, and if every downloaded file is byte-identical (sha256) to the ones behind the current tiles (and the inputs are the same), the fetched areas are discarded and the snapshot kept.

**A suspicious fetch is a failed one.** A fetch that keeps no area in scope (a swapped lng/lat), has no areas for a region it serves that had some, or loses more than 10% of the areas published without `--refresh` is treated like a throw. `--refresh` accepts a smaller set, never an emptied region.

**No churn.** When every source reuses its snapshot and the result is the published index (but for its `generated` date) over byte-identical tiles, the build keeps the published `generated` date, so a month in which nothing changed commits nothing. (The first no-op month after a fetch still commits once: each source's `status` goes from `fetched` to `snapshot`.)

A **snapshot** re-emits the source's areas from the current tiles with their encoded rings untouched (byte-identical rows) and keeps the meta, vintage, provenance, inputs and dropped-stats **it was published with**: the period and attribution belong to that data, not to whatever the module says now. A source that **fails** does the same with a `::warning::`. Its status is `snapshot-after-failure` (verify WARNs "stale", and /check/ tells readers its latest update could not be used) only when something newer was known to be out: a changed upstream, a `--refresh`, or nothing published. A speculative fetch that fails (upstream could not say, or only the inputs changed) keeps plain `snapshot`. R2 still applies to snapshot areas (a moved rectangle or decision drops them).

A build killed part-way leaves `prices/data.staging-<pid>` or `prices/data.old-<pid>`; the next build removes them (restoring `.old-<pid>` if it holds the only copy of the output), and `/prices/data.*` is git-ignored.

## verify-prices.mjs

Gates the commit; any FAIL exits 1.

- **Structure**: fields = the contract; every listed leaf exists, no strays, leaves disjoint; every row index resolves; every area touches each leaf it is in, is in **every** leaf its bbox touches, and is identical in each; split thresholds hold (above them only at the minimum cell).
- **Honesty**: no value ≤ 0; suppressed has no value; nothing neutral is coloured (n below `colourMinN`, CV > 0.30, suppressed/uncertain/few/bottomcoded flags); every source's meta complete, licence linked, metric honest; each scale one source / currency / jurisdiction with 4 strictly increasing breaks that its own areas reproduce; each region's area count and jurisdiction names match its tiles; no address-type field in any tile; no price for a `none` region, which is listed under `missing`.
- **Scope R2**: each area's jurisdiction (via its scale) is a home jurisdiction of its region, its bbox reaches the region's rectangle, and the rectangles equal coverage.json.
- **Nothing lost** vs git HEAD's index.json (or `--prev`): a source, a region's areas from a source, or a colour scale the previous build had and `regions.mjs` still gives FAILs, even under `--refresh`.
- **Drift** vs the same: ±10% areas per source and per region, ±15% per-scale median, unless `--refresh` names the source.
- **Size**: FAIL above 60 KB gzipped per tile, WARN above 30 KB.
- **Spot checks** (each prints what it saw): Southwark has more than 30 MSOAs; London's median of MSOA medians is £400k–£900k; NYC has more than 1,500 tracts; Toronto more than 400 CTs. A source missing from the build fails its check. `--no-spot` skips them (tests on fake data).
- **Bands** (WARN only): each scale's five colour bands hold 5–45% of its coloured areas (tied or bunched values can leave one all but empty).

## Commands

```sh
node tools/prices/run-source.mjs acs-tract [--frozen]     # one source, printed, nothing written
node tools/build-prices.mjs                               # monthly: upstream-checked
node tools/build-prices.mjs --refresh acs-tract           # take a new vintage deliberately
node tools/build-prices.mjs --frozen --refresh all        # rebuild everything from the raw cache (reproducible)
node tools/build-prices.mjs --out /tmp/prices-test        # any output dir (tests never write prices/data)
node tools/verify-prices.mjs [--refresh acs-tract]
node tools/prices/probe-hosts.mjs                         # which hosts answer, one GET each
node --test tools/prices/test/*.test.mjs                 # the glob: Node 24 will not take the bare directory
```

## Adding a source (checklist)

1. Licence first: official, open, commercial use allowed; exact attribution lines; an https licence link.
2. Write `tools/prices/sources/<id>.mjs` to the contract above. Throw on any column rename or format change; never fall back to a guess.
3. Give it its regions in `regions.mjs` (a better source for a city REPLACES the old one for the whole region: one scale, one source).
4. `node tools/prices/run-source.mjs <id>` until it reports "OK: every area meets the contract", with sensible counts per region and breaks per scale.
5. Add a spot check to verify-prices for something you know to be true, and its host(s) to `KNOWN` in probe-hosts.mjs.
6. Build, verify, then look at the areas on `/check/?prices` in each region it serves.

## Workflows

- `.github/workflows/rebuild-prices.yml`: monthly (`41 5 5 * *`, after the safety pages on the 2nd and schools on the 4th). Build → `verify-prices --reference-optional` → `sync-site-facts` (fills `data-fact="prices-where"`) → scoped `git add prices/ check/index.html tools/data/prices/` (never `-A`) → commit → push with a 3× rebase retry. Dispatch input `refresh`: source ids or `all`.
- `.github/workflows/probe-price-hosts.yml`: dispatch only; runs `tools/prices/probe-hosts.mjs` and writes a table to the run summary. Run it before relying on the monthly job from GitHub's runners.
