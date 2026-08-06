#!/usr/bin/env node
// tools/check-app-facts.mjs
//
// Keeps the hand-written App Store facts on the site true.
//
// WHY THIS EXISTS
// index.html states "Requires iOS 16.4+". Nothing produced that number — it was
// typed, and it silently became wrong the moment 1.2.3 lowered the deployment
// target from 26.4 to 16.4. For however long that lasted, the homepage told
// every visitor on an older iPhone that they could not install an app they
// could, which is the most expensive kind of stale copy: it turns away the
// exact people a version-floor drop was meant to reach. A content review caught
// it. A content review is not a control.
//
// The App Store is the authority for what the app requires, so this copies its
// answer rather than checking a second hand-maintained number against the
// first. Run in the monthly rebuild, the site self-corrects the next time it
// builds — no one has to remember.
//
// WHY IT DOES NOT FAIL THE BUILD
// An unreachable iTunes endpoint is not a content error, and killing a
// 25-minute page rebuild over a transient 5xx would trade a rare stale line for
// a regular dead rebuild. Unreachable → warn and carry on. Only --check (used
// by hand, or by a future dedicated job) exits non-zero, and only on a genuine
// mismatch it could see.
//
// Usage:
//   node tools/check-app-facts.mjs           fix in place, always exit 0
//   node tools/check-app-facts.mjs --check    report only, exit 1 on mismatch

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const APP_ID = '6768244297';
const CHECK_ONLY = process.argv.includes('--check');

// Every file that states a requirement, and the pattern that finds it. Add a
// row here rather than a second script when a new page repeats the claim.
const TARGETS = [
  { file: 'index.html', re: /Requires iOS (\d+(?:\.\d+)*)\+/g, label: 'Requires iOS <v>+' },
];

async function appFacts() {
  // country=us: the lookup is per-storefront and an unknown/unlisted country
  // returns resultCount 0, which would read as "app not found" and mask a real
  // answer. The app is listed in the US store.
  const url = `https://itunes.apple.com/lookup?id=${APP_ID}&country=us`;
  const r = await fetch(url, { signal: AbortSignal.timeout(20_000) });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const j = await r.json();
  const app = (j.results || [])[0];
  if (!app) throw new Error('app not found in lookup');
  if (!app.minimumOsVersion) throw new Error('lookup carries no minimumOsVersion');
  return { minOs: String(app.minimumOsVersion), version: String(app.version || '?') };
}

let facts;
try {
  facts = await appFacts();
} catch (e) {
  // Deliberately exit 0: see WHY IT DOES NOT FAIL THE BUILD above.
  console.warn(`[app-facts] could not reach the App Store lookup (${e.message}) — leaving copy untouched`);
  process.exit(0);
}

console.log(`[app-facts] App Store says: version ${facts.version}, minimum iOS ${facts.minOs}`);

let mismatches = 0;
for (const t of TARGETS) {
  const path = join(ROOT, t.file);
  const before = readFileSync(path, 'utf8');
  const found = [...before.matchAll(t.re)].map(m => m[1]);
  if (!found.length) {
    // The claim vanishing is itself worth knowing — silence here would mean the
    // guard quietly stops guarding after an unrelated redesign.
    console.warn(`[app-facts] ${t.file}: no "${t.label}" found — guard is not covering this file`);
    continue;
  }
  const wrong = found.filter(v => v !== facts.minOs);
  if (!wrong.length) {
    console.log(`[app-facts] ${t.file}: ${found.length}× "${t.label}" — all correct (${facts.minOs})`);
    continue;
  }
  mismatches += wrong.length;
  if (CHECK_ONLY) {
    console.error(`[app-facts] ${t.file}: states ${[...new Set(wrong)].join(', ')} but the App Store requires ${facts.minOs}`);
    continue;
  }
  const after = before.replace(t.re, `Requires iOS ${facts.minOs}+`);
  writeFileSync(path, after);
  console.log(`[app-facts] ${t.file}: corrected ${wrong.length}× ${[...new Set(wrong)].join(', ')} → ${facts.minOs}`);
}

if (CHECK_ONLY && mismatches) process.exit(1);
