#!/usr/bin/env node
// tools/render-pages.mjs
//
// Renders the /safety/ programmatic pages from tools/data-cache/<city>/*.json
// (produced by generate-data.mjs): one static page per neighborhood, a city hub
// with a client-side area checker, /safety/ root, sitemap.xml and robots.txt.
//
// Design constraints, in order:
//   1. Every page must be genuinely informative from DATA (score, breakdown,
//      time-of-day, comparisons) — never a thin template with the name swapped.
//   2. Framing discipline (mirrors the app): "reported incidents", dated,
//      sourced, informational-only — routes and times, never area verdicts.
//   3. Fully static output. No runtime backend calls, no JS required to read
//      a page (the hub checker is the only progressive enhancement).
//
// Run: node tools/render-pages.mjs [--city new-york]

import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CITY = process.argv.includes('--city') ? process.argv[process.argv.indexOf('--city') + 1] : 'new-york';
const SITE = 'https://safe-route.app';
const APP_ID = '6768244297';
const APP_URL = `https://apps.apple.com/app/id${APP_ID}`;

const gaz = JSON.parse(readFileSync(join(ROOT, 'tools', 'gazetteer', `${CITY}.json`)));
const cacheDir = join(ROOT, 'tools', 'data-cache', CITY);

// ── data load ────────────────────────────────────────────────────────────────
const areas = [];
for (const f of readdirSync(cacheDir).filter(f => f.endsWith('.json'))) {
  areas.push(JSON.parse(readFileSync(join(cacheDir, f))));
}
const bySlug = new Map(areas.map(a => [a.slug, a]));
const gazBySlug = new Map(gaz.areas.map(a => [a.slug, a]));
const scores = areas.map(a => a.safetyScore).sort((x, y) => x - y);
const median = scores[Math.floor(scores.length / 2)];
// rank 1 = safest (highest index)
const ranked = [...areas].sort((a, b) => b.safetyScore - a.safetyScore);
const rankOf = new Map(ranked.map((a, i) => [a.slug, i + 1]));

// ── helpers ──────────────────────────────────────────────────────────────────
const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const monthName = ym => {
  const [y, m] = String(ym).split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });
};
const ord = n => n + (n % 100 >= 11 && n % 100 <= 13 ? 'th' : ['th', 'st', 'nd', 'rd'][Math.min(n % 10, 4)] || 'th');
const fmt = n => Number(n).toLocaleString('en-US');
const CAT_NAMES = {
  'violent-crime': 'Violent crime', 'sexual-offences': 'Sexual offences', 'robbery': 'Robbery',
  'possession-of-weapons': 'Weapons possession', 'burglary': 'Burglary',
  'criminal-damage-arson': 'Criminal damage & arson', 'public-order': 'Public order',
  'theft-from-the-person': 'Theft from a person', 'drugs': 'Drugs',
  'anti-social-behaviour': 'Anti-social behaviour', 'vehicle-crime': 'Vehicle crime',
  'other-theft': 'Other theft', 'other-crime': 'Other', 'shoplifting': 'Shoplifting',
  'bicycle-theft': 'Bicycle theft', 'miscellaneous-incidents': 'Miscellaneous',
};
const catName = c => CAT_NAMES[c] || c.replace(/-/g, ' ').replace(/^./, ch => ch.toUpperCase());
const bandWord = { low: 'Low risk', moderate: 'Moderate', elevated: 'Elevated', high: 'High risk' };
const bandColor = { low: '#2E8B40', moderate: '#B0703C', elevated: '#9C5220', high: '#BC3B2E' };

