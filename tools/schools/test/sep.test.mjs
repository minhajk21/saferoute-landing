// node --test tools/schools/test/sep.test.mjs
// Mexico City (sources/sep.mjs): every rule that decides whether a school is
// drawn, and how it is worded, on small hand-made rows shaped like the SEP
// datastore dumps (no network).
import test from 'node:test';
import assert from 'node:assert/strict';
import sep, { buildRows, activeShifts, typeLabel, levelLabel, authorityOf, postcodeOf, placeholderPoints, displayCase, index911 } from '../sources/sep.mjs';
import { rowProblems } from '../lib/schema.mjs';
import { loadCoverage } from '../lib/coverage.mjs';

// A CNCT row with sensible defaults; override what a test is about.
let n = 0;
const cct = (o = {}) => ({
  CV_CCT: `09DPR${String(++n).padStart(4, '0')}X`, C_NOMBRE: 'BENITO JUÁREZ', C_TIPO: 'ESCUELA',
  INMUEBLE_C_NOM_ENT: 'CIUDAD DE MÉXICO', INMUEBLE_C_NOM_MUN: 'COYOACÁN', INMUEBLE_C_NOM_ASEN: 'DEL CARMEN',
  INMUEBLE_CV_CODIGO_POSTAL: '4100', INMUEBLE_LATITUD: String(19.35 + n * 1e-4), INMUEBLE_LONGITUD: '-99.162311',
  SOSTENIMIENTO_C_CONTROL: 'PÚBLICO', SOSTENIMIENTO_C_SUBCONTROL: 'FEDERAL',
  DEPOPERATIVA_C_DEPENDENCIAN1: 'PRESIDENCIA DE LA REPÚBLICA', DEPOPERATIVA_C_DEPENDENCIAN2: 'SECRETARÍA DE EDUCACIÓN PÚBLICA',
  DEPOPERATIVA_C_DEPENDENCIAN3: 'ORGANOS DESCONCENTRADOS DE LA SECRETARÍA DE EDUCACIÓN PÚBLICA',
  DEPOPERATIVA_C_DEPENDENCIAN4: 'AUTORIDAD EDUCATIVA FEDERAL DE LA CIUDAD DE MÉXICO',
  C_TURNO_01: '1 - MATUTINO', C_TURNO_02: '', C_TURNO_03: '',
  TIPONIVELSUB_C_SERVICION2: 'PRIMARIA', TIPONIVELSUB_C_SERVICION3: 'GENERAL', CARACTERISTCA_C_CARACTERIZAN2: 'NO APLICA',
  ...o,
});
const run = (cnct, basica = [], ms = []) => {
  const stats = {}, traced = {};
  const rows = buildRows({ cnct, basica, ms }, { stat: (k, v = 1) => { stats[k] = (stats[k] || 0) + v; }, trace: (id, why) => { traced[id] = why; } });
  return { rows, stats, traced };
};

test('sep: a plain public primary becomes a valid v2 row in scope', () => {
  const r = cct({ CV_CCT: '09DPR2060Q', C_NOMBRE: 'MIGUEL HIDALGO Y COSTILLA', INMUEBLE_CV_CODIGO_POSTAL: '12400', INMUEBLE_LATITUD: '19.18521', INMUEBLE_LONGITUD: '-99.074906' });
  const { rows } = run([r], [{ clave_cct: '09DPR2060Q', turno: '1', nivel: 'Primaria', insc_t: '467', tot_doc_p: '12' }]);
  assert.equal(rows.length, 1);
  const o = rows[0];
  assert.deepEqual(rowProblems(o, sep), []);
  assert.equal(o.id, '09DPR2060Q');
  assert.equal(o.postcode, '12400');
  assert.equal(o.stage, 'Primary');
  assert.equal(o.sector, 'state');
  assert.equal(o.phase, 'Primaria general (primary)');
  assert.equal(o.type, 'Público · turno matutino (public; morning shift)');
  assert.equal(o.pupils, 467);
  assert.equal(o.teachers, 12);
  assert.equal(o.la, 'AUTORIDAD EDUCATIVA FEDERAL DE LA CIUDAD DE MÉXICO');
  assert.equal(o.area, 'DEL CARMEN, COYOACÁN');
  assert.equal(o.ratingScheme, 'mx-none');
  assert.equal(o.juris, 'MX-CMX');
  assert.equal(loadCoverage().regionFor(o.lat, o.lng, o.juris)?.id, 'mexicocity');
});

