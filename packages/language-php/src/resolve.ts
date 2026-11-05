/**
 * PHP name resolution (preview), as Composer's autoloader and Laravel's container find code:
 * `composer.json` `autoload` and `autoload-dev` (PSR-4, PSR-0, `classmap`, `files`), the classes,
 * functions and constants the project declares wherever they are, `config/app.php` aliases, and
 * the bindings of service providers.
 *
 * A class found nowhere in the project is external when its namespace is not one of the
 * project's (Laravel, PHPUnit, PHP itself). A class under a namespace the project autoloads that
 * no file declares is unresolved: uncertainty, so the tests that reach it are selected.
 */
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { ModuleResolver, ResolveResult } from "@smarttest/source-parser";
import { phpBindings } from "./analyze.js";
import { PHP_CLASSES } from "./builtins.js";

export const PHP_RESOLVER_VERSION = "php-r1";

interface ComposerProject {
  /** Project-relative folder of `composer.json` ("" = the root). */
  dir: string;
  /** PSR-4 prefixes (with their trailing `\`, lower case) → folders, longest prefix first. */
  psr4: [string, string[]][];
  psr0: [string, string[]][];
  /** Namespaces Composer installed into `vendor/` (lower case, trailing `\`). */
  vendor: string[];
}

const lc = (s: string) => s.toLowerCase();

function normalize(p: string): string {
  const out: string[] = [];
  for (const part of p.split("/")) {
    if (!part || part === ".") continue;
    if (part === ".." && out.length && out[out.length - 1] !== "..") out.pop();
    else out.push(part);
  }
  return out.join("/");
}

const up = (d: string) => (d.includes("/") ? d.slice(0, d.lastIndexOf("/")) : "");
const at = (dir: string, rel: string) => normalize(dir ? `${dir}/${rel}` : rel);

