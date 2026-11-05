/**
 * Files a test runner loads for every test because its configuration names them (spec §11.4):
 * the configuration and the local modules it imports, setup files, global setup/teardown, test
 * environments, support files, preloaded modules, and local files that aliases/module mappers
 * point to. They are read statically; a value that can't be read is reported, never guessed.
 */
import { readFile, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, posix, relative } from "node:path";
import type { RunnerHit } from "@smarttest/impact-engine";
import type { ConfigPath, RunnerConfigFacts } from "@smarttest/language-typescript";
import { angularTestTargets, type ChangeSet } from "@smarttest/shared";
import type { RunnerRoot } from "@smarttest/test-discovery";
import { languages } from "./languages.js";

export interface RunnerInputs {
  root: RunnerRoot;
  /** "vitest", or "vitest (packages/web)" when the runner is not at the project root. */
  label: string;
  /** The configuration files the runner reads (its config and the local modules it imports). */
  configs: { file: string; importedBy?: string }[];
  /** Local files the runner loads for every test. */
  loads: { file: string; key: string; source: string }[];
  /** Local files a module mapping points to, and the specifiers it maps. */
  mappings: { file: string; key: string; find: string; regex: boolean; source: string }[];
  /** Keys whose value can't be read statically, with the file that sets them. */
  computed: { key: string; source: string }[];
}

const EXTENSIONS = ["", ".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs", ".json"];
const INDEXES = ["/index.ts", "/index.tsx", "/index.js", "/index.mjs", "/index.cjs"];
const OWN_NAMES =
  /^(?:vitest\.(?:config|workspace|setup)|jest\.(?:config|preset|setup)|playwright\.config|cypress\.config|setupTests|global-(?:setup|teardown))\./;

const ROLES: Record<string, string> = {
  setupFiles: "setup file",
  setupFilesAfterEnv: "setup file",
  globalSetup: "global setup file",
  globalTeardown: "global teardown file",
  testEnvironment: "test environment",
  supportFile: "support file",
  snapshotResolver: "snapshot resolver",
  testSequencer: "test sequencer",
  providersFile: "providers file",
  polyfills: "polyfills",
  styles: "global stylesheet",
  scripts: "global script",
  main: "test entry point",
  resolver: "module resolver",
  snapshotSerializers: "snapshot serializer",
  transform: "transformer",
  preset: "preset",
  "--import": "preloaded module (--import)",
  "--require": "preloaded module (--require)",
  "-r": "preloaded module (-r)",
  "--loader": "module loader (--loader)",
  "--experimental-loader": "module loader (--experimental-loader)",
  bootstrap: "bootstrap file",
  env: "test environment file",
  pest: "Pest configuration",
};

async function isFile(abs: string): Promise<boolean> {
  try {
    return (await stat(abs)).isFile();
  } catch {
    return false;
  }
}
async function read(abs: string): Promise<string | undefined> {
  try {
    return await readFile(abs, "utf8");
  } catch {
    return undefined;
  }
}

export const runnerLabel = (r: RunnerRoot) => `${r.adapter}${r.dir ? ` (${r.dir})` : ""}`;