test('sep: stage follows the official level; CAM is "not published"', () => {
  const lv = { INICIAL: 'Nursery', PREESCOLAR: 'Nursery', PRIMARIA: 'Primary', SECUNDARIA: 'Secondary', 'MEDIA SUPERIOR': 'Secondary', CAM: '' };
  const serv = { INICIAL: 'LACTANTE Y MATERNAL', PREESCOLAR: 'GENERAL', PRIMARIA: 'GENERAL', SECUNDARIA: 'TÉCNICA', 'MEDIA SUPERIOR': 'BACHILLERATO GENERAL', CAM: 'CAM' };
  const { rows } = run(Object.keys(lv).map(l => cct({ TIPONIVELSUB_C_SERVICION2: l, TIPONIVELSUB_C_SERVICION3: serv[l] })));
  assert.deepEqual(rows.map(r => r.stage), Object.values(lv));
  assert.equal(rows[5].phase, 'Centro de Atención Múltiple (special education centre)');
});

test('sep: drops what is not a school a family chooses — counted, never silently', () => {
  const { rows, stats } = run([
    cct({ C_TIPO: 'BIBLIOTECA' }),
    cct({ C_TIPO: 'PLANTEL (MEDIA SUPERIOR)', TIPONIVELSUB_C_SERVICION2: 'MEDIA SUPERIOR' }),
    cct({ TIPONIVELSUB_C_SERVICION2: 'SUPERIOR', TIPONIVELSUB_C_SERVICION3: 'LICENCIATURA Y POSGRADO' }),
    cct({ CARACTERISTCA_C_CARACTERIZAN2: 'ADULTOS' }),
    cct({ TIPONIVELSUB_C_SERVICION2: 'INICIAL', TIPONIVELSUB_C_SERVICION3: 'INICIAL NO ESCOLARIZADA', CARACTERISTCA_C_CARACTERIZAN2: 'ATENCIÓN A PADRES' }),
    cct({ C_TURNO_01: '2 - VESPERTINO (INACTIVO)', C_TURNO_02: '3 - NOCTURNO (INACTIVO)' }),
    cct({ CV_CCT: '09DBH0001D', TIPONIVELSUB_C_SERVICION2: 'MEDIA SUPERIOR', TIPONIVELSUB_C_SERVICION3: 'BACHILLERATO GENERAL' }),
    cct(),
  ], [], [{ escuela: '09DBH0001D4', modalidad: 'No Escolarizada', nivel: 'Media Superior', alumnos: '141992', docentes: '1' }]);
  assert.equal(rows.length, 1);
  for (const k of ['dropped.notASchool', 'dropped.plantelDuplicate', 'dropped.otherLevel', 'dropped.adult', 'dropped.parentSupport', 'dropped.noActiveShift', 'dropped.notSchoolBased']) assert.equal(stats[k], 1, k);
});

test('sep: a school with some inactive shifts keeps only its active ones', () => {
  const r = cct({ C_TURNO_01: '2 - VESPERTINO', C_TURNO_02: '1 - MATUTINO (INACTIVO)', C_TURNO_03: '1 - MATUTINO' });
  assert.deepEqual(activeShifts(r), [1, 2]);
  assert.equal(typeLabel('PÚBLICO', 'FEDERAL', [1, 2]), 'Público · turnos matutino y vespertino (public; morning and afternoon shifts)');
  assert.equal(typeLabel('PRIVADO', 'PRIVADO', [5]), 'Privado · turno continuo (private; full-day shift)');
  assert.equal(typeLabel('PÚBLICO', 'AUTÓNOMO', [4]), 'Público autónomo · turno discontinuo (public, autonomous university; split-day shift)');
  // enrolment sums the CCT's active shifts only
  const { rows } = run([cct({ CV_CCT: '09DES0001A', TIPONIVELSUB_C_SERVICION2: 'SECUNDARIA', C_TURNO_01: '1 - MATUTINO', C_TURNO_02: '2 - VESPERTINO (INACTIVO)' })],
    [{ clave_cct: '09DES0001A', turno: '1', nivel: 'Secundaria', insc_t: '300', tot_doc_p: '20' },
     { clave_cct: '09DES0001A', turno: '2', nivel: 'Secundaria', insc_t: '100', tot_doc_p: '9' }]);
  assert.equal(rows[0].pupils, 300);
  assert.equal(rows[0].teachers, 20);
});

