/**
 * Plugin contracts (Plugin SDK v1, frozen at 1.0.0; documentation/guides/plugins.md).
 *
 * A plugin is a module whose default export is a `SmartTestPlugin`. It is listed in the `plugins`
 * option of the configuration. In 1.0 a plugin contributes edge providers: extra dependency edges
 * between project files that the TypeScript/JavaScript analysis cannot see (code generators,
 * non-code inputs, other languages).
 *
 * Safety (spec §32.2): provided edges only ever add tests to a selection; they never remove one.
 * A relationship a provider cannot resolve is reported in `unresolved` and becomes uncertainty,
 * so the tests that reach it are never ruled out in BALANCED or SAFE mode.
 */
import type { Capability, Confidence } from "../primitives.js";
import type { GraphEdgeKind } from "./graph.js";

/** What an edge provider can do (ADR-0005: anything not declared `true` is unsupported). */
export interface EdgeProviderCapabilities {
  /** Returns edges between project files. A provider without it is never called. */
  fileEdges: Capability;
  /** Reports the relationships it found but could not resolve, in `unresolved`. */
  unresolved: Capability;
  /** Its edges may point at files outside the analysed sources (non-code files, other languages). */
  nonSourceFiles: Capability;
}

/** "`from` depends on `to`": a change to `to` affects `from` and every test that reaches `from`. */
export interface ProvidedEdge {
  /** Project-relative POSIX path of the dependent file (a source file or a test). */
  from: string;
  /** Project-relative POSIX path of the file it depends on. */
  to: string;
  kind: GraphEdgeKind;
  confidence: Confidence;
  /** Why the edge exists, for explanations. */
  reason?: string;
}

/** A relationship the provider saw but could not resolve to a file. */
export interface UnresolvedRelationship {
  /** Project-relative POSIX path of the file holding the relationship. */
  file: string;
  reason: string;
}

export interface EdgeProviderContext {
  /** Absolute project root. */
  readonly root: string;
  /** Project-relative POSIX paths of the source files SmartTest analyses (tests included). */
  readonly files: readonly string[];
  /** Whether a project-relative path is a test file. */
  isTest(path: string): boolean;
  /** Every project file that is not excluded (non-code files included). */
  listFiles(): Promise<string[]>;
  /** Reads a project file; `undefined` when it does not exist or lies outside the project. */
  readFile(path: string): Promise<string | undefined>;
}

export interface EdgeProviderResult {
  edges: ProvidedEdge[];
  unresolved?: UnresolvedRelationship[];
}

/** Contributes dependency edges to the graph (Plugin SDK v1). */
export interface EdgeProvider {
  /** Plugin API version this provider implements. */
  readonly apiVersion: 1;
  /** Stable identifier, shown in explanations and warnings. */
  readonly id: string;
  getCapabilities(): EdgeProviderCapabilities;
  /** Called once per analysis. Must be deterministic for the same files. */
  provideEdges(context: EdgeProviderContext): Promise<EdgeProviderResult>;
}

/** The default export of a plugin module. */
export interface SmartTestPlugin {
  /** Plugin API version the plugin was written against. */
  readonly apiVersion: 1;
  readonly name: string;
  edgeProviders?: EdgeProvider[];
}
