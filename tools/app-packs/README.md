# App packs: the iPhone app's bundled schools and home-values data (O1)

`tools/build-app-packs.mjs` turns the **verified, published** layer data at one
landing commit into the packs SafeRoute 1.4 bundles (RELEASE-1.4-SCOPE.md §4.4
O1; Q3 option a: the app fetches no tiles). It writes **outside the served
tree** (default `out/app-packs/`, git-ignored) and the packs are never
committed. O2 (`tools/import-overlay-packs.mjs` in the iOS repo) runs it against
a given commit and copies the six files into the app: both packs and each
pack's Spanish display text, `schools.es.json` (S7) and `prices.es.json` (H5),
below.

```sh
node tools/build-app-packs.mjs                       # both packs from the working tree -> out/app-packs/
node tools/build-app-packs.mjs --commit c97230057    # from git (git archive), whatever is checked out
node tools/build-app-packs.mjs --layer schools --out /path/outside/the/repo [--json] [--strict-es]
node --test tools/app-packs/test/*.test.mjs          # includes the Apple decode of every chunk (swift; skipped off macOS)
swift tools/app-packs/test/inflate.swift <x-pack.bin> <offset>:<length>:<rawLength> …   # Apple-side decode by hand
```

Exit 0 built, 1 a gate or the build failed (nothing written), 2 a usage error
(unknown option, empty `--commit`/`--out`, a served `--out`).

**The data.** The input paths are `schools/data`, `prices/data`,
`check/index.html`, `tools/schools` and `tools/prices`. With `--commit REV` they
come from git; without it from the working tree, which must match HEAD
(`--allow-dirty` overrides, recorded `+dirty`). Either way `landingCommit` is
the **last commit at or before REV (or HEAD) that changed an input**, and
`generated` is that commit's date in UTC. So `--commit HEAD`, a branch tip, a
safety-pages-only main commit and the data commit itself all give the same
six files, and a tooling-only commit changes nothing (a translation commit
changes only the text file built from that source).

**The rules** the gates hold the data to (the licence allow-list
`tools/schools/licence.mjs`, `tools/schools/filters.mjs`, both layers'
`lib/schema.mjs` field lists, and the loaded source and ratings modules) are
also read from the builder's **committed HEAD**. A scheme is licensed, or a
source loadable, only if both the data commit and HEAD say so: an old
`--commit` cannot bring back a licence withdrawn since, and nothing in the
working tree can widen one (a dirty rule path refuses the build even with
`--allow-dirty`). `pack.rulesCommit` is the last HEAD commit that changed a
rule path.

**Where it writes.** Inside any checkout of this repository (this worktree,
the main checkout, any other worktree) only the top-level, git-ignored `out/`;
checked on the real path as git sees it, so letter case and symlinks do not
get round it. Anywhere outside the repository is fine. Building one layer
removes the other layer's pack from `--out` if it came from another landing
commit, so the directory never holds a mixed pair.

## Container (both layers)

| File | What |
|---|---|
| `<layer>-pack.bin` | Chunks, each compressed alone with **raw DEFLATE** (`zlib.deflateRawSync`, level 9; RFC 1951, no header), concatenated. Nothing else: no header, no timestamp. Apple: `compression_decode_buffer(…, COMPRESSION_ZLIB)`. |
| `<layer>-pack.json` | The layer's slimmed index, plus `pack` = `{ version: 1, layer, generated, landingCommit, rulesCommit, encoder, sha256, bytes, chunkOf, chunks: [[offset, length, rows, rawLength], …], … }`. `sha256`/`bytes` are the .bin's; `rawLength` is the inflated size (the decode buffer). `generated` is the landing commit's date (UTC). `encoder` = `{ format: 'deflate-raw', level: 9, zlib }`: the zlib that made the bytes. |

Same data, same rules, same zlib → byte-identical files
(test/determinism.test.mjs). Node bundles its own zlib and its output differs
from other zlib builds byte for byte (all decode the same), so a pack built
under another Node may hash differently: `pack.encoder.zlib` and the
summary's `toolchain` (node, zlib, the builder's last commit) say why.

**For O2 / O3.** O2 should check that `pack.landingCommit` matches
`/^[0-9a-f]{40}$/` (never `+dirty`), that both JSON files carry the same
`landingCommit`, and that it is `git log -1 --format=%H <rev> -- <input
paths>` for the rev it asked for. O3 checks `pack.layer`, then
`pack.version == 1`, then the index version **per layer**: the schools index
is v2, the home-values index is **v1** (as published).

