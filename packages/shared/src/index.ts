/**
 * @smarttest/shared — shared contracts, primitives, error model, exit codes and utilities.
 *
 * Contracts mirror the master specification (documentation/product/PRD.md).
 */

export type * from "./contracts/adapters.js";
export type * from "./contracts/graph.js";
export type * from "./contracts/impact.js";
export type * from "./contracts/symbols.js";
export type * from "./contracts/test-results.js";
export type * from "./contracts/tracing.js";
export type * from "./contracts/vcs.js";
export * from "./errors.js";
export * from "./fs.js";
export * from "./glob.js";
export * from "./hash.js";
export * from "./logger.js";
export * from "./paths.js";
export * from "./primitives.js";
export * from "./proc.js";
export * from "./text.js";

export const VERSION = "0.9.0";
