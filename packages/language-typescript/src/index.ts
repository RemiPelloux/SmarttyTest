/**
 * @smarttest/language-typescript — TypeScript language adapter built on the TypeScript Compiler API.
 * This is the only analysis package that imports `typescript` (ADR-0002).
 */
import type { Analyzer, FileAnalysis } from "@smarttest/source-parser";
import { ANALYZER_VERSION, analyzeSource } from "./analyze.js";

export { ANALYZER_VERSION, analyzeSource, tokenHash } from "./analyze.js";
export { TypeScriptResolver, type WorkspaceEntry } from "./resolve.js";

export const typescriptAnalyzer: Analyzer = {
  id: "typescript",
  version: ANALYZER_VERSION,
  supports: (path) => /\.(?:[cm]?ts|tsx)$/.test(path) && !path.endsWith(".d.ts"),
  analyze: (path, content): FileAnalysis => analyzeSource(path, content),
};
