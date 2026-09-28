// Mexico City: every school the Secretaría de Educación Pública (SEP) lists in
// the Ciudad de México, from its Catálogo de Centros de Trabajo (CNCT 2025),
// with enrolment and teachers from the Formato 911 school census (2024-25).
// Both are published by SEP on datos.gob.mx under CC BY 4.0. DESIGN.md §1a,
// §3 (stage) and §4 (no rating: `mx-none`), Phase 6.
//
// WHAT IS A SCHOOL HERE. The CNCT lists every SEP work centre: libraries,
// supervision offices, universities and training centres as well as schools.
// Kept: C_TIPO "ESCUELA" rows at the levels a family chooses a school for —
// inicial (CENDI), preescolar, primaria, secundaria, media superior and CAM
// (special education). Dropped and COUNTED (index.sources.sep.stats):
//   dropped.notASchool        libraries, supervision zones, offices …
//   dropped.plantelDuplicate  "PLANTEL (MEDIA SUPERIOR)": the building record
//                             of a media-superior school that also has its own
//                             ESCUELA row (DESIGN.md §3)
//   dropped.otherLevel        superior, formación para el trabajo, other
//   dropped.adult             schools for adults (característica ADULTOS)
//   dropped.parentSupport     "inicial no escolarizada": parenting programmes
//   dropped.noActiveShift     every shift marked "(INACTIVO)"
//   dropped.notSchoolBased    media superior whose only Formato 911 modality is
//                             "No escolarizada" (online, distance or open
//                             study, e.g. Prepa en Línea-SEP, registered at one
//                             address with 141,992 students)
//
// NO GUESSED LOCATIONS (the owner's decision, DESIGN.md Q6). Held back and
// COUNTED as unmapped.*, never drawn:
//   unmapped.placeholderLocation     ~17 points (one per alcaldía, plus one
//       generic point) where SEP parks schools it has not located: ≥4 schools
//       on one exact point across ≥2 postcodes, and anything within 30 m of
//       such a point (the same centroid written with more decimals)
//   unmapped.impreciseLocation       both coordinates have < 3 decimal places
//   unmapped.locationOutsideMexicoCity  a point outside the city altogether
//   unmapped.locationContradictsAddress the point is > 5 km (and > 3× that
//       postcode's own spread) from the median of ≥3 other SEP centres that
//       share the school's published postcode: the point contradicts the
//       school's own address. See CONTRADICTION below.
// No coordinate is ever repaired from another source (no DENUE, no SIGED): a
// school without a trustworthy published point is counted, not drawn.
//
// NOT CARRIED. No religion field exists in these files. No address, phone,
// e-mail or contact name: the dump carries none of the CNCT's contact columns
// and we read only the columns named below. No test score: Mexico publishes no
// school-level rating (the `mx-none` note says so plainly).
//
// LABELS. English, with the official Spanish term alongside ("Primaria general
// (primary)"): DESIGN.md Q8, owner's decision. Names, colonias, alcaldías and
// authorities are carried exactly as SEP publishes them (upper case); the page
// may display them in title case — displayCase() below is the rule to use.

import { parseCsv, records, columns } from '../lib/csv.mjs';
import { mxStage } from '../lib/stage.mjs';

// ── upstream (pinned: a new vintage is a reviewed change, see probe) ─────────
const CKAN = 'https://www.datos.gob.mx';
const CNCT_PKG = 'catalogo_centros_trabajo_sep';
const F911_PKG = 'registro_alumnado_personal_docente_educacion_basica_media_superior_formato_911';
export const RES = {
  cnct: { id: '3457e135-e83c-43d3-b721-f7fb93c5280c', filters: { INMUEBLE_C_NOM_ENT: 'CIUDAD DE MÉXICO' }, min: 10000,
          label: 'Catálogo de Centros de Trabajo SEP (2025)', vintage: 'CNCT 2025 (cut 13 Nov 2025)' },
  basica: { id: 'da9459bd-c185-44e4-b054-6efc269ea609', filters: { entidad: '9' }, min: 5000,
            label: 'Formato 911, educación básica 2024-2025', vintage: 'Formato 911 2024-25' },
  ms: { id: 'b123343a-ba57-466f-8f12-0019b1878286', filters: { entidad: '9' }, min: 400,
        label: 'Formato 911, educación media superior 2024-2025', vintage: 'Formato 911 2024-25' },
};
// The datastore "dump" is one request per resource and filters server-side.
// Node's default fetch user agent is REQUIRED: datos.gob.mx (Akamai) answers
// 403 to curl, wget, python and any UA containing a URL (DESIGN.md §7 R3).
const dumpUrl = r => `${CKAN}/datastore/dump/${r.id}?format=csv&filters=${encodeURIComponent(JSON.stringify(r.filters))}`;
// Same filters, limit 0: the row total the dump must contain (a truncated
// dump would otherwise look like a city with fewer schools).
const countUrl = r => `${CKAN}/api/3/action/datastore_search?resource_id=${r.id}&limit=0&filters=${encodeURIComponent(JSON.stringify(r.filters))}`;
export const CONALEP = { id: '3f6ad62b-80cd-44fc-a235-3182de752214', filters: { cve_ent: 9 } };   // verify() reference only

