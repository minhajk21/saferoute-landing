// The human-readable parts of index.json that are DERIVED from what is in the
// build, so no page ever hand-types which countries or filters exist.

import { JURIS } from '../juris.mjs';
import { FILTERS } from '../filters.mjs';

// "A", "A and B", "A, B and C"
export const joinAnd = list => (list.length <= 1 ? list.join('') : `${list.slice(0, -1).join(', ')} and ${list[list.length - 1]}`);

// Where schools are, as a phrase: "England and Wales", or with every planned
// country "England, Wales, Northern Ireland, 26 US cities, Toronto, Vancouver
// and Mexico City". UK regions are named by their jurisdictions (the UK region
// is a country, not a city); US cities are counted once there are three or
// more; everything else is named by city. Order follows the regions (the
// backend's PROVIDERS order), with each group placed where it first appears.
export function composeWhere(regions) {
  const parts = [];
  const us = regions.filter(r => r.country === 'us');
  let usDone = false;
  for (const r of regions) {
    if (r.country === 'gb') parts.push(...r.jurisPresent.map(j => JURIS[j].where || JURIS[j].name));
    else if (r.country === 'us') {
      if (us.length >= 3) { if (!usDone) parts.push(`${us.length} US cities`); usDone = true; }
      else parts.push(r.name);
    } else parts.push(r.name);
  }
  return joinAnd([...new Set(parts)]);
}

// Filters published by at least one source in the build, with the values a
// select offers and the phrase for "It is published for {where}".
export function composeFilters(sources, rows) {
  const out = [];
  for (const [id, f] of Object.entries(FILTERS)) {
    const by = sources.filter(s => (s.meta.publishes || []).includes(id));
    if (!by.length) continue;
    const ids = new Set(by.map(s => s.id));
    const rec = { id, type: f.type, label: f.label, noun: f.noun, publishedBy: [...ids], where: joinAnd(by.map(s => s.meta.where)) };
    if (f.field) rec.field = f.field;
    if (f.tag) rec.tag = f.tag;
    if (f.type === 'select') {
      rec.any = f.any;
      const ex = new Set(f.exclude || []);
      rec.options = [...new Set(rows.filter(r => ids.has(r.src)).map(r => r[f.field]))].filter(v => v && !ex.has(v)).sort();
    }
    out.push(rec);
  }
  return out;
}
