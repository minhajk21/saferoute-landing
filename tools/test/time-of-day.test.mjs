// node --test tools/test/*.test.mjs
// The time-of-day gate (tools/time-of-day.mjs), and the built /safety/ pages
// it governs. A mix flagged timeOfDayIsRealData:false must never be drawn or
// quoted: San Diego and Vancouver send a date only, Minneapolis and Long Beach
// the time a report was filed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { realTimeOfDay } from '../time-of-day.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

test('gate: a real six-bucket mix passes through unchanged', () => {
  const tod = [0.3, 0.2, 0.1, 0.2, 0.1, 0.1];
  assert.equal(realTimeOfDay({ timeOfDay: tod, timeOfDayIsRealData: true }), tod);
});
test('gate: an explicit false withholds the mix (San Diego date-only shape)', () => {
  // tools/data-cache/sandiego/balboa-park.json as fetched
  assert.equal(realTimeOfDay({ timeOfDay: [0.7, 0, 0, 0.3, 0, 0], timeOfDayIsRealData: false }), null);
});
test('gate: a cache record with no flag counts as real, as it always has', () => {
  const tod = [0.3, 0.2, 0.1, 0.2, 0.1, 0.1];
  assert.equal(realTimeOfDay({ timeOfDay: tod }), tod);
});
test('gate: no mix, a short mix or no record gives null', () => {
  assert.equal(realTimeOfDay({ timeOfDay: null, timeOfDayIsRealData: false }), null);
  assert.equal(realTimeOfDay({ timeOfDay: null, timeOfDayIsRealData: true }), null);
  assert.equal(realTimeOfDay({ timeOfDay: [0.5, 0.5], timeOfDayIsRealData: true }), null);
  assert.equal(realTimeOfDay({ timeOfDay: 'x'.repeat(6), timeOfDayIsRealData: true }), null);
  assert.equal(realTimeOfDay(null), null);
  assert.equal(realTimeOfDay(undefined), null);
});

// The built pages against the committed data cache. Run after render-pages.mjs.
const TOD_HEADING = '<h2>When it happens</h2>';
// The area page's timing sentence, by the end of each of its three wordings
// (makeProse `when`), and the share its "safe at night?" answer quotes.
const TOD_WHEN = /overnight \(midnight–6 a\.m\.\)|\(6 p\.m\.–midnight\) and \d+% overnight\./;
const TOD_NIGHT = /between 6 p\.m\. and 6 a\.m\./;
// Any of the above, plus a looser net for a reworded sentence, for the pages
// that must quote none of it.
const TOD_PROSE = /severity-weighted (reports|incidents)[^<]*overnight|overnight \(midnight|between 6 p\.m\. and 6 a\.m\./;

let byFlag;
function pagesByFlag() {
  return byFlag ??= readPages();
}
function readPages() {
  const cache = join(ROOT, 'tools', 'data-cache');
  const out = { fake: [], real: [] };
  for (const city of readdirSync(cache)) {
    const dir = join(cache, city);
    if (city.endsWith('-basemap') || !existsSync(join(ROOT, 'safety', city))) continue;
    let files;
    try { files = readdirSync(dir).filter(f => f.endsWith('.json')); } catch { continue; }
    for (const f of files) {
      const a = JSON.parse(readFileSync(join(dir, f), 'utf8'));
      const page = join(ROOT, 'safety', city, a.slug, 'index.html');
      if (!existsSync(page)) continue;            // below the publish floor
      const real = realTimeOfDay(a) != null;
      if (!real && !(Array.isArray(a.timeOfDay) && a.timeOfDay.length >= 6)) continue;
      const html = readFileSync(page, 'utf8');
      const hasWhen = TOD_WHEN.test(html), hasNight = TOD_NIGHT.test(html);
      const row = { city, slug: a.slug, hasHeading: html.includes(TOD_HEADING), hasWhen, hasNight,
        hasProse: hasWhen || hasNight || TOD_PROSE.test(html) };
      (real ? out.real : out.fake).push(row);
    }
  }
  return out;
}

test('pages: no area page draws or quotes a mix that is not real', () => {
  const { fake } = pagesByFlag();
  const bad = fake.filter(p => p.hasHeading || p.hasProse).map(p => `${p.city}/${p.slug}`);
  assert.deepEqual(bad, [], `${bad.length} of ${fake.length} pages still show a time-of-day mix`);
});
// The other side of the gate: a real mix keeps the chart AND both sentences
// built from it. Checking the heading alone would pass a gate that withheld
// the timing sentence or the night share from cities whose times are real.
test('pages: areas with a real mix keep the chart, the timing sentence and the night share', () => {
  const { real } = pagesByFlag();
  assert.ok(real.length > 0);
  const missing = real.flatMap(p => [
    ...(p.hasHeading ? [] : [`${p.city}/${p.slug}: chart`]),
    ...(p.hasWhen ? [] : [`${p.city}/${p.slug}: timing sentence`]),
    ...(p.hasNight ? [] : [`${p.city}/${p.slug}: night share`]),
  ]);
  assert.deepEqual(missing, [], `${missing.length} gaps across ${real.length} pages with a real mix`);
});

// A city with no real mix in any area has no chart and no night page, so its
// hubs must not promise either: the methodology once said "Time-of-day charts
// use ... incident timestamps" for Minneapolis and Vancouver, and eight hub
// descriptions said "night-time patterns".
const HUB_CLAIM = /Time-of-day charts use|night-time patterns/;
test('hubs: a city with no real mix neither promises a chart nor has a night page', () => {
  const cache = join(ROOT, 'tools', 'data-cache');
  const bad = [];
  let checked = 0;
  for (const city of readdirSync(cache)) {
    const site = join(ROOT, 'safety', city);
    if (city.endsWith('-basemap') || !existsSync(join(site, 'index.html'))) continue;
    const areas = readdirSync(join(cache, city)).filter(f => f.endsWith('.json'))
      .map(f => JSON.parse(readFileSync(join(cache, city, f), 'utf8')));
    if (areas.some(a => realTimeOfDay(a))) continue;
    checked++;
    const districts = join(site, 'district');
    const hubs = [join(site, 'index.html'), ...(existsSync(districts)
      ? readdirSync(districts).map(d => join(districts, d, 'index.html')).filter(existsSync) : [])];
    for (const h of hubs) if (HUB_CLAIM.test(readFileSync(h, 'utf8'))) bad.push(h.slice(ROOT.length + 1));
    if (existsSync(join(site, 'night'))) bad.push(`safety/${city}/night/`);
  }
  assert.ok(checked > 0);
  assert.deepEqual(bad, []);
});
