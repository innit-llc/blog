#!/usr/bin/env node
// Checks run after every build (and runnable alone: node check.mjs <articles-dir>).
// Kept independent of markdown.mjs: code blocks, links and markup are read
// back from the outputs with separate, simpler extractors.

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { SITE, POSTS, PRODUCT_START, PRODUCT_END, AI_LINE, DEVTO_BLOG_LINE, FONT_FILES, DECISION_HEADING, factsHeading, shareFile, coverFile } from './build.mjs';

const SHARE_SIZE = [1200, 630];

// Width and height of a PNG file, or null when the file is not a PNG.
function pngSize(file) {
  const b = fs.readFileSync(file);
  if (b.length < 24 || b.toString('latin1', 0, 8) !== '\x89PNG\r\n\x1a\n' || b.toString('latin1', 12, 16) !== 'IHDR') return null;
  return [b.readUInt32BE(16), b.readUInt32BE(20)];
}

const BLOG_URL = 'https://innit-llc.github.io/blog/';

function unescapeHtml(s) {
  return s.replace(/&(lt|gt|quot|#39|amp);/g, (_, e) =>
    ({ lt: '<', gt: '>', quot: '"', '#39': "'", amp: '&' })[e]);
}

// Fenced code blocks of a Markdown text, exactly as written between the fences.
function mdCodeBlocks(md) {
  const blocks = [];
  const lines = md.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const open = /^(`{3,})/.exec(lines[i]);
    if (!open) continue;
    const body = [];
    for (i++; i < lines.length && !lines[i].startsWith(open[1]); i++) body.push(lines[i]);
    blocks.push(body.length ? body.join('\n') + '\n' : '');
  }
  return blocks;
}

function stripFences(md) {
  return md.replace(/^(`{3,})[^\n]*\n[\s\S]*?^\1`*[ \t]*$/gm, '');
}

function stripCodeSpans(md) {
  return md.replace(/(`+)[\s\S]*?[^`]\1(?!`)/g, '');
}

