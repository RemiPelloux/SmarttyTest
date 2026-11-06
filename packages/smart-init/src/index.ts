/**
 * @smarttest/smart-init — explained, previewable, idempotent and reversible setup (spec §5).
 */
import { chmod, readFile, realpath, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { Rule, SmartTestConfig } from "@smarttest/config";
import { findConfigFile } from "@smarttest/config";
import type { ProjectProfile } from "@smarttest/project-detector";
import {
  assertNoSymlinkBelow,
  detectIndent,
  exists,
  PACKAGE_NAME,
  readJson,
  readText,
  relPosix,
  runProcess,
  sha256,
  writeFileAtomic,
  writeJson,
} from "@smarttest/shared";
import { planCaptainHookUninstall } from "./captainhook.js";
import { detectHookTarget, planHookUninstall } from "./hooks.js";

export * from "./captainhook.js";
export * from "./hooks.js";
export * from "./migrate.js";
export * from "./trailer.js";

export interface Recommendation {
  key: string;
  value: string;
  reason: string;
  evidence: string[];
}

export interface FilePlan {
  path: string;
  action: "create" | "modify" | "skip";
  reason: string;
  before?: string;
  after?: string;
  /** Low-risk changes are applied by `init --auto`. */
  risk: "low" | "medium";
  /** File mode to set after writing (executable hooks). */
  mode?: number;
  /**
   * The project's own formatter, run on `after` just before the (atomic) write so the new file
   * passes the project's format check. A formatter failure is a warning: the file is written as
   * generated.
   */
  format?: LocalFormatter;
}

export interface LocalFormatter {
  name: "Prettier" | "Biome";
  /** The formatter's Node entry point, run with this Node (no shell, no `.cmd` shim). */
  script: string;
}

/**
 * Prettier or Biome installed in the project (`node_modules/.bin`), resolved to the package's
 * Node entry point. Prettier wins when both are installed.
 */
export async function localFormatter(root: string): Promise<LocalFormatter | undefined> {
  for (const [name, bin, pkg] of [
    ["Prettier", "prettier", "prettier"],
    ["Biome", "biome", "@biomejs/biome"],
  ] as const) {
    const shim = join(root, "node_modules", ".bin", bin);
    if (!(await exists(shim)) && !(await exists(`${shim}.cmd`))) continue;
    const manifest = await readJson<{ bin?: string | Record<string, string> }>(
      join(root, "node_modules", pkg, "package.json"),
    );
    const entry = typeof manifest?.bin === "string" ? manifest.bin : manifest?.bin?.[bin];
    if (!entry) continue;
    const script = resolve(root, "node_modules", pkg, entry);
    if (await exists(script)) return { name, script };
  }
  return undefined;
}

/** Formats `text` as the file `path` with the project's formatter (stdin to stdout). */
async function formatWith(
  root: string,
  formatter: LocalFormatter,
  path: string,
  text: string,
): Promise<string> {
  const args =
    formatter.name === "Prettier"
      ? ["--stdin-filepath", path]
      : ["format", `--stdin-file-path=${path}`];
  const r = await runProcess(process.execPath, [formatter.script, ...args], {
    cwd: root,
    input: text,
    timeoutMs: 30_000,
  });
  if (r.code !== 0 || !r.stdout.trim())
    throw new Error(
      (r.stderr || r.stdout).trim().split("\n")[0] || (r.timedOut ? "timed out" : `exit ${r.code}`),
    );
  return r.stdout;
}

export interface SetupPlan {
  summary: string;
  recommendations: Recommendation[];
  warnings: string[];
  files: FilePlan[];
  config: SmartTestConfig;
}

export interface PlanInputs {
  untestedModules: string[];
  globalConfigFiles: string[];
  overrides?: Partial<Pick<SmartTestConfig, "mode">> & {
    layout?: "mirror" | "colocated" | "domain" | "custom";
    adapters?: ("vitest" | "jest" | "node" | "playwright" | "cypress" | "angular" | "phpunit")[];
  };
}

export const SCRIPTS: Record<string, string> = {
  "test:affected": "smarttest run --affected",
  "test:explain": "smarttest explain",
};

function suggestedRules(profile: ProjectProfile, sourceFiles: readonly string[]): Rule[] {
  const rules: Rule[] = [];
  const critical = new Set<string>();
  for (const f of sourceFiles) {
    const m = /^(.*?\/)?(auth|authentication|security|payments?|billing)\//.exec(f);
    if (m) critical.add(`${m[1] ?? ""}${m[2]}/**`);
  }
  for (const path of [...critical].slice(0, 3)) {
    const segs = path.replace(/\/\*\*$/, "").split("/");
    let name = `${segs.at(-1)}-critical`;
    // Two "auth/" folders in different projects must not produce the same rule name.
    if (rules.some((r) => r.name === name)) name = `${segs[0]}-${segs.at(-1)}-critical`;
    for (let n = 2; rules.some((r) => r.name === name); n++) name = `${segs.at(-1)}-critical-${n}`;
    rules.push({
      name,
      match: { path },
      risk: "critical",
      execution: { alwaysRunOnAffected: true },
    });
  }
  if (profile.frameworks.some((f) => f.value === "NestJS")) {
    rules.push({
      name: "controllers-integration",
      match: { decorator: "Controller" },
      require: ["integration"],
    });
  }
  if (sourceFiles.some((f) => /Service\.[cm]?[jt]sx?$/.test(f)))
    rules.push({
      name: "service-tests",
      match: { class: "*Service" },
      require: ["unit"],
      generate: { template: "service" },
    });
  return rules;
}

/** Renders a value as a readable JS literal: short arrays/objects stay on one line. */
function renderValue(v: unknown, indent: string): string {
  const key = (k: string) => (/^[A-Za-z_$][\w$]*$/.test(k) ? k : JSON.stringify(k));
  const inline = (x: unknown): string =>
    Array.isArray(x)
      ? `[${x.map(inline).join(", ")}]`
      : x && typeof x === "object"
        ? `{ ${Object.entries(x)
            .map(([k, val]) => `${key(k)}: ${inline(val)}`)
            .join(", ")} }`
        : JSON.stringify(x);
  const one = inline(v);
  if (one.length <= 72 || typeof v !== "object" || v === null) return one;
  const next = `${indent}  `;
  if (Array.isArray(v))
    return `[\n${v.map((x) => `${next}${renderValue(x, next)},`).join("\n")}\n${indent}]`;
  return `{\n${Object.entries(v as Record<string, unknown>)
    .map(([k, val]) => `${next}${key(k)}: ${renderValue(val, next)},`)
    .join("\n")}\n${indent}}`;
}

const BROWSER_RUNNERS = ["playwright", "cypress"];

/**
 * The hook scope to propose when browser end-to-end runners sit next to a unit runner: the hook
 * runs the unit runners, and selected browser specs are reported as left to CI. Undefined when
 * there is nothing to separate.
 */
export function suggestHookRunners(
  adapters: readonly string[],
): NonNullable<NonNullable<SmartTestConfig["hook"]>["runners"]> | undefined {
  const unique = [...new Set(adapters)];
  const unit = unique.filter((a) => !BROWSER_RUNNERS.includes(a));
  if (!unit.length || unit.length === unique.length) return undefined;
  return unit as NonNullable<NonNullable<SmartTestConfig["hook"]>["runners"]>;
}

export function renderConfigFile(config: SmartTestConfig, typescript: boolean): string {
  const lines = [
    typescript
      ? `import { defineConfig } from "${PACKAGE_NAME}";`
      : `// @ts-check\nimport { defineConfig } from "${PACKAGE_NAME}";`,
    "",
    "// Generated by `smarttest init`. Edit freely — re-running init never overwrites this file.",
    "// Reference: https://github.com/RemiPelloux/SmarttyTest/blob/main/documentation/reference/configuration.md",
    "export default defineConfig({",
  ];
  for (const [k, v] of Object.entries(config)) {
    if (v === undefined) continue;
    lines.push(`  ${k}: ${renderValue(v, "  ")},`);
  }
  lines.push("});", "");
  return lines.join("\n");
}

export async function buildPlan(
  profile: ProjectProfile,
  sourceFiles: readonly string[],
  inputs: PlanInputs,
): Promise<SetupPlan> {
  const root = profile.root;
  const recs: Recommendation[] = [];
  const warnings = [...profile.warnings];
  const adapters =
    inputs.overrides?.adapters ??
    ([...new Set(profile.runners.map((r) => r.adapter))] as (
      | "vitest"
      | "jest"
      | "node"
      | "playwright"
      | "cypress"
    )[]);
  const layout =
    inputs.overrides?.layout ?? (profile.tests.colocatedRatio >= 0.5 ? "colocated" : "mirror");
  const testDir =
    profile.tests.testDirs.find((d) => d === "tests" || d === "test" || d === "__tests__") ??
    "tests";

  recs.push({
    key: "Test layout",
    value: layout,
    reason: profile.tests.testFiles
      ? `${Math.round((layout === "colocated" ? profile.tests.colocatedRatio : 1 - profile.tests.colocatedRatio) * 100)}% of existing tests follow this convention`
      : "no existing tests — mirror keeps tests separate from sources",
    evidence: [`${profile.tests.testFiles} test files detected`],
  });
  // Per-project conventions when sub-projects lay out their tests differently.
  const conventions: [string, NonNullable<SmartTestConfig["projects"]>[string]][] = [];
  for (const p of profile.projectTests ?? []) {
    if (p.testFiles < 3) continue;
    if (p.colocatedRatio >= 0.7) {
      const naming =
        p.suffix && p.suffix !== ".test" ? `{FileName}${p.suffix}.{Extension}` : undefined;
      conventions.push([p.dir, { tests: { layout: "colocated", ...(naming ? { naming } : {}) } }]);
    } else if (p.colocatedRatio <= 0.3 && p.testDir !== undefined && p.flat) {
      conventions.push([
        p.dir,
        { tests: { layout: "custom", path: `${p.dir}/${p.testDir}/{FileName}.test.{Extension}` } },
      ]);
    } else if (p.colocatedRatio <= 0.3 && p.testDir !== undefined) {
      conventions.push([p.dir, { tests: { layout: "mirror", directory: p.testDir } }]);
    }
  }
  const distinct = new Set(conventions.map(([, c]) => JSON.stringify(c)));
  const projects =
    conventions.length >= 2 && distinct.size >= 2 ? Object.fromEntries(conventions) : undefined;
  if (projects)
    recs.push({
      key: "Project tests",
      value: Object.entries(projects)
        .map(
          ([d, c]) =>
            `${d}: ${c.tests?.layout}${c.tests?.naming ? ` ${c.tests.naming}` : ""}${c.tests?.path ? ` ${c.tests.path}` : ""}`,
        )
        .join(" · "),
      reason:
        "sub-projects lay out their tests differently; generated tests follow each project's own convention",
      evidence: (profile.projectTests ?? []).map(
        (p) => `${p.dir}: ${p.testFiles} tests, ${Math.round(p.colocatedRatio * 100)}% colocated`,
      ),
    });
  if (adapters.length) {
    recs.push({
      key: "Adapter",
      value: adapters.join(", "),
      reason: "existing runner configuration is reused as-is",
      evidence: profile.runners.flatMap((r) => r.evidence),
    });
  } else {
    warnings.push("No test runner found — install vitest or jest, then re-run `smarttest init`");
  }
  recs.push({
    key: "Change tracking",
    value:
      profile.vcs.provider === "none"
        ? "native snapshots"
        : `${profile.vcs.provider} + native snapshots`,
    reason:
      profile.vcs.provider === "none"
        ? "no version control detected — snapshots track changes locally"
        : `${profile.vcs.provider === "git" ? "Git" : profile.vcs.provider === "svn" ? "Subversion" : "Mercurial"} repository detected; snapshots speed up repeated local runs`,
    evidence:
      profile.vcs.provider === "none"
        ? ["no .git, .svn or .hg found"]
        : [`${profile.vcs.provider} root ${profile.vcs.root}`],
  });
  recs.push({
    key: "Impact mode",
    value: inputs.overrides?.mode ?? "balanced",
    reason: "recommended default: transitive selection with conservative handling of uncertainty",
    evidence: [],
  });
  recs.push({
    key: "Coverage",
    value: profile.coverage[0]?.value ?? "none detected",
    reason: profile.coverage.length
      ? "existing provider is reused"
      : "coverage is optional; install a provider to enable `--coverage`",
    evidence: profile.coverage.flatMap((c) => c.evidence),
  });
  recs.push({
    key: "Workers",
    value: String(profile.runtime.recommendedWorkers),
    reason: `${profile.runtime.cpus} CPUs, ${profile.runtime.freeMemoryMb} MB free memory`,
    evidence: [],
  });
  const rules = suggestedRules(profile, sourceFiles);
  if (rules.length)
    recs.push({
      key: "Suggested rules",
      value: rules.map((r) => r.name).join(", "),
      reason: "critical areas and conventions found in the source tree",
      evidence: rules.map((r) => JSON.stringify(r.match)),
    });
  if (inputs.untestedModules.length)
    warnings.push(
      `${inputs.untestedModules.length} module(s) have no matching tests (e.g. ${inputs.untestedModules.slice(0, 3).join(", ")})`,
    );
  if (inputs.globalConfigFiles.length)
    warnings.push(
      `${inputs.globalConfigFiles.length} configuration file(s) widen test selection in their project when changed (${inputs.globalConfigFiles.slice(0, 4).join(", ")})`,
    );

  const ignoredByCommands = [...new Set(profile.testCommands.flatMap((c) => c.ignores))];
  if (ignoredByCommands.length) {
    recs.push({
      key: "Skipped tests",
      value: ignoredByCommands.join(", "),
      reason: "your existing test commands skip these, so SmartTest does too",
      evidence: profile.testCommands
        .filter((c) => c.ignores.length)
        .map((c) => `${c.source}${c.line ? `:${c.line}` : ""}`),
    });
  }
  const hookRunners = suggestHookRunners(adapters);
  if (hookRunners)
    recs.push({
      key: "Hook scope",
      value: `hook.runners: [${hookRunners.join(", ")}]`,
      reason: `commit hooks run ${hookRunners.join(", ")}; selected ${adapters.filter((a) => BROWSER_RUNNERS.includes(a)).join(", ")} specs need a browser, so the hook reports them as "selected, not run in the hook (left to CI)" — \`smarttest run\` and \`smarttest ci\` still run them`,
      evidence: profile.runners.flatMap((r) => r.evidence),
    });
  const hookCommands = profile.testCommands.filter((c) =>
    /husky|hooks|lefthook|pre-commit-config/.test(c.source),
  );
  if (hookCommands.length) {
    const hookFile = hookCommands[0]?.source ?? "";
    // Tests kept in pre-push stay there (see SmartTest.initPlan): the push variant runs.
    const push = hookCommands.every((c) => c.source.includes("pre-push"));
    recs.push({
      key: "Git hook",
      value: push ? "smarttest run --push" : "smarttest run --staged",
      reason: `${hookFile} runs ${hookCommands.length} full suite(s) (${[...new Set(hookCommands.map((c) => c.adapter))].join(", ")}); one affected-tests run can replace them`,
      evidence: hookCommands.map((c) => `${c.source}:${c.line}`),
    });
  }
  const exclude = [
    ...profile.layout.generatedDirs
      .filter((d) => !["dist", "build", "coverage", ".next", "out"].includes(d))
      .map((d) => `${d}/**`),
    ...ignoredByCommands,
  ];
  const config: SmartTestConfig = {
    mode: inputs.overrides?.mode ?? "balanced",
    ...(adapters.length ? { adapters } : {}),
    vcs: { provider: "auto", snapshots: true },
    tests: { layout, directory: testDir },
    ...(projects ? { projects } : {}),
    ...(exclude.length ? { exclude } : {}),
    ...(rules.length ? { rules } : {}),
    ...(hookRunners ? { hook: { runners: hookRunners } } : {}),
    // PHP is a preview: the toggle is written down, so turning it off is one edit.
    ...(profile.runners.some((r) => r.adapter === "phpunit") ? { php: { enabled: true } } : {}),
    reports: { formats: ["html", "json", "junit"] },
  };

  const files: FilePlan[] = [];
  const existingConfig = await findConfigFile(root);
  if (existingConfig) {
    files.push({
      path: existingConfig.slice(root.length + 1),
      action: "skip",
      reason: "existing configuration preserved",
      risk: "low",
    });
  } else if (!(await readText(join(root, "package.json")))) {
    // No package.json (a PHP or Python project): SmartTest runs through npx, so its package is
    // not installed beside the config; a JSON config loads without importing it.
    files.push({
      path: "smarttest.config.json",
      action: "create",
      reason: "SmartTest configuration (JSON: the project has no package.json)",
      after: `${JSON.stringify(config, null, 2)}\n`,
      risk: "low",
    });
  } else {
    const name = profile.layout.typescript ? "smarttest.config.ts" : "smarttest.config.mjs";
    const formatter = await localFormatter(root);
    files.push({
      path: name,
      action: "create",
      reason: `SmartTest configuration${formatter ? ` (formatted with the project's ${formatter.name} when written)` : ""}`,
      after: renderConfigFile(config, profile.layout.typescript),
      risk: "low",
      ...(formatter ? { format: formatter } : {}),
    });
  }
  const pkgText = await readText(join(root, "package.json"));
  // A PHP application with a package.json for its front-end assets (Vite) runs SmartTest through
  // npx: npm scripts would name a `smarttest` that is not installed there.
  const phpFirst =
    !!pkgText &&
    profile.runners.some((r) => r.adapter === "phpunit") &&
    !profile.runners.some(
      (r) => r.dir === "" && !["phpunit", "pytest", "unittest"].includes(r.adapter),
    ) &&
    !/"@tkmremi\/smarttest"\s*:/.test(pkgText);
  if (phpFirst)
    files.push({
      path: "package.json",
      action: "skip",
      reason:
        "SmartTest is not one of its dependencies: run it with `npx --yes @tkmremi/smarttest` (or `npm install -D @tkmremi/smarttest` to add the scripts)",
      risk: "low",
    });
  else if (pkgText) {
    try {
      const pkg = JSON.parse(pkgText) as { scripts?: Record<string, string> };
      const scripts = { ...(pkg.scripts ?? {}) };
      const missing = Object.entries(SCRIPTS).filter(([k]) => !(k in scripts));
      if (!missing.length)
        files.push({
          path: "package.json",
          action: "skip",
          reason: "scripts already present",
          risk: "medium",
        });
      else {
        for (const [k, v] of missing) scripts[k] = v;
        const next = { ...pkg, scripts };
        const after = `${JSON.stringify(next, null, detectIndent(pkgText))}${pkgText.endsWith("\n") ? "\n" : ""}`;
        files.push({
          path: "package.json",
          action: "modify",
          reason: `add scripts: ${missing.map(([k]) => k).join(", ")}`,
          before: pkgText,
          after,
          risk: "medium",
        });
      }
    } catch {
      warnings.push("package.json is not valid JSON — scripts were not added");
    }
  }
  const gi = await readText(join(root, ".gitignore"));
  const ignored = gi?.split(/\r?\n/).some((l) => /^\/?\.smarttest\/?$/.test(l.trim()));
  if (ignored)
    files.push({
      path: ".gitignore",
      action: "skip",
      reason: ".smarttest/ already ignored",
      risk: "low",
    });
  else if (gi !== undefined)
    files.push({
      path: ".gitignore",
      action: "modify",
      reason: "ignore local SmartTest state",
      before: gi,
      after: `${gi}${gi.endsWith("\n") || gi === "" ? "" : "\n"}.smarttest/\n`,
      risk: "low",
    });
  else
    files.push({
      path: ".gitignore",
      action: "create",
      reason: "ignore local SmartTest state",
      after: ".smarttest/\n",
      risk: "low",
    });

  const fw = profile.frameworks.map((f) => f.value).join(" + ");
  const lang = profile.layout.typescript ? "TypeScript" : "JavaScript";
  const pm =
    profile.packageManager.name === "unknown" ? "no lockfile" : profile.packageManager.name;
  const label: Record<string, string> = {
    vitest: "Vitest",
    jest: "Jest",
    node: "node:test",
    playwright: "Playwright",
    cypress: "Cypress",
    angular: "ng test",
    pytest: "pytest",
    unittest: "unittest",
    phpunit: "PHPUnit",
  };
  const summary = `${[fw, lang].filter(Boolean).join(" + ")}${adapters.length ? ` + ${adapters.map((a) => label[a] ?? a).join(" + ")}` : ""} · ${pm}${profile.workspaces.length ? (profile.workspaces.every((w) => w.kind === "nested") ? ` · ${profile.workspaces.length} independent projects` : ` workspace (${profile.workspaces.length} packages)`) : ""} · ${profile.vcs.provider === "git" ? "Git" : "no VCS"}`;
  return { summary, recommendations: recs, warnings, files, config };
}

/**
 * Line diff for previews, in file order: "@ line n" before each changed region (n is the line in
 * the new file), then "- removed" and "+ added" lines. Repeated lines such as `fi` are kept.
 */
export function previewDiff(plan: FilePlan): string[] {
  if (plan.action === "skip") return [];
  const before = (plan.before ?? "").split("\n");
  const after = (plan.after ?? "").split("\n");
  if (plan.action === "create")
    return after.filter((l, i) => i < after.length - 1 || l !== "").map((l) => `+ ${l}`);
  let start = 0;
  while (start < before.length && start < after.length && before[start] === after[start]) start++;
  let endB = before.length;
  let endA = after.length;
  while (endB > start && endA > start && before[endB - 1] === after[endA - 1]) {
    endB--;
    endA--;
  }
  const b = before.slice(start, endB);
  const a = after.slice(start, endA);
  // Longest common subsequence of the differing middle; previewed files are small.
  const lcs = Array.from({ length: b.length + 1 }, () => new Uint32Array(a.length + 1));
  for (let i = b.length - 1; i >= 0; i--)
    for (let j = a.length - 1; j >= 0; j--)
      (lcs[i] as Uint32Array)[j] =
        b[i] === a[j]
          ? ((lcs[i + 1] as Uint32Array)[j + 1] as number) + 1
          : Math.max(
              (lcs[i + 1] as Uint32Array)[j] as number,
              (lcs[i] as Uint32Array)[j + 1] as number,
            );
  const out: string[] = [];
  let open = false;
  let i = 0;
  let j = 0;
  const change = (line: string) => {
    if (!open) out.push(`@ line ${start + j + 1}`);
    open = true;
    out.push(line);
  };
  while (i < b.length || j < a.length) {
    if (i < b.length && j < a.length && b[i] === a[j]) {
      open = false;
      i++;
      j++;
    } else if (
      i < b.length &&
      (j === a.length ||
        ((lcs[i + 1] as Uint32Array)[j] as number) >= ((lcs[i] as Uint32Array)[j + 1] as number))
    )
      change(`- ${b[i++]}`);
    else {
      change(`+ ${a[j]}`);
      j++;
    }
  }
  return out;
}

export interface JournalEntry {
  path: string;
  action: "create" | "modify";
  before?: string;
  afterHash: string;
}

export interface Journal {
  version: 1;
  createdAt: string;
  entries: JournalEntry[];
}

const journalPath = (storeDir: string) => join(storeDir, "state", "init-journal.json");

/**
 * Applies file changes atomically and records a journal for rollback (spec §5.7). With
 * `journal: false` (changes that are not init's, such as `hook install`) nothing is recorded, so
 * `init --rollback` never undoes them; the returned entries list what was written.
 */
export async function applyPlan(
  root: string,
  storeDir: string,
  plan: SetupPlan,
  options: { onlyLowRisk?: boolean; journal?: boolean; onWarning?: (message: string) => void } = {},
): Promise<Journal> {
  const record = options.journal !== false;
  const previous = record ? await readJson<Journal>(journalPath(storeDir)) : undefined;
  const entries: JournalEntry[] = [...(previous?.entries ?? [])];
  for (const fp of plan.files) {
    if (fp.action === "skip" || fp.after === undefined) continue;
    if (options.onlyLowRisk && fp.risk !== "low") continue;
    const abs = join(root, fp.path);
    // A committed directory link (`.husky -> ~/bin`) must not carry a write out of the project.
    // Paths that leave the project are Git's own hook files, resolved by Git (`../.git/hooks`).
    if (relPosix(root, abs) !== undefined) assertNoSymlinkBelow(root, dirname(abs));
    const current = await readText(abs);
    if (fp.action === "create" && current !== undefined) continue; // appeared meanwhile — never overwrite
    if (fp.action === "modify" && current !== fp.before) continue; // changed since planning — skip safely
    let after = fp.after;
    if (fp.format)
      try {
        after = await formatWith(root, fp.format, fp.path, fp.after);
      } catch (error) {
        options.onWarning?.(
          `${fp.path} was written unformatted: ${fp.format.name} failed (${(error as Error).message}) — run your formatter on it`,
        );
      }
    await writeFileAtomic(abs, after);
    if (fp.mode !== undefined) await chmod(abs, fp.mode);
    const prior = entries.find((e) => e.path === fp.path);
    if (prior) prior.afterHash = sha256(after);
    else
      entries.push({
        path: fp.path,
        action: fp.action,
        ...(fp.action === "modify" ? { before: fp.before as string } : {}),
        afterHash: sha256(after),
      });
  }
  const journal: Journal = {
    version: 1,
    createdAt: previous?.createdAt ?? new Date().toISOString(),
    entries,
  };
  if (record && entries.length) await writeJson(journalPath(storeDir), journal);
  return journal;
}

export interface RollbackResult {
  restored: string[];
  removed: string[];
  conflicts: string[];
}

/**
 * The journal lives in the store, which repository content can plant: an entry may only name a
 * file inside the project reached without directory links, or one of Git's own hook files (which
 * Git may keep outside the project, e.g. a subdirectory project or a linked worktree).
 */
async function journalTargetAllowed(root: string, path: string): Promise<boolean> {
  if (path.includes("\0")) return false;
  const abs = resolve(root, path);
  if (relPosix(root, abs) !== undefined) {
    try {
      assertNoSymlinkBelow(root, dirname(abs));
      return true;
    } catch {
      return false;
    }
  }
  const real = await realpath(root).catch(() => root);
  for (const stage of ["pre-commit", "pre-push", "commit-msg"] as const) {
    const hook = (await detectHookTarget(root, "git", stage)).file;
    if (resolve(root, hook) === abs || resolve(real, hook) === resolve(real, path)) return true;
  }
  return false;
}

/** Undoes init. Files edited after init are reported, never overwritten. */
export async function rollback(
  root: string,
  storeDir: string,
  options: { dryRun?: boolean } = {},
): Promise<RollbackResult> {
  const journal = await readJson<Journal>(journalPath(storeDir));
  const result: RollbackResult = { restored: [], removed: [], conflicts: [] };
  if (!journal) return result;
  // Steps left as they are stay in the journal: a later rollback finishes only those.
  const remaining: JournalEntry[] = [];
  for (const e of [...journal.entries].reverse()) {
    if (typeof e.path !== "string" || !(await journalTargetAllowed(root, e.path))) {
      result.conflicts.push(`${String(e.path)} (not a file SmartTest set up — left untouched)`);
      remaining.unshift(e);
      continue;
    }
    const abs = join(root, e.path);
    const current = await readText(abs);
    if (current === undefined) {
      if (e.action === "modify") {
        result.conflicts.push(`${e.path} (deleted since init)`);
        remaining.unshift(e);
      }
      continue;
    }
    if (sha256(current) !== e.afterHash) {
      result.conflicts.push(`${e.path} (edited since init — left untouched)`);
      remaining.unshift(e);
      continue;
    }
    if (e.action === "create") {
      if (!options.dryRun) await rm(abs, { force: true });
      result.removed.push(e.path);
    } else {
      if (!options.dryRun) await writeFileAtomic(abs, e.before ?? "");
      result.restored.push(e.path);
    }
  }
  if (!options.dryRun) {
    if (!remaining.length) await rm(journalPath(storeDir), { force: true });
    else await writeJson(journalPath(storeDir), { ...journal, entries: remaining });
  }
  return result;
}

export interface UninstallPlan {
  files: FilePlan[];
  storeDir: string;
  keep: string[];
}

/** Lists what `smarttest uninstall` removes. Generated tests always stay (they belong to the user). */
export async function planUninstall(root: string, storeDir: string): Promise<UninstallPlan> {
  const files: FilePlan[] = [];
  const config = await findConfigFile(root);
  if (config)
    files.push({
      path: config.slice(root.length + 1),
      action: "modify",
      reason: "remove SmartTest configuration",
      risk: "medium",
    });
  const pkgText = await readText(join(root, "package.json"));
  if (pkgText) {
    try {
      const pkg = JSON.parse(pkgText) as { scripts?: Record<string, string> };
      const ours = Object.entries(pkg.scripts ?? {}).filter(([k, v]) => SCRIPTS[k] === v);
      if (ours.length) {
        const scripts = Object.fromEntries(
          Object.entries(pkg.scripts ?? {}).filter(([k, v]) => SCRIPTS[k] !== v),
        );
        files.push({
          path: "package.json",
          action: "modify",
          reason: `remove scripts: ${ours.map(([k]) => k).join(", ")}`,
          before: pkgText,
          after: `${JSON.stringify({ ...pkg, scripts }, null, detectIndent(pkgText))}\n`,
          risk: "medium",
        });
      }
    } catch {
      /* leave package.json alone */
    }
  }
  const gi = await readText(join(root, ".gitignore"));
  if (gi && /^\/?\.smarttest\/?$/m.test(gi)) {
    files.push({
      path: ".gitignore",
      action: "modify",
      reason: "remove .smarttest/ entry",
      before: gi,
      after: gi
        .split("\n")
        .filter((l) => !/^\/?\.smarttest\/?$/.test(l.trim()))
        .join("\n"),
      risk: "low",
    });
  }
  // SmartTest's actions in CaptainHook's hooks, with the steps they replaced restored.
  const captain = await planCaptainHookUninstall(root).catch(() => undefined);
  if (captain) files.push(captain);
  // SmartTest's blocks in the commit and push hooks (between its markers; the rest of each hook
  // stays): left in place, the next commit would run SmartTest and recreate the store.
  for (const hook of await planHookUninstall(root).catch(() => [] as FilePlan[])) {
    const same = files.find((f) => f.path === hook.path);
    if (!same) {
      files.push(hook);
      continue;
    }
    // simple-git-hooks lives in package.json: drop our scripts from the hook-free version too.
    if (same.path === "package.json" && hook.after !== undefined) {
      const pkg = JSON.parse(hook.after) as { scripts?: Record<string, string> };
      if (pkg.scripts)
        pkg.scripts = Object.fromEntries(
          Object.entries(pkg.scripts).filter(([k, v]) => SCRIPTS[k] !== v),
        );
      same.after = `${JSON.stringify(pkg, null, detectIndent(hook.after))}\n`;
      same.reason = `${same.reason}; ${hook.reason}`;
    }
  }
  return { files, storeDir, keep: ["all test files (including generated scaffolds)"] };
}

export async function applyUninstall(root: string, plan: UninstallPlan): Promise<string[]> {
  const done: string[] = [];
  for (const f of plan.files) {
    const abs = join(root, f.path);
    if (f.after === undefined) {
      await rm(abs, { force: true });
    } else {
      const current = await readFile(abs, "utf8").catch(() => undefined);
      if (current !== f.before) continue;
      await writeFileAtomic(abs, f.after);
    }
    done.push(f.path);
  }
  if (await exists(plan.storeDir)) {
    await rm(plan.storeDir, { recursive: true, force: true });
    done.push(`${plan.storeDir} (local state)`);
  }
  return done;
}

export function renderSetupReport(
  plan: SetupPlan,
  applied: string[],
  validation: { ok: boolean; messages: string[] },
): string {
  const lines = [
    "# SmartTest setup report",
    "",
    `**Detected:** ${plan.summary}`,
    "",
    "## Recommendations",
    "",
    "| Setting | Value | Why |",
    "|---|---|---|",
  ];
  for (const r of plan.recommendations) lines.push(`| ${r.key} | ${r.value} | ${r.reason} |`);
  lines.push("", "## Changes", "");
  for (const f of plan.files)
    lines.push(
      `- ${f.action === "skip" ? "○" : applied.includes(f.path) ? "✓" : "–"} \`${f.path}\` — ${f.action}: ${f.reason}`,
    );
  if (plan.warnings.length)
    lines.push("", "## Warnings", "", ...plan.warnings.map((w) => `- ${w}`));
  lines.push(
    "",
    "## Validation",
    "",
    `${validation.ok ? "✓ Ready" : "✕ Needs attention"}`,
    ...validation.messages.map((m) => `- ${m}`),
  );
  lines.push(
    "",
    "## Next steps",
    "",
    "- `npx smarttest run --affected`",
    "- `npx smarttest explain <test>`",
    "- Undo with `npx smarttest init --rollback`",
    "",
  );
  return lines.join("\n");
}