test('sep: CENDI level text comes from the Formato 911 levels it teaches', () => {
  const ini = cct({ TIPONIVELSUB_C_SERVICION2: 'INICIAL', TIPONIVELSUB_C_SERVICION3: 'LACTANTE Y MATERNAL' });
  assert.equal(levelLabel(ini, new Set(['Inicial', 'Preescolar'])), 'Educación inicial y preescolar (early childhood and preschool)');
  assert.equal(levelLabel(ini, new Set(['Preescolar'])), 'Preescolar (preschool)');
  assert.equal(levelLabel(ini, new Set()), 'Educación inicial (early childhood care and education)');
  const e = index911([{ clave_cct: 'X', turno: '1', nivel: 'Inicial', insc_t: '6', tot_doc_p: '1' }, { clave_cct: 'X', turno: '1', nivel: 'Preescolar', insc_t: '35', tot_doc_p: '4' }], []).get('X');
  assert.equal(e.rows.reduce((a, x) => a + x.pupils, 0), 41);
  assert.equal(levelLabel(cct({ TIPONIVELSUB_C_SERVICION2: 'SECUNDARIA', CARACTERISTCA_C_CARACTERIZAN2: 'PARA TRABAJADORES' })), 'Secundaria para trabajadores (lower secondary for working students)');
});

test('sep: placeholder points are held back, with the same point written more precisely', () => {
  const ph = ['19.4416', '-99.1519'];
  const list = [0, 1, 2, 3].map(i => cct({ INMUEBLE_LATITUD: ph[0], INMUEBLE_LONGITUD: ph[1], INMUEBLE_CV_CODIGO_POSTAL: String(6000 + i * 10) }));
  const near = cct({ INMUEBLE_LATITUD: '19.441647', INMUEBLE_LONGITUD: '-99.151884' });                      // ~6 m away
  // Four schools on one point in ONE postcode is a real building (a shared site), not a placeholder.
  const site = [0, 1, 2, 3].map(() => cct({ INMUEBLE_LATITUD: '19.361606', INMUEBLE_LONGITUD: '-99.184074', INMUEBLE_CV_CODIGO_POSTAL: '1020' }));
  assert.equal(placeholderPoints([...list, ...site]).length, 1);
  const { rows, stats } = run([...list, near, ...site, cct()]);
  assert.equal(stats['unmapped.placeholderLocation'], 5);
  assert.equal(rows.length, 5);
});

test('sep: imprecise, out-of-city and address-contradicting points are held back', () => {
  const peers = [0, 1, 2, 3, 4].map(i => cct({ INMUEBLE_CV_CODIGO_POSTAL: '7550', INMUEBLE_LATITUD: String(19.4810 + i * 1e-3), INMUEBLE_LONGITUD: String(-99.0714 - i * 1e-3) }));
  const far = cct({ CV_CCT: '09DML0017X', INMUEBLE_CV_CODIGO_POSTAL: '7550', INMUEBLE_LATITUD: '19.217847', INMUEBLE_LONGITUD: '-99.20553' });   // ~33 km from its postcode
  const out = cct({ CV_CCT: '09DPR1439C', INMUEBLE_LATITUD: '19.480949', INMUEBLE_LONGITUD: '-99.907631' });
  const coarse = cct({ CV_CCT: '09PES0008E', INMUEBLE_LATITUD: '19.33', INMUEBLE_LONGITUD: '-99.29' });
  const halfCoarse = cct({ INMUEBLE_LATITUD: '19.33', INMUEBLE_LONGITUD: '-99.291234' });                    // one exact-looking coordinate is fine
  const { rows, stats, traced } = run([...peers, far, out, coarse, halfCoarse]);
  assert.equal(traced['09DML0017X'], 'unmapped.locationContradictsAddress');
  assert.equal(traced['09DPR1439C'], 'unmapped.locationOutsideMexicoCity');
  assert.equal(traced['09PES0008E'], 'unmapped.impreciseLocation');
  assert.equal(rows.length, 6);
  assert.equal(stats['unmapped.locationContradictsAddress'], 1);
});

