// A small, dependency-free Markdown converter covering what the articles use:
// ATX headings, paragraphs, fenced code, block quotes, ordered and unordered
// lists, inline code, links, bare https links, *emphasis* and **strong**.
// Raw HTML is never passed through: every character of text is escaped, and
// lines that are whole HTML comments are dropped.

export function escapeHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function escapeAttr(s) {
  return escapeHtml(s).replace(/"/g, '&quot;');
}

// A hyphenated word (sign-ups, Arp-Hansen) is wrapped in a no-wrap span, so a
// heading or title never breaks after its hyphen. The hyphen stays U+002D, so
// copy and search see the word as written. Takes HTML; only text between tags
// is touched. The class "nw" is `white-space: nowrap` in every stylesheet.
export function noBreakHyphens(html) {
  return html.split(/(<[^>]*>)/).map((part) => (part.startsWith('<') ? part
    : part.replace(/[\p{L}\p{N}]+(?:-[\p{L}\p{N}]+)+/gu, '<span class="nw">$&</span>'))).join('');
}

export function slugify(text) {
  return text
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'section';
}

// Front matter: `key: value` lines between two `---` lines. Double-quoted
// values are read as JSON strings, which YAML double-quoted strings match for
// everything the articles use.
export function splitFrontMatter(md) {
  const m = /^---\n([\s\S]*?)\n---\n/.exec(md);
  if (!m) throw new Error('no front matter');
  const data = {};
  for (const line of m[1].split('\n')) {
    const kv = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(line);
    if (!kv) throw new Error(`unreadable front matter line: ${line}`);
    let v = kv[2].trim();
    if (v.startsWith('"')) v = JSON.parse(v);
    data[kv[1]] = v;
  }
  return { data, raw: m[0], body: md.slice(m[0].length) };
}

const FENCE = /^(`{3,})\s*([\w+-]*)\s*$/;
const HEADING = /^(#{1,6})\s+(.*?)\s*#*\s*$/;
const UL = /^[-*+]\s+(.*)$/;
const OL = /^(\d{1,9})[.)]\s+(.*)$/;
const COMMENT = /^\s*<!--[\s\S]*?-->\s*$/;

function startsBlock(line) {
  return FENCE.test(line) || HEADING.test(line) || UL.test(line) || OL.test(line) || line.startsWith('>');
}

// Returns { html, codeBlocks } where codeBlocks lists the raw text of every
// fenced block, in order, for the byte-identity check.
export function renderMarkdown(md, { usedIds = new Set(), headingShift = 0 } = {}) {
  const codeBlocks = [];
  const html = renderBlocks(md.replace(/\r\n/g, '\n').split('\n'), { usedIds, headingShift, codeBlocks });
  return { html, codeBlocks };
}

function renderBlocks(lines, ctx) {
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.trim() === '' || COMMENT.test(line)) { i++; continue; }

    let m;
    if ((m = FENCE.exec(line))) {
      const fence = m[1];
      const lang = m[2];
      const body = [];
      i++;
      while (i < lines.length && !new RegExp(`^${fence}\`*\\s*$`).test(lines[i])) body.push(lines[i++]);
      if (i >= lines.length) throw new Error(`unclosed code fence: ${line}`);
      i++;
      const text = body.length ? body.join('\n') + '\n' : '';
      ctx.codeBlocks.push(text);
      const cls = lang ? ` class="language-${escapeAttr(lang)}"` : '';
      out.push(`<pre><code${cls}>${escapeHtml(text)}</code></pre>`);
      continue;
    }

    if ((m = HEADING.exec(line))) {
      const level = Math.min(6, m[1].length + ctx.headingShift);
      let id = slugify(m[2]);
      let n = 2;
      while (ctx.usedIds.has(id)) id = `${slugify(m[2])}-${n++}`;
      ctx.usedIds.add(id);
      out.push(`<h${level} id="${id}">${renderInline(m[2])}</h${level}>`);
      i++;
      continue;
    }

    if (line.startsWith('>')) {
      const inner = [];
      while (i < lines.length && lines[i].startsWith('>')) inner.push(lines[i++].replace(/^> ?/, ''));
      out.push(`<blockquote>\n${renderBlocks(inner, ctx)}\n</blockquote>`);
      continue;
    }

    if (UL.test(line) || OL.test(line)) {
      const ordered = OL.test(line);
      const re = ordered ? OL : UL;
      const items = [];
      let start = 1;
      while (i < lines.length && re.test(lines[i])) {
        const mm = re.exec(lines[i]);
        if (ordered && items.length === 0) start = Number(mm[1]);
        const text = [ordered ? mm[2] : mm[1]];
        i++;
        // Continuation lines: indented, or lazy lines that start no new block.
        while (i < lines.length && lines[i].trim() !== '' && !re.test(lines[i]) &&
               (/^\s+/.test(lines[i]) || !startsBlock(lines[i]))) {
          text.push(lines[i++].trim());
        }
        items.push(`<li>${renderInline(text.join('\n'))}</li>`);
      }
      const tag = ordered ? 'ol' : 'ul';
      const startAttr = ordered && start !== 1 ? ` start="${start}"` : '';
      out.push(`<${tag}${startAttr}>\n${items.join('\n')}\n</${tag}>`);
      continue;
    }

    const para = [];
    while (i < lines.length && lines[i].trim() !== '' && !COMMENT.test(lines[i]) &&
           (para.length === 0 || !startsBlock(lines[i]))) {
      para.push(lines[i++].trim());
    }
    out.push(`<p>${renderInline(para.join('\n'))}</p>`);
  }
  return out.join('\n');
}

// Trailing characters that GFM leaves outside a bare link.
function trimUrl(url) {
  let u = url;
  for (;;) {
    const before = u;
    u = u.replace(/[.,:;!?'"*_~]+$/, '');
    if (u.endsWith(')')) {
      const open = (u.match(/\(/g) || []).length;
      const close = (u.match(/\)/g) || []).length;
      if (close > open) u = u.slice(0, -1);
    }
    if (u === before) return u;
  }
}

export function renderInline(src) {
  const slots = [];
  const hold = (html) => `\u0000${slots.push(html) - 1}\u0000`;

  // 1. Code spans: their content is literal.
  let s = src.replace(/(`+)([\s\S]*?[^`])\1(?!`)/g, (_, ticks, body) => {
    let b = body.replace(/\n/g, ' ');
    if (b.length > 2 && b.startsWith(' ') && b.endsWith(' ')) b = b.slice(1, -1);
    return hold(`<code>${escapeHtml(b)}</code>`);
  });

  // 2. Inline links [text](url).
  s = s.replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, (_, text, url) =>
    hold(`<a href="${escapeAttr(url)}">${renderInline(text)}</a>`));

  // 3. Bare https links.
  s = s.replace(/https?:\/\/[^\s<>\u0000]+/g, (raw) => {
    const url = trimUrl(raw);
    return hold(`<a href="${escapeAttr(url)}">${escapeHtml(url)}</a>`) + raw.slice(url.length);
  });

  // 4. Everything left is text.
  s = escapeHtml(s);

  // 5. Emphasis.
  s = s.replace(/\*\*(?=\S)([\s\S]+?)(?<=\S)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/\*(?=\S)([^*]+?)(?<=\S)\*/g, '<em>$1</em>');

  // 6. Put the held pieces back.
  return s.replace(/\u0000(\d+)\u0000/g, (_, n) => slots[Number(n)]);
}
