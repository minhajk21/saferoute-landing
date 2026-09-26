#!/usr/bin/env node
// tools/audit-viewports.mjs
//
// Loads the site's page types at a matrix of real screen sizes in headless
// Chrome and reports what the layout actually does at each — so "does it fit
// this screen?" is a measurement, not a guess, and can be re-run after any
// change.
//
// WHY THIS EXISTS
// Layout bugs here have all been size-specific and invisible at the size they
// were written at: four homepage cards that broke 3+1 only at laptop widths, a
// header that stacked only on phones, and a map fixed at 560px tall that used
// under 40% of a large monitor. Each was found by eye, by chance. This checks
// every page type at every size in a few minutes.
//
// WHAT IT CHECKS
//   overflow   the page scrolls sideways (FAIL — content is cut off; measured
//              against the device width, see AUDIT). Any exception must be
//              listed in KNOWN_OVERFLOW, which is empty and should stay so
//   offender   the widest element causing it, when it does
//   map fill   on map pages, how much of the viewport the map uses once
//              scrolled to it, against a target that fits what that map is for
//              (see MAPS) — and on stacked phone layouts, a band rather than a
//              floor, because a full-height map traps scrolling on touch
//   area       the share of the SCREEN (width x height) the map covers on
//              arrival and after a search. Height alone hid the old /check/
//              layout: its map was 93% of the height once scrolled to, but a
//              third of the screen on arrival.
//   pane       on /check/, that the side pane stays inside <main>
//   header     on every page type at every size (FAIL unless noted):
//     - ONE row: the wordmark and every visible nav item share a centre line.
//       It used to wrap to two rows at 372-375px on / and /tonight/ only
//       (their gutter was 2px wider), so an iPhone SE saw a 95px bar there
//       and a 61px one on the next tab.
//     - the SAME height on every page type at the same size — the check that
//       would have caught that drift, which no single page shows.
//     - Map and Safety index are visible and at least 24x24px, phones
//       included: phones once lost both, and the Map was then unreachable
//       from 127 pages.
//     - the current tab carries aria-current="page" — and only it (the
//       homepage and the 404 page mark none) — so the one thing colour and an
//       underline say to a sighted reader is said to a screen reader too.
//
// THE /check/ APP-SHELL CONTRACT (/check/ and /check/?schools, FAIL unless noted)
// /check/ is an app shell, not a page with a map in it. Each rule below was a
// real regression or a near-miss during the redesign that made it one, so each
// is locked in here rather than trusted to review:
//   desktop (>= 861 wide, >= 540 tall)
//     - the page never scrolls (document height = viewport). Anything taller
//       must live inside the pane, which scrolls; a page that scrolls again is
//       the old layout creeping back, and puts the search off-screen.
//     - the map sits directly under the header and runs to the right edge
//       (full-bleed); with the schools layer on, the schools toolbar is the
//       top strip of the map's stage and the map sits directly under it.
//     - the map covers the acceptance share of the screen AREA (A1: 50% at
//       861px, 55% at 1024, 63% at 1280, 66% at 1366, 67% at 1440, 70% at
//       1920, 74% at 2560), on arrival and after a search, and the page is
//       still at the top after a search (a search that scrolls the page moved
//       the search box away from the reader who might want a second one).
//     - the pane is on screen, ends at the bottom of the viewport and scrolls
//       itself (overflow-y auto/scroll); the h1 and the search box are fully
//       on screen under the header.
//   every size
//     - exactly one visible h1, and the lead (#lead) is shown on arrival: both
//       carry the page's SEO, and a fold-the-intro feature must only ever fold
//       it after the reader's own search.
//     - the autocomplete (#ac) is never clipped by an ancestor's overflow and
//       nothing paints over it: a three-item probe list is dropped in and each
//       item's centre must hit the list. The map's stacking context once came
//       within one z-index of covering it.
//   stacked (< 861 wide)
//     - #side's scroll-margin-top clears the header, whatever its height: a
//       school tap scrolls the pane into view, and a hard-coded 64px margin
//       once put its "Back" button under a 95px (two-row) header.
//     - the map height band is a FAIL here, not a WARN; after a search the map
//       is not under the header and >= 55% of it is on screen, and on 360x740
//       and 390x844 the search box is fully visible under the header too
//       (on a landscape phone only a WARN: there the map wins by design).
//   /check/?schools
//     - the schools layer draws within 3s (pins, not the "Zoom in" note that
//       the old z7 England view showed), centred on central London at zoom
//       >= 12 — or, on a map too small to show central London at 12, the
//       closest zoom that fits it. Its toolbar is shown, and on desktop it sits
//       inside the map's stage, not the column; WARN if the pane keeps < 55%
//       of the height under the header. On phones the toolbar stays inside
//       the screen: its filter row scrolls sideways within itself.
//   default view by time zone, once per run at 1440x900: Europe/London opens on
//     Great Britain, America/New_York on the lower 48, America/Mexico_City on
//     Mexico City, Asia/Tokyo wide enough to hold both London and New York —
//     and no page load asks for geolocation.
//
// No npm dependencies: it drives an installed Chrome over the DevTools
// Protocol using Node's built-in WebSocket, and serves the site itself, so it
// needs no running preview server. (The pages still load Leaflet and fonts
// from their CDNs; the SafeRoute backend is never called — the "search" state
// is reached through the page's own revealTool(), not a real lookup.)
//
// Usage:
//   node tools/audit-viewports.mjs                full matrix, exit 1 on any FAIL
//   node tools/audit-viewports.mjs /check/        one page (and its ?variants,
//                                                 so /check/ also runs ?schools);
//                                                 an unlisted /check/ URL (e.g.
//                                                 '/check/#schools') gets the
//                                                 /check/ or ?schools contract
//   node tools/audit-viewports.mjs --site <dir>   serve <dir> instead of this repo
//   node tools/audit-viewports.mjs --root <dir>   overlay: a file under <dir> wins
//                                                 over the same path in --site,
//                                                 so a prototype can be audited
//                                                 without copying it into the repo