## Schools (`schools-pack.*`)

- **Index**: `schools/data/tiles/index.json` (v2) without `sources[].upstream`;
  `sources[].displayCase` removed (already applied: `pack.displayCase`);
  `schemes` limited to those rows use; each note's trailing
  `<span class="caveat">…<a …>label</a></span>` split into fields, so the only
  HTML left is `<b>`: `{ when?, html, caveat?, link?: { url, label } }`.
- **Chunks**: one per leaf, `chunks[i]` ↔ `cells[i]`; a chunk is the leaf's rows
  (arrays in `fields` order, the tile's order). Read fields by name.
- **Display case at pack time**: `name`, `area`, `la` (and `trust`) through the
  page's own `schCase` for a source with `displayCase`; `trust` through the
  page's `trustName` otherwise. Both are run from `check/index.html` itself (the
  way `tools/schools/test/display-case.test.mjs` runs schCase), so the app needs
  no Swift port. Only letter case changes (the reproduction gate checks it).
- **Rating licence (Q4 b)**: a US school keeps a value only under a scheme
  `tools/schools/licence.mjs` licenses (at the data commit and at HEAD) for its
  own state; any other is stripped (rv/rd emptied, row back on its source's
  `defaultScheme`, i.e. the `us-pending` link-out). This is the only place the
  app's link-out rule is enforced. A licensed scheme published without a
  `licenceUrl` gets its ratings module's (at HEAD), listed in
  `pack.ratingLicence.licenceUrlAdded` (CT at c97230057).

## Spanish display text (`schools.es.json`, S7)

The app shows the schools pack's own words (scheme titles, scales, caveats,
notes, labels, attributions, place and filter words, and About's "School
data" rows: each source's where, publisher and vintage, and the scope) through
`SchoolDataText.display`; in Spanish it looks each one up here.
`lib/schools-text.mjs` lists those strings by the app's own paths
(`displayStrings`: per scheme kind, as SchoolDataText's doc says) and builds
the file from the committed source **`tools/app-packs/i18n/schools.es.src.json`**
(es-MX, informal tú, with the glossary subset it is checked against). The
source is read from the builder's committed **HEAD**, like the rules: a dirty
source file refuses the build (`--allow-dirty` reads it, recorded `+dirty`;
never with `--commit`). Each text has its own source file (`TEXT_SOURCES` in
`lib/schools-text.mjs`), and is refused and stamped by that file alone.

| Field | What |
|---|---|
| `forPack` | `{ landingCommit, indexSha256, binSha256 }`: the sha256 of the `schools-pack.json` and `.bin` it was built with. The app uses no text that names another pack. |
| `textCommit` | the last commit at HEAD that changed `tools/app-packs/i18n/schools.es.src.json` (that file only: a commit to `prices.es.src.json` beside it leaves this file byte-identical) |
| `hash` | the key: the first 16 hex of SHA-256 over the exact UTF-8 of the English, as the app passes it (a template before it is filled); nothing is normalised at run time |
| `strings` | `{ key: { en, es } }`, in display order |
| `keep` | the licence names' and the sources' dataset names' keys: they stay English (glossary; SD19: dataset names kept, agency names translated) |
| `values` | `{ key: { en, es, field } }`: Mexico City's SEP `type`/`phase` values without their English gloss ("Primaria general (primary)" → "Primaria general"). Every other row value (ratings, grades, governance words) stays as published. |
| `display` | every display string's key; `stats`: translated, keep, identity (no letters), missing (+ `missingKeys`), values, valuesMissing |

A display string with no entry is **missing**: the app shows the English with
"(en inglés)". That is counted, not a failure, unless `--strict-es`. Gates (any
one fails the schools build; their results join the schools pack's in the
summary, which O2 requires all PASS):

| Gate | Fails when |
|---|---|
| `es-keys` | a key is not the hash of its English; text that is not NFC, has edge whitespace or is empty; two display strings share a key |
| `es-orphans` | a source entry whose English this pack does not display (an orphaned key) |
| `es-form` | different `{placeholder}` sets; a different number of `<b>` runs, any other tag, a raw `<` or an HTML entity in the Spanish; a trailing " ↗" in one language only |
| `es-licences` | a licence name or a source's dataset name translated; a licence name (or its bracketed short form) in an English string but not its Spanish; an attribution that would no longer link its licence (the page's `linkLicence`) |
| `es-words` | a label, title or filter word whose Spanish matches `FORBIDDEN_KEY` or religi/confesi/denominaci/diócesis; "anónimo" anywhere; the formal usted/ustedes |
| `es-glossary` | an English term without its glossary rendering in the Spanish (internado, chárter, alumnado, aleja el mapa, calificación, estatus, inspección, Fuente:, …); a name in capitals (NCES, ETI, OSSD…) dropped |
| `es-gloss` | a `values` entry that is not a SEP `type`/`phase` value with exactly one trailing "( … )", whose Spanish is not that value without it, or that occurs as any other value |
| `es-rating-values` | a display string or an entry equal to a row's rating value (`rv`) |
| `es-complete` | (`--strict-es` only) a display string or a glossed SEP value with no Spanish |

