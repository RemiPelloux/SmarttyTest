/**
 * Plugin loading and edge providers (Plugin SDK v1; documentation/guides/plugins.md).
 *
 * Plugins are listed in the `plugins` option: paths relative to the project root, or package
 * names resolved from it. Each module's default export is a `SmartTestPlugin`. Loading a plugin
 * runs its code, exactly like loading `smarttest.config.ts` does.
 *
 * Safety: provided edges only add dependents. A provider that throws or returns malformed output
 * fails the analysis (never "no edges"), and what it reports as unresolved becomes uncertainty.
 */
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { isAbsolute, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { ProvidedGraphInput } from "@smarttest/dependency-graph";
import { PLUGIN_API_VERSION } from "@smarttest/plugin-sdk";
import {
  type Confidence,
  type EdgeProvider,
  type EdgeProviderContext,
  type GraphEdgeKind,
  SmartTestError,
  type SmartTestPlugin,
} from "@smarttest/shared";

export { PLUGIN_API_VERSION };

const EDGE_KINDS: readonly GraphEdgeKind[] = [
  "IMPORTS",
  "EXPORTS",
  "CALLS",
  "REFERENCES",
  "EXTENDS",
  "IMPLEMENTS",
  "INSTANTIATES",
  "DEPENDS_ON",
  "TESTS",
  "COVERS",
  "OBSERVED_EXECUTION",
  "CONFIGURES",
];
const CONFIDENCES: readonly Confidence[] = ["high", "medium", "low", "unknown"];

export interface LoadedPlugin {
  /** As written in the configuration. */
  spec: string;
  /** Absolute path of the loaded module. */
  path: string;
  plugin: SmartTestPlugin;
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** A project-relative POSIX path that stays inside the project. */
export function isProjectPath(p: unknown): p is string {
  return (
    typeof p === "string" &&
    p.length > 0 &&
    !p.includes("\\") &&
    !p.startsWith("/") &&
    !/^[A-Za-z]:/.test(p) &&
    !p.split("/").some((s) => s === ".." || s === "." || s === "")
  );
}

function invalid(spec: string, message: string): SmartTestError {
  return new SmartTestError(`Plugin ${spec}: ${message}`, {
    code: "ST_PLUGIN_INVALID",
    category: "configuration",
    hint: "Check the plugin against the Plugin SDK conformance kit (smarttest/plugin-sdk/conformance).",
  });
}

/** Checks the static shape of a plugin's default export. */
export function assertPlugin(spec: string, value: unknown): asserts value is SmartTestPlugin {
  if (!isObject(value)) throw invalid(spec, "the module's default export must be a plugin object");
  if (value.apiVersion !== PLUGIN_API_VERSION)
    throw new SmartTestError(
      `Plugin ${spec} targets plugin API ${String(value.apiVersion)}; this SmartTest implements API ${PLUGIN_API_VERSION}`,
      {
        code: "ST_PLUGIN_API_VERSION",
        category: "configuration",
        hint: "Update the plugin or SmartTest so that both use the same plugin API version.",
      },
    );
  if (typeof value.name !== "string" || !value.name) throw invalid(spec, "`name` is required");
  if (value.edgeProviders !== undefined) {
    if (!Array.isArray(value.edgeProviders))
      throw invalid(spec, "`edgeProviders` must be an array");
    for (const [i, p] of value.edgeProviders.entries()) {
      if (!isObject(p)) throw invalid(spec, `edgeProviders[${i}] must be an object`);
      if (p.apiVersion !== PLUGIN_API_VERSION)
        throw invalid(spec, `edgeProviders[${i}].apiVersion must be ${PLUGIN_API_VERSION}`);
      if (typeof p.id !== "string" || !p.id)
        throw invalid(spec, `edgeProviders[${i}].id is required`);
      for (const fn of ["getCapabilities", "provideEdges"])
        if (typeof p[fn] !== "function")
          throw invalid(spec, `edgeProviders[${i}].${fn} must be a function`);
    }
  }
}

/** Resolves and imports the configured plugins, in order. */
export async function loadPlugins(root: string, specs: readonly string[]): Promise<LoadedPlugin[]> {
  const out: LoadedPlugin[] = [];
  for (const spec of specs) {
    let path: string;
    try {
      path =
        spec.startsWith(".") || isAbsolute(spec)
          ? resolve(root, spec)
          : createRequire(join(root, "package.json")).resolve(spec);
    } catch (error) {
      throw new SmartTestError(`Plugin ${spec} cannot be found from ${root}`, {
        code: "ST_PLUGIN_LOAD_FAILED",
        category: "configuration",
        hint: "Use a path relative to the project root (./tools/plugin.mjs) or an installed package name.",
        cause: error,
      });
    }
    let mod: { default?: unknown };
    try {
      mod = (await import(pathToFileURL(path).href)) as { default?: unknown };
    } catch (error) {
      throw new SmartTestError(`Plugin ${spec} failed to load: ${(error as Error).message}`, {
        code: "ST_PLUGIN_LOAD_FAILED",
        category: "configuration",
        hint: "Run the module with node to see the error.",
        cause: error,
      });
    }
    const plugin = mod.default ?? mod;
    assertPlugin(spec, plugin);
    out.push({ spec, path, plugin });
  }
  return out;
}

export interface ProviderRunContext {
  root: string;
  files: readonly string[];
  isTest(path: string): boolean;
  listFiles(): Promise<string[]>;
}

/**
 * Runs every edge provider and returns their validated output for the graph. Providers that do
 * not declare `fileEdges` are not called (ADR-0005); the others' limits become warnings.
 */
export async function runEdgeProviders(
  plugins: readonly LoadedPlugin[],
  run: ProviderRunContext,
): Promise<ProvidedGraphInput & { warnings: string[] }> {
  const edges: ProvidedGraphInput["edges"][number][] = [];
  const unresolved: { file: string; reason: string }[] = [];
  const warnings: string[] = [];
  let listed: Promise<string[]> | undefined;
  const context: EdgeProviderContext = {
    root: run.root,
    files: run.files,
    isTest: run.isTest,
    listFiles: () => {
      listed ??= run.listFiles();
      return listed.then((l) => [...l]);
    },
    readFile: async (p) => {
      const abs = resolve(run.root, p);
      const rel = relative(run.root, abs);
      if (!rel || rel.startsWith("..") || isAbsolute(rel)) return undefined;
      return readFile(abs, "utf8").catch(() => undefined);
    },
  };
  for (const { spec, plugin } of plugins) {
    for (const provider of plugin.edgeProviders ?? []) {
      const failure = (message: string, cause?: unknown) =>
        new SmartTestError(`Edge provider ${provider.id} (${spec}) ${message}`, {
          code: "ST_PLUGIN_FAILED",
          category: "infrastructure",
          hint: "Its edges are unknown, so SmartTest cannot rule any test out. Fix the plugin or remove it from `plugins`.",
          ...(cause !== undefined ? { cause } : {}),
        });
      const caps = provider.getCapabilities() as Partial<
        ReturnType<EdgeProvider["getCapabilities"]>
      >;
      if (caps.fileEdges !== true && caps.fileEdges !== "partial") {
        warnings.push(`Edge provider ${provider.id} does not declare fileEdges; it was not used`);
        continue;
      }
      if (caps.unresolved !== true)
        warnings.push(
          `Edge provider ${provider.id} cannot report what it fails to resolve; its edges only add tests`,
        );
      let result: Awaited<ReturnType<EdgeProvider["provideEdges"]>>;
      try {
        result = await provider.provideEdges(context);
      } catch (error) {
        throw failure(`failed: ${(error as Error).message}`, error);
      }
      if (!isObject(result) || !Array.isArray(result.edges))
        throw failure("returned no `edges` array");
      for (const [i, e] of (result.edges as unknown[]).entries()) {
        const edge = e as Record<string, unknown>;
        if (
          !isObject(e) ||
          !isProjectPath(edge.from) ||
          !isProjectPath(edge.to) ||
          !EDGE_KINDS.includes(edge.kind as GraphEdgeKind) ||
          !CONFIDENCES.includes(edge.confidence as Confidence)
        )
          throw failure(`returned an invalid edge at edges[${i}]: ${JSON.stringify(e)}`);
        edges.push({
          from: edge.from as string,
          to: edge.to as string,
          kind: edge.kind as GraphEdgeKind,
          confidence: edge.confidence as Confidence,
          provider: provider.id,
        });
      }
      if (result.unresolved !== undefined && !Array.isArray(result.unresolved))
        throw failure("returned `unresolved` that is not an array");
      for (const [i, u] of (result.unresolved ?? []).entries()) {
        if (!isObject(u) || !isProjectPath(u.file) || typeof u.reason !== "string")
          throw failure(`returned an invalid unresolved entry at unresolved[${i}]`);
        unresolved.push({ file: u.file, reason: `${provider.id}: ${u.reason}` });
      }
    }
  }
  return { edges, unresolved, warnings };
}