// ── SVG: incident dot map (no basemap — copyright-clean, zero-cost) ─────────
// Where the incidents actually fall — plus the spatial "shape" of the pattern
// (edge-clustered vs even), so a quiet-center neighborhood like Riverdale reads
// as "quiet core, busier corridor at the rim" instead of a broken empty radar.
function mapShape(a) {
  const cosLat = Math.cos(a.lat * Math.PI / 180);
  const pts = (a.incidents || []).map(p => ({
    dx: (p.lng - a.lng) * 111320 * cosLat,
    dy: (p.lat - a.lat) * 111320,
  }));
  if (!pts.length) return { n: 0, edgeClustered: false, dirWord: '' };
  const dists = pts.map(p => Math.hypot(p.dx, p.dy)).sort((x, y) => x - y);
  const medianDist = dists[Math.floor(dists.length / 2)];
  const mx = pts.reduce((s, p) => s + p.dx, 0) / pts.length;
  const my = pts.reduce((s, p) => s + p.dy, 0) / pts.length;
  const bearing = (Math.atan2(mx, my) * 180 / Math.PI + 360) % 360; // 0 = N
  const dirWord = ['north', 'north-east', 'east', 'south-east', 'south', 'south-west', 'west', 'north-west'][Math.round(bearing / 45) % 8];
  return {
    n: pts.length,
    medianDist,
    // Most reports far from the center, and skewed to one side → annotate.
    edgeClustered: medianDist > 0.65 * (a.radiusMetres || 1000) && Math.hypot(mx, my) > 0.2 * (a.radiusMetres || 1000),
    dirWord,
  };
}

function mapSVG(a, shape, bm) {
  const W = 640, H = 430, cx = W / 2, cy = H / 2;
  const scale = (H - 40) / 2 / (a.radiusMetres || 1000); // px per metre, ring fits height
  const cosLat = Math.cos(a.lat * Math.PI / 180);
  // Sparse areas get slightly larger dots so a low-crime map still reads as
  // deliberately sparse rather than failed-to-load.
  const base = (a.incidents || []).length < 150 ? 3.0 : 2.1;
  const dots = (a.incidents || []).map(p => {
    const x = cx + ((p.lng - a.lng) * 111320 * cosLat) * scale;
    const y = cy - ((p.lat - a.lat) * 111320) * scale;
    if (x < 4 || x > W - 4 || y < 4 || y > H - 4) return '';
    const t = Math.max(0, Math.min(1, ((p.w ?? 4) - 2) / 8));
    const col = `rgb(${Math.round(232 - t * 92)},${Math.round(146 - t * 90)},${Math.round(134 - t * 82)})`;
    return `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${(base + t * 1.6).toFixed(1)}" fill="${col}" fill-opacity="0.78"/>`;
  }).join('');
  const rings = [250, 500, 750, 1000].map(m =>
    `<circle cx="${cx}" cy="${cy}" r="${(m * scale).toFixed(1)}" fill="none" stroke="#B9AF98" stroke-width="${m === 1000 ? 1.4 : 0.7}" ${m < 1000 ? 'stroke-dasharray="3 5"' : ''} fill-opacity="0"/>`).join('');
  const sb = 500 * scale;

  // Vector basemap (from fetch-basemap.mjs) — water behind land, then parks,
  // then streets; the whole page map becomes real geography, not an abstract
  // radar. Falls back to plain paper if no basemap was built for this area.
  const path = (rings2, close) => rings2.map(r => 'M' + r.map(p => p.join(',')).join('L') + (close ? 'Z' : '')).join('');
  let ground = `<rect width="${W}" height="${H}" fill="#FBF9F2"/>`;
  let streetLabels = '';
  if (bm && bm.land?.length) {
    ground = `<rect width="${W}" height="${H}" fill="#D7E3E8"/>` +                                  // water
      `<path d="${path(bm.land, true)}" fill="#F7F3E8" fill-rule="evenodd"/>` +                     // land
      (bm.parks?.length ? `<path d="${path(bm.parks, true)}" fill="#E4EDDA" fill-rule="evenodd"/>` : '') +
      (bm.stMinor?.length ? `<path d="${path(bm.stMinor)}" fill="none" stroke="#DCD3BF" stroke-width="1"/>` : '') +
      (bm.stMajor?.length ? `<path d="${path(bm.stMajor)}" fill="none" stroke="#C9BC9F" stroke-width="1.8"/>` : '');
    streetLabels = (bm.labels || [])
      .filter(l => l.x >= 24 && l.x <= W - 24 && l.y >= 20 && l.y <= H - 20) // off-frame anchor = invisible
      .map(l =>
        `<text x="${l.x}" y="${l.y}" transform="rotate(${l.a} ${l.x} ${l.y})" text-anchor="middle" dy="-3" font-family="IBM Plex Mono,monospace" font-size="9.5" fill="#7D7666" stroke="#F7F3E8" stroke-width="3" paint-order="stroke">${esc(l.t)}</text>`).join('');
  }

  return `<svg viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Map of reported crime locations within ${a.radiusMetres} metres of the centre of ${esc(a.name)}, over the local street network">
${ground}${rings}${streetLabels}${dots}
<circle cx="${cx}" cy="${cy}" r="4.5" fill="#14564C"/><circle cx="${cx}" cy="${cy}" r="8.5" fill="none" stroke="#14564C" stroke-width="1.5"/>
<text x="${cx}" y="${cy + 24}" text-anchor="middle" font-family="IBM Plex Mono,monospace" font-size="10.5" fill="#14564C" stroke="#F7F3E8" stroke-width="3" paint-order="stroke">neighborhood center</text>
<rect x="12" y="8" width="278" height="24" rx="7" fill="#FBF9F2" fill-opacity="0.88"/>
<circle cx="26" cy="20" r="3" fill="#E89286" fill-opacity="0.85"/><circle cx="40" cy="20" r="3.6" fill="#8C1010" fill-opacity="0.85"/>
<text x="52" y="24" font-family="IBM Plex Mono,monospace" font-size="11" fill="#3C514C">1 dot = 1 report · darker = more severe</text>
<rect x="12" y="${H - 36}" width="118" height="28" rx="7" fill="#FBF9F2" fill-opacity="0.88"/>
<line x1="20" y1="${H - 16}" x2="${20 + sb}" y2="${H - 16}" stroke="#052926" stroke-width="2"/>
<text x="${20 + sb / 2}" y="${H - 22}" text-anchor="middle" font-family="IBM Plex Mono,monospace" font-size="11" fill="#3C514C">500 m</text>
<text x="${W - 20}" y="${H - 20}" text-anchor="end" font-family="IBM Plex Mono,monospace" font-size="11" fill="#717F7A" stroke="#F7F3E8" stroke-width="3" paint-order="stroke">N ↑</text>
</svg>`;
}

