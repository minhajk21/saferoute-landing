// Discovers and validates source modules (tools/schools/sources/<id>.mjs) and
// ratings modules (tools/schools/ratings/<scheme>.mjs). The contract they are
// checked against is documented in tools/schools/README.md.
//
// Discovery is by file, not by a registry: a lane adds its source by adding a
// file, so parallel lanes never edit the same list. Files starting with "_"
// are helpers (sources/_ofsted.mjs) or templates and are never loaded.

import { readdirSync, existsSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { JURIS } from '../juris.mjs';
import { FILTERS } from '../filters.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
export const SOURCES_DIR = join(HERE, '..', 'sources');
export const RATINGS_DIR = join(HERE, '..', 'ratings');

const CADENCES = ['monthly', 'annual', 'static'];
export const SCHEME_KINDS = ['rating', 'status', 'none', 'ofsted'];

async function loadDir(dir) {
  if (!existsSync(dir)) return [];
  const files = readdirSync(dir).filter(f => f.endsWith('.mjs') && !f.startsWith('_')).sort();
  const out = [];
  for (const f of files) {
    const mod = await import(pathToFileURL(join(dir, f)).href);
    if (!mod.default) throw new Error(`${dir}/${f}: no default export`);
    out.push({ file: f, mod: mod.default });
  }
  return out;
}

export function schemeProblems(id, s) {
  const p = [];
  if (!SCHEME_KINDS.includes(s?.kind)) p.push(`kind "${s?.kind}" (want ${SCHEME_KINDS.join(' | ')})`);
  if (s?.kind === 'rating' || s?.kind === 'status') {
    for (const k of ['title', 'short', 'scale', 'year', 'publisher', 'url']) if (!s[k]) p.push(`no ${k}`);
    if (s.values && !Array.isArray(s.values)) p.push('values must be an array of allowed rv strings');
  }
  if (s?.kind === 'none' && !(s.notes?.length || s.text)) p.push('a "none" scheme needs text or notes');
  for (const n of s?.notes || []) if (!n.html) p.push('a note without html');
  return p.map(x => `scheme ${id}: ${x}`);
}

export async function loadSources(dir = SOURCES_DIR) {
  const list = [];
  for (const { file, mod: s } of await loadDir(dir)) {
    const where = `sources/${file}`;
    const bad = m => { throw new Error(`${where}: ${m} (see tools/schools/README.md)`); };
    if (!/^[a-z][a-z0-9-]*$/.test(s.id || '')) bad(`id "${s.id}" must be lower-case letters, digits and "-"`);
    if (basename(file, '.mjs') !== s.id) bad(`the file must be named after its id ("${s.id}.mjs")`);
    if (!Array.isArray(s.juris) || !s.juris.length) bad('juris must list the jurisdictions its rows carry');
    for (const j of s.juris) if (!JURIS[j]) bad(`unknown jurisdiction ${j} (add it to tools/schools/juris.mjs)`);
    if (!CADENCES.includes(s.cadence)) bad(`cadence "${s.cadence}" (want ${CADENCES.join(' | ')})`);
    if (typeof s.fetch !== 'function') bad('no fetch(ctx)');
    const m = s.meta || {};
    for (const k of ['name', 'publisher', 'licence', 'attribution', 'where']) if (!m[k]) bad(`meta.${k} is required (every source carries its licence and attribution)`);
    for (const f of m.publishes || []) if (!FILTERS[f]) bad(`meta.publishes names unknown filter "${f}" (tools/schools/filters.mjs)`);
    if (m.displayCase != null && !['en', 'es'].includes(m.displayCase)) bad(`meta.displayCase "${m.displayCase}" (want 'en' or 'es': the page's title-case rules for a source that publishes in capitals)`);
    for (const [id, sc] of Object.entries(s.schemes || {})) {
      const p = schemeProblems(id, sc); if (p.length) bad(p.join('; '));
    }
    list.push(s);
  }
  return list;
}

export async function loadRatings(dir = RATINGS_DIR) {
  const list = [];
  for (const { file, mod: r } of await loadDir(dir)) {
    const where = `ratings/${file}`;
    const bad = m => { throw new Error(`${where}: ${m} (see tools/schools/README.md)`); };
    if (basename(file, '.mjs') !== r.scheme) bad(`the file must be named after its scheme id ("${r.scheme}.mjs")`);
    if (!Array.isArray(r.juris) || !r.juris.length) bad('juris is required');
    for (const j of r.juris) if (!JURIS[j]) bad(`unknown jurisdiction ${j}`);
    if (!Array.isArray(r.sources) || !r.sources.length) bad('sources (the row.src values it rates) is required');
    if (!r.record || !['rating', 'status'].includes(r.record.kind)) bad('record.kind must be "rating" or "status"');
    const p = schemeProblems(r.scheme, r.record); if (p.length) bad(p.join('; '));
    if (typeof r.build !== 'function') bad('no build(ctx)');
    if (!(r.floor > 0 && r.floor <= 1)) bad('floor (minimum match share, 0–1) is required');
    list.push(r);
  }
  return list;
}