import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { readFile, stat, mkdtemp, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, dirname, extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

// ── arguments ──────────────────────────────────────────────────────────────
let SITE = join(dirname(fileURLToPath(import.meta.url)), '..');
let OVERLAY = null, FILTER = null;
{
  const argv = process.argv.slice(2);
  const usage = m => { console.error(`audit-viewports: ${m}\nusage: node tools/audit-viewports.mjs [--site <dir>] [--root <dir>] [/page/]`); process.exit(2); };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--site' || a === '--root') {
      const v = argv[++i];
      if (!v) usage(`${a} needs a directory`);
      if (!existsSync(v)) usage(`${a} ${v}: no such directory`);
      if (a === '--site') SITE = resolve(v); else OVERLAY = resolve(v);
    } else if (a.startsWith('--')) usage(`unknown option ${a}`);
    else if (FILTER) usage('only one page filter');
    else FILTER = a;
  }
}

const VIEWPORTS = [
  { name: 'phone-xs',   w: 320,  h: 568  },
  { name: 'phone-s',    w: 360,  h: 740  },
  // iPhone SE and the 12/13 mini: the width where the header used to wrap on
  // two tabs and not the others.
  { name: 'phone-se',   w: 375,  h: 667  },
  { name: 'phone',      w: 390,  h: 844  },
  { name: 'tablet',     w: 768,  h: 1024 },
  // A phone on its side: still the stacked layout (under 861), and the
  // shortest screen the map band has to fit.
  { name: 'phone-land', w: 844,  h: 390, mobile: true },
  // The first width that gets the desktop shell, where the column is widest
  // relative to the map.
  { name: 'edge',       w: 861,  h: 700  },
  { name: 'tab-land',   w: 1024, h: 768  },
  // The shortest common laptop screen (and browser windows with toolbars).
  { name: 'laptop-xs',  w: 1280, h: 600  },
  { name: 'laptop-s',   w: 1280, h: 720  },
  { name: 'laptop',     w: 1366, h: 768  },
  { name: 'mac',        w: 1440, h: 900  },
  { name: 'fhd',        w: 1920, h: 1080 },
  { name: 'qhd',        w: 2560, h: 1440 },
];

// /tonight/ is audited through its #seattle deep link, which opens a city and
// so builds the map; the bare page has no map until someone picks a city.
// /check/?schools is where the homepage's Schools card and the old /schools/
// URL land, and it is the /check/ state with the most on screen at once.
// /safety/baltimore/medfield-hampden-woodberry-remington/ stands for the area
// pages whose names are slash-joined: a browser will not wrap after "/", and
// before render-pages.mjs added a <wbr> after each one, 24 such pages pushed a
// phone sideways by up to 264px while Peckham, the other area page here, was
// fine. /404.html is what Pages serves for every missing path, so it is a
// page type of its own with the same header and footer.
const ALL_PAGES = ['/', '/check/', '/check/?schools', '/tonight/#seattle', '/safety/', '/safety/london/', '/safety/london/peckham/',
  '/safety/baltimore/medfield-hampden-woodberry-remington/', '/transparency/', '/404.html'];
// The tab each page type is ON, by its nav link's href (null: none — the
// homepage and the 404 page are not one of the tabs).
const CURRENT_TAB = p => p.startsWith('/check/') ? '/check/' : p.startsWith('/tonight/') ? '/tonight/'
  : p.startsWith('/safety/') ? '/safety/' : p.startsWith('/transparency/') ? '/transparency/' : null;
// A filter names one page; a listed page also brings its ?query variants.
const PAGES = !FILTER ? ALL_PAGES
  : ALL_PAGES.includes(FILTER) ? ALL_PAGES.filter(p => p === FILTER || p.startsWith(FILTER + '?'))
  : [FILTER];

// Map pages, with targets that match what each map is FOR. The others are
// reading pages, where a constrained line length is correct and is not flagged.
//   /check/   is a tool — on a desktop layout the map should be the screen.
//   /tonight/ embeds its map under a city list, so about two-thirds is right.
// areaMin: [[minWidth, floor], ...] — the entry with the largest minWidth <= the
// viewport width applies (desktopMin may take the same form). strict: this
// page's map-fill and area WARNs become FAILs, so the layout cannot silently
// regress.
const MAPS = {
  // areaMin is acceptance A1 itself, size by size, so a regression that costs
  // a few points of map on a big screen cannot pass.
  '/check/':          { sel: '#map', desktopMin: 0.85, desktopWidthMin: 0.55, strict: true,
    areaMin: [[861, 0.50], [1024, 0.55], [1280, 0.63], [1366, 0.66], [1440, 0.67], [1920, 0.70], [2560, 0.74]] },
  // The schools toolbar sits above the map inside its stage, so the map gives
  // up some height here. The prepare step waits until the layer has actually
  // DRAWN (pins on the map, or its note shown): the note starts out hidden, so
  // "note not visible" alone is true before anything has happened, and a check
  // made then would pass whatever the layer later does.
  // At 861px the stage is ~490px wide and the toolbar wraps to four rows
  // (~155px), leaving the map 69% of the height; from 1024 it is 75%+. So the
  // height floor is 0.70 from 1024 and 0.65 at the edge, where one more row
  // (~40px) would still trip it.
  '/check/?schools':  { sel: '#map', desktopMin: [[861, 0.65], [1024, 0.70]], desktopWidthMin: 0.55, areaMin: [[1280, 0.50]], strict: true, schools: true,
    prepare: `(async () => {
      const note = () => document.querySelector('.schnote');
      const drawn = () => {
        try {
          if (typeof schBusy !== 'undefined' && schBusy) return false;
          if (typeof schLayer !== 'undefined' && schLayer && map.hasLayer(schLayer)) return true;
        } catch {}
        return note()?.hidden === false;
      };
      for (let i = 0; i < 20; i++) {
        if (drawn()) return 'ok';
        await new Promise(r => setTimeout(r, 150));
      }
      return drawn() ? 'ok' : 'timeout';
    })()` },
  // Tonight's Leaflet map is built only once LIVE data arrives, and the backend
  // answers only safe-route.app — so offline it never builds. What the audit
  // measures is the container, whose size does not depend on the data: the
  // card is static HTML, so .citymap is there from the first paint, and when
  // every city fetch fails the page keeps it at full size, marked .nomap ("No
  // live data to map"). So the prepare returns at once; its 'live' means the
  // container was found, not that live data was seen. The wait and the
  // ensureMap fallback date from when the error handler rewrote the slot and
  // could delete a container the audit had just built; they stay as a guard.
  // strict: its phone band (55-80%) FAILs rather than WARNs. On a landscape
  // phone its 340px floor once made the map 87% of the screen, a touch scroll
  // trap that sat in this report as a WARN nobody acted on.
  '/tonight/#seattle': { sel: '.citymap', desktopMin: 0.60, strict: true, prepare: `(async () => {
      for (let i = 0; i < 40; i++) {
        if (document.querySelector('.citymap')) return 'live';
        if (/Couldn.t load the live layers/.test(document.body.innerText)) break;
        await new Promise(r => setTimeout(r, 150));
      }
      if (!document.querySelector('.citymap') && typeof ensureMap === 'function') { ensureMap(); return 'built'; }
      return document.querySelector('.citymap') ? 'live' : 'missing';
    })()` },
};
// Below 861px the pane stacks under the map. There the map must be big enough
// to use but must NOT fill the screen: on touch, one-finger drag pans the map,
// so a full-height map traps the page and the content under it is unreachable.
const STACKED_BELOW = 861;
const MOBILE_BAND = [0.55, 0.80];
// Where acceptance A7 requires the search box, not just the map, to be on
// screen after a search.
const Q_AFTER_SEARCH = new Set(['320x568', '360x740', '390x844']);

