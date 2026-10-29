/**
 * smarttest — the SmartTest CLI and the public entry point for `smarttest.config.ts`.
 *
 *   import { defineConfig } from "smarttest";
 */

export type {
  RiskLevel,
  Rule,
  RuleMatch,
  SmartTestConfig,
  TestCategory,
  TestLayout,
} from "@smarttest/config";
export { defineConfig } from "@smarttest/config";
export { main } from "./main.js";
