// tools/most-reported.mjs
//
// The order an area's categories read in wherever a /safety/ page shows them
// as counts or names the largest: the highest count first.
//
// The backend sends `breakdown` sorted by count x severity weight
// (computeAreaSafety in saferoute-backend's src/services/routing.js), the
// order the score is built in, and it stays so on the wire. Read as it came,
// the area page's "What's reported here" table listed SoHo's Violent crime 528
// above Public order 607, and its first entry was printed as "The largest
// reported category" and as the answer to "What is the most common crime?" —
// on 121 of London's 248 pages a larger count sat in the page's own table.
//
// Equal counts keep the backend's order (count x weight, so the more severe
// first), then go by category id, so the same data always gives the same
// page: the backend's own ties follow the order incidents arrived in. This is
// the iPhone app's order since 1.4.2 (MostReported.swift). /check/ sorts the
// same way in the browser (byCount in check/index.html).
//
// Returns a sorted copy; the cached record is not touched.

export function mostReported(breakdown) {
  return (breakdown || []).slice().sort((a, b) =>
    (b.count - a.count) || ((b.weight || 0) - (a.weight || 0))
    || (a.category < b.category ? -1 : a.category > b.category ? 1 : 0));
}