/** Reads what a runner loads from its configuration (static, no runner process). */
export async function readRunnerInputs(
  projectRoot: string,
  root: RunnerRoot,
): Promise<RunnerInputs> {
  const { readRunnerConfig, readNodeTestScript } = (await languages()).ts;
  const out: RunnerInputs = {
    root,
    label: runnerLabel(root),
    configs: [],
    loads: [],
    mappings: [],
    computed: [],
  };
  const rel = (abs: string): string | undefined => {
    const r = relative(projectRoot, abs).split("\\").join("/");
    return r.startsWith("../") || r === ".." || isAbsolute(r) ? undefined : r;
  };
  /** A local file for `p`, trying the extensions a runner would. */
  const probe = async (abs: string, dirIndex = true): Promise<string | undefined> => {
    for (const ext of dirIndex ? [...EXTENSIONS, ...INDEXES] : EXTENSIONS)
      if (await isFile(abs + ext)) return abs + ext;
    return undefined;
  };

  // Angular CLI: `angular.json` is the configuration. Its test target (and the build target the
  // unit-test builder compiles with) names the TypeScript and runner configs, setup and providers
  // files, polyfills and global styles: every spec of the project loads them.
  if (root.adapter === "angular") {
    const workspace = root.configFile ?? (root.dir ? `${root.dir}/angular.json` : "angular.json");
    out.configs.push({ file: workspace });
    const text = await read(join(projectRoot, workspace));
    const target = (text ? angularTestTargets(text) : []).find(
      (t) => !root.project || t.project === root.project,
    );
    if (!target) return out;
    for (const key of target.computed) out.computed.push({ key, source: workspace });
    for (const l of target.loads) {
      const file = root.dir ? `${root.dir}/${l.file}` : l.file;
      if (!(await isFile(join(projectRoot, file)))) continue;
      if (["tsConfig", "runnerConfig", "karmaConfig", "config"].includes(l.key))
        out.configs.push({ file, importedBy: workspace });
      else out.loads.push({ file, key: l.key, source: workspace });
    }
    return out;
  }

  // pytest and unittest (preview): their configuration files. conftest.py files are imports of
  // the tests below them (language-python), so they and what they import select those tests.
  if (root.adapter === "pytest" || root.adapter === "unittest") {
    for (const name of ["pytest.ini", "pyproject.toml", "setup.cfg", "tox.ini"]) {
      const file = root.dir ? `${root.dir}/${name}` : name;
      if (await isFile(join(projectRoot, file))) out.configs.push({ file });
    }
    return out;
  }

  // PHPUnit and Pest (preview): the configuration, its bootstrap, the test environment and Pest's
  // `Pest.php` run for every test. `tests/TestCase.php`, the application's bootstrap and its
  // migrations reach the tests that boot the application through the graph (language-php), so
  // a test that does not boot it is not selected by them.
  if (root.adapter === "phpunit") {
    const prefix = root.dir ? `${root.dir}/` : "";
    let config = root.configFile;
    if (!config)
      for (const name of ["phpunit.xml", "phpunit.xml.dist", "phpunit.dist.xml"])
        if (await isFile(join(projectRoot, `${prefix}${name}`))) {
          config = `${prefix}${name}`;
          break;
        }
    if (config) {
      out.configs.push({ file: config });
      const text = (await read(join(projectRoot, config))) ?? "";
      const bootstrap = /<phpunit\b[^>]*\sbootstrap="([^"]+)"/.exec(text)?.[1];
      if (bootstrap) {
        const base = posix.dirname(config);
        const file = posix.normalize(base === "." ? bootstrap : `${base}/${bootstrap}`);
        if (await isFile(join(projectRoot, file)))
          out.loads.push({ file, key: "bootstrap", source: config });
      }
    }
    for (const name of [".env.testing", "tests/Pest.php"]) {
      const file = `${prefix}${name}`;
      if (await isFile(join(projectRoot, file)))
        out.loads.push({
          file,
          key: name === ".env.testing" ? "env" : "pest",
          source: config ?? "PHPUnit",
        });
    }
    return out;
  }

  // The configuration files: the runner's own (or the vite config Vitest falls back to) and,
  // transitively, the local modules they import.
  const facts: { file: string; facts: RunnerConfigFacts }[] = [];
  let configFile = root.configFile;
  if (!configFile && root.adapter === "vitest")
    for (const v of ["vite.config.ts", "vite.config.mts", "vite.config.js", "vite.config.mjs"]) {
      const f = root.dir ? `${root.dir}/${v}` : v;
      if (await isFile(join(projectRoot, f))) {
        configFile = f;
        break;
      }
    }
  const queue: { file: string; importedBy?: string }[] = configFile ? [{ file: configFile }] : [];
  const seen = new Set<string>();
  while (queue.length) {
    const next = queue.shift() as { file: string; importedBy?: string };
    if (seen.has(next.file)) continue;
    seen.add(next.file);
    out.configs.push(next);
    const text = await read(join(projectRoot, next.file));
    if (text === undefined) continue;
    const f = readRunnerConfig(root.adapter, next.file, text);
    facts.push({ file: next.file, facts: f });
    for (const spec of f.imports) {
      const abs = await probe(join(projectRoot, dirname(next.file), spec));
      const r = abs ? rel(abs) : undefined;
      if (r && !seen.has(r)) queue.push({ file: r, importedBy: next.file });
    }
  }
  // Jest settings in package.json.
  if (root.adapter === "jest" && !root.configFile) {
    const pkgFile = root.dir ? `${root.dir}/package.json` : "package.json";
    const pkg = await read(join(projectRoot, pkgFile));
    try {
      const jest = pkg ? (JSON.parse(pkg) as { jest?: unknown }).jest : undefined;
      if (jest && typeof jest === "object")
        facts.push({
          file: pkgFile,
          facts: readRunnerConfig("jest", "package.json", JSON.stringify(jest)),
        });
    } catch {
      // An unreadable package.json is reported elsewhere.
    }
  }

  const configDir = (file: string) => dirname(join(projectRoot, file));
  // Vitest `root` / Jest `rootDir`, relative to the configuration that sets it.
  const runnerBase = facts.reduce(
    (acc, { file, facts: f }) => (f.root ? join(configDir(file), f.root.path) : acc),
    configFile ? configDir(configFile) : join(projectRoot, root.dir),
  );
  /** The local file a configured path names, or undefined for a package / a pattern. */
  const local = async (
    p: ConfigPath,
    file: string,
    dirIndex = true,
  ): Promise<string | undefined> => {
    let path = p.path.replace(/^<rootDir>/, runnerBase);
    if (/\$\d|\$&|[*?]/.test(path)) return undefined; // a rewrite pattern or glob, not one file
    const explicit =
      p.base === "config" ||
      p.path.startsWith("<rootDir>") ||
      path.startsWith("./") ||
      path.startsWith("../") ||
      isAbsolute(path);
    if (!isAbsolute(path)) path = join(p.base === "config" ? configDir(file) : runnerBase, path);
    const found = await probe(path, dirIndex);
    if (found) return rel(found);
    if (!dirIndex) return undefined;
    // A relative path that names no file still identifies it: creating it changes the run.
    return explicit && /\.[cm]?[jt]sx?$/.test(path) ? rel(path) : undefined;
  };

  for (const { file, facts: f } of facts) {
    for (const key of f.computed) out.computed.push({ key, source: file });
    for (const l of f.loads) {
      const target = await local(l, file);
      if (target && !out.configs.some((c) => c.file === target))
        out.loads.push({ file: target, key: l.key, source: file });
    }
    for (const m of f.mappings) {
      // A directory alias (`@src` → ./src) is a path rewrite, resolved per import.
      const target = await local(m.target, file, false);
      if (target)
        out.mappings.push({ file: target, key: m.key, find: m.find, regex: m.regex, source: file });
    }
  }
  // Cypress loads its default support file unless the config names another one or `false`.
  if (root.adapter === "cypress" && !facts.some((f) => f.facts.present.includes("supportFile"))) {
    const base = configFile ? configDir(configFile) : join(projectRoot, root.dir);
    for (const name of ["e2e", "component", "index"]) {
      const found = await probe(join(base, "cypress", "support", name));
      const r = found ? rel(found) : undefined;
      if (r && /\.[cm]?[jt]sx?$/.test(r))
        out.loads.push({ file: r, key: "supportFile", source: configFile ?? "cypress defaults" });
    }
  }
  // node --test: modules the test script preloads.
  if (root.adapter === "node") {
    const pkgFile = root.dir ? `${root.dir}/package.json` : "package.json";
    const pkg = await read(join(projectRoot, pkgFile));
    let scripts: Record<string, string> = {};
    try {
      scripts =
        (pkg ? (JSON.parse(pkg) as { scripts?: Record<string, string> }).scripts : {}) ?? {};
    } catch {
      scripts = {};
    }
    for (const [name, script] of Object.entries(scripts)) {
      if (typeof script !== "string" || !/\bnode\b[^&|;]*\s--test\b/.test(script)) continue;
      const { loads, computed } = readNodeTestScript(script);
      if (computed) out.computed.push({ key: `scripts.${name}`, source: pkgFile });
      for (const l of loads) {
        const target = await local(l, pkgFile);
        if (target)
          out.loads.push({ file: target, key: l.key, source: `${pkgFile} scripts.${name}` });
      }
    }
  }
  return out;
}