// ── SVG: time-of-day chart (weekday/weekend × day/eve/night) ────────────────
function todSVG(a) {
  const tod = a.timeOfDay;
  if (!tod || tod.length < 6) return '';
  const max = Math.max(...tod, 0.0001);
  const W = 300, H = 130, bw = 30, gap = 12, groupGap = 44, base = H - 34;
  const labels = ['6a–6p', '6p–12a', '12a–6a'];
  let x = 14, out = '';
  const group = (idx0, title) => {
    const x0 = x;
    for (let i = 0; i < 3; i++) {
      const v = tod[idx0 + i] / max, h = Math.max(3, v * 72);
      const t = tod[idx0 + i] / max;
      const col = `rgb(${Math.round(232 - t * 92)},${Math.round(146 - t * 90)},${Math.round(134 - t * 82)})`;
      out += `<rect x="${x}" y="${(base - h).toFixed(1)}" width="${bw}" height="${h.toFixed(1)}" rx="3" fill="${col}"/>`;
      out += `<text x="${x + bw / 2}" y="${base + 13}" text-anchor="middle" font-family="IBM Plex Mono,monospace" font-size="8.5" fill="#717F7A">${labels[i]}</text>`;
      x += bw + gap;
    }
    out += `<text x="${(x0 + x - gap) / 2}" y="${base + 27}" text-anchor="middle" font-family="IBM Plex Mono,monospace" font-size="9.5" font-weight="600" fill="#3C514C" letter-spacing="1">${title}</text>`;
    x += groupGap - gap;
  };
  group(0, 'MON–FRI'); group(3, 'SAT–SUN');
  return `<svg viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="When reported incidents happen in ${esc(a.name)}: severity-weighted share by time of day, weekdays versus weekends">${out}</svg>`;
}

