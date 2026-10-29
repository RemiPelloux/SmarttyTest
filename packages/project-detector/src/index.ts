/**
 * @smarttest/project-detector — runtime, package manager, workspace, framework, runner,
 * layout, VCS, coverage and CI discovery, with evidence for every conclusion (spec §5.3).
 */

import { constants } from "node:fs";
import { access, readdir, stat } from "node:fs/promises";
import { arch, cpus, freemem, platform, totalmem } from "node:os";
import { dirname, join } from "node:path";
import { exists, matchGlob, readJson, readText, toPosix, walkFiles } from "@smarttest/shared";
import { detectTestCommands, type ExistingTestCommand } from "./commands.js";

export { detectTestCommands, type ExistingTestCommand } from "./commands.js";

export interface Evidence {
  value: string;
  evidence: string[];
}

export interface RuntimeInfo {
  os: string;
  arch: string;
  node: string;
  nodeSupported: boolean;
  cpus: number;
  totalMemoryMb: number;
  freeMemoryMb: number;
  rootWritable: boolean;
  recommendedWorkers: number;
}

export interface WorkspacePackage {
  name: string;
  dir: string;
  /** Declared by a workspace manifest, or an independent nested project. */
  kind: "workspace" | "nested";
  dependencies: string[];
  manifest: PackageManifest;
}

export interface PackageManifest {
  name?: string;
  version?: string;
  type?: string;
  packageManager?: string;
  workspaces?: string[] | { packages?: string[] };
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  exports?: unknown;
  main?: string;
  module?: string;
  types?: string;
  source?: string;
  jest?: unknown;
}

export interface RunnerInfo {
  adapter: "vitest" | "jest" | "node";
  dir: string;
  configFile?: string;
  /** Test file patterns given on the command line (node --test). */
  patterns?: string[];
  evidence: string[];
}

export interface TestConvention {
  layout: "mirror" | "colocated" | "mixed" | "none";
  testFiles: number;
  colocatedRatio: number;
  testDirs: string[];
  setupFiles: string[];
  fixtureDirs: string[];
  mockDirs: string[];
}

/** How one sub-project (a runner directory) lays out its tests. */
export interface ProjectTestConvention {
  dir: string;
  testFiles: number;
  colocatedRatio: number;
  /** Suffix between the source name and its extension for colocated tests (".test", ".server.test"). */
  suffix?: string;
  /** Directory (relative to the project) holding most non-colocated tests, if one dominates. */
  testDir?: string;
  /** Tests in testDir sit directly in it (no sub-folders). */
  flat?: boolean;
}

export interface SourceLayout {
  sourceRoots: string[];
  aliases: Record<string, string[]>;
  generatedDirs: string[];
  typescript: boolean;
  tsconfigFiles: string[];
  moduleType: "esm" | "cjs" | "mixed";
}

export interface VcsInfo {
  provider: "git" | "none";
  root?: string;
  nested: string[];
  unsupported: string[];
}

export interface ProjectProfile {
  root: string;
  name: string;
  runtime: RuntimeInfo;
  packageManager: Evidence & { name: "npm" | "pnpm" | "yarn" | "bun" | "unknown" };
  workspaces: WorkspacePackage[];
  frameworks: Evidence[];
  runners: RunnerInfo[];
  tests: TestConvention;
  /** Test conventions per runner directory (for repositories with several projects). */
  projectTests: ProjectTestConvention[];
  layout: SourceLayout;
  vcs: VcsInfo;
  coverage: Evidence[];
  /** How the project runs tests today (hooks, scripts, CI). */
  testCommands: ExistingTestCommand[];
  ci: Evidence[];
  warnings: string[];
}

const MIN_NODE = [22, 12];