// Sideways overflow that is known and tolerated: { page, w, tag, px }. An entry
// covers its page, width and offender up to the recorded overflow; a different
// offender or more overflow FAILs, and an entry that no longer reproduces
// WARNs, so the list can only shrink. EMPTY since 2026-09-25: measuring
// overflow against the device width (innerWidth reads 0 under mobile
// emulation) exposed six cases on pages outside /check/ — sr.css's nowrap
// .btn ("Get SafeRoute on the App Store", 296px) and the /safety/ ranking
// table (346px at its narrowest) — and both were fixed in CSS. Add to it only
// with a reason and a plan to remove it.
const KNOWN_OVERFLOW = [];
// Under 540px tall the shell lets the page scroll rather than crush the column.
const SHELL_MIN_H = 540;

// Where ?schools must open: central London, the densest schools data and the
// page's own VIEWS.schools box. [[south, west], [north, east]].
const CENTRAL_LONDON = [[51.47, -0.165], [51.535, -0.055]];

// The time-zone pass (see WHAT IT CHECKS). Boxes are [[south, west], [north, east]].
const TZ_VIEWS = [
  { tz: 'Europe/London',       box: [[49.9, -8.2], [56.0, 1.8]],        minZoom: 5 },
  { tz: 'America/New_York',    box: [[24.5, -124.8], [49.6, -66.9]],    minZoom: 4, maxZoom: 5 },
  { tz: 'America/Mexico_City', box: [[19.18, -99.34], [19.6, -98.94]],  minZoom: 10 },
  { tz: 'Asia/Tokyo',          maxZoom: 4, holds: { London: [51.5074, -0.1278], 'New York': [40.7549, -73.984] } },
];

const CHROME = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
].find(p => existsSync(p));

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── a static server for the site (plus an optional overlay), so the audit
// needs nothing else running ──
const TYPES = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.json': 'application/json',
                '.svg': 'image/svg+xml', '.png': 'image/png', '.webp': 'image/webp', '.jpg': 'image/jpeg', '.ico': 'image/x-icon' };
async function resolveIn(root, p) {
  let f = join(root, p);
  try { if ((await stat(f)).isDirectory()) f = join(f, 'index.html'); } catch {}
  return existsSync(f) ? f : null;
}
function serve() {
  const srv = createServer(async (req, res) => {
    const p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    const f = (OVERLAY && await resolveIn(OVERLAY, p)) || await resolveIn(SITE, p);
    try {
      if (!f) throw 0;
      const body = await readFile(f);
      res.writeHead(200, { 'Content-Type': TYPES[extname(f)] || 'application/octet-stream' });
      res.end(body);
    } catch { res.writeHead(404); res.end(); }
  });
  return new Promise(r => srv.listen(0, '127.0.0.1', () => r(srv)));
}

// ── minimal DevTools Protocol client ───────────────────────────────────────
function cdp(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let id = 0;
  const pending = new Map(), waiters = [];
  ws.onmessage = ev => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
    else if (m.method) for (const w of [...waiters]) if (w.method === m.method) { w.resolve(m.params); waiters.splice(waiters.indexOf(w), 1); }
  };
  const ready = new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  return {
    ready,
    send: (method, params = {}) => new Promise(res => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); }),
    once: method => new Promise(resolve => waiters.push({ method, resolve })),
    close: () => ws.close(),
  };
}

