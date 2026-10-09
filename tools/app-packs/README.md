# App packs: the iPhone app's bundled schools and home-values data (O1)

`tools/build-app-packs.mjs` turns the **verified, published** layer data at one
landing commit into the packs SafeRoute 1.4 bundles (RELEASE-1.4-SCOPE.md §4.4
O1; Q3 option a: the app fetches no tiles). It writes **outside the served
tree** (default `out/app-packs/`, git-ignored) and the packs are never
committed. O2 (`tools/import-overlay-packs.mjs` in the iOS repo) runs it against
a given commit and copies the four files into the app.

```sh
node tools/build-app-packs.mjs                       # both packs from the working tree -> out/app-packs/
node tools/build-app-packs.mjs --commit c97230057    # from git (git archive), whatever is checked out
node tools/build-app-packs.mjs --layer schools --out /path/outside/the/repo [--json]
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
four files, and a tooling-only commit changes nothing.

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

Tests: `container` (deflate round trip, container checks), `reproduction`
(independent re-expansion of both packs), `gates` (a fixture that must fail for
every gate, including each way the reviews found round one), `determinism`
(working tree = `--commit HEAD` = `--commit <data commit>`), `cli` (out-path
guard, dirty refusals, `--commit` resolution, argument errors, a symlinked
CLI path, in a throwaway git repo where needed), `apple` (`inflate.swift`
decodes the fixtures and **every** chunk of both packs; each sha256 must equal
Node's). Expected counts are computed from the input, so a monthly data refresh
does not break them.
