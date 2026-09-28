# Schools data: how the Map's Schools layer is built

The Schools layer on `/check/` reads adaptive tiles from `schools/data/tiles/`.
`tools/build-schools.mjs` writes them from one module per data source. This file
is the contract those modules implement. Read it before adding a country, a
source or a rating.

Contents: [pipeline](#pipeline) · [files](#files) · [row schema v2](#the-row-schema-v2) ·
[source modules](#source-modules) · [schemes](#rating-schemes-how-a-pane-words-a-rating) ·
[ratings modules](#ratings-modules-us-state-rating-maps) · [filters](#filters) ·
[scope R2](#scope-r2-coverage-regions-jurisdictions) · [tiles](#tiles-and-the-snapshot-rule) ·
[index.json](#indexjson-v2) · [verify](#verify-schoolsmjs) · [commands](#commands) ·
[adding a source](#adding-a-source-checklist) · [the page](#the-page-checkindexhtml)

## House rules (non-negotiable)

- **Official open data only, and every claim true.** Every source carries its licence and an attribution line; the pane prints it for every school.
- **Pin colour is stage only** (Nursery / Primary / Secondary / Not published). Hollow = private. No rating is ever read by the marker code.
- **A rating is text in the pane, in its own system's words**, with its year, source and link. It is never a colour, filter, sort, count, legend or "top schools" list, and never compared across states or countries. If a system publishes nothing usable, the pane says so plainly.
- **Private schools never carry a public-school rating value.**
- **Religion is never a field, a filter or a colour.** Strip religious columns at parse. Management types (NI) and board names (Ontario) are governance: shown in the pane, never filtered or coloured.
- **A school with no published location is counted and dropped, never guessed** onto a centroid.
- **Raw downloads never go into the repo** (the monthly page job commits with `git add -A`). They go through `ctx.download`, which caches under the OS temp dir.
- **A failed source can never empty a country**: it re-emits its rows from the current tiles.

## Pipeline

```
tools/data/coverage.json ─┐   (backend covers() rectangles; lib/coverage-from-backend.mjs)
tools/schools/regions.mjs ┤   (per region: home jurisdictions, start view)
                          ▼
sources/<id>.mjs  ── fetch(ctx) ─► v2 rows ─┐
   … on failure / not due: rows from the current tiles (snapshot)
                                            ▼
ratings maps (tools/data/schools/ratings/<scheme>.json) ─► merged by row id
                                            ▼
                 validate (lib/schema.mjs rowProblems) → scope R2 → dedupe (src,id)
                                            ▼
             adaptive tiles + index.json v2  (lib/tiles.mjs, atomic write)
                                            ▼
                         tools/verify-schools.mjs  (gates the commit)
```

## Files

| Path | What |
|---|---|
| `tools/build-schools.mjs` | Orchestrator. Knows no country. |
| `tools/verify-schools.mjs` | Completeness, drift, scope, honesty invariants, size, position. |
| `tools/schools/sources/<id>.mjs` | One module per source. Files starting `_` are helpers or templates and are never loaded. |
| `sources/gias.mjs` (+ `_ofsted.mjs`) | England & Wales: GIAS register, Ofsted MI. Monthly. |
| `sources/de.mjs` (+ `_de-schoolsplus.mjs`, `_de-eti.mjs`, `_de-xlsx.mjs`) | Northern Ireland: DE Schools Plus register, school census, available places; incremental ETI report crawl. Monthly. |
| `sources/ccd.mjs`, `sources/pss.mjs` (+ `_nces.mjs`) | US public (NCES CCD + EDGE ArcGIS layer) and private (PSS) schools, 26 cities. Annual. |
| `sources/on-sif.mjs` (annual), `sources/on-priv.mjs` (monthly) | Toronto: Ontario SIF table; private school location + contact lists. `on-sif.mjs` also exports the Canadian helpers (incl. an xlsx reader). |
| `sources/bc.mjs` | Vancouver: BC K-12 schools list + enrolment by grade. Monthly. |
| `sources/sep.mjs` | Mexico City: SEP CNCT 2025 + Formato 911 (datos.gob.mx). Annual. Exports `displayCase`, the Spanish title-case rule the page uses. |
| `tools/schools/sources/_template.mjs` | Copy this to start a source. |
| `tools/schools/ratings/<scheme>.mjs` | One module per US state rating scheme (18; `_us.mjs` is their shared helper: zip, xlsx, CCD state ids, joins). `_template.mjs` to start. |
| `tools/schools/ratings.mjs` | Runner that builds one rating map by hand. |
| `tools/schools/probe-hosts.mjs` | Phase 0: one request per upstream host with the build's own user agent; run from GitHub's runner by `.github/workflows/probe-school-hosts.yml` (dispatch only). |
| `tools/schools/regions.mjs` | Region id → name, home jurisdictions (R2), start view, time zones. |
| `tools/schools/juris.mjs` | Every ISO 3166-2 jurisdiction a row may carry, with its name. Pre-filled for every planned place. |
| `tools/schools/filters.mjs` | The optional filters (gender, boarding, charter). |
| `tools/schools/lib/schema.mjs` | `FIELDS` (v2), `EMPTY`, `toRow`/`fromRow`, `rowProblems`. |
| `tools/schools/lib/stage.mjs` | Every stage crosswalk (§3 of the design): `giasStage`, `niStage`, `usPublicStage`, `usPrivateStage`, `ontarioStage`, `bcStage`, `mxStage`. |
| `tools/schools/lib/tiles.mjs` | Adaptive tiling, keys, stats, atomic write, `readRowsFromTiles` (the snapshot reader). |
| `tools/schools/lib/coverage.mjs` | `loadCoverage()` and the R2 helper `regionFor(lat, lng, juris)`. |
| `tools/schools/lib/coverage-from-backend.mjs` | Regenerates `tools/data/coverage.json` from `saferoute-backend/src/providers`, and proves it against the real `covers()`. |
| `tools/schools/lib/csv.mjs` | Quote-aware parser for any separator and encoding (`parseCsv`, `records`, `columns`). |
| `tools/schools/lib/download.mjs` | Cached downloader with provenance sidecars and per-host user agents. |
| `tools/schools/lib/osgb.mjs` | OSGB36 grid → WGS84 (GIAS). |
| `tools/schools/lib/meta.mjs` | `where` phrase and the filters list, derived from the build. |
| `tools/schools/test/*.test.mjs` | `node --test tools/schools/test/*.test.mjs` |
| `tools/data/coverage.json` | Generated; committed. |
| `tools/data/schools/ratings/*.json` | Rating maps; committed. |
| `tools/data/schools/ni/ni-coords.json`, `eti-reports.json` | Northern Ireland: vendored DE OGL school points (with the 3 withheld and why) and the first full ETI crawl. Rebuilt only by hand (`_de-schoolsplus.mjs --coords`, `_de-eti.mjs --full`). |
| `.github/workflows/rebuild-schools.yml` | The monthly rebuild (4th of the month): build → verify (`--reference-optional`) → sync-site-facts → scoped commit. `refresh` input for a deliberate new vintage. |

## The row schema (v2)

Every source emits plain objects with these keys. A key a source does not
publish may be left out: `toRow` fills its empty value (`''`, `null` or
`false`). Tiles store rows as arrays in this order; `index.fields` carries the
list, so readers always look fields up **by name**.

| Field | Meaning | Empty |
|---|---|---|
| `src` | source id = the module's `id` | — |
| `id` | the official id **as published, as a string** (URN, NCESSCH, PPIN, DE ref `101-0012`, BSID, MINCODE, CCT) | — |
| `name` | as published | — |
| `postcode` | postcode / ZIP / postal code / código postal | `''` |
| `lat`, `lng` | WGS84, **rounded to 5 dp** (`+x.toFixed(5)`) | — |
| `juris` | ISO 3166-2 (`GB-ENG`, `US-TX`, `CA-ON`, `MX-CMX` …) **from the source's own state/province field**, never from geometry | — |
| `type` | official type label, in its own words | `''` |
| `sector` | `state` or `private` (hollow pin) | — |
| `stage` | `Nursery` / `Primary` / `Secondary` / `''` = not published. **From `lib/stage.mjs`**, from the system's own level field | `''` |
| `phase` | the official level label (shown in the pane beside the stage grouping) | `''` |
| `tags` | space-separated codes: `charter` `new-address-2025-26` (US public) `grammar` `prep` `irish-medium` (NI) `french-immersion` `francophone` (BC) `ossd` `ossd-applied` `ossd-unknown` `ossd-unread` (Ontario private; unlabelled, they select the scheme note) | `''` |
| `gender` | **declared** only (`Boys` / `Girls` / `Mixed`; GIAS also writes `Not applicable`). Never derived from pupil counts. Requires `meta.publishes` to include `gender` | `''` |
| `boarding` | boolean. Requires `meta.publishes` to include `boarding` | `false` |
| `span` | the span in its own system: `4–11` (ages), `PK–5` (grades), `Years 1–7` | `''` |
| `pupils` | integer | `null` |
| `pupilsAsOf` | ISO date or school year; `''` = the source's `meta.pupilsAsOf` | `''` |
| `capacity` | places / approved enrolment / design capacity | `null` |
| `teachers` | FTE or headcount (the label says which) | `null` |
| `meals` | a percentage | `null` |
| `mealsKind` | `fsm` (E&W) / `fsme` (NI) / `frl` / `dc` (US). **Set exactly when `meals` is.** Ontario's low-income % is never put here | `''` |
| `admissions` | admissions policy (GIAS) | `''` |
| `la` | education authority: LA, school district, board, BC district, SEP operating body | `''` |
| `trust` | GIAS trust / US charter authorizer / NI **management type** (Controlled, Catholic Maintained…: governance, labelled "Management type", never a filter or colour) | `''` |
| `area` | ward / city / "colonia, alcaldía" / town (shown after the postcode) | `''` |
| `ratingScheme` | scheme id; its wording lives once in `index.schemes` | — (required) |
| `rv` | rating value in the scheme's own words | `''` |
| `rd` | rating year or date | `''` |
| `ru` | per-row link slug where a record link cannot be derived from `id` (NI ETI report path) | `''` |
| `sixthForm` `nursery` `inspectorate` `oeifGrade` `oeifDate` `cardDate` `rc…` (7) | England & Wales only | `false` / `''` |

Never add: religion / denomination / diocese / faith / typology fields (verify
fails on the name), addresses, websites, test scores that are not an official
rating (EQAO, BC FSA, SAER).

## Source modules

`tools/schools/sources/<id>.mjs`, default export:

```js
export default {
  id: 'ccd',                 // lower-case; = row.src; = the file name
  juris: ['US-NY', 'US-TX'], // every jurisdiction its rows carry (must exist in juris.mjs)
  cadence: 'annual',         // 'monthly' | 'annual' | 'static'
  meta: {                    // copied into index.json sources[id]
    name, publisher, licence,            // required
    licenceUrl,                          // required by verify-schools: /check/ links the licence in its sources list and
                                         // in each pane's attribution line (where the line names the licence)
    attribution: 'NCES ID {id} · …',     // required; {field} is filled from the row; printed under every school
    recordUrl: 'https://…?ID={id}',      // optional; only a VERIFIED per-school page ({field} URI-encoded)
    recordLabel: 'NCES school record',   // link text (default "Official record")
    where: 'US public schools',          // required; "It is published for {where}" in filter notes and the sources list
    displayCase: 'en',                   // optional, 'en' | 'es': the source prints names in CAPITALS, and /check/ shows an
                                         // all-capitals name, area, la or trust in title case (the page's schCase; data unchanged)
    publishes: ['charter'],              // filters it fills (filters.mjs): gender | boarding | charter
    pupilsAsOf: '2024-25',               // default for rows with pupilsAsOf ''
    labels: { … },                       // pane labels, see "The page"
  },
  schemes: { 'us-none-mo': { kind: 'none', notes: [ … ] } },  // every scheme its rows reference (non-map ones)
  async fetch(ctx) { return rows; },     // v2 row objects (the build clips, validates, dedupes, tiles)
  async probe(ctx) {},                   // optional: { vintage, changed } — new upstream vintage?
  async verify(rows, { haversine }) {},  // optional: position check(s) per juris, see verify
  invariants(rows) {},                   // optional, OFFLINE: [{ name, problems: [], ok }] checks verify-schools always
                                         // runs (de: no pane says "no ETI report" while one is filed for the school)
  fromV1(o) {},                          // gias only: reads the last v1 tile set
};
```

**When `fetch` runs.** `monthly` sources fetch on every build. `annual` and
`static` sources re-emit their current tiles unless run with `--refresh <id>`,
or unless they have no rows in the tiles yet (their first build). If they
define `probe`, it runs instead and a new vintage prints
`::warning:: new vintage for <id>` — refreshing is always a deliberate
`--refresh` run, so annual data never changes shape unreviewed.

**If `fetch` throws or returns no rows**, the build prints a `::warning::` and
re-emits that source's rows from the current tiles (with the previous build's
provenance). A brand-new source with no snapshot is simply absent from that
build.

**`ctx`** (one per source per build):

| | |
|---|---|
| `ctx.download(file, urls, { maxAgeH = 12, ua, timeoutMs, headers })` → `Buffer` | Cached under `<raw-dir>/<id>/<file>` with a `.meta.json` provenance sidecar. `urls`: a string, an array tried in order, or an async function returning either (resolve date-stamped names only when a fetch is needed). `ua`: `undefined` = Node's default fetch UA (what most hosts accept); `''` = empty UA (michigan.gov); anything else sent as-is. **Never one global browser UA** (education-ni.gov.uk refuses a spoofed Chrome). `--frozen` never touches the network. |
| `ctx.provenance` | What was downloaded (url, sha256, bytes, Last-Modified, ETag, fetchedAt); copied to `index.sources[id].upstream`. |
| `ctx.stat(key, n = 1)` | Counters → `index.sources[id].stats`. Use `unmapped.<reason>` for schools **not drawn because no location is published**, `dropped.<reason>` for rows that are not schools in scope (closed, virtual, adult). |
| `ctx.vintage(text)` | The data's own vintage, e.g. `"CCD 2024-25; EDGE 2024-25"`. |
| `ctx.snapshot` | This source's rows in the current tiles (read-only). For incremental crawls (NI ETI: stop at the newest report date already published). |
| `ctx.prev` | This source's record in the current `index.json` (or `null`). |
| `ctx.coverage` | `{ regions, regionFor(lat, lng, juris) }` — to pre-filter a national file to the covered boxes. The build applies R2 again anyway. |
| `ctx.refresh`, `ctx.frozen`, `ctx.log`, `ctx.warn` | |

Every row is checked by `lib/schema.mjs rowProblems()`; one bad row fails the
build with examples. It checks: `src`, string `id`, name, 5-dp numbers, `juris`
in the module's list, sector, stage, boolean boarding, numeric counts,
`meals`/`mealsKind` together, gender/boarding only if published, no `rv` on a
private school, a `ratingScheme`, no forbidden field names.

## Rating schemes: how a pane words a rating

A row carries only `ratingScheme`, `rv`, `rd` (and `ru`). The wording lives
once, in `index.schemes[id]`, supplied by the source module (`schemes`) or the
ratings module (`record`). `kind` picks the renderer on `/check/`:

| kind | For | Renders |
|---|---|---|
| `none` | no rating published / not applicable | the **first** note whose `when` matches (else `text`), as one line. E&W `not-ofsted` (Wales / ISI / private / default), `us-none-mo`, `ca-bc-none`, `mx-none`, `us-private`, NI "no report since 2016" … |
| `rating` | an official summative rating | the pattern below |
| `status` | a status that is **not a rating** (NY/PA/CA ESSA, …) | the same pattern; its `scale` must say it is not a rating |
| `ofsted` | England's Ofsted (report card areas + legacy OEIF) | the dedicated E&W renderer, unchanged |

```
<b>{title}</b>                                           "Texas school rating (TEA)"
<b>{rv}</b> — {rd || year} {short}                       "B — 2026 A–F accountability rating"
   … or, rv empty: {miss}  (default: "{place} publishes this {rating|status}, but this school is not in the {year} file.
                                      Special education, alternative, pre-K and career centres are often not rated.")
{scale}                                                  best to worst, in the state's words
{measures}                                               what it mostly measures
Set under {juris name} rules; it cannot be compared with ratings from other states or countries. {caveat} {matching notes}
Source: {publisher} ↗                                    url
```

Record fields: `kind`, `title`, `short`, `scale`, `measures`, `caveat`, `year`,
`publisher`, `url`, `values` (allowed `rv` strings — verify checks every row),
`miss` (template with `{place}` `{year}`), `notes: [{ when: { field: value |
[values], tag: 'code' }, html }]` (`tag` matches one of the row's `tags`, e.g.
NI's `eti-earlier-ref`: a report filed under the school's earlier reference),
`text`, `licence`/`licenceUrl` (an openly licensed rating: WA's CC BY 4.0 is
linked in the pane and the sources list). `rating`/`status` require title,
short, scale, year, publisher, url. Note `html` may contain `<b>`; everything
else is escaped.

## Ratings modules (US state rating maps)

`tools/schools/ratings/<scheme>.mjs` — see `_template.mjs`:

```js
export default {
  scheme: 'us-tx-af', juris: ['US-TX'], sources: ['ccd'], floor: 0.95,
  record: { kind: 'rating', title, short, scale, measures, caveat, year, publisher, url, values },
  async build(ctx) { return { values: { [NCESSCH]: { rv, rd } }, vintage }; },
};
```

- Built by hand: `node tools/schools/ratings.mjs --scheme us-tx-af`. `ctx.rows`
  are the in-scope rows from the current tiles (state schools of `sources` in
  `juris`); `ctx.download` as above. The runner keeps values only for those
  rows, checks them against `record.values`, and **refuses to write below
  `floor`** (the verified match rate — a changed layout looks like a collapse
  in matches). It writes `tools/data/schools/ratings/<scheme>.json`:
  `{ meta: { scheme, juris, sources, vintage, built, upstream, match }, values }`.
- The monthly build merges committed maps without the network: every **state**
  row of those sources and jurisdictions gets `ratingScheme = scheme` and the
  value, or an empty `rv` (the pane's miss line). A missing map file means the
  scheme is simply not applied yet (rows keep their source's default scheme,
  e.g. a "not shown yet" note).

## Filters

`filters.mjs` defines gender (select), boarding (check) and charter (check on
tag). A source declares what it fills in `meta.publishes`; `index.filters`
lists only filters some source in the build publishes, with `publishedBy` and a
`where` phrase. On `/check/` a control shows only while the schools in view
include one from a publishing source, or while it is on. When a filter is on
and schools from non-publishing sources are in view, the map note says
"Showing only schools that publish {noun}. It is published for {where}."
Never add a religion, management or rating filter.

## Scope R2: coverage, regions, jurisdictions

A school is in scope when it lies inside a crime-data region's **rectangle**
and its own `juris` is one of that region's home jurisdictions
(`regions.mjs`). Regions are tried in the backend's `PROVIDERS` order (Long
Beach before Los Angeles). The rectangle, not the exact `covers()`, so Boston's
polygon and the LA/Houston enclaves leave no holes; the home-state limit keeps
New Jersey out of NYC and Estado de México out of Mexico City. It is the
rectangle, literally (the owner's decision): the New York City layer includes
the strips of Westchester County (Yonkers, Mount Vernon, New Rochelle, Pelham:
38 schools) and western Nassau County (95) that lie inside the NYC crime
rectangle, as Boston's includes Cambridge and Brookline. `/check/` says so in
its sources list (`index.scope`, from `SCOPE_NOTE` in `regions.mjs`), and a
region's `outside` names what else its rectangle holds, for the map note.

- `tools/data/coverage.json` is generated: `node tools/schools/lib/coverage-from-backend.mjs [--backend ../saferoute-backend] [--check]`.
  It parses each provider's `covers()` (or an exported `BBOX`), then imports the
  backend and **probes the real `covers()`** inside and just outside every
  rectangle; refined regions (boston, la, houston) are recorded as such.
- **The build fails if coverage.json has a region with no `regions.mjs` entry**:
  a new crime city forces a schools decision.
- `juris.mjs` already lists every planned jurisdiction; add one only for a new place.

## Tiles and the snapshot rule

- Base cells are 0.25°; any cell with more than **600** rows splits into
  quadrants, recursively, down to **0.0625°**. Keys: `206_-1` (0.25°),
  `q412_-2` (0.125°), `qq825_-3` (0.0625°) = level prefix + `floor(lat/size)_floor(lng/size)`.
  `index.cells` lists every leaf; leaves never overlap.
- Rows are sorted by lat, lng, src, id, so identical inputs give byte-identical tiles.
- Written atomically (staging dir + rename): a crash leaves the old set intact.
- **The tiles are every source's snapshot** (`readRowsFromTiles`). Keep the
  worst tile at or under ~50 KB gzipped (verify fails above 50 KB).

## index.json v2

```jsonc
{ "version": 2, "generated": "…", "base": 0.25, "split": { "maxRows": 600, "minCell": 0.0625 },
  "count": 26218, "where": "England and Wales", "fields": [ … ], "cells": [ … leaf keys … ],
  "regions": [ { "id": "uk", "name": "United Kingdom", "country": "gb", "juris": ["GB-ENG","GB-WLS"],
                 "bbox": [s, w, n, e], "count": 26218, "view": [[s,w],[n,e]], "viewName": "central London", "tz": "^Europe/" } ],
  "juris":   { "GB-ENG": { "name": "England", "country": "GB", "count": 24826 }, … },
  "sources": { "gias": { …meta, "cadence", "juris", "rows", "status", "vintage", "fetched", "upstream": [ … ], "stats": { … } } },
  "schemes": { "none": { "kind": "ofsted", … }, "not-ofsted": { "kind": "none", "notes": [ … ] } },
  "filters": [ { "id": "gender", "type": "select", "field": "gender", "label": "Gender", "any": "Any gender",
                 "options": ["Boys","Girls","Mixed"], "publishedBy": ["gias"], "where": "England & Wales", "noun": "gender" }, … ],
  "options": { "gender": [ … ] } }
```

Only regions, jurisdictions, sources and schemes that have rows in the build
appear. `status` is `fetched`, `snapshot` or `snapshot-after-failure`.
`tools/sync-site-facts.mjs` copies `count` (`data-fact="schools"`) and `where`
(`data-fact="schools-where"`) into the pages.

## verify-schools.mjs

`node tools/verify-schools.mjs [--tiles dir] [--prev index.json] [--refresh src,…] [--no-position]`
— exits 1 on any FAIL. Checks: fields = schema; every leaf present, no stray
files, leaves disjoint, rows inside their leaf, split threshold; counts (total,
per source, per region); **drift** ±5% per source against git HEAD's index
(`--refresh` exempts a source); **R2 scope** for every row and region boxes =
coverage.json; unique `(src,id)`; stage/sector/juris/coordinates; schemes
defined, well-formed, used; `rv` ∈ `values`; **no rating on a private school**;
gender/boarding/filter tags only where published; meals/mealsKind; licence and
attribution present, and a `licenceUrl` for every source and every openly
licensed scheme; each source's offline `invariants(rows)`; **no tile over 50 KB gzipped**; **position per
jurisdiction** through each source's `verify(rows, { haversine })` hook, which
returns `[{ juris, check: 'position', reference, pass, message }]` (E&W:
postcodes.io postcode centroids, median ≤ 200 m). A jurisdiction with no
reference is a WARN — plug one in (NI: DE point vs postcode centroid, internal
only; Toronto: SIF vs City of Toronto layer ≤ 50 m; CDMX: CONALEP planteles
≤ 50 m, no placeholder clusters).

## Commands

```sh
node tools/build-schools.mjs                         # monthly: fetch monthly sources, reuse the rest
node tools/build-schools.mjs --only ccd,pss          # fetch exactly these (any cadence); all others re-emit their snapshot
node tools/build-schools.mjs --refresh ccd           # deliberately take a new vintage of an annual source
node tools/build-schools.mjs --frozen --raw-dir DIR  # reproducible: never fetch, use DIR's files
node tools/build-schools.mjs --out DIR --snapshot schools/data/tiles   # build somewhere else
node tools/verify-schools.mjs                        # [--reference-optional]: an unreachable position reference WARNs (CI)
node tools/schools/ratings.mjs --scheme us-tx-af
node tools/schools/probe-hosts.mjs                   # which upstream hosts answer (Phase 0; CI: probe-school-hosts.yml)
node tools/schools/lib/coverage-from-backend.mjs --check
node --test tools/schools/test/*.test.mjs
node tools/sync-site-facts.mjs
node tools/audit-viewports.mjs /check/               # the page must stay at 0 FAIL
```

## Adding a source (checklist)

1. Copy `sources/_template.mjs` to `sources/<id>.mjs`.
2. Pick the stage function for your system from `lib/stage.mjs` (add one there if your system is new, with the official grouping cited).
3. `juris` from the source's own state/province field. Count and drop schools with no published location (`ctx.stat('unmapped.…')`).
4. Define every scheme your rows reference (`kind: 'none'` with plain wording where nothing is published).
5. `meta`: licence, attribution with `{id}`, `where`, `labels`, `publishes`, `recordUrl` only if verified.
6. Optional `verify` hook with an independent position reference.
7. `node tools/build-schools.mjs --only <id>` → `node tools/verify-schools.mjs` → `node tools/audit-viewports.mjs /check/`.
8. Look at a dense tile and at ten panes in the browser.

## The page (check/index.html)

The page names no country; it renders from `index.json`:

- **Tiles**: `cellsInView()` walks from the 0.25° cells in view down to existing leaves (12-base-cell zoom cap unchanged).
- **Notes**: zoomed out → "Zoom in to see schools." only if school data lies in view (also below zoom 12 when a view would draw more than `SCH_MAX_PINS` = 4,000 pins: Mexico City at zoom 10-11 on a phone); no data here → "No school data here. Schools cover {where}."; data nearby but nothing drawn → "No mapped schools in view — try zooming out.", plus, where the view's centre is in a region whose rectangle crosses a line (`regions[].outside`), "Here the map shows schools in {home juris `area`/`name`} only, not {outside}." (Jersey City, Arlington VA, Windsor); a filter hiding non-publishing sources → "Showing only schools that publish …", and when it hides every pin, "No school in view publishes {noun}. It is published for {where}." (or, if some in view publish it, "No school in view matches these filters. Only schools that publish …").
- **Pane rows**, in this order, each shown only when published and labelled from `sources[src].labels`, overridden by `juris[j].labels` (from `juris.mjs`) where a jurisdiction words one differently (fallbacks in the page's `SCH_LABELS`): `type`, `phase`, `span`, `gender`, `pupils` (+ " of {capacity} {capacityOf}" when `capacityOf` is set), `capacity` (own row when `capacity` is set and not in "of" form), `teachers` (+ `ratio` row "about N" when `labels.ratio` is set), `meals` (label `labels.meals[mealsKind]`), `sixthForm`, `boarding`, `nursery`, one row per tag with `labels.tags[tag]`, `admissions`, `la`, `trust`. Then `labels.pupilsAsOf` (`{date}`), the record link, and the attribution.
- **Rating block**: by scheme `kind`, above.
- **Show schools / ?schools**: both go to the region whose `tz` matches the visitor's time zone, else the first region (the UK: central London) — `?schools` always, the pane's button when the view holds no school data or is zoomed out. The hint then says "Starting in {viewName}." `tools/audit-viewports.mjs` holds the `?schools` matrix to Europe/London and checks six zones separately.

- **Co-located schools**: pins within `SCH_NEAR_M` = 5 m of one another (single linkage: one site) — 40% of Mexico City, infant and junior pairs in England, multi-school US campuses of up to 11, and distinct records published a few metres apart — are fanned out in a small ring around the site's centre in screen pixels, recomputed on each redraw; a lone pin stays on its point. The pane lists the site's other schools as "Also at this address", each a link that opens it (same-named ones are told apart by level, type or id).
- **Display case**: for a source with `meta.displayCase`, an all-capitals `name`, `area`, `la` or `trust` is shown in title case (`schCase` in the page: `'es'` is exactly `sep.displayCase`, `'en'` keeps initialisms such as PS, ISD, KIPP, NYC, roman numerals and codes). `tools/schools/test/display-case.test.mjs` runs the page's own block. Mixed case, and every source without the flag (so England & Wales), is shown exactly as published.
- **Rating block wording**: `rating` says "Set under {juris rules or name} rules; it cannot be compared with ratings from other states or countries."; `status` says "… with other states' or countries' ratings or statuses." (a status is not a rating). A scheme's `link: { url, label }` with `{ru}` renders a per-school link (NI: the ETI report).
- **School data sources**: a `<details>` in `#secSchools`, filled from `index.sources` when first opened: where, name, publisher, vintage, licence (a link to its text), rows, and the `unmapped.*` total ("not drawn because their published location is missing or unreliable"), then every rating scheme's `attribution` (with its licence link where it has one), then `index.scope` (regions.mjs `SCOPE_NOTE`: what "around a city" means under R2, e.g. Yonkers is in the New York City layer).

## Proven for the v2 refactor (Sept 2026)

England & Wales output is semantically unchanged: the same 26,218 URNs; every
v1 field equal under its v2 name for every school; `stage` equal to the old
page's `schStage()` for every school; the pane HTML byte-identical for all
26,218 schools; pin counts identical for 960 filter combinations in 10 views;
the fallback path (v1 tiles as snapshot) produces byte-identical tiles.
Evidence: `scratchpad/schools-build/phase1/`.
