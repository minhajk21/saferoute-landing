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
// every page type at every size in about a minute.
//
// WHAT IT CHECKS
//   overflow   the page scrolls sideways (FAIL — content is cut off)
//   offender   the widest element causing it, when it does
//   map fill   on map pages, how much of the viewport the map uses once
//              scrolled to it, against a target that fits what that map is for
//              (see MAPS) — and on stacked phone layouts, a band rather than a
//              floor, because a full-height map traps scrolling on touch
//   pane       on /check/, that the side pane stays inside the layout
//
// No npm dependencies: it drives an installed Chrome over the DevTools
// Protocol using Node's built-in WebSocket, and serves the repo itself, so it
// needs neither a running preview server nor the network.
//
// Usage:
//   node tools/audit-viewports.mjs            full matrix, exit 1 on any FAIL
//   node tools/audit-viewports.mjs /check/     one page

import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { readFile, stat, mkdtemp, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const VIEWPORTS = [
  { name: 'phone-s',  w: 360,  h: 740  },
  { name: 'phone',    w: 390,  h: 844  },
  { name: 'tablet',   w: 768,  h: 1024 },
  { name: 'tab-land', w: 1024, h: 768  },
  { name: 'laptop-s', w: 1280, h: 720  },
  { name: 'laptop',   w: 1366, h: 768  },
  { name: 'mac',      w: 1440, h: 900  },
  { name: 'fhd',      w: 1920, h: 1080 },
  { name: 'qhd',      w: 2560, h: 1440 },
];

// /tonight/ is audited through its #seattle deep link, which opens a city and
// so builds the map; the bare page has no map until someone picks a city.
const PAGES = process.argv[2]
  ? [process.argv[2]]
  : ['/', '/check/', '/tonight/#seattle', '/safety/', '/safety/london/', '/safety/london/peckham/', '/transparency/'];

// Map pages, with targets that match what each map is FOR. The others are
// reading pages, where a constrained line length is correct and is not flagged.
//   /check/   is a tool — on a desktop layout the map should be the screen.
//   /tonight/ embeds its map under a city list, so about two-thirds is right.
const MAPS = {
  '/check/':          { sel: '#map',     desktopMin: 0.80, desktopWidthMin: 0.55 },
  // Tonight only builds its map once LIVE data arrives, and the backend answers
  // only safe-route.app — so offline it never builds. The container's size does
  // not depend on the data, so the audit builds it directly (the page's own
  // ensureMap) and says so in the report rather than implying it saw live data.
  //
  // It must WAIT for the page to finish trying first. Offline, the page's own
  // city fetches fail, and its error handler rewrites the map slot with "Couldn't
  // load the live layers" — if that lands after the audit built the container,
  // it deletes it. That race made this report 'map not found' on roughly one
  // run in two; waiting until the page has settled removes it.
  '/tonight/#seattle': { sel: '.citymap', desktopMin: 0.60, prepare: `(async () => {
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

const CHROME = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
].find(p => existsSync(p));

// ── a static server for the repo, so the audit needs nothing else running ──
const TYPES = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.json': 'application/json',
                '.svg': 'image/svg+xml', '.png': 'image/png', '.webp': 'image/webp', '.jpg': 'image/jpeg', '.ico': 'image/x-icon' };
function serve() {
  const srv = createServer(async (req, res) => {
    let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    let f = join(ROOT, p);
    try { if ((await stat(f)).isDirectory()) f = join(f, 'index.html'); } catch {}
    try {
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
const AUDIT = (mapSel) => {
  const vw = window.innerWidth, vh = window.innerHeight;
  const docW = document.documentElement.scrollWidth;
  const out = { overflow: Math.max(0, docW - vw) };
  if (out.overflow) {
    let worst = null;
    for (const el of document.querySelectorAll('body *')) {
      const r = el.getBoundingClientRect();
      if (r.width === 0) continue;
      const over = r.right - vw;
      if (over > 1 && (!worst || over > worst.over)) {
        worst = { over: Math.round(over), tag: el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + (el.className && typeof el.className === 'string' ? '.' + el.className.trim().split(/\s+/).slice(0, 2).join('.') : '') };
      }
    }
    out.offender = worst;
  }
  if (mapSel) {
    const m = document.querySelector(mapSel);
    if (m) {
      const r = m.getBoundingClientRect();
      out.mapH = Math.round(r.height);
      out.mapW = Math.round(r.width);
      out.mapFill = +(Math.min(r.height, vh) / vh).toFixed(2);
      // How much of the screen the map occupies on ARRIVAL, before any scroll.
      out.onLoad = +(Math.max(0, Math.min(vh, r.bottom) - Math.max(0, r.top)) / vh).toFixed(2);
    }
    const side = document.querySelector('#side, aside');
    const lay = document.querySelector('.layout');
    if (side && lay) {
      const s = side.getBoundingClientRect(), l = lay.getBoundingClientRect();
      out.paneOk = s.right <= l.right + 1 && s.left >= l.left - 1;
    }
  }
  return out;
};

async function main() {
  if (!CHROME) { console.error('audit-viewports: no Chrome/Chromium found'); process.exit(2); }
  const srv = await serve();
  const base = `http://127.0.0.1:${srv.address().port}`;
  const profile = await mkdtemp(join(tmpdir(), 'sr-audit-'));
  const port = 9300 + Math.floor(Math.random() * 500);
  const chrome = spawn(CHROME, [
    '--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
    '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--hide-scrollbars', 'about:blank',
  ], { stdio: 'ignore' });

  let version;
  for (let i = 0; i < 50 && !version; i++) {
    try { version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json(); }
    catch { await new Promise(r => setTimeout(r, 150)); }
  }
  if (!version) { chrome.kill(); srv.close(); console.error('audit-viewports: Chrome did not start'); process.exit(2); }

  const target = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' })).json();
  const c = cdp(target.webSocketDebuggerUrl);
  await c.ready;
  await c.send('Page.enable');
  await c.send('Runtime.enable');

  let fails = 0, warns = 0;
  const rows = [];
  for (const vp of VIEWPORTS) {
    await c.send('Emulation.setDeviceMetricsOverride', {
      width: vp.w, height: vp.h, deviceScaleFactor: 1, mobile: vp.w < 768,
    });
    for (const page of PAGES) {
      const loaded = c.once('Page.loadEventFired');
      await c.send('Page.navigate', { url: base + page });
      await Promise.race([loaded, new Promise(r => setTimeout(r, 8000))]);
      await new Promise(r => setTimeout(r, 350));   // let ResizeObservers and layout settle
      const mapCfg = MAPS[page] || null;
      const mapSel = mapCfg ? mapCfg.sel : null;
      let prepared = null;
      if (mapCfg?.prepare) {
        prepared = (await c.send('Runtime.evaluate', { expression: mapCfg.prepare, returnByValue: true, awaitPromise: true })).result?.result?.value;
        await new Promise(r => setTimeout(r, 250));
      }
      const r = await c.send('Runtime.evaluate', {
        expression: `(${AUDIT.toString()})(${JSON.stringify(mapSel)})`, returnByValue: true,
      });
      const a = r.result?.result?.value || {};
      const issues = [];
      if (a.overflow) { issues.push(`FAIL overflow ${a.overflow}px${a.offender ? ` (${a.offender.tag})` : ''}`); fails++; }
      if (mapCfg && a.mapFill != null) {
        const pct = Math.round(a.mapFill * 100);
        if (vp.w >= STACKED_BELOW) {
          if (a.mapFill < mapCfg.desktopMin) { issues.push(`WARN map uses ${pct}% of height (want >= ${mapCfg.desktopMin * 100}%)`); warns++; }
          const wFill = a.mapW / vp.w;
          if (mapCfg.desktopWidthMin && wFill < mapCfg.desktopWidthMin) { issues.push(`WARN map uses ${Math.round(wFill * 100)}% of width (want >= ${mapCfg.desktopWidthMin * 100}%)`); warns++; }
        } else if (a.mapFill < MOBILE_BAND[0]) {
          issues.push(`WARN map uses ${pct}% of height — too small to use`); warns++;
        } else if (a.mapFill > MOBILE_BAND[1]) {
          issues.push(`WARN map uses ${pct}% of height — traps scrolling on touch`); warns++;
        }
      } else if (mapCfg && a.mapH == null) {
        issues.push('FAIL map element not found'); fails++;
      }
      if (a.paneOk === false) { issues.push('FAIL pane outside layout'); fails++; }
      if (prepared === 'built') issues.push('(container built offline — no live data)');
      // The user-facing outcome on /check/: after a search, how much of the
      // screen is the map. revealTool() is what a search calls to get there.
      if (page === '/check/') {
        const after = await c.send('Runtime.evaluate', { expression: `(() => { if (typeof revealTool !== 'function') return null;
          document.documentElement.style.scrollBehavior='auto'; revealTool();
          return new Promise(r => setTimeout(() => { const m = document.querySelector('#map').getBoundingClientRect(), vh = innerHeight;
            r(+(Math.max(0, Math.min(vh, m.bottom) - Math.max(0, m.top)) / vh).toFixed(2)); }, 900)); })()`, returnByValue: true, awaitPromise: true });
        a.afterSearch = after.result?.result?.value;
      }
      rows.push({ vp: `${vp.name} ${vp.w}x${vp.h}`, page, map: mapSel && a.mapH ? `${a.mapW}x${a.mapH} (${Math.round(a.mapFill * 100)}% h, ${Math.round(a.mapW / vp.w * 100)}% w, ${Math.round(a.onLoad * 100)}% on load${a.afterSearch != null ? `, ${Math.round(a.afterSearch * 100)}% after search` : ''})` : '', issues });
    }
  }
  c.close(); chrome.kill(); srv.close();
  await rm(profile, { recursive: true, force: true }).catch(() => {});

  const pad = (s, n) => String(s).padEnd(n);
  for (const r of rows) {
    if (!r.issues.length && !r.map) continue;
    console.log(`  ${pad(r.vp, 20)} ${pad(r.page, 19)} ${pad(r.map, 64)} ${r.issues.join('; ') || 'ok'}`);
  }
  console.log(`\n  ${rows.length} page/size combinations · ${fails} FAIL · ${warns} WARN`);
  process.exit(fails ? 1 : 0);
}

main().catch(e => { console.error('audit-viewports failed:', e.message); process.exit(2); });
