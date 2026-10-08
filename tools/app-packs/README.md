# App packs: the iPhone app's bundled schools and home-values data (O1)

`tools/build-app-packs.mjs` turns the **verified, published** layer data at one
landing commit into the packs SafeRoute 1.4 bundles (RELEASE-1.4-SCOPE.md §4.4
O1; Q3 option a: the app fetches no tiles). It writes **outside the served
tree** (default `out/app-packs/`, git-ignored) and the packs are never
committed. O2 (`tools/import-overlay-packs.mjs` in the iOS repo) runs it against
a given commit and copies the four files into the app.

```sh
node tools/build-app-packs.mjs                       # both packs from the working tree -> out/app-packs/
node tools/build-app-packs.mjs --commit c97230057    # from that commit's files (git archive), whatever is checked out
node tools/build-app-packs.mjs --layer schools --out /path/outside/the/repo [--json]
node --test tools/app-packs/test/*.test.mjs          # includes the Apple decode (swift; skipped off macOS)
swift tools/app-packs/test/inflate.swift <x-pack.bin> <offset>:<length>:<rawLength> …   # Apple-side decode by hand
```

Without `--commit` the input paths (`schools/data`, `prices/data`,
`check/index.html`, `tools/schools`, `tools/prices`, `tools/data`) must match
HEAD (`--allow-dirty` overrides; the commit is then recorded `+dirty`), and the
commit recorded is the last one that changed an input, so a tooling-only commit
gives byte-identical packs.

## Container (both layers)

| File | What |
|---|---|
| `<layer>-pack.bin` | Chunks, each compressed alone with **raw DEFLATE** (`zlib.deflateRawSync`, level 9; RFC 1951, no header), concatenated. Nothing else: no header, no timestamp. Apple: `compression_decode_buffer(…, COMPRESSION_ZLIB)`. |
| `<layer>-pack.json` | The layer's slimmed index, plus `pack` = `{ version: 1, layer, generated, landingCommit, sha256, bytes, chunkOf, chunks: [[offset, length, rows, rawLength], …], … }`. `sha256`/`bytes` are the .bin's; `rawLength` is the inflated size (the decode buffer). `generated` is the landing commit's date. |

Same commit, same zlib → byte-identical files (test/determinism.test.mjs).

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
  `tools/schools/licence.mjs` licenses; any other is stripped (rv/rd emptied, row
  back on its source's `defaultScheme`, i.e. the `us-pending` link-out). This is
  the only place the app's link-out rule is enforced.

## Home values (`prices-pack.*`)

- **Index**: `prices/data/index.json` (v1, as published) without
  `sources[].upstream` and `sources[].inputs`. `tiles.cells` stays (for
  `tileGrid`/`leafFor`).
- **Chunks**: areas **deduplicated** by (src, id), one chunk per colour scale,
  `chunks[i]` ↔ `scales[i]`; a chunk is `{ a: [row…], c: [context…] }` (the web
  tile format; `ctx` indexes the chunk's own `c`), rows by (src, id).
- **Leaf map**: `pack.leaves[i]` ↔ `tiles.cells[i]`, a flat
  `[chunk, row, chunk, row, …]` in the web tile's row order.

## Gates (any one fails the build; nothing is written)

| Gate | Fails when |
|---|---|
| `forbidden-fields` | a row field, context key or any index key matches `/relig\|denomin\|faith\|diocese\|typology\|orient/i` |
| `filter-ids` | a filter (or `options` key) other than gender, boarding, charter |
| `licence-urls` | a source (or a further licence, or a scheme that links one) without an https licence URL |
| `source-ids` | a source id, wherever named (index, rows, scales, regions, filters, geometry), is not a loaded source module: the parked `denver-sales` can never enter (the `denver` region's `acs-tract` estimates are fine) |
| `note-html` | any string in the index holds a tag other than `<b>` |
| `rating-licence` | (schools) a US value, or a US row, left on a scheme `licence.mjs` does not license |
| `totals` | the pack, read back from the .bin, disagrees with the index: total, per source, jurisdiction and region (schools); per region, source stats and scale (home values) |
| `reproduction` | re-expanding the .bin does not give back every web tile row: schools row by row (only the documented fields may differ, cased fields only in letter case); home values every web tile rebuilt **byte for byte** from the leaf map and chunks; and the index equals the web index but for the slimming |

Tests: `container` (deflate round trip, container checks), `reproduction`
(independent re-expansion of both packs), `gates` (a fixture that must fail for
every gate), `determinism`, `apple` (`inflate.swift` decodes fixtures and the
largest chunk of each pack; its sha256 must equal Node's).
