/**
 * A small Markdown renderer for the documentation site. It covers what the docs use: headings with
 * GitHub-style ids, paragraphs, emphasis, inline code, links, images, tables, fenced code (Mermaid
 * included), block quotes, nested lists, rules and raw HTML blocks. No dependencies.
 */

const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const escAttr = (s) => esc(s).replace(/"/g, "&quot;");

/** GitHub's heading slug. */
export function slugify(text) {
  return text
    .toLowerCase()
    .replace(/<[^>]+>/g, "")
    .replace(/[`*_~[\]()]/g, "")
    .replace(/[^\p{L}\p{N}\s_-]/gu, "")
    .trim()
    .replace(/\s/g, "-");
}

/**
 * @param {string} src
 * @param {{ link?: (href: string) => string }} options link rewrites relative hrefs and srcs
 */
export function renderMarkdown(src, options = {}) {
  const link = options.link ?? ((h) => h);
  const headings = [];
  const usedIds = new Map();
  let hasMermaid = false;

  const inline = (text) => {
    const tokens = [];
    const hold = (html) => {
      tokens.push(html);
      return `\uE000${tokens.length - 1}\uE000`;
    };
    // code spans (backtick runs of equal length)
    let s = text.replace(/(`+)([\s\S]*?[^`])\1(?!`)/g, (_, _ticks, code) => {
      const c =
        code.length > 1 && code.startsWith(" ") && code.endsWith(" ") ? code.slice(1, -1) : code;
      return hold(`<code>${esc(c)}</code>`);
    });
    // inline HTML we allow through
    s = s.replace(/<(\/?)(br|small|sub|sup|kbd|b|i|em|strong|code|span|img)(\s[^>]*)?\/?>/gi, (m) =>
      hold(m.replace(/\s(src|href)="([^"]+)"/g, (_x, a, v) => ` ${a}="${escAttr(link(v))}"`)),
    );
    s = s.replace(/\\([\\`*_{}[\]()#+\-.!|<>])/g, (_, c) => hold(esc(c)));
    s = esc(s);
    s = s.replace(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+&quot;([^&]*)&quot;)?\)/g, (_, alt, href) =>
      hold(
        `<img src="${escAttr(link(href.replace(/&amp;/g, "&")))}" alt="${escAttr(alt)}" loading="lazy">`,
      ),
    );
    s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, label, href) => {
      const h = link(href.replace(/&amp;/g, "&"));
      const ext = /^https?:/.test(h) ? ' rel="noopener"' : "";
      return `<a href="${escAttr(h)}"${ext}>${label}</a>`;
    });
    s = s.replace(
      /&lt;(https?:\/\/[^\s&]+)&gt;/g,
      (_, u) => `<a href="${escAttr(u)}" rel="noopener">${u}</a>`,
    );
    s = s.replace(/\*\*([^*]+?)\*\*/g, "<strong>$1</strong>");
    s = s.replace(/(^|[^\w*])\*([^*\s][^*]*?)\*(?!\w)/g, "$1<em>$2</em>");
    s = s.replace(/(^|[^\w])_([^_\s][^_]*?)_(?!\w)/g, "$1<em>$2</em>");
    return s
      .replace(/\uE000(\d+)\uE000/g, (_, i) => tokens[Number(i)])
      .replace(/\uE000(\d+)\uE000/g, (_, i) => tokens[Number(i)]);
  };

  const isTableSep = (l) => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(l);
  const cells = (l) => {
    const t = l.trim().replace(/^\|/, "").replace(/\|$/, "");
    const out = [];
    let cur = "";
    let inCode = false;
    for (let i = 0; i < t.length; i++) {
      const ch = t[i];
      if (ch === "\\" && t[i + 1] === "|") {
        cur += "\\|";
        i++;
      } else if (ch === "`") {
        inCode = !inCode;
        cur += ch;
      } else if (ch === "|" && !inCode) {
        out.push(cur.trim());
        cur = "";
      } else cur += ch;
    }
    out.push(cur.trim());
    return out.map((c) => c.replace(/\\\|/g, "|"));
  };
  const listRe = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;
  const isBlockStart = (l) =>
    /^\s*```/.test(l) ||
    /^#{1,6}\s/.test(l) ||
    /^\s*>/.test(l) ||
    listRe.test(l) ||
    /^(-{3,}|\*{3,})\s*$/.test(l);

  const blocks = (lines) => {
    const out = [];
    let i = 0;
    while (i < lines.length) {
      const line = lines[i];
      if (!line.trim()) {
        i++;
        continue;
      }
      const fence = /^(\s*)```\s*([\w-]*)/.exec(line);
      if (fence) {
        const indent = fence[1].length;
        const lang = fence[2];
        const body = [];
        i++;
        while (i < lines.length && !/^\s*```\s*$/.test(lines[i]))
          body.push(lines[i++].slice(indent));
        i++;
        const code = body.join("\n");
        if (lang === "mermaid") {
          hasMermaid = true;
          out.push(`<pre class="mermaid">${esc(code)}</pre>`);
        } else
          out.push(`<pre${lang ? ` data-lang="${lang}"` : ""}><code>${esc(code)}</code></pre>`);
        continue;
      }
      const h = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
      if (h) {
        const level = h[1].length;
        const text = h[2];
        let id = slugify(text);
        const n = usedIds.get(id) ?? 0;
        usedIds.set(id, n + 1);
        if (n) id = `${id}-${n}`;
        const html = inline(text);
        headings.push({ level, text: html.replace(/<[^>]+>/g, ""), id });
        out.push(
          `<h${level} id="${id}">${html}${level > 1 ? ` <a class="anchor" href="#${id}" aria-label="Link to this section">#</a>` : ""}</h${level}>`,
        );
        i++;
        continue;
      }
      if (/^(-{3,}|\*{3,})\s*$/.test(line)) {
        out.push("<hr>");
        i++;
        continue;
      }
      if (line.trim().startsWith("|") && i + 1 < lines.length && isTableSep(lines[i + 1])) {
        const head = cells(line);
        const aligns = cells(lines[i + 1]).map((c) =>
          c.startsWith(":") && c.endsWith(":") ? "center" : c.endsWith(":") ? "right" : "",
        );
        i += 2;
        const rows = [];
        while (i < lines.length && lines[i].trim().startsWith("|")) rows.push(cells(lines[i++]));
        const td = (tag, c, j) =>
          `<${tag}${aligns[j] ? ` style="text-align:${aligns[j]}"` : ""}>${inline(c)}</${tag}>`;
        out.push(
          `<div class="table"><table><thead><tr>${head.map((c, j) => td("th", c, j)).join("")}</tr></thead><tbody>${rows
            .map((r) => `<tr>${r.map((c, j) => td("td", c, j)).join("")}</tr>`)
            .join("")}</tbody></table></div>`,
        );
        continue;
      }
      if (/^\s*>/.test(line)) {
        const body = [];
        while (i < lines.length && /^\s*>/.test(lines[i]))
          body.push(lines[i++].replace(/^\s*>\s?/, ""));
        out.push(`<blockquote>${blocks(body)}</blockquote>`);
        continue;
      }
      if (
        /^\s*<\/?[a-zA-Z]/.test(line) &&
        !/^\s*<(https?:|br\b|code|b\b|em|strong|small|kbd)/i.test(line)
      ) {
        const body = [];
        while (i < lines.length && lines[i].trim()) body.push(lines[i++]);
        out.push(
          body
            .join("\n")
            .replace(/\s(src|href)="([^"]+)"/g, (_x, a, v) => ` ${a}="${escAttr(link(v))}"`),
        );
        continue;
      }
      const li = listRe.exec(line);
      if (li) {
        const baseIndent = li[1].length;
        const ordered = /\d/.test(li[2]);
        const items = [];
        let loose = false;
        while (i < lines.length) {
          const m = listRe.exec(lines[i]);
          if (!m || m[1].length !== baseIndent) break;
          const contentIndent = m[1].length + m[2].length + 1;
          const body = [m[3]];
          i++;
          let sawBlank = false;
          while (i < lines.length) {
            const l = lines[i];
            if (!l.trim()) {
              sawBlank = true;
              body.push("");
              i++;
              continue;
            }
            const indent = l.length - l.trimStart().length;
            if (indent >= contentIndent || (indent > baseIndent && listRe.test(l))) {
              body.push(l.slice(Math.min(indent, contentIndent)));
              i++;
              continue;
            }
            if (!sawBlank && !isBlockStart(l) && indent > baseIndent - 1 && !listRe.test(l)) {
              body.push(l.trim()); // lazy continuation
              i++;
              continue;
            }
            break;
          }
          while (body.length && !body[body.length - 1].trim()) body.pop();
          if (body.some((b) => !b.trim())) loose = true;
          items.push(body);
          // blank line between items keeps the list going
          let j = i;
          while (j < lines.length && !lines[j].trim()) j++;
          const next = j < lines.length ? listRe.exec(lines[j]) : null;
          if (j > i && next && next[1].length === baseIndent) {
            loose = true;
            i = j;
          } else if (j > i) break;
        }
        const start = ordered ? Number.parseInt(li[2], 10) : 1;
        const tag = ordered ? "ol" : "ul";
        out.push(
          `<${tag}${ordered && start !== 1 ? ` start="${start}"` : ""}>${items
            .map((b) => {
              const html = blocks(b);
              const tight = !loose && html.startsWith("<p>") && html.indexOf("<p>", 1) === -1;
              return `<li>${tight ? html.replace(/^<p>([\s\S]*?)<\/p>/, "$1") : html}</li>`;
            })
            .join("")}</${tag}>`,
        );
        continue;
      }
      const para = [];
      while (
        i < lines.length &&
        lines[i].trim() &&
        !isBlockStart(lines[i]) &&
        !(lines[i].trim().startsWith("|") && isTableSep(lines[i + 1] ?? ""))
      ) {
        para.push(lines[i++].trim());
      }
      if (!para.length) {
        para.push(lines[i++].trim());
      }
      out.push(`<p>${inline(para.join("\n")).replace(/\n/g, " ")}</p>`);
    }
    return out.join("\n");
  };

  const html = blocks(src.replace(/\r\n/g, "\n").split("\n"));
  const h1 = headings.find((x) => x.level === 1);
  return { html, headings, title: h1?.text ?? "", hasMermaid };
}
