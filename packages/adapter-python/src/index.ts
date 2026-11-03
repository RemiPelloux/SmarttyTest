/**
 * @smarttest/adapter-python — pytest and unittest (preview).
 *
 * - pytest: files are listed with `--collect-only -q` and run by path; results come from its
 *   JUnit XML. A collection error, or a selected file in which pytest collects nothing, is a
 *   failure, never a pass.
 * - unittest: there is no listing command and no machine-readable report, so a small driver
 *   loads the selected modules with `unittest`'s own loader and writes one JSON record per test.
 *   A module that fails to import is a failure of that file.
 *
 * The interpreter: `SMARTTEST_PYTHON`, the configured one, the project's `.venv`/`venv`, the
 * active `VIRTUAL_ENV`, then `python3` (`python` on Windows).
 */
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import {
  type ExecutionOptions,
  runProcess,
  SmartTestError,
  type TestAdapter,
  type TestAdapterCapabilities,
  type TestCase,
  type TestExecution,
  type TestRunResult,
  type TestSelection,
  toPosix,
  walkFiles,
} from "@smarttest/shared";

export interface PythonAdapterOptions {
  projectRoot: string;
  /** Directory the runner starts in (the Python project's root). */
  cwd: string;
  /** Interpreter configured in `python.interpreter`. */
  interpreter?: string;
}

/** The Python a project runs its tests with. */
export function pythonInterpreter(cwd: string, configured?: string): string {
  const explicit = process.env.SMARTTEST_PYTHON || configured;
  if (explicit) return isAbsolute(explicit) ? explicit : resolve(cwd, explicit);
  const win = process.platform === "win32";
  for (const env of [".venv", "venv"]) {
    const p = win ? join(cwd, env, "Scripts", "python.exe") : join(cwd, env, "bin", "python");
    if (existsSync(p)) return p;
  }
  if (process.env.VIRTUAL_ENV) {
    const p = win
      ? join(process.env.VIRTUAL_ENV, "Scripts", "python.exe")
      : join(process.env.VIRTUAL_ENV, "bin", "python");
    if (existsSync(p)) return p;
  }
  return win ? "python" : "python3";
}

const CAPABILITIES: TestAdapterCapabilities = {
  discovery: true,
  fileSelection: true,
  testCaseSelection: false,
  coverage: false,
  tracing: false,
  parallel: false,
  cancellation: true,
  retry: false,
  sourceMaps: false,
};

const env = (extra?: Record<string, string>): NodeJS.ProcessEnv => ({
  ...process.env,
  PYTHONDONTWRITEBYTECODE: "1",
  PYTHONUNBUFFERED: "1",
  NO_COLOR: "1",
  ...extra,
});

function missing(python: string, message: string): SmartTestError {
  return new SmartTestError(
    `${python} could not run: ${message.trim().split("\n").slice(-3).join(" ")}`,
    {
      code: "ST_RUNNER_MISSING",
      category: "infrastructure",
      hint: 'Install the project\'s Python dependencies, or point SmartTest at its interpreter: `python: { interpreter: ".venv/bin/python" }` in smarttest.config, or SMARTTEST_PYTHON.',
    },
  );
}

const xmlText = (s: string) =>
  s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCharCode(Number(n)))
    .replace(/&amp;/g, "&");
const attr = (tag: string, name: string) =>
  ((new RegExp(`\\s${name}="([^"]*)"`).exec(tag)?.[1] ?? "") as string).replace(/&quot;/g, '"');

