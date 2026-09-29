// A zero-dependency ESRI Shapefile reader (.shp + .dbf + .prj + .cpg) for the
// area sources. The repo has no package.json, and the two boundary products the
// prices layer needs only ship as shapefiles:
//   TIGER cartographic tracts (cb_2024_SS_tract_500k)   NAD83 lat/lng
//   StatCan 2021 census tracts (lct_000b21a_e)          NAD83 Statistics Canada
//                                                       Lambert (EPSG:3347), metres
//
//   const z = unzip(buf);                      // tools/schools/ratings/_us.mjs
//   const { features } = readShapefile(z, { where: p => p.PRUID === '35' });
//   features -> [{ props, bbox: [s, w, n, e], polys: [[outer, hole…], …] }]
//
// `files` is the unzip() result, a Map, or a plain object of member name ->
// Buffer. `layer` picks one .shp when the zip holds several. `where(props)` is
// asked BEFORE a record's geometry is decoded and projected, so a source can
// skip most of a national file cheaply.
//
// OUTPUT, per feature:
//   props  the .dbf row, decoded by field type (C text, N/F number or null for
//          blank or "****" overflow, L boolean or null, D "YYYY-MM-DD" or null)
//   bbox   [south, west, north, east] in degrees: tools/data/coverage.json's
//          order, so it can be tested against a region rectangle directly
//   polys  a GeoJSON-style MultiPolygon of [lng, lat] rings, closed (first
//          point repeated), full precision, in RFC 7946 orientation (outer rings
//          counter-clockwise, holes clockwise)
//
// RINGS. A shapefile polygon is a flat list of rings; which are holes, and which
// outer ring each hole belongs to, is left to the reader. The spec says outer
// rings run clockwise and holes counter-clockwise, and both boundary products
// obey it, so orientation decides outer vs hole and containment decides the
// owner: a hole goes to the smallest outer ring that contains it. A hole no
// outer ring contains (a writer that got the winding wrong) is kept as an outer
// ring rather than dropped, and counted in stats.orphanHoles, so it shows up in
// a lane report instead of vanishing from the map.
//
// PROJECTIONS. A .prj that is a bare GEOGCS (WGS84, NAD83) is read as lng/lat
// as-is: the NAD83-WGS84 shift is about a metre, far below the build's 8 m
// simplification. Lambert Conformal Conic (1SP and 2SP, any ellipsoid, any
// linear unit) is inverted exactly (Snyder 1987, eqs. 15-1 to 15-11), because
// every Statistics Canada boundary file uses it. Anything else throws: a new
// projection must be added here on purpose, never guessed at.

const TYPES = { 0: 'Null', 5: 'Polygon', 15: 'PolygonZ', 25: 'PolygonM' };

// ── .dbf ────────────────────────────────────────────────────────────────────
// Codepage from the .cpg sidecar (TIGER writes "UTF-8"), else the language
// driver byte in the header, else Windows-1252: most GIS writers default to it,
// and decoding it as UTF-8 would turn every "é" into a replacement character
// without failing.
const CPG = { 'utf-8': 'utf-8', utf8: 'utf-8', 65001: 'utf-8', 1252: 'windows-1252', 'ansi 1252': 'windows-1252',
  'iso-8859-1': 'latin1', 'iso88591': 'latin1', 88591: 'latin1', latin1: 'latin1' };
const LDID = { 0x57: 'windows-1252', 0x03: 'windows-1252', 0x01: 'latin1', 0x02: 'latin1' };

export function dbfEncoding(dbf, cpg) {
  if (cpg != null) {
    const key = String(cpg).trim().toLowerCase();
    if (CPG[key]) return CPG[key];
    throw new Error(`.cpg names codepage "${String(cpg).trim()}", which this reader does not know — add it rather than guess`);
  }
  return LDID[dbf[29]] || 'windows-1252';
}

