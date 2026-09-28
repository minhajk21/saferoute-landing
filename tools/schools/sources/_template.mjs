// TEMPLATE for a new source — copy to sources/<id>.mjs (the leading "_" keeps
// this file from being loaded). Contract and field meanings:
// tools/schools/README.md. Delete every comment you do not need.
//
// Checklist before the first real build:
//   [ ] meta.licence and meta.attribution say exactly what the licence asks
//   [ ] juris lists every ISO 3166-2 code the rows carry (tools/schools/juris.mjs)
//   [ ] stage comes from lib/stage.mjs for YOUR system's own level field
//   [ ] no religion-type field, no address, no website, no test scores
//   [ ] a school with no published location is COUNTED (ctx.stat('unmapped.…'))
//       and dropped — never guessed onto a centroid
//   [ ] node tools/build-schools.mjs --only <id> && node tools/verify-schools.mjs

import { records } from '../lib/csv.mjs';
// import { usPublicStage } from '../lib/stage.mjs';

async function fetchRows(ctx) {
  // Raw files go through ctx.download (cached under the OS temp dir, provenance
  // recorded). Never write into the repo.
  const buf = await ctx.download('example.csv', 'https://example.org/schools.csv', { maxAgeH: 24 * 30 });
  const out = [];
  for (const r of records(buf, { encoding: 'utf-8' })) {
    const lat = +r.LAT, lng = +r.LON;
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || !lat) { ctx.stat('unmapped.noCoordinates'); continue; }
    out.push({
      src: 'example', id: r.ID, name: r.NAME, postcode: r.ZIP,
      lat: +lat.toFixed(5), lng: +lng.toFixed(5),
      juris: 'US-XX',                       // from the SOURCE's own state field, never from geometry
      type: r.TYPE, sector: 'state', stage: '', phase: r.LEVEL,
      span: '', pupils: null, area: r.CITY,
      ratingScheme: 'example-none',         // every row names a scheme defined below (or by a ratings module)
      // any other schema field left out takes its empty value (lib/schema.mjs EMPTY)
    });
  }
  ctx.vintage('2024-25');
  return out;   // the build clips to scope (R2), validates, dedupes and tiles
}

export default {
  id: 'example',                 // = row.src = this file's name
  juris: ['US-XX'],
  cadence: 'annual',             // 'monthly' fetches every run; 'annual'/'static' reuse their tiles unless --refresh <id>
  meta: {
    name: 'Example register',
    publisher: 'Example Department of Education',
    licence: 'Public domain',
    attribution: 'Example ID {id} · Example Department of Education, register 2024-25.',   // {field} = row value
    recordUrl: 'https://example.org/school/{id}',   // omit if no VERIFIED per-school page exists
    recordLabel: 'Official school record',
    where: 'Example City',       // "It is published for {where}" when a filter hides other sources' schools
    publishes: [],               // filters this source fills: 'gender' | 'boarding' | 'charter' (tools/schools/filters.mjs)
    pupilsAsOf: '2024-25',       // default for rows whose pupilsAsOf is ''
    labels: {                    // pane row labels, in this system's own terms; a missing label hides the row
      type: 'Type', phase: 'Level', span: 'Grades', pupils: 'Students', la: 'School district',
      pupilsAsOf: 'Enrolment as of {date}.',
    },
  },
  schemes: {
    'example-none': { kind: 'none', notes: [{ html: 'Example publishes no rating for its schools.' }] },
  },
  fetch: fetchRows,
  // Optional:
  // async probe(ctx) { return { vintage: '2025-26', changed: true }; }      // annual sources: detect a new vintage
  // async verify(rows, { haversine }) { return [{ juris, check: 'position', reference, pass, message }]; }
};
