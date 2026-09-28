// The optional school filters on /check/, defined once. A filter reaches the
// page only if some source in the build DECLARES that it publishes it
// (sources/<id>.mjs meta.publishes), and /check/ shows its control only while
// the schools in view include one from such a source (or while it is on, so
// it can always be switched off).
//
// Stage (Nursery / Primary / Secondary) and State / Private are not here: every
// source publishes both, so they are fixed controls in the page.
//
//   label   the control's text / accessible name
//   type    'select' over row[field] (options come from the rows), or
//           'check': a checkbox that keeps rows where row[field] is true, or
//           whose space-separated row.tags include `tag`
//   noun    fills "Showing only schools that publish {noun}."
//
// NEVER add a filter on religion, management type, or any rating or
// inspection outcome: ratings are text in the pane, in their own words, and
// are never a colour, filter, sort or count.

export const FILTERS = {
  gender:   { type: 'select', field: 'gender', label: 'Gender', any: 'Any gender', noun: 'gender',
              // GIAS writes "Not applicable" for most independent special
              // schools; it is not a gender a parent filters by.
              exclude: ['Not applicable'] },
  boarding: { type: 'check', field: 'boarding', label: 'Boarding', noun: 'boarding' },
  charter:  { type: 'check', tag: 'charter', label: 'Charter', noun: 'charter status' },
};
