/**
 * Lockfile and manifest changes, by package. A lockfile change used to select every test; here it
 * becomes the packages whose resolved entries changed, and the packages that depend on them, so
 * only the code importing one of those packages is selected.
 *
 * Parsed without a YAML or lockfile library: each format is split into entries (one per package,
 * or one per declared dependency of a workspace), and an entry whose text differs is a changed
 * package. An entry that belongs to no package (lockfile version, settings, overrides, patches)
 * makes the change global: everything is selected, as before.
 */

export interface LockEntry {
  /** Package names the entry resolves (empty: a setting that applies to every package). */
  names: string[];
  text: string;
  /** Names of the packages this entry depends on. */
  deps: string[];
}

export type PackageDiff =
  | { packages: string[]; dependents: Map<string, Set<string>> }
  | { full: string };

export const LOCKFILE =
  /(?:^|\/)(?:package-lock\.json|npm-shrinkwrap\.json|pnpm-lock\.yaml|yarn\.lock)$/;
export const MANIFEST = /(?:^|\/)package\.json$/;

const DEP_SECTIONS = [
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies",
] as const;

/** Manifest fields with no effect on what code loads or how tests run. */
const METADATA_FIELDS = new Set([
  "description",
  "keywords",
  "author",
  "contributors",
  "maintainers",
  "license",
  "homepage",
  "bugs",
  "repository",
  "funding",
  "private",
  "publishConfig",
]);

