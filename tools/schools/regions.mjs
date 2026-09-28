// Schools-side facts about each crime-data region. The RECTANGLES are not here:
// they are the backend's, copied into tools/data/coverage.json by
// lib/coverage-from-backend.mjs. This file says only what the schools layer
// needs on top of a rectangle:
//
//   name      how the region is named in notes and index.json
//   juris     scope rule R2: the rectangle is limited to these ISO 3166-2
//             jurisdictions, judged by each SOURCE's own state/province field,
//             never by geometry. That keeps New Jersey schools out of the NYC
//             box and Estado de México out of Mexico City's (DESIGN.md §0).
//   view      [[south, west], [north, east]]: where the layer opens when it
//             jumps to this region (openSchools), at a zoom that draws pins
//   viewName  "Starting in {viewName}." — the pane's hint after that jump
//   tz        time zones (regex source) whose visitors are sent to this region
//             when the layer has to jump somewhere, and where /check/?schools
//             opens for them (a zone no region names opens the first, the UK)
//   outside   what else lies inside the rectangle and is therefore NOT mapped
//             (R2), as the map note names it: "Here the map shows schools in
//             New York State only, not New Jersey." — so an empty view across
//             the line is not read as a place without schools. Checked in the
//             Sept 2026 repair against the raw downloads (NCES public and
//             private schools by state in each rectangle; 68 Ontario schools in
//             Windsor inside Detroit's) and, for Baja California (Tijuana), Morelos, the State of
//             Mexico, Scotland and the Republic of Ireland, by geography. A new
//             or moved rectangle needs this re-checked.
//
// THE BUILD FAILS if coverage.json has a region with no entry here — a new
// crime city forces a schools decision instead of silently getting none (the
// same guard as the page workflow's "unknown city" check). A region is only
// published in index.json once some source actually puts schools in it.

// A view the size of the central-London one (~7 km x 7.5 km at London's
// latitude), centred on a checked city-centre point.
const around = (lat, lng) => [[+(lat - 0.032).toFixed(4), +(lng - 0.055).toFixed(4)], [+(lat + 0.032).toFixed(4), +(lng + 0.055).toFixed(4)]];