/** Parses pytest's JUnit XML (`-o junit_family=xunit1`, which carries each test's file). */
export function parsePytestJunit(xml: string, rel: (file: string) => string): TestExecution[] {
  const out: TestExecution[] = [];
  for (const m of xml.matchAll(/<testcase\b([^>]*?)(\/>|>([\s\S]*?)<\/testcase>)/g)) {
    const tag = m[1] as string;
    const body = m[3] ?? "";
    const classname = attr(tag, "classname");
    const name = xmlText(attr(tag, "name"));
    let file = attr(tag, "file");
    // A collection error has no file: its classname is the module path (`tests.test_x`).
    if (!file && classname) file = `${classname.replace(/\./g, "/")}.py`;
    if (!file && name.endsWith(".py")) file = name;
    if (!file) continue;
    const f = rel(file);
    const moduleParts = f.replace(/\.py$/, "").split("/");
    const cls = classname.split(".").slice(moduleParts.length).join("::");
    const failure = /<(failure|error)\b([^>]*)>([\s\S]*?)<\/\1>|<(failure|error)\b([^>]*)\/>/.exec(
      body,
    );
    const skipped = /<skipped\b/.test(body);
    const status: TestExecution["status"] = failure ? "failed" : skipped ? "skipped" : "passed";
    const exec: TestExecution = {
      testId: `${f}::${cls ? `${cls}::` : ""}${name || "(collection)"}`,
      status,
      durationMs: Math.round(Number(attr(tag, "time") || 0) * 1000),
      attempts: 1,
    };
    if (failure)
      exec.error = {
        message: xmlText(`${attr(failure[2] ?? failure[5] ?? "", "message")}\n${failure[3] ?? ""}`)
          .trim()
          .slice(0, 4000),
      };
    out.push(exec);
  }
  return out;
}

export class PytestAdapter implements TestAdapter {
  readonly apiVersion = 1;
  readonly id = "pytest";
  constructor(private readonly options: PythonAdapterOptions) {}

  getCapabilities(): TestAdapterCapabilities {
    return CAPABILITIES;
  }

  private python(): string {
    return pythonInterpreter(this.options.cwd, this.options.interpreter);
  }

  private rel(file: string): string {
    const abs = isAbsolute(file) ? file : join(this.options.cwd, file);
    return toPosix(relative(this.options.projectRoot, abs));
  }

  async discover(): Promise<TestCase[]> {
    const python = this.python();
    const res = await runProcess(
      python,
      ["-m", "pytest", "--collect-only", "-q", "-p", "no:cacheprovider"],
      { cwd: this.options.cwd, env: env(), timeoutMs: 120_000 },
    );
    // 0: collected; 5: nothing collected. Anything else: pytest is missing or the collection broke.
    if (res.code !== 0 && res.code !== 5) {
      if (/No module named pytest|not found|ENOENT/i.test(`${res.stderr}${res.stdout}`))
        throw missing(python, res.stderr || res.stdout);
      throw new SmartTestError(
        `pytest --collect-only failed: ${(res.stdout || res.stderr).trim().split("\n").slice(-8).join("\n")}`,
        { code: "ST_DISCOVERY_FAILED", category: "infrastructure" },
      );
    }
    const files = new Set<string>();
    for (const line of res.stdout.split("\n")) {
      const id = line.trim();
      const at = id.indexOf("::");
      if (at > 0 && id.slice(0, at).endsWith(".py")) files.add(this.rel(id.slice(0, at)));
    }
    return [...files].sort().map((f) => ({ id: f, filePath: f, suitePath: [], name: f, tags: [] }));
  }

