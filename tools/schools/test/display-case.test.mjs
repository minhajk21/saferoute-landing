// The /check/ page re-cases all-capitals names for sources that declare
// meta.displayCase (SEP, NCES). The rule lives in the page (check/index.html,
// between "BEGIN schCase" and "END schCase"); this test runs that exact block.
//   - 'es' must equal sources/sep.mjs displayCase(), the rule the Mexico City
//     lane designed and reviewed, on every Mexico City string in the tiles.
//   - 'en' keeps initialisms, numbered school codes and roman numerals.
//   - mixed case (the publisher's own styling) and sources without a rule are
//     never touched, so England & Wales panes cannot change.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { displayCase } from '../sources/sep.mjs';
import { readRowsFromTiles } from '../lib/tiles.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const page = readFileSync(join(ROOT, 'check', 'index.html'), 'utf8');
const a = page.indexOf('// ── display case (BEGIN schCase'), b = page.indexOf('// ── END schCase ──');
const { schCase } = new Function(`${page.slice(a, b)}; return { schCase };`)();

test('the page carries the schCase block', () => {
  assert.ok(a > 0 && b > a, 'markers not found in check/index.html');
});

test("'es' equals sep.displayCase", () => {
  const cases = ['ESCUELA SECUNDARIA TÉCNICA 101', 'SAN JUAN DE ARAGÓN VII SECCIÓN, GUSTAVO A. MADERO', 'CENDI ISSSTE E.B.D.I. NO. 107',
    'INSTITUTO NACIONAL DE BELLAS ARTES Y LITERATURA', 'PLANTEL DEL VALLE, BENITO JUÁREZ', 'ESCUELA PRIMARIA "LA CORREGIDORA"',
    'TECNOLOGICO UNIVERSITARIO DE MEXICO (TUM)', 'CULHUACÁN CTM SECCIÓN PILOTO, COYOACÁN', 'CAI/JARDIN DE NIÑOS AGUSTIN MELGAR',
    'PLANTEL CONALEP 224. GUSTAVO A MADERO II', 'COLEGIO O`FARRILL SOCIEDAD CIVIL', 'JUGANDO CON A B C', 'APRENDIENDO A APRENDER'];
  for (const c of cases) assert.equal(schCase(c, 'es'), displayCase(c), c);
  const dir = process.env.SCHOOLS_TILES || join(ROOT, 'schools', 'data', 'tiles');
  const sep = existsSync(join(dir, 'index.json')) ? readRowsFromTiles(dir, {}).bySrc.get('sep') || [] : [];
  let n = 0;
  for (const r of sep) for (const f of ['name', 'area', 'la']) if (r[f]) { n++; assert.equal(schCase(r[f], 'es'), displayCase(r[f]), `${r.id} ${f}`); }
  if (sep.length) assert.ok(n > 10000, `only ${n} Mexico City strings compared`);
});

// The repair pass (Sept 2026): official initialisms were being lower-cased.
test("'es' keeps initialisms, and a lone A where it is an initial", () => {
  const cases = {
    'TECNOLOGICO UNIVERSITARIO DE MEXICO (TUM)': 'Tecnologico Universitario de Mexico (TUM)',
    'CULHUACÁN CTM SECCIÓN PILOTO, COYOACÁN': 'Culhuacán CTM Sección Piloto, Coyoacán',
    'VILLAS TRABAJADORES DEL GOBIERNO DEL DF, TLÁHUAC': 'Villas Trabajadores del Gobierno del DF, Tláhuac',
    'CAI/JARDIN DE NIÑOS AGUSTIN MELGAR': 'CAI/Jardin de Niños Agustin Melgar',
    'CAI SEP NO 05': 'CAI SEP No 05',
    'PLANTEL CONALEP 224. GUSTAVO A MADERO II': 'Plantel CONALEP 224. Gustavo A Madero II',
    'SAN JUAN DE ARAGÓN VII SECCIÓN, GUSTAVO A. MADERO': 'San Juan de Aragón VII Sección, Gustavo A. Madero',
    'COLEGIO O`FARRILL SOCIEDAD CIVIL': 'Colegio O`Farrill Sociedad Civil',
    'JUGANDO CON A B C': 'Jugando con A B C',
    'JARDÍN DE NIÑOS ANEXO A LA UNIVERSIDAD MOTOLINIA': 'Jardín de Niños Anexo a la Universidad Motolinia',
    'CENDI SE HOSPITAL GENERAL DR. MANUEL GEA GONZÁLEZ (SSA)': 'CENDI Se Hospital General Dr. Manuel Gea González (SSA)',
    'SR. DN. VENUSTIANO CARRANZA': 'Sr. Dn. Venustiano Carranza',
    'ESCUELA PRIMARIA "LA CORREGIDORA"': 'Escuela Primaria "La Corregidora"',
  };
  for (const [k, v] of Object.entries(cases)) { assert.equal(schCase(k, 'es'), v, k); assert.equal(displayCase(k), v, `sep ${k}`); }
});

test("'en' keeps initialisms, codes and numerals", () => {
  const cases = {
    'PS 11 PURVIS J BEHAN': 'PS 11 Purvis J Behan',
    'PS/IS 295': 'PS/IS 295',
    'KIPP BRONX CHARTER SCHOOL II': 'KIPP Bronx Charter School II',
    'HOUSTON ISD': 'Houston ISD',
    'YES PREP - SOUTHEAST': 'YES Prep - Southeast',
    'DR RONALD E MCNAIR J H': 'Dr Ronald E McNair J H',
    "ST JOSEPH'S PREPARATORY SCHOOL": "St Joseph's Preparatory School",
    "LA SCUOLA D'ITALIA": "La Scuola D'Italia",
    'VINES EC/PK/K': 'Vines EC/PK/K',
    'HICKMAN MILLS C-1': 'Hickman Mills C-1',
    'NEW YORK CITY GEOGRAPHIC DISTRICT #19': 'New York City Geographic District #19',
    'MO CHARTER PUBLIC SCHOOL COMM': 'MO Charter Public School Comm',
    'NYC DOE OFFICE OF CHARTER SCHOOL ACCOUNTABILITY AND SUPPORT': 'NYC DOE Office of Charter School Accountability and Support',
    'CHARTER BOARD (CSB)': 'Charter Board (CSB)',
    'WILLIAMSBURG HIGH SCHOOL OF ART AND TECHNOLOGY (THE)': 'Williamsburg High School of Art and Technology (The)',
    'MATER DEI CATHOLIC H.S.': 'Mater Dei Catholic H.S.',
    'CARDIFF BY THE SEA': 'Cardiff by the Sea',
    'MSGR FARRELL HIGH SCHOOL': 'Msgr Farrell High School',
    'NEW YORK STATE OFFICE MENTAL HEALTH (OMH)': 'New York State Office Mental Health (OMH)',
    'EAST BROOKLYN ASCEND CHARTER SCHOOL (EBACS)': 'East Brooklyn Ascend Charter School (EBACS)',
    "MANHATTAN CHILDREN'S CENTER (THE)": "Manhattan Children's Center (The)",
  };
  for (const [k, v] of Object.entries(cases)) assert.equal(schCase(k, 'en'), v, k);
});

test('mixed case and sources without a rule are left exactly as published', () => {
  assert.equal(schCase('Brooklyn Tech HS', 'en'), 'Brooklyn Tech HS');
  assert.equal(schCase('HARRIS FEDERATION', undefined), 'HARRIS FEDERATION');
  assert.equal(schCase('', 'en'), '');
  assert.equal(schCase(null, 'es'), null);
});
