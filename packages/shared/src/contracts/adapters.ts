import type { Capability } from "../primitives.js";
import type { GraphEdge, GraphNode } from "./graph.js";
import type { SourceSymbol } from "./symbols.js";
import type { ExecutionOptions, TestCase, TestRunResult, TestSelection } from "./test-results.js";

export interface TestAdapterCapabilities {
  discovery: Capability;
  fileSelection: Capability;
  testCaseSelection: Capability;
  coverage: Capability;
  tracing: Capability;
  parallel: Capability;
  cancellation: Capability;
  retry: Capability;
  sourceMaps: Capability;
}

export interface CoverageArtifact {
  format: "istanbul-json" | "lcov" | "v8";
  /** Full-suite vs selected-subset coverage must never be conflated (spec §16.2). */
  scope: "full" | "selected";
  path: string;
}

export interface TestAdapter {
  id: string;
  discover(): Promise<TestCase[]>;
  execute(selection: TestSelection, options: ExecutionOptions): Promise<TestRunResult>;
  collectCoverage?(): Promise<CoverageArtifact>;
  getCapabilities(): TestAdapterCapabilities;
}

export interface SymbolGraph {
  symbols: SourceSymbol[];
  nodes: GraphNode[];
  edges: GraphEdge[];
  unresolved: { filePath: string; specifier: string; reason: string }[];
}

export interface TestTarget {
  testFilePath: string;
  symbolId: string;
  kind: "unit" | "integration" | "e2e";
}

export interface LanguageAdapter {
  language: string;
  analyze(files: string[]): Promise<SymbolGraph>;
  findTestTargets(symbol: SourceSymbol): Promise<TestTarget[]>;
}
