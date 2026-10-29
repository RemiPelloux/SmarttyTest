import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { exists, SmartTestError, shortHash } from "@smarttest/shared";
import ts from "typescript";
import { resolveConfig } from "./defaults.js";
import type { ResolvedConfig, SmartTestConfig } from "./types.js";
import { type ConfigIssue, validateConfig } from "./validate.js";

export const CONFIG_FILES = [
  "smarttest.config.ts",
  "smarttest.config.mts",
  "smarttest.config.js",
  "smarttest.config.mjs",
  "smarttest.config.json",
];

export interface LoadedConfig {
  config: ResolvedConfig;
  raw: SmartTestConfig;
  path?: string;
  warnings: ConfigIssue[];
}

export async function findConfigFile(root: string): Promise<string | undefined> {
  for (const name of CONFIG_FILES) {
    const p = join(root, name);
    if (await exists(p)) return p;
  }
  return undefined;
}

/**
 * Loads smarttest.config.* without requiring the smarttest package to be resolvable:
 * the file is transpiled and `defineConfig` imports are replaced by an identity helper.
 */
async function importConfigModule(root: string, file: string): Promise<unknown> {
  const source = await readFile(file, "utf8");
  if (file.endsWith(".json")) return JSON.parse(source);
  const stripped = source.replace(
    /^\s*import\s+(?:type\s+)?\{[^}]*\}\s+from\s+["'](?:smarttest|@smarttest\/config)["'];?\s*$/gm,
    "",
  );
  const js = ts.transpileModule(`const defineConfig = (c) => c;\n${stripped}`, {
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022,
      verbatimModuleSyntax: false,
    },
    fileName: file,
  }).outputText;
  const tmpDir = join(root, ".smarttest", "tmp");
  await mkdir(tmpDir, { recursive: true });
  const tmp = join(tmpDir, `config.${shortHash(js)}.mjs`);
  await writeFile(tmp, js);
  try {
    const mod = (await import(pathToFileURL(tmp).href)) as { default?: unknown };
    return mod.default ?? mod;
  } finally {
    await rm(tmp, { force: true });
  }
}

export async function loadConfig(root: string, explicitPath?: string): Promise<LoadedConfig> {
  const path = explicitPath ? join(root, explicitPath) : await findConfigFile(root);
  if (!path) return { config: resolveConfig({}), raw: {}, warnings: [] };
  if (!(await exists(path))) {
    throw new SmartTestError(`Config file not found: ${explicitPath}`, {
      code: "ST_CONFIG_NOT_FOUND",
      category: "configuration",
      hint: "Check the --config path, or run `smarttest init` to create one.",
    });
  }
  let raw: unknown;
  try {
    raw = await importConfigModule(root, path);
  } catch (cause) {
    throw new SmartTestError(`Could not load ${path}: ${(cause as Error).message}`, {
      code: "ST_CONFIG_LOAD_FAILED",
      category: "configuration",
      hint: "Make sure the config file is valid TypeScript/JavaScript and exports a default object.",
      cause,
    });
  }
  const { errors, warnings } = validateConfig(raw);
  if (errors.length) {
    throw new SmartTestError(
      `Invalid configuration in ${path}:\n${errors.map((e) => `  • ${e.path || "(root)"}: ${e.message}`).join("\n")}`,
      {
        code: "ST_CONFIG_INVALID",
        category: "configuration",
        hint: "Fix the listed options, then run `smarttest doctor`.",
      },
    );
  }
  return {
    config: resolveConfig(raw as SmartTestConfig),
    raw: raw as SmartTestConfig,
    path,
    warnings,
  };
}
