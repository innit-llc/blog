#!/usr/bin/env node
// Builds the blog (into ./docs, served by GitHub Pages from the /docs folder)
// and the dev.to versions of the articles (into <articles-dir>/devto/), then
// runs every check in check.mjs. Both outputs are generated; never edit them.
// The blog's stylesheet and fonts are copied from ./assets; the share images
// are rendered by share.mjs with a headless Chromium.
//
// Usage: node build.mjs <articles-dir>
// Node 20 or later. No npm dependencies.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderMarkdown, renderInline, splitFrontMatter, escapeHtml, escapeAttr } from './markdown.mjs';
import { shareHtml, renderShareImages, SHARE_W, SHARE_H, COVER_W, COVER_H } from './share.mjs';
import { runChecks } from './check.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

// Owner-editable wording: site name (its first word is set bold as the
// wordmark), the one-sentence site description (the index heading, meta and
// Open Graph description, and the index share image), footer, and the closing
// line of every article page.
export const SITE = {
  name: 'WolfBoy blog',
  description: 'Real privacy fines and settlements, each followed from the official documents to the code behind it and the fix.',
  publisher: 'WolfBoy, by INNIT LLC',
  repoLine: 'WolfBoy on GitHub:',
  url: 'https://innit-llc.github.io/blog/',
  repo: 'https://github.com/innit-llc/wolfboy',
  repoLabel: 'github.com/innit-llc/wolfboy',
};

// The articles, with the date each is shown under. Newest first on the index;
// equal dates keep this order. `canonical` is the dev.to URL of the post; when
// set, the blog page declares it canonical, because dev.to publishes first.
// The dates and canonical URLs are filled in after the dev.to posts exist.
// `card` picks which items of the article's "The decision" list go on its
// share image, each named by the words the item starts with; the image shows
// the first sentence of each, read from the article at build time.
export const POSTS = [
  { slug: 'loomio-gravatar-301', date: '2026-11-17', canonical: '', factsHead: 'The advisory', card: ['Affected versions', 'Fixed in', 'Severity as published'] },
  { slug: 'consent-withdrawal-link-poland', date: '2026-11-17', canonical: '', card: ['Fine', 'Final'] },
  { slug: 'retention-deadlines-denmark', date: '2026-11-17', canonical: '', card: ['Country', 'Court and date', 'Amount'] },
  { slug: 'health-event-names-to-analytics-sdks-us', date: '2026-11-17', canonical: '', card: ['Who', 'Amount', 'Status'] },
];

// Files copied from ./assets/fonts into the site, and where the share images go.
export const FONT_FILES = [
  'SchibstedGrotesk-normal-400-900-latin.woff2',
  'FragmentMono-normal-400-latin.woff2',
  'LibreCaslonText-normal-400-latin.woff2',
  'LibreCaslonText-italic-400-latin.woff2',
  // latin-ext: Polish and other accented letters in quoted decisions
  'SchibstedGrotesk-normal-400-900-latin-ext.woff2',
  'FragmentMono-normal-400-latin-ext.woff2',
  'LibreCaslonText-normal-400-latin-ext.woff2',
  'LibreCaslonText-italic-400-latin-ext.woff2',
  'OFL.txt',
];
export const DECISION_HEADING = 'The decision';
// The heading of a post's facts box: "The decision" unless the post names another (`factsHead`).
export const factsHeading = (post) => post.factsHead || DECISION_HEADING;
export const shareFile = (slug) => `og/${slug || 'index'}.png`;
// dev.to cover image of an article (its `main_image`): the title alone, at dev.to's crop size.
export const coverFile = (slug) => `cover/${slug}.png`;

export const PRODUCT_START = '<!-- product-block:start -->';
export const PRODUCT_END = '<!-- product-block:end -->';
export const AI_MARKER = '<!-- ai-disclosure: owner to word -->';
export const AI_LINE =
  '*This article was written with AI assistance and checked against the official sources listed above.*';
export const DEVTO_BLOG_LINE =
  'More cases like this, from the decision down to the code: [our blog](https://innit-llc.github.io/blog/).';

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
  'August', 'September', 'October', 'November', 'December'];

function longDate(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) throw new Error(`bad date ${iso}`);
  return `${Number(m[3])} ${MONTHS[Number(m[2]) - 1]} ${m[1]}`;
}

