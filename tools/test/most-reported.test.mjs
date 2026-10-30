// node --test tools/test/*.test.mjs
// The order an area's categories read in where they are shown as counts or the
// largest is named (tools/most-reported.mjs, and byCount in check/index.html),
// and the built /safety/ pages it governs. The backend sends the breakdown by
// count x severity weight, so read as it came, SoHo's table listed Violent
// crime 528 above Public order 607 and abbey-road called violent crime (80)
// "the largest reported category" over anti-social behaviour (91).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mostReported } from '../most-reported.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const ids = list => list.map(c => c.category);

// tools/data-cache/london/abbey-road.json as fetched, in the backend's order
const ABBEY_ROAD = [
  { category: 'violent-crime', count: 80, weight: 10 }, { category: 'anti-social-behaviour', count: 91, weight: 5 },
  { category: 'burglary', count: 21, weight: 7 }, { category: 'other-theft', count: 36, weight: 4 },
  { category: 'public-order', count: 20, weight: 6 }, { category: 'vehicle-crime', count: 25, weight: 4 },
  { category: 'theft-from-the-person', count: 15, weight: 6 }, { category: 'drugs', count: 14, weight: 5 },
  { category: 'shoplifting', count: 30, weight: 2 }, { category: 'robbery', count: 5, weight: 9 },
];

test('order: the highest count first', () => {
  assert.deepEqual(ids(mostReported(ABBEY_ROAD)).slice(0, 6),
    ['anti-social-behaviour', 'violent-crime', 'other-theft', 'shoplifting', 'vehicle-crime', 'burglary']);
});
test('order: equal counts keep the backend order (the more severe first), then go by id', () => {
  const tied = [
    { category: 'robbery', count: 7, weight: 9 }, { category: 'drugs', count: 7, weight: 5 },
    { category: 'burglary', count: 7, weight: 5 }, { category: 'shoplifting', count: 9, weight: 2 },
  ];
  assert.deepEqual(ids(mostReported(tied)), ['shoplifting', 'robbery', 'burglary', 'drugs']);
  // The same categories in any arrival order give the same list.
  assert.deepEqual(ids(mostReported(tied.slice().reverse())), ids(mostReported(tied)));
});
test('order: a sorted copy; the cached record is left in the backend order', () => {
  const bd = ABBEY_ROAD.slice();
  mostReported(bd);
  assert.deepEqual(bd, ABBEY_ROAD);
  assert.deepEqual(mostReported(undefined), []);
  assert.deepEqual(mostReported(null), []);
});

// check/index.html sorts in the browser; its byCount must give the same order.
test('/check/: byCount orders as the pages do', () => {
  const page = readFileSync(join(ROOT, 'check', 'index.html'), 'utf8');
  const m = /^function byCount\(.*$/m.exec(page);
  assert.ok(m, 'byCount not found in check/index.html');
  const byCount = new Function(`${m[0]}; return byCount;`)();
  const shuffled = [...ABBEY_ROAD.slice(5), ...ABBEY_ROAD.slice(0, 5)];
  assert.deepEqual(ids(shuffled.slice().sort(byCount)), ids(mostReported(ABBEY_ROAD)));
  // The hex popup's categories carry the area's weight, or none.
  const hex = [{ category: 'drugs', count: 2 }, { category: 'burglary', count: 2 }, { category: 'robbery', count: 1 }];
  assert.deepEqual(ids(hex.sort(byCount)), ['burglary', 'drugs', 'robbery']);
  // Both sorts in the page use it, the area list and the hex popup.
  assert.equal(page.match(/\.sort\(byCount\)/g)?.length, 2);
});

// The built pages against the committed data cache. Run after render-pages.mjs.
const ROWS = /<tr><td>([^<]*)<\/td><td style="width:38%"><div class="sharebar"><i style="width:\d+%"><\/i><\/div><\/td><td class="n">([\d,]+) · /g;
const MIX = /<p>(The largest [^<]*? category here is|Most of [^<]*? here is property-related —) <strong>([^<]*)<\/strong>/;
const FAQ = /<p>([^<]*?) — ([\d,]+) of [\d,]+ incidents \(\d+%\)/;
const VIOLENT = ['violent crime', 'robbery', 'sexual offences', 'weapons possession'];
const PROPERTY = ['burglary', 'vehicle crime', 'other theft', 'shoplifting', 'bicycle theft', 'theft from a person', 'criminal damage & arson'];
const prose = label => (label === 'Other' ? 'Other crime' : label.replace(/&amp;/g, '&')).toLowerCase();
const num = s => Number(s.replace(/,/g, ''));

let pages;
function readPages() {
  if (pages) return pages;
  const cache = join(ROOT, 'tools', 'data-cache');
  pages = [];
  for (const city of readdirSync(cache)) {
    if (city.endsWith('-basemap') || !existsSync(join(ROOT, 'safety', city))) continue;
    for (const f of readdirSync(join(cache, city)).filter(f => f.endsWith('.json'))) {
      const a = JSON.parse(readFileSync(join(cache, city, f), 'utf8'));
      const page = join(ROOT, 'safety', city, a.slug, 'index.html');
      if (!existsSync(page) || !(a.breakdown || []).length) continue;     // below the publish floor
      const html = readFileSync(page, 'utf8');
      const table = (html.match(/<table class="cats">([\s\S]*?)<\/table>/) || [])[1] || '';
      pages.push({ id: `${city}/${a.slug}`, a, rows: [...table.matchAll(ROWS)].map(m => ({ name: m[1], n: num(m[2]) })),
        mix: html.match(MIX), faq: html.match(FAQ) });
    }
  }
  return pages;
}

test('pages: every table reads highest count first, and its first row is the largest in the data', () => {
  const all = readPages();
  assert.ok(all.length > 2000);
  const bad = all.filter(p => !p.rows.length || p.rows.some((r, i) => i && r.n > p.rows[i - 1].n)
    || p.rows[0].n !== Math.max(...p.a.breakdown.map(c => c.count))).map(p => p.id);
  assert.deepEqual(bad, [], `${bad.length} of ${all.length} tables`);
});
test('pages: "the largest category" and "the most common crime" both name the first row', () => {
  const bad = readPages().flatMap(p => {
    const top = prose(p.rows[0].name);
    return [
      ...(p.mix && p.mix[2] === top ? [] : [`${p.id}: sentence names ${p.mix?.[2]}, table ${top}`]),
      ...(p.faq && p.faq[1].toLowerCase() === top && num(p.faq[2]) === p.rows[0].n ? [] : [`${p.id}: FAQ ${p.faq?.[1]}`]),
    ];
  });
  assert.deepEqual(bad, []);
});
test('pages: "property-related" only of a property category, and only when property is most of it', () => {
  const PROP_IDS = ['burglary', 'vehicle-crime', 'other-theft', 'shoplifting', 'bicycle-theft', 'theft-from-the-person', 'criminal-damage-arson'];
  const all = readPages();
  const bad = all.filter(p => p.mix?.[1].startsWith('Most')).filter(p => {
    const share = p.a.breakdown.filter(c => PROP_IDS.includes(c.category)).reduce((s, c) => s + c.count, 0) / p.a.totalIncidents;
    return !PROPERTY.includes(p.mix[2]) || share <= 0.5;
  }).map(p => p.id);
  assert.deepEqual(bad, []);
  // and the warning about walking at night stays with the violent categories
  assert.ok(all.some(p => p.mix && VIOLENT.includes(p.mix[2])));
});