/** Declarations found by a light scan of a file (namespace, class-likes, functions, constants). */
function scanDeclarations(text: string): {
  classes: string[];
  functions: string[];
  consts: string[];
} {
  const classes: string[] = [];
  const functions: string[] = [];
  const consts: string[] = [];
  // Comments out (a declaration in a docblock is not one).
  const src = text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'])\/\/[^\n]*/g, "$1");
  let ns = "";
  const re =
    /(?:^|(?<=[;{}])|(?<=<\?php))[ \t]*(?:namespace[ \t]+([\w\\]+)[ \t]*[;{]|(?:(?:abstract|final|readonly)[ \t]+)*(?:class|interface|trait|enum)[ \t]+(\w+)|function[ \t]+&?[ \t]*(\w+)[ \t]*\(|const[ \t]+(\w+)[ \t]*=|define[ \t]*\([ \t]*['"](\w+)['"])/gm;
  for (const m of src.matchAll(re)) {
    const q = (n: string) => (ns ? `${ns}\\${n}` : n);
    if (m[1]) ns = m[1].replace(/^\\/, "");
    else if (m[2]) classes.push(q(m[2]));
    else if (m[3]) functions.push(q(m[3]));
    else if (m[4]) consts.push(q(m[4]));
    else if (m[5]) consts.push(m[5]);
  }
  return { classes, functions, consts };
}

export class PhpResolver implements ModuleResolver {
  private readonly cache = new Map<string, ResolveResult>();
  private readonly projects = new Map<string, ComposerProject | null>();
  private index:
    | {
        classes: Map<string, string>;
        functions: Map<string, string>;
        consts: Map<string, string>;
      }
    | undefined;
  private bindingIndex: Map<string, { file: string; concrete?: string }> | undefined;
  private aliases: Map<string, string> | undefined;

  /** `files`: the project's PHP files (project-relative), read when a scan is needed. */
  constructor(
    private readonly root: string,
    private readonly files: () => readonly string[] = () => [],
  ) {}

  private isFile(rel: string): boolean {
    try {
      return statSync(join(this.root, rel)).isFile();
    } catch {
      return false;
    }
  }

  private read(rel: string): string {
    try {
      return readFileSync(join(this.root, rel), "utf8");
    } catch {
      return "";
    }
  }

  private phpFiles(): string[] {
    return this.files().filter((f) => f.endsWith(".php"));
  }

  /** The Composer project a folder belongs to: the nearest `composer.json` above it. */
  private composerOf(dir: string): ComposerProject | undefined {
    for (let d = dir; ; d = up(d)) {
      const p = this.project(d);
      if (p) return p;
      if (!d) return undefined;
    }
  }

  private project(dir: string): ComposerProject | undefined {
    if (this.projects.has(dir)) return this.projects.get(dir) ?? undefined;
    const text = this.read(at(dir, "composer.json"));
    if (!text) {
      this.projects.set(dir, null);
      return undefined;
    }
    let json: Record<string, unknown> = {};
    try {
      json = JSON.parse(text) as Record<string, unknown>;
    } catch {
      json = {};
    }
    const psr4 = new Map<string, string[]>();
    const psr0 = new Map<string, string[]>();
    for (const section of ["autoload", "autoload-dev"]) {
      const a = (json[section] ?? {}) as Record<string, unknown>;
      for (const [map, into] of [
        ["psr-4", psr4],
        ["psr-0", psr0],
      ] as const) {
        const m = (a[map] ?? {}) as Record<string, string | string[]>;
        for (const [prefix, dirs] of Object.entries(m)) {
          const list = (Array.isArray(dirs) ? dirs : [dirs]).map((d) =>
            at(dir, String(d).replace(/\/$/, "")),
          );
          into.set(lc(prefix), [...(into.get(lc(prefix)) ?? []), ...list]);
        }
      }
    }
    // Namespaces of installed packages (vendor/composer/autoload_psr4.php): external, fast.
    const vendor: string[] = [];
    const installed = this.read(at(dir, "vendor/composer/autoload_psr4.php"));
    for (const m of installed.matchAll(/^\s*'((?:[^'\\]|\\.)*)'\s*=>/gm))
      vendor.push(lc((m[1] as string).replace(/\\\\/g, "\\")));
    const byLength = (m: Map<string, string[]>) =>
      [...m.entries()].sort((x, y) => y[0].length - x[0].length);
    const p: ComposerProject = { dir, psr4: byLength(psr4), psr0: byLength(psr0), vendor };
    this.projects.set(dir, p);
    return p;
  }

  /** Every class, function and constant the project's PHP files declare (built once). */
  private declarations() {
    if (this.index) return this.index;
    const classes = new Map<string, string>();
    const functions = new Map<string, string>();
    const consts = new Map<string, string>();
    for (const f of this.phpFiles()) {
      if (/(?:^|\/)vendor\//.test(f)) continue;
      const text = this.read(f);
      if (!/\b(?:class|interface|trait|enum|function|const|define)\b/.test(text)) continue;
      const d = scanDeclarations(text);
      for (const c of d.classes) if (!classes.has(lc(c))) classes.set(lc(c), f);
      for (const c of d.functions) if (!functions.has(lc(c))) functions.set(lc(c), f);
      for (const c of d.consts) if (!consts.has(c)) consts.set(c, f);
    }
    this.index = { classes, functions, consts };
    return this.index;
  }

  /** `config/app.php` aliases (`'Pay' => App\Facades\Pay::class`) of a Composer project. */
  private alias(name: string, project: ComposerProject | undefined): string | undefined {
    if (!this.aliases) {
      this.aliases = new Map();
      const text = this.read(at(project?.dir ?? "", "config/app.php"));
      // 'aliases' => [ … ], bracket-matched (its entries hold `::class` and nested calls).
      let block = "";
      const found = /['"]aliases['"]\s*=>\s*(\[|array\s*\()/.exec(text);
      if (found) {
        const start = found.index + found[0].length - 1;
        let depth = 0;
        for (let i = start; i < text.length; i++) {
          const c = text[i];
          if (c === "[" || c === "(") depth++;
          else if (c === "]" || c === ")") depth--;
          if (depth === 0) {
            block = text.slice(start + 1, i);
            break;
          }
        }
      }
      for (const m of block.matchAll(
        /['"](\w+)['"]\s*=>\s*(?:\\?([\w\\]+)::class|['"]\\?([\w\\]+)['"])/g,
      ))
        this.aliases.set(lc(m[1] as string), ((m[2] ?? m[3]) as string).replace(/\\\\/g, "\\"));
    }
    return this.aliases.get(lc(name));
  }

  /** Container bindings of the project (service providers): key → concrete class or provider. */
  private bindings(): Map<string, { file: string; concrete?: string }> {
    if (this.bindingIndex) return this.bindingIndex;
    const out = new Map<string, { file: string; concrete?: string }>();
    for (const f of this.phpFiles()) {
      if (/(?:^|\/)vendor\//.test(f)) continue;
      const text = this.read(f);
      if (!/(?:->|::)\s*(?:bind|singleton|scoped|instance)(?:If)?\s*\(/.test(text)) continue;
      for (const b of phpBindings(f, text)) {
        const key = b.isClass ? `class:${lc(b.key)}` : `key:${b.key}`;
        if (!out.has(key))
          out.set(key, { file: f, ...(b.concrete ? { concrete: b.concrete } : {}) });
      }
    }
    this.bindingIndex = out;
    return out;
  }

  /** The file declaring class `fqcn`, or why it has none. */
  private findClass(
    fqcn: string,
    fromDir: string,
    seen = new Set<string>(),
  ): { file?: string; projectNamespace?: boolean } {
    const name = fqcn.replace(/^\\/, "");
    const key = lc(name);
    if (seen.has(key)) return {};
    seen.add(key);
    const projects = [this.composerOf(fromDir), this.project("")].filter(
      (p, i, all): p is ComposerProject => !!p && all.indexOf(p) === i,
    );
    let projectNamespace = false;
    for (const p of projects) {
      for (const [prefix, dirs] of p.psr4) {
        if (!key.startsWith(prefix)) continue;
        projectNamespace = true;
        const rel = `${name.slice(prefix.length).replace(/\\/g, "/")}.php`;
        for (const d of dirs) {
          const f = at(d, rel);
          if (this.isFile(f)) return { file: f };
        }
      }
      for (const [prefix, dirs] of p.psr0) {
        if (!key.startsWith(prefix)) continue;
        projectNamespace = true;
        const cut = name.lastIndexOf("\\");
        const nsPath = cut < 0 ? "" : `${name.slice(0, cut).replace(/\\/g, "/")}/`;
        const rel = `${nsPath}${name.slice(cut + 1).replace(/_/g, "/")}.php`;
        for (const d of dirs) {
          const f = at(d, rel);
          if (this.isFile(f)) return { file: f };
        }
      }
    }
    // PHP's own classes and installed packages: external without reading the project.
    if (!name.includes("\\") && PHP_CLASSES.has(key)) return {};
    if (
      !projectNamespace &&
      projects.some((p) => p.vendor.some((v) => key.startsWith(v))) &&
      !projects.some((p) => p.psr4.some(([x]) => x && key.startsWith(x)))
    )
      return {};
    const declared = this.declarations().classes.get(key);
    if (declared) return { file: declared };
    if (!name.includes("\\")) {
      const target = this.alias(name, projects[0]);
      if (target) {
        const r = this.findClass(target, fromDir, seen);
        if (r.file) return r;
      }
    }
    return { projectNamespace };
  }

  resolve(fromFile: string, specifier: string): ResolveResult {
    const fromDir = up(fromFile);
    // Relative paths depend on the importing folder; everything else on its Composer project.
    const cacheKey = `${fromDir}\u0000${specifier}`;
    const hit = this.cache.get(cacheKey);
    if (hit) return hit;
    const r = this.resolveUncached(fromDir, specifier);
    this.cache.set(cacheKey, r);
    return r;
  }

  private resolveUncached(fromDir: string, specifier: string): ResolveResult {
    const external = { external: true } as const;
    const fromPath = (p: string) => p.replace(/\//g, "\\");
    if (specifier.startsWith("@class/") || specifier.startsWith("@class-string/")) {
      const fqcn = fromPath(specifier.slice(specifier.indexOf("/") + 1));
      const r = this.findClass(fqcn, fromDir);
      if (r.file) return { resolved: r.file };
      if (r.projectNamespace && specifier.startsWith("@class/"))
        return {
          reason: `no class ${fqcn} in the project, though its namespace is the project's (composer.json autoload)`,
        };
      return external;
    }
    for (const [prefix, kind] of [
      ["@fn?/", "functions"],
      ["@fn/", "functions"],
      ["@const?/", "consts"],
      ["@const/", "consts"],
    ] as const) {
      if (!specifier.startsWith(prefix)) continue;
      const fq = fromPath(specifier.slice(prefix.length));
      const index = this.declarations()[kind];
      const find = (n: string) => (kind === "consts" ? index.get(n) : index.get(lc(n)));
      const found =
        find(fq) ?? (prefix.includes("?") ? find(fq.slice(fq.lastIndexOf("\\") + 1)) : undefined);
      if (found) return { resolved: found };
      // A function of PHP itself or of an installed package (Laravel's helpers).
      return external;
    }
    if (specifier.startsWith("@bound/") || specifier.startsWith("@bind-key/")) {
      const isClass = specifier.startsWith("@bound/");
      const key = isClass ? fromPath(specifier.slice(7)) : specifier.slice(10);
      const b = this.bindings().get(isClass ? `class:${lc(key)}` : `key:${key}`);
      if (!b) return external;
      // An interface (or a key) bound to a class: that class. A class bound to itself, or a
      // closure whose class cannot be read, adds nothing: the container only builds it for a
      // test that boots the application, and such a test already loads every provider.
      if (b.concrete && lc(b.concrete) !== lc(key)) {
        const c = this.findClass(b.concrete, up(b.file));
        if (c.file) return { resolved: c.file };
      }
      return external;
    }
    if (specifier === "@app-boot") {
      const p = this.composerOf(fromDir);
      const f = at(p?.dir ?? "", "bootstrap/app.php");
      return this.isFile(f) ? { resolved: f } : external;
    }
    if (specifier.startsWith("@pest/")) {
      for (let d = specifier.slice(6); ; d = up(d)) {
        const f = at(d, "Pest.php");
        if (this.isFile(f)) return { resolved: f };
        if (!d) break;
      }
      return external;
    }
    if (specifier.startsWith("@composer/")) {
      const p = this.composerOf(fromDir);
      const f = at(p?.dir ?? "", specifier.slice(10));
      if (/(?:^|\/)vendor\//.test(f)) return external;
      return this.isFile(f) ? { resolved: f } : external;
    }
    if (specifier.startsWith(".") || specifier.startsWith("/")) {
      if (specifier.startsWith("/")) return external; // an absolute path: outside the project
      const rel = normalize(fromDir ? `${fromDir}/${specifier}` : specifier);
      if (rel.startsWith("..")) return external;
      if (/(?:^|\/)vendor\//.test(rel)) return external;
      if (this.isFile(rel)) return { resolved: rel };
      // PHP looks a relative include up in the include path (the working folder) too.
      const p = this.composerOf(fromDir);
      const fromRoot = at(p?.dir ?? "", specifier);
      if (this.isFile(fromRoot) && !/(?:^|\/)vendor\//.test(fromRoot))
        return { resolved: fromRoot };
      return external;
    }
    return { reason: `unknown PHP reference "${specifier}"` };
  }

  /**
   * Files that change how references resolve (they key the stored resolutions): Composer's
   * manifests and installed namespaces, the aliases, and the service providers' bindings.
   */
  inputs(files: readonly string[]): string[] {
    const out = new Set<string>();
    for (const f of files) {
      if (/(?:^|\/)composer\.json$/.test(f)) out.add(f);
      if (/(?:^|\/)Providers\/[^/]+\.php$/.test(f) || /(?:^|\/)bootstrap\/providers\.php$/.test(f))
        out.add(f);
      if (/(?:^|\/)config\/app\.php$/.test(f)) out.add(f);
    }
    out.add("composer.json");
    out.add("vendor/composer/autoload_psr4.php");
    return [...out].sort();
  }
}