export async function detectRuntime(root: string): Promise<RuntimeInfo> {
  const [major = 0, minor = 0] = process.versions.node.split(".").map(Number);
  let rootWritable = true;
  try {
    await access(root, constants.W_OK);
  } catch {
    rootWritable = false;
  }
  const count = cpus().length || 1;
  const freeMb = Math.round(freemem() / 1024 / 1024);
  // ~512 MB per worker, at least 1, at most cores - 1
  const recommendedWorkers = Math.max(1, Math.min(count - 1 || 1, Math.floor(freeMb / 512) || 1));
  return {
    os: platform(),
    arch: arch(),
    node: process.versions.node,
    nodeSupported:
      major > (MIN_NODE[0] as number) ||
      (major === MIN_NODE[0] && minor >= (MIN_NODE[1] as number)),
    cpus: count,
    totalMemoryMb: Math.round(totalmem() / 1024 / 1024),
    freeMemoryMb: freeMb,
    rootWritable,
    recommendedWorkers,
  };
}

async function detectPackageManager(
  root: string,
  manifest: PackageManifest | undefined,
  warnings: string[],
  projectDirs: readonly string[] = [],
) {
  const evidence: string[] = [];
  const found: ("npm" | "pnpm" | "yarn" | "bun")[] = [];
  const locks: [string, "npm" | "pnpm" | "yarn" | "bun"][] = [
    ["pnpm-lock.yaml", "pnpm"],
    ["yarn.lock", "yarn"],
    ["package-lock.json", "npm"],
    ["bun.lock", "bun"],
    ["bun.lockb", "bun"],
  ];
  for (const [file, pm] of locks) {
    if (await exists(join(root, file))) {
      found.push(pm);
      evidence.push(`lockfile ${file}`);
    }
  }
  // No root lockfile: a repo of independent projects, each with its own lockfile.
  if (!found.length) {
    for (const dir of projectDirs) {
      for (const [file, pm] of locks) {
        if (await exists(join(root, dir, file))) {
          found.push(pm);
          evidence.push(`lockfile ${dir}/${file}`);
          break;
        }
      }
    }
  }
  const declared = manifest?.packageManager?.split("@")[0] as
    | "npm"
    | "pnpm"
    | "yarn"
    | "bun"
    | undefined;
  if (declared) evidence.unshift(`package.json packageManager: ${manifest?.packageManager}`);
  const unique = [...new Set(found)];
  const perProject = evidence.some((e) => e.includes("/"));
  if (unique.length > 1 && !perProject)
    warnings.push(`Conflicting lockfiles (${unique.join(", ")}) — package manager is ambiguous`);
  const name = declared ?? (unique.length === 1 ? unique[0] : undefined) ?? unique[0] ?? "unknown";
  const value = name;
  return { name: name as ProjectProfile["packageManager"]["name"], value, evidence };
}