const RAW_MAX_AGE_H = 24 * 7;
const CDMX_ENT = 'CIUDAD DE MÉXICO';
// The entity's own extent with a little margin: a point outside it cannot be
// a Mexico City school's building (09DPR1439C sits at -99.90, 80 km west).
const CDMX_EXTENT = [18.98, -99.42, 19.66, -98.88];

const LEVELS = new Set(['INICIAL', 'PREESCOLAR', 'PRIMARIA', 'SECUNDARIA', 'MEDIA SUPERIOR', 'CAM']);

// ── official Spanish terms, with English glosses ────────────────────────────
// Level (TIPONIVELSUB_C_SERVICION2 | SERVICION3, and the característica where
// it names a different kind of school). An unknown combination falls back to
// the Spanish term alone and is counted (gloss.missing) so a refresh shows it.
const LEVEL_GLOSS = {
  'PREESCOLAR|GENERAL': 'Preescolar general (preschool)',
  'PREESCOLAR|COMUNITARIO': 'Preescolar comunitario (community preschool)',
  'PRIMARIA|GENERAL': 'Primaria general (primary)',
  'PRIMARIA|COMUNITARIO': 'Primaria comunitaria (community primary)',
  'SECUNDARIA|GENERAL': 'Secundaria general (lower secondary)',
  'SECUNDARIA|GENERAL|PARA TRABAJADORES': 'Secundaria para trabajadores (lower secondary for working students)',
  'SECUNDARIA|TÉCNICA': 'Secundaria técnica (technical lower secondary)',
  'SECUNDARIA|TELESECUNDARIA': 'Telesecundaria (lower secondary taught with televised lessons)',
  'SECUNDARIA|COMUNITARIO': 'Secundaria comunitaria (community lower secondary)',
  'MEDIA SUPERIOR|BACHILLERATO GENERAL': 'Bachillerato general (upper secondary)',
  'MEDIA SUPERIOR|TECNOLÓGICO': 'Bachillerato tecnológico (technical upper secondary)',
  'MEDIA SUPERIOR|PROFESIONAL TÉCNICO BACHILLER': 'Profesional técnico bachiller (vocational upper secondary)',
  'MEDIA SUPERIOR|PROFESIONAL TÉCNICO': 'Profesional técnico (vocational technician course)',
  'CAM|CAM': 'Centro de Atención Múltiple (special education centre)',
};
// Inicial: the levels a CENDI actually teaches come from its Formato 911 rows,
// not from the CNCT's single level (DESIGN.md §3: 321 CENDIs listed INICIAL
// also teach preescolar; others report only preescolar).
const INICIAL_GLOSS = {
  both: 'Educación inicial y preescolar (early childhood and preschool)',
  pre: 'Preescolar (preschool)',
  ini: 'Educación inicial (early childhood care and education)',
};
const CONTROL_GLOSS = {
  'PÚBLICO|FEDERAL': ['Público', 'public'],
  'PÚBLICO|AUTÓNOMO': ['Público autónomo', 'public, autonomous university'],
  'PRIVADO|PRIVADO': ['Privado', 'private'],
};
const SHIFT_GLOSS = { 1: ['matutino', 'morning'], 2: ['vespertino', 'afternoon'], 3: ['nocturno', 'evening'],
                      4: ['discontinuo', 'split-day'], 5: ['continuo', 'full-day'] };

const and = (list, word) => (list.length <= 1 ? list.join('') : `${list.slice(0, -1).join(', ')} ${word} ${list[list.length - 1]}`);

// "1 - MATUTINO", "2 - VESPERTINO (INACTIVO)" -> active shift numbers.
export function activeShifts(r) {
  return [r.C_TURNO_01, r.C_TURNO_02, r.C_TURNO_03]
    .filter(t => t && !/INACTIVO/i.test(t))
    .map(t => parseInt(t, 10)).filter(n => SHIFT_GLOSS[n])
    .sort((a, b) => a - b);            // "matutino y vespertino" whichever SEP lists first
}

// "Público · turno matutino (public; morning shift)"
export function typeLabel(control, subcontrol, shifts) {
  const c = CONTROL_GLOSS[`${control}|${subcontrol}`] || [control ? control[0] + control.slice(1).toLowerCase() : '', ''];
  const es = shifts.map(n => SHIFT_GLOSS[n][0]), en = shifts.map(n => SHIFT_GLOSS[n][1]);
  const shiftEs = shifts.length ? `${shifts.length > 1 ? 'turnos' : 'turno'} ${and(es, 'y')}` : '';
  const shiftEn = shifts.length ? `${and(en, 'and')} ${shifts.length > 1 ? 'shifts' : 'shift'}` : '';
  const es1 = [c[0], shiftEs].filter(Boolean).join(' · ');
  const en1 = [c[1], shiftEn].filter(Boolean).join('; ');
  return en1 ? `${es1} (${en1})` : es1;
}

