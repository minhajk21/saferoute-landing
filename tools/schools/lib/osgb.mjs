// OSGB36 British National Grid (Easting/Northing) -> WGS84 lat/lng.
//
// GIAS gives OSGB36 Easting/Northing. Leaflet needs WGS84. Two steps, and both
// are needed — skipping the datum shift leaves pins ~100m out, which in a dense
// city puts a school on the wrong side of a road.
//
// 1. Inverse Transverse Mercator off the Airy 1830 ellipsoid → OSGB36 lat/lon
// 2. Helmert 7-parameter transform → WGS84 (~5m, far below pin precision)
//
// Hand-rolled rather than pulling in proj4 (~1MB) for one projection. The
// constants are Ordnance Survey's published values and the result is checked
// against postcodes.io by verify-schools.mjs (the gias source's position
// check), not taken on trust. Moved unchanged from build-schools.mjs.
export function osgb36ToWgs84(E, N) {
  const a = 6377563.396, b = 6356256.909;          // Airy 1830
  const F0 = 0.9996012717;                          // National Grid scale factor
  const lat0 = 49 * Math.PI / 180, lon0 = -2 * Math.PI / 180;
  const E0 = 400000, N0 = -100000;
  const e2 = 1 - (b * b) / (a * a);
  const n = (a - b) / (a + b), n2 = n * n, n3 = n2 * n;

  let lat = lat0, M = 0;
  do {
    lat = (N - N0 - M) / (a * F0) + lat;
    const dLat = lat - lat0, sLat = lat + lat0;
    const Ma = (1 + n + 1.25 * n2 + 1.25 * n3) * dLat;
    const Mb = (3 * n + 3 * n2 + 2.625 * n3) * Math.sin(dLat) * Math.cos(sLat);
    const Mc = (1.875 * n2 + 1.875 * n3) * Math.sin(2 * dLat) * Math.cos(2 * sLat);
    const Md = (35 / 24) * n3 * Math.sin(3 * dLat) * Math.cos(3 * sLat);
    M = b * F0 * (Ma - Mb + Mc - Md);
  } while (Math.abs(N - N0 - M) >= 0.00001);

  const cosLat = Math.cos(lat), sinLat = Math.sin(lat);
  const nu = a * F0 / Math.sqrt(1 - e2 * sinLat * sinLat);
  const rho = a * F0 * (1 - e2) / Math.pow(1 - e2 * sinLat * sinLat, 1.5);
  const eta2 = nu / rho - 1;
  const tanLat = Math.tan(lat), tan2 = tanLat * tanLat, tan4 = tan2 * tan2, tan6 = tan4 * tan2;
  const secLat = 1 / cosLat;
  const nu3 = nu * nu * nu, nu5 = nu3 * nu * nu, nu7 = nu5 * nu * nu;

  const VII = tanLat / (2 * rho * nu);
  const VIII = tanLat / (24 * rho * nu3) * (5 + 3 * tan2 + eta2 - 9 * tan2 * eta2);
  const IX = tanLat / (720 * rho * nu5) * (61 + 90 * tan2 + 45 * tan4);
  const X = secLat / nu;
  const XI = secLat / (6 * nu3) * (nu / rho + 2 * tan2);
  const XII = secLat / (120 * nu5) * (5 + 28 * tan2 + 24 * tan4);
  const XIIA = secLat / (5040 * nu7) * (61 + 662 * tan2 + 1320 * tan4 + 720 * tan6);

  const dE = E - E0, dE2 = dE * dE, dE3 = dE2 * dE, dE4 = dE2 * dE2,
        dE5 = dE3 * dE2, dE6 = dE4 * dE2, dE7 = dE5 * dE2;
  const latO = lat - VII * dE2 + VIII * dE4 - IX * dE6;
  const lonO = lon0 + X * dE - XI * dE3 + XII * dE5 - XIIA * dE7;

  return helmertToWgs84(latO, lonO);
}

// OSGB36 → WGS84. OS publish the parameters for WGS84→OSGB36; these are those
// values negated, which is the standard inverse for a transform this small.
function helmertToWgs84(lat, lon) {
  const aFrom = 6377563.396, bFrom = 6356256.909;   // Airy 1830
  const aTo = 6378137.000, bTo = 6356752.3142;      // WGS84
  const tx = 446.448, ty = -125.157, tz = 542.060;  // metres
  const rx = 0.1502 / 3600 * Math.PI / 180;         // arcsec → rad
  const ry = 0.2470 / 3600 * Math.PI / 180;
  const rz = 0.8421 / 3600 * Math.PI / 180;
  const s = -20.4894 / 1e6 + 1;                     // ppm → scale factor

  const e2From = 1 - (bFrom * bFrom) / (aFrom * aFrom);
  const sinLat = Math.sin(lat), cosLat = Math.cos(lat);
  const nu = aFrom / Math.sqrt(1 - e2From * sinLat * sinLat);
  const x1 = nu * cosLat * Math.cos(lon);
  const y1 = nu * cosLat * Math.sin(lon);
  const z1 = (1 - e2From) * nu * sinLat;

  const x2 = tx + s * x1 - rz * y1 + ry * z1;
  const y2 = ty + rz * x1 + s * y1 - rx * z1;
  const z2 = tz - ry * x1 + rx * y1 + s * z1;

  const e2To = 1 - (bTo * bTo) / (aTo * aTo);
  const p = Math.sqrt(x2 * x2 + y2 * y2);
  let latT = Math.atan2(z2, p * (1 - e2To)), nuT;
  for (let i = 0; i < 10; i++) {
    nuT = aTo / Math.sqrt(1 - e2To * Math.sin(latT) * Math.sin(latT));
    const next = Math.atan2(z2 + e2To * nuT * Math.sin(latT), p);
    if (Math.abs(next - latT) < 1e-12) { latT = next; break; }
    latT = next;
  }
  return [latT * 180 / Math.PI, Math.atan2(y2, x2) * 180 / Math.PI];
}