function countOf(haystack, needle) {
  return haystack.split(needle).length - 1;
}

// Replaces the AI marker and the line after it with `replacement`.
function replaceAiLine(body, slug, replacement) {
  if (countOf(body, AI_MARKER) !== 1) throw new Error(`${slug}: expected one "${AI_MARKER}"`);
  const re = new RegExp(`${AI_MARKER.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\n(\\*[^\\n]*\\*)\\n?`);
  const m = re.exec(body);
  if (!m) throw new Error(`${slug}: the line after the AI marker is not an italic line`);
  return body.slice(0, m.index) + replacement + '\n' + body.slice(m.index + m[0].length);
}

// Splits the body around the product block; markers must each occur once.
function splitProduct(body, slug) {
  if (countOf(body, PRODUCT_START) !== 1 || countOf(body, PRODUCT_END) !== 1) {
    throw new Error(`${slug}: expected one product-block start and one end marker`);
  }
  const a = body.indexOf(PRODUCT_START);
  const b = body.indexOf(PRODUCT_END);
  if (b < a) throw new Error(`${slug}: product-block end before start`);
  return {
    before: body.slice(0, a),
    block: body.slice(a + PRODUCT_START.length, b),
    after: body.slice(b + PRODUCT_END.length),
  };
}

export function devtoMarkdown(source, slug) {
  const { raw, body } = splitFrontMatter(source);
  const frontMatter = raw.replace(/^canonical_url:.*\n/m, '');
  const { before, after } = splitProduct(body, slug);
  const joined = before.replace(/\n+$/, '') + '\n\n' + after.replace(/^\n+/, '');
  return frontMatter + replaceAiLine(joined, slug, `${AI_LINE}\n\n${DEVTO_BLOG_LINE}`);
}

function unescapeHtml(s) {
  return s.replace(/&(lt|gt|quot|amp);/g, (_, e) => ({ lt: '<', gt: '>', quot: '"', amp: '&' })[e]);
}

// The wordmark: the site name's first word bold, the rest regular.
function wordmark() {
  const [strong, ...rest] = SITE.name.split(' ');
  return { strong, rest: rest.join(' ') };
}

