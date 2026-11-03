/**
 * @smarttest/language-python — Python analysis for SmartTest (preview): modules, classes,
 * functions and methods, imports (absolute, relative, packages, `src/` layouts), `conftest.py`
 * fixtures, and dynamic imports as uncertainty. Parsed without running Python.
 */
import type { Analyzer } from "@smarttest/source-parser";
import { analyzePython, PYTHON_ANALYZER_VERSION } from "./analyze.js";

export { analyzePython, PYTHON_ANALYZER_VERSION, PYTHON_TEST_FILE, tokenize } from "./analyze.js";
export {
  PYTHON_MUTANT_ERROR,
  type PythonMutationPoint,
  pythonMutationPoints,
} from "./mutate.js";
export { PYTHON_RESOLVER_VERSION, PythonResolver } from "./resolve.js";
export { PYTHON_STDLIB } from "./stdlib.js";

export const pythonAnalyzer: Analyzer = {
  apiVersion: 1,
  id: "python",
  version: PYTHON_ANALYZER_VERSION,
  supports: (path) => path.endsWith(".py"),
  analyze: (path, content) => analyzePython(path, content),
};