// levels911: Set of Formato 911 `nivel` values for this CCT ('Inicial', 'Preescolar' …)
export function levelLabel(r, levels911 = new Set()) {
  const n2 = r.TIPONIVELSUB_C_SERVICION2, n3 = r.TIPONIVELSUB_C_SERVICION3, car = r.CARACTERISTCA_C_CARACTERIZAN2;
  if (n2 === 'INICIAL') {
    const ini = levels911.has('Inicial'), pre = levels911.has('Preescolar');
    return ini && pre ? INICIAL_GLOSS.both : pre ? INICIAL_GLOSS.pre : INICIAL_GLOSS.ini;
  }
  return LEVEL_GLOSS[`${n2}|${n3}|${car}`] || LEVEL_GLOSS[`${n2}|${n3}`] || null;
}

// The deepest operating-authority level SEP publishes (DEPOPERATIVA_C_
// DEPENDENCIAN4 → 3 → 2), as published. Left blank where it is not an
// education authority: a private school's own legal form (INICIATIVA PRIVADA >
// ASOCIACIÓN CIVIL), and 14 CENDIs of IMSS/ISSSTE/DIF coded "EMBAJADA" (an
// upstream coding error: their funding body says IMSS, ISSSTE or DIF).
export function authorityOf(r) {
  if (r.DEPOPERATIVA_C_DEPENDENCIAN1 === 'INICIATIVA PRIVADA' || r.DEPOPERATIVA_C_DEPENDENCIAN2 === 'EMBAJADA') return '';
  return (r.DEPOPERATIVA_C_DEPENDENCIAN4 || r.DEPOPERATIVA_C_DEPENDENCIAN3 || r.DEPOPERATIVA_C_DEPENDENCIAN2 || '').replace(/\s{2,}/g, ' ').trim();
}

// The datastore types the código postal as a number, so "06030" arrives as
// "6030". Mexican postcodes are five digits; "0" means none.
export function postcodeOf(v) {
  const s = String(v || '').trim();
  if (!/^\d{4,5}$/.test(s) || +s === 0) return '';
  return s.padStart(5, '0');
}

const decimals = v => (String(v).split('.')[1] || '').length;

const haversine = (a, b, c, d) => {
  const R = 6371008.8, t = x => x * Math.PI / 180;
  const dp = t(c - a), dl = t(d - b);
  return 2 * R * Math.asin(Math.sqrt(Math.sin(dp / 2) ** 2 + Math.cos(t(a)) * Math.cos(t(c)) * Math.sin(dl / 2) ** 2));
};
const quantile = (a, p) => { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(s.length * p))]; };

// ── placeholder points ──────────────────────────────────────────────────────
// SEP parks schools it has not located on a point per alcaldía (and one
// generic point). They are exact shared points no real building produces:
// ≥ PH_MIN schools across ≥ 2 different postcodes. Counted over every school
// row (including adult and parent programmes, which share them), so the rule
// does not depend on what is later dropped. Verified: 17 points, 720 rows.
const PH_MIN = 4, PH_NEAR_M = 30;
export function placeholderPoints(rows) {
  const pts = new Map();
  for (const r of rows) {
    const k = `${r.INMUEBLE_LATITUD},${r.INMUEBLE_LONGITUD}`;
    const s = pts.get(k) || { lat: +r.INMUEBLE_LATITUD, lng: +r.INMUEBLE_LONGITUD, n: 0, pc: new Set() };
    s.n++; s.pc.add(postcodeOf(r.INMUEBLE_CV_CODIGO_POSTAL)); pts.set(k, s);
  }
  return [...pts.values()].filter(s => s.n >= PH_MIN && s.pc.size >= 2);
}
const nearPlaceholder = (ph, lat, lng) => ph.some(p => haversine(lat, lng, p.lat, p.lng) <= PH_NEAR_M);

