import { describe, expect, it } from "vitest";
import { parseNameStatusZ, parseZeroContextRanges, scopeChangeSet } from "./index.js";

describe("vcs-core parsers", () => {
  it("parses name-status -z with renames", () => {
    const out = "M\0src/a.ts\0R087\0src/old.ts\0src/new.ts\0D\0src/gone.ts\0A\0src/added.ts\0";
    expect(parseNameStatusZ(out)).toEqual([
      { type: "modified", path: "src/a.ts" },
      { type: "renamed", path: "src/new.ts", previousPath: "src/old.ts" },
      { type: "deleted", path: "src/gone.ts" },
      { type: "added", path: "src/added.ts" },
    ]);
  });

  it("parses -U0 hunks into 0-based ranges", () => {
    const diff =
      "diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -3 +3,2 @@\n-x\n+y\n+z\n@@ -10,2 +11,0 @@\n";
    const ranges = parseZeroContextRanges(diff).get("src/a.ts");
    expect(ranges?.map((r) => [r.start.line, r.end.line])).toEqual([
      [2, 3],
      [10, 10],
    ]);
  });

  it("scopes repo paths to a project subdirectory", () => {
    const cs = scopeChangeSet(
      {
        provider: "git",
        completeness: "complete",
        warnings: [],
        changes: [
          { type: "modified", path: "app/src/a.ts" },
          { type: "modified", path: "other/b.ts" },
        ],
      },
      "app",
    );
    expect(cs.changes).toEqual([{ type: "modified", path: "src/a.ts" }]);
  });
});
