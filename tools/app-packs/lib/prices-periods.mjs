// The home values' periods and context labels, rebuilt from their fields
// (RELEASE-1.4-SCOPE.md §4.6 H5): the app never translates a period as a
// string; it rebuilds it in the interface language from the same fields
// (SafeRoute/Core/Overlays/PriceDataText.swift is the Swift twin). This file
// is the English rebuild, and the gate that proves it equals every published
// string. A form the rebuild does not know fails the build, so the app's twin
// can never fall behind silently.
//
// PERIODS (index.sources[id].period, and each scale's period), by the shape
// of the source:
//   window       a recorded-sales source: window { by, from, to, span }
//                  by "sale"       "Sales dated Aug 2024 – Jul 2026"
//                  by "recording"  "Sales recorded Sep 2025 – Aug 2026"
//                and span = "{Mon} {yyyy} – {Mon} {yyyy}" from from/to, and
//                vintage = "{from}..{to}"
//   twelveMonthsTo  vintage "12m-to-YYYY-MM"     "12 months to March 2026"
//   acs5         vintage "YYYY-YYYY" spanning 5 years, cadence annual
//                                                 "2020–2024 (5-year survey)"
//   calendarYear vintage "YYYY", cadence annual   "Calendar year 2025"
//   census       vintage "YYYY", cadence static   "2021 Census (May 2021)"
//                (May is the census day, a constant of the form)
// Month names come from a fixed table, never toLocaleString (en-GB writes
// "Sept"; the pack and the web write "Sep").
//
// CONTEXT LABELS (a row's ctx.label), by the source that owns the context:
// the row's own source, or for a recorded-sales source its geometry source
// (a sale tract's context is its ACS owners' estimate):
//   acs          "{metric}, {a}–{b mod 100} survey"  (the owner is acs5)
//                "Median home value (owners’ estimate), 2020–24 survey"
//   wider        "{metric}, wider area ({place}), {year}" (year = the owner's
//                vintage; the place is a proper name, kept as published)
//                "Median sale price, wider area (Antrim and Newtownabbey DEA ‘Airport’), 2025"

export const MONTHS_SHORT = Object.freeze(['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']);
export const MONTHS_LONG = Object.freeze(['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']);
export const CENSUS_MONTH = 5;

const YM = /^(\d{4})-(\d{2})$/;
const ym = s => {
  const m = YM.exec(s ?? '');
  if (!m) return null;
  const y = Number(m[1]), mo = Number(m[2]);
  return mo >= 1 && mo <= 12 ? { y, m: mo } : null;
};

// "Aug 2025 – Jul 2026" from a window's from/to, or null.
export function spanOf(window) {
  const a = ym(window?.from), b = ym(window?.to);
  if (!a || !b) return null;
  return `${MONTHS_SHORT[a.m - 1]} ${a.y} – ${MONTHS_SHORT[b.m - 1]} ${b.y}`;
}

// The period's form and fields, or null for a shape this file does not know.
export function periodForm(src) {
  if (!src) return null;
  if (src.window) {
    const w = src.window, by = w.by === 'sale' ? 'dated' : w.by === 'recording' ? 'recorded' : null;
    const from = ym(w.from), to = ym(w.to);
    if (!by || !from || !to) return null;
    return { form: 'window', by, from, to };
  }
  const v = String(src.vintage ?? '');
  let m;
  if ((m = /^12m-to-(\d{4})-(\d{2})$/.exec(v))) {
    const mo = Number(m[2]);
    return mo >= 1 && mo <= 12 ? { form: 'twelveMonthsTo', y: Number(m[1]), m: mo } : null;
  }
  if ((m = /^(\d{4})-(\d{4})$/.exec(v)) && src.cadence === 'annual') {
    const a = Number(m[1]), b = Number(m[2]);
    return b - a === 4 ? { form: 'acs5', a, b } : null;
  }
  if ((m = /^(\d{4})$/.exec(v))) {
    if (src.cadence === 'annual') return { form: 'calendarYear', y: Number(m[1]) };
    if (src.cadence === 'static') return { form: 'census', y: Number(m[1]) };
  }
  return null;
}

