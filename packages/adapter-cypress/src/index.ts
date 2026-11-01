/**
 * @smarttest/adapter-cypress — runs end-to-end specs through `cypress run --spec`, reading one
 * JUnit file per spec (Cypress's built-in mocha JUnit reporter). Cypress has no list command, so
 * discovery applies the config's `specPattern` (or the default `cypress/e2e/**\/*.cy.*`).
 */
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { resolvePackageBin } from "@smarttest/plugin-sdk";
import {
  type ExecutionOptions,
  matchGlob,
  readText,
  runProcess,
  SmartTestError,
  type TestAdapter,
  type TestAdapterCapabilities,
  type TestCase,
  type TestExecution,
  type TestRunResult,
  type TestSelection,
} from "@smarttest/shared";

export interface CypressAdapterOptions {
  projectRoot: string;
  cwd: string;
  configFile?: string;
  /** Project files (relative to projectRoot) used for static spec discovery. */
  files?: () => Promise<readonly string[]>;
}

export const CYPRESS_DEFAULT_SPEC = "cypress/e2e/**/*.cy.{js,jsx,ts,tsx,mjs,cjs}";

/** `specPattern` from a Cypress config when it is a plain string or string array, else undefined. */
export function cypressSpecPatterns(configText: string | undefined): string[] | undefined {
  if (!configText) return undefined;
  const e2e = configText.indexOf("e2e");
  const scope = e2e > -1 ? configText.slice(e2e) : configText;
  const m = /specPattern\s*:\s*(\[[^\]]*\]|["'`][^"'`]+["'`])/.exec(scope);
  if (!m) return undefined;
  return [...(m[1] as string).matchAll(/["'`]([^"'`]+)["'`]/g)].map((x) => x[1] as string);
}

const decode = (s: string) =>
  s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");

/** Element text: CDATA sections verbatim, everything else entity-decoded. */
const text = (s: string) =>
  s
    .split(/(<!\[CDATA\[[\s\S]*?\]\]>)/)
    .map((part) => (part.startsWith("<![CDATA[") ? part.slice(9, -3) : decode(part)))
    .join("");

/**
 * The full title of a mocha JUnit test case. Cypress's reporter writes the full title
 * ("cart adds") as `name` and the test's own title ("adds") as `classname`; with
 * `testCaseSwitchClassnameAndName` it is the other way round. Either way, the full title is the
 * attribute that ends with the other one.
 */
function fullTitle(name = "", classname = ""): string {
  if (!classname || name.endsWith(classname)) return name || classname;
  if (!name || classname.endsWith(name)) return classname;
  return `${classname} ${name}`;
}

/** Parses one mocha JUnit file written for a Cypress spec. */
export function parseCypressJUnit(xml: string, specFile: string): TestExecution[] {
  const out: TestExecution[] = [];
  const cases = xml.matchAll(/<testcase\b([^>]*?)(\/>|>([\s\S]*?)<\/testcase>)/g);
  for (const c of cases) {
    const a = Object.fromEntries(
      [...(c[1] ?? "").matchAll(/([\w:-]+)="([^"]*)"/g)].map((m) => [m[1], decode(m[2] as string)]),
    );
    const body = c[3] ?? "";
    const failure = /<(failure|error)\b([^>]*)>([\s\S]*?)<\/\1>|<(failure|error)\b([^>]*)\/>/.exec(
      body,
    );
    const skipped = /<skipped\b/.test(body);
    const message = decode(/message="([^"]*)"/.exec(failure?.[2] ?? failure?.[5] ?? "")?.[1] ?? "");
    const detail = text(failure?.[3] ?? "").trim();
    out.push({
      testId: `${specFile}::${fullTitle(a.name, a.classname)}`,
      status: failure ? "failed" : skipped ? "skipped" : "passed",
      durationMs: Math.round(Number(a.time ?? 0) * 1000),
      attempts: 1,
      ...(failure
        ? {
            error: {
              message: (detail.includes(message) ? detail : `${message}\n${detail}`)
                .trim()
                .slice(0, 4000),
            },
          }
        : {}),
    });
  }
  return out;
}

/**
 * Specs that Cypress ran and counted as failing but for which it wrote no JUnit file: a spec
 * that fails to load (syntax error, missing import) never reaches the reporter. Reads the
 * per-spec "Running: <spec>" sections of `cypress run`'s console output.
 */
export function cypressUnreportedFailures(
  output: string,
  specs: readonly string[],
): { spec: string; message: string }[] {
  const out: { spec: string; message: string }[] = [];
  const sections = output.split(/^\s*Running:\s+/m).slice(1);
  for (const section of sections) {
    const shown = /^(\S+)/.exec(section)?.[1];
    if (!shown) continue;
    const matches = specs.filter((s) => s === shown || s.endsWith(`/${shown}`));
    const failing = Number(/Failing:\s+(\d+)/.exec(section)?.[1] ?? 0);
    if (matches.length !== 1 || !failing) continue;
    const body = section.split(/\(Results\)/)[0] ?? "";
    out.push({
      spec: matches[0] as string,
      message: body.split("\n").slice(1).join("\n").trim().slice(0, 4000),
    });
  }
  return out;
}

export class CypressAdapter implements TestAdapter {
  readonly apiVersion = 1;
  readonly id = "cypress";
  constructor(private readonly options: CypressAdapterOptions) {}

  getCapabilities(): TestAdapterCapabilities {
    return {
      discovery: "partial",
      fileSelection: true,
      testCaseSelection: false,
      coverage: false,
      tracing: false,
      parallel: false,
      cancellation: true,
      retry: false,
      sourceMaps: false,
    };
  }

  private bin(): string {
    const bin = resolvePackageBin(this.options.cwd, "cypress", "cypress");
    if (!bin)
      throw new SmartTestError(`Cypress is not installed in ${this.options.cwd}`, {
        code: "ST_RUNNER_MISSING",
        category: "infrastructure",
        hint: "Install it (`npm i -D cypress`) or set `adapters` in smarttest.config.",
      });
    return bin;
  }

  async discover(): Promise<TestCase[]> {
    const cfg = this.options.configFile
      ? await readText(join(this.options.projectRoot, this.options.configFile))
      : undefined;
    const patterns = cypressSpecPatterns(cfg) ?? [CYPRESS_DEFAULT_SPEC];
    const dir = relative(this.options.projectRoot, this.options.cwd).split("\\").join("/");
    const files = (await this.options.files?.()) ?? [];
    return files
      .filter((f) => (dir ? f.startsWith(`${dir}/`) : true))
      .filter((f) => patterns.some((p) => matchGlob(dir ? f.slice(dir.length + 1) : f, p)))
      .map((f) => ({ id: f, filePath: f, suitePath: [], name: f, tags: ["e2e"] }));
  }

  /** Arguments for `cypress run` (exported for tests). */
  runArgs(files: readonly string[], junitDir: string): string[] {
    const specs = files.map((f) =>
      relative(this.options.cwd, join(this.options.projectRoot, f)).split("\\").join("/"),
    );
    return [
      "run",
      "--spec",
      specs.join(","),
      "--reporter",
      "junit",
      "--reporter-options",
      // includePending: without it, skipped (`it.skip`) tests are left out of the file entirely.
      `mochaFile=${join(junitDir, "[hash].xml")},toConsole=false,includePending=true`,
      ...(this.options.configFile
        ? ["--config-file", join(this.options.projectRoot, this.options.configFile)]
        : []),
    ];
  }

  /**
   * The selected spec a JUnit file belongs to (exported for tests). Results are credited to a
   * spec only on evidence: the `file` attribute naming exactly one selected spec, or a run of a
   * single spec. Otherwise they stay unattributed, so a spec that crashed before writing its own
   * file can never inherit another spec's passes.
   */
  specOfJUnit(xml: string, selected: readonly string[]): string {
    const raw = /<testsuite\b[^>]*\bfile="([^"]+)"/.exec(xml)?.[1];
    if (!raw) return selected.length === 1 ? (selected[0] as string) : "(unattributed)";
    const attr = raw.split("\\").join("/");
    const fromCwd = (s: string) =>
      relative(this.options.cwd, join(this.options.projectRoot, s)).split("\\").join("/");
    const exact = selected.filter((s) => attr === s || attr === fromCwd(s));
    if (exact.length === 1) return exact[0] as string;
    // An absolute path, or one relative to another directory: match on a path boundary.
    const suffix = selected.filter(
      (s) => attr.endsWith(`/${fromCwd(s)}`) || attr.endsWith(`/${s}`),
    );
    return suffix.length === 1 ? (suffix[0] as string) : attr;
  }

  async execute(selection: TestSelection, options: ExecutionOptions): Promise<TestRunResult> {
    const startedAt = new Date().toISOString();
    const tmp = await mkdtemp(join(tmpdir(), "smarttest-cypress-"));
    try {
      const res = await runProcess(
        process.execPath,
        [this.bin(), ...this.runArgs(selection.files, tmp)],
        {
          cwd: this.options.cwd,
          env: { ...process.env, FORCE_COLOR: "0", NO_COLOR: "1", ...options.env },
          ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
          ...(options.signal ? { signal: options.signal } : {}),
        },
      );
      const executions: TestExecution[] = [];
      for (const f of await readdir(tmp).catch(() => [] as string[])) {
        const xml = await readFile(join(tmp, f), "utf8");
        executions.push(...parseCypressJUnit(xml, this.specOfJUnit(xml, selection.files)));
      }
      if (res.code !== 0) {
        const reported = new Set(executions.map((e) => e.testId.split("::")[0]));
        for (const { spec, message } of cypressUnreportedFailures(res.stdout, selection.files)) {
          if (reported.has(spec)) continue;
          executions.push({
            testId: `${spec}::(suite)`,
            status: "failed",
            durationMs: 0,
            attempts: 1,
            error: { message: message || "Cypress counted this spec as failing" },
          });
        }
      }
      const result: TestRunResult & { meta?: Record<string, unknown> } = {
        adapter: this.id,
        executions,
        startedAt,
        finishedAt: new Date().toISOString(),
      };
      result.meta = {
        exitCode: res.code,
        timedOut: res.timedOut,
        cancelled: res.cancelled,
        ...(res.code !== 0 && !executions.length
          ? { stderr: (res.stderr || res.stdout).slice(0, 2000) }
          : {}),
        // Cypress exits with the number of failed tests; quoted if it fails with none failed.
        output: (res.stderr || res.stdout).slice(-3000),
      };
      return result;
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  }
}
