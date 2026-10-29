import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { builtinModules } from "node:module";
import { dirname, join } from "node:path";
import { relPosix, toPosix } from "@smarttest/shared";
import type { ModuleResolver, ResolveResult } from "@smarttest/source-parser";
import ts from "typescript";

export interface WorkspaceEntry {
  name: string;
  dir: string;
  manifest: { exports?: unknown; main?: string; module?: string; source?: string; types?: string };
}

const BUILTINS = new Set(builtinModules);
const PROBE_EXTS = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs", ".json"];
const CONDITIONS = [
  "@smarttest/source",
  "source",
  "development",
  "import",
  "module",
  "node",
  "default",
  "require",
  "types",
];

function isFile(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

function pickExport(value: unknown, subpath: string): string | undefined {
  if (typeof value === "string") return subpath === "." ? value : undefined;
  if (!value || typeof value !== "object") return undefined;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj);
  if (keys.some((k) => k.startsWith("."))) {
    const entry = obj[subpath] ?? (subpath === "." ? undefined : obj[`${subpath}.js`]);
    if (entry !== undefined) return pickExport(entry, ".");
    // wildcard subpath patterns: "./*": "./src/*.ts"
    for (const k of keys) {
      if (!k.includes("*")) continue;
      const [pre, post] = k.split("*") as [string, string];
      if (subpath.startsWith(pre) && subpath.endsWith(post)) {
        const target = pickExport(obj[k], ".");
        return target?.replace("*", subpath.slice(pre.length, subpath.length - post.length));
      }
    }
    return undefined;
  }
  for (const c of CONDITIONS)
    if (c in obj) {
      const r = pickExport(obj[c], ".");
      if (r) return r;
    }
  return undefined;
}

