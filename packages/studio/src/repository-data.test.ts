/**
 * Repository-controlled data in the new Studio views (security review, second pass).
 */
import { createHash } from "node:crypto";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { LineCoverageReport } from "@smarttest/core";
import { describe, expect, it } from "vitest";
import { sourceCoverageOf } from "./snapshot.js";

interface MapModule {
  mapDot(map: unknown, view: unknown, filters: unknown): string;
}

const mapJs = (await import(
  pathToFileURL(join(import.meta.dirname, "..", "web", "js", "map.js")).href
)) as MapModule;

describe("impact map DOT export (SR-19)", () => {
  it("keeps a change description on its comment line", () => {
    const dot = mapJs.mapDot(
      { change: 'git · main\n"x" [image="/etc/passwd"];\n' },
      {
        nodes: [{ id: 'src/"a".ts', label: "a\nb", role: "changed" }],
        edges: [],
      },
      { change: "", test: "", kind: "", confidence: "" },
    );
    const lines = dot.split("\n");
    expect(lines[0]?.startsWith("// SmartTest impact map · git · main")).toBe(true);
    expect(lines.filter((l) => l.includes("image="))).toEqual([lines[0]]);
    expect(dot).toContain('"src/\\"a\\".ts" [label="a\\nb", shape=ellipse, style=bold];');
  });
});

describe("line coverage from runner output (SR-20)", () => {
  const text = "export const a = 1;\n";
  const sha = createHash("sha256").update(text).digest("hex");
  const report = (files: Record<string, unknown>) =>
    ({
      schemaVersion: 1,
      origin: "istanbul",
      scope: "full",
      runId: "r",
      collectedAt: "t",
      files,
      unmapped: [],
    }) as unknown as LineCoverageReport;

  it("does not break the source view on a malformed or inherited entry", () => {
    for (const files of [
      { "src/a.ts": { sha256: sha, lines: "x", branches: [] } },
      { "src/a.ts": { sha256: sha, lines: [5, [1, 2], null], branches: [null, { line: 1 }] } },
    ]) {
      const result = sourceCoverageOf(report(files), "src/a.ts", text, false, [1]);
      expect(["absent", "current"]).toContain(result.state);
    }
    const proto = sourceCoverageOf(report({}), "constructor", text, false, []);
    expect(proto.state).toBe("absent");
    const ok = sourceCoverageOf(
      report({ "src/a.ts": { sha256: sha, lines: [[1, 3]], branches: [] } }),
      "src/a.ts",
      text,
      false,
      [1],
    );
    expect(ok.state).toBe("current");
    expect(ok.lines).toEqual([{ n: 1, hits: 3 }]);
  });
});
