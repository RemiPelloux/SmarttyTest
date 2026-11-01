#!/usr/bin/env node
/**
 * SmartTest benchmarks (ST-096, PRD §31.3) under documented conditions.
 *
 *   pnpm build && node benchmarks/run.mjs [--sizes small,medium,large] [--out benchmarks/RESULTS.md]
 *
 * Generates synthetic layered TypeScript repositories (seeded, reproducible), commits them to Git and
 * measures SmartTest's own overhead. Test execution time is excluded: runners are not SmartTest.
 */
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { cpus, platform, release, tmpdir, totalmem } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i > -1 ? args[i + 1] : fallback;
};
const SIZES = { small: 50, medium: 500, large: 2000, xlarge: 10000 };
const sizes = opt("sizes", "small,medium,large,xlarge").split(",");
const outFile = join(root, opt("out", "benchmarks/RESULTS.md"));

const { SmartTest } = await import(pathToFileURL(join(root, "packages/core/dist/index.js")).href);
const { toHtml, summarize, TOOL } = await import(
  pathToFileURL(join(root, "packages/report-engine/dist/index.js")).href
);
const bin = join(root, "packages/cli/.publish/dist/bin.js");

/** Deterministic PRNG (mulberry32). */
function rng(seed) {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

async function generate(n) {
  const dir = await mkdtemp(join(tmpdir(), `st-bench-${n}-`));
  const rand = rng(42 + n);
  const perLayer = 10;
  await writeFile(
    join(dir, "package.json"),
    JSON.stringify(
      { name: `bench-${n}`, private: true, type: "module", devDependencies: { vitest: "^5.0.5" } },
      null,
      2,
    ),
  );
  await writeFile(
    join(dir, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: { module: "ESNext", moduleResolution: "Bundler", strict: true },
    }),
  );
  await writeFile(
    join(dir, "vitest.config.ts"),
    'import { defineConfig } from "vitest/config";\nexport default defineConfig({});\n',
  );
  await mkdir(join(dir, "src"), { recursive: true });
  await mkdir(join(dir, "tests"), { recursive: true });
  for (let i = 0; i < n; i++) {
    const layer = Math.floor(i / perLayer);
    const deps = new Set();
    if (layer > 0) {
      for (let k = 0; k < 2; k++) deps.add((layer - 1) * perLayer + Math.floor(rand() * perLayer));
    }
    const imports = [...deps].map((d) => `import { Service${d} } from "./m${d}";`).join("\n");
    const uses = [...deps].map((d) => `new Service${d}().run(x)`).join(" + ") || "x";
    await writeFile(
      join(dir, "src", `m${i}.ts`),
      `${imports}\n\nexport class Service${i} {\n  run(x: number): number {\n    return ${uses} + ${i};\n  }\n  name(): string {\n    return "s${i}";\n  }\n  private secret(): number {\n    return ${i};\n  }\n}\n\nexport function helper${i}(v: number): number {\n  return v * ${i % 7};\n}\n`,
    );
    await writeFile(
      join(dir, "tests", `m${i}.test.ts`),
      `import { expect, it } from "vitest";\nimport { Service${i} } from "../src/m${i}";\n\nit("runs", () => {\n  expect(new Service${i}().name()).toBe("s${i}");\n  expect(typeof new Service${i}().run(1)).toBe("number");\n});\n`,
    );
  }
  const git = (...a) =>
    execFileSync("git", ["-c", "user.name=bench", "-c", "user.email=b@b", ...a], {
      cwd: dir,
      stdio: "ignore",
    });
  git("init", "-q", "-b", "main");
  git("add", "-A");
  git("commit", "-qm", "bench");
  return dir;
}

if (opt("generate")) {
  // Profiling helper: generate one repository, print its path and keep it.
  console.log(await generate(SIZES[opt("generate")]));
  process.exit(0);
}

const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
async function time(fn, runs = 1) {
  const out = [];
  for (let i = 0; i < runs; i++) {
    const t = performance.now();
    await fn();
    out.push(performance.now() - t);
  }
  return median(out);
}