// Splits Markdown around the one "## The decision" section (up to the next
// level-1 or level-2 heading).
function splitDecision(md, slug, head = DECISION_HEADING) {
  const lines = md.split('\n');
  const heading = new RegExp(`^## ${head}\\s*$`);
  const starts = lines.flatMap((l, i) => (heading.test(l) ? [i] : []));
  if (starts.length !== 1) throw new Error(`${slug}: expected one "## ${head}" section before the product block`);
  const s = starts[0];
  let e = lines.findIndex((l, i) => i > s && /^#{1,2}\s/.test(l));
  if (e === -1) e = lines.length;
  return {
    opening: lines.slice(0, s).join('\n'),
    decision: lines.slice(s, e).join('\n'),
    rest: lines.slice(e).join('\n'),
  };
}

// A short label at the start of a list item ("Fine:", "Court and date:") is
// set bold. Works on rendered HTML; a label never holds markup.
function boldLabels(html, open, close) {
  return html.replace(/<li>([^<:\n]{1,40}):\s/g, (m, label) =>
    label.trim().split(/\s+/).length <= 5 ? `<li>${open}${label}:${close} ` : m);
}

// The items of the first list in a Markdown section, as Markdown text.
function listItems(md) {
  const items = [];
  for (const line of md.split('\n')) {
    const m = /^[-*+]\s+(.*)$/.exec(line);
    if (m) items.push(m[1]);
    else if (items.length && line.trim() !== '' && !/^#/.test(line)) items[items.length - 1] += ' ' + line.trim();
    else if (items.length && line.trim() === '') break;
  }
  return items;
}

// The first sentence of a Markdown text: ends at . ! or ? outside brackets,
// followed by a space and a capital; "N.D." style initials do not end it.
function firstSentence(md) {
  let depth = 0;
  for (let i = 0; i < md.length; i++) {
    const c = md[i];
    if (c === '(' || c === '[') depth++;
    else if ((c === ')' || c === ']') && depth > 0) depth--;
    else if (depth === 0 && (c === '.' || c === '!' || c === '?')) {
      let j = i + 1;
      while (j < md.length && /["”’)*_]/.test(md[j])) j++;
      if (j >= md.length) return md;
      if (!/\s/.test(md[j]) || !/^\s+["“(\[]?[A-Z]/.test(md.slice(j))) continue;
      if (c === '.' && /(^|[\s.(])[A-Z]$/.test(md.slice(0, i))) continue;
      return md.slice(0, j);
    }
  }
  return md;
}

function plainText(md) {
  return unescapeHtml(renderInline(md).replace(/<[^>]+>/g, ''));
}

// The share-image facts of an article: for each `card` entry, the one item of
// "The decision" list that starts with it, cut to its first sentence.
function cardFacts(decisionMd, post) {
  const items = listItems(decisionMd);
  return (post.card || []).map((start) => {
    const hits = items.filter((it) => {
      const t = plainText(it);
      return t.startsWith(start) && !/[A-Za-z]/.test(t.charAt(start.length));
    });
    if (hits.length !== 1) throw new Error(`${post.slug}: card entry "${start}" matches ${hits.length} items of "${DECISION_HEADING}"`);
    return boldLabels(`<li>${renderInline(firstSentence(hits[0]))}`, '<b>', '</b>').slice(4);
  });
}

function page({ title, description, ogType, ogUrl, ogImage, canonical, root, content, bodyClass }) {
  const canonicalLink = canonical ? `<link rel="canonical" href="${escapeAttr(canonical)}" />\n` : '';
  const wm = wordmark();
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(title)}</title>
<meta name="description" content="${escapeAttr(description)}" />
<meta property="og:type" content="${ogType}" />
<meta property="og:site_name" content="${escapeAttr(SITE.name)}" />
<meta property="og:title" content="${escapeAttr(title)}" />
<meta property="og:description" content="${escapeAttr(description)}" />
<meta property="og:url" content="${escapeAttr(ogUrl)}" />
<meta property="og:image" content="${escapeAttr(ogImage)}" />
<meta property="og:image:width" content="${SHARE_W}" />
<meta property="og:image:height" content="${SHARE_H}" />
<meta property="og:image:alt" content="${escapeAttr(title)}" />
<meta name="twitter:card" content="summary_large_image" />
<meta name="color-scheme" content="light dark" />
${canonicalLink}<link rel="preload" href="${root}fonts/${FONT_FILES[0]}" as="font" type="font/woff2" crossorigin="anonymous" />
<link rel="stylesheet" href="${root}style.css" />
</head>
<body class="${bodyClass}">
<header class="mast"><div class="wrap"><a class="brand" href="${root || './'}"><b>${escapeHtml(wm.strong)}</b>${wm.rest ? ` ${escapeHtml(wm.rest)}` : ''}</a></div></header>
<main class="wrap">
${content}
</main>
<footer class="site"><div class="wrap">${escapeHtml(SITE.publisher)}</div></footer>
</body>
</html>
`;
}

export function articleHtml(source, post) {
  const { data, body } = splitFrontMatter(source);
  if (!data.title || !data.description) throw new Error(`${post.slug}: title or description missing`);
  const withAi = replaceAiLine(body, post.slug, AI_LINE);
  const { before, block, after } = splitProduct(withAi, post.slug);
  const { opening, decision, rest } = splitDecision(before, post.slug, factsHeading(post));
  const usedIds = new Set();
  const parts = [opening, decision, rest, block, after].map((md) => renderMarkdown(md, { usedIds }));
  const caseHtml = boldLabels(parts[1].html, '<span class="k">', '</span>');
  const content = `<article>
<header>
<h1>${escapeHtml(data.title)}</h1>
<p class="meta"><time datetime="${post.date}">${longDate(post.date)}</time></p>
</header>
${parts[0].html}
<section class="case">
${caseHtml}
</section>
${parts[2].html}
<aside class="product-note">
${parts[3].html}
</aside>
${parts[4].html}
<p class="repo-link">${escapeHtml(SITE.repoLine)} <a href="${escapeAttr(SITE.repo)}">${escapeHtml(SITE.repoLabel)}</a></p>
</article>`;
  return {
    title: data.title,
    description: data.description,
    facts: cardFacts(decision, post),
    html: page({
      title: data.title,
      description: data.description,
      ogType: 'article',
      ogUrl: `${SITE.url}${post.slug}/`,
      ogImage: `${SITE.url}${shareFile(post.slug)}`,
      canonical: post.canonical,
      root: '../',
      bodyClass: 'post',
      content,
    }),
  };
}

function indexHtml(entries) {
  const items = entries.map((e) => `<li>
<h2><a href="${e.slug}/">${escapeHtml(e.title)}</a></h2>
<p>${escapeHtml(e.description)}</p>
<p class="meta"><time datetime="${e.date}">${longDate(e.date)}</time></p>
</li>`).join('\n');
  return page({
    title: SITE.name,
    description: SITE.description,
    ogType: 'website',
    ogUrl: SITE.url,
    ogImage: `${SITE.url}${shareFile('')}`,
    root: '',
    bodyClass: 'home',
    content: `<h1>${escapeHtml(SITE.description)}</h1>
<ul class="posts">
${items}
</ul>
<p class="repo-link">${escapeHtml(SITE.repoLine)} <a href="${escapeAttr(SITE.repo)}">${escapeHtml(SITE.repoLabel)}</a></p>`,
  });
}

export function build(articlesDir) {
  const siteDir = path.join(HERE, 'docs');
  const devtoDir = path.join(articlesDir, 'devto');
  const assets = path.join(HERE, 'assets');
  fs.rmSync(siteDir, { recursive: true, force: true });
  fs.mkdirSync(siteDir, { recursive: true });
  fs.mkdirSync(devtoDir, { recursive: true });

  const entries = [];
  for (const post of POSTS) {
    const source = fs.readFileSync(path.join(articlesDir, `${post.slug}.md`), 'utf8');
    fs.writeFileSync(path.join(devtoDir, `${post.slug}.md`), devtoMarkdown(source, post.slug));
    const art = articleHtml(source, post);
    fs.mkdirSync(path.join(siteDir, post.slug), { recursive: true });
    fs.writeFileSync(path.join(siteDir, post.slug, 'index.html'), art.html);
    entries.push({ ...post, title: art.title, description: art.description, facts: art.facts });
  }
  const order = (e) => POSTS.findIndex((p) => p.slug === e.slug);
  entries.sort((x, y) => (x.date === y.date ? order(x) - order(y) : x.date < y.date ? 1 : -1));
  fs.writeFileSync(path.join(siteDir, 'index.html'), indexHtml(entries));
  fs.copyFileSync(path.join(assets, 'style.css'), path.join(siteDir, 'style.css'));
  fs.mkdirSync(path.join(siteDir, 'fonts'), { recursive: true });
  for (const f of FONT_FILES) fs.copyFileSync(path.join(assets, 'fonts', f), path.join(siteDir, 'fonts', f));
  fs.writeFileSync(path.join(siteDir, '.nojekyll'), '');

  // Share images: each article from its title and decision facts; the index
  // from the site description and the newest three titles.
  const fontFile = path.join(assets, 'fonts', FONT_FILES[0]);
  const common = { fontFile, brand: wordmark(), host: SITE.url.replace(/^https?:\/\//, '').replace(/\/$/, '') };
  renderShareImages([
    ...entries.map((e) => ({
      out: path.join(siteDir, shareFile(e.slug)),
      html: shareHtml({ ...common, title: e.title, titleSize: 60, sheetHead: factsHeading(e), rows: e.facts }),
    })),
    ...entries.map((e) => ({
      out: path.join(siteDir, coverFile(e.slug)), w: COVER_W, h: COVER_H,
      html: shareHtml({ ...common, title: e.title, titleSize: 64, sheetHead: '', rows: [], w: COVER_W, h: COVER_H }),
    })),
    {
      out: path.join(siteDir, shareFile('')),
      html: shareHtml({ ...common, title: SITE.description, titleSize: 54, rowSize: 21, sheetHead: '',
        rows: entries.slice(0, 3).map((e) => escapeHtml(e.title)) }),
    },
  ]);
  return { siteDir, devtoDir };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const articlesDir = process.argv[2];
  if (!articlesDir) {
    console.error('usage: node build.mjs <articles-dir>');
    process.exit(2);
  }
  const dirs = build(path.resolve(articlesDir));
  const failures = runChecks({ articlesDir: path.resolve(articlesDir), ...dirs });
  if (failures.length) {
    console.error(`FAIL: ${failures.length} check(s) failed`);
    for (const f of failures) console.error(`  - ${f}`);
    process.exit(1);
  }
  console.log(`built ${dirs.siteDir} and ${dirs.devtoDir}; all checks passed`);
}