// The English period, rebuilt (null where periodForm is).
export function periodOf(src) {
  const f = periodForm(src);
  if (!f) return null;
  switch (f.form) {
    case 'window': return `Sales ${f.by} ${MONTHS_SHORT[f.from.m - 1]} ${f.from.y} – ${MONTHS_SHORT[f.to.m - 1]} ${f.to.y}`;
    case 'twelveMonthsTo': return `12 months to ${MONTHS_LONG[f.m - 1]} ${f.y}`;
    case 'acs5': return `${f.a}–${f.b} (5-year survey)`;
    case 'calendarYear': return `Calendar year ${f.y}`;
    case 'census': return `${f.y} Census (${MONTHS_LONG[CENSUS_MONTH - 1]} ${f.y})`;
    default: return null;
  }
}

// The source a row's context belongs to.
export const contextOwner = (src, sources) => (src?.kind === 'point-sales' && src.geometry ? sources?.[src.geometry] : src) || null;

const WIDER = /^(.+), wider area \((.+)\), (\d{4})$/;

// A context label's form and fields against its owner, or null.
export function contextForm(label, owner) {
  if (typeof label !== 'string' || !owner) return null;
  const f = periodForm(owner);
  if (f?.form === 'acs5' && label === `${owner.metric}, ${f.a}–${String(f.b % 100).padStart(2, '0')} survey`) return { form: 'acs', metric: owner.metric, a: f.a, b: f.b };
  const m = WIDER.exec(label);
  if (m && m[1] === owner.metric && f?.form === 'calendarYear' && Number(m[3]) === f.y) return { form: 'wider', metric: m[1], place: m[2], y: f.y };
  return null;
}

export function contextLabelOf(form) {
  if (!form) return null;
  if (form.form === 'acs') return `${form.metric}, ${form.a}–${String(form.b % 100).padStart(2, '0')} survey`;
  if (form.form === 'wider') return `${form.metric}, wider area (${form.place}), ${form.y}`;
  return null;
}

// The gate pr-periods. index: the slimmed prices index; contexts: every
// distinct [sourceId, ctx] of the pack's rows. Every source's and every
// scale's period equals its rebuild; every window's span equals its rebuild
// and its vintage is "{from}..{to}"; a source's own contextLabel and every
// row's context label match a known form of their owner, and rebuild exactly.
export function periodProblems(index, contexts) {
  const p = [], sources = index.sources || {};
  const forms = {};
  for (const [id, s] of Object.entries(sources)) {
    const f = periodForm(s);
    forms[id] = f?.form ?? null;
    if (!f) { p.push(`source ${id}: a period form the rebuild does not know (vintage ${JSON.stringify(s.vintage)}, cadence ${s.cadence}${s.window ? ', a window' : ''})`); continue; }
    if (periodOf(s) !== s.period) p.push(`source ${id}: period ${JSON.stringify(s.period)}, the rebuild gives ${JSON.stringify(periodOf(s))}`);
    if (s.window) {
      if (spanOf(s.window) !== s.window.span) p.push(`source ${id}: window.span ${JSON.stringify(s.window.span)}, the rebuild gives ${JSON.stringify(spanOf(s.window))}`);
      if (s.vintage !== `${s.window.from}..${s.window.to}`) p.push(`source ${id}: vintage ${JSON.stringify(s.vintage)} is not the window ${s.window.from}..${s.window.to}`);
    }
    if (s.contextLabel != null && contextLabelOf(contextForm(s.contextLabel, s)) !== s.contextLabel) p.push(`source ${id}: contextLabel ${JSON.stringify(s.contextLabel)} is not a form the rebuild knows`);
  }
  (index.scales || []).forEach((sc, i) => {
    const s = sources[sc.source];
    if (!s) { p.push(`scale ${sc.key ?? i}: source ${sc.source} is not in index.sources`); return; }
    if (sc.period != null && periodOf(s) !== sc.period) p.push(`scale ${sc.key ?? i}: period ${JSON.stringify(sc.period)}, its source's rebuild gives ${JSON.stringify(periodOf(s))}`);
  });
  const seen = new Set();
  for (const [id, ctx] of contexts) {
    const label = ctx?.label;
    if (label == null) continue;
    const k = `${id}\u0000${label}`;
    if (seen.has(k)) continue;
    seen.add(k);
    const owner = contextOwner(sources[id], sources);
    const f = contextForm(label, owner);
    if (!f) p.push(`a ${id} row's context label ${JSON.stringify(label)} is not a form the rebuild knows`);
    else if (contextLabelOf(f) !== label) p.push(`a ${id} row's context label ${JSON.stringify(label)} rebuilds as ${JSON.stringify(contextLabelOf(f))}`);
  }
  return { problems: p, forms, labels: seen.size };
}