/** The project-relative files `start` imports, transitively, with the import chain to each. */
function closure(
  start: string,
  importsOf: (file: string) => readonly string[],
): Map<string, string[]> {
  const chains = new Map<string, string[]>([[start, [start]]]);
  const queue = [start];
  while (queue.length) {
    const f = queue.shift() as string;
    for (const d of importsOf(f)) {
      if (chains.has(d)) continue;
      chains.set(d, [d, ...(chains.get(f) as string[])]);
      queue.push(d);
    }
  }
  return chains;
}

export interface RunnerHitContext {
  inputs: readonly RunnerInputs[];
  /** Tests each runner collects. */
  testsOf: (root: RunnerRoot) => string[];
  /** Resolved local imports of an analysed file. */
  importsOf: (file: string) => readonly string[];
  /** Analysed files importing a specifier, and whether that import resolved somewhere. */
  importersOf: (match: (specifier: string) => boolean) => { file: string; resolved?: string }[];
  /** Whether the graph links a file straight to another (one edge). */
  dependsDirectly: (from: string, to: string) => boolean;
  /** Tests that depend on a file. */
  testsDependingOn: (file: string) => string[];
  /** Whether a change to the file reaches any test through the graph. */
  reachesAnyTest: (file: string) => boolean;
  isTest: (file: string) => boolean;
  changeSet: ChangeSet;
}

/**
 * For each changed file, the tests a runner's configuration makes depend on it, and why.
 * Also returns warnings for configurations whose loaded files can't be read statically.
 */
