// Render the cover images for an article from its front matter.
// Usage: node scripts/make-cover.mjs <slug> [<slug> ...]   (or --all)
// Writes src/assets/images/covers/<slug>.jpg (1200x675: article header, cards,
// social previews) and <slug>-feature.jpg (960x720: the homepage feature panel,
// which already shows the title, so it carries the artwork only).
// Artwork, in order of preference:
//   coverLogos: "aws, google-cloud"  product logos from scripts/cover-logos.json
//   an animated diagram embedded in the post (a frame of it)
//   coverMotif: gpu | queue | ...    or the topic's default illustration
import { chromium } from 'playwright';
import { readFile, readdir, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const outDir = path.join(root, 'src/assets/images/covers');
const logoLib = JSON.parse(await readFile(path.join(root, 'scripts/cover-logos.json'), 'utf8'));

const themes = {
  'Kubernetes': { bg: 'linear-gradient(135deg,#0f2a4a 0%,#1d4f8c 100%)', accent: '#7cc4ff', chip: '#c4e4ff', motif: 'kubernetes' },
  'Cloud Security': { bg: 'linear-gradient(135deg,#0d1b2a 0%,#1f3b57 100%)', accent: '#ffac91', chip: '#ffd9cc', motif: 'security' },
  'Cloud Networking': { bg: 'linear-gradient(135deg,#0b3530 0%,#127566 100%)', accent: '#83dfcc', chip: '#c9f0e6', motif: 'network' },
  'Cloud & DevOps': { bg: 'linear-gradient(135deg,#3a2306 0%,#9a5a12 100%)', accent: '#ffd28a', chip: '#ffe0a1', motif: 'pipeline' },
  'AI Engineering': { bg: 'linear-gradient(135deg,#1e0b33 0%,#6b2a8f 100%)', accent: '#f5b8ff', chip: '#f6dcff', motif: 'terminal' },
  'Terraform': { bg: 'linear-gradient(135deg,#2a1552 0%,#5b33a8 100%)', accent: '#cdb6ff', chip: '#e9e0ff', motif: 'plan' },
  'Career & Learning': { bg: 'linear-gradient(135deg,#4a1e12 0%,#a24a30 100%)', accent: '#ffd4c5', chip: '#ffe6dc', motif: 'path' }
};

const motifs = {
  kubernetes: a => `<svg viewBox="0 0 400 400" width="400" height="400"><g fill="none" stroke="${a}" stroke-width="3">
    ${[[200,90],[290,145],[290,255],[200,310],[110,255],[110,145]].map(([x,y],i)=>`<polygon points="${hex(x,y,44)}" opacity="${i%2?0.55:1}"/>`).join('')}
    <polygon points="${hex(200,200,58)}" stroke-width="5"/></g>
    <circle cx="200" cy="200" r="16" fill="${a}"/>
    ${[[200,90],[290,145],[290,255],[200,310],[110,255],[110,145]].map(([x,y])=>`<line x1="200" y1="200" x2="${x}" y2="${y}" stroke="${a}" stroke-width="2" opacity=".5" stroke-dasharray="4 6"/>`).join('')}</svg>`,
  security: a => `<svg viewBox="0 0 400 400" width="400" height="400"><g fill="none" stroke="${a}" stroke-width="4" stroke-linejoin="round">
    <path d="M200 60 L310 105 V200 C310 270 260 320 200 345 C140 320 90 270 90 200 V105 Z"/>
    <path d="M200 95 L280 128 V200 C280 252 245 290 200 310 C155 290 120 252 120 200 V128 Z" opacity=".45"/></g>
    <rect x="160" y="190" width="80" height="62" rx="8" fill="${a}"/><path d="M175 190 v-22 a25 25 0 0 1 50 0 v22" fill="none" stroke="${a}" stroke-width="8"/>
    <circle cx="200" cy="216" r="8" fill="#0d1b2a"/><rect x="196" y="218" width="8" height="18" fill="#0d1b2a"/></svg>`,
  network: a => { const n=[[80,90],[210,60],[330,120],[120,220],[260,230],[90,330],[220,340],[340,300]];
    const e=[[0,1],[1,2],[0,3],[1,4],[2,4],[3,4],[3,5],[4,6],[4,7],[5,6],[6,7],[2,7]];
    return `<svg viewBox="0 0 400 400" width="400" height="400">${e.map(([i,j])=>`<line x1="${n[i][0]}" y1="${n[i][1]}" x2="${n[j][0]}" y2="${n[j][1]}" stroke="${a}" stroke-width="2.5" opacity=".55"/>`).join('')}
    ${n.map(([x,y],i)=>`<circle cx="${x}" cy="${y}" r="${i===4?22:13}" fill="${i===4?a:'none'}" stroke="${a}" stroke-width="3"/>`).join('')}</svg>`; },
  pipeline: a => `<svg viewBox="0 0 400 400" width="400" height="400"><g stroke="${a}" stroke-width="3" fill="none">
    ${[70,170,270].map((y,i)=>`<rect x="${40+i*30}" y="${y}" width="200" height="64" rx="12" opacity="${1-i*0.2}"/>`).join('')}
    <path d="M240 102 C320 102 320 202 270 202" /><path d="M270 202 C350 202 350 302 300 302"/></g>
    ${[70,170,270].map((y,i)=>`<circle cx="${72+i*30}" cy="${y+32}" r="10" fill="${a}"/><rect x="${95+i*30}" y="${y+26}" width="${110-i*15}" height="12" rx="6" fill="${a}" opacity=".6"/>`).join('')}</svg>`,
  plan: a => `<svg viewBox="0 0 400 400" width="400" height="400"><rect x="30" y="50" width="340" height="300" rx="14" fill="#00000033" stroke="${a}" stroke-width="2"/>
    ${[['+','#8ff0b0',200],['~','#ffd28a',160],['-','#ff9a9a',120],['+','#8ff0b0',230],['~','#ffd28a',90],['+','#8ff0b0',180]].map(([s,c,w],i)=>`<text x="60" y="${105+i*42}" fill="${c}" font-family="ui-monospace,Menlo,monospace" font-size="26" font-weight="700">${s}</text><rect x="95" y="${86+i*42}" width="${w}" height="18" rx="9" fill="${c}" opacity=".75"/>`).join('')}</svg>`,
  gpu: a => `<svg viewBox="0 0 400 400" width="400" height="400"><rect x="90" y="90" width="220" height="220" rx="18" fill="none" stroke="${a}" stroke-width="4"/>
    <rect x="140" y="140" width="120" height="120" rx="10" fill="${a}" opacity=".9"/><text x="200" y="212" text-anchor="middle" font-family="ui-monospace,Menlo,monospace" font-size="34" font-weight="700" fill="#0f2a4a">GPU</text>
    ${[120,160,200,240,280].map(x=>`<line x1="${x}" y1="60" x2="${x}" y2="90" stroke="${a}" stroke-width="4"/><line x1="${x}" y1="310" x2="${x}" y2="340" stroke="${a}" stroke-width="4"/><line x1="60" y1="${x}" x2="90" y2="${x}" stroke="${a}" stroke-width="4"/><line x1="310" y1="${x}" x2="340" y2="${x}" stroke="${a}" stroke-width="4"/>`).join('')}</svg>`,
  queue: a => `<svg viewBox="0 0 400 400" width="400" height="400">${[0,1,2,3,4,5].map(i=>`<rect x="${40+i*48}" y="170" width="36" height="60" rx="8" fill="${a}" opacity="${0.35+i*0.13}"/>`).join('')}
    <path d="M340 200 h30 m-12 -12 l12 12 l-12 12" stroke="${a}" stroke-width="4" fill="none"/>
    <rect x="40" y="270" width="320" height="14" rx="7" fill="#ffffff22"/><rect x="40" y="270" width="230" height="14" rx="7" fill="${a}"/>
    <text x="40" y="140" font-family="ui-monospace,Menlo,monospace" font-size="22" fill="${a}">requests waiting: 6</text></svg>`,
  terminal: a => `<svg viewBox="0 0 400 400" width="400" height="400"><rect x="30" y="70" width="340" height="260" rx="16" fill="#00000055" stroke="${a}" stroke-width="2"/>
    <circle cx="58" cy="96" r="7" fill="#ff8a8a"/><circle cx="80" cy="96" r="7" fill="#ffd28a"/><circle cx="102" cy="96" r="7" fill="#8ff0b0"/>
    <text x="56" y="150" font-family="ui-monospace,Menlo,monospace" font-size="24" fill="${a}">&gt; plan the change</text>
    ${[[56,180,220],[56,210,170],[56,240,250]].map(([x,y,w])=>`<rect x="${x}" y="${y}" width="${w}" height="12" rx="6" fill="${a}" opacity=".45"/>`).join('')}
    <text x="56" y="295" font-family="ui-monospace,Menlo,monospace" font-size="24" fill="#8ff0b0">✓ tests pass</text></svg>`,
  bars: a => `<svg viewBox="0 0 400 400" width="400" height="400">${[[60,230],[120,280],[180,250],[240,300],[300,210]].map(([x,h],i)=>`<rect x="${x}" y="${340-h}" width="44" height="${h}" rx="6" fill="${a}" opacity="${0.4+i*0.12}"/>`).join('')}
    <line x1="40" y1="340" x2="370" y2="340" stroke="${a}" stroke-width="3"/></svg>`,
  path: a => `<svg viewBox="0 0 400 400" width="400" height="400"><path d="M60 330 C140 330 120 230 200 230 S260 130 340 120" fill="none" stroke="${a}" stroke-width="5" stroke-dasharray="2 12" stroke-linecap="round"/>
    ${[[60,330],[200,230],[340,120]].map(([x,y],i)=>`<circle cx="${x}" cy="${y}" r="${16+i*6}" fill="${i===2?a:'none'}" stroke="${a}" stroke-width="4"/>`).join('')}</svg>`
};

function hex(cx, cy, r) {
  return Array.from({ length: 6 }, (_, i) => { const t = Math.PI / 3 * i - Math.PI / 6; return `${(cx + r * Math.cos(t)).toFixed(1)},${(cy + r * Math.sin(t)).toFixed(1)}`; }).join(' ');
}
const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function frontMatter(text) {
  const block = text.match(/^---\n([\s\S]*?)\n---/)[1];
  const data = {};
  for (const line of block.split('\n')) {
    const m = line.match(/^(\w+):\s*(.*)$/);
    if (!m) continue;
    let v = m[2].trim();
    if (v.startsWith('"') && v.endsWith('"')) v = JSON.parse(v);
    data[m[1]] = v;
  }
  return data;
}

function logo(key, size) {
  const l = logoLib[key];
  if (!l) throw new Error(`Unknown cover logo "${key}". Add it to scripts/cover-logos.json`);
  return `<svg viewBox="0 0 ${l.width} ${l.height}" width="${size}" height="${size}" preserveAspectRatio="xMidYMid meet">${l.body}</svg>`;
}

// Logo tiles joined by glowing links: one, two or three logos.
function logoStage(keys, accent, W, H) {
  const tile = { 1: 250, 2: 178, 3: 150 }[keys.length];
  if (!tile) throw new Error('coverLogos takes one to three logos');
  const pos = { 1: [[W / 2, H / 2]], 2: [[W * 0.2, H * 0.5], [W * 0.8, H * 0.5]],
    3: [[W / 2, H * 0.24], [W * 0.18, H * 0.76], [W * 0.82, H * 0.76]] }[keys.length];
  const pairs = keys.length === 2 ? [[0, 1]] : keys.length === 3 ? [[0, 1], [1, 2], [2, 0]] : [];
  const links = pairs.map(([a, b]) => {
    const [x1, y1] = pos[a], [x2, y2] = pos[b];
    const dots = [0.36, 0.5, 0.64].map((t, n) => `<circle cx="${x1 + (x2 - x1) * t}" cy="${y1 + (y2 - y1) * t}" r="${n === 1 ? 9 : 6}" fill="${accent}"/>`).join('');
    return `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${accent}" stroke-width="14" opacity=".18" stroke-linecap="round"/>
      <line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${accent}" stroke-width="3" stroke-dasharray="10 9" stroke-linecap="round"/>${dots}`;
  }).join('');
  const rings = keys.length === 1 ? [1.25, 1.55, 1.85].map((k, n) => `<circle cx="${W / 2}" cy="${H / 2}" r="${tile / 2 * k}" fill="none" stroke="${accent}" stroke-width="2" opacity="${0.5 - n * 0.14}"/>`).join('') : '';
  const tiles = keys.map((k, n) => `<div class="tile" style="left:${pos[n][0] - tile / 2}px;top:${pos[n][1] - tile / 2}px;width:${tile}px;height:${tile}px">${logo(k, Math.round(tile * 0.62))}</div>`).join('');
  return `<div class="stage" style="width:${W}px;height:${H}px"><svg class="links" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">${rings}${links}</svg>${tiles}</div>`;
}

async function page(slug, variant) {
  const text = await readFile(path.join(root, 'src/posts', slug + '.md'), 'utf8');
  const data = frontMatter(text);
  const theme = themes[data.category];
  if (!theme) throw new Error(`No cover theme for category ${data.category}`);
  const logos = (data.coverLogos || '').split(',').map(s => s.trim()).filter(Boolean);
  const diagram = logos.length ? null : text.match(/src="\/assets\/diagrams\/([\w-]+\.gif)"/)?.[1];
  const label = esc(data.coverLabel || data.title).replace(/\n/g, '<br>');
  const feature = variant === 'feature';
  const [W, H] = feature ? [960, 720] : [1200, 675];
  let art;
  if (logos.length) art = feature ? `<div class="art-center">${logoStage(logos, theme.accent, 640, 430)}</div>` : `<div class="art-right">${logoStage(logos, theme.accent, 480, 470)}</div>`;
  else if (diagram) art = `<div class="frame${feature ? ' center' : ''}"><img src="data:image/gif;base64,${(await readFile(path.join(root, 'src/assets/diagrams', diagram))).toString('base64')}"></div>`;
  else art = `<div class="motif${feature ? ' center' : ''}">${(motifs[data.coverMotif] || motifs[theme.motif])(theme.accent)}</div>`;
  const kicker = `<span class="kicker">${esc(data.category)}</span>`;
  const code = data.coverCode ? `<div class="code">${esc(data.coverCode)}</div>` : '';
  const brand = `<p class="brand">{c} the code clouds<b>.</b></p>`;
  const copy = feature
    ? `<div class="top">${kicker}</div><div class="bottom">${code}${brand}</div>`
    : `<div class="copy">${kicker}<h1>${label}</h1><div>${code}<div style="margin-top:26px">${brand}</div></div></div>`;
  return { data, diagram, W, H, html: `<!doctype html><html><head><meta charset="utf-8"><style>
    *{box-sizing:border-box;margin:0}
    body{width:${W}px;height:${H}px;overflow:hidden;background:${theme.bg};color:#f4f8fa;font-family:"Inter",system-ui,-apple-system,"Segoe UI",sans-serif;position:relative}
    body:before{content:"";position:absolute;inset:0;background:radial-gradient(circle at 85% 20%,#ffffff1f,transparent 45%),repeating-linear-gradient(0deg,#ffffff08 0 1px,transparent 1px 40px),repeating-linear-gradient(90deg,#ffffff08 0 1px,transparent 1px 40px)}
    .copy{position:absolute;left:72px;top:64px;bottom:64px;width:${diagram || logos.length ? 600 : 640}px;display:flex;flex-direction:column;justify-content:space-between;z-index:2}
    .kicker{display:inline-flex;align-self:flex-start;gap:10px;align-items:center;font:600 18px/1 ui-monospace,Menlo,monospace;letter-spacing:.08em;text-transform:uppercase;color:#0b1a24;background:${theme.chip};padding:10px 16px;border-radius:30px}
    h1{font:500 66px/1.08 Georgia,"Times New Roman",serif;letter-spacing:-1.5px;color:#fff}
    .code{font:500 22px/1.4 ui-monospace,Menlo,monospace;color:${theme.accent};background:#0000004d;border:1px solid #ffffff26;padding:14px 18px;border-radius:10px;align-self:flex-start;display:inline-block;max-width:100%;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .brand{font:600 20px/1 ui-monospace,Menlo,monospace;color:#ffffffcc}.brand b{color:${theme.accent}}
    .top{position:absolute;left:56px;top:48px;z-index:2}
    .bottom{position:absolute;left:56px;right:56px;bottom:44px;display:flex;justify-content:space-between;align-items:center;gap:24px;z-index:2}
    .motif{position:absolute;right:70px;top:137px;opacity:.95}
    .motif.center{right:auto;left:${(W - 400) / 2}px;top:${(H - 400) / 2 - 10}px}
    .frame{position:absolute;right:64px;top:48px;width:420px;height:579px;border-radius:18px;overflow:hidden;background:#fff;box-shadow:0 30px 60px #0007,0 0 0 1px #ffffff40;transform:rotate(2deg)}
    .frame.center{right:auto;left:${(W - 380) / 2}px;top:120px;width:380px;height:470px;transform:rotate(-2deg)}
    .frame img{width:100%;display:block}
    .art-right{position:absolute;right:56px;top:${(H - 470) / 2}px}
    .art-center{position:absolute;left:${(W - 640) / 2}px;top:${(H - 430) / 2 - 6}px}
    .stage{position:relative}.links{position:absolute;inset:0}
    .tile{position:absolute;display:flex;align-items:center;justify-content:center;background:#fff;border-radius:30px;box-shadow:0 24px 50px #00000059,0 0 0 8px #ffffff1f}
  </style></head><body>${copy}${art}</body></html>` };
}

let slugs = process.argv.slice(2);
if (slugs[0] === '--all') {
  slugs = [];
  for (const f of (await readdir(path.join(root, 'src/posts'))).filter(f => f.endsWith('.md'))) {
    const fm = frontMatter(await readFile(path.join(root, 'src/posts', f), 'utf8'));
    if ((fm.coverImage || '').startsWith('/assets/images/covers/')) slugs.push(f.slice(0, -3));
  }
}
if (!slugs.length) { console.error('Usage: node scripts/make-cover.mjs <slug> [...]'); process.exit(1); }
await mkdir(outDir, { recursive: true });
const browser = await chromium.launch();
try {
  for (const slug of slugs) {
    for (const variant of ['cover', 'feature']) {
      const { html, diagram, W, H } = await page(slug, variant);
      const tab = await browser.newPage({ viewport: { width: W, height: H } });
      await tab.setContent(html, { waitUntil: 'load' });
      // Let an animated diagram reach its busiest middle frames before capturing.
      if (diagram) await tab.waitForTimeout(9000);
      const file = path.join(outDir, slug + (variant === 'feature' ? '-feature' : '') + '.jpg');
      await tab.screenshot({ path: file, type: 'jpeg', quality: 82 });
      await tab.close();
      console.log('wrote', path.relative(root, file));
    }
  }
} finally {
  await browser.close();
}
