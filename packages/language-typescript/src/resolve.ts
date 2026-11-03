import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { builtinModules } from "node:module";
import { dirname, join } from "node:path";
import { relPosix, toPosix } from "@smarttest/shared";
import type { ModuleResolver, ResolveResult } from "@smarttest/source-parser";
import ts from "typescript";
import {
  ALIAS_CONFIGS,
  type AliasConfig,
  type AliasTool,
  matchAlias,
  readAliasConfig,
} from "./bundler-aliases.js";

export interface WorkspaceEntry {
  name: string;
  dir: string;
  manifest: { exports?: unknown; main?: string; module?: string; source?: string; types?: string };
}

/**
 * Bumped when resolution changes, so stored resolutions are redone (2: tsconfig references;
 * 3: local names before builtins, declared dependencies, export conditions, package `imports`,
 * the tsconfig project that includes the file, imports outside the root; 4: bundler and
 * test-runner aliases, root-absolute glob patterns).
 */
export const RESOLVER_VERSION = 5;
const ALIAS_TOOLS = Object.keys(ALIAS_CONFIGS) as AliasTool[];
const BUILTINS = new Set(builtinModules);
/**
 * Modules a framework generates or serves (Wasp's SDK, SvelteKit, Nuxt): not npm installs. They
 * count only when the framework is there (a declared dependency or its marker file at the root).
 */
const FRAMEWORK_MODULES: Record<string, { deps: string[]; markers: string[] }> = {
  wasp: { deps: ["wasp"], markers: ["main.wasp", "main.wasp.ts", ".wasproot"] },
  $app: { deps: ["@sveltejs/kit"], markers: [] },
  $env: { deps: ["@sveltejs/kit"], markers: [] },
  "$service-worker": { deps: ["@sveltejs/kit"], markers: [] },
  "#app": { deps: ["nuxt", "nuxt3"], markers: ["nuxt.config.ts", "nuxt.config.js"] },
  "#imports": { deps: ["nuxt", "nuxt3"], markers: ["nuxt.config.ts", "nuxt.config.js"] },
};
const FRAMEWORK_MARKERS = [...new Set(Object.values(FRAMEWORK_MODULES).flatMap((f) => f.markers))];
const DEP_FIELDS = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"];
/**
 * Reads tsconfig files (and what they extend) without listing the project's files: only the
 * compiler options are used, and `include` globbing costs a directory walk of the whole project.
 */
const OPTIONS_ONLY_HOST: ts.ParseConfigHost = {
  useCaseSensitiveFileNames: ts.sys.useCaseSensitiveFileNames,
  fileExists: (f) => ts.sys.fileExists(f),
  readFile: (f) => ts.sys.readFile(f),
  readDirectory: () => [],
};
const PROBE_EXTS = [
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".json",
  ".vue",
  ".svelte",
];
const DTS = /\.d\.[cm]?ts$/;
/** Directories a package build writes to; never a workspace package's source. */
const BUILD_OUTPUT = /^(dist|build|out)\//;
const VITE_CONFIGS = ["vite.config.ts", "vite.config.js", "vite.config.mjs", "vite.config.mts"];

function isFile(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

function inNodeModules(p: string): boolean {
  return toPosix(p).split("/").includes("node_modules");
}

/** The `*` key matching `subpath` with the longest prefix (Node's rule), and what `*` stands for. */
function matchPattern(
  keys: readonly string[],
  subpath: string,
): { key: string; star: string } | undefined {
  let best: { key: string; star: string } | undefined;
  for (const k of keys) {
    const at = k.indexOf("*");
    if (at < 0) continue;
    const pre = k.slice(0, at);
    const post = k.slice(at + 1);
    if (subpath.length < pre.length + post.length) continue;
    if (!subpath.startsWith(pre) || !subpath.endsWith(post)) continue;
    if (!best || pre.length > best.key.indexOf("*"))
      best = { key: k, star: subpath.slice(pre.length, subpath.length - post.length) };
  }
  return best;
}

/**
 * Every file an `exports` (or `imports`) value can point `subpath` to: the targets of all
 * conditions, since a test environment can pick any of them (`browser` under jsdom, `node`…).
 */
function exportTargets(value: unknown, subpath: string): string[] {
  if (typeof value === "string") return subpath === "." ? [value] : [];
  if (Array.isArray(value)) return value.flatMap((v) => exportTargets(v, subpath));
  if (!value || typeof value !== "object") return [];
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj);
  if (keys.some((k) => k.startsWith("."))) {
    const entry = obj[subpath] ?? (subpath === "." ? undefined : obj[`${subpath}.js`]);
    if (entry !== undefined) return exportTargets(entry, ".");
    // wildcard subpath patterns: "./*": "./src/*.ts"
    const m = matchPattern(keys, subpath);
    return m ? exportTargets(obj[m.key], ".").map((t) => t.replaceAll("*", m.star)) : [];
  }
  return [...new Set(keys.flatMap((k) => exportTargets(obj[k], ".")))];
}