## Spanish display text for home values (`prices.es.json`, H5)

The same shape as `schools.es.json` (version, language, hash, `forPack` for
the **prices** pack, `textCommit`, strings, keep, `values` (always empty),
display, stats), so the app reads both with one loader. `lib/prices-text.mjs`
lists the strings the app passes through `PriceDataText.display`: `where`,
`scope`; each source's metric, unit noun (and its one-form, "sales" → "sale",
as the page's `prOne` makes it), area noun and notes; each scale's name and
metric; region names and `outside`; jurisdiction names and areas; the
missing cities' names and reasons. The source is
**`tools/app-packs/i18n/prices.es.src.json`** (es-MX, informal tú, with the
glossary it is checked against), read from HEAD; `textCommit` is the last
commit that changed that file.

- **Kept in English (`keep`, HD12):** licence names, and each source's dataset
  `name`, `publisher` and `credit`, which sit beside the verbatim English
  attribution lines that name them.
- **Not display text:** attribution lines (verbatim English, licence linked as
  published) and **periods and context labels**, which the app rebuilds in
  its own language from their fields (`lib/prices-periods.mjs`): the sale
  window ("Sales dated/recorded {span}"), "12 months to {Month} {yyyy}",
  "{a}–{b} (5-year survey)", "Calendar year {y}", "{y} Census (May {y})"; the
  ACS context "{metric}, {a}–{yy} survey" and NI's "{metric}, wider area
  ({DEA}), {y}". Month names come from a fixed table (en-GB's `toLocaleString`
  writes "Sept"; the pack writes "Sep").
- **A refreshed pack** whose note text moved (Hennepin's months and amounts
  change with each rebuild) has a new key for it: the old entry becomes an
  orphan and the build fails until the source is updated, so a 1.4.x pack
  refresh needs its changed notes translated (or `--allow-dirty` to see them).

