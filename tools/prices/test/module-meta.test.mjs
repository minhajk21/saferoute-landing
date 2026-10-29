// node --test tools/prices/test/*.test.mjs
// lib/module-meta.mjs: when a source re-emits its snapshot, build-prices warns
// if the module's meta has changed since the published build. A source that
// stamps its attribution at fetch time with the version of what it read
// ("data as of <date>"; NYC also names the annualized workbooks and the PLUTO
// release it used) must not read as changed for those stamps alone: before
// this, every --only build of another source warned "nyc-dof-sales meta
// differs from the published build's" though nothing in its module had
// changed. A real change to what the module states must still warn.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { metaOf, moduleMeta, metaDiffers, unstamped } from '../lib/module-meta.mjs';
import { loadSource } from '../lib/schema.mjs';
import nyc from '../sources/nyc-dof-sales.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const published = id => metaOf(JSON.parse(readFileSync(join(ROOT, 'prices', 'data', 'index.json'), 'utf8')).sources[id]);
const clone = o => JSON.parse(JSON.stringify(o));

// The module's own lines, stamped the way a fetch stamps them (metaFor's
// facts), with whatever dates, workbooks and release we like.
function stampNyc(meta, { rolling = '2027-01-15', annual = [[2025, '2026-05-04']], pluto = '27v1', taxMap = '2027-01-02' } = {}) {
  const m = clone(meta);
  const years = annual.map(([y, d]) => ` and Annualized Sales ${y} (DOF's workbooks on nyc.gov, also published as NYC Open Data w2pb-icbu; Property Tax System data as of ${d})`).join('');
  m.attribution[0] = m.attribution[0].replace('data as of unknown)', `data as of ${rolling})${years}`);
  m.attribution[1] = m.attribution[1].replace('PLUTO (', `PLUTO ${pluto} (`).replace('p8u6-a6it)', `p8u6-a6it, data as of ${taxMap})`);
  return m;
}

test('nyc-dof-sales: the published meta is what its module says, once the fetch-time stamps are left out', () => {
  const pub = published('nyc-dof-sales');
  // The stamps are really there: the raw lines differ from the module's.
  assert.notDeepEqual(pub.attribution, nyc.meta.attribution);
  assert.match(pub.attribution[0], /data as of \d{4}-\d{2}-\d{2}\) and Annualized Sales \d{4} /);
  assert.match(pub.attribution[1], /PLUTO \w+ \(/);
  // ...and are all that differs: no warning.
  assert.equal(metaDiffers(nyc, pub), false);
  assert.deepEqual(moduleMeta(pub, nyc).attribution, moduleMeta({ ...nyc.meta }, nyc).attribution);
});

test('the stamps are left out whatever their dates, workbooks and release', () => {
  for (const facts of [{}, { annual: [] }, { annual: [[2024, '2025-04-08'], [2025, '2026-05-04']] }, { rolling: '2026-12-01', pluto: '26v3', taxMap: '2026-11-30' }]) {
    assert.equal(metaDiffers(nyc, stampNyc(nyc.meta, facts)), false, JSON.stringify(facts));
  }
  // Any source's "data as of", with no stamps of its own: the ISO day, 'unknown'
  // before a fetch, a US date; a stamp present only after a fetch, with its comma.
  const src = { id: 'x', kind: 'point-sales', meta: { attribution: ['Source: A Table (Open Data abcd-1234, data as of unknown). B (Open Data efgh-5678).'] } };
  for (const line of [
    'Source: A Table (Open Data abcd-1234, data as of 2026-10-01). B (Open Data efgh-5678).',
    'Source: A Table (Open Data abcd-1234, data as of 10/01/2026). B (Open Data efgh-5678, data as of 2026-09-30).',
  ]) assert.equal(metaDiffers(src, { ...src.meta, attribution: [line] }), false, line);
  assert.equal(unstamped('Property Tax System data as of 2026-05-04)'), 'Property Tax System)');
});

test('a change to what the module states still warns', () => {
  const pub = stampNyc(nyc.meta);
  const changed = (what, f) => {
    const m = clone(pub); f(m);
    assert.equal(metaDiffers(nyc, m), true, what);
  };
  changed('a word in the credit line', m => { m.attribution[0] = m.attribution[0].replace('kept home sales only', 'kept all sales'); });
  changed('a data set renamed', m => { m.attribution[0] = m.attribution[0].replace('Rolling Calendar Sales', 'Rolling Sales'); });
  changed('a data set id', m => { m.attribution[1] = m.attribution[1].replace('64uk-42ks', '64uk-42kt'); });
  changed('an attribution line added (a publisher\'s disclaimer)', m => { m.attribution.push('The county\'s disclaimer: furnished AS IS.'); });
  changed('an attribution line dropped', m => { m.attribution.pop(); });
  changed('the licence', m => { m.licence = 'CC BY 4.0'; });
  changed('the licence link', m => { m.licenceUrl = 'https://example.org/licence'; });
  changed('the credit', m => { m.credit = 'NYC DOF'; });
  changed('the metric', m => { m.metric = 'Mean sale price'; });
  changed('the window', m => { m.window = { ...m.window, months: 12 }; });
  // The other way round: the module edited, the snapshot as published.
  const edited = { ...nyc, meta: { ...nyc.meta, attribution: [...nyc.meta.attribution, 'A new line.'] } };
  assert.equal(metaDiffers(edited, published('nyc-dof-sales')), true);
  // A "data as of" is a stamp only with a date after it: other words are not.
  const src = { id: 'x', kind: 'areas', meta: { attribution: ['Data as of the census.'] } };
  assert.equal(metaDiffers(src, { attribution: ['Data as of the survey.'] }), true);
});

test('what the build adds is not compared (period, area noun, notes, window dates)', () => {
  const m = stampNyc(nyc.meta);
  Object.assign(m, { period: 'Sales dated Aug 2024 – Jul 2026', areaNoun: 'census tract', notes: [...m.notes, 'Figures are rounded.'],
    window: { ...m.window, from: '2024-08', to: '2026-07', span: 24 }, status: 'snapshot', fetched: '2026-09-15', vintage: '2024-08..2026-07' });
  assert.equal(metaDiffers(nyc, m), false);
});

test('a module\'s stamps must be global regular expressions', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'prices-stamps-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const meta = clone(published('acs-tract'));
  const write = (id, stamps) => {
    writeFileSync(join(dir, `${id}.mjs`), `export default { id: '${id}', regions: ['nyc'], cadence: 'annual', meta: ${JSON.stringify(meta)}, fetch: () => null${stamps ? `, stamps: ${stamps}` : ''} };\n`);
    return join(dir, `${id}.mjs`);
  };
  await loadSource(write('ok-none'));
  await loadSource(write('ok-global', '[/ v\\d+/g]'));
  await assert.rejects(loadSource(write('not-global', '[/ v\\d+/]')), /stamps, when given, must be a list of global/);
  await assert.rejects(loadSource(write('not-a-list', '/ v\\d+/g')), /stamps, when given, must be a list of global/);
  await assert.rejects(loadSource(write('a-string', '[" v1"]')), /stamps, when given, must be a list of global/);
});
