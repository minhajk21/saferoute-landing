// tools/prices/lib/module-meta.mjs
//
// Is a published source's meta still what its module says? build-prices asks
// when a source re-emits its snapshot (a failed fetch, or a hand refresh of
// another source with --only): the snapshot keeps the meta it was published
// with, so a module whose meta has changed since gets a warning that the
// change applies when the source is next fetched.
//
// Only what the MODULE states is compared. Left out:
//   - what the build adds: ENTRY_BUILD_KEYS, and for a sale source its period,
//     area noun and notes (the build writes them) and its window's dates;
//   - in attribution lines, what fetch() stamps in from the data it read:
//     every "data as of <date>" (the version of a data set, which NYC's
//     § 23-502(d) asks for), and whatever else the module lists in its own
//     `stamps` (nyc-dof-sales: the annualized workbooks a window needed and
//     PLUTO's release). The module's meta before a fetch has none of them
//     ("data as of unknown", or nothing), so without this a stamped source's
//     snapshot always read as changed: nyc-dof-sales warned on every --only
//     build of another source, though nothing in its module had changed.

import { ENTRY_BUILD_KEYS, isSales } from './schema.mjs';

// A source's index entry without the fields that describe a build.
export const metaOf = m => Object.fromEntries(Object.entries(m).filter(([k]) => !ENTRY_BUILD_KEYS.includes(k)));

// ", data as of 2026-09-15" and " data as of unknown": the ISO day a source
// writes (or 'unknown' before a fetch; a US 05/04/2026 too). The comma before
// it goes with it, since a stamp that appears only after a fetch (the Digital
// Tax Map's) brings its own.
const AS_OF = /,? data as of (?:unknown|\d{4}-\d{2}-\d{2}(?:T[\d:.]+Z?)?|\d{1,2}\/\d{1,2}\/\d{4})/g;

// An attribution line without its fetch-time stamps: the module's own first
// (a stamp may hold a "data as of"), then every "data as of" date.
export function unstamped(line, stamps = []) {
  let s = String(line);
  for (const re of stamps || []) s = s.replace(re, '');
  return s.replace(AS_OF, '');
}

// A meta (the module's, or a published entry's) as the module would state it.
export function moduleMeta(m, src) {
  let out = metaOf(m);
  if (isSales(src)) {
    const { period, areaNoun, window: w, notes, ...rest } = out;
    const { from, to, span, ...win } = w || {};
    out = { ...rest, window: { ...win, lagMonths: win.lagMonths || 0 } };
  }
  if (Array.isArray(out.attribution)) out.attribution = out.attribution.map(l => unstamped(l, src.stamps));
  return out;
}

// True when the published meta is not what the module says now.
export const metaDiffers = (src, published) =>
  JSON.stringify(moduleMeta({ ...src.meta }, src)) !== JSON.stringify(moduleMeta(published, src));