export function readDbf(buf, { encoding = 'windows-1252' } = {}) {
  if (buf.length < 33) throw new Error('.dbf is too short to have a header');
  const count = buf.readUInt32LE(4), headLen = buf.readUInt16LE(8), recLen = buf.readUInt16LE(10);
  const fields = [];
  let off = 1;                                                           // byte 0 of a record is the deletion flag
  for (let p = 32; p + 32 <= headLen && buf[p] !== 0x0d; p += 32) {
    const name = buf.toString('latin1', p, p + 11).replace(/\0[\s\S]*$/, '').trim();
    const type = String.fromCharCode(buf[p + 11]);
    const length = buf[p + 16], decimals = buf[p + 17];
    fields.push({ name, type, length, decimals, off });
    off += length;
  }
  if (off !== recLen) throw new Error(`.dbf field lengths add up to ${off} bytes but records are ${recLen} — not a dBASE file this reader understands`);
  if (headLen + count * recLen > buf.length) throw new Error(`.dbf says ${count} records but the file is truncated`);
  const text = new TextDecoder(encoding);
  const records = new Array(count);
  for (let i = 0; i < count; i++) {
    const r = headLen + i * recLen;
    if (buf[r] === 0x2a) { records[i] = null; continue; }                // "*": deleted
    const row = {};
    for (const f of fields) {
      const a = r + f.off, b = a + f.length;
      switch (f.type) {
        case 'C': row[f.name] = text.decode(buf.subarray(a, b)).replace(/\0+$/, '').trim(); break;
        case 'N': case 'F': {
          const s = buf.toString('latin1', a, b).replace(/\0/g, '').trim();
          const v = s === '' || /^\*+$/.test(s) ? null : Number(s);
          if (v !== null && !Number.isFinite(v)) throw new Error(`.dbf field ${f.name}: "${s}" is not a number`);
          row[f.name] = v;
          break;
        }
        case 'L': { const c = buf.toString('latin1', a, a + 1); row[f.name] = /[YyTt]/.test(c) ? true : /[NnFf]/.test(c) ? false : null; break; }
        case 'D': { const s = buf.toString('latin1', a, b).trim(); row[f.name] = /^\d{8}$/.test(s) ? `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6)}` : null; break; }
        case 'I': row[f.name] = buf.readInt32LE(a); break;
        case 'O': row[f.name] = buf.readDoubleLE(a); break;
        default: throw new Error(`.dbf field ${f.name} has type "${f.type}", which this reader does not decode`);
      }
    }
    records[i] = row;
  }
  return { fields: fields.map(({ off: _, ...f }) => f), records };
}