  async execute(selection: TestSelection, options: ExecutionOptions): Promise<TestRunResult> {
    const startedAt = new Date().toISOString();
    const python = this.python();
    const tmp = await mkdtemp(join(tmpdir(), "smarttest-pytest-"));
    const out = join(tmp, "junit.xml");
    const files = selection.files.map((f) =>
      toPosix(relative(this.options.cwd, join(this.options.projectRoot, f))),
    );
    try {
      const res = await runProcess(
        python,
        [
          "-m",
          "pytest",
          "-q",
          "-p",
          "no:cacheprovider",
          "-o",
          "junit_family=xunit1",
          `--junitxml=${out}`,
          "--",
          ...files,
        ],
        {
          cwd: this.options.cwd,
          env: env(options.env),
          ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
          ...(options.signal ? { signal: options.signal } : {}),
        },
      );
      if (res.code !== 0 && /No module named pytest/.test(res.stderr))
        throw missing(python, res.stderr);
      const xml = await readFile(out, "utf8").catch(() => "");
      const executions = parsePytestJunit(xml, (f) => this.rel(f));
      // A selected file pytest collected nothing from is never a pass.
      const seen = new Set(executions.map((e) => e.testId.slice(0, e.testId.indexOf("::"))));
      for (const f of selection.files)
        if (!seen.has(f))
          executions.push({
            testId: `${f}::(collection)`,
            status: "failed",
            durationMs: 0,
            attempts: 1,
            error: {
              message:
                res.code === 5
                  ? "pytest collected no test from this file"
                  : (res.stdout || res.stderr)
                      .trim()
                      .split("\n")
                      .slice(-20)
                      .join("\n")
                      .slice(0, 4000) || "pytest reported no result for this file",
            },
          });
      const result: TestRunResult & { meta?: Record<string, unknown> } = {
        adapter: this.id,
        executions,
        startedAt,
        finishedAt: new Date().toISOString(),
      };
      result.meta = {
        // pytest exits 1 when a test failed; 2–4 (interrupted, internal, usage) fail the run.
        exitCode: res.code === 1 || res.code === 5 ? 0 : res.code,
        timedOut: res.timedOut,
        cancelled: res.cancelled,
        output: (res.stdout || res.stderr).slice(-3000),
      };
      return result;
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  }
}

/** The unittest driver: loads the given modules and writes one JSON record per test. */
const UNITTEST_DRIVER = String.raw`
import json, sys, time, traceback, unittest
out, names = sys.argv[1], sys.argv[2:]
sys.path.insert(0, ".")
records = []
class Result(unittest.TestResult):
    def startTest(self, test):
        self._t = time.perf_counter(); super().startTest(test)
    def _add(self, test, status, err=None):
        msg = None
        if err is not None:
            msg = "".join(traceback.format_exception(*err))[-4000:] if isinstance(err, tuple) else str(err)
        records.append({"id": test.id(), "status": status, "ms": round((time.perf_counter() - getattr(self, "_t", time.perf_counter())) * 1000), "message": msg})
    def addSuccess(self, test): self._add(test, "passed")
    def addFailure(self, test, err): self._add(test, "failed", err)
    def addError(self, test, err): self._add(test, "failed", err)
    def addSkip(self, test, reason): self._add(test, "skipped", reason)
    def addExpectedFailure(self, test, err): self._add(test, "passed")
    def addUnexpectedSuccess(self, test): self._add(test, "failed", "unexpected success")
    def addSubTest(self, test, sub, err):
        if err is not None: self._add(sub, "failed", err)
loader = unittest.TestLoader()
suite = unittest.TestSuite()
for name in names:
    try:
        suite.addTests(loader.loadTestsFromName(name))
    except Exception:
        records.append({"id": name + ".(import)", "status": "failed", "ms": 0, "message": traceback.format_exc()[-4000:], "module": name})
result = Result()
suite.run(result)
for e in loader.errors:
    records.append({"id": "(loader)", "status": "failed", "ms": 0, "message": e[-4000:]})
json.dump(records, open(out, "w"))
`;

export interface UnittestAdapterOptions extends PythonAdapterOptions {
  /** `discover -s`: where test modules are searched (default "."). */
  start?: string;
  /** `discover -p`: test module pattern (default `test*.py`). */
  pattern?: string;
}

/** `test*.py` → a RegExp on a file name. */
const fnmatch = (glob: string) =>
  new RegExp(
    `^${glob
      .replace(/[.+^${}()|[\]\\]/g, "\\$&")
      .replace(/\*/g, ".*")
      .replace(/\?/g, ".")}$`,
  );

export class UnittestAdapter implements TestAdapter {
  readonly apiVersion = 1;
  readonly id = "unittest";
  constructor(private readonly options: UnittestAdapterOptions) {}

  getCapabilities(): TestAdapterCapabilities {
    return CAPABILITIES;
  }

