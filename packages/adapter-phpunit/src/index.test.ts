import { describe, expect, it } from "vitest";
import {
  batches,
  failingEvents,
  parseListTestsXml,
  parsePhpUnitJunit,
  phpBinary,
} from "./index.js";

describe("parsePhpUnitJunit", () => {
  it("reads passes, failures, errors, skips and data sets, with each test's file", () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<testsuites>
  <testsuite name="unit" tests="5">
    <testsuite name="Shop\\Tests\\MoneyTest" file="/repo/tests/MoneyTest.php">
      <testcase name="testAdds" file="/repo/tests/MoneyTest.php" line="12" class="Shop\\Tests\\MoneyTest" classname="Shop.Tests.MoneyTest" assertions="1" time="0.002"/>
      <testcase name="testFormats" file="/repo/tests/MoneyTest.php" line="17" class="Shop\\Tests\\MoneyTest" classname="Shop.Tests.MoneyTest" time="0.1">
        <failure type="PHPUnit\\Framework\\ExpectationFailedException">Failed asserting that '1.50 €' is identical to '1.50 EUR' &amp; more.</failure>
      </testcase>
      <testcase name="testBoom" file="/repo/tests/MoneyTest.php" class="Shop\\Tests\\MoneyTest" time="0"><error type="Error">Call to undefined method</error></testcase>
      <testcase name="testLater" file="/repo/tests/MoneyTest.php" class="Shop\\Tests\\MoneyTest" time="0"><skipped/></testcase>
    </testsuite>
    <testsuite name="Shop\\Tests\\HelpersTest::testFormats" file="/repo/tests/HelpersTest.php">
      <testcase name="testFormats with data set &quot;whole&quot;" file="/repo/tests/HelpersTest.php" class="Shop\\Tests\\HelpersTest" time="0.001"/>
    </testsuite>
  </testsuite>
</testsuites>`;
    const out = parsePhpUnitJunit(xml, (f) => f.replace("/repo/", ""));
    expect(out.map((e) => [e.testId, e.status])).toEqual([
      ["tests/MoneyTest.php::MoneyTest::testAdds", "passed"],
      ["tests/MoneyTest.php::MoneyTest::testFormats", "failed"],
      ["tests/MoneyTest.php::MoneyTest::testBoom", "failed"],
      ["tests/MoneyTest.php::MoneyTest::testLater", "skipped"],
      ['tests/HelpersTest.php::HelpersTest::testFormats with data set "whole"', "passed"],
    ]);
    expect(out[1]?.error?.message).toContain("is identical to '1.50 EUR' & more.");
    expect(out[1]?.durationMs).toBe(100);
    expect(out[4]?.method).toBe("testFormats");
  });

  it("takes the file of the enclosing suite when a test case has none (Pest)", () => {
    const xml = `<testsuites><testsuite name="Tests\\Feature\\HomeTest" file="/repo/tests/Feature/HomeTest.php"><testcase name="it shows the home page" class="Tests\\Feature\\HomeTest" time="0.01"/></testsuite></testsuites>`;
    expect(parsePhpUnitJunit(xml, (f) => f.replace("/repo/", ""))[0]?.testId).toBe(
      "tests/Feature/HomeTest.php::HomeTest::it shows the home page",
    );
  });
});

describe("parseListTestsXml", () => {
  it("reads the files of the listed test classes (PHPUnit 11) and phpt files", () => {
    const xml = `<?xml version="1.0"?>
<testSuite xmlns="https://xml.phpunit.de/testSuite"><tests>
  <testClass name="Shop\\Tests\\CartTest" file="/repo/tests/CartTest.php"><testMethod id="Shop\\Tests\\CartTest::testA" name="testA"/></testClass>
  <phpt file="/repo/tests/cli.phpt"/>
</tests><groups/></testSuite>`;
    expect(parseListTestsXml(xml)).toEqual({
      files: ["/repo/tests/CartTest.php", "/repo/tests/cli.phpt"],
      classes: [],
    });
  });

  it("returns the class names when the files are missing (PHPUnit 10)", () => {
    expect(
      parseListTestsXml(`<tests><testCaseClass name="Tests\\FooTest"></testCaseClass></tests>`),
    ).toEqual({ files: [], classes: ["Tests\\FooTest"] });
  });
});

describe("failingEvents", () => {
  const events = `[00:00:00.001 / 00:00:00.000] [4 MB] Test Considered Risky (Shop\\Tests\\CartTest::testA)
                                              This test did not perform any assertions
[00:00:00.002 / 00:00:00.000] [4 MB] Test Triggered PHP Warning (Shop\\Tests\\CartTest::testB#0)
                                              Undefined variable $x
[00:00:00.003 / 00:00:00.000] [4 MB] Test Triggered Deprecation (Shop\\Tests\\CartTest::testC)`;

  it("names the risky tests and warnings the configuration fails on", () => {
    const out = failingEvents(events, '<phpunit failOnRisky="true" failOnWarning="true">');
    expect(out.map((e) => e.test)).toEqual([
      "Shop\\Tests\\CartTest::testA",
      "Shop\\Tests\\CartTest::testB#0",
    ]);
    expect(out[0]?.reason).toContain("risky — This test did not perform any assertions");
  });

  it("names nothing the configuration does not fail on", () => {
    expect(failingEvents(events, "<phpunit>")).toEqual([]);
  });
});

describe("batches", () => {
  it("keeps each command line under the limit, every file once, in order", () => {
    const files = Array.from({ length: 10 }, (_, i) => `tests/File${i}Test.php`);
    const out = batches(files, 60);
    expect(out.flat()).toEqual(files);
    for (const b of out) expect(b.join(" ").length).toBeLessThanOrEqual(60);
  });
});

describe("phpBinary", () => {
  it("looks a bare command up on PATH and resolves a relative path in the project", () => {
    const saved = process.env.SMARTTEST_PHP;
    try {
      delete process.env.SMARTTEST_PHP;
      expect(phpBinary("/repo")).toBe("php");
      expect(phpBinary("/repo", "php8.3")).toBe("php8.3");
      process.env.SMARTTEST_PHP = "bin/php";
      expect(phpBinary("/repo").replaceAll("\\", "/")).toMatch(/\/repo\/bin\/php$/);
    } finally {
      if (saved === undefined) delete process.env.SMARTTEST_PHP;
      else process.env.SMARTTEST_PHP = saved;
    }
  });
});
