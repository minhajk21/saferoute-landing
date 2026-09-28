#!/usr/bin/env node
// Writes tools/data/coverage.json: every crime-data region's rectangle, in the
// backend's PROVIDERS order, read from the backend's own source.
//
// WHY. The schools layer covers exactly where SafeRoute has crime data (scope
// rule R2: each city's covers() rectangle, limited to that city's own state,
// province or entity). The backend owns coverage; this repo must never keep a
// hand-typed second copy of 30 rectangles that drifts the day a city's box
// moves. So the rectangles are READ from saferoute-backend/src/providers and
// committed here as data, and the schools build reads only the committed file
// (it never needs the backend checked out).
//
// HOW, and why it can be trusted:
//   1. src/providers/index.js gives the PROVIDERS order (first match wins where
//      boxes overlap: Long Beach is listed before Los Angeles).
//   2. Each provider file's covers() gives its rectangle. A provider that
//      exports BBOX = { minLat, maxLat, minLng, maxLng } is read from that
//      instead (the design asks the backend to add it; nothing depends on it).
//   3. PROOF: the backend's real covers() is then imported and probed — a grid
//      of points inside each rectangle, and points just outside every edge. A
//      rectangle is written only if covers() is false everywhere outside it and
//      (for a plain box) true everywhere inside. Boston's city polygon and the
//      Los Angeles / Houston enclaves make covers() narrower than the box; those
//      are recorded as `refined`, with the share of inside probes covered. R2
//      deliberately uses the rectangle, not the refinement (DESIGN.md §0).
//
// Usage:
//   node tools/schools/lib/coverage-from-backend.mjs [--backend <dir>] [--out <file>] [--check]
//     --backend  saferoute-backend checkout (default: ../saferoute-backend next
//                to this repo, or $SAFEROUTE_BACKEND)
//     --check    compare with the committed file and exit 1 if it would change
//
// Output: { generated, backend: { commit }, regions: [{ id, country, bbox: [s, w, n, e], refined }] }

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const argv = process.argv.slice(2);
const arg = (n, d) => (argv.includes(n) ? argv[argv.indexOf(n) + 1] : d);
const BACKEND = resolve(arg('--backend', process.env.SAFEROUTE_BACKEND || join(ROOT, '..', 'saferoute-backend')));
const OUT = resolve(arg('--out', join(ROOT, 'tools', 'data', 'coverage.json')));
const CHECK = argv.includes('--check');
const PROV = join(BACKEND, 'src', 'providers');

const stripComments = s => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"])\/\/.*$/gm, '$1');
const NUM = '(-?\\d+(?:\\.\\d+)?)';

function providerOrder() {
  const src = readFileSync(join(PROV, 'index.js'), 'utf8');
  const imports = new Map([...src.matchAll(/import\s*\{\s*(\w+)\s*\}\s*from\s*'\.\/(\w+\.js)'/g)].map(m => [m[1], m[2]]));
  const block = /const PROVIDERS\s*=\s*\[([\s\S]*?)\];/.exec(src);
  if (!block) throw new Error('src/providers/index.js: no "const PROVIDERS = [ … ];" block');
  const names = stripComments(block[1]).split(',').map(s => s.trim()).filter(Boolean);
  return names.map(n => {
    if (!imports.has(n)) throw new Error(`PROVIDERS lists ${n}, which index.js does not import from a local file`);
    return { name: n, file: imports.get(n) };
  });
}

function readProvider(file) {
  const raw = readFileSync(join(PROV, file), 'utf8');
  const src = stripComments(raw);
  const ids = [...new Set([...src.matchAll(/^\s{2}id:\s*'([^']+)'/gm)].map(m => m[1]))];
  if (ids.length !== 1) throw new Error(`${file}: expected one provider id, found [${ids}]`);
  const country = (/^\s{2}country:\s*'([^']+)'/m.exec(src) || [])[1] || null;

  let bbox = null, how, refinedCalls = [];
  const exp = /export\s+const\s+BBOX\s*=\s*\{([^}]*)\}/.exec(src);
  if (exp) {
    const g = k => { const m = new RegExp(`${k}\\s*:\\s*${NUM}`).exec(exp[1]); if (!m) throw new Error(`${file}: BBOX has no ${k}`); return +m[1]; };
    bbox = [g('minLat'), g('minLng'), g('maxLat'), g('maxLng')]; how = 'BBOX';
  } else {
    // covers body: `function covers(lat, lng) { … }` or `covers: (lat, lng) => …,`
    let body = null;
    const fn = /function covers\s*\(\s*lat\s*,\s*lng\s*\)\s*\{([\s\S]*?)\n\}/.exec(src);
    if (fn) body = fn[1];
    const arrow = /covers:\s*\(\s*lat\s*,\s*lng\s*\)\s*=>\s*([^\n]*)/.exec(src);
    if (!body && arrow) body = arrow[1];
    if (!body) throw new Error(`${file}: cannot find covers()`);
    const re = new RegExp(`lat\\s*>=\\s*${NUM}\\s*&&\\s*lat\\s*<=\\s*${NUM}\\s*&&\\s*lng\\s*>=\\s*${NUM}\\s*&&\\s*lng\\s*<=\\s*${NUM}`, 'g');
    const boxes = [...body.matchAll(re)];
    if (boxes.length !== 1) throw new Error(`${file}: expected one lat/lng rectangle in covers(), found ${boxes.length}`);
    const [, s, n, w, e] = boxes[0].map(Number);
    bbox = [s, w, n, e]; how = 'covers()';
    refinedCalls = [...body.matchAll(/\b(in[A-Z]\w*|boundaryTest)\s*\(([^)]*)\)/g)].map(m => `${m[1]}(${m[2].trim()})`);
  }
  const [s, w, n, e] = bbox;
  if (!(s < n && w < e && s >= -90 && n <= 90 && w >= -180 && e <= 180)) throw new Error(`${file}: implausible rectangle [${bbox}]`);
  return { id: ids[0], country, bbox, how, refinedCalls };
}

