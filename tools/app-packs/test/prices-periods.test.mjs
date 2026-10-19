// node --test tools/app-packs/test/*.test.mjs
// H5: the periods and context labels the app rebuilds from their fields
// (lib/prices-periods.mjs), against every published string of the real index
// and the real rows. (The gate's failures are in prices-text.test.mjs.)
import test from 'node:test';
import assert from 'node:assert/strict';
import { packPrices } from '../lib/prices.mjs';
import { periodOf, spanOf, periodForm, contextForm, contextLabelOf, periodProblems, MONTHS_SHORT } from '../lib/prices-periods.mjs';
import { realPrices, LANDING, fieldIndex } from './helpers.mjs';

async function real() {
  const { input, rules } = await realPrices();
  const { pack, ...index } = JSON.parse(packPrices(input, rules, LANDING).json);
  const F = fieldIndex(input.index), ids = Object.keys(input.index.sources);
  const contexts = input.tiles.flatMap(([, t]) => { const x = JSON.parse(t); return x.a.filter(r => r[F.ctx] != null).map(r => [ids[r[F.src]], x.c[r[F.ctx]]]); });
  return { index, contexts };
}

test('every published period, span and context label rebuilds exactly', async () => {
  const { index } = await real();
  for (const [id, s] of Object.entries(index.sources)) assert.equal(periodOf(s), s.period, id);
  for (const s of Object.values(index.sources)) if (s.window) assert.equal(spanOf(s.window), s.window.span);
  assert.equal(periodOf({ vintage: '12m-to-2026-03' }), '12 months to March 2026');
  assert.equal(periodOf({ vintage: '2021', cadence: 'static' }), '2021 Census (May 2021)');
  assert.equal(periodOf({ window: { by: 'recording', from: '2025-09', to: '2026-08' } }), 'Sales recorded Sep 2025 – Aug 2026');
  assert.equal(MONTHS_SHORT[8], 'Sep');                    // never en-GB's "Sept"
  assert.equal(periodForm({ vintage: '2019', cadence: 'monthly' }), null);
  const acs = index.sources['acs-tract'], ni = index.sources['ni-ward'];
  const f = contextForm('Median home value (owners’ estimate), 2020–24 survey', acs);
  assert.deepEqual(f, { form: 'acs', metric: acs.metric, a: 2020, b: 2024 });
  const w = contextForm('Median sale price, wider area (Antrim and Newtownabbey DEA ‘Airport’), 2025', ni);
  assert.equal(w.place, 'Antrim and Newtownabbey DEA ‘Airport’');
  assert.equal(contextLabelOf(w), 'Median sale price, wider area (Antrim and Newtownabbey DEA ‘Airport’), 2025');
  assert.equal(contextForm('Median sale price, wider area (X), 2024', ni), null);   // not the source's year
});

test('the gate on the real rows: 10 sources, 41 scales, 53 context labels, nothing unknown', async () => {
  const { index, contexts } = await real();
  const r = periodProblems(index, contexts);
  assert.deepEqual(r.problems, []);
  assert.equal(r.labels, 53);
  assert.deepEqual(new Set(Object.values(r.forms)), new Set(['acs5', 'calendarYear', 'twelveMonthsTo', 'census', 'window']));
});
