import { describe, expect, it } from "vitest";
import { vitestFailedSuiteText } from "./index.js";

const block = (header: string, error: string) =>
  `\n FAIL  ${header}\nError: ${error}\n ❯ somewhere\n\n⎯⎯⎯⎯⎯⎯[1/2]⎯\n`;

describe("the text Vitest printed for a file that failed outside its tests", () => {
  it("finds the file's block, with or without the suite's line after the path", () => {
    const stderr = `\n⎯⎯ Failed Suites 2 ⎯⎯\n${block("tests/after-all.test.ts > d", "afterAll boom")}${block("tests/before-all.test.ts:2 > d", "beforeAll boom")}`;
    expect(vitestFailedSuiteText(stderr, "tests/after-all.test.ts")).toContain("afterAll boom");
    const before = vitestFailedSuiteText(stderr, "tests/before-all.test.ts");
    expect(before).toContain("beforeAll boom");
    expect(before).not.toContain("afterAll boom");
    expect(vitestFailedSuiteText(stderr, "tests/other.test.ts")).toBeUndefined();
  });
});
