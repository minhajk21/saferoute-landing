// Scope rule R2, in one place: a school is on the map when it lies inside a
// crime-data region's rectangle AND its own jurisdiction (from the SOURCE's
// state / province / entity field, never from geometry) is one of that
// region's home jurisdictions.
//
// Rectangles come from tools/data/coverage.json (the backend's covers() boxes,
// see coverage-from-backend.mjs), in the backend's PROVIDERS order, so where
// two boxes overlap (Long Beach inside Los Angeles) the first wins, as it does
// for crime data. The home jurisdictions come from ../regions.mjs.
//
//   const cov = loadCoverage();          // throws if a region lacks a regions.mjs entry
//   cov.regionFor(lat, lng, juris)       // -> region object, or null (out of scope)
//   cov.regions                          // [{ id, name, country, bbox, juris, view, viewName, tz }]
//
// Why the rectangle and not the exact covers(): Boston's city polygon and the
// Los Angeles / Houston enclaves would punch holes in the map — Santa Monica
// or Beverly Hills with no schools while surrounded by pins. The rectangle
// limited to the home state has neither holes nor cross-border rating systems.

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { REGIONS } from '../regions.mjs';
import { JURIS } from '../juris.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
export const COVERAGE_PATH = join(ROOT, 'tools', 'data', 'coverage.json');

export const inBox = (bbox, lat, lng) => lat >= bbox[0] && lat <= bbox[2] && lng >= bbox[1] && lng <= bbox[3];

export function loadCoverage(path = COVERAGE_PATH) {
  const doc = JSON.parse(readFileSync(path, 'utf8'));
  const unknown = doc.regions.filter(r => !REGIONS[r.id]).map(r => r.id);
  if (unknown.length) {
    throw new Error(`coverage.json has region(s) ${unknown.join(', ')} with no entry in tools/schools/regions.mjs — ` +
      'a new crime city needs a schools decision (its home jurisdiction), so the build stops here');
  }
  const regions = doc.regions.map(r => ({ ...r, ...REGIONS[r.id] }));
  for (const r of regions) {
    for (const j of r.juris) if (!JURIS[j]) throw new Error(`regions.mjs: ${r.id} names unknown jurisdiction ${j} (add it to juris.mjs)`);
  }
  const stale = Object.keys(REGIONS).filter(id => !doc.regions.some(r => r.id === id));
  return {
    doc, regions, stale,   // stale: regions.mjs entries the backend no longer has (a warning, not an error)
    regionFor(lat, lng, juris) {
      for (const r of regions) if (inBox(r.bbox, lat, lng) && r.juris.includes(juris)) return r;
      return null;
    },
  };
}
