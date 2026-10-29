/**
 * @smarttest/language-javascript — JavaScript adapter (ESM, CommonJS, JSX).
 * Powered by the TypeScript parser in JavaScript mode.
 */
import { ANALYZER_VERSION, analyzeSource } from "@smarttest/language-typescript";
import type { Analyzer } from "@smarttest/source-parser";

export const javascriptAnalyzer: Analyzer = {
  id: "javascript",
  version: ANALYZER_VERSION,
  supports: (path) => /\.(?:[cm]?js|jsx)$/.test(path),
  analyze: (path, content) => analyzeSource(path, content),
};
