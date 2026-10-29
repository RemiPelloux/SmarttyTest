import type { ResolvedConfig, SmartTestConfig } from "./types.js";

export const SOURCE_EXTENSIONS = ["ts", "tsx", "mts", "cts", "js", "jsx", "mjs", "cjs"] as const;

export const DEFAULT_INCLUDE = [`**/*.{${SOURCE_EXTENSIONS.join(",")}}`];

export const DEFAULT_EXCLUDE = [
  "**/*.d.ts",
  "**/node_modules/**",
  "**/dist/**",
  "**/build/**",
  "**/coverage/**",
  "**/.next/**",
  "**/.smarttest/**",
  "smarttest.config.*",
];

/**
 * Built-in mandatory triggers (spec §11.4). Changes to these files widen verification.
 * Rules and config can add triggers, never remove these.
 */
export const BUILTIN_TRIGGERS = [
  "**/tsconfig*.json",
  "**/jsconfig*.json",
  "**/package.json",
  "**/package-lock.json",
  "**/pnpm-lock.yaml",
  "**/pnpm-workspace.yaml",
  "**/yarn.lock",
  "**/bun.lock",
  "**/bun.lockb",
  "**/.npmrc",
  "**/.nvmrc",
  "**/.node-version",
  "**/vitest.config.*",
  "**/vitest.workspace.*",
  "**/vite.config.*",
  "**/jest.config.*",
  "**/jest.preset.*",
  "**/babel.config.*",
  "**/.babelrc*",
  "**/.swcrc",
  "**/{vitest,jest}.setup.*",
  "**/setupTests.*",
  "**/global-setup.*",
  "**/.env",
  "**/.env.*",
  "smarttest.config.*",
];

export function resolveConfig(config: SmartTestConfig = {}): ResolvedConfig {
  return {
    include: config.include ?? DEFAULT_INCLUDE,
    exclude: [...DEFAULT_EXCLUDE, ...(config.exclude ?? [])],
    mode: config.mode ?? "balanced",
    adapters: config.adapters ?? [],
    vcs: {
      provider: config.vcs?.provider ?? "auto",
      ...(config.vcs?.base ? { base: config.vcs.base } : {}),
      snapshots: config.vcs?.snapshots ?? true,
    },
    snapshots: {
      storeContent: config.snapshots?.storeContent ?? false,
      keep: config.snapshots?.keep ?? 20,
    },
    tests: {
      ...(config.tests?.layout ? { layout: config.tests.layout } : {}),
      directory: config.tests?.directory ?? "tests",
      ...(config.tests?.naming ? { naming: config.tests.naming } : {}),
      ...(config.tests?.match ? { match: config.tests.match } : {}),
      ...(config.tests?.templates ? { templates: config.tests.templates } : {}),
    },
    generated: config.generated ?? [],
    triggers: config.triggers ?? [],
    rules: config.rules ?? [],
    retries: config.retries ?? 0,
    timeoutMs: config.timeoutMs ?? 10 * 60_000,
    ...(config.workers ? { workers: config.workers } : {}),
    reports: {
      formats: config.reports?.formats ?? ["html", "json"],
      outputDir: config.reports?.outputDir ?? ".smarttest/reports",
    },
    storeDir: config.storeDir ?? ".smarttest",
  };
}