// Runs inside the page. Returns plain JSON.
// "Visible" means inside the viewport AND below the header: header.site is
// sticky and near-opaque, so whatever scrolls under it is covered.
const AUDIT = (mapSel, isCheck) => {
  const vw = window.innerWidth, vh = window.innerHeight;
  const docW = document.documentElement.scrollWidth;
  // Under mobile emulation Chrome zooms a too-wide page OUT to fit it, which
  // widens innerWidth to the content: the old /check/ was 378px wide on a
  // 320px phone and read as 0px of overflow, and so did five other pages at
  // 320px. The layout viewport (clientWidth) stays at the device width, so
  // every page is measured against that.
  const edge = document.documentElement.clientWidth;
  const out = { overflow: Math.max(0, docW - edge) };
  // An element inside a clipping ancestor (the map's tiles, the phone filter
  // row's hidden end) cannot be what widens the page; naming it sent the old
  // 320px /check/ report to img.leaflet-tile instead of button#geo.
  const clipped = el => { for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) if (getComputedStyle(p).overflowX !== 'visible') return true; return false; };
  if (out.overflow) {
    let worst = null;
    for (const el of document.querySelectorAll('body *')) {
      const r = el.getBoundingClientRect();
      if (r.width === 0) continue;
      const over = r.right - edge;
      if (over > 1 && (!worst || over > worst.over) && !clipped(el)) {
        worst = { over: Math.round(over), tag: el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + (el.className && typeof el.className === 'string' ? '.' + el.className.trim().split(/\s+/).slice(0, 2).join('.') : '') };
      }
    }
    out.offender = worst;
  }
  const hdr = document.querySelector('header.site');
  const hdrBottom = hdr ? Math.max(0, hdr.getBoundingClientRect().bottom) : 0;
  const box = el => { if (!el) return null; const r = el.getBoundingClientRect();
    return { top: +r.top.toFixed(1), bottom: +r.bottom.toFixed(1), left: +r.left.toFixed(1), right: +r.right.toFixed(1), w: Math.round(r.width), h: Math.round(r.height) }; };
  if (mapSel) {
    const m = document.querySelector(mapSel);
    if (m) {
      const r = m.getBoundingClientRect();
      out.mapH = Math.round(r.height);
      out.mapW = Math.round(r.width);
      out.mapFill = +(Math.min(r.height, vh) / vh).toFixed(2);
      // How much of the SCREEN the map covers on ARRIVAL, before any scroll.
      const visW = Math.max(0, Math.min(vw, r.right) - Math.max(0, r.left));
      const visH = Math.max(0, Math.min(vh, r.bottom) - Math.max(hdrBottom, r.top));
      out.area = +(visW * visH / (vw * vh)).toFixed(3);
      out.mapTop = +r.top.toFixed(1);
      out.mapRight = +r.right.toFixed(1);
    }
    // .layout is gone in the app shell; <main> is the frame in both layouts.
    const side = document.querySelector('#side, aside');
    const lay = document.querySelector('main');
    if (isCheck && side && lay) {
      const s = side.getBoundingClientRect(), l = lay.getBoundingClientRect();
      out.paneOk = s.right <= l.right + 1 && s.left >= l.left - 1;
    }
  }
  if (isCheck) {
    out.hdrBottom = +hdrBottom.toFixed(1);
    out.hdrH = hdr ? hdr.offsetHeight : 0;
    out.docH = document.documentElement.scrollHeight;
    const h1s = [...document.querySelectorAll('h1')];
    const shown = h1s.filter(h => { const r = h.getBoundingClientRect(); return r.width > 0 && r.height > 0; });
    out.h1Visible = shown.length;
    out.h1Rect = box(shown[0] || h1s[0]);
    const lead = document.getElementById('lead');
    out.leadVisible = !!lead && getComputedStyle(lead).display !== 'none' && lead.offsetHeight > 0;
    out.leadMissing = !lead;
    out.qRect = box(document.getElementById('q'));
    const side = document.getElementById('side');
    out.side = side ? { ...box(side), overflowY: getComputedStyle(side).overflowY } : null;
    out.sideMargin = side ? parseFloat(getComputedStyle(side).scrollMarginTop) || 0 : null;
    // Every ancestor that could clip the autocomplete. The root's overflow (and
    // the body's, when the root's is visible) applies to the viewport rather
    // than to that element's box, so it clips nothing the viewport would not.
    const ac = document.getElementById('ac');
    out.acClip = [];
    const rootVisible = ['overflowX', 'overflowY'].every(k => getComputedStyle(document.documentElement)[k] === 'visible');
    for (let el = ac && ac.parentElement; el && el !== document.documentElement; el = el.parentElement) {
      if (el === document.body && rootVisible) continue;
      const cs = getComputedStyle(el);
      const vals = [cs.overflow, cs.overflowX, cs.overflowY];
      if (vals.some(v => v !== 'visible')) out.acClip.push(`${el.tagName.toLowerCase()}${el.id ? '#' + el.id : ''}${typeof el.className === 'string' && el.className.trim() ? '.' + el.className.trim().split(/\s+/)[0] : ''} (overflow ${cs.overflowX}/${cs.overflowY})`);
    }
    // The schools toolbar may legitimately sit between the header and the map,
    // as the top strip of the map's stage.
    const sb = document.getElementById('schbar'), stage = document.querySelector('.stage');
    const sbShown = sb && getComputedStyle(sb).display !== 'none' && sb.getBoundingClientRect().height > 0;
    out.topStrip = sbShown && stage && stage.contains(sb) ? box(sb) : null;
  }
  return out;
};

// Runs inside the page: the autocomplete z-order probe. Three fake rows go into
// #ac and each row's centre must land on #ac itself — anything else there is
// painting over the list. On a stacked layout the list may start below the
// fold, so it is scrolled into view first, as a reader would; the desktop shell
// cannot scroll, so there a row off the bottom of the screen is a miss.
const AC_PROBE = () => {
  const ac = document.getElementById('ac');
  if (!ac) return { missing: true };
  const de = document.documentElement, prevSB = de.style.scrollBehavior;
  de.style.scrollBehavior = 'auto';
  const sx = scrollX, sy = scrollY;
  ac.innerHTML = '<li><a><span class=nm>probe</span></a></li>'.repeat(3);
  const r0 = ac.getBoundingClientRect();
  if (r0.bottom > innerHeight) ac.scrollIntoView({ block: 'end', behavior: 'instant' });
  const hdr = document.querySelector('header.site');
  const misses = [];
  for (const li of ac.children) {
    const r = li.getBoundingClientRect(), x = r.left + r.width / 2, y = r.top + r.height / 2;
    const hit = document.elementFromPoint(x, y);
    if (!hit || !ac.contains(hit)) {
      const name = !hit ? 'nothing (off-screen)' : hit.tagName.toLowerCase() + (hit.id ? '#' + hit.id : '') + (typeof hit.className === 'string' && hit.className.trim() ? '.' + hit.className.trim().split(/\s+/)[0] : '')
        + (hdr && hdr.contains(hit) ? ' in header' : '');
      misses.push(`y=${Math.round(y)} hits ${name}`);
    }
  }
  ac.innerHTML = '';
  window.scrollTo({ left: sx, top: sy, behavior: 'instant' });
  de.style.scrollBehavior = prevSB;
  return { misses };
};

