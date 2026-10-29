/**
 * Builds the documentation site into site/dist: the landing page (site/index.html) and every
 * Markdown page under documentation/, plus the changelog and benchmark results.
 *   node scripts/site/build.mjs          build
 *   node scripts/site/build.mjs --serve  build and serve on http://localhost:4173
 */
import { existsSync, statSync } from "node:fs";
import { cp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname, extname, join, posix, relative, resolve } from "node:path";
import { renderMarkdown } from "./markdown.mjs";

const ROOT = resolve(import.meta.dirname, "../..");
const SITE = join(ROOT, "site");
const DIST = join(SITE, "dist");
const REPO = "https://github.com/RemiPelloux/SmarttyTest";
const manifest = JSON.parse(await readFile(join(ROOT, "scripts/packages.manifest.json"), "utf8"));
const VERSION = manifest.version;

/** Repository Markdown file → site path. */
const pages = new Map();
async function walk(dir) {
  for (const e of await readdir(join(ROOT, dir), { withFileTypes: true })) {
    const p = posix.join(dir, e.name);
    if (e.isDirectory()) {
      if (p === "documentation/planning/foundation") continue;
      await walk(p);
    } else if (e.name.endsWith(".md")) {
      const rel = p.slice("documentation/".length);
      const out = rel.endsWith("README.md")
        ? rel.replace(/README\.md$/, "index.html")
        : rel.replace(/\.md$/, ".html");
      pages.set(p, `docs/${out}`);
    }
  }
}
await walk("documentation");
pages.set("CHANGELOG.md", "docs/changelog.html");
pages.set("benchmarks/RESULTS.md", "docs/benchmarks.html");

/** Sidebar groups (site paths). */
const NAV = [
  [
    "Start",
    [
      ["Overview", "docs/index.html"],
      ["Getting started", "docs/guides/getting-started.html"],
      ["Running in CI", "docs/guides/ci.html"],
    ],
  ],
  [
    "Concepts",
    [
      ["How selection works", "docs/concepts/how-selection-works.html"],
      ["Safety model", "docs/concepts/safety-model.html"],
      ["Runtime evidence", "docs/concepts/runtime-evidence.html"],
      ["Running less, faster", "docs/concepts/speed.html"],
      ["Change tracking", "docs/concepts/change-tracking.html"],
      ["Rules", "docs/concepts/rules.html"],
    ],
  ],
  [
    "Reference",
    [
      ["CLI", "docs/reference/cli.html"],
      ["Configuration", "docs/reference/configuration.html"],
      ["Benchmarks", "docs/benchmarks.html"],
      ["Changelog", "docs/changelog.html"],
    ],
  ],
  [
    "Results",
    [
      ["Case study: LeadsIt", "docs/case-studies/leadsit.html"],
      ["External repositories", "docs/case-studies/external-repositories.html"],
    ],
  ],
  [
    "Project",
    [
      ["Roadmap", "docs/planning/roadmap.html"],
      ["Architecture", "docs/architecture/overview.html"],
      ["Decision records", "docs/architecture/adr/index.html"],
      ["Design system", "docs/design/design-system.html"],
      ["Specification", "docs/product/PRD.html"],
    ],
  ],
];

const rel = (from, to) => {
  const r = posix.relative(posix.dirname(from), to);
  return r === "" ? posix.basename(to) : r;
};
const escHtml = (s) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const assetsToCopy = new Set();

