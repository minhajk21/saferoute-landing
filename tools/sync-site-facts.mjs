#!/usr/bin/env node
// tools/sync-site-facts.mjs
//
// Keeps the homepage's coverage numbers true by copying them from the files
// that actually define them, rather than trusting a hand-typed second copy.
//
// WHY THIS EXISTS
// The homepage said "1,376 neighborhood reports" and "1,376 areas across
// thirteen cities" long after the site had grown to 2,575 areas in 26 cities —
// nearly double, and missing every UK city outside London. Nothing produced
// those numbers; they were typed once and left. The same failure as the iOS
// version floor that check-app-facts.mjs now owns, and the same fix: the
// generator is the authority, so read the generator's output.
//
// HOW IT FINDS THE NUMBERS
// Any element carrying data-fact="<name>" has its text replaced with the
// current value. Markers rather than regexes over prose, so rewording a
// sentence can never silently stop a number updating.
//
//   areas          total areas in safety/search-index.json (written by
//                  render-pages.mjs — the same list the in-page lookup searches)
//   cities         distinct cities in that index
//   schools        schools on the map (schools/data/tiles/index.json)
//   city:<slug>    areas in one city
//
// A number it cannot compute is left exactly as it was and reported — never
// blanked, never zeroed. A missing fact is a warning; a wrong fact is the
// thing this exists to prevent.
//
// Usage:
//   node tools/sync-site-facts.mjs           fix in place (homepage + /check/)
//   node tools/sync-site-facts.mjs --check    report only, exit 1 on any drift

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CHECK_ONLY = process.argv.includes('--check');
const PAGES = ['index.html', 'check/index.html'];

const fmt = n => n.toLocaleString('en-GB');

function computeFacts() {
  const facts = {};
  const idxPath = join(ROOT, 'safety', 'search-index.json');
  if (existsSync(idxPath)) {
    const areas = JSON.parse(readFileSync(idxPath, 'utf8'));
    facts.areas = fmt(areas.length);
    const byCity = {};
    for (const a of areas) byCity[a.c] = (byCity[a.c] || 0) + 1;
    facts.cities = String(Object.keys(byCity).length);
    for (const [c, n] of Object.entries(byCity)) facts[`city:${c}`] = fmt(n);
  }
  const schoolPath = join(ROOT, 'schools', 'data', 'tiles', 'index.json');
  if (existsSync(schoolPath)) {
    const s = JSON.parse(readFileSync(schoolPath, 'utf8'));
    if (Number.isFinite(s.count)) facts.schools = fmt(s.count);
  }
  return facts;
}

const facts = computeFacts();
let drift = 0, missing = 0;

for (const page of PAGES) {
  const path = join(ROOT, page);
  const before = readFileSync(path, 'utf8');
  const after = before.replace(/(<([a-z0-9]+)\b[^>]*\bdata-fact="([^"]+)"[^>]*>)([^<]*)(<\/\2>)/gi,
    (whole, open, _tag, name, text, close) => {
      if (!(name in facts)) {
        console.warn(`  ${page}: no value for data-fact="${name}" — left as "${text}"`);
        missing++;
        return whole;
      }
      if (text !== facts[name]) {
        console.log(`  ${page}: ${name}  "${text}" -> "${facts[name]}"`);
        drift++;
      }
      return open + facts[name] + close;
    });
  if (!CHECK_ONLY && after !== before) writeFileSync(path, after);
}

console.log(`  site facts: ${drift} updated, ${missing} unresolved` + (CHECK_ONLY ? ' (check only)' : ''));
if (CHECK_ONLY && drift) process.exit(1);
