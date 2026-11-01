/**
 * Packages linked to folders outside the project (a workspace sibling installed as a symlink in
 * `node_modules`). Changes there are outside the project's change set, but project files run them.
 */
import { realpathSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import type { FileAnalysis } from "@smarttest/source-parser";

const packageName = (specifier: string): string | undefined => {
  if (/^[./#~]|^[a-z]+:/i.test(specifier)) return undefined;
  const parts = specifier.split("/");
  return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
};

/**
 * Importer → folders (relative to the project, `../shared`) of the packages it imports that are
 * links to somewhere outside the project and outside any `node_modules`.
 */
export function outsideLinks(
  root: string,
  files: ReadonlyMap<string, FileAnalysis>,
): Map<string, string[]> {
  const found = new Map<string, string | undefined>();
  /** The folder `name` resolves to from `dir` (Node's lookup through parent `node_modules`). */
  const lookup = (dir: string, name: string): string | undefined => {
    const k = `${dir}\0${name}`;
    if (found.has(k)) return found.get(k);
    let real: string | undefined;
    try {
      real = realpathSync(join(dir, "node_modules", name));
    } catch {
      const parent = dirname(dir);
      real = parent === dir ? undefined : lookup(parent, name);
    }
    found.set(k, real);
    return real;
  };
  const out = new Map<string, string[]>();
  let realRoot = root;
  try {
    realRoot = realpathSync(root);
  } catch {}
  for (const [file, a] of files) {
    const dirs = new Set<string>();
    for (const imp of a.imports) {
      if (imp.resolved) continue;
      const name = packageName(imp.specifier);
      if (!name) continue;
      const real = lookup(dirname(join(root, file)), name);
      if (!real) continue;
      const rel = relative(realRoot, real).split(sep).join("/");
      if (rel.startsWith("../") && !rel.split("/").includes("node_modules")) dirs.add(rel);
    }
    if (dirs.size) out.set(file, [...dirs].sort());
  }
  return out;
}