// Runs inside the page, ?schools only: the layer's own state after prepare.
// fitZoom is the closest zoom at which central London fits this map with the
// page's 16px padding: z13 on a laptop, but z11 on a 320px-wide phone or a
// landscape phone's 248px-tall map, where z12 cannot show it.
const SCHOOLS = (london) => {
  // The device width, not innerWidth: a toolbar pushed past a phone's edge
  // widens the page, and mobile emulation then zooms out until it "fits".
  const vw = document.documentElement.clientWidth, vh = innerHeight;
  const hdr = document.querySelector('header.site');
  const hdrBottom = hdr ? Math.max(0, hdr.getBoundingClientRect().bottom) : 0;
  const sb = document.getElementById('schbar');
  const note = document.querySelector('.schnote');
  const bar = sb?.getBoundingClientRect();
  // The filter row, not just the bar: the bar is always the stage's full
  // width, so its box alone cannot show filters clipped past the edge. On a
  // phone the row must scroll sideways, and its LAST control must come fully
  // into view (and be the thing under the pointer) once it has.
  const row = sb?.querySelector('.sb-filters');
  let reach = null;
  if (row && sb.offsetParent) {
    const last = row.lastElementChild, keep = row.scrollLeft;
    const ox = getComputedStyle(row).overflowX;
    row.scrollLeft = row.scrollWidth;
    const r = last?.getBoundingClientRect(), rr = row.getBoundingClientRect();
    const hit = r ? document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2) : null;
    reach = { overflows: row.scrollWidth > row.clientWidth + 1, ox, last: last?.id || last?.textContent.trim().slice(0, 20),
      ok: !!(r && r.width && r.left >= Math.max(0, rr.left) - 1 && r.right <= Math.min(vw, rr.right) + 1 && hit && last.contains(hit)) };
    row.scrollLeft = keep;
  }
  const side = document.getElementById('side')?.getBoundingClientRect();
  let zoom = null, fitZoom = null, centre = null;
  try {
    zoom = map.getZoom();
    const c = map.getCenter(); centre = [+c.lat.toFixed(4), +c.lng.toFixed(4)];
    fitZoom = map.getBoundsZoom(L.latLngBounds(london), false, L.point(32, 32));
  } catch {}
  return {
    schbarDisplay: sb ? getComputedStyle(sb).display : null,
    schbarInStage: !!(sb && sb.closest('.stage')),
    zoom, fitZoom, centre,
    noteVisible: !!(note && !note.hidden && getComputedStyle(note).display !== 'none' && note.getBoundingClientRect().height > 0),
    noteText: note?.textContent.trim() || '',
    bar: bar ? { left: Math.round(bar.left), right: Math.round(bar.right), w: Math.round(bar.width), h: Math.round(bar.height) } : null,
    reach,
    sideVisH: side ? Math.round(Math.max(0, Math.min(vh, side.bottom) - Math.max(hdrBottom, side.top))) : null,
    room: Math.round(vh - hdrBottom),
    vw,
  };
};

// Runs inside the page: the state right after a search. revealTool() is what a
// search calls to bring the answer into view. It may scroll smoothly, so wait
// until the scroll position has held still before measuring.
const AFTER_SEARCH = `(async () => {
  if (typeof revealTool !== 'function') return null;
  document.documentElement.style.scrollBehavior = 'auto';
  revealTool();
  await new Promise(r => setTimeout(r, 900));
  for (let i = 0, last = scrollY, still = 0; i < 40 && still < 4; i++) {
    await new Promise(r => setTimeout(r, 50));
    if (scrollY === last) still++; else { still = 0; last = scrollY; }
  }
  const vw = innerWidth, vh = innerHeight;
  const hdr = document.querySelector('header.site');
  const hdrBottom = hdr ? Math.max(0, hdr.getBoundingClientRect().bottom) : 0;
  const m = document.querySelector('#map').getBoundingClientRect();
  const visW = Math.max(0, Math.min(vw, m.right) - Math.max(0, m.left));
  const visH = Math.max(0, Math.min(vh, m.bottom) - Math.max(hdrBottom, m.top));
  const q = document.getElementById('q')?.getBoundingClientRect();
  return {
    scrollY: Math.round(scrollY),
    area: +(visW * visH / (vw * vh)).toFixed(3),
    mapTop: +m.top.toFixed(1), hdrBottom: +hdrBottom.toFixed(1),
    visFrac: m.height ? +(visH / m.height).toFixed(2) : 0,
    qRect: q ? { top: +q.top.toFixed(1), bottom: +q.bottom.toFixed(1), left: +q.left.toFixed(1), right: +q.right.toFixed(1) } : null,
  };
})()`;

// Counts geolocation requests from the moment a document starts, for the
// time-zone pass: the page must never ask on load, only on a click.
const GEO_SPY = `(() => { window.__geoAsked = 0; const g = navigator.geolocation; if (!g) return;
  for (const k of ['getCurrentPosition', 'watchPosition']) { const f = g[k].bind(g); g[k] = (...a) => { window.__geoAsked++; return f(...a); }; } })()`;

// Runs inside the page: the site header as a reader sees it. A nav link's
// label may be shortened on phones ("Safety" for "Safety index", the rest
// kept for screen readers), so links are found by href, not by their text.
const HEADER = () => {
  const hdr = document.querySelector('header.site');
  if (!hdr) return { missing: true };
  const vw = document.documentElement.clientWidth;
  const shown = el => { const cs = getComputedStyle(el), r = el.getBoundingClientRect();
    return cs.display !== 'none' && cs.visibility !== 'hidden' && r.width > 1 && r.height > 1 && r.left >= -1 && r.right <= vw + 1; };
  const items = [...hdr.querySelectorAll('.wordmark, .site-nav a')].filter(shown);
  const mids = items.map(el => { const r = el.getBoundingClientRect(); return r.top + r.height / 2; });
  const link = href => { const a = hdr.querySelector(`.site-nav a[href="${href}"]`); if (!a) return null;
    const r = a.getBoundingClientRect(); return { shown: shown(a), w: +r.width.toFixed(1), h: +r.height.toFixed(1) }; };
  return {
    h: +hdr.getBoundingClientRect().height.toFixed(1),
    spread: mids.length ? +(Math.max(...mids) - Math.min(...mids)).toFixed(1) : 0,
    map: link('/check/'), safety: link('/safety/'),
    current: [...hdr.querySelectorAll('[aria-current="page"]')].map(a => a.getAttribute('href')),
  };
};

// ── helpers for the checks ────────────────────────────────────────────────
const pctOf = x => Math.round(x * 100);
// Area shortfalls print one decimal: 49.7% rounds to "50%", which would read
// as passing a 50% floor.
const pct1 = x => `${(x * 100).toFixed(1)}%`;
// A floor is a number, or [[minWidth, floor], ...] where the entry with the
// largest minWidth <= the viewport width applies (none applies: no floor).
const floorFor = (spec, vw) => {
  if (typeof spec === 'number') return spec;
  let best = null;
  for (const [w, min] of spec || []) if (w <= vw && (!best || w > best[0])) best = [w, min];
  return best ? best[1] : null;
};
const inside = (r, top, bottom, vw) => r && r.w > 0 && r.h > 0 && r.top >= top - 1 && r.bottom <= bottom + 1 && r.left >= -1 && r.right <= vw + 1;
const px = n => `${Math.round(n)}px`;

