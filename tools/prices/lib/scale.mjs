// Colour breaks for one scale region: city-relative quintiles, fixed at build
// time so an area's colour is the same on every visit until the next build
// and the page never recomputes a legend.
//
// ONE AREA, ONE VOTE. The breaks are the 20th/40th/60th/80th percentiles of
// the COLOURED areas' values (linear interpolation between order statistics).
// An area is coloured when it has a value and none of the flags that make it
// neutral (suppressed, uncertain, few); a top-coded value is coloured and
// votes with its published floor (ACS 2,000,001), so it lands in the top class.
//
// ROUNDED to 2 significant figures, so the legend reads "£420k · £560k", and
// then forced STRICTLY increasing: a break that rounds onto (or below) the one
// before is raised by one unit in its own second significant figure. The
// breaks are legend ticks, not data; every value in the pane stays exact.
//
// Class of a value (the page does the same): 0 below breaks[0], k when
// breaks[k-1] <= v < breaks[k], 4 at or above breaks[3].

export const PCTS = [0.2, 0.4, 0.6, 0.8];
export const MIN_COLOURED = 5;   // fewer coloured areas than this cannot form quintiles

// Linear-interpolated percentile of an ASCENDING array.
export function percentile(sorted, p) {
  if (!sorted.length) return NaN;
  const i = (sorted.length - 1) * p, lo = Math.floor(i), hi = Math.ceil(i);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo);
}

// 2 significant figures, and the size of one step in the 2nd figure.
const unitOf = v => 10 ** (Math.floor(Math.log10(Math.abs(v))) - 1);
export function sig2(v) {
  if (!(v > 0)) throw new Error(`cannot round ${v} to 2 significant figures`);
  const u = unitOf(v);
  return Math.round(v / u) * u;
}
// Float-clean: 0.1 + 0.2 style noise never reaches index.json.
const clean = v => +v.toPrecision(12);

export function computeBreaks(values) {
  const sorted = values.filter(v => Number.isFinite(v) && v > 0).sort((a, b) => a - b);
  if (sorted.length < MIN_COLOURED) throw new Error(`only ${sorted.length} coloured value(s); at least ${MIN_COLOURED} are needed for quintile breaks`);
  const breaks = [];
  for (const p of PCTS) {
    let b = sig2(percentile(sorted, p));
    const prev = breaks[breaks.length - 1];
    if (prev != null && b <= prev) b = sig2(prev + unitOf(prev));   // one step up in prev's own 2nd figure
    breaks.push(clean(b));
  }
  return {
    breaks,
    min: sorted[0], max: sorted[sorted.length - 1],
    median: percentile(sorted, 0.5),
    areas: sorted.length,
  };
}

export const increasing = b => b.every((v, i) => i === 0 || v > b[i - 1]);

export function classOf(v, breaks) {
  let k = 0;
  while (k < breaks.length && v >= breaks[k]) k++;
  return k;
}
