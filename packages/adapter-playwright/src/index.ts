/**
 * @smarttest/adapter-playwright — runs end-to-end specs through Playwright Test itself.
 * Discovery uses `playwright test --list`; execution passes the selected spec files as filters
 * and reads the JSON reporter. Traces, screenshots and videos are attached to the results.
 */
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative } from "node:path";
import { resolvePackageBin } from "@smarttest/plugin-sdk";
import {
  type ExecutionOptions,
  relPosix,
  runProcess,
  SmartTestError,
  type TestAdapter,
  type TestAdapterCapabilities,
  type TestCase,
  type TestExecution,
  type TestRunResult,
  type TestSelection,
  type TestStatus,
} from "@smarttest/shared";

export interface PlaywrightAdapterOptions {
  projectRoot: string;
  cwd: string;
  configFile?: string;
}

interface PwResult {
  status?: string;
  duration?: number;
  retry?: number;
  error?: { message?: string; stack?: string };
  errors?: { message?: string }[];
  attachments?: { name?: string; path?: string; contentType?: string }[];
}
interface PwTest {
  projectName?: string;
  status?: string; // expected | unexpected | flaky | skipped
  results?: PwResult[];
}
interface PwSpec {
  title: string;
  file: string;
  tests?: PwTest[];
}
interface PwSuite {
  title?: string;
  file?: string;
  specs?: PwSpec[];
  suites?: PwSuite[];
}
export interface PlaywrightReport {
  config?: { rootDir?: string };
  suites?: PwSuite[];
  errors?: { message?: string }[];
}

/** Flattens a Playwright JSON report into executions keyed `file::suite › title [project]`. */
export function parsePlaywrightReport(
  report: PlaywrightReport,
  projectRoot: string,
  cwd: string,
): TestExecution[] {
  const rootDir = report.config?.rootDir ?? cwd;
  const out: TestExecution[] = [];
  const walk = (suite: PwSuite, path: string[]) => {
    const here = suite.title && suite.title !== suite.file ? [...path, suite.title] : path;
    for (const spec of suite.specs ?? []) {
      const abs = isAbsolute(spec.file) ? spec.file : join(rootDir, spec.file);
      const file = relPosix(projectRoot, abs) ?? relative(projectRoot, abs);
      for (const t of spec.tests ?? []) {
        const results = t.results ?? [];
        const last = results.at(-1);
        const status: TestStatus =
          t.status === "skipped"
            ? "skipped"
            : t.status === "flaky"
              ? "flaky"
              : t.status === "expected"
                ? "passed"
                : last?.status === "timedOut"
                  ? "timed-out"
                  : last?.status === "interrupted"
                    ? "cancelled"
                    : "failed";
        const failure = results.find((r) => r.status !== "passed" && r.status !== "skipped");
        const message =
          failure?.error?.message ?? failure?.errors?.map((e) => e.message).join("\n");
        const artifacts = results.flatMap((r) =>
          (r.attachments ?? [])
            .filter((a) => a.path)
            .map((a) => ({
              name: a.name ?? "attachment",
              path: relPosix(projectRoot, a.path as string) ?? (a.path as string),
            })),
        );
        out.push({
          testId: `${file}::${[...here, spec.title].join(" › ")}${t.projectName ? ` [${t.projectName}]` : ""}`,
          status,
          durationMs: Math.round(results.reduce((a, r) => a + (r.duration ?? 0), 0)),
          attempts: Math.max(1, results.length),
          ...(message && status !== "passed" ? { error: { message: message.slice(0, 4000) } } : {}),
          ...(artifacts.length ? { artifacts } : {}),
        });
      }
    }
    for (const s of suite.suites ?? []) walk(s, here);
  };
  for (const s of report.suites ?? []) walk(s, []);
  return out;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export class PlaywrightAdapter implements TestAdapter {
  readonly id = "playwright";
  constructor(private readonly options: PlaywrightAdapterOptions) {}

  getCapabilities(): TestAdapterCapabilities {
    return {
      discovery: true,
      fileSelection: true,
      testCaseSelection: false,
      coverage: false,
      tracing: true,
      parallel: true,
      cancellation: true,
      retry: true,
      sourceMaps: false,
    };
  }

  private bin(): string {
    const bin =
      resolvePackageBin(this.options.cwd, "@playwright/test", "playwright") ??
      resolvePackageBin(this.options.cwd, "playwright", "playwright");
    if (!bin)
      throw new SmartTestError(`Playwright is not installed in ${this.options.cwd}`, {
        code: "ST_RUNNER_MISSING",
        category: "infrastructure",
        hint: "Install it (`npm i -D @playwright/test`) or set `adapters` in smarttest.config.",
      });
    return bin;
  }

  private configArgs(): string[] {
    return this.options.configFile
      ? ["--config", join(this.options.projectRoot, this.options.configFile)]
      : [];
  }

  private async report(
    args: string[],
    options: { timeoutMs?: number; signal?: AbortSignal; env?: Record<string, string> } = {},
  ) {
    const tmp = await mkdtemp(join(tmpdir(), "smarttest-playwright-"));
    const out = join(tmp, "report.json");
    try {
      const res = await runProcess(
        process.execPath,
        [this.bin(), "test", ...args, "--reporter=json", ...this.configArgs()],
        {
          cwd: this.options.cwd,
          env: {
            ...process.env,
            FORCE_COLOR: "0",
            NO_COLOR: "1",
            PLAYWRIGHT_JSON_OUTPUT_NAME: out,
            ...options.env,
          },
          ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
          ...(options.signal ? { signal: options.signal } : {}),
        },
      );
      let report: PlaywrightReport | undefined;
      try {
        report = JSON.parse(await readFile(out, "utf8")) as PlaywrightReport;
      } catch {
        const start = res.stdout.indexOf("{");
        try {
          report =
            start > -1 ? (JSON.parse(res.stdout.slice(start)) as PlaywrightReport) : undefined;
        } catch {
          report = undefined;
        }
      }
      return { res, report };
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  }

  async discover(): Promise<TestCase[]> {
    const { res, report } = await this.report(["--list"], { timeoutMs: 120_000 });
    if (!report)
      throw new SmartTestError(
        `playwright discovery failed: ${(res.stderr || res.stdout).trim().slice(0, 500)}`,
        {
          code: "ST_DISCOVERY_FAILED",
          category: "infrastructure",
        },
      );
    const files = [
      ...new Set(
        parsePlaywrightReport(report, this.options.projectRoot, this.options.cwd).map(
          (e) => e.testId.split("::")[0] as string,
        ),
      ),
    ];
    return files.map((f) => ({ id: f, filePath: f, suitePath: [], name: f, tags: ["e2e"] }));
  }

  async execute(selection: TestSelection, options: ExecutionOptions): Promise<TestRunResult> {
    const startedAt = new Date().toISOString();
    const filters = selection.files.map((f) =>
      escapeRe(relative(this.options.cwd, join(this.options.projectRoot, f)).split("\\").join("/")),
    );
    const { res, report } = await this.report(
      [
        ...filters,
        ...(options.workers ? [`--workers=${options.workers}`] : []),
        ...(options.retries ? [`--retries=${options.retries}`] : []),
      ],
      {
        ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
        ...(options.signal ? { signal: options.signal } : {}),
        ...(options.env ? { env: options.env } : {}),
      },
    );
    const executions = report
      ? parsePlaywrightReport(report, this.options.projectRoot, this.options.cwd)
      : [];
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
  }
}