function linkFor(srcFile, sitePath) {
  return (href) => {
    if (/^(https?:|mailto:|#|data:)/.test(href)) return href;
    const [path, hash] = href.split("#");
    if (!path) return href;
    const target = posix.normalize(posix.join(posix.dirname(srcFile), path)).replace(/\/$/, "");
    const anchor = hash ? `#${hash}` : "";
    const asPage = pages.get(target) ?? pages.get(posix.join(target, "README.md"));
    if (asPage) return rel(sitePath, asPage) + anchor;
    if (
      target.startsWith("documentation/") &&
      !target.endsWith(".md") &&
      existsSync(join(ROOT, target)) &&
      statSync(join(ROOT, target)).isFile()
    ) {
      const out = `docs/${target.slice("documentation/".length)}`;
      assetsToCopy.add([target, out]);
      return rel(sitePath, out) + anchor;
    }
    if (existsSync(join(ROOT, target))) {
      const kind = statSync(join(ROOT, target)).isDirectory() ? "tree" : "blob";
      return `${REPO}/${kind}/main/${target}${anchor}`;
    }
    return href;
  };
}

function navHtml(sitePath) {
  return NAV.map(
    ([group, items]) =>
      `<div class="nav-group"><p class="nav-title">${group}</p><ul>${items
        .map(
          ([label, p]) =>
            `<li><a href="${rel(sitePath, p)}"${p === sitePath ? ' aria-current="page"' : ""}>${label}</a></li>`,
        )
        .join("")}</ul></div>`,
  ).join("");
}

function docPage({ sitePath, srcFile, title, html, headings, hasMermaid }) {
  const up = (p) => rel(sitePath, p);
  const toc = headings.filter((h) => h.level === 2);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escHtml(title)} · SmartTest</title>
<meta name="description" content="SmartTest documentation: ${escHtml(title)}">
<link rel="icon" href="${up("assets/logo.svg")}" type="image/svg+xml">
<link rel="stylesheet" href="${up("assets/site.css")}">
<link rel="stylesheet" href="${up("assets/docs.css")}">
</head>
<body class="docs">
<a class="skip" href="#content">Skip to content</a>
<header class="bar">
  <a class="wordmark" href="${up("index.html")}"><img src="${up("assets/logo.svg")}" alt="" width="22" height="22"> SmartTest</a>
  <button class="nav-toggle" type="button" aria-expanded="false" aria-controls="sidebar">Menu</button>
  <nav class="bar-links" aria-label="Site">
    <a href="${up("docs/index.html")}">Docs</a>
    <a href="${up("docs/reference/cli.html")}">CLI</a>
    <a href="${up("docs/planning/roadmap.html")}">Roadmap</a>
    <a href="${REPO}" rel="noopener">GitHub</a>
  </nav>
  <label class="search"><span class="sr">Search the docs</span><input type="search" placeholder="Search" data-search data-base="${up("")}" autocomplete="off"><span class="search-results" data-results hidden></span></label>
</header>
<div class="layout">
  <aside id="sidebar" class="sidebar">${navHtml(sitePath)}<p class="version">Version ${VERSION}</p></aside>
  <main id="content" class="prose">
${html}
    <p class="edit"><a href="${REPO}/blob/main/${srcFile}" rel="noopener">Edit this page on GitHub</a></p>
  </main>
  ${toc.length > 2 ? `<nav class="toc" aria-label="On this page"><p class="nav-title">On this page</p><ul>${toc.map((h) => `<li><a href="#${h.id}">${h.text}</a></li>`).join("")}</ul></nav>` : "<div></div>"}
</div>
<script src="${up("assets/docs.js")}" defer></script>
${hasMermaid ? `<script type="module">import mermaid from "https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.esm.min.mjs"; mermaid.initialize({ startOnLoad: true, theme: "dark" });</script>` : ""}
</body>
</html>
`;
}

await rm(DIST, { recursive: true, force: true });
await mkdir(DIST, { recursive: true });
await cp(join(SITE, "assets"), join(DIST, "assets"), { recursive: true });
await cp(join(ROOT, "documentation/assets/logo.svg"), join(DIST, "assets/logo.svg"));

const searchIndex = [];
const docsList = [];
for (const [srcFile, sitePath] of pages) {
  let md = await readFile(join(ROOT, srcFile), "utf8");
  if (srcFile === "documentation/README.md")
    md = md.replace(/^# Documentation/, "# SmartTest documentation");
  const r = renderMarkdown(md, { link: linkFor(srcFile, sitePath) });
  const title = r.title || posix.basename(srcFile, ".md");
  const out = join(DIST, sitePath);
  await mkdir(dirname(out), { recursive: true });
  await writeFile(out, docPage({ sitePath, srcFile, title, ...r }));
  const words = md.split(/\s+/).length;
  searchIndex.push({
    t: title,
    u: sitePath,
    h: r.headings.filter((h) => h.level <= 3).map((h) => [h.text, h.id]),
  });
  docsList.push({ title, sitePath, minutes: Math.max(1, Math.round(words / 230)) });
}
for (const [src, out] of assetsToCopy) {
  await mkdir(dirname(join(DIST, out)), { recursive: true });
  await cp(join(ROOT, src), join(DIST, out));
}
await writeFile(join(DIST, "assets/search.json"), JSON.stringify(searchIndex));

// Landing page: the docs list is generated from the sidebar groups.
const minutesOf = (p) => docsList.find((d) => d.sitePath === p)?.minutes ?? 1;
const list = NAV.map(
  ([group, items]) =>
    `<div class="doc-group"><p class="doc-group-name">${group}</p><ul>${items
      .map(
        ([label, p]) =>
          `<li><a href="${p}"><span class="dot dot-${group.toLowerCase()}" aria-hidden="true"></span><span class="doc-name">${label}</span><span class="doc-time">${minutesOf(p)} min</span></a></li>`,
      )
      .join("")}</ul></div>`,
).join("");
const landing = (await readFile(join(SITE, "index.html"), "utf8"))
  .replace("<!-- DOCS_LIST -->", list)
  .replace(
    "<!-- DEMO_DATA -->",
    (await readFile(join(SITE, "assets/demo-data.json"), "utf8")).trim().replace(/</g, "\\u003c"),
  )
  .replaceAll("{{VERSION}}", VERSION);
await writeFile(join(DIST, "index.html"), landing);
await writeFile(join(DIST, ".nojekyll"), "");
await writeFile(
  join(DIST, "404.html"),
  docPage({
    sitePath: "404.html",
    srcFile: "documentation/README.md",
    title: "Page not found",
    html: `<h1 id="page-not-found">Page not found</h1><p>That page does not exist. Start from the <a href="docs/index.html">documentation overview</a>.</p>`,
    headings: [],
    hasMermaid: false,
  })
    .replace(/href="(?!https?:|#)([^"]+)"/g, (m, h) =>
      h.startsWith("/") ? m : `href="/SmarttyTest/${h}"`,
    )
    .replace(/src="(?!https?:)([^"]+)"/g, 'src="/SmarttyTest/$1"'),
);
console.log(`site: ${pages.size} pages → ${relative(ROOT, DIST)}`);

if (process.argv.includes("--serve")) {
  const types = {
    ".html": "text/html",
    ".css": "text/css",
    ".js": "text/javascript",
    ".json": "application/json",
    ".svg": "image/svg+xml",
    ".webp": "image/webp",
    ".png": "image/png",
  };
  createServer(async (req, res) => {
    let p = decodeURIComponent((req.url ?? "/").split("?")[0]);
    if (p.endsWith("/")) p += "index.html";
    try {
      const body = await readFile(join(DIST, p));
      res.writeHead(200, { "content-type": types[extname(p)] ?? "application/octet-stream" });
      res.end(body);
    } catch {
      res.writeHead(404, { "content-type": "text/html" });
      res.end(await readFile(join(DIST, "404.html")));
    }
  }).listen(4173, () => console.log("http://localhost:4173"));
}
