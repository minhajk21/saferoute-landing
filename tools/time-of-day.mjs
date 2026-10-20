// tools/time-of-day.mjs
//
// The one test for whether an area's time-of-day mix may be drawn or quoted on
// a /safety/ page.
//
// The backend sends a six-bucket mix — [wkDay, wkEve, wkNight, wkndDay,
// wkndEve, wkndNight] — together with the provider's own timeOfDayIsRealData
// flag. Some feeds carry no time of the incident: San Diego and Vancouver give
// a date only, so every incident lands in one bucket, and Minneapolis and Long
// Beach give the time the report was filed. Their mix is not a pattern. Until
// this gate, every area page in those four cities drew it under "When it
// happens ... from police incident timestamps" and said "only about 0% of
// severity-weighted reports fall overnight".
//
// A record with no flag at all (an older cache file) counts as real, as it
// always has here; only an explicit false withholds the mix.
//
// Used by render-pages.mjs for the area page's chart and its timing sentence,
// the "safe at night?" answer, and the areas that feed the city's night page.
// /check/ reads the same flag in the browser.

export function realTimeOfDay(a) {
  return a && a.timeOfDayIsRealData !== false
    && Array.isArray(a.timeOfDay) && a.timeOfDay.length >= 6
    ? a.timeOfDay : null;
}