// ── CONTRADICTION: a point far from every other centre in its own postcode ───
// Mexico City postcodes are small (median spread of their SEP centres ~0.9 km).
// A school whose point lies > 5 km from the median of ≥ 3 OTHER SEP centres
// in its published postcode — and > 3× that postcode's own 90th-percentile
// spread, so large rural postcodes are not penalised — is not where its own
// address says. Checked against SEP's own SIGED record of each of the 41 held
// back in Sept 2026: SIGED places 20 inside their postcode (the catalogue point
// is wrong), 14 repeat the catalogue point (SIGED copies it, so no independent
// evidence), 7 are elsewhere again; none supports the catalogue point against
// the address (evidence: scratchpad schools-build/mexico/contradictions.json).
// Peers are every CNCT centre (any type) not on a placeholder, never the
// school itself or its own point.
const CONTRA_MIN_M = 5000, CONTRA_SPREAD_X = 3, CONTRA_PEERS = 3;
export function contradictionChecker(allRows, isPlaceholder) {
  const byCp = new Map();
  for (const r of allRows) {
    const cp = postcodeOf(r.INMUEBLE_CV_CODIGO_POSTAL);
    const lat = +r.INMUEBLE_LATITUD, lng = +r.INMUEBLE_LONGITUD;
    if (!cp || !Number.isFinite(lat) || !Number.isFinite(lng) || isPlaceholder(lat, lng)) continue;
    if (lat < CDMX_EXTENT[0] || lat > CDMX_EXTENT[2] || lng < CDMX_EXTENT[1] || lng > CDMX_EXTENT[3]) continue;
    (byCp.get(cp) || byCp.set(cp, []).get(cp)).push({ cct: r.CV_CCT, lat, lng });
  }
  return (cct, cp, lat, lng) => {
    const peers = (byCp.get(cp) || []).filter(p => p.cct !== cct && !(p.lat === lat && p.lng === lng));
    if (peers.length < CONTRA_PEERS) return null;
    const mlat = quantile(peers.map(p => p.lat), 0.5), mlng = quantile(peers.map(p => p.lng), 0.5);
    const spread = quantile(peers.map(p => haversine(p.lat, p.lng, mlat, mlng)), 0.9);
    const d = haversine(lat, lng, mlat, mlng);
    return d > Math.max(CONTRA_MIN_M, CONTRA_SPREAD_X * spread) ? { d: Math.round(d), spread: Math.round(spread), peers: peers.length } : null;
  };
}

// ── Formato 911 ─────────────────────────────────────────────────────────────
// Básica: one row per CCT × shift × level. Students = insc_t ("inscripción
// total"); teachers = tot_doc_p ("total de personal docente": class teachers
// and directors who teach a class, plus subject teachers in secundaria — SEP's
// own total; the datastore dictionary defines it). Summed over the CCT's
// active shifts (and, for a CENDI, both levels).
// Media superior: `escuela` = CCT + shift digit; students `alumnos`, teachers
// `docentes`; only the "Escolarizada" (school-based) modality is counted.
export function index911(basica, ms) {
  const by = new Map();
  const get = cct => by.get(cct) || by.set(cct, { rows: [], levels: new Set(), modal: new Set() }).get(cct);
  for (const r of basica) {
    const e = get(r.clave_cct);
    e.rows.push({ shift: parseInt(r.turno, 10), pupils: +r.insc_t || 0, teachers: +r.tot_doc_p || 0, school: true });
    e.levels.add(r.nivel);
  }
  for (const r of ms) {
    const e = get(r.escuela.slice(0, 10));
    const school = r.modalidad === 'Escolarizada';
    e.modal.add(r.modalidad);
    e.rows.push({ shift: parseInt(r.escuela.slice(10), 10), pupils: +r.alumnos || 0, teachers: +r.docentes || 0, school });
    e.levels.add(r.nivel);
  }
  return by;
}

// ── fetch ───────────────────────────────────────────────────────────────────
const CNCT_COLS = ['CV_CCT', 'C_NOMBRE', 'C_TIPO', 'INMUEBLE_C_NOM_ENT', 'INMUEBLE_C_NOM_MUN', 'INMUEBLE_C_NOM_ASEN',
  'INMUEBLE_CV_CODIGO_POSTAL', 'INMUEBLE_LATITUD', 'INMUEBLE_LONGITUD', 'SOSTENIMIENTO_C_CONTROL', 'SOSTENIMIENTO_C_SUBCONTROL',
  'DEPOPERATIVA_C_DEPENDENCIAN1', 'DEPOPERATIVA_C_DEPENDENCIAN2', 'DEPOPERATIVA_C_DEPENDENCIAN3', 'DEPOPERATIVA_C_DEPENDENCIAN4',
  'C_TURNO_01', 'C_TURNO_02', 'C_TURNO_03', 'TIPONIVELSUB_C_SERVICION2', 'TIPONIVELSUB_C_SERVICION3', 'CARACTERISTCA_C_CARACTERIZAN2'];
const BASICA_COLS = ['entidad', 'clave_cct', 'turno', 'nivel', 'insc_t', 'tot_doc_p'];
const MS_COLS = ['entidad', 'escuela', 'modalidad', 'nivel', 'alumnos', 'docentes'];