/**
 * Maps a built artifact path (dist/*.js, *.d.ts) back to its source when possible: the source
 * swap (`lib/x.js` → `src/x.ts`) comes before the path itself, so a build left on disk never wins.
 */
function toSource(
  absPkgDir: string,
  rel: string,
  fileExists: (p: string) => boolean = isFile,
  packageEntry = false,
): string | undefined {
  const candidates: string[] = [];
  const clean = rel.replace(/^\.\//, "");
  const swapped = clean.replace(/^(dist|build|lib|out|esm|cjs)\//, "src/");
  const stripExt = (p: string) => p.replace(/\.d\.[cm]?ts$|\.[cm]?[jt]sx?$/, "");
  if (swapped !== clean) for (const e of PROBE_EXTS) candidates.push(stripExt(swapped) + e);
  candidates.push(clean);
  for (const e of PROBE_EXTS) candidates.push(stripExt(clean) + e);
  if (packageEntry)
    for (const e of [".ts", ".tsx", ".js", ".mjs"]) candidates.push(`src/index${e}`);
  for (const c of candidates) {
    const abs = join(absPkgDir, c);
    if (fileExists(abs) && !DTS.test(c) && !BUILD_OUTPUT.test(c)) return abs;
  }
  return undefined;
}

/** A tsconfig `include`/`exclude` spec as a regular expression over absolute POSIX paths. */
function specRegExp(dir: string, spec: string): RegExp {
  const abs = toPosix(join(dir, spec));
  const segs = abs.split("/");
  const last = segs[segs.length - 1] ?? "";
  // "src" (no wildcard, no extension) names a directory and everything below it.
  const dirLike = !/[*?]/.test(last) && !/\.[A-Za-z0-9]+$/.test(last);
  let re = "";
  for (const [i, s] of segs.entries()) {
    const isLast = i === segs.length - 1;
    if (s === "**") {
      re += isLast ? ".*" : "(?:[^/]+/)*";
      continue;
    }
    re += s
      .replace(/[.+^${}()|[\]\\]/g, "\\$&")
      .replace(/\*/g, "[^/]*")
      .replace(/\?/g, "[^/]");
    if (!isLast) re += "/";
  }
  return new RegExp(`^${re}${dirLike ? "(?:/.*)?" : ""}$`);
}

/** Whether a tsconfig's `files`/`include`/`exclude` take in a file (absolute path). */
function containsFn(dir: string, raw: unknown): (absFile: string) => boolean {
  const r = (raw ?? {}) as { files?: unknown; include?: unknown; exclude?: unknown };
  const strings = (v: unknown) =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : undefined;
  const files = strings(r.files);
  const include = strings(r.include) ?? (files ? [] : ["**/*"]);
  const exclude = strings(r.exclude) ?? [];
  const fileSet = new Set((files ?? []).map((f) => toPosix(join(dir, f))));
  const inc = include.map((s) => specRegExp(dir, s));
  const exc = exclude.map((s) => specRegExp(dir, s));
  return (absFile) => {
    const a = toPosix(absFile);
    return fileSet.has(a) || (inc.some((x) => x.test(a)) && !exc.some((x) => x.test(a)));
  };
}

/** The compiler options of one tsconfig project, and which files the project includes. */
interface Project {
  opts: ts.CompilerOptions;
  contains: (absFile: string) => boolean;
}

type PackageJson = Record<string, unknown>;

export class TypeScriptResolver implements ModuleResolver {
  private optionsByDir = new Map<string, Project[]>();
  private caches = new Map<ts.CompilerOptions, ts.ModuleResolutionCache>();
  private configByPath = new Map<string, Project[]>();
  private readonly workspaces: (WorkspaceEntry & { abs: string })[];
  private readonly realRoot: string;
  // File-system lookups are memoized for the lifetime of the resolver (one index update).
  private readonly files = new Map<string, boolean>();
  private readonly dirs = new Map<string, boolean>();
  private readonly reals = new Map<string, string>();
  private readonly packages = new Map<string, PackageJson | undefined>();
  private readonly declaredByDir = new Map<string, Set<string>>();
  /** Every file read to decide resolutions (tsconfig chains, package.json files): the cache key. */
  private readonly inputs = new Set<string>();
  private readonly aliasByDir = new Map<string, AliasConfig[]>();
  private readonly aliasByFile = new Map<string, AliasConfig | undefined>();
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

  /** `realpathSync.native`: on a case-insensitive file system it also restores the real casing. */
  private realpath(p: string): string {
    let v = this.reals.get(p);
    if (v === undefined) {
      try {
        v = realpathSync.native(p);
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
    this.realRoot = realpathSync.native(root);
    this.workspaces = workspaces
      .map((w) => ({ ...w, abs: join(root, w.dir) }))
      .sort((a, b) => b.name.length - a.name.length);
  }

  private rel(abs: string): string | undefined {
    const real = this.realpath(abs);
    return relPosix(this.realRoot, real) ?? relPosix(this.root, abs);
  }

  /**
   * The files that decide how `files` (root-relative) resolve: every tsconfig/jsconfig read (with
   * the configs they extend and reference), every package.json consulted and the framework marker
   * files. Root-relative when inside the root. Their content keys the stored resolutions.
   */
  inputsFor(files: readonly string[]): string[] {
    const dirs = new Set(files.map((f) => dirname(join(this.root, f))));
    for (const d of dirs) {
      this.optionsFor(d);
      this.declared(d);
      this.nearestPackage(d);
      this.aliasConfigs(d);
      for (const m of FRAMEWORK_MARKERS) if (this.isFile(join(d, m))) this.inputs.add(join(d, m));
    }
    return [...this.inputs].map((p) => relPosix(this.root, p) ?? toPosix(p)).sort();
  }

  /**
   * The nearest config's projects, then those of the projects it references: a solution-style
   * `tsconfig.json` (`files: []` and `references`, Vite's template) keeps its `paths` in
   * `tsconfig.app.json`.
   */
  private optionsFor(absDir: string): Project[] {
    const cached = this.optionsByDir.get(absDir);
    if (cached) return cached;
    let list: Project[] | undefined;
    let dir = absDir;
    for (;;) {
      for (const name of ["tsconfig.json", "jsconfig.json"]) {
        const p = join(dir, name);
        if (existsSync(p)) {
          list = this.configByPath.get(p);
          if (!list) {
            list = this.readOptions(p, new Set());
            this.configByPath.set(p, list);
          }
          break;
        }
      }
      if (list || toPosix(dir) === toPosix(this.root)) break;
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
    const finalList = list ?? [
      {
        opts: {
          allowJs: true,
          resolveJsonModule: true,
          moduleResolution: ts.ModuleResolutionKind.Bundler,
          module: ts.ModuleKind.ESNext,
        },
        contains: () => false,
      },
    ];
    this.optionsByDir.set(absDir, finalList);
    return finalList;
  }

  private readOptions(p: string, seen: Set<string>): Project[] {
    if (seen.has(p)) return [];
    seen.add(p);
    this.inputs.add(p);
    const source = ts.readJsonConfigFile(p, (f) => ts.sys.readFile(f));
    const parsed = ts.parseJsonSourceFileConfigFileContent(
      source,
      OPTIONS_ONLY_HOST,
      dirname(p),
      undefined,
      p,
    );
    // The configs it extends (`./config/base.json`, `@tsconfig/node20/tsconfig.json`).
    for (const f of source.extendedSourceFiles ?? []) this.inputs.add(f);
    const opts: ts.CompilerOptions = { ...parsed.options, allowJs: true, resolveJsonModule: true };
    if (
      opts.moduleResolution === undefined ||
      opts.moduleResolution === ts.ModuleResolutionKind.Classic
    ) {
      opts.moduleResolution = ts.ModuleResolutionKind.Bundler;
      opts.module = ts.ModuleKind.ESNext;
    }
    const refs = (parsed.projectReferences ?? []).flatMap((r) => {
      const f = ts.resolveProjectReferencePath(r);
      return existsSync(f) ? this.readOptions(f, seen) : [];
    });
    return [{ opts, contains: containsFn(dirname(p), parsed.raw) }, ...refs];
  }

  private packageJson(dir: string): PackageJson | undefined {
    if (this.packages.has(dir)) return this.packages.get(dir);
    const p = join(dir, "package.json");
    let v: PackageJson | undefined;
    if (this.isFile(p)) {
      this.inputs.add(p);
      const json = readJsonSafe(p);
      v = json && typeof json === "object" ? (json as PackageJson) : {};
    }
    this.packages.set(dir, v);
    return v;
  }

  private nearestPackage(dir: string): { dir: string; json: PackageJson } | undefined {
    for (let d = dir; ; d = dirname(d)) {
      const json = this.packageJson(d);
      if (json) return { dir: d, json };
      if (dirname(d) === d) return undefined;
    }
  }

  /**
   * Package names the package.json files from `dir` up declare (dependencies of every kind and
   * their own names), up to the workspace or repository root. Only a declared package counts as
   * installed: a name found in `node_modules` may be hoisted there for another package, and with
   * nothing installed yet every name would count.
   */
  private declared(dir: string): Set<string> {
    const cached = this.declaredByDir.get(dir);
    if (cached) return cached;
    const pkg = this.packageJson(dir);
    const own = new Set<string>();
    if (pkg) {
      if (typeof pkg.name === "string") own.add(pkg.name);
      for (const field of DEP_FIELDS) {
        const deps = pkg[field];
        if (deps && typeof deps === "object") for (const k of Object.keys(deps)) own.add(k);
      }
    }
    const top =
      dirname(dir) === dir ||
      !!pkg?.workspaces ||
      existsSync(join(dir, "pnpm-workspace.yaml")) ||
      existsSync(join(dir, ".git"));
    const set = top ? own : new Set([...own, ...this.declared(dirname(dir))]);
    this.declaredByDir.set(dir, set);
    return set;
  }

  /** A framework's module, when the framework is there (declared, or its marker file above). */
  private frameworkModule(absFrom: string, specifier: string): boolean {
    const fw = FRAMEWORK_MODULES[specifier.split("/")[0] as string];
    if (!fw) return false;
    const declared = this.declared(dirname(absFrom));
    if (fw.deps.some((d) => declared.has(d))) return true;
    for (let d = dirname(absFrom); this.rel(d) !== undefined; d = dirname(d)) {
      for (const m of fw.markers)
        if (this.isFile(join(d, m))) {
          this.inputs.add(join(d, m));
          return true;
        }
      if (toPosix(d) === toPosix(this.root) || dirname(d) === d) break;
    }
    return false;
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

  /** A declaration or build output of a project package, mapped to its source. */
  private packageSource(abs: string): string | undefined {
    for (let d = dirname(abs); ; d = dirname(d)) {
      if (this.rel(d) === undefined) return undefined;
      if (this.packageJson(d)) {
        const inPkg = relPosix(d, abs);
        return inPkg === undefined ? undefined : toSource(d, inPkg, (p) => this.isFile(p));
      }
      if (dirname(d) === d) return undefined;
    }
  }

  private finish(abs: string | undefined, specifier: string): ResolveResult {
    if (!abs) return { reason: `cannot resolve "${specifier}"` };
    if (inNodeModules(this.realpath(abs))) return { external: true };
    // A package's declarations or build output (`dist/index.d.ts`, `dist/index.js` reached through
    // a linked package), mapped back to the source it is built from.
    const bare = !specifier.startsWith(".") && !specifier.startsWith("/");
    const relBefore = this.rel(abs);
    if (
      DTS.test(abs) ||
      (bare && relBefore !== undefined && /(^|\/)(dist|build|out)\//.test(relBefore))
    ) {
      const src = this.packageSource(abs);
      if (src) abs = src;
      else if (DTS.test(abs)) {
        const impl = this.probe(abs.replace(DTS, ""));
        if (impl && !DTS.test(impl)) abs = impl;
        else return { external: true };
      }
    }
    const rel = this.rel(abs);
    // Code outside the root can change without SmartTest seeing it: never "external".
    if (rel === undefined)
      return {
        reason: `"${specifier}" resolves outside the project root (${toPosix(this.realpath(abs))})`,
      };
    return { resolved: rel };
  }

  /** One outcome from several candidate targets: different files are kept as uncertainty. */
  private combine(outs: ResolveResult[], what: string): ResolveResult | undefined {
    const resolved = [...new Set(outs.flatMap((o) => (o.resolved ? [o.resolved] : [])))];
    if (resolved.length === 1) return { resolved: resolved[0] as string };
    if (resolved.length > 1)
      return {
        resolved: resolved[0] as string,
        uncertain: `${what} can load different files (${resolved.join(", ")})`,
      };
    return outs.find((o) => o.reason) ?? outs[0];
  }

  /** TypeScript's resolution, in the tsconfig project that includes the importing file first. */
  private tsResolve(
    specifier: string,
    absFrom: string,
    projects: Project[],
  ): ResolveResult | undefined {
    const attempt = (p: Project): ResolveResult | undefined => {
      const res = ts.resolveModuleName(
        specifier,
        absFrom,
        p.opts,
        this.host,
        this.cacheFor(p.opts),
      );
      const r = res.resolvedModule;
      return r ? this.finish(r.resolvedFileName, specifier) : undefined;
    };
    const owning = projects.filter((p) => p.contains(absFrom));
    for (const p of owning) {
      const out = attempt(p);
      if (out) return out;
    }
    // No project includes the file (or none resolves it): any of them may apply.
    const outs = projects
      .filter((p) => !owning.includes(p))
      .flatMap((p) => {
        const out = attempt(p);
        return out ? [out] : [];
      });
    if (!outs.length) return undefined;
    const kinds = new Set(outs.map((o) => o.resolved ?? (o.external ? "\0external" : o.reason)));
    if (kinds.size === 1) return outs[0];
    const combined = this.combine(outs, `"${specifier}" (no tsconfig project includes the file)`);
    if (combined?.resolved && !combined.uncertain)
      return {
        ...combined,
        uncertain: `"${specifier}" resolves differently in the tsconfig projects, and none includes the file`,
      };
    return combined;
  }

  /** package.json `imports` (`#app/*`), whatever moduleResolution the tsconfig uses. */
  private packageImports(fromFile: string, absFrom: string, specifier: string) {
    const pkg = this.nearestPackage(dirname(absFrom));
    const imports = pkg?.json.imports;
    if (!pkg || !imports || typeof imports !== "object") return undefined;
    const map = imports as Record<string, unknown>;
    let targets: string[];
    let key = specifier;
    if (specifier in map) targets = exportTargets(map[specifier], ".");
    else {
      const m = matchPattern(Object.keys(map), specifier);
      if (!m) return undefined;
      key = m.key;
      targets = exportTargets(map[m.key], ".").map((t) => t.replaceAll("*", m.star));
    }
    const outs = targets.map((t) =>
      t.startsWith("./")
        ? this.finish(this.probe(join(pkg.dir, t)), specifier)
        : this.resolve(fromFile, t),
    );
    return (
      this.combine(outs, `package.json imports "${key}"`) ?? {
        reason: `package.json imports "${key}" has no target`,
      }
    );
  }

  /** Where a root-absolute import (`/src/x`, Vite) starts: the nearest Vite root, else the root. */
  private viteRoots(absFrom: string): string[] {
    const bases: string[] = [];
    for (let d = dirname(absFrom); this.rel(d) !== undefined; d = dirname(d)) {
      if (VITE_CONFIGS.some((c) => this.isFile(join(d, c))) || this.isFile(join(d, "index.html")))
        bases.push(d);
      if (toPosix(d) === toPosix(this.root) || dirname(d) === d) break;
    }
    return bases;
  }

  private rootAbsolute(absFrom: string, specifier: string): ResolveResult {
    const bases = [...this.viteRoots(absFrom), this.root];
    for (const b of bases) {
      const abs = this.probe(join(b, specifier));
      if (abs) return this.finish(abs, specifier);
    }
    return { reason: `root-absolute import "${specifier}" does not resolve to a file` };
  }

  /**
   * The aliases bundler and test-runner configurations declare for files in `absDir`: the nearest
   * configuration of each tool (Vite, Vitest, Jest, webpack, Babel) from there up to the root.
   * Each configuration file read is a resolution input.
   */
  private aliasConfigs(absDir: string): AliasConfig[] {
    const cached = this.aliasByDir.get(absDir);
    if (cached) return cached;
    const found: AliasConfig[] = [];
    const done = new Set<AliasTool>();
    for (let d = absDir; this.rel(d) !== undefined; d = dirname(d)) {
      for (const tool of ALIAS_TOOLS) {
        if (done.has(tool)) continue;
        for (const name of ALIAS_CONFIGS[tool]) {
          const [fileName, field] = name.split("#") as [string, string | undefined];
          const p = join(d, fileName);
          if (!this.isFile(p)) continue;
          if (field && !(field in (this.packageJson(d) ?? {}))) continue;
          // The nearest config file of a tool is the one it uses, aliases or not.
          done.add(tool);
          this.inputs.add(p);
          const key = field ? `${p}#${field}` : p;
          if (!this.aliasByFile.has(key)) this.aliasByFile.set(key, readAliasConfig(tool, key));
          const config = this.aliasByFile.get(key);
          if (config) {
            for (const f of config.inputs) this.inputs.add(f);
            found.push(config);
          }
          break;
        }
      }
      if (toPosix(d) === toPosix(this.root) || dirname(d) === d) break;
    }
    this.aliasByDir.set(absDir, found);
    return found;
  }

  /** Where an alias candidate points: a file, a package, or nothing. */
  private aliasTarget(
    fromFile: string,
    config: AliasConfig,
    c: { abs?: string; spec?: string },
    specifier: string,
  ): ResolveResult | undefined {
    let abs: string | undefined;
    if (c.abs !== undefined) abs = this.probe(c.abs);
    else {
      const spec = c.spec ?? "";
      if (spec.startsWith("/"))
        // Vite reads `/src` from its root; Jest & co. read a file-system path.
        abs = this.probe(
          config.tool === "vite" || config.tool === "vitest" ? join(config.root, spec) : spec,
        );
      else {
        abs = this.probe(join(config.dir, spec));
        // A package (`vue` → `vue/dist/vue.esm-bundler.js`): resolved once more, without aliases.
        if (!abs) {
          const out = this.resolve(fromFile, spec, false);
          return out.resolved || out.external ? out : undefined;
        }
      }
    }
    return abs ? this.finish(abs, specifier) : undefined;
  }

  /** What each bundler/test-runner configuration that aliases `specifier` maps it to. */
  private bundlerAlias(fromFile: string, absFrom: string, specifier: string): ResolveResult[] {
    const outs: ResolveResult[] = [];
    for (const config of this.aliasConfigs(dirname(absFrom))) {
      const hit = matchAlias(config, specifier);
      if (!hit) continue;
      let out: ResolveResult | undefined;
      for (const c of hit.candidates) {
        out = this.aliasTarget(fromFile, config, c, specifier);
        if (out) break;
      }
      const where = relPosix(this.root, config.file.split("#")[0] as string) ?? config.file;
      outs.push(
        out ?? {
          reason: `${config.tool} alias "${hit.rule.find}" (${where}) maps "${specifier}" to no file`,
        },
      );
    }
    return outs;
  }

  /**
   * The aliases' outcomes with TypeScript's. Configurations that load different files (the app's
   * Vite alias and the tests' Jest mapper) keep the import uncertain; an alias that maps to no
   * file while another resolves does too.
   */
  private withAliases(
    aliased: ResolveResult[],
    viaTs: ResolveResult | undefined,
    specifier: string,
  ): ResolveResult {
    const all = viaTs?.resolved ? [...aliased, viaTs] : aliased;
    const resolved = all.filter((o) => o.resolved);
    if (resolved.length) {
      const c = this.combine(resolved, `"${specifier}" (bundler aliases and tsconfig paths)`);
      const uncertain =
        c?.uncertain ??
        aliased.find((o) => !o.resolved && !o.external)?.reason ??
        resolved.find((o) => o.uncertain)?.uncertain;
      return uncertain ? { ...(c as ResolveResult), uncertain } : (c as ResolveResult);
    }
    const missing = aliased.find((o) => !o.external);
    return missing ?? { external: true };
  }

  resolvePattern(fromFile: string, pattern: string): string | undefined {
    const absFrom = join(this.root, fromFile);
    if (pattern.startsWith("/")) {
      // Root-absolute (`import.meta.glob("/src/pages/*.ts")`): from the nearest Vite root.
      return relPosix(this.root, join(this.viteRoots(absFrom)[0] ?? this.root, pattern));
    }
    if (pattern.startsWith(".")) return undefined;
    const viaPaths = this.pathsPattern(fromFile, pattern);
    if (viaPaths) return viaPaths;
    for (const config of this.aliasConfigs(dirname(absFrom))) {
      const hit = matchAlias(config, pattern);
      for (const c of hit?.candidates ?? []) {
        const spec = c.spec ?? "";
        const abs =
          c.abs ??
          (spec.startsWith("/")
            ? config.tool === "vite" || config.tool === "vitest"
              ? join(config.root, spec)
              : spec
            : join(config.dir, spec));
        const rel = relPosix(this.root, abs);
        if (rel !== undefined) return rel;
      }
    }
    return undefined;
  }

  private pathsPattern(fromFile: string, pattern: string): string | undefined {
    for (const { opts } of this.optionsFor(dirname(join(this.root, fromFile)))) {
      const paths = opts.paths ?? {};
      const base = opts.baseUrl ?? (opts as { pathsBasePath?: string }).pathsBasePath;
      if (!base) continue;
      for (const key of Object.keys(paths)) {
        const at = key.indexOf("*");
        const prefix = at < 0 ? key : key.slice(0, at);
        if (at < 0 ? pattern !== key : !pattern.startsWith(prefix)) continue;
        for (const target of paths[key] ?? []) {
          const rel = relPosix(
            this.root,
            join(base, target.replace("*", pattern.slice(prefix.length))),
          );
          if (rel !== undefined) return rel;
        }
      }
    }
    return undefined;
  }

  /**
   * `aliases`: apply bundler/test-runner aliases (off when resolving an alias's own target, as
   * bundlers do: an alias is applied once).
   */
  resolve(fromFile: string, specifier: string, aliases = true): ResolveResult {
    if (specifier.startsWith("node:")) return { external: true };
    if (/^[a-z]+:/i.test(specifier) && !/^[a-zA-Z]:[\\/]/.test(specifier))
      return { external: true };
    // A bundler query (`./icon.svg?raw`, `#web/a.css?inline`, `./w.ts?worker`) names the same file.
    const query = specifier.indexOf("?");
    if (query > 0) return this.resolve(fromFile, specifier.slice(0, query), aliases);
    const absFrom = join(this.root, fromFile);
    const relative = specifier.startsWith(".") || specifier.startsWith("/");

    if (specifier.startsWith("#")) {
      const out = this.packageImports(fromFile, absFrom, specifier);
      if (out) return out;
    }

    if (!relative) {
      for (const ws of this.workspaces) {
        if (specifier === ws.name || specifier.startsWith(`${ws.name}/`)) {
          const sub = specifier === ws.name ? "." : `.${specifier.slice(ws.name.length)}`;
          let targets = exportTargets(ws.manifest.exports, sub);
          if (!targets.length)
            targets = [
              sub === "."
                ? (ws.manifest.source ?? ws.manifest.module ?? ws.manifest.main ?? "index.js")
                : sub,
            ];
          const outs = targets.flatMap((target) => {
            const src =
              toSource(ws.abs, target, (p) => this.isFile(p), sub === ".") ??
              (sub !== "." ? this.probe(join(ws.abs, sub)) : undefined);
            return src ? [this.finish(src, specifier)] : [];
          });
          return (
            this.combine(outs, `workspace package "${specifier}"`) ?? {
              reason: `workspace package "${ws.name}" entry "${targets[0]}" has no source file`,
            }
          );
        }
      }
    }

    // The SDK a framework generates (`wasp/client/operations`): its build is no project source.
    if (!relative && this.frameworkModule(absFrom, specifier)) return { external: true };
    const projects = this.optionsFor(dirname(absFrom));
    // An alias only a bundler or test-runner config declares (`@` → `./src` in vite.config.ts).
    if (!relative && aliases) {
      const aliased = this.bundlerAlias(fromFile, absFrom, specifier);
      if (aliased.length)
        return this.withAliases(aliased, this.tsResolve(specifier, absFrom, projects), specifier);
    }
    // A Node builtin name (`events`, `constants`) is a builtin unless a local alias or `baseUrl`
    // folder of that name resolves it.
    if (BUILTINS.has(specifier)) {
      if (projects.some((p) => p.opts.baseUrl || p.opts.paths)) {
        const out = this.tsResolve(specifier, absFrom, projects);
        if (out?.resolved) return out;
      }
      return { external: true };
    }
    if (specifier.startsWith("/")) {
      const out = this.tsResolve(specifier, absFrom, projects);
      return out?.resolved ? out : this.rootAbsolute(absFrom, specifier);
    }
    const out = this.tsResolve(specifier, absFrom, projects);
    if (out) return out;
    if (relative) {
      const abs = this.probe(join(dirname(absFrom), specifier));
      const res = this.finish(abs, specifier);
      return abs ? res : { reason: `relative import "${specifier}" does not resolve to a file` };
    }
    // alias that should resolve inside the project?
    let aliasMiss: string | undefined;
    const owning = projects.filter((p) => p.contains(absFrom));
    for (const { opts } of [...owning, ...projects.filter((p) => !owning.includes(p))]) {
      const paths = opts.paths ?? {};
      const base = opts.baseUrl ?? (opts as { pathsBasePath?: string }).pathsBasePath;
      for (const key of Object.keys(paths)) {
        const re = new RegExp(
          `^${key.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace("*", "(.*)")}$`,
        );
        const match = re.exec(specifier);
        if (!match) continue;
        // TypeScript only maps aliases to modules it can type; a non-code file (`.svg`, `.css`,
        // `.json` without resolveJsonModule) behind an alias is probed here.
        for (const target of base ? (paths[key] ?? []) : []) {
          const res = this.finish(
            this.probe(join(base as string, target.replace("*", match[1] ?? ""))),
            specifier,
          );
          if (res.resolved) return res;
        }
        aliasMiss ??= `path alias "${key}" did not resolve "${specifier}"`;
      }
    }
    if (aliasMiss) return { reason: aliasMiss };
    // A bare name that is no alias and no declared dependency (an alias only a bundler config
    // declares) is unresolved, never "external": its dependents cannot be ruled out.
    const parts = specifier.split("/");
    const name = specifier.startsWith("@") ? parts.slice(0, 2).join("/") : (parts[0] as string);
    if (!this.declared(dirname(absFrom)).has(name))
      return { reason: `"${specifier}" is neither a path alias nor a declared dependency` };
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
