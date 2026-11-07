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
// The published package's version (the manifest's own version field is not bumped by releases).
const VERSION = JSON.parse(await readFile(join(ROOT, "packages/cli/package.json"), "utf8")).version;

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

/** Sidebar groups (site paths), with the line the overview page shows for each page. */
const NAV = [
  [
    "Start",
    [
      ["Overview", "docs/index.html", "Where to begin, what is new, and every page in one place."],
      [
        "Getting started",
        "docs/guides/getting-started.html",
        "Install, run `smarttest init`, read the first selection.",
      ],
      [
        "Commit and push hooks",
        "docs/guides/commit-hooks.html",
        "Test exactly what is committed or pushed, in a temporary checkout when needed.",
      ],
      [
        "Running in CI",
        "docs/guides/ci.html",
        "Pick the base, deepen shallow clones, shard by recorded durations.",
      ],
      [
        "Rolling out to a repository",
        "docs/guides/rollout.html",
        "The steps that caught a problem in each real rollout, in order.",
      ],
    ],
  ],
  [
    "Guides",
    [
      [
        "Auditing selection",
        "docs/guides/audit.html",
        "Inject faults, record traces and compare imports to measure missed tests.",
      ],
      [
        "Angular",
        "docs/guides/angular.html",
        "Templates and styles as edges, `angular.json` per project, `ng test`.",
      ],
      [
        "Python (preview)",
        "docs/guides/python.html",
        "pytest and unittest, analysed without running Python.",
      ],
      [
        "PHP (preview)",
        "docs/guides/php.html",
        "PHPUnit, Pest and Laravel, analysed without running PHP.",
      ],
      [
        "Studio",
        "docs/guides/studio.html",
        "A local browser view of the analysis: impact, tests and evidence.",
      ],
      [
        "VS Code",
        "docs/guides/vscode.html",
        "Which tests protect a function, on hover; run what a change affects.",
      ],
      [
        "Plugins",
        "docs/guides/plugins.html",
        "The frozen Plugin SDK: edges, rules, reporters and adapters.",
      ],
    ],
  ],
  [
    "Concepts",
    [
      [
        "How selection works",
        "docs/concepts/how-selection-works.html",
        "From a diff to symbols, the dependency graph and a selection with reasons.",
      ],
      [
        "Safety model",
        "docs/concepts/safety-model.html",
        "What SmartTest never does, and why unsure means selected.",
      ],
      [
        "Runtime evidence",
        "docs/concepts/runtime-evidence.html",
        "Traces of what a test ran, combined with the static graph.",
      ],
      [
        "Running less, faster",
        "docs/concepts/speed.html",
        "Result cache, fail-fast order, parallel runners, adaptive mode.",
      ],
      [
        "Change tracking",
        "docs/concepts/change-tracking.html",
        "Git, Mercurial, Subversion, or snapshots without version control.",
      ],
      [
        "Rules",
        "docs/concepts/rules.html",
        "Architecture as testing policy: critical paths, required tests.",
      ],
    ],
  ],
  [
    "Reference",
    [
      ["CLI", "docs/reference/cli.html", "Every command and flag, with exit codes."],
      [
        "Configuration",
        "docs/reference/configuration.html",
        "Every key of `smarttest.config`, with defaults.",
      ],
      [
        "Public contracts",
        "docs/reference/contracts.html",
        "What is frozen at 1.0.0 and what needs a major version.",
      ],
      [
        "Benchmarks",
        "docs/benchmarks.html",
        "Selection and speed on the fixture harness, regenerated each release.",
      ],
      ["Changelog", "docs/changelog.html", "What changed in each version."],
    ],
  ],
  [
    "Results",
    [
      [
        "Case study: LeadsIt",
        "docs/case-studies/leadsit.html",
        "The first real migration: six projects, no root package.",
      ],
      [
        "Benchmarks for 1.0.0",
        "docs/case-studies/benchmarks-1.0.html",
        "Real repositories replayed at 0 missed failures.",
      ],
      [
        "Benchmarks for 1.2.0",
        "docs/case-studies/benchmarks-1.2.html",
        "OpenPro's four JavaScript repositories: 0 missed failures, 16–75% less test time.",
      ],
      [
        "External repositories",
        "docs/case-studies/external-repositories.html",
        "The 0.6.0 adoption check on repositories never seen before.",
      ],
    ],
  ],
  [
    "Project",
    [
      ["Roadmap", "docs/planning/roadmap.html", "What comes next, in points, with exit gates."],
      ["Roadmap 1.x", "docs/planning/roadmap-1.5.html", "The 1.x sprints and their status."],
      ["Delivery log", "docs/planning/delivery.html", "What each version actually delivered."],
      ["Architecture", "docs/architecture/overview.html", "Packages, boundaries and data flow."],
      ["Decision records", "docs/architecture/adr/index.html", "Accepted architecture decisions."],
      [
        "Security review",
        "docs/architecture/security-review.html",
        "The 1.0.0 review of what SmartTest reads, writes and runs.",
      ],
      [
        "Design system",
        "docs/design/design-system.html",
        "Tokens, type and colour shared by Studio and this site.",
      ],
      [
        "Specification",
        "docs/product/PRD.html",
        "The product specification; sections are cited as §11.4.",
      ],
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
    <a href="https://github.com/sponsors/RemiPelloux" rel="noopener">Sponsor</a>
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
let overview;
for (const [srcFile, sitePath] of pages) {
  let md = await readFile(join(ROOT, srcFile), "utf8");
  if (srcFile === "documentation/README.md")
    md = md.replace(/^# Documentation/, "# SmartTest documentation");
  const r = renderMarkdown(md, { link: linkFor(srcFile, sitePath) });
  const title = r.title || posix.basename(srcFile, ".md");
  const out = join(DIST, sitePath);
  await mkdir(dirname(out), { recursive: true });
  if (sitePath === "docs/index.html") overview = { srcFile, out };
  else await writeFile(out, docPage({ sitePath, srcFile, title, ...r }));
  const words = md.split(/\s+/).length;
  searchIndex.push({
    t: title,
    u: sitePath,
    h: r.headings.filter((h) => h.level <= 3).map((h) => [h.text, h.id]),
  });
  docsList.push({ title, sitePath, minutes: Math.max(1, Math.round(words / 230)) });
}
// The overview: a start path, what is new, and every page with its one-line description.
{
  const minutes = (p) => docsList.find((d) => d.sitePath === p)?.minutes;
  const inline = (t) => escHtml(t).replace(/`([^`]+)`/g, "<code>$1</code>");
  const groups = NAV.map(([group, items]) => {
    const cards = items
      .filter(([, p]) => p !== "docs/index.html")
      .map(([label, p, desc]) => {
        const m = minutes(p);
        return `<li><a class="card" href="${rel("docs/index.html", p)}"><span class="card-title">${escHtml(label)}</span><span class="card-desc">${inline(desc)}</span>${m ? `<span class="card-meta">${m} min read</span>` : ""}</a></li>`;
      })
      .join("");
    const id = group.toLowerCase();
    return `<h2 id="${id}">${group}<a class="anchor" href="#${id}" aria-label="Link to this section">#</a></h2><ul class="cards">${cards}</ul>`;
  }).join("\n");
  const html = `<h1 id="smarttest-documentation">SmartTest documentation</h1>
<p class="lead">SmartTest reads a change, follows it through your code to the tests that can detect a regression, and runs only those, through Jest, Vitest, <code>node --test</code>, Playwright, Cypress, Angular, pytest, unittest, PHPUnit or Pest. When it cannot rule a test out, it runs it.</p>
<ol class="start-path">
  <li><a href="guides/getting-started.html"><span class="step">1</span><span class="step-title">Install and look</span><code>smarttest init</code><span class="step-desc">Install <code>@tkmremi/smarttest</code> as a dev dependency; <code>init</code> detects the runners and explains the config before writing it.</span></a></li>
  <li><a href="guides/commit-hooks.html"><span class="step">2</span><span class="step-title">Gate commits and pushes</span><code>smarttest hook install</code><span class="step-desc">Runs the affected tests on exactly what is committed or pushed.</span></a></li>
  <li><a href="guides/ci.html"><span class="step">3</span><span class="step-title">Run it in CI</span><code>smarttest ci</code><span class="step-desc">Finds the base, deepens shallow clones, and keeps the full suite where you want it.</span></a></li>
</ol>
<aside class="whats-new" aria-labelledby="new-in"><p class="whats-new-title" id="new-in">New in ${VERSION.replace(/\.\d+$/, "")}</p><ul>
  <li><a href="guides/audit.html"><code>smarttest audit</code></a> measures missed tests on your project instead of assuming none.</li>
  <li><a href="guides/angular.html">Angular</a> workspaces, and a <a href="guides/python.html">Python preview</a> for pytest and unittest.</li>
  <li>Lockfile changes select by package, and <a href="guides/rollout.html">a rollout guide</a> from six real repositories.</li>
</ul><p><a href="changelog.html">Full changelog</a></p></aside>
${groups}
<p class="overview-foot">Section numbers such as §11.4 refer to the <a href="product/PRD.html">specification</a>. The same pages are in the repository under <code>documentation/</code>.</p>`;
  const headings = NAV.map(([group]) => ({ level: 2, text: group, id: group.toLowerCase() }));
  await writeFile(
    overview.out,
    docPage({
      sitePath: "docs/index.html",
      srcFile: overview.srcFile,
      title: "SmartTest documentation",
      html,
      headings,
      hasMermaid: false,
    }).replace('<body class="docs">', '<body class="docs docs-overview">'),
  );
}
for (const [src, out] of assetsToCopy) {
  await mkdir(dirname(join(DIST, out)), { recursive: true });
  await cp(join(ROOT, src), join(DIST, out));
}
await writeFile(join(DIST, "assets/search.json"), JSON.stringify(searchIndex));
// The `--json` and config schemas, so their `$id` URLs (…/SmarttyTest/schemas/<name>) resolve.
await cp(join(ROOT, "packages/cli/schemas"), join(DIST, "schemas"), { recursive: true });

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