async function load(ctx, key, file, cols) {
  const r = RES[key];
  const buf = await ctx.download(file, dumpUrl(r), { maxAgeH: RAW_MAX_AGE_H, timeoutMs: 300_000 });
  const cnt = JSON.parse((await ctx.download(`${file}.count.json`, countUrl(r), { maxAgeH: RAW_MAX_AGE_H })).toString('utf8'));
  const { header } = parseCsv(buf.subarray(0, 64 * 1024), { encoding: 'utf-8' });
  columns(header, cols, `${r.label} (datos.gob.mx datastore dump)`);   // fails loudly on a renamed column
  const rows = records(buf, { encoding: 'utf-8', slack: 0 });
  const total = cnt?.result?.total;
  if (!Number.isInteger(total) || rows.length !== total) throw new Error(`${r.label}: the dump has ${rows.length} rows but the datastore reports ${total} for the same filter — refusing a partial download`);
  if (rows.length < r.min) throw new Error(`${r.label}: only ${rows.length} rows (expected ≥ ${r.min}) — refusing to publish a partial city`);
  return rows;
}

export function buildRows({ cnct, basica, ms }, ctx) {
  const stat = ctx.stat, warn = ctx.warn || (() => {});
  // ctx.trace (optional, evidence runs only): (cct, reason) for every school row not drawn.
  const skip = (r, reason) => { stat(reason); if (ctx.trace && r.C_TIPO === 'ESCUELA') ctx.trace(r.CV_CCT, reason); };
  const f911 = index911(basica, ms);
  const schools = cnct.filter(r => r.C_TIPO === 'ESCUELA' && LEVELS.has(r.TIPONIVELSUB_C_SERVICION2));
  const ph = placeholderPoints(schools);
  const isPh = (lat, lng) => nearPlaceholder(ph, lat, lng);
  const contradicts = contradictionChecker(cnct, isPh);
  stat('placeholderPoints', ph.length);

  const out = [];
  for (const r of cnct) {
    if (r.INMUEBLE_C_NOM_ENT !== CDMX_ENT) { skip(r, 'dropped.otherEntity'); continue; }   // never, with the entity filter
    if (r.C_TIPO === 'PLANTEL (MEDIA SUPERIOR)') { skip(r, 'dropped.plantelDuplicate'); continue; }
    if (r.C_TIPO !== 'ESCUELA') { skip(r, 'dropped.notASchool'); continue; }
    const n2 = r.TIPONIVELSUB_C_SERVICION2;
    if (!LEVELS.has(n2)) { skip(r, 'dropped.otherLevel'); continue; }
    if (r.CARACTERISTCA_C_CARACTERIZAN2 === 'ADULTOS') { skip(r, 'dropped.adult'); continue; }
    if (r.TIPONIVELSUB_C_SERVICION3 === 'INICIAL NO ESCOLARIZADA' || r.CARACTERISTCA_C_CARACTERIZAN2 === 'ATENCIÓN A PADRES') { skip(r, 'dropped.parentSupport'); continue; }
    const shifts = activeShifts(r);
    if (!shifts.length) { skip(r, 'dropped.noActiveShift'); continue; }
    const e = f911.get(r.CV_CCT);
    if (n2 === 'MEDIA SUPERIOR' && e && e.modal.size && !e.modal.has('Escolarizada')) { skip(r, 'dropped.notSchoolBased'); continue; }

    // ── location: published, precise, in the city, consistent with its address
    const latS = r.INMUEBLE_LATITUD, lngS = r.INMUEBLE_LONGITUD;
    const lat = +latS, lng = +lngS;
    if (!latS || !lngS || !Number.isFinite(lat) || !Number.isFinite(lng) || lat === 0) { skip(r, 'unmapped.noCoordinates'); continue; }
    if (isPh(lat, lng)) { skip(r, 'unmapped.placeholderLocation'); continue; }
    if (decimals(latS) < 3 && decimals(lngS) < 3) { skip(r, 'unmapped.impreciseLocation'); continue; }
    if (lat < CDMX_EXTENT[0] || lat > CDMX_EXTENT[2] || lng < CDMX_EXTENT[1] || lng > CDMX_EXTENT[3]) { skip(r, 'unmapped.locationOutsideMexicoCity'); continue; }
    const postcode = postcodeOf(r.INMUEBLE_CV_CODIGO_POSTAL);
    if (postcode && contradicts(r.CV_CCT, postcode, lat, lng)) { skip(r, 'unmapped.locationContradictsAddress'); continue; }

    // ── the row ──
    let pupils = null, teachers = null;
    if (e) {
      const use = e.rows.filter(x => x.school && shifts.includes(x.shift));
      if (use.length < e.rows.filter(x => x.school).length) stat('f911.rowsOnInactiveShift', e.rows.filter(x => x.school).length - use.length);
      if (use.length) { pupils = use.reduce((a, x) => a + x.pupils, 0); teachers = use.reduce((a, x) => a + x.teachers, 0); stat('f911.matched'); }
      else stat('f911.noActiveShiftRows');
    } else stat('f911.notInCensus');
    let phase = levelLabel(r, e?.levels);
    if (!phase) {
      phase = [n2, r.TIPONIVELSUB_C_SERVICION3].filter(Boolean).join(' ').toLowerCase().replace(/^./, c => c.toUpperCase());
      stat('gloss.missing'); warn(`no English gloss for level ${n2} | ${r.TIPONIVELSUB_C_SERVICION3} | ${r.CARACTERISTCA_C_CARACTERIZAN2} (${r.CV_CCT})`);
    }
    if (!CONTROL_GLOSS[`${r.SOSTENIMIENTO_C_CONTROL}|${r.SOSTENIMIENTO_C_SUBCONTROL}`]) { stat('gloss.missingControl'); warn(`no gloss for control ${r.SOSTENIMIENTO_C_CONTROL}|${r.SOSTENIMIENTO_C_SUBCONTROL}`); }
    const la = authorityOf(r);
    if (!la) stat('authority.notPublished');
    out.push({
      src: 'sep', id: r.CV_CCT, name: r.C_NOMBRE.replace(/\s{2,}/g, ' ').trim(), postcode,
      lat: +lat.toFixed(5), lng: +lng.toFixed(5),
      juris: 'MX-CMX',                                   // from the CNCT's own entity field (checked above)
      type: typeLabel(r.SOSTENIMIENTO_C_CONTROL, r.SOSTENIMIENTO_C_SUBCONTROL, shifts),
      sector: r.SOSTENIMIENTO_C_CONTROL === 'PRIVADO' ? 'private' : 'state',
      stage: mxStage(n2), phase,
      boarding: r.CARACTERISTCA_C_CARACTERIZAN2 === 'INTERNADO',
      pupils, teachers, la,
      area: [r.INMUEBLE_C_NOM_ASEN, r.INMUEBLE_C_NOM_MUN].map(s => (s || '').replace(/\s{2,}/g, ' ').trim()).filter(Boolean).join(', '),
      ratingScheme: 'mx-none',
    });
  }
  return out;
}

