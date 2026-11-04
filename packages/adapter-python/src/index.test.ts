import { describe, expect, it } from "vitest";
import { parsePytestJunit, pythonInterpreter } from "./index.js";

describe("parsePytestJunit", () => {
  it("reads passes, failures, skips, classes and collection errors", () => {
    const xml = `<?xml version="1.0"?><testsuites><testsuite>
<testcase classname="tests.test_a" name="test_ok" file="tests/test_a.py" time="0.002"/>
<testcase classname="tests.test_a.TestCart" name="test_total[1]" file="tests/test_a.py" time="0.1"><failure message="assert 1 == 2">E assert 1 == 2 &amp; more</failure></testcase>
<testcase classname="tests.test_a" name="test_skip" file="tests/test_a.py"><skipped message="later"/></testcase>
<testcase classname="tests.test_broken" name="tests.test_broken" time="0"><error message="collection failure">SyntaxError</error></testcase>
</testsuite></testsuites>`;
    const out = parsePytestJunit(xml, (f) => f);
    expect(out.map((e) => [e.testId, e.status])).toEqual([
      ["tests/test_a.py::test_ok", "passed"],
      ["tests/test_a.py::TestCart::test_total[1]", "failed"],
      ["tests/test_a.py::test_skip", "skipped"],
      ["tests/test_broken.py::tests.test_broken", "failed"],
    ]);
    expect(out[1]?.error?.message).toContain("assert 1 == 2\nE assert 1 == 2 & more");
    expect(out[1]?.durationMs).toBe(100);
  });
});

describe("pythonInterpreter", () => {
  it("looks a bare command up on PATH and resolves a relative path in the project (CI: SMARTTEST_PYTHON=python)", () => {
    const saved = process.env.SMARTTEST_PYTHON;
    try {
      process.env.SMARTTEST_PYTHON = "python";
      expect(pythonInterpreter("/repo")).toBe("python");
      process.env.SMARTTEST_PYTHON = ".venv/bin/python";
      expect(pythonInterpreter("/repo").replaceAll("\\", "/")).toMatch(
        /\/repo\/\.venv\/bin\/python$/,
      );
    } finally {
      if (saved === undefined) delete process.env.SMARTTEST_PYTHON;
      else process.env.SMARTTEST_PYTHON = saved;
    }
  });
});