// URLs written in a Markdown text outside code: [text](url) targets and bare
// URLs, with GFM's trailing punctuation and unbalanced ")" left out.
function mdUrls(md) {
  let text = stripCodeSpans(stripFences(md));
  const urls = [];
  text = text.replace(/\]\((https?:\/\/[^)\s]+)\)/g, (_, u) => { urls.push(u); return ']()'; });
  for (const raw of text.match(/https?:\/\/[^\s<>]+/g) || []) {
    let u = raw;
    for (;;) {
      const before = u;
      u = u.replace(/[.,:;!?'"*_~]+$/, '');
      if (u.endsWith(')') && (u.match(/\)/g) || []).length > (u.match(/\(/g) || []).length) u = u.slice(0, -1);
      if (u === before) break;
    }
    urls.push(u);
  }
  return urls.sort();
}

function htmlHrefs(html) {
  return [...html.matchAll(/<a\s[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/g)]
    .map((m) => ({ href: unescapeHtml(m[1]), text: m[2] }));
}

function htmlCodeBlocks(html) {
  return [...html.matchAll(/<pre><code(?: class="[^"]*")?>([\s\S]*?)<\/code><\/pre>/g)]
    .map((m) => unescapeHtml(m[1]));
}

const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr']);

// Well-formedness: every tag closed in order, attributes quoted and unique,
// no bare "<" and no "&" outside an entity.
function wellFormed(html) {
  const errors = [];
  const stack = [];
  const re = /<!--[\s\S]*?-->|<!DOCTYPE html>|<\/([a-z][a-z0-9-]*)>|<([a-z][a-z0-9-]*)((?:\s+[a-z][a-z0-9:-]*="[^"<]*")*)\s*(\/?)>|<|&(?:[a-z]+|#\d+|#x[0-9a-f]+);|&/gi;
  let m;
  while ((m = re.exec(html))) {
    const tok = m[0];
    if (tok === '<' || tok === '&') { errors.push(`bare "${tok}" at offset ${m.index}`); continue; }
    if (m[1]) {
      const name = m[1].toLowerCase();
      const top = stack.pop();
      if (top !== name) { errors.push(`</${name}> closes <${top}> at offset ${m.index}`); break; }
    } else if (m[2]) {
      const name = m[2].toLowerCase();
      const names = [...m[3].matchAll(/([a-z][a-z0-9:-]*)=/gi)].map((a) => a[1].toLowerCase());
      if (new Set(names).size !== names.length) errors.push(`duplicate attribute on <${name}> at offset ${m.index}`);
      if (VOID.has(name)) continue;
      if (m[4]) { errors.push(`self-closed non-void <${name}/>`); continue; }
      stack.push(name);
    }
  }
  if (stack.length) errors.push(`unclosed: ${stack.join(' > ')}`);
  if (!html.startsWith('<!DOCTYPE html>')) errors.push('missing doctype');
  return errors;
}

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) =>
    d.isDirectory() ? walk(path.join(dir, d.name)) : [path.join(dir, d.name)]);
}

function sameList(a, b) {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

export function runChecks({ articlesDir, siteDir, devtoDir }) {
  const fail = [];
  const files = walk(siteDir);
  const htmlFiles = files.filter((f) => f.endsWith('.html'));
  const rel = (f) => path.relative(siteDir, f);

  if (!fs.existsSync(path.join(siteDir, '.nojekyll'))) fail.push('.nojekyll missing');
  if (!fs.existsSync(path.join(siteDir, 'index.html'))) fail.push('index.html missing');

  // Pages: well-formed, head metadata present, footer, internal links resolve.
  for (const f of htmlFiles) {
    const html = fs.readFileSync(f, 'utf8');
    for (const e of wellFormed(html)) fail.push(`${rel(f)}: ${e}`);
    for (const re of [/<title>[^<]+<\/title>/, /<meta name="description" content="[^"]+" \/>/,
      /<meta property="og:title" content="[^"]+" \/>/, /<meta property="og:description" content="[^"]+" \/>/]) {
      if (!re.test(html)) fail.push(`${rel(f)}: missing ${re.source.slice(0, 30)}`);
    }
    const footer = /<footer class="site"><div class="wrap">([^<]*)<\/div><\/footer>/.exec(html);
    if (!footer || footer[1] !== 'WolfBoy, by INNIT LLC') fail.push(`${rel(f)}: footer is not "WolfBoy, by INNIT LLC"`);
    const og = /<meta property="og:url" content="([^"]+)"/.exec(html);
    if (!og || !og[1].startsWith(BLOG_URL)) fail.push(`${rel(f)}: og:url not under ${BLOG_URL}`);
    else {
      const target = path.join(siteDir, og[1].slice(BLOG_URL.length), 'index.html');
      if (target !== f) fail.push(`${rel(f)}: og:url ${og[1]} does not name this page`);
    }
    // Share image: named once, absolute under the blog URL, the file exists and is a 1200x630 PNG.
    const imgs = [...html.matchAll(/<meta property="og:image" content="([^"]*)" \/>/g)].map((m) => unescapeHtml(m[1]));
    if (imgs.length !== 1) fail.push(`${rel(f)}: expected one og:image, found ${imgs.length}`);
    else if (!imgs[0].startsWith(BLOG_URL)) fail.push(`${rel(f)}: og:image not under ${BLOG_URL}`);
    else {
      const img = path.join(siteDir, imgs[0].slice(BLOG_URL.length));
      const size = img.startsWith(siteDir + path.sep) && fs.existsSync(img) ? pngSize(img) : undefined;
      if (size === undefined) fail.push(`${rel(f)}: og:image ${imgs[0]} has no file`);
      else if (!size || size[0] !== SHARE_SIZE[0] || size[1] !== SHARE_SIZE[1]) {
        fail.push(`${rel(f)}: og:image ${imgs[0]} is ${size ? size.join('x') : 'not a PNG'}, not ${SHARE_SIZE.join('x')}`);
      }
    }
    if (!html.includes(`<meta property="og:image:width" content="${SHARE_SIZE[0]}" />`) ||
        !html.includes(`<meta property="og:image:height" content="${SHARE_SIZE[1]}" />`)) fail.push(`${rel(f)}: og:image width/height not declared`);
    if (!html.includes('<meta name="twitter:card" content="summary_large_image" />')) fail.push(`${rel(f)}: twitter:card is not summary_large_image`);
    const ids = new Set([...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]));
    const refs = [...html.matchAll(/\s(?:href|src)="([^"]*)"/g)].map((m) => unescapeHtml(m[1]));
    for (const ref of refs) {
      if (/^(https?:|mailto:)/.test(ref)) continue;
      const [p, frag] = ref.split('#');
      if (!p) { if (frag && !ids.has(frag)) fail.push(`${rel(f)}: #${frag} has no target`); continue; }
      let target = path.resolve(path.dirname(f), p);
      if (p.endsWith('/') || (fs.existsSync(target) && fs.statSync(target).isDirectory())) target = path.join(target, 'index.html');
      if (!target.startsWith(siteDir + path.sep) || !fs.existsSync(target)) fail.push(`${rel(f)}: internal link ${ref} does not resolve`);
    }
  }

  // Strict XML parse as a second, independent well-formedness check.
  try {
    execFileSync('python3', ['-I', '-c',
      'import sys, xml.dom.minidom as m\nfor f in sys.argv[1:]: m.parse(f)', ...htmlFiles], { stdio: 'pipe' });
  } catch (e) {
    if (e.code === 'ENOENT') fail.push('python3 not found: strict XML well-formedness check not run');
    else fail.push(`strict XML parse failed: ${String(e.stderr).trim().split('\n').pop()}`);
  }

  const index = fs.readFileSync(path.join(siteDir, 'index.html'), 'utf8');
  // Index: the closing repository line, once, so a reader who lands on the index reaches the tool.
  const indexRepo = htmlHrefs(index).filter((l) => l.href === SITE.repo);
  if (indexRepo.length !== 1) fail.push(`index: expected one repository link, found ${indexRepo.length}`);
  for (const post of POSTS) {
    const slug = post.slug;
    const source = fs.readFileSync(path.join(articlesDir, `${slug}.md`), 'utf8');
    const fm = /^---\n[\s\S]*?\n---\n/.exec(source)[0];
    const pageFile = path.join(siteDir, slug, 'index.html');
    const html = fs.readFileSync(pageFile, 'utf8');
    const devto = fs.readFileSync(path.join(devtoDir, `${slug}.md`), 'utf8');

    // Index lists the article with title, description and date.
    const title = JSON.parse(/^title: (".*")$/m.exec(fm)[1]);
    const desc = JSON.parse(/^description: (".*")$/m.exec(fm)[1]);
    const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    if (!index.includes(`<a href="${slug}/">${esc(title)}</a>`)) fail.push(`index: no title link for ${slug}`);
    if (!index.includes(`<p>${esc(desc)}</p>`)) fail.push(`index: no description for ${slug}`);
    if (!index.includes(`<time datetime="${post.date}">`)) fail.push(`index: no date for ${slug}`);

    // Code blocks: blog page and dev.to version byte-identical to the article.
    const srcBlocks = mdCodeBlocks(source);
    if (!srcBlocks.length) fail.push(`${slug}: no code blocks found in the article`);
    if (!sameList(htmlCodeBlocks(html), srcBlocks)) fail.push(`${slug}: blog code blocks differ from the article`);
    if (!sameList(mdCodeBlocks(devto), srcBlocks)) fail.push(`${slug}: dev.to code blocks differ from the article`);

    // External links: same URLs as the article, byte for byte.
    const srcUrls = mdUrls(source);
    const links = htmlHrefs(html).filter((l) => /^https?:/.test(l.href));
    const pageUrls = links.map((l) => l.href);
    const repoCount = pageUrls.filter((u) => u === SITE.repo).length;
    if (repoCount !== 1) fail.push(`${slug}: expected one closing repository link, found ${repoCount}`);
    const pageArticleUrls = pageUrls.filter((u) => u !== SITE.repo).sort();
    if (!sameList(pageArticleUrls, srcUrls)) fail.push(`${slug}: blog external links differ from the article`);
    for (const l of links) {
      if (/^https?:/.test(l.text) && unescapeHtml(l.text) !== l.href) fail.push(`${slug}: link text ${l.text} differs from its href`);
    }
    const devtoUrls = mdUrls(devto);
    const expectDevto = [...mdUrls(source.slice(0, source.indexOf(PRODUCT_START)) +
      source.slice(source.indexOf(PRODUCT_END))), BLOG_URL].sort();
    if (!sameList(devtoUrls, expectDevto)) fail.push(`${slug}: dev.to external links differ from the article plus the blog link`);

    // Canonical link: present, once, exactly when POSTS gives a dev.to URL.
    const canon = [...html.matchAll(/<link rel="canonical" href="([^"]*)" \/>/g)].map((m) => unescapeHtml(m[1]));
    const expectCanon = post.canonical ? [post.canonical] : [];
    if (!sameList(canon, expectCanon) || html.split('rel="canonical"').length - 1 !== expectCanon.length) {
      fail.push(`${slug}: canonical link ${JSON.stringify(canon)} does not match POSTS ${JSON.stringify(expectCanon)}`);
    }
    if (post.canonical && !/^https:\/\/dev\.to\/\S+$/.test(post.canonical)) fail.push(`${slug}: canonical is not a dev.to URL`);

    // dev.to version: front matter kept, no canonical_url, no WolfBoy, wording.
    if (!devto.startsWith(fm)) fail.push(`${slug}: dev.to front matter differs from the article`);
    if (/^canonical_url:/m.test(devto)) fail.push(`${slug}: dev.to has canonical_url`);
    if (!/^published: false$/m.test(devto)) fail.push(`${slug}: dev.to is not published: false`);
    if (/wolfboy/i.test(devto)) fail.push(`${slug}: dev.to version mentions WolfBoy`);
    if (devto.includes('<!--')) fail.push(`${slug}: dev.to version keeps an HTML comment`);
    if (!devto.endsWith(`\n${AI_LINE}\n\n${DEVTO_BLOG_LINE}\n`)) fail.push(`${slug}: dev.to does not end with the AI line and the blog line`);
    if (devto.split(DEVTO_BLOG_LINE).length !== 2) fail.push(`${slug}: dev.to blog line not exactly once`);

    // Blog page: product block kept, AI line worded exactly, no leftover markup.
    const block = source.slice(source.indexOf(PRODUCT_START) + PRODUCT_START.length, source.indexOf(PRODUCT_END)).trim();
    const firstWords = block.split(/\s+/).slice(0, 4).join(' ');
    if (!/<aside class="product-note">[\s\S]*WolfBoy[\s\S]*<\/aside>/.test(html) || !html.includes(esc(firstWords))) {
      fail.push(`${slug}: blog page lost the WolfBoy block`);
    }
    // Case block: the article's own decision section, once, at the head.
    const caseCount = html.split('<section class="case">').length - 1;
    const caseRe = new RegExp(`<section class="case">\\n<h2 id="[^"]+">${factsHeading(post)}</h2>\\n<ul>`);
    if (caseCount !== 1 || !caseRe.test(html)) fail.push(`${slug}: no case block made from "${factsHeading(post)}"`);
    const aiText = AI_LINE.slice(1, -1);
    if (!html.includes(`<p><em>${aiText}</em></p>`)) fail.push(`${slug}: blog AI line not worded exactly`);
    if (html.includes('drafted with AI')) fail.push(`${slug}: blog keeps the old AI line`);
    const prose = html.replace(/<pre>[\s\S]*?<\/pre>/g, '').replace(/<code>[\s\S]*?<\/code>/g, '')
      .replace(/<head>[\s\S]*?<\/head>/, '').replace(/<[^>]+>/g, '');
    for (const leftover of ['`', '](', '**', '<!--', '-->']) {
      if (prose.includes(leftover)) fail.push(`${slug}: unconverted Markdown "${leftover}" in the page text`);
    }
    if (/(^|[^\w])\*(?!\s)/.test(prose)) fail.push(`${slug}: stray "*" in the page text`);
  }

  // The site holds only what the build writes.
  const expected = new Set(['.nojekyll', 'index.html', 'style.css', shareFile(''), ...FONT_FILES.map((f) => `fonts/${f}`),
    ...POSTS.flatMap((p) => [`${p.slug}/index.html`, shareFile(p.slug), coverFile(p.slug)])]);
  for (const f of files) if (!expected.has(rel(f))) fail.push(`unexpected file ${rel(f)}`);
  // dev.to covers: one per post, a 1000x420 PNG (dev.to's crop size).
  for (const p of POSTS) {
    const c = path.join(siteDir, coverFile(p.slug)); const s = fs.existsSync(c) ? pngSize(c) : null;
    if (!s || s[0] !== 1000 || s[1] !== 420) fail.push(`${p.slug}: dev.to cover missing or not 1000x420 (${s})`);
  }
  return fail;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const articlesDir = path.resolve(process.argv[2] || '');
  const here = path.dirname(fileURLToPath(import.meta.url));
  const failures = runChecks({ articlesDir, siteDir: path.join(here, 'docs'), devtoDir: path.join(articlesDir, 'devto') });
  for (const f of failures) console.error(`  - ${f}`);
  console.log(failures.length ? `FAIL: ${failures.length}` : 'all checks passed');
  process.exit(failures.length ? 1 : 0);
}
