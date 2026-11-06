/**
 * @smarttest/language-php — PHP analysis for SmartTest (preview): namespaces and `use`, classes,
 * interfaces, traits and enums with their members, Composer autoloading (PSR-4, PSR-0, classmap,
 * files), literal `require`/`include`, and Laravel's container (facades, bindings, the
 * application boot). Dynamic names are uncertainty. Parsed without running PHP.
 */
import type { Analyzer } from "@smarttest/source-parser";
import { analyzePhp, PHP_ANALYZER_VERSION } from "./analyze.js";

export {
  analyzePhp,
  PHP_ANALYZER_VERSION,
  PHP_TEST_FILE,
  type PhpBinding,
  phpBindings,
} from "./analyze.js";
export { PHP_CLASSES, PHP_FUNCTIONS } from "./builtins.js";
export { PHP_MUTANT_ERROR, type PhpMutationPoint, phpMutationPoints } from "./mutate.js";
export { PHP_RESOLVER_VERSION, PhpResolver } from "./resolve.js";
export { type Tok, tokenize } from "./tokenize.js";

export const phpAnalyzer: Analyzer = {
  apiVersion: 1,
  id: "php",
  version: PHP_ANALYZER_VERSION,
  supports: (path) => path.endsWith(".php"),
  analyze: (path, content) => analyzePhp(path, content),
};
