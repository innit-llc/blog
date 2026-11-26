// Share images (og:image, 1200x630 PNG): one per article from its title and
// the facts of its "The decision" section, one for the index from the site
// description and the newest titles. Each is an HTML page rendered by a
// headless Chromium; no Node dependency. The browser is found in the
// Playwright cache (~/.cache/ms-playwright) or named by WOLFBOY_CHROME.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { escapeHtml, noBreakHyphens } from './markdown.mjs';

export const SHARE_W = 1200;
export const SHARE_H = 630;
// dev.to crops a cover image to 1000x420, so covers are made at that size.
export const COVER_W = 1000;
export const COVER_H = 420;

export function findChrome() {
  if (process.env.WOLFBOY_CHROME) return process.env.WOLFBOY_CHROME;
  const base = path.join(os.homedir(), '.cache', 'ms-playwright');
  const found = [];
  const rev = (d) => Number((/-(\d+)$/.exec(d) || [0, 0])[1]);
  const dirs = fs.existsSync(base) ? fs.readdirSync(base) : [];
  for (const d of dirs.sort((a, b) => rev(b) - rev(a))) {
    for (const rel of ['chrome-headless-shell-linux64/chrome-headless-shell', 'chrome-headless-shell-linux/chrome-headless-shell',
      'chrome-linux64/chrome', 'chrome-linux/chrome']) {
      const p = path.join(base, d, rel);
      if (d.startsWith('chromium') && fs.existsSync(p)) found.push(p);
    }
  }
  if (!found.length) throw new Error(`no headless Chromium found under ${base}; set WOLFBOY_CHROME to a Chromium binary`);
  return found[0];
}

// No grain here (unlike the pages): it is invisible at share size and makes
// each PNG several times larger.
// brand: { strong, rest } wordmark parts; host: the site's address as text;
// title: plain text; sheetHead: plain text or ''; rows: HTML strings.
// A currency code keeps its amount on the same line (a no-break space, in the
// image only); a hyphenated word in the title never breaks at its hyphen (the
// no-wrap span of markdown.mjs). Rows that are titles come wrapped by the caller.
export function shareHtml({ fontFile, brand, host, title, titleSize, rowSize = 23, sheetHead, rows, w = SHARE_W, h = SHARE_H }) {
  const font = fs.readFileSync(fontFile).toString('base64');
  const head = sheetHead ? `<div class="sh">${escapeHtml(sheetHead)}</div>` : '';
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8" />
<style>
@font-face { font-family: "Schibsted Grotesk"; font-weight: 400 900; src: url(data:font/woff2;base64,${font}) format("woff2"); }
html, body { margin: 0; width: ${w}px; height: ${h}px; overflow: hidden; }
body { position: relative; color: #ebe4d3; font-family: "Schibsted Grotesk", "DejaVu Sans", sans-serif; -webkit-font-smoothing: antialiased;
  background: radial-gradient(1300px 820px at 70% 6%, #1d1915, #141210 56%, #0e0d0c); }
body::before { content: ""; position: absolute; inset: 0; background: radial-gradient(820px 520px at 38% 26%, rgba(235, 228, 211, .07), rgba(235, 228, 211, 0) 70%); }
.frame { position: absolute; z-index: 1; left: ${h < 500 ? 60 : 72}px; right: ${h < 500 ? 60 : 72}px; top: ${h < 500 ? 44 : 58}px; bottom: ${h < 500 ? 44 : 58}px; display: flex; flex-direction: column; }
.brand { flex: none; display: flex; align-items: center; justify-content: space-between; font-size: 26px; line-height: 1; letter-spacing: -.01em; }
.wm { display: inline-flex; align-items: center; gap: 16px; color: #9c9483; }
.wm::before { content: ""; width: 4px; height: 25px; background: #f0d24e; }
.wm b { font-weight: 600; color: #ebe4d3; }
.host { font-size: 20px; color: #9c9483; }
.title { flex: 1 1 auto; min-height: 0; margin-top: 40px; overflow: hidden; }
.cover .title { display: flex; align-items: center; margin-top: 12px; }
h1 { margin: 0; max-width: 1010px; font-weight: 700; font-size: ${titleSize}px; line-height: 1.07; letter-spacing: -.028em; text-wrap: balance; }
.sheet { flex: none; position: relative; margin-top: 26px; background: #ebe4d3; color: #171511; padding: 18px 30px 6px;
  box-shadow: 0 24px 60px -24px rgba(0, 0, 0, .8), 0 1px 0 rgba(0, 0, 0, .5); }
.sh { font-size: 18px; font-weight: 600; line-height: 1.3; padding-bottom: 12px; border-bottom: 1px solid #171511; }
.row { font-size: ${rowSize}px; line-height: 1.3; padding: 13px 0 14px; border-bottom: 1px solid rgba(23, 21, 17, .16); }
.row:last-child { border-bottom: 0; }
.row b { font-weight: 600; }
.nw { white-space: nowrap; }
</style></head>
<body class="${rows.length ? '' : 'cover'}"><div class="frame">
<div class="brand"><span class="wm"><b>${escapeHtml(brand.strong)}</b>${brand.rest ? ` ${escapeHtml(brand.rest)}` : ''}</span><span class="host">${escapeHtml(host)}</span></div>
<div class="title"><h1>${noBreakHyphens(escapeHtml(title).replace(/\b([A-Z]{3}) (?=\d)/g, '$1\u00a0'))}</h1></div>
${rows.length ? `<div class="sheet">${head}${rows.map((r) => `<div class="row">${r}</div>`).join('')}</div>` : ''}
</div>
<script>
document.fonts.ready.then(function () {
  var box = document.querySelector('.title'), h = document.querySelector('h1');
  var size = parseFloat(getComputedStyle(h).fontSize);
  while (box.scrollHeight > box.clientHeight + 1 && size > 34) { size -= 2; h.style.fontSize = size + 'px'; }
  document.documentElement.setAttribute('data-fit', String(size));
});
</script>
</body></html>
`;
}

// Renders each { html, out, w?, h? } job to a PNG of exactly that size (default SHARE_W x SHARE_H).
export function renderShareImages(jobs) {
  if (!jobs.length) return;
  const chrome = findChrome();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wolfboy-share-'));
  try {
    jobs.forEach((job, i) => {
      const page = path.join(tmp, `share-${i}.html`);
      fs.writeFileSync(page, job.html);
      fs.mkdirSync(path.dirname(job.out), { recursive: true });
      fs.rmSync(job.out, { force: true });
      execFileSync(chrome, ['--headless', '--no-sandbox', '--disable-gpu', '--hide-scrollbars', '--force-device-scale-factor=1',
        `--window-size=${job.w || SHARE_W},${job.h || SHARE_H}`, '--virtual-time-budget=4000', `--screenshot=${job.out}`, pathToFileURL(page).href],
      { stdio: 'pipe', timeout: 60000 });
      if (!fs.existsSync(job.out)) throw new Error(`share image not written: ${job.out}`);
    });
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}