  /** As `unittest discover` does: matching modules under the start directory, inside packages. */
  async discover(): Promise<TestCase[]> {
    const start = this.options.start ?? ".";
    const base = join(this.options.cwd, start);
    const match = fnmatch(this.options.pattern ?? "test*.py");
    const files = await walkFiles(base, {
      include: ["**/*.py"],
      exclude: ["**/.venv/**", "**/venv/**", "**/site-packages/**"],
    });
    const set = new Set(files);
    const inPackage = (f: string) => {
      const parts = f.split("/").slice(0, -1);
      for (let i = 1; i <= parts.length; i++)
        if (!set.has(`${parts.slice(0, i).join("/")}/__init__.py`)) return false;
      return true;
    };
    return files
      .filter((f) => match.test(f.split("/").pop() ?? "") && inPackage(f))
      .map((f) => toPosix(relative(this.options.projectRoot, join(base, f))))
      .sort()
      .map((f) => ({ id: f, filePath: f, suitePath: [], name: f, tags: [] }));
  }

  async execute(selection: TestSelection, options: ExecutionOptions): Promise<TestRunResult> {
    const startedAt = new Date().toISOString();
    const python = pythonInterpreter(this.options.cwd, this.options.interpreter);
    const tmp = await mkdtemp(join(tmpdir(), "smarttest-unittest-"));
    const out = join(tmp, "results.json");
    const driver = join(tmp, "driver.py");
    await writeFile(driver, UNITTEST_DRIVER);
    const moduleOf = new Map<string, string>();
    for (const f of selection.files) {
      const fromCwd = toPosix(relative(this.options.cwd, join(this.options.projectRoot, f)));
      moduleOf.set(fromCwd.replace(/\.py$/, "").replace(/\//g, "."), f);
    }
    try {
      const res = await runProcess(python, [driver, out, ...moduleOf.keys()], {
        cwd: this.options.cwd,
        env: env(options.env),
        ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
        ...(options.signal ? { signal: options.signal } : {}),
      });
      let records: {
        id: string;
        status: "passed" | "failed" | "skipped";
        ms: number;
        message?: string | null;
        module?: string;
      }[] = [];
      try {
        records = JSON.parse(await readFile(out, "utf8"));
      } catch {
        if (res.code !== 0 && /not found|ENOENT|No such file/i.test(res.stderr))
          throw missing(python, res.stderr);
        records = [];
      }
      // `tests.test_geo.PlacesTest.test_x` → file of the longest module prefix.
      const modules = [...moduleOf.keys()].sort((a, b) => b.length - a.length);
      const executions: TestExecution[] = [];
      const runErrors: string[] = [];
      for (const r of records) {
        // A failing class or module fixture is reported as `setUpClass (tests.test_x.Case)`.
        const holder = /^(\w+) \(([^)]+)\)$/.exec(r.id);
        const id = holder ? `${holder[2]}.${holder[1]}` : r.id;
        const mod = r.module ?? modules.find((m) => id === m || id.startsWith(`${m}.`));
        const file = mod ? moduleOf.get(mod) : undefined;
        if (!file) {
          if (r.status === "failed") runErrors.push(`${r.id}: ${r.message ?? ""}`);
          continue;
        }
        const name = id.slice((mod as string).length + 1) || "(module)";
        executions.push({
          testId: `${file}::${name}`,
          status: r.status,
          durationMs: r.ms,
          attempts: 1,
          ...(r.message && r.status === "failed" ? { error: { message: r.message } } : {}),
        });
      }
      const seen = new Set(executions.map((e) => e.testId.slice(0, e.testId.indexOf("::"))));
      for (const f of selection.files)
        if (!seen.has(f))
          executions.push({
            testId: `${f}::(module)`,
            status: "failed",
            durationMs: 0,
            attempts: 1,
            error: {
              message:
                (res.stderr || res.stdout).trim().split("\n").slice(-20).join("\n") ||
                "unittest ran no test from this module",
            },
          });
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
        ...(runErrors.length ? { runErrors } : {}),
        output: (res.stderr || res.stdout).slice(-3000),
      };
      return result;
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  }
}