export const REGIONS = {
  uk:          { name: 'United Kingdom', juris: ['GB-ENG', 'GB-WLS', 'GB-NIR'], outside: ['Scotland', 'the Republic of Ireland'],
                 view: [[51.47, -0.165], [51.535, -0.055]], viewName: 'central London', tz: '^Europe/' },
  // Eastern time: New York, and the Indiana and Kentucky zones (Detroit's own
  // zone goes to Detroit, below).
  nyc:         { name: 'New York City', juris: ['US-NY'], outside: ['New Jersey'], view: around(40.7549, -73.984), viewName: 'Midtown Manhattan',
                 tz: '^(America/(New_York|Indiana/(Indianapolis|Marengo|Petersburg|Vevay|Vincennes|Winamac)|Kentucky/.+|Indianapolis|Louisville|Fort_Wayne)|US/(Eastern|East-Indiana)|EST5EDT)$' },
  chicago:     { name: 'Chicago', juris: ['US-IL'], outside: ['Indiana'], view: around(41.8786, -87.6298), viewName: 'the Chicago Loop',
                 tz: '^(America/(Chicago|Indiana/(Knox|Tell_City)|Menominee|North_Dakota/.+)|US/Central|CST6CDT)$' },
  sf:          { name: 'San Francisco', juris: ['US-CA'], view: around(37.788, -122.4075), viewName: 'downtown San Francisco' },
  boston:      { name: 'Boston', juris: ['US-MA'], view: around(42.3555, -71.0605), viewName: 'downtown Boston' },
  seattle:     { name: 'Seattle', juris: ['US-WA'], view: around(47.608, -122.338), viewName: 'downtown Seattle' },
  philly:      { name: 'Philadelphia', juris: ['US-PA'], outside: ['New Jersey'], view: around(39.9526, -75.1652), viewName: 'Center City, Philadelphia' },
  dc:          { name: 'Washington DC', juris: ['US-DC'], outside: ['Maryland', 'Virginia'], view: around(38.8995, -77.0266), viewName: 'downtown Washington DC' },
  denver:      { name: 'Denver', juris: ['US-CO'], view: around(39.7447, -104.995), viewName: 'downtown Denver', tz: '^(America/(Denver|Boise)|US/Mountain|MST7MDT)$' },
  sandiego:    { name: 'San Diego', juris: ['US-CA'], outside: ['Baja California'], view: around(32.7157, -117.1611), viewName: 'downtown San Diego' },
  longbeach:   { name: 'Long Beach', juris: ['US-CA'], view: around(33.7701, -118.1937), viewName: 'downtown Long Beach' },
  la:          { name: 'Los Angeles', juris: ['US-CA'], view: around(34.049, -118.25), viewName: 'downtown Los Angeles', tz: '^(America/Los_Angeles|US/Pacific|PST8PDT)$' },
  dallas:      { name: 'Dallas', juris: ['US-TX'], view: around(32.7801, -96.8005), viewName: 'downtown Dallas' },
  detroit:     { name: 'Detroit', juris: ['US-MI'], outside: ['Ontario'], view: around(42.3316, -83.0466), viewName: 'downtown Detroit', tz: '^(America/Detroit|US/Michigan)$' },
  baltimore:   { name: 'Baltimore', juris: ['US-MD'], view: around(39.286, -76.61), viewName: 'downtown Baltimore' },
  memphis:     { name: 'Memphis', juris: ['US-TN'], outside: ['Arkansas'], view: around(35.1495, -90.049), viewName: 'downtown Memphis' },
  charlotte:   { name: 'Charlotte', juris: ['US-NC'], outside: ['South Carolina'], view: around(35.2271, -80.8431), viewName: 'uptown Charlotte' },
  nashville:   { name: 'Nashville', juris: ['US-TN'], view: around(36.1627, -86.7816), viewName: 'downtown Nashville' },
  minneapolis: { name: 'Minneapolis', juris: ['US-MN'], view: around(44.9778, -93.265), viewName: 'downtown Minneapolis' },
  cleveland:   { name: 'Cleveland', juris: ['US-OH'], view: around(41.4993, -81.6944), viewName: 'downtown Cleveland' },
  tucson:      { name: 'Tucson', juris: ['US-AZ'], view: around(32.2217, -110.9747), viewName: 'downtown Tucson', tz: '^(America/Phoenix|US/Arizona)$' },
  fortworth:   { name: 'Fort Worth', juris: ['US-TX'], view: around(32.7555, -97.3308), viewName: 'downtown Fort Worth' },
  hartford:    { name: 'Hartford', juris: ['US-CT'], view: around(41.7658, -72.6734), viewName: 'downtown Hartford' },
  kansascity:  { name: 'Kansas City', juris: ['US-MO'], outside: ['Kansas'], view: around(39.0997, -94.5786), viewName: 'downtown Kansas City' },
  houston:     { name: 'Houston', juris: ['US-TX'], view: around(29.7589, -95.3677), viewName: 'downtown Houston' },
  neworleans:  { name: 'New Orleans', juris: ['US-LA'], view: around(29.9511, -90.0715), viewName: 'central New Orleans' },
  lasvegas:    { name: 'Las Vegas', juris: ['US-NV'], view: around(36.1699, -115.1398), viewName: 'downtown Las Vegas' },
  toronto:     { name: 'Toronto', juris: ['CA-ON'], view: around(43.6532, -79.3832), viewName: 'downtown Toronto', tz: '^(America/(Toronto|Montreal|Nipigon|Thunder_Bay)|Canada/Eastern)$' },
  vancouver:   { name: 'Vancouver', juris: ['CA-BC'], view: around(49.2827, -123.1207), viewName: 'downtown Vancouver', tz: '^(America/Vancouver|Canada/Pacific)$' },
  mexicocity:  { name: 'Mexico City', juris: ['MX-CMX'], outside: ['the State of Mexico', 'Morelos'], view: around(19.4326, -99.1332), viewName: 'the Centro of Mexico City',
                 tz: '^America/(Mexico_City|Monterrey|Merida|Cancun|Matamoros|Chihuahua|Ciudad_Juarez|Ojinaga|Mazatlan|Bahia_Banderas|Hermosillo|Tijuana)$' },
};

// Shown in /check/'s "School data sources" (index.json `scope`): what R2 means
// for a reader. The New York examples are the city names NCES and the private
// school survey give for the schools the NYC rectangle takes in outside the
// five boroughs (133 of its 2,539 in the Sept 2026 build: 38 in Westchester
// County, 95 in Nassau County).
export const SCOPE_NOTE = 'Around each city outside the UK, schools are mapped inside the same rectangle as the city’s crime data, and only in the ' +
  'city’s own state, province or entity. So a city’s schools can include neighbouring towns in that state: around New York City they include ' +
  'Yonkers, Mount Vernon and New Rochelle in Westchester County, and towns in western Nassau County such as Valley Stream and Great Neck.';