const unquote = (s: string) => s.trim().replace(/^(['"])(.*)\1$/, "$2");

/** The package an import specifier names (`@scope/pkg/sub` → `@scope/pkg`), if any. */
export function packageOfSpecifier(spec: string): string | undefined {
  if (/^[./]/.test(spec) || /^[a-z]+:/i.test(spec) || spec.startsWith("#")) return undefined;
  const parts = spec.split("/");
  if (spec.startsWith("@"))
    return parts.length >= 2 && parts[0] !== "@" ? `${parts[0]}/${parts[1]}` : undefined;
  return parts[0] || undefined;
}

/** The package an `@types/*` package types (`@types/scope__pkg` → `@scope/pkg`). */
export function typedPackage(name: string): string | undefined {
  if (!name.startsWith("@types/")) return undefined;
  const t = name.slice("@types/".length);
  return t.includes("__") ? `@${t.replace("__", "/")}` : t;
}

/** The entries of a lockfile, or undefined when it cannot be read. */
export function lockEntries(path: string, text: string): Map<string, LockEntry> | undefined {
  try {
    if (/\.json$/.test(path)) return npmEntries(text);
    if (path.endsWith("pnpm-lock.yaml")) return pnpmEntries(text);
    if (path.endsWith("yarn.lock")) return yarnEntries(text);
  } catch {
    return undefined;
  }
  return undefined;
}

function depNames(v: Record<string, unknown> | undefined, keys: readonly string[]): string[] {
  const out: string[] = [];
  for (const k of keys) {
    const m = v?.[k];
    if (m && typeof m === "object") out.push(...Object.keys(m));
  }
  return out;
}

function npmEntries(text: string): Map<string, LockEntry> {
  const json = JSON.parse(text) as Record<string, unknown>;
  const out = new Map<string, LockEntry>();
  for (const [k, v] of Object.entries(json)) {
    if (k === "packages" || k === "dependencies" || k === "name" || k === "version") continue;
    out.set(`#${k}`, { names: [], text: JSON.stringify(v), deps: [] });
  }
  const packages = json.packages as Record<string, Record<string, unknown>> | undefined;
  if (packages) {
    for (const [k, v] of Object.entries(packages)) {
      const at = k.lastIndexOf("node_modules/");
      if (at !== -1) {
        out.set(k, {
          names: [k.slice(at + "node_modules/".length)],
          text: JSON.stringify(v),
          deps: depNames(v, [...DEP_SECTIONS, "requires"]),
        });
        continue;
      }
      // The root or a workspace folder: one entry per declared dependency (its own metadata, such
      // as its version, does not change what is installed).
      for (const sec of DEP_SECTIONS)
        for (const [n, spec] of Object.entries((v?.[sec] as Record<string, unknown>) ?? {}))
          out.set(`${k}|${sec}|${n}`, { names: [n], text: JSON.stringify(spec), deps: [] });
    }
    return out;
  }
  // lockfileVersion 1: a nested tree.
  const walk = (deps: Record<string, Record<string, unknown>> | undefined, prefix: string) => {
    for (const [name, v] of Object.entries(deps ?? {})) {
      const key = `${prefix}/${name}`;
      const { dependencies, ...own } = v;
      out.set(key, { names: [name], text: JSON.stringify(own), deps: depNames(v, ["requires"]) });
      walk(dependencies as Record<string, Record<string, unknown>> | undefined, key);
    }
  };
  walk(json.dependencies as Record<string, Record<string, unknown>> | undefined, "");
  return out;
}

/** `lodash@^4.17.21`, `"@babel/core@npm:^7.0.0"` → the package name. */
function descriptorName(d: string): string {
  // A header lists several quoted descriptors in one string: `"a@npm:^1, a@npm:^1.2":`.
  const s = d.replace(/"/g, "").trim();
  const at = s.indexOf("@", 1);
  return at === -1 ? s : s.slice(0, at);
}

const DEP_HEADERS = /^(?:dependencies|optionalDependencies|peerDependencies)$/;

function yarnEntries(text: string): Map<string, LockEntry> {
  const out = new Map<string, LockEntry>();
  let current: LockEntry | undefined;
  let header = "";
  /** A workspace (`app@workspace:.`): one entry per declared dependency, as in npm's root. */
  let workspace = false;
  let inDeps = false;
  for (const raw of text.split(/\r?\n/)) {
    if (!raw.trim() || raw.trimStart().startsWith("#")) continue;
    const indent = raw.length - raw.trimStart().length;
    const line = raw.trim();
    if (indent === 0) {
      header = line.replace(/:$/, "");
      workspace = /@workspace:/.test(header);
      const key = header === "__metadata" ? "#__metadata" : header;
      const names =
        header === "__metadata"
          ? []
          : [...new Set(header.split(/,\s*/).map(descriptorName).filter(Boolean))];
      // A workspace's own fields (its version, `bin`) change nothing that is installed.
      current = { names, text: "", deps: [] };
      out.set(key, current);
      inDeps = false;
      continue;
    }
    if (!current) {
      out.set(`#line:${line}`, { names: [], text: line, deps: [] });
      continue;
    }
    if (indent === 2) inDeps = DEP_HEADERS.test(line.replace(/:$/, ""));
    const dep = indent >= 4 && inDeps ? /^("(?:[^"]+)"|[^\s:"]+)/.exec(line)?.[1] : undefined;
    if (workspace) {
      if (dep)
        out.set(`${header}|${unquote(dep)}`, { names: [unquote(dep)], text: line, deps: [] });
      continue;
    }
    current.text += `${raw}\n`;
    if (dep) current.deps.push(unquote(dep));
  }
  return out;
}

/** A key of pnpm's `packages`/`snapshots` (`/react@18.2.0`, `react-dom@18.2.0(react@18.2.0)`). */
function pnpmName(key: string): string {
  // The key alone, without an inline value (`'@babel/x@7.0.0': {}`); a quoted key may hold colons.
  const q = /^(['"])(.*?)\1/.exec(key);
  let k = (q ? (q[2] as string) : key.replace(/:(?:\s.*)?$/, "")).replace(/^\//, "");
  k = k.replace(/\(.*$/, "");
  // lockfile v5: `/name/1.0.0` or `/@scope/name/1.0.0_peer@1`.
  const v5 = /^((?:@[^/]+\/)?[^/@]+)\/\d/.exec(k);
  if (v5?.[1]) return v5[1];
  const at = k.indexOf("@", 1);
  return at === -1 ? k : k.slice(0, at);
}

const PNPM_PACKAGE_SECTIONS = new Set(["packages", "snapshots"]);
const PNPM_DEP_SECTIONS = new Set([
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "specifiers",
  "dependenciesMeta",
]);

function pnpmEntries(text: string): Map<string, LockEntry> {
  const out = new Map<string, LockEntry>();
  let section = "";
  let importer = "";
  let sub = "";
  let current: LockEntry | undefined;
  let inDeps = false;
  const set = (key: string, entry: LockEntry) => {
    current = entry;
    out.set(key, entry);
  };
  for (const raw of text.split(/\r?\n/)) {
    if (!raw.trim() || raw.trimStart().startsWith("#")) continue;
    const indent = raw.length - raw.trimStart().length;
    const line = raw.trim();
    if (indent === 0) {
      const colon = line.indexOf(":");
      section = colon === -1 ? line : line.slice(0, colon);
      importer = "";
      sub = "";
      // A scalar setting (`lockfileVersion: '9.0'`) or an unknown section: global.
      set(`#${section}`, { names: [], text: `${line}\n`, deps: [] });
      if (
        section === "importers" ||
        PNPM_PACKAGE_SECTIONS.has(section) ||
        PNPM_DEP_SECTIONS.has(section)
      )
        current = undefined;
      continue;
    }
    if (PNPM_PACKAGE_SECTIONS.has(section)) {
      if (indent === 2) {
        set(`${section}|${line}`, { names: [pnpmName(line)], text: "", deps: [] });
        inDeps = false;
        continue;
      }
      if (!current) continue;
      current.text += `${raw}\n`;
      if (indent === 4) inDeps = DEP_HEADERS.test(line.replace(/:.*$/, ""));
      else if (indent === 6 && inDeps) current.deps.push(unquote(line.replace(/:.*$/, "")));
      continue;
    }
    if (section === "importers") {
      if (indent === 2) {
        importer = line.replace(/:$/, "");
        current = undefined;
        continue;
      }
      if (indent === 4) {
        sub = line.replace(/:.*$/, "");
        // A field of the importer itself (`publishDirectory: dist`): global, to be safe.
        if (!PNPM_DEP_SECTIONS.has(sub))
          set(`importers|${importer}|#${line}`, { names: [], text: line, deps: [] });
        else current = undefined;
        continue;
      }
      if (indent === 6 && PNPM_DEP_SECTIONS.has(sub)) {
        const name = unquote(line.replace(/:.*$/, ""));
        set(`importers|${importer}|${sub}|${name}`, { names: [name], text: `${line}\n`, deps: [] });
        continue;
      }
      if (current) current.text += `${raw}\n`;
      continue;
    }
    // lockfile v5 single project: top-level `dependencies:` / `specifiers:`.
    if (PNPM_DEP_SECTIONS.has(section)) {
      if (indent === 2) {
        const name = unquote(line.replace(/:.*$/, ""));
        set(`${section}|${name}`, { names: [name], text: `${line}\n`, deps: [] });
      } else if (current) current.text += `${raw}\n`;
      continue;
    }
    if (current) current.text += `${raw}\n`;
  }
  return out;
}

/** The packages a lockfile change touches, with who depends on whom (both versions merged). */
export function lockfileDiff(
  path: string,
  before: string | undefined,
  after: string | undefined,
): PackageDiff {
  if (before === undefined || after === undefined)
    return { full: `${path} was ${before === undefined ? "added" : "deleted"}` };
  const a = lockEntries(path, before);
  const b = lockEntries(path, after);
  if (!a || !b) return { full: `${path} could not be read` };
  const changed = new Set<string>();
  for (const key of new Set([...a.keys(), ...b.keys()])) {
    const x = a.get(key);
    const y = b.get(key);
    if (x?.text === y?.text) continue;
    const entry = (y ?? x) as LockEntry;
    if (!entry.names.length) return { full: `${path}: ${key.replace(/^#/, "")} changed` };
    for (const n of [...(x?.names ?? []), ...(y?.names ?? [])]) changed.add(n);
  }
  const dependents = new Map<string, Set<string>>();
  for (const entries of [a, b])
    for (const e of entries.values())
      for (const dep of e.deps)
        for (const n of e.names) {
          const set = dependents.get(dep) ?? new Set<string>();
          set.add(n);
          dependents.set(dep, set);
        }
  return { packages: [...changed].sort(), dependents };
}

/** The dependencies a `package.json` change touches; any other field makes it global. */
export function manifestDiff(
  path: string,
  before: string | undefined,
  after: string | undefined,
): PackageDiff {
  if (before === undefined || after === undefined)
    return { full: `${path} was ${before === undefined ? "added" : "deleted"}` };
  let a: Record<string, unknown>;
  let b: Record<string, unknown>;
  try {
    a = JSON.parse(before) as Record<string, unknown>;
    b = JSON.parse(after) as Record<string, unknown>;
  } catch {
    return { full: `${path} could not be read` };
  }
  const changed = new Set<string>();
  for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
    if (JSON.stringify(a[key]) === JSON.stringify(b[key]) || METADATA_FIELDS.has(key)) continue;
    if (!(DEP_SECTIONS as readonly string[]).includes(key))
      return { full: `${path}: "${key}" changed` };
    const x = (a[key] ?? {}) as Record<string, unknown>;
    const y = (b[key] ?? {}) as Record<string, unknown>;
    for (const n of new Set([...Object.keys(x), ...Object.keys(y)]))
      if (JSON.stringify(x[n]) !== JSON.stringify(y[n])) changed.add(n);
  }
  return { packages: [...changed].sort(), dependents: new Map() };
}

/** `changed` and every package that depends on one of them, directly or not. */
export function withDependents(
  changed: Iterable<string>,
  dependents: ReadonlyMap<string, ReadonlySet<string>>,
): Set<string> {
  const out = new Set(changed);
  const queue = [...out];
  while (queue.length) {
    const n = queue.pop() as string;
    for (const d of dependents.get(n) ?? [])
      if (!out.has(d)) {
        out.add(d);
        queue.push(d);
      }
  }
  return out;
}

/**
 * Packages that change how tests are compiled, collected or run rather than what code imports: a
 * change to one of them (or to anything they depend on) selects every test.
 */
export const TOOL_PACKAGE =
  /^(?:vitest|@vitest\/.*|jest|jest-.*|@jest\/.*|ts-jest|babel-jest|vite|@vitejs\/.*|vite-.*|rollup|@rollup\/.*|rolldown|esbuild|@esbuild\/.*|@swc\/.*|swc-.*|@babel\/.*|babel-.*|typescript|ts-node|tsx|@playwright\/.*|playwright|playwright-core|cypress|@cypress\/.*|@angular\/cli|@angular\/build|@angular\/compiler-cli|@angular-devkit\/.*|@angular-builders\/.*|@analogjs\/.*|jest-preset-angular|zone\.js|jsdom|happy-dom|@happy-dom\/.*|@tkmremi\/smarttest|postcss|tailwindcss|@tailwindcss\/.*|sass|sass-embedded|less|node-gyp)$/;

/**
 * Lint, format and commit tools: when no analysed file imports one and no configuration names it,
 * it cannot change what a test loads or how it runs.
 */
export const NO_TEST_EFFECT =
  /^(?:eslint|eslint-.*|@eslint\/.*|@eslint-community\/.*|@typescript-eslint\/.*|typescript-eslint|prettier|prettier-.*|@prettier\/.*|husky|lint-staged|@commitlint\/.*|commitlint|stylelint|stylelint-.*|@changesets\/.*|markdownlint|markdownlint-.*|cspell|@cspell\/.*|knip|depcheck|@biomejs\/.*)$/;

export type PackageImpact =
  | { packages: string[]; importers: { file: string; package: string }[] }
  | { full: string };

interface ImportingFile {
  path: string;
  imports: readonly { specifier: string }[];
  dynamicUnresolved?: readonly string[];
  dynamicUnmatched?: readonly string[];
}

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * What a lockfile or manifest change selects: the files importing a changed package or one that
 * depends on it, or everything (`full`, with the reason) when that cannot be told apart safely.
 *
 * - A test tool, compiler or bundler changed (TOOL_PACKAGE): everything.
 * - A declared dependency no analysed file imports is loaded some other way (a runner, a plugin, a
 *   CLI in a script, a type package): everything.
 * - A package a configuration or a stylesheet names (`preset: "ts-jest"`, `@use "bootstrap"`):
 *   everything.
 * - A changed package nothing depends on and nothing declares or imports: everything (the
 *   lockfile was read in a way that lost its dependents).
 * - A file with an import SmartTest cannot evaluate (`require(name)`) may load any package: it is
 *   an importer of each.
 */
export function packageImpact(options: {
  path: string;
  diff: PackageDiff;
  files: Iterable<ImportingFile>;
  /** Names declared in a `package.json` dependency section of the project or its workspaces. */
  declared: ReadonlySet<string>;
  /** Runner configurations and inputs: importing a changed package from one selects everything. */
  isConfig: (file: string) => boolean;
  /** Text of configurations and stylesheets, searched for the package names. */
  texts: readonly { file: string; text: string }[];
  /**
   * Packages the project's test commands are known not to load (`@angular-devkit/build-angular`
   * when every Angular test target uses another builder): like lint tools, they select nothing.
   */
  notLoadedByTests?: ReadonlySet<string>;
}): PackageImpact {
  const unused = (n: string) => NO_TEST_EFFECT.test(n) || !!options.notLoadedByTests?.has(n);
  const { path, diff } = options;
  if ("full" in diff) return diff;
  if (!diff.packages.length) return { packages: [], importers: [] };
  const affected = withDependents(diff.packages, diff.dependents);
  const byPackage = new Map<string, string[]>();
  const uncertain: string[] = [];
  const typesKey = (name: string) => `@types/${name.replace(/^@/, "").replace("/", "__")}`;
  for (const f of options.files) {
    if (f.dynamicUnresolved?.length || f.dynamicUnmatched?.length) uncertain.push(f.path);
    for (const imp of f.imports) {
      const name = packageOfSpecifier(imp.specifier);
      if (!name) continue;
      for (const key of [name, typesKey(name)])
        if (affected.has(key)) {
          const list = byPackage.get(key) ?? [];
          if (!list.includes(f.path)) list.push(f.path);
          byPackage.set(key, list);
        }
    }
  }
  const dependentsIn = (n: string) =>
    [...(diff.dependents.get(n) ?? [])].filter((d) => affected.has(d));
  /**
   * Packages the tests can load: the ones the project imports or declares (not a lint tool or an
   * unused builder), a package nothing declares, imports or depends on (its dependents may have
   * been lost), and everything those depend on.
   */
  const relevant = new Set(
    [...affected].filter(
      (n) =>
        byPackage.has(n) ||
        (options.declared.has(n) && !unused(n)) ||
        (!options.declared.has(n) && !dependentsIn(n).length),
    ),
  );
  const dependenciesOf = new Map<string, string[]>();
  for (const n of affected)
    for (const d of dependentsIn(n)) dependenciesOf.set(d, [...(dependenciesOf.get(d) ?? []), n]);
  const queue = [...relevant];
  while (queue.length)
    for (const dep of dependenciesOf.get(queue.pop() as string) ?? [])
      if (!relevant.has(dep)) {
        relevant.add(dep);
        queue.push(dep);
      }
  const isRelevant = (n: string) => relevant.has(n);
  const tool = [...affected]
    .sort()
    .find((n) => TOOL_PACKAGE.test(n) && !unused(n) && isRelevant(n));
  if (tool)
    return {
      full: `${path}: ${tool}${diff.packages.includes(tool) ? "" : ` (through ${diff.packages.slice(0, 3).join(", ")})`} changed, a test or build tool`,
    };
  const importers: { file: string; package: string }[] = [];
  for (const name of [...affected].sort()) {
    const files = byPackage.get(name) ?? [];
    if (!files.length && unused(name)) continue;
    if (!files.length && (options.declared.has(name) || !dependentsIn(name).length))
      return {
        full: `${path}: ${name} changed and no analysed file imports it (a runner, plugin or command may load it)`,
      };
    const config = files.find((f) => options.isConfig(f));
    if (config) return { full: `${path}: ${name} changed and ${config} loads it` };
    for (const file of files) importers.push({ file, package: name });
  }
  for (const { file, text } of options.texts)
    for (const name of affected)
      if (new RegExp(`(?:["'\`~]|node_modules/)${escapeRegExp(name)}(?:["'\`/]|$)`, "m").test(text))
        return { full: `${path}: ${name} changed and ${file} names it` };
  for (const file of uncertain)
    if (!importers.some((i) => i.file === file))
      importers.push({ file, package: diff.packages[0] as string });
  return { packages: diff.packages, importers };
}