// ── prose (deterministic from data — the content IS the data) ───────────────
function prose(a) {
  const g = gazBySlug.get(a.slug) || {};
  const rank = rankOf.get(a.slug), n = areas.length;
  const diff = a.safetyScore - median;
  const top = (a.breakdown || [])[0];
  const topShare = top ? Math.round(100 * top.count / Math.max(1, a.totalIncidents)) : 0;
  const tod = a.timeOfDay || [];
  const night = tod.length >= 6 ? (tod[2] + tod[5]) : null;          // 12a–6a share
  const evening = tod.length >= 6 ? (tod[1] + tod[4]) : null;        // 6p–12a share

  const bandLead = {
    low: `${a.name} sits at the safer end of New York City by reported crime.`,
    moderate: `${a.name} shows a typical level of reported crime for New York City.`,
    elevated: `${a.name} records more reported crime than most New York neighborhoods.`,
    high: `${a.name} records a high level of reported crime for New York City.`,
  }[a.band];

  const cmp = Math.abs(diff) <= 3
    ? `right at the citywide median of ${median}`
    : `${Math.abs(diff)} points ${diff > 0 ? 'above' : 'below'} the citywide median of ${median}`;

  const lead = `${bandLead} Its SafeRoute safety index is <strong>${a.safetyScore} out of 100</strong> — ${cmp}, ranking ${ord(rank)} of ${n} NYC neighborhoods — based on ${fmt(a.totalIncidents)} incidents reported to the NYPD within 1 km of the neighborhood center (data through ${monthName(a.crimeDate)}).`;

  let mix = '';
  if (top) {
    const violent = ['violent-crime', 'robbery', 'sexual-offences', 'possession-of-weapons'].includes(top.category);
    mix = violent
      ? `The largest reported category here is <strong>${catName(top.category).toLowerCase()}</strong> (${topShare}% of reports) — worth taking seriously when walking at night; the full mix is broken down below.`
      : `Most of what's reported here is property-related — <strong>${catName(top.category).toLowerCase()}</strong> alone is ${topShare}% of reports — rather than violence against strangers, though the full mix below is worth a look.`;
  }

  let when = '';
  if (night != null) {
    const nightPct = Math.round(night * 100), evePct = Math.round(evening * 100);
    when = night >= 0.30
      ? `Timing matters here: about ${nightPct}% of severity-weighted incidents are reported overnight (midnight–6 a.m.), so route choice late at night matters more than the headline number suggests.`
      : night <= 0.15
        ? `Reported incidents here skew to daytime and evening hours — only about ${nightPct}% of severity-weighted reports fall overnight (midnight–6 a.m.).`
        : `Incidents spread across the day here — roughly ${evePct}% of severity-weighted reports come in the evening (6 p.m.–midnight) and ${nightPct}% overnight.`;
  }

  const neighbors = (g.neighbors || []).map(s => bySlug.get(s)).filter(Boolean);

  const faq = [
    {
      q: `Is ${a.name} safe at night?`,
      a: night != null
        ? `${bandWord[a.band]} overall (safety index ${a.safetyScore}/100). About ${Math.round((night + evening) * 100)}% of severity-weighted incidents in ${a.name} are reported between 6 p.m. and 6 a.m. ${a.band === 'low' ? 'Reported crime is low for NYC, but stick to lit, busier streets late.' : 'At night, prefer lit, busier streets — a block or two of detour often avoids the clusters on the map above.'}`
        : `${bandWord[a.band]} overall (safety index ${a.safetyScore}/100). Prefer lit, busier streets late at night.`,
    },
    {
      q: `What is the most common crime in ${a.name}?`,
      a: top
        ? `${catName(top.category)} — ${fmt(top.count)} of ${fmt(a.totalIncidents)} incidents (${topShare}%) reported within 1 km of the neighborhood center through ${monthName(a.crimeDate)}.`
        : `No dominant category in the current data.`,
    },
    {
      q: `How is the ${a.name} safety index calculated?`,
      a: `SafeRoute weights each incident reported to the NYPD by severity (violence weighs more than shoplifting), sums the last available period within 1 km of the neighborhood center, and normalizes against citywide crime rates onto a 0–100 scale — higher is safer. It describes reported crime only; it is not a guarantee of safety.`,
    },
  ];

  return { lead, mix, when, neighbors, faq, rank, n, diff };
}

// ── page chrome ──────────────────────────────────────────────────────────────
const head = (title, desc, canonical, jsonld) => `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${esc(title)}</title>
<meta name="description" content="${esc(desc)}">
<link rel="canonical" href="${canonical}">
<meta name="apple-itunes-app" content="app-id=${APP_ID}">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(desc)}">
<meta property="og:type" content="article">
<meta property="og:url" content="${canonical}">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600&family=IBM+Plex+Sans:wght@400;500;600;700&display=swap" rel="stylesheet">
<link rel="stylesheet" href="/safety/assets/safety.css">
${jsonld ? `<script type="application/ld+json">${JSON.stringify(jsonld)}</script>` : ''}
</head>
<body>`;

const chrome = crumbs => `<header class="site"><div class="wrap">
<a class="wordmark" href="/">SafeRoute</a>
<nav class="crumbs">${crumbs}</nav>
</div></header><main><div class="wrap">`;

