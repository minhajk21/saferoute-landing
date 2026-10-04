// Putting rating values on rows, and the scheme records that word them: the
// steps build-schools.mjs runs every month, shared with
// tools/schools/apply-rating-licence.mjs (which runs them on the published
// tiles without a build), so the two can never disagree about which values
// are published.
//
// THE LICENCE RULE (tools/schools/licence.mjs). A ratings module's map is
// applied only if its values are licensed for reuse. Before any map, every row
// of a source that declares defaultScheme(row) goes back to that scheme with no
// value: rows re-emitted from the tiles (the snapshot) still carry the last
// build's scheme and value, and a value must not outlive its licence.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { LICENSED_RATINGS, ratingLicensed } from '../licence.mjs';

const fmt = n => n.toLocaleString('en-GB');

// results: [{ src, rows }]. A source that declares defaultScheme() never sets
// a value itself; its values come only from rating maps.
export function resetToDefaultSchemes(results) {
  for (const { src, rows } of results) {
    if (typeof src.defaultScheme !== 'function') continue;
    for (const r of rows) { r.ratingScheme = src.defaultScheme(r); r.rv = ''; r.rd = ''; }
  }
}

// Reset, then apply every licensed map in mapsDir to the state schools of its
// sources and jurisdictions. Returns [{ rm, meta, applied, matched }] for the
// maps applied.
export function applyRatingMaps(results, ratings, mapsDir, log = console.log) {
  resetToDefaultSchemes(results);
  const used = [];
  for (const rm of ratings) {
    if (!ratingLicensed(rm.scheme)) {
      log(`  rating ${rm.scheme}: values not licensed for reuse (tools/schools/licence.mjs) — not applied; its schools keep their source's line`);
      continue;
    }
    if (LICENSED_RATINGS[rm.scheme].juris !== rm.juris.join()) {
      throw new Error(`tools/schools/licence.mjs licenses ${rm.scheme} for ${LICENSED_RATINGS[rm.scheme].juris}, but the module rates ${rm.juris.join(', ')}`);
    }
    const path = join(mapsDir, `${rm.scheme}.json`);
    if (!existsSync(path)) { log(`  rating ${rm.scheme}: no map at tools/data/schools/ratings/${rm.scheme}.json yet — not applied`); continue; }
    const map = JSON.parse(readFileSync(path, 'utf8'));
    let n = 0, hit = 0;
    for (const { rows } of results) for (const r of rows) {
      if (!rm.sources.includes(r.src) || !rm.juris.includes(r.juris) || r.sector !== 'state') continue;
      const v = map.values[r.id];
      n++; if (v) hit++;
      r.ratingScheme = rm.scheme; r.rv = v?.rv ?? ''; r.rd = v?.rd ?? '';
    }
    used.push({ rm, meta: map.meta, applied: n, matched: hit });
    log(`  rating ${rm.scheme}: ${fmt(hit)} of ${fmt(n)} schools matched`);
  }
  return used;
}

// index.schemes: the record of every scheme a row uses, from its source module
// or, for an applied map, its ratings module (with the map's vintage). In
// source order, then ratings order, so the same inputs give the same file.
export function composeSchemes(sources, rows, usedRatings) {
  const schemes = {};
  const usedIds = new Set(rows.map(r => r.ratingScheme));
  for (const src of sources) for (const [id, s] of Object.entries(src.schemes || {})) {
    if (!usedIds.has(id)) continue;
    if (schemes[id] && JSON.stringify(schemes[id]) !== JSON.stringify(s)) throw new Error(`scheme ${id} is defined differently by two sources`);
    schemes[id] = s;
  }
  for (const u of usedRatings) if (usedIds.has(u.rm.scheme)) schemes[u.rm.scheme] = { ...u.rm.record, vintage: u.meta?.vintage ?? null };
  const unknown = [...usedIds].filter(id => !schemes[id]);
  if (unknown.length) throw new Error(`rows use rating scheme(s) no source or ratings module defines: ${unknown.join(', ')}`);
  return schemes;
}
