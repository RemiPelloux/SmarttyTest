/**
 * @smarttest/config — configuration schema, defaults, validation and loading.
 */
import type { SmartTestConfig } from "./types.js";

export * from "./defaults.js";
export * from "./load.js";
export type * from "./types.js";
export * from "./validate.js";

/** Identity helper that provides type-checking and editor completion for smarttest.config.ts. */
export function defineConfig(config: SmartTestConfig): SmartTestConfig {
  return config;
}
