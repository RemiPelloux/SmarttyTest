/**
 * Stylesheets that import other stylesheets (Sass `@use`/`@forward`/`@import`, Less and CSS
 * `@import`). A component or module loads only its own stylesheet (`styleUrl`, `import "./x.scss"`),
 * so a change to a partial reaches code through the stylesheets that import it, transitively.
 *
 * Resolution errs toward more importers, never fewer: a relative specifier is matched the way Sass
 * resolves it (partials `_x`, `x/_index`, any style extension), and a bare one (`abstracts/vars`,
 * served by load paths such as Angular's `stylePreprocessorOptions.includePaths`) matches any
 * stylesheet whose path ends with it.
 */
import { readFile } from "node:fs/promises";
import { join, posix } from "node:path";

export const STYLESHEET = /\.(?:s[ac]ss|less|css|styl)$/;

const STATEMENT = /@(?:use|forward|import)\s+([^;{}\n]+(?:\n[^;{}@]+)*)/g;
const QUOTED = /url\(\s*["']?([^"')]+)["']?\s*\)|["']([^"']+)["']/g;

/** Specifiers a stylesheet imports, in source order. */
export function styleImports(content: string, path = ""): string[] {
  const text = content.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
  const out: string[] = [];
  for (const m of text.matchAll(STATEMENT)) {
    // `@use "x" with (…)`, `@forward "x" show a` : only the first part names files.
    const clause = (m[1] as string).split(/\s(?:with|as|show|hide)\s/)[0] as string;
    let found = false;
    for (const q of clause.matchAll(QUOTED)) {
      const spec = (q[1] ?? q[2] ?? "").trim();
      if (spec) out.push(spec);
      found = true;
    }
    // The indented syntax (`.sass`) also allows unquoted paths: `@import a, b`.
    if (!found && path.endsWith(".sass"))
      for (const part of clause.split(",")) {
        const spec = part.trim().split(/\s/)[0];
        if (spec) out.push(spec);
      }
  }
  return out.filter((s) => !/^(?:sass:|https?:|\/\/|data:)/.test(s));
}

/** `src/styles/_vars.scss` → `src/styles/vars`; `theme/_index.scss` → `theme`. */
export function styleKey(path: string): string {
  let p = path.replace(/^~/, "").replace(/[?#].*$/, "");
  p = p.replace(STYLESHEET, "");
  p = p.replace(/\/_?index$/, "");
  const slash = p.lastIndexOf("/");
  return `${p.slice(0, slash + 1)}${p.slice(slash + 1).replace(/^_/, "")}`;
}

function matches(importer: string, spec: string, targetKey: string): boolean {
  if (spec.startsWith(".")) {
    const dir = posix.dirname(importer);
    return styleKey(posix.normalize(posix.join(dir === "." ? "" : dir, spec))) === targetKey;
  }
  // Root-relative, load paths, packages: any stylesheet whose path ends with the specifier. Sass
  // also tries a bare specifier relative to the importer first.
  const dir = posix.dirname(importer);
  const key = styleKey(spec.replace(/^\//, ""));
  if (!key) return false;
  return (
    styleKey(posix.normalize(posix.join(dir === "." ? "" : dir, spec))) === targetKey ||
    targetKey === key ||
    targetKey.endsWith(`/${key}`)
  );
}

/**
 * For each changed stylesheet, the project stylesheets that import it directly or transitively.
 * `files` is the project listing (relative POSIX paths); only stylesheets in it are read.
 */
export async function stylesheetImporters(
  root: string,
  files: readonly string[],
  changed: readonly string[],
): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  const targets = changed.filter((f) => STYLESHEET.test(f));
  if (!targets.length) return out;
  const sheets = files.filter((f) => STYLESHEET.test(f) && !f.split("/").includes("node_modules"));
  const imports = new Map<string, string[]>();
  await Promise.all(
    sheets.map(async (f) => {
      const text = await readFile(join(root, f), "utf8").catch(() => "");
      const specs = styleImports(text, f);
      if (specs.length) imports.set(f, specs);
    }),
  );
  for (const changedSheet of targets) {
    const found = new Set<string>();
    let frontier = [changedSheet];
    while (frontier.length) {
      const keys = frontier.map(styleKey);
      const next: string[] = [];
      for (const [sheet, specs] of imports) {
        if (sheet === changedSheet || found.has(sheet)) continue;
        if (specs.some((s) => keys.some((k) => matches(sheet, s, k)))) {
          found.add(sheet);
          next.push(sheet);
        }
      }
      frontier = next;
    }
    if (found.size) out.set(changedSheet, [...found].sort());
  }
  return out;
}