async function fetchRows(ctx) {
  const cnct = await load(ctx, 'cnct', 'cnct-2025-cdmx.csv', CNCT_COLS);
  const basica = await load(ctx, 'basica', 'f911-basica-2024-25-cdmx.csv', BASICA_COLS);
  const ms = await load(ctx, 'ms', 'f911-media-superior-2024-25-cdmx.csv', MS_COLS);
  const rows = buildRows({ cnct, basica, ms }, ctx);
  ctx.vintage(`${RES.cnct.vintage}; ${RES.basica.vintage}`);
  return rows;
}

// ── probe: is there a newer catalogue or census than the pinned one? ────────
async function probe(ctx) {
  const show = async id => (await (await fetch(`${CKAN}/api/3/action/package_show?id=${id}`, { signal: AbortSignal.timeout(60_000) })).json()).result.resources;
  const cn = (await show(CNCT_PKG)).map(r => ({ id: r.id, y: +((/\((\d{4})\)/.exec(r.name) || [])[1] || 0) })).filter(r => r.y).sort((a, b) => b.y - a.y)[0];
  const f9 = (await show(F911_PKG)).filter(r => /educación básica/i.test(r.name))
    .map(r => ({ id: r.id, y: +((/(\d{4})-\d{4}/.exec(r.name) || [])[1] || 0) })).sort((a, b) => b.y - a.y)[0];
  const changed = (cn && cn.id !== RES.cnct.id) || (f9 && f9.id !== RES.basica.id);
  return { vintage: `CNCT ${cn?.y}; Formato 911 ${f9?.y}-${String((f9?.y || 0) + 1).slice(2)}`, changed: !!changed };
}

