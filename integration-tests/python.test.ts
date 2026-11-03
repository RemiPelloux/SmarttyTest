/**
 * Python preview (S30): pytest and unittest projects are detected, analysed without running
 * Python, and run through their runner. A targeted change selects only the tests that reach it;
 * what cannot be read statically is uncertainty; a broken collection is a failure, never a pass.
 * Skipped when no Python with pytest is installed (CI installs it).
 */
import { spawnSync } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { SmartTest } from "@smarttest/core";
import { describe, expect, it } from "vitest";
import { edit, materialize } from "./helpers.js";

/** A Python that has pytest: SMARTTEST_PYTHON, then the system ones. */
const python = [process.env.SMARTTEST_PYTHON, "/usr/bin/python3", "python3", "python"].find(
  (p) => !!p && spawnSync(p, ["-m", "pytest", "--version"], { stdio: "ignore" }).status === 0,
);
if (python) process.env.SMARTTEST_PYTHON = python;

const selected = (a: { decision: { selectedTests: { filePath: string }[] } }) =>
  a.decision.selectedTests.map((t) => t.filePath).sort();

async function after(fixture: string, changes: [string, string, string][]) {
  const dir = await materialize(fixture, { git: true });
  for (const [file, find, replace] of changes) await edit(dir, file, find, replace);
  const st = await SmartTest.open({ root: dir });
  return { dir, st, analysis: await st.analyze({ mode: "balanced" }) };
}

describe.skipIf(!python)("python-pytest", () => {
  it("is detected as pytest; the full suite gives pytest's results", async () => {
    const dir = await materialize("python-pytest", { git: true });
    const st = await SmartTest.open({ root: dir });
    const roots = await st.runnerRoots();
    expect(roots.map((r) => r.adapter)).toEqual(["pytest"]);
    const run = await st.run({ all: true, formats: [] });
    expect(run.exitCode).toBe(0);
    expect(run.report.summary.passed).toBe(4);
    expect(run.report.executions.map((e) => e.file).sort()).toEqual([
      "tests/test_plugins.py",
      "tests/test_receipt.py",
      "tests/unit/test_cart.py",
      "tests/unit/test_prices.py",
    ]);
  }, 120_000);

  it("a function change selects the tests reaching it, through imports and conftest fixtures", async () => {
    const { analysis } = await after("python-pytest", [
      ["src/shop/prices.py", "cents * (1 + VAT)", "cents * (1.0 + VAT)"],
    ]);
    // with_vat: Cart.total (the conftest fixture's cart) and the receipt; not discount's test.
    expect(selected(analysis)).toEqual([
      "tests/test_plugins.py", // importlib.import_module(name): uncertainty, never ruled out
      "tests/test_receipt.py",
      "tests/unit/test_cart.py",
    ]);
  }, 120_000);

  it("another function of the same module selects only its own tests", async () => {
    const { analysis } = await after("python-pytest", [
      ["src/shop/prices.py", "cents * percent // 100", "cents * percent // 100 + 0"],
    ]);
    expect(selected(analysis)).toEqual(["tests/test_plugins.py", "tests/unit/test_prices.py"]);
  }, 120_000);

  it("a fixture change selects the tests asking for that fixture", async () => {
    const { analysis } = await after("python-pytest", [
      ["tests/conftest.py", "Cart().add(1000)", "Cart().add(1000).add(0)"],
    ]);
    expect(selected(analysis)).toEqual(["tests/test_plugins.py", "tests/unit/test_cart.py"]);
  }, 120_000);

  it("code conftest.py runs at load, or an autouse fixture, selects every test below it", async () => {
    const all = [
      "tests/test_plugins.py",
      "tests/test_receipt.py",
      "tests/unit/test_cart.py",
      "tests/unit/test_prices.py",
    ];
    const load = await after("python-pytest", [
      [
        "tests/conftest.py",
        "@pytest.fixture\ndef cart",
        'LIMIT = int("3")\n\n\n@pytest.fixture\ndef cart',
      ],
    ]);
    expect(selected(load.analysis)).toEqual(all);
    const dir = await materialize("python-pytest", { git: true });
    await edit(
      dir,
      "tests/conftest.py",
      "@pytest.fixture\ndef cart",
      "@pytest.fixture(autouse=True)\ndef no_network():\n    return None\n\n\n@pytest.fixture\ndef cart",
    );
    const { git } = await import("./helpers.js");
    git(dir, "commit", "-qam", "autouse fixture");
    await edit(dir, "tests/conftest.py", "    return None", "    return 0");
    const auto = await (await SmartTest.open({ root: dir })).analyze({ mode: "balanced" });
    expect(selected(auto)).toEqual(all);
  }, 120_000);

  it("a broken change fails the run with the right test", async () => {
    const { st } = await after("python-pytest", [
      ["src/shop/cart.py", "sum(with_vat(c)", "1 + sum(with_vat(c)"],
    ]);
    const run = await st.run({ formats: [] });
    expect(run.exitCode).not.toBe(0);
    const failed = run.report.executions.filter((e) => e.status === "failed").map((e) => e.file);
    expect(failed.sort()).toEqual(["tests/test_receipt.py", "tests/unit/test_cart.py"]);
  }, 120_000);

  it("a test file that does not even import is a failure, never a pass", async () => {
    const { st } = await after("python-pytest", [
      ["tests/unit/test_prices.py", "def test_discount():", "def test_discount(:"],
    ]);
    const run = await st.run({ formats: [] });
    expect(run.exitCode).not.toBe(0);
    expect(run.report.executions.find((e) => e.file === "tests/unit/test_prices.py")?.status).toBe(
      "failed",
    );
  }, 120_000);

  it("can be turned off per project", async () => {
    const dir = await materialize("python-pytest", { git: true });
    await writeFile(join(dir, "smarttest.config.json"), '{ "python": { "enabled": false } }\n');
    const st = await SmartTest.open({ root: dir });
    expect(await st.runnerRoots()).toEqual([]);
    const { index } = await st.loadIndex();
    expect([...index.entries().keys()].filter((f) => f.endsWith(".py"))).toEqual([]);
  }, 120_000);
});

describe.skipIf(!python)("python-unittest", () => {
  it("is detected as unittest and run module by module", async () => {
    const dir = await materialize("python-unittest", { git: true });
    const st = await SmartTest.open({ root: dir });
    expect((await st.runnerRoots()).map((r) => r.adapter)).toEqual(["unittest"]);
    const run = await st.run({ all: true, formats: [] });
    expect(run.exitCode).toBe(0);
    expect(run.report.summary.passed).toBe(3);
  }, 120_000);

  it("a relative import is followed; the other module's tests are not selected", async () => {
    const { analysis } = await after("python-unittest", [
      ["app/text.py", '"-".join(s.lower().split())', '"-".join(s.lower().split(" "))'],
    ]);
    expect(selected(analysis)).toEqual(["tests/test_offer.py"]);
  }, 120_000);

  it("a failing class fixture fails its module only", async () => {
    const { st } = await after("python-unittest", [
      [
        "tests/test_text.py",
        "class TitleTest(unittest.TestCase):",
        'class TitleTest(unittest.TestCase):\n    @classmethod\n    def setUpClass(cls) -> None:\n        raise RuntimeError("fixture")\n',
      ],
    ]);
    const run = await st.run({ all: true, formats: [] });
    expect(run.exitCode).not.toBe(0);
    expect(run.report.executions.map((e) => [e.file, e.status])).toEqual([
      ["tests/test_offer.py", "passed"],
      ["tests/test_text.py", "failed"],
    ]);
  }, 120_000);
});
