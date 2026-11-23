'use strict';
// Builds desktop/host-dotnet/assets/app.ico from app.svg (the favicon in index.html).
// Renders each size with headless Edge (same Chromium engine as the page), then packs PNG entries into one ICO.
// Run: node desktop/tools/make-icon.js

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ASSETS = path.join(__dirname, '..', 'host-dotnet', 'assets');
const SVG = fs.readFileSync(path.join(ASSETS, 'app.svg'), 'utf8');
const SIZES = [16, 24, 32, 48, 64, 128, 256];
const EDGE_CANDIDATES = [
  path.join(process.env['ProgramFiles(x86)'] || '', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
  path.join(process.env.ProgramFiles || '', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
];

const edge = EDGE_CANDIDATES.find((p) => fs.existsSync(p));
if (!edge) throw new Error('msedge.exe not found');

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'alifgunadi-office-icon-'));
const pngs = SIZES.map((size) => {
  const html = path.join(work, `icon-${size}.html`);
  const png = path.join(work, `icon-${size}.png`);
  fs.writeFileSync(
    html,
    `<!doctype html><html><body style="margin:0;background:transparent">` +
      SVG.replace('<svg ', `<svg width="${size}" height="${size}" style="display:block" `) +
      `</body></html>`,
  );
  execFileSync(edge, [
    '--headless=new',
    '--disable-gpu',
    '--hide-scrollbars',
    '--force-device-scale-factor=1',
    '--default-background-color=00000000',
    `--user-data-dir=${path.join(work, 'profile')}`,
    `--window-size=${size},${size}`,
    `--screenshot=${png}`,
    'file:///' + html.replace(/\\/g, '/'),
  ], { stdio: 'ignore', timeout: 30000 });
  return { size, data: fs.readFileSync(png) };
});

// ICO container with PNG-compressed entries (supported since Windows Vista).
const header = Buffer.alloc(6);
header.writeUInt16LE(0, 0);
header.writeUInt16LE(1, 2);
header.writeUInt16LE(pngs.length, 4);
let offset = 6 + 16 * pngs.length;
const entries = pngs.map(({ size, data }) => {
  const e = Buffer.alloc(16);
  e.writeUInt8(size >= 256 ? 0 : size, 0);
  e.writeUInt8(size >= 256 ? 0 : size, 1);
  e.writeUInt8(0, 2);
  e.writeUInt8(0, 3);
  e.writeUInt16LE(1, 4);
  e.writeUInt16LE(32, 6);
  e.writeUInt32LE(data.length, 8);
  e.writeUInt32LE(offset, 12);
  offset += data.length;
  return e;
});
fs.writeFileSync(path.join(ASSETS, 'app.ico'), Buffer.concat([header, ...entries, ...pngs.map((p) => p.data)]));
fs.copyFileSync(path.join(work, 'icon-256.png'), path.join(ASSETS, 'app-256.png'));
fs.rmSync(work, { recursive: true, force: true });
console.log('Wrote', path.join(ASSETS, 'app.ico'));