async function workspaceGlobs(
  root: string,
  manifest: PackageManifest | undefined,
): Promise<string[]> {
  const globs: string[] = [];
  const ws = manifest?.workspaces;
  if (Array.isArray(ws)) globs.push(...ws);
  else if (ws && Array.isArray(ws.packages)) globs.push(...ws.packages);
  const pnpm = await readText(join(root, "pnpm-workspace.yaml"));
  if (pnpm) {
    let inPackages = false;
    for (const line of pnpm.split(/\r?\n/)) {
      if (/^packages\s*:/.test(line)) {
        inPackages = true;
        continue;
      }
      if (inPackages) {
        const m = /^\s*-\s*["']?([^"'#]+?)["']?\s*(?:#.*)?$/.exec(line);
        if (m?.[1]) globs.push(m[1].trim());
        else if (/^\S/.test(line)) inPackages = false;
      }
    }
  }
  return globs;
}

async function detectWorkspaces(
  root: string,
  manifest: PackageManifest | undefined,
): Promise<WorkspacePackage[]> {
  const all = await workspaceGlobs(root, manifest);
  const globs = all.filter((g) => !g.startsWith("!"));
  const negated = all.filter((g) => g.startsWith("!")).map((g) => g.slice(1));
  const manifests = await walkFiles(root, { include: ["**/package.json"] });
  const out: WorkspacePackage[] = [];
  for (const m of manifests) {
    const dir = m === "package.json" ? "" : m.slice(0, -"/package.json".length);
    if (!dir) continue;
    // Declared workspaces when the root has them; otherwise every nested project counts
    // (repos made of independent packages, e.g. backend/ + app/ without a root manifest).
    const declared = globs.length > 0;
    if (declared && (!matchGlob(dir, globs) || matchGlob(dir, negated))) continue;
    const pkg = await readJson<PackageManifest>(join(root, m));
    if (!pkg) continue;
    out.push({
      name: pkg.name ?? dir,
      dir,
      kind: declared ? "workspace" : "nested",
      dependencies: Object.keys({
        ...pkg.dependencies,
        ...pkg.devDependencies,
        ...pkg.peerDependencies,
      }),
      manifest: pkg,
    });
  }
  const names = new Set(out.map((p) => p.name));
  for (const p of out) p.dependencies = p.dependencies.filter((d) => names.has(d));
  return out;
}

const FRAMEWORKS: { name: string; deps: string[]; files?: string[] }[] = [
  {
    name: "Next.js",
    deps: ["next"],
    files: ["next.config.js", "next.config.mjs", "next.config.ts"],
  },
  { name: "Wasp", deps: ["wasp"], files: ["main.wasp", "main.wasp.ts"] },
  { name: "NestJS", deps: ["@nestjs/core"], files: ["nest-cli.json"] },
  { name: "Remix", deps: ["@remix-run/react", "@react-router/dev"] },
  { name: "Astro", deps: ["astro"], files: ["astro.config.mjs", "astro.config.ts"] },
  { name: "React", deps: ["react"] },
  { name: "Vue", deps: ["vue"] },
  { name: "Svelte", deps: ["svelte"] },
  { name: "Express", deps: ["express"] },
  { name: "Fastify", deps: ["fastify"] },
  { name: "Hono", deps: ["hono"] },
  {
    name: "Prisma",
    deps: ["@prisma/client", "prisma"],
    files: ["schema.prisma", "prisma/schema.prisma"],
  },
];

function allDeps(m: PackageManifest | undefined): Record<string, string> {
  return { ...m?.dependencies, ...m?.devDependencies, ...m?.peerDependencies };
}

async function detectFrameworks(
  root: string,
  manifests: { dir: string; manifest: PackageManifest }[],
): Promise<Evidence[]> {
  const out: Evidence[] = [];
  for (const fw of FRAMEWORKS) {
    const evidence: string[] = [];
    for (const { dir, manifest } of manifests) {
      for (const d of fw.deps)
        if (allDeps(manifest)[d])
          evidence.push(`${dir ? `${dir}/` : ""}package.json depends on ${d}`);
      for (const file of fw.files ?? [])
        if (await exists(join(root, dir, file))) evidence.push(`${dir ? `${dir}/` : ""}${file}`);
    }
    if (evidence.length) out.push({ value: fw.name, evidence });
  }
  if (!out.length)
    out.push({
      value: "Node.js",
      evidence: ["no specific framework detected — treated as a generic Node.js project"],
    });
  return out;
}

const RUNNER_CONFIGS: Record<"vitest" | "jest", string[]> = {
  vitest: [
    "vitest.config.ts",
    "vitest.config.mts",
    "vitest.config.js",
    "vitest.config.mjs",
    "vitest.config.cts",
    "vitest.workspace.ts",
  ],
  jest: [
    "jest.config.ts",
    "jest.config.js",
    "jest.config.mjs",
    "jest.config.cjs",
    "jest.config.json",
  ],
};

const CUSTOM_VITEST_CONFIG = /^vitest(?:\.[\w-]+)?\.config(?:\.[\w-]+)?\.[cm]?[jt]s$/;
const CUSTOM_JEST_CONFIG = /^jest(?:\.[\w-]+)?\.config(?:\.[\w-]+)?\.(?:[cm]?[jt]s|json)$/;

/** `--config <file>` / `-c <file>` / `--config=<file>` in a script command. */
function scriptConfig(cmd: string, runner: string): string | undefined {
  const m = new RegExp(`\\b${runner}\\b[^&|;]*?(?:--config[= ]|\\s-c\\s)([^\\s&|;]+)`).exec(cmd);
  return m?.[1]?.replace(/^\.\//, "");
}

async function detectRunners(
  root: string,
  manifests: { dir: string; manifest: PackageManifest }[],
): Promise<RunnerInfo[]> {
  const out: RunnerInfo[] = [];
  const prefix = (dir: string) => (dir ? `${dir}/` : "");
  const add = (info: RunnerInfo) => {
    const existing = out.find(
      (r) => r.adapter === info.adapter && r.dir === info.dir && r.configFile === info.configFile,
    );
    if (existing)
      existing.evidence.push(...info.evidence.filter((e) => !existing.evidence.includes(e)));
    else out.push(info);
  };
  for (const { dir, manifest } of manifests) {
    let entries: string[] = [];
    try {
      entries = await readdir(join(root, dir));
    } catch {
      continue;
    }
    const scripts = Object.entries(manifest.scripts ?? {});
    for (const adapter of ["vitest", "jest"] as const) {
      const configs = new Map<string, string[]>();
      const standard = RUNNER_CONFIGS[adapter].find((f) => entries.includes(f));
      if (standard) configs.set(standard, [`config ${prefix(dir)}${standard}`]);
      for (const e of entries) {
        if (
          e !== standard &&
          (adapter === "vitest" ? CUSTOM_VITEST_CONFIG : CUSTOM_JEST_CONFIG).test(e)
        )
          configs.set(e, [`config ${prefix(dir)}${e}`]);
      }
      for (const [name, cmd] of scripts) {
        const cfg = scriptConfig(cmd, adapter);
        if (cfg && entries.includes(cfg))
          configs.set(cfg, [...(configs.get(cfg) ?? []), `script "${name}": ${cmd}`]);
      }
      if (adapter === "vitest" && !configs.size) {
        for (const vc of [
          "vite.config.ts",
          "vite.config.js",
          "vite.config.mts",
          "vite.config.mjs",
        ]) {
          const text = entries.includes(vc) ? await readText(join(root, dir, vc)) : undefined;
          if (text && /\btest\s*:/.test(text))
            configs.set(vc, [`${prefix(dir)}${vc} has a test block`]);
        }
      }
      const depEvidence: string[] = [];
      if (allDeps(manifest)[adapter])
        depEvidence.push(`${prefix(dir)}package.json depends on ${adapter}`);
      if (adapter === "jest" && manifest.jest)
        depEvidence.push(`${prefix(dir)}package.json "jest" field`);
      const plainScript = scripts.find(
        ([, cmd]) => new RegExp(`\\b${adapter}\\b`).test(cmd) && !scriptConfig(cmd, adapter),
      );
      if (plainScript) depEvidence.push(`script "${plainScript[0]}": ${plainScript[1]}`);
      for (const [cfg, evidence] of configs)
        add({
          adapter,
          dir,
          configFile: `${prefix(dir)}${cfg}`,
          evidence: [...evidence, ...depEvidence],
        });
      // A runner used without any config file runs with its defaults — only when no explicit config exists.
      if (!configs.size && depEvidence.length) add({ adapter, dir, evidence: depEvidence });
    }
    // Node's built-in runner: `node --test [patterns]`
    const nodeScript = scripts.find(([, cmd]) => /\bnode\b[^&|;]*\s--test\b/.test(cmd));
    if (nodeScript) {
      const patterns = (/--test\b((?:\s+(?!-)[^\s&|;]+)*)/.exec(nodeScript[1])?.[1] ?? "")
        .trim()
        .split(/\s+/)
        .filter((p) => p && !p.startsWith("-"))
        .map((p) => p.replace(/^["']|["']$/g, "").replace(/^\.\//, ""));
      add({
        adapter: "node",
        dir,
        ...(patterns.length ? { patterns } : {}),
        evidence: [`script "${nodeScript[0]}": ${nodeScript[1]}`],
      });
    }
  }
  return out;
}

async function detectTests(
  _root: string,
  files: string[],
  isTest: (f: string) => boolean,
): Promise<TestConvention> {
  const tests = files.filter(isTest);
  const fileSet = new Set(files);
  let colocated = 0;
  const testDirs = new Map<string, number>();
  for (const t of tests) {
    const base = t.replace(/\.(test|spec)(\.[cm]?[jt]sx?)$/, "$2").replace(/__tests__\//, "");
    // Also try without an environment segment: credits.server.test.ts → credits.ts
    const bases = [
      base,
      base.replace(
        /\.(?:server|client|node|browser|unit|int|integration|e2e)(\.[cm]?[jt]sx?)$/,
        "$1",
      ),
    ];
    const candidates = bases.flatMap((b) =>
      [".ts", ".tsx", ".js", ".jsx", ".mts", ".mjs", ".cjs", ".cts"].map((e) =>
        b.replace(/\.[cm]?[jt]sx?$/, e),
      ),
    );
    if (candidates.some((c) => fileSet.has(c) && c !== t)) colocated++;
    const top = t.split("/")[0] ?? "";
    if (["test", "tests", "__tests__", "spec", "e2e"].includes(top))
      testDirs.set(top, (testDirs.get(top) ?? 0) + 1);
  }
  const ratio = tests.length ? colocated / tests.length : 0;
  const layout: TestConvention["layout"] = !tests.length
    ? "none"
    : ratio >= 0.7
      ? "colocated"
      : ratio <= 0.3
        ? "mirror"
        : "mixed";
  const setupFiles = files.filter(
    (f) =>
      /(?:^|\/)(?:setupTests|(?:vitest|jest)\.setup|test-setup|setup)\.[cm]?[jt]s$/.test(f) &&
      !f.startsWith("src/"),
  );
  /** Directories (up to and including the matched segment) for files matching `re`. */
  const dirsOf = (re: RegExp) => {
    const out = new Set<string>();
    for (const f of files) {
      const m = re.exec(f);
      if (m) out.add(f.slice(0, m.index + m[0].length - 1));
    }
    return [...out];
  };
  return {
    layout,
    testFiles: tests.length,
    colocatedRatio: Math.round(ratio * 100) / 100,
    testDirs: [...testDirs].sort((a, b) => b[1] - a[1]).map(([d]) => d),
    setupFiles,
    fixtureDirs: dirsOf(/(?:^|\/)(?:fixtures|__fixtures__)\//),
    mockDirs: dirsOf(/(?:^|\/)(?:mocks|__mocks__)\//),
  };
}

function detectProjectTests(
  dirs: readonly string[],
  files: string[],
  isTest: (f: string) => boolean,
): ProjectTestConvention[] {
  const fileSet = new Set(files);
  const out: ProjectTestConvention[] = [];
  for (const dir of [...new Set(dirs)].filter(Boolean)) {
    const tests = files.filter((f) => f.startsWith(`${dir}/`) && isTest(f));
    if (!tests.length) continue;
    let colocated = 0;
    const suffixes = new Map<string, number>();
    const dirsCount = new Map<string, number>();
    for (const t of tests) {
      const m = /^(.*\/)?([^/]+?)((?:\.[\w-]+)*\.(?:test|spec))(\.[cm]?[jt]sx?)$/.exec(t);
      const parent = t.slice(0, t.lastIndexOf("/"));
      if (m) {
        const base = `${m[1] ?? ""}${m[2]}`;
        const sibling = [".ts", ".tsx", ".js", ".jsx", ".mts", ".mjs", ".cjs", ".cts"].some((e) =>
          fileSet.has(base + e),
        );
        if (sibling) {
          colocated++;
          suffixes.set(m[3] as string, (suffixes.get(m[3] as string) ?? 0) + 1);
          continue;
        }
      }
      const rel = parent.slice(dir.length + 1);
      dirsCount.set(rel, (dirsCount.get(rel) ?? 0) + 1);
    }
    const ratio = colocated / tests.length;
    const topSuffix = [...suffixes].sort((a, b) => b[1] - a[1])[0];
    const topDir = [...dirsCount].sort((a, b) => b[1] - a[1])[0];
    const others = tests.length - colocated;
    out.push({
      dir,
      testFiles: tests.length,
      colocatedRatio: Math.round(ratio * 100) / 100,
      ...(topSuffix && topSuffix[1] >= colocated * 0.6 ? { suffix: topSuffix[0] } : {}),
      ...(topDir && others && topDir[1] >= others * 0.6
        ? { testDir: topDir[0], flat: topDir[1] === others && dirsCount.size === 1 }
        : {}),
    });
  }
  return out;
}

async function detectLayout(
  root: string,
  files: string[],
  manifest: PackageManifest | undefined,
): Promise<SourceLayout> {
  const sourceRoots = new Set<string>();
  for (const f of files) {
    const m = /^(?:(.+?)\/)?(src|lib|app|server|source)\//.exec(f);
    if (m) sourceRoots.add(m[1] ? `${m[1]}/${m[2]}` : (m[2] as string));
  }
  const tsconfigFiles = files.filter((f) => /(?:^|\/)tsconfig[^/]*\.json$/.test(f));
  const aliases: Record<string, string[]> = {};
  for (const tc of tsconfigFiles) {
    const text = await readText(join(root, tc));
    if (!text) continue;
    try {
      const json = JSON.parse(
        text.replace(/\/\*[\s\S]*?\*\/|^\s*\/\/.*$/gm, "").replace(/,(\s*[}\]])/g, "$1"),
      ) as {
        compilerOptions?: { paths?: Record<string, string[]> };
      };
      Object.assign(aliases, json.compilerOptions?.paths ?? {});
    } catch {
      /* comments or trailing commas we can't strip — ignore, resolution still uses the real TS parser */
    }
  }
  const generatedDirs: string[] = [];
  for (const d of [
    ".next",
    "dist",
    "build",
    "out",
    "coverage",
    "generated",
    "src/generated",
    ".nuxt",
  ]) {
    try {
      if ((await stat(join(root, d))).isDirectory()) generatedDirs.push(d);
    } catch {
      /* missing */
    }
  }
  const exts = files.map((f) => f.slice(f.lastIndexOf(".")));
  const cjsHints = exts.filter((e) => e === ".cjs").length + (manifest?.type === "module" ? 0 : 1);
  const esmHints =
    exts.filter((e) => e === ".mjs" || e === ".mts").length + (manifest?.type === "module" ? 1 : 0);
  return {
    sourceRoots: [...sourceRoots].sort(),
    aliases,
    generatedDirs,
    typescript: files.some((f) => /\.[cm]?tsx?$/.test(f)) || tsconfigFiles.length > 0,
    tsconfigFiles,
    moduleType: esmHints && cjsHints > 1 ? "mixed" : esmHints ? "esm" : "cjs",
  };
}

async function findUp(start: string, marker: string): Promise<string | undefined> {
  let dir = start;
  for (;;) {
    if (await exists(join(dir, marker))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

async function detectVcs(root: string): Promise<VcsInfo> {
  const gitRoot = await findUp(root, ".git");
  const unsupported: string[] = [];
  for (const [marker, name] of [
    [".svn", "SVN"],
    [".hg", "Mercurial"],
    [".p4config", "Perforce"],
  ] as const) {
    if (await findUp(root, marker))
      unsupported.push(
        `${name} detected — not supported in 1.0 (native snapshots will be used unless Git is present)`,
      );
  }
  const nested: string[] = [];
  if (gitRoot) {
    const dirs = await walkFiles(root, {
      include: ["**/.git/HEAD", "**/.git"],
      ignoredDirs: new Set(["node_modules", ".smarttest"]),
    }).catch(() => []);
    for (const d of dirs) {
      const dir = d.replace(/\/?\.git(?:\/HEAD)?$/, "");
      if (dir) nested.push(dir);
    }
  }
  return gitRoot
    ? { provider: "git", root: toPosix(gitRoot), nested: [...new Set(nested)], unsupported }
    : { provider: "none", nested, unsupported };
}

async function detectCoverage(
  manifests: { dir: string; manifest: PackageManifest }[],
  files: string[],
): Promise<Evidence[]> {
  const out: Evidence[] = [];
  for (const { dir, manifest } of manifests) {
    const deps = allDeps(manifest);
    for (const [dep, label] of [
      ["@vitest/coverage-v8", "vitest v8"],
      ["@vitest/coverage-istanbul", "vitest istanbul"],
      ["nyc", "nyc (istanbul)"],
      ["c8", "c8 (v8)"],
    ] as const) {
      if (deps[dep])
        out.push({
          value: label,
          evidence: [`${dir ? `${dir}/` : ""}package.json depends on ${dep}`],
        });
    }
    if (deps.jest)
      out.push({
        value: "jest built-in (babel/v8)",
        evidence: [`${dir ? `${dir}/` : ""}package.json depends on jest`],
      });
  }
  if (files.some((f) => f === "coverage/coverage-final.json"))
    out.push({ value: "existing istanbul report", evidence: ["coverage/coverage-final.json"] });
  return out;
}

async function detectCi(root: string): Promise<Evidence[]> {
  const out: Evidence[] = [];
  try {
    const wf = (await readdir(join(root, ".github", "workflows"))).filter((f) =>
      /\.ya?ml$/.test(f),
    );
    if (wf.length)
      out.push({ value: "GitHub Actions", evidence: wf.map((f) => `.github/workflows/${f}`) });
  } catch {
    /* none */
  }
  for (const [file, name] of [
    [".gitlab-ci.yml", "GitLab CI"],
    ["Jenkinsfile", "Jenkins"],
    ["azure-pipelines.yml", "Azure Pipelines"],
    [".circleci/config.yml", "CircleCI"],
  ] as const) {
    if (await exists(join(root, file))) out.push({ value: name, evidence: [file] });
  }
  return out;
}

export interface DetectOptions {
  isTestFile?: (path: string) => boolean;
}

/** Full project detection. Read-only: never writes anything. */
export async function detectProject(
  root: string,
  options: DetectOptions = {},
): Promise<ProjectProfile> {
  const warnings: string[] = [];
  const manifest = await readJson<PackageManifest>(join(root, "package.json"));
  const files = await walkFiles(root);
  const workspaces = await detectWorkspaces(root, manifest);
  if (!manifest && !workspaces.length) warnings.push("No package.json found in this project");
  const manifests = [
    ...(manifest ? [{ dir: "", manifest }] : []),
    ...workspaces.map((w) => ({ dir: w.dir, manifest: w.manifest })),
  ];
  const runtime = await detectRuntime(root);
  if (!runtime.nodeSupported)
    warnings.push(`Node ${runtime.node} is not supported — use Node 22.12+ or 24 LTS`);
  const isTest =
    options.isTestFile ??
    ((f: string) => /(?:^|\/)(?:__tests__\/.+|[^/]+\.(?:test|spec))\.[cm]?[jt]sx?$/.test(f));
  const runners = await detectRunners(root, manifests);
  if (!runners.length)
    warnings.push("No Jest or Vitest setup detected — install one to run tests through SmartTest");
  const vcs = await detectVcs(root);
  warnings.push(...vcs.unsupported);
  return {
    root,
    name: manifest?.name ?? root.split(/[\\/]/).pop() ?? "project",
    runtime,
    packageManager: await detectPackageManager(
      root,
      manifest,
      warnings,
      workspaces.map((w) => w.dir),
    ),
    workspaces,
    frameworks: await detectFrameworks(root, manifests),
    runners,
    tests: await detectTests(root, files, isTest),
    projectTests: detectProjectTests(
      runners.map((r) => r.dir),
      files,
      isTest,
    ),
    layout: await detectLayout(root, files, manifest),
    vcs,
    coverage: await detectCoverage(manifests, files),
    ci: await detectCi(root),
    testCommands: await detectTestCommands(
      root,
      workspaces.map((w) => w.dir),
    ),
    warnings,
  };
}