// ── .prj ────────────────────────────────────────────────────────────────────
// Returns (x, y) -> [lng, lat]. Only the parts of the WKT the maths needs are
// read; parameter names are matched case-insensitively (ESRI writes
// "Standard_Parallel_1", OGC "standard_parallel_1").
export function projectionFromPrj(wkt) {
  if (wkt == null || !String(wkt).trim()) return { name: 'none (assumed lng/lat)', toLngLat: (x, y) => [x, y] };
  const s = String(wkt).trim();
  if (/^GEOGCS\[/i.test(s)) return { name: (/^GEOGCS\["([^"]*)"/i.exec(s) || [])[1] || 'GEOGCS', toLngLat: (x, y) => [x, y] };
  if (!/^PROJCS\[/i.test(s)) throw new Error(`.prj is neither GEOGCS nor PROJCS: ${s.slice(0, 80)}`);
  const proj = (/PROJECTION\["([^"]+)"/i.exec(s) || [])[1] || '';
  if (!/lambert_conformal_conic/i.test(proj)) throw new Error(`.prj projection "${proj}" is not supported (only Lambert Conformal Conic) — add it rather than guess`);
  const sph = /SPHEROID\["[^"]*",\s*([\d.eE+-]+),\s*([\d.eE+-]+)/i.exec(s);
  if (!sph) throw new Error('.prj has no SPHEROID');
  const params = {};
  for (const m of s.matchAll(/PARAMETER\["([^"]+)",\s*([\d.eE+-]+)\]/gi)) params[m[1].toLowerCase()] = +m[2];
  // The PROJCS's own linear UNIT is its last UNIT (the GEOGCS's angular unit comes first).
  const units = [...s.matchAll(/UNIT\["[^"]*",\s*([\d.eE+-]+)/gi)];
  const unit = units.length ? +units[units.length - 1][1] : 1;
  const need = ['central_meridian', 'latitude_of_origin', 'standard_parallel_1'];
  const miss = need.filter(k => !(k in params));
  if (miss.length) throw new Error(`.prj Lambert projection is missing ${miss.join(', ')}`);
  const inv = +sph[2];
  return {
    name: (/^PROJCS\["([^"]*)"/i.exec(s) || [])[1] || 'PROJCS',
    toLngLat: lccInverse({
      a: +sph[1], f: inv ? 1 / inv : 0,
      lat0: params.latitude_of_origin, lng0: params.central_meridian,
      lat1: params.standard_parallel_1, lat2: params.standard_parallel_2 ?? params.standard_parallel_1,
      k0: params.scale_factor ?? 1,
      x0: (params.false_easting ?? 0) * unit, y0: (params.false_northing ?? 0) * unit, unit,
    }),
  };
}

// Lambert Conformal Conic, ellipsoidal, inverse (Snyder 1987 pp. 107-109).
// Coordinates in the file's linear unit; false origin already scaled to metres.
export function lccInverse({ a, f, lat0, lng0, lat1, lat2, k0 = 1, x0 = 0, y0 = 0, unit = 1 }) {
  const rad = Math.PI / 180, e = Math.sqrt(2 * f - f * f);
  const m = p => Math.cos(p) / Math.sqrt(1 - e * e * Math.sin(p) ** 2);
  const t = p => Math.tan(Math.PI / 4 - p / 2) / ((1 - e * Math.sin(p)) / (1 + e * Math.sin(p))) ** (e / 2);
  const p0 = lat0 * rad, p1 = lat1 * rad, p2 = lat2 * rad, l0 = lng0 * rad;
  const n = Math.abs(p1 - p2) < 1e-12 ? Math.sin(p1)
    : (Math.log(m(p1)) - Math.log(m(p2))) / (Math.log(t(p1)) - Math.log(t(p2)));
  const F = m(p1) / (n * t(p1) ** n);
  const rho0 = a * F * k0 * t(p0) ** n;
  const sgn = Math.sign(n);
  return (x, y) => {
    const dx = x * unit - x0, dy = rho0 - (y * unit - y0);
    const rho = sgn * Math.sqrt(dx * dx + dy * dy);
    const theta = Math.atan2(sgn * dx, sgn * dy);
    const lng = theta / n + l0;
    if (rho === 0) return [lng / rad, sgn * 90];
    const tt = (rho / (a * F * k0)) ** (1 / n);
    let phi = Math.PI / 2 - 2 * Math.atan(tt);
    for (let i = 0; i < 15; i++) {
      const es = e * Math.sin(phi);
      const next = Math.PI / 2 - 2 * Math.atan(tt * ((1 - es) / (1 + es)) ** (e / 2));
      if (Math.abs(next - phi) < 1e-14) { phi = next; break; }
      phi = next;
    }
    return [lng / rad, phi / rad];
  };
}

// ── rings ───────────────────────────────────────────────────────────────────
// Twice the signed area in the (lng, lat) plane: > 0 counter-clockwise.
export function ringArea2(r) {
  let s = 0;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) s += (r[j][0] - r[i][0]) * (r[j][1] + r[i][1]);
  return s;
}
const ringBox = r => {
  let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity;
  for (const [x, y] of r) { if (x < w) w = x; if (x > e) e = x; if (y < s) s = y; if (y > n) n = y; }
  return [w, s, e, n];
};
const insideRing = (x, y, r) => {
  let inside = false;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
    const [xi, yi] = r[i], [xj, yj] = r[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
};

// Shapefile winding in, RFC 7946 winding out. Exported for the unit test.
export function groupRings(rings, stats = { orphanHoles: 0 }) {
  const outers = [], holes = [];
  for (const r of rings) {
    if (r.length < 4) continue;                                          // not a ring: fewer than 3 distinct points
    const a2 = ringArea2(r);
    if (a2 === 0) continue;                                              // zero area: a line, not a polygon
    (a2 < 0 ? outers : holes).push({ ring: r, area: Math.abs(a2), box: ringBox(r) });
  }
  const polys = outers.map(o => ({ ...o, holes: [] }));
  for (const h of holes) {
    const [hw, hs, he, hn] = h.box;
    let owners = polys.filter(o => o.box[0] <= hw && o.box[1] <= hs && o.box[2] >= he && o.box[3] >= hn && o.area > h.area);
    if (owners.length > 1) {
      // A vertex can sit on the outer boundary (holes may touch it), so vote
      // with a few vertices instead of trusting the first.
      const probe = h.ring.filter((_, i) => i % Math.max(1, Math.floor(h.ring.length / 5)) === 0).slice(0, 5);
      const inside = owners.filter(o => probe.filter(([x, y]) => insideRing(x, y, o.ring)).length * 2 > probe.length);
      if (inside.length) owners = inside;
    }
    if (!owners.length) { stats.orphanHoles++; polys.push({ ...h, holes: [] }); continue; }
    owners.sort((a, b) => a.area - b.area)[0].holes.push(h.ring);
  }
  const wind = (r, ccw) => ((ringArea2(r) > 0) === ccw ? r : r.slice().reverse());
  return polys.map(p => [wind(p.ring, true), ...p.holes.map(h => wind(h, false))]);
}

// ── .shp ────────────────────────────────────────────────────────────────────
// Yields { index, geom } per record, geom null for a Null shape; the index is
// the record's position, which is its .dbf row. Only polygon types are read:
// PolygonZ and PolygonM carry their Z/M arrays AFTER the x/y points, so the
// same parse serves all three.
export function* shpRecords(buf) {
  if (buf.length < 100 || buf.readInt32BE(0) !== 9994) throw new Error('not a .shp file (bad file code)');
  const end = Math.min(buf.length, buf.readInt32BE(24) * 2);
  const fileType = buf.readInt32LE(32);
  if (!TYPES[fileType] || fileType === 0) throw new Error(`.shp holds shape type ${fileType}; only Polygon, PolygonZ and PolygonM are read`);
  let p = 100, index = 0;
  while (p + 8 <= end) {
    const len = buf.readInt32BE(p + 4) * 2, c = p + 8;
    if (c + len > buf.length) throw new Error(`.shp record ${index + 1} runs past the end of the file`);
    const type = buf.readInt32LE(c);
    if (type === 0) yield { index, geom: null };
    else if (type === fileType) {
      const box = [buf.readDoubleLE(c + 4), buf.readDoubleLE(c + 12), buf.readDoubleLE(c + 20), buf.readDoubleLE(c + 28)];
      const nParts = buf.readInt32LE(c + 36), nPoints = buf.readInt32LE(c + 40);
      const parts = [];
      for (let i = 0; i < nParts; i++) parts.push(buf.readInt32LE(c + 44 + 4 * i));
      const pts = c + 44 + 4 * nParts;
      if (pts + 16 * nPoints > c + len) throw new Error(`.shp record ${index + 1}: ${nPoints} points do not fit in ${len} bytes`);
      yield { index, geom: { box, parts, nPoints, pts } };
    } else throw new Error(`.shp record ${index + 1} has shape type ${type} in a ${TYPES[fileType]} file`);
    p = c + len;
    index++;
  }
}

// Member access for an unzip() result, a Map, or a plain object.
function members(files) {
  if (files && typeof files.read === 'function' && Array.isArray(files.names)) return { names: files.names, get: n => files.read(n) };
  if (files instanceof Map) return { names: [...files.keys()], get: n => files.get(n) };
  if (files && typeof files === 'object') return { names: Object.keys(files), get: n => files[n] };
  throw new Error('readShapefile: pass an unzip() result, a Map or an object of name -> Buffer');
}

export function readShapefile(files, { layer, where, encoding } = {}) {
  const { names, get } = members(files);
  const shps = names.filter(n => /\.shp$/i.test(n) && (!layer || n.replace(/^.*\//, '').replace(/\.shp$/i, '') === layer));
  if (shps.length !== 1) throw new Error(`expected one .shp${layer ? ` named ${layer}` : ''}, found ${shps.length} (${names.join(', ')})`);
  const base = shps[0].slice(0, -4);
  const sib = ext => names.find(n => n.toLowerCase() === `${base}.${ext}`.toLowerCase());
  if (!sib('dbf')) throw new Error(`${base}.shp has no .dbf beside it`);
  const shp = get(shps[0]), dbf = get(sib('dbf'));
  const prj = sib('prj') ? get(sib('prj')).toString('latin1') : null;
  const cpg = sib('cpg') ? get(sib('cpg')).toString('latin1') : null;
  const { fields, records } = readDbf(dbf, { encoding: encoding || dbfEncoding(dbf, cpg) });
  const projection = projectionFromPrj(prj);
  const toLngLat = projection.toLngLat;
  const stats = { records: 0, deleted: 0, nullShapes: 0, skipped: 0, orphanHoles: 0 };
  const features = [];
  for (const { index, geom } of shpRecords(shp)) {
    stats.records++;
    if (index >= records.length) throw new Error(`.shp has more records than its .dbf (${records.length})`);
    const props = records[index];
    if (!props) { stats.deleted++; continue; }
    if (!geom) { stats.nullShapes++; continue; }
    if (where && !where(props)) { stats.skipped++; continue; }
    const rings = [];
    let s = Infinity, w = Infinity, n = -Infinity, e = -Infinity;
    for (let k = 0; k < geom.parts.length; k++) {
      const from = geom.parts[k], to = k + 1 < geom.parts.length ? geom.parts[k + 1] : geom.nPoints;
      const ring = new Array(to - from);
      for (let i = from; i < to; i++) {
        const q = geom.pts + 16 * i;
        const pt = toLngLat(shp.readDoubleLE(q), shp.readDoubleLE(q + 8));
        ring[i - from] = pt;
        if (pt[1] < s) s = pt[1]; if (pt[1] > n) n = pt[1]; if (pt[0] < w) w = pt[0]; if (pt[0] > e) e = pt[0];
      }
      rings.push(ring);
    }
    const polys = groupRings(rings, stats);
    if (!polys.length) { stats.nullShapes++; continue; }
    features.push({ props, bbox: [s, w, n, e], polys });
  }
  if (stats.records !== records.length) throw new Error(`.shp has ${stats.records} records but its .dbf has ${records.length}`);
  return { features, fields, projection: projection.name, stats };
}
