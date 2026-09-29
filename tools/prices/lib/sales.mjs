// Kind 'point-sales' (tools/prices/README.md, "Sale prices"): individual
// recorded sales in, census-tract figures out.
//
// A sale-price source returns arm's-length residential sales as points and
// nothing else. Everything after that happens HERE, the same way for every
// city, so no two sale sources can window, place, round or suppress their
// sales differently, and no source ever writes a figure of its own:
//
//   WINDOW   meta.window.months months ending at the latest COMPLETE month in
//            the data, pushed back meta.window.lagMonths months for the
//            source's recording lag (sales from the last weeks are still
//            being recorded, so the newest months are short and would drag a
//            median toward whatever sold fastest). A month is complete when
//            the data runs past it, or has a sale on its last day, or the
//            source says so (`through`, the publisher's own statement). A
//            `through` later than the newest sale's month says nothing about
//            that month (the data stops short of what the publisher claims),
//            so it is judged by the data alone, like no `through` at all.
//   PLACE    point-in-polygon into the geometry source's tract polygons AS
//            THEY SHIP (the encoded 8 m rings), so a sale counts in the tract
//            the page's own point-in-polygon would put it in. A sale in no
//            tract, or in a tract outside the source's `covers`, is dropped
//            and counted. Sales are never geocoded or guessed here.
//   FIGURES  per tract: n, the median, and the 25th and 75th percentiles
//            (linear interpolation, as lib/scale.mjs), each rounded to the
//            nearest 1,000: a sale price to the dollar is false precision for
//            a neighbourhood figure.
//   PRIVACY  sales are public records, but only tract aggregates are
//            published. A tract with fewer than MIN_SHOWN (3) sales gets no
//            figure at all, not even in the pane (flag suppressed; n is kept,
//            a count reveals no price), so a tract's lone sale is never shown
//            as its "median". That is ALL the rule promises: with an odd count
//            the median is one sale's price (rounded, and a round price stays
//            exact), so no wording here or on the page may say that no single
//            sale's price is ever published. The middle half is given only
//            from colourMinN (10) sales: on fewer it spans only a few sales,
//            and its ends are often single sales' prices.
//   CONTEXT  every sale tract carries the geometry source's own figure (the
//            ACS owners' estimate, with its margin of error and its top/bottom
//            coding) as its context line, labelled with that metric. It is
//            the reading where a tract has too few sales; it is never
//            coloured and never enters a sale-price scale.
//
// Nothing here is written to a tile except what buildSaleAreas returns: no
// sale's location, date, price, address or parcel id survives it.

import { decodePolys, pointInPolygon } from './geo.mjs';
import { percentile } from './scale.mjs';

export const MIN_SHOWN = 3;          // fewer sales: no figure at all
export const ROUND_TO = 1000;        // figures to the nearest 1,000 of the currency
export const MIN_COLOUR_N = 10;      // a sale source's colourMinN may not be lower
export const WINDOW_BY = ['sale', 'recording'];
export const MAX_WINDOW_MONTHS = 36;
// The drop reasons this file adds to a source's own (sources[id].stats.dropped).
export const ORCH_DROPS = ['futureDate', 'outOfWindow', 'outsideTracts', 'outsideCovers'];
// What the geometry source's flags may say about its figure in a context line.
export const CONTEXT_FLAGS = ['uncertain', 'topcoded', 'bottomcoded'];

// ── months ──────────────────────────────────────────────────────────────────
// 'YYYY-MM' <-> a month count, so a window is integer arithmetic.
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export const monthIdx = s => { const [y, m] = s.split('-').map(Number); return y * 12 + (m - 1); };
export const monthStr = i => `${Math.floor(i / 12)}-${String((i % 12) + 1).padStart(2, '0')}`;
// "Sep 2025". Fixed names, not Intl: en-GB now says "Sept", and a label must
// not change with the Node version that built it.
export const monthLabel = i => `${MON[i % 12]} ${Math.floor(i / 12)}`;
const lastDay = i => new Date(Date.UTC(Math.floor(i / 12), (i % 12) + 1, 0)).getUTCDate();

