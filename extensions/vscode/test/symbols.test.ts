import { describe, expect, it } from "vitest";
import type { GraphDump } from "../src/core/contracts.js";
import {
  bindingAtPosition,
  type DocumentSymbolNode,
  matchUnitsToSymbols,
  unitsByFile,
  unitsForFile,
} from "../src/core/symbols.js";

const graph: GraphDump = {
  nodes: [
    { id: "src/a.ts", kind: "file", label: "a.ts", filePath: "src/a.ts" },
    { id: "src/a.ts#run", kind: "function", label: "run", filePath: "src/a.ts" },
    { id: "src/a.ts#A", kind: "class", label: "A", filePath: "src/a.ts" },
    { id: "src/a.ts#A.run", kind: "method", label: "run", filePath: "src/a.ts" },
    { id: "src/b.ts#B", kind: "class", label: "B", filePath: "src/b.ts" },
    { id: "src/a.test.ts#suite", kind: "test-suite", label: "suite", filePath: "src/a.test.ts" },
    { id: "src/a.ts#module", kind: "module", label: "a", filePath: "src/a.ts" },
  ],
  edges: [],
};

const symbols: DocumentSymbolNode[] = [
  {
    name: "run",
    kind: "function",
    range: { start: { line: 0, character: 0 }, end: { line: 2, character: 1 } },
  },
  {
    name: "A",
    kind: "class",
    range: { start: { line: 4, character: 0 }, end: { line: 20, character: 1 } },
    children: [
      {
        name: "run",
        kind: "method",
        range: { start: { line: 6, character: 2 }, end: { line: 8, character: 3 } },
      },
      {
        name: "run",
        kind: "method",
        range: { start: { line: 10, character: 2 }, end: { line: 12, character: 3 } },
      },
    ],
  },
  {
    name: "Namespace",
    kind: "namespace",
    range: { start: { line: 22, character: 0 }, end: { line: 30, character: 1 } },
    children: [
      {
        name: "inner",
        kind: "function",
        range: { start: { line: 24, character: 2 }, end: { line: 26, character: 3 } },
      },
    ],
  },
];

describe("graph units", () => {
  it("keeps only functions, methods and classes from the requested file", () => {
    expect(unitsForFile(graph, "src/a.ts").map((unit) => unit.id)).toEqual([
      "src/a.ts#run",
      "src/a.ts#A",
      "src/a.ts#A.run",
    ]);
    expect(unitsForFile(graph, "src/a.ts", "win32")).toHaveLength(3);
    expect(unitsForFile(graph, "SRC/A.TS", "win32")).toHaveLength(3);
    expect(unitsForFile(graph, "src/A.ts", "linux")).toHaveLength(0);
  });

  it("indexes every file once and drops duplicate unit ids", () => {
    const index = unitsByFile(
      {
        nodes: [
          ...graph.nodes,
          { id: "src/a.ts#run", kind: "function", label: "run", filePath: "src/a.ts" },
          { id: "./src/c.ts#c", kind: "function", label: "c" },
        ],
        edges: [],
      },
      "linux",
    );
    expect(index.get("src/a.ts")?.map((unit) => unit.id)).toEqual([
      "src/a.ts#run",
      "src/a.ts#A",
      "src/a.ts#A.run",
    ]);
    expect(index.get("src/b.ts")?.map((unit) => unit.id)).toEqual(["src/b.ts#B"]);
    expect(index.get("src/c.ts")?.map((unit) => unit.qualifiedName)).toEqual(["c"]);
    expect(index.has("src/a.test.ts")).toBe(false);
  });
});

describe("symbol matching", () => {
  it("matches functions, methods and namespace members", () => {
    const bindings = matchUnitsToSymbols(unitsForFile(graph, "src/a.ts"), symbols);
    expect(bindings.map((binding) => [binding.unit.id, binding.range.start.line])).toEqual([
      ["src/a.ts#run", 0],
      ["src/a.ts#A", 4],
      ["src/a.ts#A.run", 6],
    ]);
  });

  it("uses the first declaration for an overloaded method", () => {
    const method = unitsForFile(graph, "src/a.ts").find((unit) => unit.id === "src/a.ts#A.run");
    const [binding] = matchUnitsToSymbols(method ? [method] : [], symbols);
    expect(binding?.range.start.line).toBe(6);
  });

  it("returns no binding when the language server has no symbol", () => {
    expect(matchUnitsToSymbols(unitsForFile(graph, "src/b.ts"), symbols)).toEqual([]);
  });

  it("finds the smallest enclosing unit at a position", () => {
    const bindings = matchUnitsToSymbols(unitsForFile(graph, "src/a.ts"), symbols);
    expect(bindingAtPosition(bindings, 7, 4)?.unit.id).toBe("src/a.ts#A.run");
    expect(bindingAtPosition(bindings, 5, 0)?.unit.id).toBe("src/a.ts#A");
    expect(bindingAtPosition(bindings, 1, 0)?.unit.id).toBe("src/a.ts#run");
    expect(bindingAtPosition(bindings, 40, 0)).toBeUndefined();
  });
});
