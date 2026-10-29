/**
 * @smarttest/adapter-node — runs tests through Node's built-in runner (`node --test`).
 * Results come from the JUnit reporter, which records the file of every test case.
 */
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import {
  type ExecutionOptions,
  relPosix,
  runProcess,
  type TestAdapter,
  type TestAdapterCapabilities,
  type TestCase,
  type TestExecution,
  type TestRunResult,
  type TestSelection,
  type TestStatus,
  toPosix,
  walkFiles,
} from "@smarttest/shared";
import { expandNodePatterns } from "@smarttest/test-discovery";

export interface NodeTestAdapterOptions {
  projectRoot: string;
  cwd: string;
  /** Patterns from `node --test <patterns>`; defaults to Node's own defaults. */
  patterns?: string[];
}

const decode = (s: string) =>
  s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");

function attrs(tag: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of tag.matchAll(/([\w:-]+)="([^"]*)"/g))
    out[m[1] as string] = decode(m[2] as string);
  return out;
}

/** Parses Node's JUnit reporter output (nested <testsuite>, <testcase file="…">). */
export function parseNodeJUnit(xml: string, projectRoot: string): TestExecution[] {
  const out: TestExecution[] = [];
  const suites: string[] = [];
  const re = /<(\/?)(testsuite|testcase)\b([^>]*?)(\/?)>|<(failure|skipped|error)\b([^>]*?)(\/?)>/g;
  let current: { exec: TestExecution; file: string } | undefined;
  let m: RegExpExecArray | null;
  // biome-ignore lint/suspicious/noAssignInExpressions: classic regex scanning loop
  while ((m = re.exec(xml))) {
    const [, closing, tag, rawAttrs, selfClosing, child, childAttrs] = m;
    if (tag === "testsuite") {
      if (closing) suites.pop();
      else if (!selfClosing) suites.push(attrs(rawAttrs ?? "").name ?? "");
      continue;
    }
    if (tag === "testcase") {
      if (closing) {
        current = undefined;
        continue;
      }
      const a = attrs(rawAttrs ?? "");
      const file = a.file ? toPosix(relative(projectRoot, a.file)) : "(unknown)";
      const name = [...suites, a.name ?? ""].filter(Boolean).join(" ");
      const exec: TestExecution = {
        testId: `${file}::${name}`,
        status: "passed",
        durationMs: Math.round(Number(a.time ?? 0) * 1000),
        attempts: 1,
      };
      out.push(exec);
      current = selfClosing ? undefined : { exec, file };
      continue;
    }
    if (child && current) {
      const a = attrs(childAttrs ?? "");
      if (child === "skipped")
        current.exec.status = (a.type === "todo" ? "pending" : "skipped") as TestStatus;
      else {
        current.exec.status = "failed";
        const end = xml.indexOf(`</${child}>`, re.lastIndex);
        const body = end > -1 ? xml.slice(re.lastIndex, end) : "";
        current.exec.error = {
          message: decode(`${a.message ?? ""}\n${body}`)
            .trim()
            .slice(0, 4000),
        };
      }
    }
  }
  return out;
}

export class NodeTestAdapter implements TestAdapter {
  readonly id = "node";
  constructor(private readonly options: NodeTestAdapterOptions) {}

  getCapabilities(): TestAdapterCapabilities {
    return {
      discovery: true,
      fileSelection: true,
      testCaseSelection: false,
      coverage: false,
      tracing: false,
      parallel: true,
      cancellation: true,
      retry: false,
      sourceMaps: false,
    };
  }

  async discover(): Promise<TestCase[]> {
    const patterns = expandNodePatterns(this.options.patterns);
    const files = await walkFiles(this.options.cwd, { include: patterns });
    return files.map((f) => {
      const rel = relPosix(this.options.projectRoot, join(this.options.cwd, f)) ?? f;
      return { id: rel, filePath: rel, suitePath: [], name: rel, tags: [] };
    });
  }

  async execute(selection: TestSelection, options: ExecutionOptions): Promise<TestRunResult> {
    const startedAt = new Date().toISOString();
    const tmp = await mkdtemp(join(tmpdir(), "smarttest-node-"));
    const out = join(tmp, "junit.xml");
    try {
      const args = [
        "--test",
        "--test-reporter=junit",
        `--test-reporter-destination=${out}`,
        ...(options.workers ? [`--test-concurrency=${options.workers}`] : []),
        ...selection.files.map((f) => join(this.options.projectRoot, f)),
      ];
      const res = await runProcess(process.execPath, args, {
        cwd: this.options.cwd,
        env: { ...process.env, FORCE_COLOR: "0", NO_COLOR: "1" },
        ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
        ...(options.signal ? { signal: options.signal } : {}),
      });
      const xml = await readFile(out, "utf8").catch(() => "");
      const executions = xml ? parseNodeJUnit(xml, this.options.projectRoot) : [];
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
        stderr: executions.length ? "" : (res.stderr || res.stdout).slice(-4000),
      };
      return result;
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  }
}