const results = {};
for (const size of sizes) {
  const n = SIZES[size];
  process.stdout.write(`▸ ${size} (${n} modules, ${n} tests)… `);
  const dir = await generate(n);
  const r = {};
  r.startup = await time(
    () => execFileSync(process.execPath, [bin, "--version"], { stdio: "ignore" }),
    7,
  );
  // Change a module in the middle layer (realistic fan-out): the body of Service<target>.run, which
  // every module (and test) downstream depends on. Each call makes a new edit since the last run.
  const target = Math.floor(n / 2);
  const file = join(dir, "src", `m${target}.ts`);
  const original = await readFile(file, "utf8");
  let edits = 0;
  const editBody = () =>
    writeFile(file, original.replace(` + ${target};`, ` + ${target} + ${++edits} * 0;`));
  const store = join(dir, ".smarttest");
  const cli = () => execFileSync(process.execPath, [bin, "impact"], { cwd: dir, stdio: "ignore" });
  // End to end, as a user runs it: process start, configuration, change detection, index, graph,
  // impact, output. Cold: no index and no graph on disk. Warm: an edit since the previous run.
  await editBody();
  r.cliCold = await time(async () => {
    await rm(store, { recursive: true, force: true });
    cli();
  }, 3);
  const cliWarm = [];
  for (let i = 0; i < 5; i++) {
    await editBody();
    const t = performance.now();
    cli();
    cliWarm.push(performance.now() - t);
  }
  r.cliWarm = median(cliWarm);
  // In-process phases.
  await rm(store, { recursive: true, force: true });
  const st = await SmartTest.open({ root: dir });
  r.coldIndex = await time(() => st.loadIndex());
  r.warmIndex = await time(() => st.loadIndex(), 3);
  const warmAnalyses = [];
  const graphModes = new Set();
  let last;
  for (let i = 0; i < 4; i++) {
    await editBody();
    const t = performance.now();
    const s = await SmartTest.open({ root: dir });
    last = await s.analyze();
    // The first analysis builds and stores the graph; the measured ones patch the stored graph.
    if (i === 0) continue;
    warmAnalyses.push(performance.now() - t);
    graphModes.add(s.lastGraphBuild);
  }
  r.graphModes = [...graphModes].join(", ");
  r.warmDiff = median(warmAnalyses);
  r.selection = last.timings["graph build"] + last.timings["impact analysis"];
  r.selected = last.decision.selectedTests.length;
  r.total = last.testFiles.length;
  // Graph build from the analyses (no stored graph).
  await rm(join(store, "state", "graph.json"), { force: true });
  r.graphBuild = (await (await SmartTest.open({ root: dir })).analyze()).timings["graph build"];
  // Watch mode: index and graph stay in memory; a body change patches the graph.
  {
    const warm = await SmartTest.open({ root: dir });
    warm.keepWarm = true;
    await warm.analyze();
    const patches = [];
    for (let i = 1; i <= 3; i++) {
      await editBody();
      const a = await warm.analyze();
      if (warm.lastGraphBuild === "patched") patches.push(a.timings["graph build"]);
    }
    r.graphPatch = patches.length ? median(patches) : undefined;
  }
  // Report generation for a run of this size.
  const executions = last.testFiles.map((f) => ({
    file: f,
    adapter: "vitest",
    status: "passed",
    durationMs: 3,
    tests: [{ testId: `${f}::runs`, status: "passed", durationMs: 3, attempts: 1 }],
  }));
  const decision = {
    ...last.decision,
    selectedTests: last.testFiles.map((t) => ({
      testId: t,
      filePath: t,
      reasons: [{ kind: "fallback", message: "bench" }],
    })),
    skippedTests: [],
  };
  const report = {
    schemaVersion: 1,
    tool: TOOL,
    runId: "bench",
    command: "bench",
    startedAt: "",
    finishedAt: "",
    project: "bench",
    mode: "balanced",
    change: { description: "bench", changeSet: last.input.changeSet },
    decision,
    executions,
    summary: summarize(decision, executions, 1),
    timings: {},
    warnings: [],
  };
  r.report = await time(() => {
    toHtml(report);
  }, 3);
  r.rssMb = Math.round(process.memoryUsage().rss / 1024 / 1024);
  results[size] = r;
  if (!process.env.BENCH_KEEP) await rm(dir, { recursive: true, force: true });
  else console.log(`kept ${dir}`);
  console.log("done");
}