export function runnerHits(ctx: RunnerHitContext): { hits: RunnerHit[]; warnings: string[] } {
  const changed = new Set<string>();
  for (const c of ctx.changeSet.changes) {
    changed.add(c.path);
    if (c.previousPath) changed.add(c.previousPath);
  }
  const hits: RunnerHit[] = [];
  const warnings: string[] = [];
  const add = (hit: RunnerHit) => {
    if (changed.has(hit.file) && hit.tests.length) hits.push(hit);
  };
  for (const ri of ctx.inputs) {
    const tests = ctx.testsOf(ri.root);
    if (!tests.length) continue;
    const name = ri.label;
    // Every test of the runner depends on its configuration and on what it loads: the files
    // named directly first, then what they import (each file once, with its shortest chain).
    const starts = [
      ...ri.configs.map((c) => ({
        file: c.file,
        role: c.importedBy
          ? `imported by ${c.importedBy}, the configuration of ${name}`
          : `configuration of ${name}`,
        importedRole: `part of the configuration of ${name}`,
      })),
      ...ri.loads.map((l) => {
        const role = `${ROLES[l.key] ?? `${l.key} file`} of ${name} (${l.key} in ${l.source})`;
        return { file: l.file, role, importedRole: role };
      }),
    ];
    const done = new Set<string>();
    for (const st of starts) {
      if (done.has(st.file)) continue;
      done.add(st.file);
      add({
        file: st.file,
        tests,
        message: `${st.file} changed — ${st.role}`,
        ...(OWN_NAMES.test(posix.basename(st.file)) ? { narrow: true } : {}),
      });
    }
    for (const st of starts)
      for (const [file, chain] of closure(st.file, ctx.importsOf)) {
        if (done.has(file)) continue;
        done.add(file);
        add({
          file,
          tests,
          message: `${file} changed — imported by ${chain[1]}, ${st.importedRole}`,
          path: chain,
        });
      }
    for (const m of ri.mappings) {
      // The tests that import a mapped specifier; every test of the runner when none is found
      // (the mapping may apply to a specifier analysis does not see, such as a stylesheet).
      let re: RegExp | undefined;
      try {
        re = m.regex ? new RegExp(m.find) : undefined;
      } catch {
        re = undefined;
      }
      const imports = ctx.importersOf((s) =>
        m.regex ? (re ? re.test(s) : true) : s === m.find || s.startsWith(`${m.find}/`),
      );
      // Imports analysis already resolves to the target are graph edges, at symbol precision.
      const importers = [
        ...new Set(imports.filter((i) => i.resolved !== m.file).map((i) => i.file)),
      ];
      if (imports.length && !importers.length) continue;
      const what = `"${m.find}" (${m.key} in ${m.source})`;
      for (const [file, chain] of closure(m.file, ctx.importsOf)) {
        if (!changed.has(file)) continue;
        // An importer the graph already links straight to this file (a framework edge, a
        // resolved alias) is traversed by the graph with symbol precision.
        const unlinked = importers.filter((f) => !ctx.dependsDirectly(f, file));
        if (importers.length && !unlinked.length) continue;
        const reached = new Set<string>();
        for (const f of unlinked) {
          if (ctx.isTest(f)) reached.add(f);
          for (const t of ctx.testsDependingOn(f)) reached.add(t);
        }
        add({
          file,
          tests: importers.length ? tests.filter((t) => reached.has(t)) : tests,
          message:
            file === m.file
              ? `${file} changed — ${name} maps ${what} to it`
              : `${file} changed — imported by ${chain[1]}, which ${name} maps ${what} to`,
          ...(chain.length > 1 ? { path: chain } : {}),
        });
      }
    }
    if (ri.computed.length) {
      const what = ri.computed.map((c) => `${c.key} in ${c.source}`).join(", ");
      warnings.push(
        `${name}: ${what} can't be read statically — a changed file no test imports selects every ${name} test`,
      );
      const dir = ri.root.dir;
      for (const c of ctx.changeSet.changes) {
        if (c.type === "deleted" || ctx.isTest(c.path)) continue;
        if (dir && !c.path.startsWith(`${dir}/`)) continue;
        if (!/\.[cm]?[jt]sx?$/.test(c.path) || ctx.reachesAnyTest(c.path)) continue;
        add({
          file: c.path,
          tests,
          message: `${c.path} changed — no test imports it, and ${name} may load it (${what} is computed)`,
        });
      }
    }
  }
  return { hits, warnings };
}

/** Every file the runner reads to run its tests, for cache keys. */
export function runnerInputFiles(
  ri: RunnerInputs,
  importsOf: (file: string) => readonly string[],
): string[] {
  const out = new Set<string>();
  for (const f of [...ri.configs.map((c) => c.file), ...ri.loads.map((l) => l.file)])
    for (const d of closure(f, importsOf).keys()) out.add(d);
  for (const m of ri.mappings) for (const d of closure(m.file, importsOf).keys()) out.add(d);
  return [...out].sort();
}
