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
    const name =
      a.classname && !a.classname.endsWith(a.name ?? "")
        ? `${a.classname} ${a.name}`
        : (a.classname ?? a.name ?? "");
    out.push({
      testId: `${specFile}::${name}`,
      status: failure ? "failed" : skipped ? "skipped" : "passed",
      durationMs: Math.round(Number(a.time ?? 0) * 1000),
      attempts: 1,
      ...(failure
        ? {
            error: {
              message: decode(
                `${/message="([^"]*)"/.exec(failure[2] ?? failure[5] ?? "")?.[1] ?? ""}\n${failure[3] ?? ""}`,
              )
                .trim()
                .slice(0, 4000),
            },
          }
        : {}),
    });
  }
  return out;
}

export class CypressAdapter implements TestAdapter {
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
      `mochaFile=${join(junitDir, "[hash].xml")},toConsole=false`,
      ...(this.options.configFile
        ? ["--config-file", join(this.options.projectRoot, this.options.configFile)]
        : []),
    ];
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
        const specAttr = /<testsuite\b[^>]*\bfile="([^"]+)"/.exec(xml)?.[1];
        const spec = specAttr
          ? (selection.files.find((s) => specAttr.endsWith(s) || s.endsWith(specAttr)) ?? specAttr)
          : (selection.files[0] ?? "(unknown)");
        executions.push(...parseCypressJUnit(xml, spec));
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
      };
      return result;
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  }
}