const footer = (a) => `</div></main><footer class="site"><div class="wrap">
<p><strong>Sources.</strong> Crime data: NYPD complaint data via <a href="https://opendata.cityofnewyork.us/">NYC Open Data</a>${a ? `, data through ${monthName(a.crimeDate)}` : ''}. Neighborhood boundaries: NYC 2020 Neighborhood Tabulation Areas. Basemap (streets, parks, shoreline): NYC Open Data. Analysis © SafeRoute.</p>
<p><strong>About this data.</strong> Figures are incidents <em>reported</em> to police within 1&nbsp;km of each neighborhood's center — reporting practices vary and not all crime is reported. This is informational only and not a guarantee of safety, a prediction, or a judgment of any community. Use it the way the app does: to pick better-lit, lower-incident routes and times.</p>
<p><a href="/safety/new-york/">All New York neighborhoods</a> · <a href="/">SafeRoute app</a> · <a href="https://minhajk21.github.io/saferoute-privacy/">Privacy</a></p>
</div></footer></body></html>`;

const cta = (name) => `<div class="cta">
<h2>Walking in ${esc(name)} at night?</h2>
<p>SafeRoute scores every walking route against the same live crime data on this page — and shows how much of each route runs on lit streets. Pick the safer way, share your walk, and check in when you arrive. Free, no account.</p>
<a class="btn" href="${APP_URL}">Get SafeRoute on the App Store</a>
</div>`;

// ── neighborhood pages ───────────────────────────────────────────────────────
let pages = 0;
for (const a of areas) {
  const p = prose(a);
  const url = `${SITE}/safety/${CITY}/${a.slug}/`;
  const title = `Is ${a.name} Safe? Crime Map & Safety Index — SafeRoute`;
  const desc = `${a.name} safety index: ${a.safetyScore}/100 (${bandWord[a.band].toLowerCase()}) — ${fmt(a.totalIncidents)} reported incidents within 1 km (through ${monthName(a.crimeDate)}). Crime map, what's reported, and how it compares across NYC.`;
  const jsonld = [
    { '@context': 'https://schema.org', '@type': 'BreadcrumbList', itemListElement: [
      { '@type': 'ListItem', position: 1, name: 'Safety', item: `${SITE}/safety/` },
      { '@type': 'ListItem', position: 2, name: 'New York', item: `${SITE}/safety/${CITY}/` },
      { '@type': 'ListItem', position: 3, name: a.name, item: url }] },
    { '@context': 'https://schema.org', '@type': 'FAQPage',
      mainEntity: p.faq.map(f => ({ '@type': 'Question', name: f.q, acceptedAnswer: { '@type': 'Answer', text: f.a } })) },
  ];

  const shape = mapShape(a);
  const clusterNote = shape.edgeClustered
    ? ` Reports cluster toward the ${shape.dirWord} of the map — the area immediately around the neighborhood center is comparatively quiet.`
    : '';
  const bmFile = join(ROOT, 'tools', 'data-cache', `${CITY}-basemap`, `${a.slug}.json`);
  const bm = existsSync(bmFile) ? JSON.parse(readFileSync(bmFile)) : null;

  const catRows = (a.breakdown || []).slice(0, 6).map(c => {
    const share = Math.round(100 * c.count / Math.max(1, a.totalIncidents));
    return `<tr><td>${esc(catName(c.category))}</td><td style="width:38%"><div class="sharebar"><i style="width:${share}%"></i></div></td><td class="n">${fmt(c.count)} · ${share}%</td></tr>`;
  }).join('');

  const nearbyRows = p.neighbors.map(nb =>
    `<li><a href="/safety/${CITY}/${nb.slug}/">${esc(nb.name)}</a><span class="s">${nb.safetyScore}/100 · ${bandWord[nb.band]}</span></li>`).join('');

  const html = `${head(title, desc, url, jsonld)}${chrome(`<a href="/safety/">Safety</a> › <a href="/safety/${CITY}/">New York</a> › ${esc(a.name)}`)}
<p class="eyebrow">Safety index · ${esc(a.borough)}, New York · data through ${monthName(a.crimeDate)}</p>
<h1>Is ${esc(a.name)} safe?</h1>
<p class="lead">${p.lead}</p>

<div class="scorecard">
  <div class="scorenum" style="color:${bandColor[a.band]}">${a.safetyScore}<small>/100</small></div>
  <div style="flex:1">
    <span class="band ${a.band}">${bandWord[a.band]}</span>
    <div class="scoremeta">SafeRoute safety index for the area within 1 km of the center of ${esc(a.name)} — higher is safer. ${ord(p.rank)} of ${p.n} NYC neighborhoods.</div>
    <div class="gaugebar"><i style="width:${a.safetyScore}%;background:${bandColor[a.band]}"></i></div>
  </div>
</div>

${p.mix ? `<p>${p.mix}</p>` : ''}
${p.when ? `<p>${p.when}</p>` : ''}

<h2>Where incidents cluster</h2>
<figure class="map">
${mapSVG(a, shape, bm)}
<figcaption>${fmt(a.totalIncidents)} incidents reported within 1 km of the ${esc(a.name)} center${(a.incidents || []).length < a.totalIncidents ? ` (${fmt((a.incidents || []).length)} shown)` : ''} · NYPD data through ${monthName(a.crimeDate)}${bm ? ' · basemap: NYC Open Data' : ''}.${clusterNote}</figcaption>
</figure>

<div class="grid2">
<section>
<h2>What's reported here</h2>
<table class="cats">${catRows}</table>
</section>
<section>
<h2>When it happens</h2>
<div class="tod">${todSVG(a)}</div>
<p style="font-size:14px;color:var(--ink-3);margin-top:8px">Severity-weighted share of reported incidents by time of day, from NYPD incident timestamps.</p>
</section>
</div>

${cta(a.name)}

<h2>Nearby areas</h2>
<ul class="nearby">${nearbyRows}</ul>

<h2>Common questions</h2>
${p.faq.map(f => `<details><summary>${esc(f.q)}</summary><p>${f.a}</p></details>`).join('\n')}
${footer(a)}`;

  const dir = join(ROOT, 'safety', CITY, a.slug);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'index.html'), html);
  pages++;
}

