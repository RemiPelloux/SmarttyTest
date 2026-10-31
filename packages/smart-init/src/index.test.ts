import { describe, expect, it } from "vitest";
import { previewDiff } from "./index.js";

const modify = (before: string, after: string) =>
  previewDiff({ path: "hook", action: "modify", reason: "", risk: "low", before, after });

describe("previewDiff", () => {
  it("shows an inserted block where it goes, with its repeated lines", () => {
    const before = [
      "#!/bin/sh",
      'if [ -n "$CHANGED" ]; then',
      "  npx vitest related $CHANGED &",
      "fi",
      "wait",
      "",
    ].join("\n");
    const after = [
      "#!/bin/sh",
      "if [ -x node_modules/.bin/smarttest ]; then",
      "  npx smarttest run",
      "fi",
      'if [ -n "$CHANGED" ]; then',
      "  true & # replaced: npx vitest related $CHANGED &",
      "fi",
      "wait",
      "",
    ].join("\n");
    expect(modify(before, after)).toEqual([
      "@ line 2",
      "+ if [ -x node_modules/.bin/smarttest ]; then",
      "+   npx smarttest run",
      "+ fi",
      "@ line 6",
      "-   npx vitest related $CHANGED &",
      "+   true & # replaced: npx vitest related $CHANGED &",
    ]);
  });

  it("reports a removal at the line where it was", () => {
    expect(modify("a\nb\nc\n", "a\nc\n")).toEqual(["@ line 2", "- b"]);
  });

  it("lists a new file without positions and nothing for an unchanged one", () => {
    expect(
      previewDiff({ path: "f", action: "create", reason: "", risk: "low", after: "x\ny\n" }),
    ).toEqual(["+ x", "+ y"]);
    expect(previewDiff({ path: "f", action: "skip", reason: "", risk: "low" })).toEqual([]);
  });
});