// ── verify (verify-schools position hook) ───────────────────────────────────
// 1. No placeholder cluster left on the map. 2. No imprecise point. 3. An
// independent reference: CONALEP's own published plantel locations (CONALEP,
// datos.gob.mx, CC BY 4.0), joined by CCT — DESIGN.md §6b, median ≤ 50 m.
async function verify(rows, { haversine: hv = haversine } = {}) {
  const checks = [];
  const pts = new Map();
  for (const r of rows) { const k = `${r.lat},${r.lng}`; const s = pts.get(k) || { n: 0, pc: new Set() }; s.n++; s.pc.add(r.postcode); pts.set(k, s); }
  const clusters = [...pts].filter(([, s]) => s.n >= PH_MIN && s.pc.size >= 2);
  checks.push({ juris: 'MX-CMX', check: 'position', reference: 'placeholder-cluster rule (≥4 schools, ≥2 postcodes, one point)',
    pass: clusters.length === 0, message: clusters.length ? `${clusters.length} placeholder-like point(s) on the map, e.g. ${clusters.slice(0, 3).map(([k, s]) => `${k} ×${s.n}`).join(', ')}` : `no placeholder clusters among ${rows.length} schools` });
  const coarse = rows.filter(r => decimals(r.lat) < 3 && decimals(r.lng) < 3);
  checks.push({ juris: 'MX-CMX', check: 'position', reference: 'coordinate precision', pass: coarse.length === 0,
    message: coarse.length ? `${coarse.length} point(s) with < 3 decimal places, e.g. ${coarse.slice(0, 3).map(r => r.id).join(', ')}` : 'every point has ≥ 3 decimal places in at least one coordinate' });
  const res = await fetch(`${CKAN}/datastore/dump/${CONALEP.id}?format=csv&filters=${encodeURIComponent(JSON.stringify(CONALEP.filters))}`, { signal: AbortSignal.timeout(60_000) });
  if (!res.ok) throw new Error(`CONALEP planteles HTTP ${res.status}`);
  const ref = new Map(records(Buffer.from(await res.arrayBuffer())).map(r => [r.cct, r]));
  const off = rows.filter(r => ref.has(r.id)).map(r => { const c = ref.get(r.id); return { id: r.id, m: hv(r.lat, r.lng, +c.latitud, +c.longitud) }; })
    .filter(o => Number.isFinite(o.m)).sort((a, b) => a.m - b.m);
  if (off.length < 10) checks.push({ juris: 'MX-CMX', check: 'position', reference: 'CONALEP plantel locations', pass: false, message: `only ${off.length} CONALEP planteles matched by CCT — too few to conclude anything` });
  else {
    const med = off[Math.floor(off.length / 2)].m, p90 = off[Math.floor(off.length * 0.9)].m, worst = off[off.length - 1];
    checks.push({ juris: 'MX-CMX', check: 'position', reference: 'CONALEP plantel locations (CONALEP, datos.gob.mx)', pass: med <= 50,
      message: `${off.length} planteles: median ${med.toFixed(0)} m, p90 ${p90.toFixed(0)} m, worst ${worst.m.toFixed(0)} m (${worst.id}); limit median 50 m` });
  }
  return checks;
}

// ── display rule for the page (not applied to the data) ─────────────────────
// SEP publishes names, colonias, alcaldías and authorities in capitals. The
// page may show them in title case with Spanish small words in lower case,
// keeping roman numerals, dotted abbreviations and initialisms as written:
//   "ESCUELA SECUNDARIA TÉCNICA 101" -> "Escuela Secundaria Técnica 101"
//   "SAN JUAN DE ARAGÓN VII SECCIÓN, GUSTAVO A. MADERO" -> "San Juan de Aragón VII Sección, Gustavo A. Madero"
//   "TECNOLOGICO UNIVERSITARIO DE MEXICO (TUM)" -> "Tecnologico Universitario de Mexico (TUM)"
//   "CULHUACÁN CTM SECCIÓN PILOTO" -> "Culhuacán CTM Sección Piloto"
//   'PRIMARIA "LA CORREGIDORA"' -> 'Primaria "La Corregidora"' (a quotation starts a phrase)
// Initialisms: a known one (ACRONYM), any 2-5 letter word with no vowel (CTM,
// DF, GDF, SSP; Y counts as a vowel: GYM, MY) unless it is an abbreviated word
// (WORD: DR, SR, ST …), and a 2-5 letter word alone in parentheses ("(SSA)").
// A lone "A" stays a capital where it is an initial, not the preposition "a":
// next to another single letter ("A B C", "A C", "C A D I") or after a given
// name that SEP writes with its initial undotted ("GUSTAVO A MADERO").
const SMALL = new Set(['de', 'del', 'la', 'las', 'los', 'el', 'y', 'e', 'o', 'u', 'a', 'al', 'en', 'con', 'para', 'por', 'sin']);
const ACRONYM = new Set(['CENDI', 'CADI', 'CAM', 'CCH', 'UNAM', 'UAM', 'IPN', 'IMSS', 'ISSSTE', 'DIF', 'GDF', 'SEP', 'CONALEP', 'CETIS', 'CBTIS',
  'CECYT', 'CBTA', 'IEMS', 'CONAFE', 'AEFCM', 'INBAL', 'EBDI', 'CDMX', 'UVM', 'ITESM', 'SNTE', 'ISSFAM', 'SEDENA', 'PEMEX', 'CFE', 'DGETI', 'DGB',
  'CAI', 'CAPEP', 'INPI', 'CTM', 'DF']);
