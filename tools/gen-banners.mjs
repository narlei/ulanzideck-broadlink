#!/usr/bin/env node
/**
 * Builds the store art: resources/cover.png, banner1.png, banner2.png.
 *
 * Rendered from HTML rather than an image model so the copy, the key mockups
 * and the settings-panel shot are exactly what the plugin actually shows —
 * a store page that misspells its own UI is worse than no store page.
 *
 *   node tools/gen-banners.mjs
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PLUGIN = join(ROOT, 'com.narlei.broadlink.ulanziPlugin');
const OUT = join(ROOT, 'resources');
const TMP = join(ROOT, 'tools', '.build');

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

// Store-wide visual system (see the Disk Status art). The per-product accent is
// the plugin's own infrared orange; the headline gradient stays green→cyan→blue
// so every plugin's page reads as part of the same store.
const ACCENT = '#ff8a3d';
const GRADIENT = 'linear-gradient(90deg,#3ecf6b 0%,#22d3ee 55%,#4772fa 100%)';

const svg = (name) => readFileSync(join(PLUGIN, 'resources', name), 'utf8');
const dataUrl = (name) => `data:image/svg+xml;base64,${Buffer.from(svg(name)).toString('base64')}`;

const ICON = dataUrl('icon.svg');
const TOGGLE_ON = dataUrl('toggle-on.svg');
const TOGGLE_OFF = dataUrl('toggle-off.svg');

const BASE = `
  * { margin:0; padding:0; box-sizing:border-box; }
  body {
    font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;
    background:linear-gradient(135deg,#0a0e1a 0%,#0d1117 100%);
    color:#fff; overflow:hidden; position:relative;
  }
  body::before {
    content:''; position:absolute; inset:0;
    background:radial-gradient(circle at 14% 10%, rgba(46,86,170,0.38) 0%, rgba(46,86,170,0) 55%);
  }
  .wrap { position:relative; width:100%; height:100%; }
  .grad {
    background:${GRADIENT};
    -webkit-background-clip:text; background-clip:text; color:transparent;
  }
  .eyebrow {
    display:flex; align-items:center; gap:16px;
    font-size:32px; font-weight:700; letter-spacing:6px; color:#9aa2b4;
  }
  .eyebrow i { width:14px; height:14px; border-radius:50%; background:${ACCENT}; }
  .checks { display:flex; flex-direction:column; gap:34px; }
  .check { display:flex; align-items:center; gap:24px; }
  .check .box {
    width:44px; height:44px; border-radius:12px; flex:none;
    background:rgba(255,138,61,0.14); border:2px solid ${ACCENT};
    display:flex; align-items:center; justify-content:center;
  }
  .check .box svg { width:24px; height:24px; }
  .check span { font-size:40px; font-weight:600; color:#e6e9f0; }
  .key {
    background:#0e0e12; border:1px solid rgba(255,255,255,0.07);
    display:flex; align-items:center; justify-content:center;
  }
  .key img { width:88%; height:88%; border-radius:14%; }
  .card {
    background:#15181f; border:1px solid rgba(255,255,255,0.07);
    border-radius:30px; padding:38px 30px 34px; text-align:center; position:relative;
    display:flex; flex-direction:column; align-items:center;
    height:500px; justify-content:flex-start;
  }
  .card .title { white-space:nowrap; }
  .card .bar { position:absolute; top:0; left:26px; right:26px; height:6px; border-radius:0 0 4px 4px; }
  .card .title { font-size:40px; font-weight:800; margin-top:26px; }
  .card .sub { font-size:30px; font-weight:600; color:#8b93a7; margin-top:10px; }
`;

const CHECK_SVG = `<svg viewBox="0 0 24 24" fill="none"><path d="M5 12.5 L10 17.5 L19 7" stroke="${ACCENT}" stroke-width="3.4" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

/* ------------------------------------------------------------------ cover */
const cover = `<!doctype html><meta charset="utf-8"><style>
  ${BASE}
  body { width:1600px; height:800px; }
  .head { position:absolute; left:90px; top:150px; display:flex; align-items:center; gap:34px; }
  .head .halo { position:relative; width:120px; height:120px; flex:none; }
  .head .halo::after {
    content:''; position:absolute; inset:-14px; border-radius:34px;
    background:${ACCENT}; opacity:0.45; filter:blur(22px); z-index:0;
  }
  .head .halo img { position:relative; z-index:1; width:120px; height:120px; border-radius:29px; }
  .head h1 { font-size:60px; font-weight:800; letter-spacing:-1px; }
  .head p { font-size:26px; font-weight:600; color:#8b93a7; margin-top:6px; }
  .copy { position:absolute; left:90px; top:330px; }
  .copy h2 { font-size:88px; font-weight:800; line-height:1.06; letter-spacing:-2px; }
  .copy .sub { font-size:32px; font-weight:500; color:#aeb6c6; margin-top:22px; }
  .pills { position:absolute; left:90px; top:600px; display:flex; gap:22px; }
  .pill {
    height:56px; padding:0 28px; border-radius:28px; display:flex; align-items:center;
    background:rgba(255,255,255,0.06); border:1px solid rgba(255,255,255,0.10);
    font-size:28px; font-weight:600; color:#d3d8e3;
  }
  .deck {
    position:absolute; left:900px; top:190px; width:610px; height:430px;
    background:#141414; border-radius:28px; padding:26px 30px;
  }
  .deck .brand {
    text-align:center; font-size:26px; font-weight:700; letter-spacing:8px; color:#6f7480; margin-bottom:22px;
  }
  .grid { display:grid; grid-template-columns:repeat(4,1fr); gap:18px; }
  .grid .key { width:100%; aspect-ratio:1; border-radius:18px; }
  .cap { font-size:17px; font-weight:700; color:#cfd5e0; margin-top:6px; text-align:center; }
  .cell { display:flex; flex-direction:column; }
</style><div class="wrap">
  <div class="head">
    <div class="halo"><img src="${ICON}"></div>
    <div><h1>Broadlink IR/RF</h1><p>UlanziDeck · macOS · Windows</p></div>
  </div>
  <div class="copy">
    <h2>Any remote.<br><span class="grad">One key away.</span></h2>
    <div class="sub">IR and RF 433MHz — all on your network.</div>
  </div>
  <div class="pills">
    <div class="pill">Learn from your remote</div>
    <div class="pill">No account</div>
    <div class="pill">No cloud</div>
  </div>
  <div class="deck">
    <div class="brand">U · S T U D I O</div>
    <div class="grid">
      <div class="cell"><div class="key"><img src="${TOGGLE_ON}"></div><div class="cap">Bedroom</div></div>
      <div class="cell"><div class="key"><img src="${TOGGLE_OFF}"></div><div class="cap">Fan</div></div>
      <div class="cell"><div class="key"><img src="${ICON}"></div><div class="cap">Projector</div></div>
      <div class="cell"><div class="key"></div></div>
      <div class="cell"><div class="key"></div></div>
      <div class="cell"><div class="key"></div></div>
      <div class="cell"><div class="key"></div></div>
      <div class="cell"><div class="key"></div></div>
    </div>
  </div>
</div>`;