// A real calendar date as 'YYYY-MM-DD' (not 2026-02-30).
export function isIsoDate(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

// The window, from the newest kept sale date. See WINDOW above.
export function saleWindow({ latest, months, lagMonths = 0, through = null }) {
  const li = monthIdx(latest.slice(0, 7));
  const complete = +latest.slice(8, 10) === lastDay(li) ? li : li - 1;
  const t = through ? monthIdx(through) : null;
  const end = (t != null && t < li ? t : t === li ? li : complete) - lagMonths;
  const start = end - months + 1;
  return { from: monthStr(start), to: monthStr(end), span: `${monthLabel(start)} – ${monthLabel(end)}` };
}
export const inWindow = (date, w) => { const m = date.slice(0, 7); return m >= w.from && m <= w.to; };

// How the period reads: "Sales recorded Sep 2025 – Aug 2026" for a window by
// recording date, "Sales dated …" for one by date of sale. The page builds
// "from 412 sales recorded Sep 2025 – Aug 2026" from the same two words.
export const windowVerb = by => (by === 'recording' ? 'recorded' : 'dated');
export const periodOf = (by, span) => `Sales ${windowVerb(by)} ${span}`;

// ── figures ─────────────────────────────────────────────────────────────────
export const roundTo = v => Math.round(v / ROUND_TO) * ROUND_TO;
export function figuresOf(prices, minN) {
  const s = [...prices].sort((a, b) => a - b), n = s.length;
  if (n < MIN_SHOWN) return { n, value: null, iqr: null };
  return { n, value: roundTo(percentile(s, 0.5)), iqr: n >= minN ? [roundTo(percentile(s, 0.25)), roundTo(percentile(s, 0.75))] : null };
}

// ── where a sale is ─────────────────────────────────────────────────────────
// A grid over the tracts' boxes (0.01°, about 1 km), so each sale is tested
// against a handful of polygons, not a city's 2,000. Tracts are tried in id
// order: two simplified tracts can overlap by a sliver, and the same sale must
// land in the same tract on every build.
export function tractLocator(tracts, cell = 0.01) {
  const grid = new Map();
  const list = [...tracts].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map(t => ({ t, bbox: t.bbox, polys: decodePolys(t.enc) }));
  const k = (i, j) => `${i}_${j}`;
  for (const x of list) {
    const [s, w, n, e] = x.bbox;
    for (let i = Math.floor(s / cell); i <= Math.floor(n / cell); i++) {
      for (let j = Math.floor(w / cell); j <= Math.floor(e / cell); j++) {
        const key = k(i, j);
        if (!grid.has(key)) grid.set(key, []);
        grid.get(key).push(x);
      }
    }
  }
  return (lat, lng) => {
    for (const x of grid.get(k(Math.floor(lat / cell), Math.floor(lng / cell))) || []) {
      const [s, w, n, e] = x.bbox;
      if (lat < s || lat > n || lng < w || lng > e) continue;
      if (pointInPolygon(lat, lng, x.polys)) return x.t;
    }
    return null;
  };
}

// ── covers ──────────────────────────────────────────────────────────────────
// Where the source is AUTHORITATIVE: its jurisdictions, optionally narrowed to
// counties (5-digit state+county FIPS, matched against the first five digits
// of the tract's GEOID). Tracts elsewhere in the region keep the geometry
// source's own figure.
export const isCovered = (covers, a) => covers.juris.includes(a.juris) && (!covers.counties || covers.counties.some(c => a.id.startsWith(c)));
export function coversProblems(covers) {
  if (!covers || typeof covers !== 'object') return ['covers must be { juris: [...], counties?: [...] }'];
  const p = [];
  if (!Array.isArray(covers.juris) || !covers.juris.length || covers.juris.some(j => !/^[A-Z]{2}-[A-Z0-9]{1,3}$/.test(j))) p.push('covers.juris must list ISO 3166-2 codes');
  if (covers.counties != null && (!Array.isArray(covers.counties) || !covers.counties.length || covers.counties.some(c => !/^\d{5}$/.test(c)))) p.push('covers.counties, when given, must list 5-digit state+county FIPS codes');
  if (Object.keys(covers).some(k => !['juris', 'counties'].includes(k))) p.push(`covers has field(s) beyond juris/counties: ${Object.keys(covers).join(', ')}`);
  return p;
}
const pickCovers = c => ({ juris: [...c.juris].sort(), ...(c.counties ? { counties: [...c.counties].sort() } : {}) });

// One sale as a source returned it: '' when usable, else why not. A sale that
// is not even well-formed is a contract violation (the source must filter),
// not a drop.
export function saleProblem(s) {
  if (!s || typeof s !== 'object') return 'not an object';
  if (!(Number.isFinite(s.lat) && s.lat >= -90 && s.lat <= 90 && Number.isFinite(s.lng) && s.lng >= -180 && s.lng <= 180)) return `lat/lng ${s.lat}, ${s.lng}`;
  if (!(Number.isFinite(s.price) && s.price > 0)) return `price ${s.price}`;
  if (!isIsoDate(s.date)) return `date ${JSON.stringify(s.date)} is not YYYY-MM-DD`;
  if (s.type != null && typeof s.type !== 'string') return 'type must be a string when given';
  return '';
}

// The ACS figure of a tract as a context line (see CONTEXT), or null when the
// geometry source publishes none there.
export function contextOf(g, geoMeta) {
  if (!g || g.value == null) return null;
  const flags = (g.flags || []).filter(f => CONTEXT_FLAGS.includes(f));
  return { label: geoMeta.contextLabel || `${geoMeta.metric}, ${geoMeta.period}`, value: g.value, moe: g.moe ?? null, n: null, flags };
}

export const currencySymbol = c => ({ GBP: '£', USD: '$', CAD: 'CA$' }[c] ?? `${c} `);
// The rules above in the pane's words, added to every sale source's notes
// unless the source already states the at-least-3 rule itself. It says what
// the rule does (how many sales a figure rests on), never that no sale's price
// can be read from a figure: see PRIVACY.
export const STATES_MIN_SHOWN = new RegExp(`at least ${MIN_SHOWN} sales|fewer than ${MIN_SHOWN}\\b`, 'i');
export function privacyNote(meta) {
  const sym = currencySymbol(meta.currency), area = meta.areaNoun || 'area';
  return `Each figure is the median of the sales in that ${area}, rounded to the nearest ${sym}1,000. A figure always rests on at least ${MIN_SHOWN} sales: ` +
    `a ${area} with fewer shows none, and one with fewer than ${meta.colourMinN} is not coloured. ` +
    `“Middle half” is the range the middle 50% of its sales fell in, shown where a ${area} has ${meta.colourMinN} or more.`;
}

// ── the whole step ──────────────────────────────────────────────────────────
//   src      the point-sales module (meta.window, meta.colourMinN, regions)
//   out      what its fetch returned: { covers, sales, dropped, through?, vintage? }
//   tracts   the geometry source's areas in the source's regions, prepared
//            (enc, bbox), each { id, name, region, juris, value, moe, flags,
//            enc, bbox } — or a sale source's own published row, which then
//            carries its old `context` and `fromSale: true`
//   geoMeta  the geometry source's meta (metric, period, contextLabel)
//   now      'YYYY-MM-DD': a sale dated after it is an error, dropped
//   scaleOf  region id -> the scale key a sale tract takes there
//   keepPrices  also return the placed prices by tract (run-source's
//            diagnostics; the build never asks)
// Returns { areas, meta, vintage, covers, window, stats, violations }.
export function buildSaleAreas({ src, out, tracts, geoMeta, now, scaleOf, keepPrices = false }) {
  const violations = [];
  const bad = m => violations.push(`${src.id}: ${m}`);
  if (!out || typeof out !== 'object') { bad('fetch returned nothing'); return { violations }; }
  coversProblems(out.covers).forEach(bad);
  if (!Array.isArray(out.sales)) bad('fetch must return sales: [{ lat, lng, price, date }]');
  const srcDrops = out.dropped ?? {};
  if (typeof srcDrops !== 'object' || Array.isArray(srcDrops) || Object.values(srcDrops).some(v => !(Number.isInteger(v) && v >= 0))) bad('dropped must be { reason: count } with whole-number counts');
  for (const k of Object.keys(srcDrops)) if (ORCH_DROPS.includes(k)) bad(`dropped.${k} is counted by the build, not the source`);
  if (out.through != null && !/^\d{4}-(0[1-9]|1[0-2])$/.test(out.through)) bad(`through "${out.through}" is not YYYY-MM`);
  if (violations.length) return { violations };
  const malformed = [];
  out.sales.forEach((s, i) => { const p = saleProblem(s); if (p) malformed.push(`sale ${i}: ${p}`); });
  if (malformed.length) { bad(`${malformed.length} malformed sale(s), e.g. ${malformed.slice(0, 3).join('; ')}`); return { violations }; }

  const w = src.meta.window, minN = src.meta.colourMinN;
  const dropped = { ...srcDrops, ...Object.fromEntries(ORCH_DROPS.map(k => [k, 0])) };
  const current = out.sales.filter(s => s.date <= now);
  dropped.futureDate = out.sales.length - current.length;
  if (!current.length) { bad('no sale dated on or before the build date'); return { violations }; }
  const latest = current.reduce((m, s) => (s.date > m ? s.date : m), current[0].date);
  const win = saleWindow({ latest, months: w.months, lagMonths: w.lagMonths || 0, through: out.through || null });

  const covers = pickCovers(out.covers);
  const locate = tractLocator(tracts);
  const prices = new Map();
  let used = 0;
  for (const s of current) {
    if (!inWindow(s.date, win)) { dropped.outOfWindow++; continue; }
    const t = locate(s.lat, s.lng);
    if (!t) { dropped.outsideTracts++; continue; }
    if (!isCovered(covers, t)) { dropped.outsideCovers++; continue; }
    if (!prices.has(t.id)) prices.set(t.id, []);
    prices.get(t.id).push(s.price);
    used++;
  }

  const areas = [];
  for (const t of tracts) {
    if (!isCovered(covers, t)) continue;
    const f = figuresOf(prices.get(t.id) || [], minN);
    const context = t.fromSale ? (t.context ? { ...t.context, flags: [...(t.context.flags || [])] } : null) : contextOf(t, geoMeta);
    // No figure: withheld (hatched, "only 2 sales") where there were sales or
    // there is a context line to read; otherwise nothing is published at all
    // (a park, an airport) and, as for an ACS jam value, the area is not drawn.
    const flags = f.value == null ? (f.n > 0 || context ? ['suppressed'] : []) : f.n < minN ? ['few'] : [];
    areas.push({ id: t.id, name: t.name ?? null, region: t.region, juris: t.juris, scale: scaleOf(t.region),
      value: f.value, moe: null, n: f.n, iqr: f.iqr, flags, context, src: src.id, enc: t.enc, bbox: t.bbox });
  }

  const areaNoun = src.meta.areaNoun || geoMeta.areaNoun;
  const meta = { ...src.meta, areaNoun, period: periodOf(w.by, win.span), window: { ...w, lagMonths: w.lagMonths || 0, ...win } };
  if (!(meta.notes || []).some(n => STATES_MIN_SHOWN.test(n))) meta.notes = [...(meta.notes || []), privacyNote(meta)];
  return {
    areas, meta, covers, window: win, violations,
    vintage: `${win.from}..${win.to}`,
    stats: { dropped, sales: { received: out.sales.length, used } },
    ...(keepPrices ? { prices } : {}),
  };
}