/** Maps a built artifact path (dist/*.js, *.d.ts) back to its source when possible. */
function toSource(
  absPkgDir: string,
  rel: string,
  fileExists: (p: string) => boolean = isFile,
): string | undefined {
  const candidates: string[] = [];
  const clean = rel.replace(/^\.\//, "");
  candidates.push(clean);
  const swapped = clean.replace(/^(dist|build|lib|out|esm|cjs)\//, "src/");
  const stripExt = (p: string) => p.replace(/\.d\.[cm]?ts$|\.[cm]?[jt]sx?$/, "");
  for (const base of [stripExt(clean), stripExt(swapped)])
    for (const e of PROBE_EXTS) candidates.push(base + e);
  for (const e of [".ts", ".tsx", ".js", ".mjs"]) candidates.push(`src/index${e}`);
  for (const c of candidates) {
    const abs = join(absPkgDir, c);
    if (fileExists(abs) && !/\.d\.[cm]?ts$/.test(c) && !/^(dist|build|out)\//.test(c)) return abs;
  }
  return undefined;
}

export class TypeScriptResolver implements ModuleResolver {
  private optionsByDir = new Map<string, ts.CompilerOptions>();
  private caches = new Map<ts.CompilerOptions, ts.ModuleResolutionCache>();
  private configByPath = new Map<string, ts.CompilerOptions>();
  private readonly workspaces: (WorkspaceEntry & { abs: string })[];
  private readonly realRoot: string;
  // File-system lookups are memoized for the lifetime of the resolver (one index update).
  private readonly files = new Map<string, boolean>();
  private readonly dirs = new Map<string, boolean>();
  private readonly reals = new Map<string, string>();
  private readonly host: ts.ModuleResolutionHost = {
    fileExists: (p) => this.isFile(p),
    readFile: (p) => ts.sys.readFile(p),
    directoryExists: (p) => {
      let v = this.dirs.get(p);
      if (v === undefined) {
        v = ts.sys.directoryExists(p);
        this.dirs.set(p, v);
      }
      return v;
    },
    realpath: (p) => this.realpath(p),
    getCurrentDirectory: () => this.root,
    getDirectories: (p) => ts.sys.getDirectories(p),
  };

  private isFile(p: string): boolean {
    let v = this.files.get(p);
    if (v === undefined) {
      v = isFile(p);
      this.files.set(p, v);
    }
    return v;
  }

  private realpath(p: string): string {
    let v = this.reals.get(p);
    if (v === undefined) {
      try {
        v = realpathSync(p);
      } catch {
        v = p;
      }
      this.reals.set(p, v);
    }
    return v;
  }

  constructor(
    private readonly root: string,
    workspaces: WorkspaceEntry[] = [],
  ) {
    this.realRoot = realpathSync(root);
    this.workspaces = workspaces
      .map((w) => ({ ...w, abs: join(root, w.dir) }))
      .sort((a, b) => b.name.length - a.name.length);
  }

  private rel(abs: string): string | undefined {
    const real = this.realpath(abs);
    return relPosix(this.realRoot, real) ?? relPosix(this.root, abs);
  }

  private optionsFor(absDir: string): ts.CompilerOptions {
    const cached = this.optionsByDir.get(absDir);
    if (cached) return cached;
    let opts: ts.CompilerOptions | undefined;
    let dir = absDir;
    for (;;) {
      for (const name of ["tsconfig.json", "jsconfig.json"]) {
        const p = join(dir, name);
        if (existsSync(p)) {
          opts = this.configByPath.get(p);
          if (!opts) {
            const read = ts.readConfigFile(p, (f) => ts.sys.readFile(f));
            const parsed = ts.parseJsonConfigFileContent(
              read.config ?? {},
              ts.sys,
              dir,
              undefined,
              p,
            );
            opts = { ...parsed.options, allowJs: true, resolveJsonModule: true };
            if (
              opts.moduleResolution === undefined ||
              opts.moduleResolution === ts.ModuleResolutionKind.Classic
            ) {
              opts.moduleResolution = ts.ModuleResolutionKind.Bundler;
              opts.module = ts.ModuleKind.ESNext;
            }
            this.configByPath.set(p, opts);
          }
          break;
        }
      }
      if (opts || toPosix(dir) === toPosix(this.root)) break;
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
    const finalOpts = opts ?? {
      allowJs: true,
      resolveJsonModule: true,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      module: ts.ModuleKind.ESNext,
    };
    this.optionsByDir.set(absDir, finalOpts);
    return finalOpts;
  }

  private cacheFor(opts: ts.CompilerOptions): ts.ModuleResolutionCache {
    let c = this.caches.get(opts);
    if (!c) {
      c = ts.createModuleResolutionCache(this.root, (s) => s, opts);
      this.caches.set(opts, c);
    }
    return c;
  }

  private probe(absBase: string): string | undefined {
    if (this.isFile(absBase)) return absBase;
    const noJs = absBase.replace(/\.(?:[cm]?js|jsx)$/, "");
    for (const base of noJs !== absBase ? [noJs, absBase] : [absBase]) {
      for (const e of PROBE_EXTS) if (this.isFile(base + e)) return base + e;
    }
    for (const e of PROBE_EXTS)
      if (this.isFile(join(absBase, `index${e}`))) return join(absBase, `index${e}`);
    return undefined;
  }

  private finish(abs: string | undefined, specifier: string): ResolveResult {
    if (!abs) return { reason: `cannot resolve "${specifier}"` };
    if (/\.d\.[cm]?ts$/.test(abs)) {
      const impl = this.probe(abs.replace(/\.d\.[cm]?ts$/, ""));
      if (impl && !/\.d\.[cm]?ts$/.test(impl)) abs = impl;
      else return { external: true };
    }
    const rel = this.rel(abs);
    if (rel === undefined || rel.split("/").includes("node_modules")) return { external: true };
    return { resolved: rel };
  }

  resolve(fromFile: string, specifier: string): ResolveResult {
    if (
      specifier.startsWith("node:") ||
      BUILTINS.has(specifier) ||
      BUILTINS.has(specifier.split("/")[0] ?? "")
    )
      return { external: true };
    if (/^[a-z]+:/i.test(specifier) && !/^[a-zA-Z]:[\\/]/.test(specifier))
      return { external: true };
    const absFrom = join(this.root, fromFile);
    const relative = specifier.startsWith(".") || specifier.startsWith("/");

    if (!relative) {
      for (const ws of this.workspaces) {
        if (specifier === ws.name || specifier.startsWith(`${ws.name}/`)) {
          const sub = specifier === ws.name ? "." : `.${specifier.slice(ws.name.length)}`;
          const target =
            pickExport(ws.manifest.exports, sub) ??
            (sub === "."
              ? (ws.manifest.source ?? ws.manifest.module ?? ws.manifest.main ?? "index.js")
              : sub);
          const src =
            toSource(ws.abs, target, (p) => this.isFile(p)) ??
            (sub !== "." ? this.probe(join(ws.abs, sub)) : undefined);
          if (src) return this.finish(src, specifier);
          return { reason: `workspace package "${ws.name}" entry "${target}" has no source file` };
        }
      }
    }

    const opts = this.optionsFor(dirname(absFrom));
    const res = ts.resolveModuleName(specifier, absFrom, opts, this.host, this.cacheFor(opts));
    const resolved = res.resolvedModule;
    if (resolved && !(resolved.isExternalLibraryImport && !this.rel(resolved.resolvedFileName))) {
      const out = this.finish(resolved.resolvedFileName, specifier);
      if (out.resolved || out.external) return out;
    }
    if (relative) {
      const abs = this.probe(join(dirname(absFrom), specifier));
      const out = this.finish(abs, specifier);
      return out.resolved || out.external
        ? out
        : { reason: `relative import "${specifier}" does not resolve to a file` };
    }
    // alias that should resolve inside the project?
    const paths = opts.paths ?? {};
    for (const key of Object.keys(paths)) {
      const re = new RegExp(`^${key.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace("*", ".*")}$`);
      if (re.test(specifier))
        return { reason: `path alias "${key}" did not resolve "${specifier}"` };
    }
    return { external: true };
  }
}

export function readJsonSafe(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
}