test('sep: boarding only from INTERNADO; private schools carry no authority or rating', () => {
  const { rows } = run([
    cct({ CARACTERISTCA_C_CARACTERIZAN2: 'INTERNADO' }),
    cct({ SOSTENIMIENTO_C_CONTROL: 'PRIVADO', SOSTENIMIENTO_C_SUBCONTROL: 'PRIVADO', DEPOPERATIVA_C_DEPENDENCIAN1: 'INICIATIVA PRIVADA', DEPOPERATIVA_C_DEPENDENCIAN2: 'ASOCIACIÓN CIVIL', DEPOPERATIVA_C_DEPENDENCIAN3: '', DEPOPERATIVA_C_DEPENDENCIAN4: '' }),
  ]);
  assert.equal(rows[0].boarding, true);
  assert.equal(rows[1].boarding, false);
  assert.equal(rows[1].sector, 'private');
  assert.equal(rows[1].la, '');
  assert.equal(rows[1].rv, undefined);
  for (const r of rows) assert.deepEqual(rowProblems(r, sep), []);
  assert.equal(authorityOf(cct({ DEPOPERATIVA_C_DEPENDENCIAN2: 'EMBAJADA', DEPOPERATIVA_C_DEPENDENCIAN3: '', DEPOPERATIVA_C_DEPENDENCIAN4: '' })), '');
  assert.equal(authorityOf(cct({ DEPOPERATIVA_C_DEPENDENCIAN2: 'UNIVERSIDAD NACIONAL AUTÓNOMA DE MÉXICO', DEPOPERATIVA_C_DEPENDENCIAN3: '', DEPOPERATIVA_C_DEPENDENCIAN4: '' })), 'UNIVERSIDAD NACIONAL AUTÓNOMA DE MÉXICO');
});

test('sep: postcodes regain their leading zero; "0" is none', () => {
  assert.equal(postcodeOf('6030'), '06030');
  assert.equal(postcodeOf('12400'), '12400');
  assert.equal(postcodeOf('0'), '');
  assert.equal(postcodeOf(''), '');
});

test('sep: wording — no rating, CC BY attribution, verified record link', () => {
  const s = sep.schemes['mx-none'];
  assert.equal(s.kind, 'none');
  assert.match(s.notes[0].html, /does not publish an official rating or inspection result/);
  assert.match(sep.meta.attribution, /\{id\}/);
  assert.match(sep.meta.attribution, /CC BY 4\.0/);
  assert.match(sep.meta.attribution, /adapted by SafeRoute/);
  assert.equal(sep.meta.recordUrl, 'https://www.siged.sep.gob.mx/SIGED/escuelas.html?cct={id}');
  assert.deepEqual(sep.meta.publishes, ['boarding']);
});

test('sep: displayCase (for the page) keeps Spanish small words, numerals, initials and acronyms', () => {
  assert.equal(displayCase('ESCUELA SECUNDARIA TÉCNICA 101'), 'Escuela Secundaria Técnica 101');
  assert.equal(displayCase('SAN JUAN DE ARAGÓN VII SECCIÓN, GUSTAVO A. MADERO'), 'San Juan de Aragón VII Sección, Gustavo A. Madero');
  assert.equal(displayCase('SAN JERÓNIMO LÍDICE, LA MAGDALENA CONTRERAS'), 'San Jerónimo Lídice, La Magdalena Contreras');
  assert.equal(displayCase('CENDI ISSSTE E.B.D.I. NO. 107'), 'CENDI ISSSTE E.B.D.I. No. 107');
  assert.equal(displayCase('THE AMERICAN SCHOOL FOUNDATION, A.C.'), 'The American School Foundation, A.C.');
  assert.equal(displayCase('"OAK\'S LEADERSHIP SCHOOL"'), '"Oak\'s Leadership School"');
  assert.equal(displayCase('UNAM ESCUELA NACIONAL PREPARATORIA PLANTEL 1 GABINO BARREDA'), 'UNAM Escuela Nacional Preparatoria Plantel 1 Gabino Barreda');
  assert.equal(displayCase('CENTRO DE ATENCIÓN MÚLTIPLE No. 6'), 'CENTRO DE ATENCIÓN MÚLTIPLE No. 6');   // mixed case: left as published
});
