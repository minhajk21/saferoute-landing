// WHICH US STATE RATING VALUES MAY BE PUBLISHED.
//
// Owner decision, 2 October 2026, one rule for the website and the app: a
// rating or status VALUE from a US state is shown only where the state
// EXPLICITLY licenses its reuse. "No stated licence, and nothing restrictive
// found" is not a licence. This ends the earlier owner exceptions for Texas
// (TEA's copyright notice asks anyone outside Texas for written approval) and
// Arizona (an undocumented ADE API with no licence).
//
// A ratings module (ratings/<scheme>.mjs) turns a state's own file into values
// on our rows, so its values are republished data. build-schools.mjs applies a
// module's map only if its scheme is listed here. The other 16 modules (AZ CA
// CO DC IL LA MA MD MI NC NV NY OH PA TN TX) are kept, so their maps can still
// be rebuilt and checked, but their values are never applied: those states'
// public schools keep their source's link-out line (sources/ccd.mjs
// `us-pending`: what the state publishes, a link to it, and why the map does
// not show it), with no value. verify-schools.mjs fails any value under a
// scheme that is neither listed here nor defined by the row's own source.
//
// Ofsted (England) and ETI (Northern Ireland) are not listed: their outcomes
// come from their own source modules (sources/gias.mjs, sources/de.mjs), under
// the Open Government Licence v3.0 those sources declare in meta.licence.
//
// To show a state's values: get its explicit licence or written permission,
// add its scheme here with that licence and where it is stated, and the next
// monthly build (or tools/schools/apply-rating-licence.mjs now) applies it.
// To withdraw one, remove it here and run the same.

export const LICENSED_RATINGS = Object.freeze({
  'us-ct-ngas': { juris: 'US-CT', licence: 'Public Domain', statedAt: 'data.ct.gov dataset h28j-iix5 (licence field)' },
  'us-wa-wsif': { juris: 'US-WA', licence: 'CC BY 4.0', statedAt: 'data.wa.gov dataset u25x-vdun (licence field)' },
});

// May this ratings module's values be published?
export const ratingLicensed = scheme => Object.hasOwn(LICENSED_RATINGS, scheme);

// Does this jurisdiction have a licensed rating scheme? sources/ccd.mjs words
// its interim line by it: "not shown yet" for a licensed state whose map is not
// built, the licence reason for every other state.
export const jurisRatingLicensed = juris => Object.values(LICENSED_RATINGS).some(x => x.juris === juris);
