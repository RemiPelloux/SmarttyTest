import { describe, expect, it } from "vitest";
import * as conformance from "./conformance.js";
import * as sdk from "./index.js";

/**
 * The runtime surface of Plugin SDK v1 is frozen at 1.0.0 (documentation/reference/contracts.md):
 * removing or renaming an export is a breaking change, adding one is a deliberate minor change.
 */
describe("Plugin SDK v1 surface", () => {
  it("exports the frozen runtime API", () => {
    expect(Object.keys(sdk).sort()).toEqual([
      "EDGE_PROVIDER_CAPABILITY_KEYS",
      "PLUGIN_API_VERSION",
      "TEST_ADAPTER_CAPABILITY_KEYS",
      "VCS_CAPABILITY_KEYS",
      "checkTestAdapterConformance",
      "defineEdgeProvider",
      "definePlugin",
      "fileOfTestId",
      "parseJestLikeReport",
      "resolvePackageBin",
      "supports",
      "supportsPartially",
    ]);
    expect(sdk.PLUGIN_API_VERSION).toBe(1);
  });

  it("exports the conformance kit", () => {
    expect(Object.keys(conformance).sort()).toEqual([
      "assertConformance",
      "checkEdgeProvider",
      "checkLanguageAnalyzer",
      "checkPlugin",
      "checkRunnerAdapter",
      "checkTestAdapterConformance",
      "checkVcsAdapter",
      "edgeProviderContext",
      "formatConformanceReport",
      "isProjectRelativePath",
    ]);
  });

  it("treats only explicit declarations as support (ADR-0005)", () => {
    expect(sdk.supports(true)).toBe(true);
    expect(sdk.supports("partial")).toBe(false);
    expect(sdk.supports(undefined)).toBe(false);
    expect(sdk.supportsPartially("partial")).toBe(true);
  });

  it("checks an edge provider's declarations against its behaviour", async () => {
    const report = await conformance.checkEdgeProvider(
      {
        apiVersion: 1,
        id: "undeclared",
        getCapabilities: () => ({ fileEdges: true, unresolved: false, nonSourceFiles: false }),
        provideEdges: async () => ({
          edges: [{ from: "a.ts", to: "schema.graphql", kind: "DEPENDS_ON", confidence: "high" }],
          unresolved: [{ file: "a.ts", reason: "x" }],
        }),
      },
      { root: "/", files: ["a.ts"], allFiles: ["a.ts", "schema.graphql"] },
    );
    expect(report.ok).toBe(false);
    const result = report.checks.find((c) => c.name === "edges.result");
    expect(result?.message).toMatch(/nonSourceFiles is not declared/);
    expect(result?.message).toMatch(/does not declare the unresolved capability/);
  });
});