/* --------------------------------------------------------------- banner 1 */
// Fixed height so a longer title can never push one card taller than its
// neighbours; titles stay short enough not to wrap in the first place.
const card = (bar, img, title, sub, { placeholder = '', keyLabel = '' } = {}) => `
  <div class="card">
    <div class="bar" style="background:${bar}"></div>
    <div class="key" style="width:236px;height:236px;border-radius:34px;flex-direction:column;gap:6px">
      ${
        img
          ? `<img src="${img}" style="width:${keyLabel ? '74%' : '88%'};height:auto">
             ${keyLabel ? `<div style="font-size:24px;font-weight:700;color:#e6e9f0">${keyLabel}</div>` : ''}`
          : `<div style="color:#5a6069;font-size:26px;font-weight:700">${placeholder}</div>`
      }
    </div>
    <div class="title">${title}</div>
    <div class="sub">${sub}</div>
  </div>`;

const banner1 = `<!doctype html><meta charset="utf-8"><style>
  ${BASE}
  body { width:2400px; height:1600px; }
  .left { position:absolute; left:130px; top:300px; width:920px; }
  .left h2 { font-size:118px; font-weight:800; line-height:1.05; letter-spacing:-3px; margin-top:52px; }
  .left .body { font-size:42px; font-weight:500; line-height:1.5; color:#aeb6c6; margin-top:56px; }
  .checks { position:absolute; left:130px; top:1090px; }
  .grid2 { position:absolute; left:1150px; top:270px; display:grid; grid-template-columns:repeat(3,360px); gap:38px; }
</style><div class="wrap">
  <div class="left">
    <div class="eyebrow"><i></i>ONE KEY, TWO CODES</div>
    <h2>Two buttons.<br><span class="grad">One key.</span></h2>
    <div class="body">A lamp with separate on and off remotes used to
    cost you two keys. Toggle holds both codes and sends
    whichever one it did not send last.</div>
  </div>
  <div class="checks">
    <div class="check"><div class="box">${CHECK_SVG}</div><span>Key art shows on or off</span></div>
    <div class="check"><div class="box">${CHECK_SVG}</div><span>Flips only once the send lands</span></div>
    <div class="check"><div class="box">${CHECK_SVG}</div><span>IR or RF in either slot</span></div>
  </div>
  <div class="grid2">
    ${card('#4772fa', null, 'Not set up', 'pick a device', { placeholder: 'setup' })}
    ${card(ACCENT, TOGGLE_ON, 'Toggle · on', 'lit while on')}
    ${card('#6b7280', TOGGLE_OFF, 'Toggle · off', 'dark while off')}
    ${card(ACCENT, TOGGLE_ON, 'RF', '433 · 315MHz', { keyLabel: 'Bedroom' })}
    ${card('#3ecf6b', ICON, 'IR', 'every RM model', { keyLabel: 'Air con' })}
    ${card('#22d3ee', ICON, 'Named', 'label on the key', { keyLabel: 'Projector' })}
  </div>
</div>`;

