import { describe, expect, it } from "vitest";
import { parseNodeJUnit } from "./index.js";

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