async function main() {
  if (!CHROME) { console.error('audit-viewports: no Chrome/Chromium found'); process.exit(2); }
  const srv = await serve();
  const base = `http://127.0.0.1:${srv.address().port}`;
  const profile = await mkdtemp(join(tmpdir(), 'sr-audit-'));
  // Port 0 lets Chrome pick a free port and write it to DevToolsActivePort.
  // A guessed port could collide with another audit running at the same time,
  // and the audit would then drive THAT run's browser.
  const chrome = spawn(CHROME, [
    '--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`,
    '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--hide-scrollbars', 'about:blank',
  ], { stdio: 'ignore' });
  const cleanup = () => { try { chrome.kill(); } catch {} };
  process.on('exit', cleanup);

  let port, version;
  for (let i = 0; i < 60 && !version; i++) {
    try {
      port ||= +(await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0] || undefined;
      if (port) version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
    } catch {}
    if (!version) await sleep(150);
  }
  if (!version) { chrome.kill(); srv.close(); console.error('audit-viewports: Chrome did not start'); process.exit(2); }

  const target = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' })).json();
  const c = cdp(target.webSocketDebuggerUrl);
  await c.ready;
  await c.send('Page.enable');
  await c.send('Runtime.enable');

  const ev = async (expression, awaitPromise = false) =>
    (await c.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise })).result?.result?.value;
  const load = async url => {
    // Navigating to the URL already open, differing only in its #fragment, is
    // a same-document jump in Chrome: no reload and no load event. A one-page
    // run of '/tonight/#seattle' or '/check/#schools' loads the same URL at
    // every size and measured the previous size's page, so go via a blank one.
    if (url.includes('#')) {
      const blank = c.once('Page.loadEventFired');
      await c.send('Page.navigate', { url: 'about:blank' });
      await Promise.race([blank, sleep(2000)]);
    }
    const loaded = c.once('Page.loadEventFired');
    await c.send('Page.navigate', { url });
    await Promise.race([loaded, sleep(8000)]);
    await sleep(350);   // let ResizeObservers and layout settle
  };

  let fails = 0, warns = 0;
  const knowns = new Set();
  const rows = [];
  const headerHeights = [];
  for (const vp of VIEWPORTS) {
    await c.send('Emulation.setDeviceMetricsOverride', {
      width: vp.w, height: vp.h, deviceScaleFactor: 1, mobile: vp.mobile ?? vp.w < 768,
    });
    const desktop = vp.w >= STACKED_BELOW;
    const heights = [];   // [page, header height] at this size, compared below
    for (const page of PAGES) {
      const isCheck = page.startsWith('/check/');
      await load(base + page);
      // Web fonts swap in after load and change line breaks: the column's on
      // the shell, and the header's everywhere (its tabs are Plex Mono, and
      // whether they fit one row is measured to the pixel). Wait for them.
      await ev(`Promise.race([document.fonts.ready.then(() => 1), new Promise(r => setTimeout(r, 3000))])`, true);
      const hd = (await ev(`(${HEADER.toString()})()`)) || { missing: true };
      // An unlisted /check/ URL is still the app shell: it takes the contract
      // of the variant it is (schools mode or not), never none.
      const mapCfg = MAPS[page] || (isCheck ? MAPS[/[?&]schools\b|#schools$/.test(page) ? '/check/?schools' : '/check/'] : null);
      const mapSel = mapCfg ? mapCfg.sel : null;
      let prepared = null;
      if (mapCfg?.prepare) {
        prepared = await ev(mapCfg.prepare, true);
        await sleep(250);
      }
      const a = (await ev(`(${AUDIT.toString()})(${JSON.stringify(mapSel)}, ${isCheck})`)) || {};
      const issues = [];
      const flag = (level, msg) => { issues.push(`${level} ${msg}`); if (level === 'FAIL') fails++; else warns++; };
      const sev = mapCfg?.strict ? 'FAIL' : 'WARN';
      // ── header ──
      if (hd.missing) flag('FAIL', 'no header.site');
      else {
        heights.push([page, hd.h]);
        if (hd.spread > 1.5) flag('FAIL', `header wraps to more than one row (${hd.h}px tall; items ${hd.spread}px apart)`);
        for (const [name, l] of [['Map', hd.map], ['Safety index', hd.safety]]) {
          if (!l) flag('FAIL', `header has no ${name} link`);
          else if (!l.shown) flag('FAIL', `header hides ${name} at this width`);
          else if (l.w < 24 || l.h < 24) flag('FAIL', `header ${name} target ${l.w}x${l.h}px (want >= 24x24)`);
        }
        // Markup, not layout: checked at the first size only, so a missing
        // attribute is one FAIL per page rather than one per size.
        const want = CURRENT_TAB(page);
        if (vp === VIEWPORTS[0] && (want ? hd.current.join() !== want : hd.current.length)) {
          flag('FAIL', `aria-current="page" on ${hd.current.length ? hd.current.join(', ') : 'no tab'} (want ${want || 'none'})`);
        }
      }
      if (a.overflow) {
        const tag = a.offender?.tag || '';
        const known = KNOWN_OVERFLOW.find(k => k.page === page && k.w === vp.w && (tag === k.tag || tag.startsWith(k.tag + '.')) && a.overflow <= k.px + 2);
        if (known) { issues.push(`KNOWN overflow ${a.overflow}px (${tag}) — fix outside /check/, see KNOWN_OVERFLOW`); knowns.add(known); }
        else flag('FAIL', `overflow ${a.overflow}px${tag ? ` (${tag})` : ''}`);
      }
      if (mapCfg && a.mapFill != null) {
        const pct = pctOf(a.mapFill);
        if (desktop) {
          const hMin = floorFor(mapCfg.desktopMin, vp.w);
          if (hMin != null && a.mapFill < hMin) flag(sev, `map uses ${pct}% of height (want >= ${pctOf(hMin)}%)`);
          const wFill = a.mapW / vp.w;
          if (mapCfg.desktopWidthMin && wFill < mapCfg.desktopWidthMin) flag(sev, `map uses ${pctOf(wFill)}% of width (want >= ${pctOf(mapCfg.desktopWidthMin)}%)`);
          const floor = floorFor(mapCfg.areaMin, vp.w);
          if (floor != null && a.area < floor) flag(sev, `map covers ${pct1(a.area)} of screen area on load (want >= ${pctOf(floor)}%)`);
        } else if (a.mapFill < MOBILE_BAND[0]) {
          flag(sev, `map uses ${pct}% of height — too small to use`);
        } else if (a.mapFill > MOBILE_BAND[1]) {
          flag(sev, `map uses ${pct}% of height — traps scrolling on touch`);
        }
      } else if (mapCfg && a.mapH == null) {
        flag('FAIL', 'map element not found');
      }
      if (a.paneOk === false) flag('FAIL', 'pane outside layout');
      if (prepared === 'built') issues.push('(container built offline — no live data)');

      if (isCheck) {
        // ── every size ──
        if (a.h1Visible !== 1) flag('FAIL', `${a.h1Visible} visible h1 (want exactly 1)`);
        if (!a.leadVisible) flag('FAIL', a.leadMissing ? 'lead not visible on arrival — no #lead element' : 'lead not visible on arrival');
        if (a.acClip?.length) flag('FAIL', `#ac clipped by ${a.acClip.join(', ')}`);
        const probe = await ev(`(${AC_PROBE.toString()})()`);
        if (!probe || probe.missing) flag('FAIL', '#ac not found');
        else if (probe.misses.length) flag('FAIL', `#ac covered at ${probe.misses.length} of 3 probe rows (${probe.misses.join('; ')})`);

        // ── desktop app shell ──
        if (desktop && vp.h >= SHELL_MIN_H) {
          if (a.docH > vp.h + 1) flag('FAIL', `page scrolls — app shell broken (document ${px(a.docH)}, viewport ${px(vp.h)})`);
          if (a.mapTop != null) {
            if (a.topStrip) {
              if (Math.abs(a.topStrip.top - a.hdrBottom) > 1) flag('FAIL', `schools toolbar not directly under header (toolbar top ${px(a.topStrip.top)}, header bottom ${px(a.hdrBottom)})`);
              if (Math.abs(a.mapTop - a.topStrip.bottom) > 1) flag('FAIL', `map not directly under the schools toolbar (map top ${px(a.mapTop)}, toolbar bottom ${px(a.topStrip.bottom)})`);
            } else if (Math.abs(a.mapTop - a.hdrBottom) > 1) {
              flag('FAIL', `map not directly under header (map top ${px(a.mapTop)}, header bottom ${px(a.hdrBottom)})`);
            }
            if (a.mapRight < vp.w - 1) flag('FAIL', `map not full-bleed (right edge ${px(a.mapRight)} of ${px(vp.w)})`);
          }
          const s = a.side;
          if (!s) flag('FAIL', 'no #side pane');
          else {
            if (s.left < -1 || s.right > vp.w + 1) flag('FAIL', `pane not inside the screen (x ${px(s.left)}–${px(s.right)} of ${px(vp.w)})`);
            if (s.bottom > vp.h + 1) flag('FAIL', `pane runs below the screen (bottom ${px(s.bottom)} of ${px(vp.h)})`);
            if (!['auto', 'scroll'].includes(s.overflowY)) flag('FAIL', `pane does not scroll itself (overflow-y ${s.overflowY})`);
          }
          if (!inside(a.qRect, a.hdrBottom, vp.h, vp.w)) flag('FAIL', `#q not fully on screen under the header (${a.qRect ? `y ${px(a.qRect.top)}–${px(a.qRect.bottom)}` : 'missing'})`);
          if (!inside(a.h1Rect, a.hdrBottom, vp.h, vp.w)) flag('FAIL', `h1 not fully on screen under the header (${a.h1Rect ? `y ${px(a.h1Rect.top)}–${px(a.h1Rect.bottom)}` : 'missing'})`);
        }
        // ── stacked ──
        if (!desktop && a.sideMargin != null && a.sideMargin < a.hdrH) {
          flag('FAIL', `Back would hide under the header (#side scroll-margin-top ${px(a.sideMargin)} < header ${px(a.hdrH)})`);
        }

        // ── /check/?schools ──
        if (mapCfg?.schools) {
          const x = await ev(`(${SCHOOLS.toString()})(${JSON.stringify(CENTRAL_LONDON)})`) || {};
          if (prepared !== 'ok') flag('FAIL', 'schools layer did not draw within 3s');
          if (!x.schbarDisplay || x.schbarDisplay === 'none') flag('FAIL', '#schbar not shown with the schools layer on');
          const zFloor = Math.min(12, x.fitZoom ?? 12);
          if (x.zoom == null || x.zoom < zFloor) flag('FAIL', `schools view at zoom ${x.zoom} (want >= ${zFloor}${zFloor < 12 ? ', the closest fit of central London on this map' : ''})`);
          const [[s, w], [n, e]] = CENTRAL_LONDON;
          if (!x.centre || x.centre[0] < s || x.centre[0] > n || x.centre[1] < w || x.centre[1] > e) flag('FAIL', `schools view not centred on central London (${x.centre ? x.centre.join(',') : 'no map'})`);
          if (x.noteVisible) flag('FAIL', `.schnote visible — "${x.noteText}"`);
          if (desktop) {
            if (!x.schbarInStage) flag('FAIL', '#schbar is not inside .stage (the toolbar belongs on the map, not in the column)');
            if (x.sideVisH != null && x.sideVisH < 0.55 * x.room) flag('WARN', `pane keeps ${px(x.sideVisH)} of ${px(x.room)} under the header (want >= 55%)`);
          } else if (!x.bar || !x.bar.w || x.bar.left < 0 || x.bar.right > x.vw) {
            flag('FAIL', `#schbar not inside the screen (${x.bar ? `x ${x.bar.left}–${x.bar.right} of ${x.vw}` : 'missing'})`);
          } else if (!x.reach || !x.reach.ok || (x.reach.overflows && !/^(auto|scroll)$/.test(x.reach.ox))) {
            flag('FAIL', `last school filter (${x.reach?.last ?? '?'}) cannot be scrolled fully into view (row overflow-x ${x.reach?.ox ?? '?'})`);
          } else if (x.bar.h > 60) {
            // One row of filters that scrolls sideways; a taller bar means they
            // have started wrapping and are pushing the map down the phone.
            flag('WARN', `#schbar is ${x.bar.h}px tall on a phone (want one row, <= 60px)`);
          }
        }

        // ── after a search ──
        a.after = await ev(AFTER_SEARCH, true);
        const af = a.after;
        if (af) {
          if (desktop) {
            if (af.scrollY !== 0) flag('FAIL', `desktop page scrolled (scrollY ${af.scrollY} after a search)`);
            const floor = floorFor(mapCfg.areaMin, vp.w);
            if (floor != null && af.area < floor) flag(sev, `map covers ${pct1(af.area)} of screen area after a search (want >= ${pctOf(floor)}%)`);
          } else {
            if (af.mapTop < af.hdrBottom - 1) flag('FAIL', `map under the header after a search (map top ${px(af.mapTop)}, header bottom ${px(af.hdrBottom)})`);
            if (af.visFrac < 0.55) flag('FAIL', `only ${pctOf(af.visFrac)}% of the map on screen after a search (want >= 55%)`);
            if (!af.qRect || af.qRect.top < af.hdrBottom - 1 || af.qRect.bottom > vp.h + 1) flag(Q_AFTER_SEARCH.has(`${vp.w}x${vp.h}`) ? 'FAIL' : 'WARN', `#q not fully visible after a search (y ${af.qRect ? `${px(af.qRect.top)}–${px(af.qRect.bottom)}` : '?'}, header bottom ${px(af.hdrBottom)})`);
          }
        } else if (mapCfg) {
          flag('FAIL', 'no revealTool() — the after-search state could not be measured');
        }
      }
      const mapCol = mapSel && a.mapH
        ? `${a.mapW}x${a.mapH} (${pctOf(a.mapFill)}% h, ${pctOf(a.mapW / vp.w)}% w, area ${pctOf(a.area)}% on load${a.after ? `, ${pctOf(a.after.area)}% after search` : ''})`
        : '';
      rows.push({ vp: `${vp.name} ${vp.w}x${vp.h}`, page, map: mapCol, issues });
    }
    // One header, one height: every page type at this size must agree. No
    // single page can show this drift, which is how a 95px bar on two tabs
    // and a 61px bar on the rest went unnoticed.
    const hs = heights.map(([, h]) => h);
    if (hs.length > 1 && Math.max(...hs) - Math.min(...hs) > 0.5) {
      fails++;
      const byH = {};
      for (const [p, h] of heights) (byH[h] ||= []).push(p);
      rows.push({ vp: `${vp.name} ${vp.w}x${vp.h}`, page: '(all pages)', map: '',
        issues: [`FAIL header height differs by page type: ${Object.entries(byH).map(([h, ps]) => `${h}px ${ps.join(' ')}`).join(' | ')}`] });
    }
    headerHeights.push(`${vp.w}x${vp.h} ${[...new Set(hs)].join('/')}px`);
  }

  // ── default view by time zone ──
  // The page picks its opening view from the browser's time zone, read at
  // load; a regression here sends a third of visitors to the wrong continent.
  if (PAGES.includes('/check/')) {
    await c.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    const spy = await c.send('Page.addScriptToEvaluateOnNewDocument', { source: GEO_SPY });
    for (const v of TZ_VIEWS) {
      await c.send('Emulation.setTimezoneOverride', { timezoneId: v.tz });
      await load(base + '/check/');
      const s = await ev(`(() => { try {
        const c = map.getCenter(), b = map.getBounds();
        return { lat: c.lat, lng: c.lng, zoom: map.getZoom(), geo: window.__geoAsked || 0,
          holds: Object.fromEntries(Object.entries(${JSON.stringify(v.holds || {})}).map(([k, p]) => [k, b.contains(p)])) };
      } catch (e) { return { error: String(e) }; } })()`) || { error: 'no result' };
      const issues = [];
      const flag = msg => { issues.push(`FAIL ${msg}`); fails++; };
      if (s.error) flag(`default view not readable (${s.error})`);
      else {
        if (v.box) {
          const [[south, west], [north, east]] = v.box;
          if (s.lat < south || s.lat > north || s.lng < west || s.lng > east) flag(`centre ${s.lat.toFixed(2)},${s.lng.toFixed(2)} outside ${JSON.stringify(v.box)}`);
        }
        if (v.minZoom != null && s.zoom < v.minZoom) flag(`zoom ${s.zoom} (want >= ${v.minZoom})`);
        if (v.maxZoom != null && s.zoom > v.maxZoom) flag(`zoom ${s.zoom} (want <= ${v.maxZoom})`);
        for (const [k, ok] of Object.entries(s.holds)) if (!ok) flag(`${k} not in the opening view`);
        if (s.geo) flag(`geolocation requested on load (${s.geo}x) — only a click may ask`);
      }
      rows.push({ vp: 'time zone 1440x900', page: '/check/', map: `${v.tz}${s.error ? '' : ` opens on ${s.lat.toFixed(2)},${s.lng.toFixed(2)} z${s.zoom}`}`, issues });
    }
    await c.send('Emulation.setTimezoneOverride', { timezoneId: '' });
    await c.send('Page.removeScriptToEvaluateOnNewDocument', { identifier: spy.result.identifier });
  }

  // A known overflow that did not show up on a run that covered it has been
  // fixed (or has moved to a different offender, which FAILed above).
  const stale = KNOWN_OVERFLOW.filter(k => PAGES.includes(k.page) && VIEWPORTS.some(v => v.w === k.w) && !knowns.has(k));
  warns += stale.length;

  c.close(); chrome.kill(); srv.close();
  await rm(profile, { recursive: true, force: true }).catch(() => {});

  const pad = (s, n) => String(s).padEnd(n);
  for (const r of rows) {
    if (!r.issues.length && !r.map) continue;
    console.log(`  ${pad(r.vp, 20)} ${pad(r.page, 19)} ${pad(r.map, 64)} ${r.issues.join('; ') || 'ok'}`);
  }
  for (const k of stale) console.log(`  WARN known overflow on ${k.page} at ${k.w}px (${k.tag}, ${k.px}px) no longer reproduces — remove it from KNOWN_OVERFLOW`);
  console.log(`\n  header height by size: ${headerHeights.join(' · ')}`);
  console.log(`\n  ${rows.length} page/size combinations · ${fails} FAIL · ${warns} WARN · ${knowns.size} KNOWN`);
  process.exit(fails ? 1 : 0);
}

main().catch(e => { console.error('audit-viewports failed:', e.message); process.exit(2); });