/* --------------------------------------------------------------- banner 2 */
const row = (label, note, selected) => `
  <div style="display:flex;align-items:center;gap:14px;padding:18px 22px;border-radius:10px;
              ${selected ? 'background:rgba(255,138,61,0.16);' : ''}">
    <span style="flex:1;font-size:30px;font-weight:${selected ? 700 : 500};
                 color:${selected ? '#ffb067' : '#e9eef5'}">${label}</span>
    ${note ? `<span style="font-size:24px;color:#8b93a7">${note}</span>` : ''}
  </div>`;

const banner2 = `<!doctype html><meta charset="utf-8"><style>
  ${BASE}
  body { width:2400px; height:1600px; }
  .left { position:absolute; left:130px; top:300px; width:900px; }
  .left h2 { font-size:118px; font-weight:800; line-height:1.05; letter-spacing:-3px; margin-top:52px; }
  .left .body { font-size:42px; font-weight:500; line-height:1.5; color:#aeb6c6; margin-top:56px; }
  .checks { position:absolute; left:130px; top:1090px; }
  .win {
    position:absolute; left:1150px; top:250px; width:1120px; height:1100px;
    background:#1e1f22; border-radius:26px; overflow:hidden;
    box-shadow:0 30px 80px rgba(0,0,0,0.5);
  }
  .win .bar {
    height:78px; background:#26272b; display:flex; align-items:center; padding:0 26px; gap:12px;
  }
  .win .bar .dot { width:18px; height:18px; border-radius:50%; }
  .win .bar .t { flex:1; text-align:center; font-size:28px; font-weight:700; color:#9aa2b4; margin-left:-60px; }
  .win .content { padding:34px 40px; }
  .fl { font-size:26px; font-weight:600; color:#9aa2b4; margin-bottom:12px; }
  .ctl {
    height:74px; border-radius:12px; background:#18191b; border:1px solid rgba(255,255,255,0.14);
    display:flex; align-items:center; padding:0 22px; font-size:30px; color:#e9eef5;
  }
  .ctl.focus { border-color:${ACCENT}; }
  .menu { margin-top:12px; background:#23252a; border:1px solid rgba(255,255,255,0.16); border-radius:12px; padding:8px; }
  .slot {
    margin-top:26px; padding:24px 26px; border-radius:16px;
    background:rgba(255,255,255,0.04); border:1px solid rgba(255,255,255,0.10);
  }
  .slot.on { border-color:rgba(255,138,61,0.45); }
  .slot .h { display:flex; justify-content:space-between; align-items:baseline; margin-bottom:18px; }
  .slot .n { font-size:26px; font-weight:700; letter-spacing:2px; }
  .slot.on .n { color:#ffb067; }
  .slot .c { font-size:24px; color:#8b93a7; font-family:ui-monospace,Menlo,monospace; }
  .btns { display:flex; gap:14px; }
  .btn {
    flex:1; height:62px; border-radius:10px; border:1px solid #00ffe6; color:#00ffe6;
    display:flex; align-items:center; justify-content:center; font-size:26px; font-weight:600;
  }
  .btn.work { background:rgba(0,255,230,0.22); }
  .btn.dim { opacity:0.4; }
  .status {
    margin-top:26px; padding:22px 24px; border-radius:12px; font-size:28px; line-height:1.45;
    white-space:pre-line; color:#d8f5ef;
    background:rgba(45,212,191,0.12); border:1px solid rgba(45,212,191,0.4);
  }
</style><div class="wrap">
  <div class="left">
    <div class="eyebrow"><i></i>LEARN FROM YOUR REMOTE</div>
    <h2>Point. Press.<br><span class="grad">Captured.</span></h2>
    <div class="body">Aim the original remote at the Broadlink and press
    its button. The code is stored with that key —
    and you can fire it before ever touching the deck.</div>
  </div>
  <div class="checks">
    <div class="check"><div class="box">${CHECK_SVG}</div><span>Finds your devices on the network</span></div>
    <div class="check"><div class="box">${CHECK_SVG}</div><span>Manual IP for segmented networks</span></div>
    <div class="check"><div class="box">${CHECK_SVG}</div><span>Guided two-step RF capture</span></div>
  </div>
  <div class="win">
    <div class="bar">
      <div class="dot" style="background:#ff5f57"></div>
      <div class="dot" style="background:#febc2e"></div>
      <div class="dot" style="background:#28c840"></div>
      <div class="t">Toggle On/Off</div>
    </div>
    <div class="content">
      <div class="fl">Broadlink device</div>
      <div class="ctl focus">RM4 Pro Quarto — 192.168.68.109</div>
      <div class="menu">
        ${row('RM4 Pro Quarto — 192.168.68.109', '', true)}
        ${row('BroadLink Sala — 192.168.68.108', 'IR only')}
        ${row('RM mini 3 — 192.168.68.146', 'IR only')}
      </div>
      <div class="slot on">
        <div class="h"><span class="n">ON</span><span class="c">RF · 187 bytes</span></div>
        <div class="btns"><div class="btn dim">Learn IR</div><div class="btn work">Learn RF</div><div class="btn dim">Test</div></div>
      </div>
      <div class="slot">
        <div class="h"><span class="n">OFF</span><span class="c">RF · 187 bytes</span></div>
        <div class="btns"><div class="btn dim">Learn IR</div><div class="btn dim">Learn RF</div><div class="btn dim">Test</div></div>
      </div>
      <div class="status">Locked on 433.86 MHz.
Let go of the button, then hit the button below.</div>
      <div class="btns" style="margin-top:22px">
        <div class="btn" style="border-color:#00ffe6">I let go — capture now</div>
        <div class="btn dim" style="flex:0 0 240px">Cancel</div>
      </div>
    </div>
  </div>
</div>`;

/* ------------------------------------------------------------------ build */
if (!existsSync(CHROME)) {
  console.error(`Chrome not found at ${CHROME} — needed to rasterize.`);
  process.exit(1);
}
mkdirSync(OUT, { recursive: true });
mkdirSync(TMP, { recursive: true });

const jobs = [
  ['cover', cover, 1600, 800],
  ['banner1', banner1, 2400, 1600],
  ['banner2', banner2, 2400, 1600],
];

for (const [name, html, w, h] of jobs) {
  const src = join(TMP, `${name}.html`);
  const png = join(OUT, `${name}.png`);
  writeFileSync(src, html);
  execFileSync(CHROME, [
    '--headless',
    '--disable-gpu',
    '--no-sandbox',
    '--hide-scrollbars',
    '--force-device-scale-factor=1',
    `--window-size=${w},${h}`,
    `--screenshot=${png}`,
    `file://${src}`,
  ], { stdio: 'ignore' });
  console.log(`✓ ${png}`);
}

rmSync(TMP, { recursive: true, force: true });
console.log('\nDone. Check dimensions with: sips -g pixelWidth -g pixelHeight resources/*.png');
