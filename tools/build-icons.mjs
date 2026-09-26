#!/usr/bin/env node
// tools/build-icons.mjs
//
// Rasterises /favicon.svg into /favicon.ico (16, 32 and 48px) and
// /apple-touch-icon.png (180px), so the three icons can never drift apart:
// edit the SVG, run this, commit all three.
//
// No npm dependencies, like audit-viewports.mjs: an installed Chrome renders
// the SVG over the DevTools Protocol, and the ICO container is written by
// hand. An ICO is a 6-byte header, one 16-byte entry per size, then each
// size's PNG verbatim; every browser has read PNG entries since IE/Vista.
//
// The touch icon is drawn as a full square with no rounded corners: iOS
// applies its own mask, and transparent corners would be filled black
// inside it.
//
// Usage: node tools/build-icons.mjs

import { spawn } from 'node:child_process';
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CHROME = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
].find(p => existsSync(p));
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function main() {
  if (!CHROME) { console.error('build-icons: no Chrome/Chromium found'); process.exit(2); }
  const svg = await readFile(join(ROOT, 'favicon.svg'), 'utf8');
  const profile = await mkdtemp(join(tmpdir(), 'sr-icons-'));
  const chrome = spawn(CHROME, ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`,
    '--no-first-run', '--no-default-browser-check', '--hide-scrollbars', 'about:blank'], { stdio: 'ignore' });
  process.on('exit', () => { try { chrome.kill(); } catch {} });
  let port, version;
  for (let i = 0; i < 60 && !version; i++) {
    try {
      port ||= +(await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0] || undefined;
      if (port) version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
    } catch {}
    if (!version) await sleep(150);
  }
  if (!version) { console.error('build-icons: Chrome did not start'); process.exit(2); }
  const target = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' })).json();
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  let id = 0; const pending = new Map();
  ws.onmessage = ev => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  const send = (method, params = {}) => new Promise(r => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });

  // Draws the SVG at exactly size x size CSS px on a transparent page.
  const shot = async (markup, size) => {
    await send('Emulation.setDeviceMetricsOverride', { width: size, height: size, deviceScaleFactor: 1, mobile: false });
    await send('Emulation.setDefaultBackgroundColorOverride', { color: { r: 0, g: 0, b: 0, a: 0 } });
    const sized = markup.replace('<svg ', `<svg width="${size}" height="${size}" style="display:block" `);
    const html = `<!doctype html><html style="background:transparent"><body style="margin:0;background:transparent">${sized}</body></html>`;
    await send('Page.navigate', { url: 'data:text/html;base64,' + Buffer.from(html).toString('base64') });
    await sleep(300);
    const r = await send('Page.captureScreenshot', { format: 'png', clip: { x: 0, y: 0, width: size, height: size, scale: 1 } });
    return Buffer.from(r.result.data, 'base64');
  };
  await send('Page.enable');
  const pngs = [];
  for (const s of [16, 32, 48]) pngs.push([s, await shot(svg, s)]);
  const touch = await shot(svg.replace(/ rx="[\d.]+"/, ''), 180);

  const head = Buffer.alloc(6);
  head.writeUInt16LE(0, 0); head.writeUInt16LE(1, 2); head.writeUInt16LE(pngs.length, 4);
  let offset = 6 + 16 * pngs.length;
  const entries = pngs.map(([s, buf]) => {
    const e = Buffer.alloc(16);
    e.writeUInt8(s, 0); e.writeUInt8(s, 1);          // width, height (< 256)
    e.writeUInt16LE(1, 4); e.writeUInt16LE(32, 6);   // colour planes, bits per pixel
    e.writeUInt32LE(buf.length, 8); e.writeUInt32LE(offset, 12);
    offset += buf.length;
    return e;
  });
  const ico = Buffer.concat([head, ...entries, ...pngs.map(p => p[1])]);
  await writeFile(join(ROOT, 'favicon.ico'), ico);
  await writeFile(join(ROOT, 'apple-touch-icon.png'), touch);
  ws.close(); chrome.kill();
  await rm(profile, { recursive: true, force: true }).catch(() => {});
  console.log(`favicon.ico ${ico.length} B (${pngs.map(([s, b]) => `${s}px ${b.length} B`).join(', ')}) · apple-touch-icon.png ${touch.length} B`);
}

main().catch(e => { console.error('build-icons failed:', e.message); process.exit(2); });