// ── city hub ─────────────────────────────────────────────────────────────────
{
  const url = `${SITE}/safety/${CITY}/`;
  const date = monthName(areas[0]?.crimeDate || '2026-01');
  const title = `New York Neighborhood Safety Map & Rankings (${areas.length} areas) — SafeRoute`;
  const desc = `How safe is your NYC neighborhood? Safety index (0–100) for ${areas.length} New York neighborhoods from NYPD reported-crime data through ${date} — ranked by borough, with crime maps and night-time patterns.`;
  const boroughs = [...new Set(areas.map(a => a.borough))].sort();
  const tables = boroughs.map(b => {
    const rows = ranked.filter(a => a.borough === b).map(a =>
      `<tr><td><a href="/safety/${CITY}/${a.slug}/">${esc(a.name)}</a></td><td class="n" style="color:${bandColor[a.band]}">${a.safetyScore}/100</td><td><span class="band ${a.band}">${bandWord[a.band]}</span></td><td class="n">${fmt(a.totalIncidents)}</td></tr>`).join('');
    return `<h2 id="${b.toLowerCase().replace(/\s+/g, '-')}">${esc(b)}</h2>
<table class="rank"><thead><tr><th>Neighborhood (safest first)</th><th style="text-align:right">Index</th><th>Band</th><th style="text-align:right">Incidents</th></tr></thead><tbody>${rows}</tbody></table>`;
  }).join('\n');

  const idx = areas.map(a => ({ s: a.slug, n: a.name, b: a.borough, v: a.safetyScore, band: a.band }));
  const html = `${head(title, desc, url, {
    '@context': 'https://schema.org', '@type': 'BreadcrumbList', itemListElement: [
      { '@type': 'ListItem', position: 1, name: 'Safety', item: `${SITE}/safety/` },
      { '@type': 'ListItem', position: 2, name: 'New York', item: url }],
  })}${chrome(`<a href="/safety/">Safety</a> › New York`)}
<p class="eyebrow">Neighborhood safety · New York City · data through ${date}</p>
<h1>How safe is your New York neighborhood?</h1>
<p class="lead">SafeRoute scores every NYC neighborhood 0–100 from incidents reported to the NYPD — severity-weighted, within 1 km of each neighborhood's center, normalized citywide. Higher is safer. The same data powers the SafeRoute app's crime-aware walking routes.</p>

<div class="checker">
<input id="ckr" type="search" placeholder="Check a neighborhood — e.g. Harlem, Bushwick, Astoria…" aria-label="Search New York neighborhoods">
<ul id="ckr-out"></ul>
</div>

<p class="notice">These figures describe <strong>reported</strong> crime around each neighborhood's center — they are informational, not a judgment of any community. Citywide median index: <strong>${median}/100</strong>.</p>

${tables}

${cta('New York')}

<h2>Methodology</h2>
<p style="font-size:15.5px;color:var(--ink-2)">Each incident reported to the NYPD (via NYC Open Data) is weighted by severity — violence counts for more than shoplifting. For every neighborhood we sum weighted incidents within 1 km of its center (2020 Neighborhood Tabulation Area centroids), and normalize against citywide crime rates onto a 0–100 index, higher&nbsp;=&nbsp;safer. Time-of-day charts use NYPD incident timestamps, severity-weighted. Pages regenerate as new data is published.</p>
${footer(areas[0])}
<script>
const IDX=${JSON.stringify(idx)};
const inp=document.getElementById('ckr'),out=document.getElementById('ckr-out');
inp.addEventListener('input',()=>{
  const q=inp.value.trim().toLowerCase();out.innerHTML='';
  if(q.length<2)return;
  IDX.filter(a=>a.n.toLowerCase().includes(q)).slice(0,8).forEach(a=>{
    const li=document.createElement('li');
    li.innerHTML='<a href="/safety/${CITY}/'+a.s+'/"><span>'+a.n+' <small style="color:var(--ink-3)">'+a.b+'</small></span><span class="s">'+a.v+'/100</span></a>';
    out.appendChild(li);
  });
});
</script></body></html>`.replace('</body></html></body></html>', '</body></html>');
  writeFileSync(join(ROOT, 'safety', CITY, 'index.html'), html);
}

