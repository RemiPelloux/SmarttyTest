import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { NodeTestAdapter, nodeTestFileArg, parseNodeJUnit } from "./index.js";

describe("file arguments to node --test", () => {
  it("escapes glob characters, which Node 21+ expands in every argument", () => {
    expect(nodeTestFileArg("/p/test/[id].test.js", 22)).toBe("/p/test/[[]id[]].test.js");
    expect(nodeTestFileArg("/p/a*b?.test.js", 26)).toBe("/p/a[*]b[?].test.js");
    expect(nodeTestFileArg("/p/@(x).test.js", 26)).toBe("/p/@[(]x[)].test.js");
    // Brace expansion runs before classes: the comma and `..` that would trigger it become `?`.
    expect(nodeTestFileArg("/p/{x,y}.test.js", 26)).toBe("/p/[{]x?y[}].test.js");
    expect(nodeTestFileArg("/p/{1..2}.test.js", 26)).toBe("/p/[{]1.?2[}].test.js");
    expect(nodeTestFileArg("/p/a,b.test.js", 26)).toBe("/p/a,b.test.js");
    // Before Node 21 arguments are plain paths.
    expect(nodeTestFileArg("/p/test/[id].test.js", 20)).toBe("/p/test/[id].test.js");
  });

  it("runs the selected file, not the files its name matches as a glob", async () => {
    const root = await mkdtemp(join(tmpdir(), "smarttest-node-glob-"));
    try {
      await mkdir(join(root, "test"));
      await writeFile(join(root, "package.json"), '{"type":"module"}');
      for (const [name, body] of [
        ["[id]", "throw new Error('bracket')"],
        ["i", ""],
        ["{x,y}", "throw new Error('brace')"],
        ["x", ""],
      ])
        await writeFile(
          join(root, "test", `${name}.test.js`),
          `import test from "node:test"; test(${JSON.stringify(name)}, () => { ${body} });\n`,
        );
      const adapter = new NodeTestAdapter({ projectRoot: root, cwd: root });
      const run = await adapter.execute({ files: ["test/[id].test.js", "test/{x,y}.test.js"] }, {});
      expect(run.executions.map((e) => [e.testId, e.status]).sort()).toEqual([
        ["test/[id].test.js::[id]", "failed"],
        ["test/{x,y}.test.js::{x,y}", "failed"],
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("the project's node --test script", () => {
  it("runs with the script's preloads, env file, conditions and NODE_OPTIONS", async () => {
    const root = await mkdtemp(join(tmpdir(), "smarttest-node-flags-"));
    try {
      await mkdir(join(root, "test"));
      await writeFile(
        join(root, "package.json"),
        JSON.stringify({
          type: "module",
          scripts: {
            build: "echo build",
            test: "tsc -b && NODE_OPTIONS='--import ./pre.mjs' node --require ./setup.cjs --env-file .env.test --conditions=smarttest --test --test-name-pattern=never --test-reporter spec test/",
          },
        }),
      );
      await writeFile(join(root, "setup.cjs"), "globalThis.SETUP = 'required';\n");
      await writeFile(join(root, "pre.mjs"), "globalThis.PRE = 'imported';\n");
      await writeFile(join(root, ".env.test"), "FROM_ENV_FILE=yes\n");
      await writeFile(
        join(root, "test", "a.test.js"),
        [
          'import test from "node:test";',
          'import assert from "node:assert";',
          'test("needs the preloads", () => {',
          '  assert.equal(globalThis.SETUP, "required");',
          '  assert.equal(globalThis.PRE, "imported");',
          '  assert.equal(process.env.FROM_ENV_FILE, "yes");',
          '  assert.ok(process.execArgv.includes("--conditions=smarttest"));',
          "});",
          "",
        ].join("\n"),
      );
      const adapter = new NodeTestAdapter({ projectRoot: root, cwd: root, patterns: ["test/"] });
      expect(adapter.scriptFlags()).toEqual({
        args: ["--require=./setup.cjs", "--env-file=.env.test", "--conditions=smarttest"],
        env: { NODE_OPTIONS: "--import ./pre.mjs" },
      });
      const run = await adapter.execute({ files: ["test/a.test.js"] }, {});
      expect(run.executions.map((e) => [e.testId, e.status, e.error?.message])).toEqual([
        ["test/a.test.js::needs the preloads", "passed", undefined],
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("--workers replaces the script's --test-concurrency; an explicit command wins", () => {
    const adapter = new NodeTestAdapter({
      projectRoot: "/p",
      cwd: "/p",
      command: {
        nodeArgs: ["--test-concurrency=1", "--experimental-test-module-mocks"],
        env: {},
        patterns: [],
        preloads: [],
        computed: false,
      },
    });
    expect(adapter.scriptFlags().args).toEqual([
      "--test-concurrency=1",
      "--experimental-test-module-mocks",
    ]);
    expect(adapter.scriptFlags(4).args).toEqual(["--experimental-test-module-mocks"]);
    expect(
      new NodeTestAdapter({ projectRoot: "/p", cwd: "/p", command: null }).scriptFlags(),
    ).toEqual({ args: [], env: {} });
  });
});

const xml = `<?xml version="1.0" encoding="utf-8"?>
<testsuites>
	<testsuite name="math" time="0.005" tests="4" failures="1" skipped="2">
		<testcase name="adds" time="0.000486" classname="math" file="/p/test/a.test.mjs"/>
		<testcase name="fails" time="0.0005" classname="math" file="/p/test/a.test.mjs" failure="1 == 2">
			<failure type="testCodeFailure" message="1 == 2">
Error [ERR_TEST_FAILURE]: 1 == 2 &lt;details&gt;
			</failure>
		</testcase>
		<testcase name="later" time="0.0001" classname="math" file="/p/test/a.test.mjs">
			<skipped type="todo" message="true"/>
		</testcase>
		<testcase name="skipped" time="0.00007" classname="math" file="/p/test/a.test.mjs">
			<skipped type="skipped" message="true"/>
		</testcase>
	</testsuite>
	<testcase name="top level" time="0.00008" classname="test" file="/p/test/b.test.mjs"/>
</testsuites>`;

describe("parseNodeJUnit", () => {
  it("maps statuses, nested suites, files and failure messages", () => {
    const r = parseNodeJUnit(xml, "/p");
    expect(r.map((e) => [e.testId, e.status])).toEqual([
      ["test/a.test.mjs::math adds", "passed"],
      ["test/a.test.mjs::math fails", "failed"],
      ["test/a.test.mjs::math later", "pending"],
      ["test/a.test.mjs::math skipped", "skipped"],
      ["test/b.test.mjs::top level", "passed"],
    ]);
    expect(r[1]?.error?.message).toContain("1 == 2 <details>");
  });
});
