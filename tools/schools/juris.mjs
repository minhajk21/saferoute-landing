// Every jurisdiction a school row can carry (row.juris, ISO 3166-2), with the
// names the pane and the notes use. Pre-filled for every place in the schools
// expansion design so source lanes never need to edit this shared file; only
// the jurisdictions that actually have rows are copied into index.json.
//
//   name       "Texas" — heads a rating block and says whose rules set it
//              ("Set under Texas rules; it cannot be compared …")
//   country    ISO 3166-1 alpha-2
//   where      how the jurisdiction reads in "Schools cover {where}", when it
//              is named on its own (US states never are: their cities are)
//   rules      optional: how it reads in "Set under {rules} rules" where the
//              name does not fit there ("the District of Columbia")
//   area       optional: how it reads as a place in the map note "Here the map
//              shows schools in {area} only, not …" where the name alone would
//              be ambiguous ("New York State", not the city)
//   labels     optional pane-label overrides for this jurisdiction only, on top
//              of the source's meta.labels (e.g. a state that calls its
//              districts "parishes"); same keys as a source's labels

export const JURIS = {
  'GB-ENG': { name: 'England', country: 'GB', where: 'England' },
  'GB-WLS': { name: 'Wales', country: 'GB', where: 'Wales' },
  'GB-NIR': { name: 'Northern Ireland', country: 'GB', where: 'Northern Ireland' },

  'US-AZ': { name: 'Arizona', country: 'US' },
  'US-CA': { name: 'California', country: 'US' },
  'US-CO': { name: 'Colorado', country: 'US' },
  'US-CT': { name: 'Connecticut', country: 'US' },
  'US-DC': { name: 'the District of Columbia', rules: 'District of Columbia', country: 'US' },
  'US-IL': { name: 'Illinois', country: 'US' },
  'US-LA': { name: 'Louisiana', country: 'US' },
  'US-MA': { name: 'Massachusetts', country: 'US' },
  'US-MD': { name: 'Maryland', country: 'US' },
  'US-MI': { name: 'Michigan', country: 'US' },
  'US-MN': { name: 'Minnesota', country: 'US' },
  'US-MO': { name: 'Missouri', country: 'US' },
  'US-NC': { name: 'North Carolina', country: 'US' },
  'US-NV': { name: 'Nevada', country: 'US' },
  'US-NY': { name: 'New York', area: 'New York State', country: 'US' },
  'US-OH': { name: 'Ohio', country: 'US' },
  'US-PA': { name: 'Pennsylvania', country: 'US' },
  'US-TN': { name: 'Tennessee', country: 'US' },
  'US-TX': { name: 'Texas', country: 'US' },
  'US-WA': { name: 'Washington', country: 'US' },

  'CA-ON': { name: 'Ontario', country: 'CA' },
  'CA-BC': { name: 'British Columbia', country: 'CA' },

  'MX-CMX': { name: 'Mexico City', country: 'MX' },
};