| Gate | Fails when |
|---|---|
| `pr-periods` | a source's or scale's period, a window's span, or a row's context label (and a source's `contextLabel`) is not exactly the rebuild from its fields; a period or label of a shape the rebuild does not know; a window whose vintage is not `{from}..{to}` |
| `pr-es-keys`, `pr-es-orphans`, `pr-es-form` | as `es-keys`, `es-orphans` and `es-form` above (the same functions): the hash rule, NFC, no collision; no orphaned entry; the same `{placeholders}`, no tag, no entity |
| `pr-es-words` | "promedio" anywhere, or the standalone word "media"/"medias" (the mean; "mediana" and the ordinary "medio" pass); "precio" in a label (metric, unit or area noun, scale name or metric) reached from an owners'-estimate source (`acs-tract`, `statcan-ct`), or "price" in its English; "average" in any English; the formal usted; "anónimo". Notes may say "no son precios de venta": the rule is the labels' (§4.6 H5) |
| `pr-es-money` | the numbers differ between the English and the Spanish (as a multiset, grouping ignored: never converted, never dropped); a bare `$` in the Spanish, or not one `US$` for each US dollar amount (HD1); a different count of `£` or `CA$` |
| `pr-es-shared` | a string `schools.es.src.json` also translates (England, Wales, Northern Ireland, New York, the District of Columbia…) with other Spanish (SD18) |
| `pr-es-licences` | a kept string (licence, dataset name, publisher, credit) with a translation; a licence name in an English string but not its Spanish; an attribution line with a translation |
| `pr-es-glossary` | an English term without its glossary rendering (mediana, sector censal, estimación de los propietarios, precio de venta, margen de error, partes independientes, escritura, predio, departamento…); a name in capitals (ONS, HMRC, LPS, MSOA, NYC…) dropped, unless spelled out as `acronymExpansions` says (US → EE. UU., UK → Reino Unido, DC → D. C.) |
| `pr-es-complete` | (`--strict-es` only) a display string with no Spanish |

## Home values (`prices-pack.*`)

- **Index**: `prices/data/index.json` (v1, as published) without
  `sources[].upstream` and `sources[].inputs`. `tiles.cells` stays (for
  `tileGrid`/`leafFor`).
- **Chunks**: areas **deduplicated** by (src, id), one chunk per colour scale,
  `chunks[i]` ↔ `scales[i]`; a chunk is `{ a: [row…], c: [context…] }` (the web
  tile format; `ctx` indexes the chunk's own `c`), rows by (src, id).
- **Leaf map**: `pack.leaves[i]` ↔ `tiles.cells[i]`, a flat
  `[chunk, row, chunk, row, …]` in the web tile's row order.
- **Source order**: a row's `src` is an index into `pack.sourceIds` (=
  `Object.keys(index.sources)` in published order). Read it from there:
  Foundation's `JSONSerialization` and Swift's `Dictionary`/`JSONDecoder` do not
  keep object key order, so `index.sources`' own order cannot be relied on.

## Gates (any one fails the build; nothing is written)

| Gate | Fails when |
|---|---|
| `forbidden-fields` | a row field, context key, any index key, or a pane label (source labels, filter words, scheme titles) matches `/relig\|denomin\|faith\|diocese\|typology\|orient/i`; `index.fields` is not exactly the layer's `lib/schema.mjs` `FIELDS` (so no field is renamed to carry something else); a home-values context key outside `CONTEXT_KEYS` |
| `filter-ids` | a filter (or `options` key) other than gender, boarding, charter; a filter that differs from its `tools/schools/filters.mjs` definition (field, tag, type, label, noun, any) or carries a key it does not define; select options outside Boys/Girls/Mixed; a source whose `publishes` names anything else, or a `publishedBy` that is not exactly the sources publishing it |
| `licence-urls` | a source (or a further licence, or a scheme that links one) without an https licence URL; a state ratings scheme whose values the pack carries without publisher, attribution, licence and an https `licenceUrl` (or with one its ratings module contradicts) |
| `source-ids` | a source id, wherever named (index, rows, scales, regions, filters, geometry), is not a source module loaded at both the data commit and HEAD: the parked `denver-sales` can never enter (the `denver` region's `acs-tract` estimates are fine); (home values) `pack.sourceIds` is not the index's order, or a row's `src` is not an index into it |
| `note-html` | any string in the index, or in any row or context of the decoded chunks, holds a tag other than `<b>` |
| `rating-licence` | (schools) a row on a state ratings scheme that is not licensed (at the data commit and HEAD) for that row's own jurisdiction; a US value (rv) off a licensed scheme; a US row off one carrying any England & Wales rating field (rd, inspectorate, oeif*, cardDate, rc*) |
| `rating-schemes` | (schools) a row whose scheme the pack's index does not define, or that is neither its own source module's scheme nor a licensed state scheme |
| `totals` | the pack, read back from the .bin, disagrees with the index: total, per source, jurisdiction and region (schools); per region, source stats and scale (home values) |
| `reproduction` | re-expanding the .bin does not give back every web tile row: schools row by row (only the documented fields may differ, cased fields only in letter case); home values every web tile rebuilt **byte for byte** from the leaf map and chunks; and the index equals the web index but for the slimming |

Tests: `schools-text` (S7: every Spanish gate on the real pack, and a fixture
that must fail for each; missing text counted; the file tied to its pack;
the source read from HEAD, one file per text), `prices-text` and
`prices-periods` (H5: the same for `prices.es.json`, and every period, span
and context label rebuilt), `container` (deflate round trip, container checks), `reproduction`
(independent re-expansion of both packs), `gates` (a fixture that must fail for
every gate, including each way the reviews found round one), `determinism`
(working tree = `--commit HEAD` = `--commit <data commit>`, all six files), `cli` (out-path
guard, dirty refusals, `--commit` resolution, argument errors, a symlinked
CLI path, in a throwaway git repo where needed), `apple` (`inflate.swift`
decodes the fixtures and **every** chunk of both packs; each sha256 must equal
Node's). Expected counts are computed from the input, so a monthly data refresh
does not break them.