const WORD = new Set(['DR', 'SR', 'DN', 'SN', 'ST', 'STS', 'MRS', 'CD', 'MC']);
const INITIAL_AFTER = new Set(['GUSTAVO', 'EZEQUIEL']);
const ROMAN = /^(?=[IVXL]+$)(XL|L?X{0,3})(IX|IV|V?I{0,3})$/;
export function displayCase(s) {
  if (!s) return s;
  return s.split(/(,\s*)/).map(part => {             // each comma-separated part starts a new phrase
    if (/^,/.test(part) || part !== part.toUpperCase()) return part;   // mixed case is the publisher's own styling
    const cores = (part.match(/[^\s/]+/g) || []).map(w => w.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, ''));
    let first = true, k = -1;
    return part.replace(/[^\s/]+/g, w => {
      k++;
      const i = w.search(/[\p{L}\p{N}]/u);
      if (i < 0) return w;
      const j = w.length - [...w].reverse().join('').search(/[\p{L}\p{N}]/u);
      const lead = w.slice(0, i), core = w.slice(i, j), tail = w.slice(j);
      if (/["“«(]/.test(lead)) first = true;            // a quotation or parenthesis starts a phrase: "LA CORREGIDORA" -> "La Corregidora"
      let out;
      if (/^(\p{Lu}\.)+\p{Lu}$/u.test(core) || (core.length === 1 && tail.startsWith('.'))) out = core;   // A.C., E.B.D.I., the "A." in "Gustavo A. Madero"
      else if (lead.endsWith('(') && tail.startsWith(')') && /^\p{L}{2,5}$/u.test(core) && !SMALL.has(core.toLowerCase())) out = core;   // "(TUM)"
      else if (core === 'A' && (cores[k - 1]?.length === 1 || cores[k + 1]?.length === 1 || INITIAL_AFTER.has(cores[k - 1]))) out = core;   // "A B C", "GUSTAVO A MADERO"
      else if (ACRONYM.has(core) || ROMAN.test(core) || /\d/.test(core)) out = core;              // CENDI, VII, 4A, 09DPR…
      else if (!first && SMALL.has(core.toLowerCase())) out = core.toLowerCase();
      else if (!WORD.has(core) && /^[^AEIOUYÁÉÍÓÚÜ]{2,5}$/u.test(core)) out = core;              // CTM, SSP, GGM: initialisms
      else out = core.toLowerCase().replace(/(?<=^|-|^\p{L}['’`´])\p{L}/gu, c => c.toUpperCase());   // O'FARRILL -> O'Farrill
      first = false;
      return lead + out + tail;
    });
  }).join('');
}

// ── wording (copied into index.json) ────────────────────────────────────────
export default {
  id: 'sep',
  juris: ['MX-CMX'],
  cadence: 'annual',
  meta: {
    name: 'SEP Catálogo de Centros de Trabajo 2025 and Formato 911 school census 2024-25',
    publisher: 'Secretaría de Educación Pública (SEP), on datos.gob.mx',
    licence: 'Creative Commons Attribution 4.0 International (CC BY 4.0)',
    licenceUrl: 'https://creativecommons.org/licenses/by/4.0/',
    attribution: 'CCT {id} · Fuente: SEP, Catálogo de Centros de Trabajo 2025 y Estadística del Formato 911, ciclo 2024-2025 (datos.gob.mx, CC BY 4.0); adapted by SafeRoute.',
    // SIGED is SEP's own school finder. The link opens it with this school's
    // CCT already in the search box (its escuelas.js reads ?cct=); one press of
    // "Buscar" shows the school. Checked in Chrome, Sept 2026 — hence the label.
    recordUrl: 'https://www.siged.sep.gob.mx/SIGED/escuelas.html?cct={id}',
    recordLabel: 'Look it up in SEP’s school finder (SIGED)',
    // SEP publishes names, colonias and authorities in capitals: /check/ shows
    // them with displayCase() below (its schCase, 'es' rules — the same rule,
    // proved equal by tools/schools/test/display-case.test.mjs).
    displayCase: 'es',
    where: 'Mexico City',
    publishes: ['boarding'],
    pupilsAsOf: '2024-25',
    labels: {
      type: 'Funding and shift', phase: 'Level', pupils: 'Students', teachers: 'Teachers',
      boarding: 'Boarding (internado)', la: 'Education authority',
      pupilsAsOf: 'Students and teachers: SEP’s Formato 911 census at the start of the {date} school year.',
    },
  },
  schemes: {
    'mx-none': {
      kind: 'none',
      notes: [{
        // PLANEA, the last national test with school-by-school results: its
        // basic-education test was last given to lower-secondary schools (3°
        // de secundaria) on 11-12 June 2019, and its upper-secondary test
        // (PLANEA Educación Media Superior) on 5-6 April 2022, in public and
        // private schools, with results published per school (CCT) — e.g.
        // Chihuahua's "08_escuelas_pms2022.xlsx", Tabasco's "Resultados PLANEA
        // Media Superior 2022 (Escuelas)". IMCO (24 Jan 2023): the last
        // secundaria application was 2019 and EMS had one in 2022; reporting
        // in Sept 2026 finds none since. No later application was found (Sept
        // 2026). Mejoredu: abolished by the constitutional reform published in
        // the DOF on 20 Dec 2024; it closed in 2025 and its functions passed
        // to the SEP.
        html: '<b>Mexico does not publish an official rating or inspection result for individual schools.</b> ' +
          'PLANEA, the national test whose results were published school by school, was last given in 2019 in lower-secondary ' +
          'schools and in 2022 in upper-secondary schools, and it has not been replaced by any school rating. Mejoredu, ' +
          'the federal body that evaluated education, was abolished by a constitutional reform in December 2024.',
      }],
    },
  },
  fetch: fetchRows,
  probe,
  verify,
};