// Probe the real covers(): outer bound everywhere, full box unless refined.
async function prove(regions) {
  const mod = await import(pathToFileURL(join(PROV, 'index.js')).href);
  const out = [];
  for (const r of regions) {
    const p = mod.getProviderById(r.id);
    if (!p) throw new Error(`backend getProviderById("${r.id}") returned nothing`);
    const [s, w, n, e] = r.bbox, eps = 1e-4, K = 9;
    let inside = 0, covered = 0;
    for (let i = 0; i < K; i++) for (let j = 0; j < K; j++) {
      inside++;
      if (p.covers(s + (n - s) * (i + 0.5) / K, w + (e - w) * (j + 0.5) / K)) covered++;
    }
    for (let i = 0; i <= K; i++) {
      const lat = s + (n - s) * i / K, lng = w + (e - w) * i / K;
      for (const [a, b] of [[s - eps, lng], [n + eps, lng], [lat, w - eps], [lat, e + eps]]) {
        if (p.covers(a, b)) throw new Error(`${r.id}: covers(${a}, ${b}) is true OUTSIDE the parsed rectangle [${r.bbox}] — the parse is wrong`);
      }
    }
    // The corners themselves are inside (covers() uses >= and <=).
    if (!r.refinedCalls.length) {
      if (covered !== inside) throw new Error(`${r.id}: covers() is false at ${inside - covered} of ${inside} points inside a plain rectangle — the parse is wrong`);
      if (!p.covers(s, w) || !p.covers(n, e)) throw new Error(`${r.id}: covers() false on the rectangle's own corners`);
    } else if (!covered) throw new Error(`${r.id}: covers() false everywhere inside [${r.bbox}]`);
    // country from the live provider object: factory-built providers
    // (makeArcgisProvider…) set it where a text parse cannot see it.
    out.push({ ...r, country: p.country ?? r.country, insideCovered: +(covered / inside).toFixed(3) });
  }
  return out;
}

const order = providerOrder();
const parsed = order.map(({ file }) => readProvider(file));
const ids = parsed.map(r => r.id);
if (new Set(ids).size !== ids.length) throw new Error(`duplicate provider ids: ${ids}`);
const proved = await prove(parsed);

let commit = null;
try { commit = execFileSync('git', ['-C', BACKEND, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(); } catch {}

const doc = {
  note: 'Generated by tools/schools/lib/coverage-from-backend.mjs from saferoute-backend src/providers (PROVIDERS order). Do not edit by hand.',
  generated: new Date().toISOString().slice(0, 10),
  backend: { repo: 'saferoute-backend', commit },
  bboxOrder: '[minLat, minLng, maxLat, maxLng]',
  regions: proved.map(r => ({
    id: r.id, country: r.country, bbox: r.bbox,
    // covers() is narrower than the rectangle here (a city polygon or enclaves);
    // insideCovered is the share of a 9x9 probe grid it accepts.
    refined: r.refinedCalls.length ? { calls: r.refinedCalls, insideCovered: r.insideCovered } : null,
  })),
};

const same = (a, b) => JSON.stringify({ ...a, generated: 0, backend: 0 }) === JSON.stringify({ ...b, generated: 0, backend: 0 });
if (CHECK) {
  const cur = existsSync(OUT) ? JSON.parse(readFileSync(OUT, 'utf8')) : null;
  if (!cur || !same(cur, doc)) { console.error(`coverage.json is out of date with ${BACKEND} — run without --check`); process.exit(1); }
  console.log(`coverage.json matches the backend (${doc.regions.length} regions)`);
} else {
  const cur = existsSync(OUT) ? JSON.parse(readFileSync(OUT, 'utf8')) : null;
  if (cur && same(cur, doc)) doc.generated = cur.generated;   // no churn when nothing changed
  mkdirSync(dirname(OUT), { recursive: true });
  // One region per line: reviewable in a diff, and a moved box is one line.
  const { regions, ...head } = doc;
  const text = JSON.stringify(head, null, 1).replace(/\n}$/, ',\n "regions": [\n' +
    regions.map(r => '  ' + JSON.stringify(r)).join(',\n') + '\n ]\n}\n');
  JSON.parse(text);   // must still be valid JSON
  writeFileSync(OUT, text);
  console.log(`wrote ${OUT}: ${doc.regions.length} regions` +
    `, refined: ${doc.regions.filter(r => r.refined).map(r => r.id).join(', ') || 'none'} (backend ${commit?.slice(0, 9) ?? 'unknown commit'})`);
}
process.exit(0);   // the backend's modules may hold timers open