const fmt = (ms) =>
  ms === undefined ? "—" : ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(2)} s`;
const TARGETS = [
  ["Warm CLI startup (`--version`)", "startup", 300],
  ["Warm analysis, end to end (CLI `impact` after an edit)", "cliWarm", 1000],
  ["Cold start, end to end (CLI `impact`, no index or graph)", "cliCold", 1000],
  ["Simple diff analysis, warm index (in-process `analyze` after an edit)", "warmDiff", 500],
  ["Warm graph selection (graph build + impact)", "selection", 200],
  ["Standard report generation (HTML)", "report", 2000],
  ["Graph update after a body change (watch: patched)", "graphPatch", 10],
];
const cols = sizes.map((s) => `${s} (${SIZES[s]})`);
const lines = [
  "# Benchmark results",
  "",
  "<!-- GENERATED by benchmarks/run.mjs — re-run to update. -->",
  "",
  `Conditions: ${platform()} ${release()} · ${cpus()[0]?.model ?? "unknown CPU"} × ${cpus().length} · ${Math.round(totalmem() / 1024 ** 3)} GB RAM · Node ${process.versions.node} · smarttest ${TOOL.version}.`,
  "Synthetic layered TypeScript repositories (10 modules per layer, 2 imports per module, one test per module, seeded). Test execution time is excluded. Warm runs follow a new edit to the changed module, so the stored graph is patched, not merely reloaded. End-to-end times include process start and output; targets for those rows are the 1.0.0 performance story (warm < 1 s at 10,000 modules, cold < 1 s at 2,000).",
  "",
  `| Operation | Target | ${cols.join(" | ")} |`,
  `|---|---|${cols.map(() => "---").join("|")}|`,
];
for (const [label, key, target] of TARGETS) {
  lines.push(
    `| ${label} | < ${fmt(target)} | ${sizes.map((s) => `${fmt(results[s][key])} ${results[s][key] <= target ? "met" : "missed"}`).join(" | ")} |`,
  );
}
lines.push(
  `| Graph build from the analyses (no stored graph) | — | ${sizes.map((s) => fmt(results[s].graphBuild)).join(" | ")} |`,
);
lines.push(
  `| Stored graph in warm analyses | — | ${sizes.map((s) => results[s].graphModes).join(" | ")} |`,
);
lines.push(
  `| Cold index (first run, parse everything) | — | ${sizes.map((s) => fmt(results[s].coldIndex)).join(" | ")} |`,
);
lines.push(
  `| Warm index (nothing changed) | — | ${sizes.map((s) => fmt(results[s].warmIndex)).join(" | ")} |`,
);
lines.push(
  `| Tests selected for a mid-graph change | — | ${sizes.map((s) => `${results[s].selected} / ${results[s].total} (${Math.round((results[s].selected / results[s].total) * 100)}%)`).join(" | ")} |`,
);
lines.push(
  `| Process RSS after run | — | ${sizes.map((s) => `${results[s].rssMb} MB`).join(" | ")} |`,
);
lines.push(
  "",
  "Targets are aspirational engineering targets from PRD §31.3 and the 1.0.0 performance story, not guarantees. The cold-start target is stated for 2,000 modules; it is shown for every size. Misses are reported, not hidden.",
  "",
);
await writeFile(outFile, lines.join("\n"));
console.log(`\n${lines.slice(7).join("\n")}\n\n✔ wrote ${outFile.slice(root.length + 1)}`);