// ── /safety/ root ────────────────────────────────────────────────────────────
{
  const url = `${SITE}/safety/`;
  const html = `${head('Neighborhood Safety Maps & Crime Data — SafeRoute', 'Data-driven neighborhood safety: crime maps, 0–100 safety indexes, and night-time patterns from official police data. Powered by the SafeRoute crime-aware walking app.', url, null)}${chrome('Safety')}
<p class="eyebrow">SafeRoute safety index</p>
<h1>Neighborhood safety, from official police data</h1>
<p class="lead">The data behind SafeRoute's crime-aware walking routes, published as browsable neighborhood pages: a 0–100 safety index, a crime map, what's reported, and when it happens.</p>
<h2>Cities</h2>
<table class="rank"><tbody>
<tr><td><a href="/safety/new-york/">New York City</a></td><td class="n">${areas.length} neighborhoods</td></tr>
</tbody></table>
<p style="font-size:15px;color:var(--ink-2)">More cities from SafeRoute's 30-city coverage (London, Chicago, Toronto, Mexico City…) are on the way.</p>
${cta('your city')}
${footer(areas[0])}`;
  mkdirSync(join(ROOT, 'safety'), { recursive: true });
  writeFileSync(join(ROOT, 'safety', 'index.html'), html);
}

// ── sitemap + robots + .nojekyll ─────────────────────────────────────────────
{
  const today = new Date().toISOString().slice(0, 10);
  const urls = [
    { loc: `${SITE}/`, pri: '1.0' },
    { loc: `${SITE}/safety/`, pri: '0.8' },
    { loc: `${SITE}/safety/${CITY}/`, pri: '0.9' },
    ...ranked.map(a => ({ loc: `${SITE}/safety/${CITY}/${a.slug}/`, pri: '0.7' })),
  ];
  writeFileSync(join(ROOT, 'sitemap.xml'),
    `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` +
    urls.map(u => `<url><loc>${u.loc}</loc><lastmod>${today}</lastmod><priority>${u.pri}</priority></url>`).join('\n') +
    `\n</urlset>\n`);
  if (!existsSync(join(ROOT, 'robots.txt')))
    writeFileSync(join(ROOT, 'robots.txt'), `User-agent: *\nAllow: /\n\nSitemap: ${SITE}/sitemap.xml\n`);
  writeFileSync(join(ROOT, '.nojekyll'), '');
}

console.log(`rendered: ${pages} neighborhood pages + hub + root · median ${median} · sitemap ${areas.length + 3} urls`);
