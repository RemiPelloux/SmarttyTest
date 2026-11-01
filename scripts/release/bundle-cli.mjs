#!/usr/bin/env node
/**
 * Builds the publishable `smarttest` package into packages/cli/.publish/ (ST-099):
 *   - one ESM bundle for the CLI and the config API (all @smarttest/* packages inlined)
 *   - only runtime dependency: typescript (used to parse projects and load smarttest.config.ts)
 *   - hand-written public types (defineConfig + config schema)
 *   - `@tkmremi/smarttest/studio`: `startStudio`, to embed Studio in another Node process
 *   - the Plugin SDK (`@tkmremi/smarttest/plugin-sdk`, `@tkmremi/smarttest/plugin-sdk/conformance`) with its
 *     declarations, and the JSON schemas (`@tkmremi/smarttest/schemas/*`)
 *
 *   node scripts/release/bundle-cli.mjs [--version x.y.z]
 */
import { cp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import ts from "typescript";

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
const cli = join(root, "packages/cli");
const out = join(cli, ".publish");
const versionArg = process.argv.indexOf("--version");
const cliPkg = JSON.parse(await readFile(join(cli, "package.json"), "utf8"));
const rootPkg = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
const tsVersion = JSON.parse(await readFile(join(root, "packages/config/package.json"), "utf8"))
  .dependencies.typescript;
const version = versionArg > -1 ? process.argv[versionArg + 1] : cliPkg.version;

await rm(out, { recursive: true, force: true });
await mkdir(join(out, "dist"), { recursive: true });

await build({
  entryPoints: {
    bin: join(cli, "src/bin.ts"),
    index: join(cli, "src/index.ts"),
    "parse-worker": join(root, "packages/core/src/parse-worker.ts"),
    "plugin-sdk": join(root, "packages/plugin-sdk/src/index.ts"),
    "plugin-sdk-conformance": join(root, "packages/plugin-sdk/src/conformance.ts"),
    // `@tkmremi/smarttest/playwright`: the page fixture that records browser coverage for `--coverage`.
    playwright: join(root, "packages/adapter-playwright/src/coverage.ts"),
    // `@tkmremi/smarttest/studio`: only `startStudio`; the rest of @smarttest/studio stays internal.
    studio: "smarttest-studio-entry",
  },
  outdir: join(out, "dist"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  splitting: true,
  conditions: ["@smarttest/source"],
  external: [],
  sourcemap: "linked",
  legalComments: "linked",
  banner: {
    js: "import { createRequire as __stCreateRequire } from 'node:module'; const require = __stCreateRequire(import.meta.url);",
  },
  define: { "process.env.SMARTTEST_BUNDLED": '"1"' },
  plugins: [
    {
      name: "studio-entry",
      setup(b) {
        b.onResolve({ filter: /^smarttest-studio-entry$/ }, () => ({
          path: "studio-entry",
          namespace: "studio-entry",
        }));
        b.onLoad({ filter: /.*/, namespace: "studio-entry" }, () => ({
          contents: 'export { startStudio } from "./src/server.ts";\n',
          resolveDir: join(root, "packages/studio"),
          loader: "js",
        }));
      },
    },
    {
      // Load typescript with require(): importing its 9 MB CommonJS file through the ESM loader
      // makes Node scan it for named exports, which costs about 200 ms per process and worker.
      name: "typescript-require",
      setup(b) {
        b.onResolve({ filter: /^typescript$/ }, (args) =>
          args.namespace === "ts-require"
            ? { path: "typescript", external: true }
            : { path: "typescript", namespace: "ts-require" },
        );
        b.onLoad({ filter: /.*/, namespace: "ts-require" }, () => ({
          contents: 'const ts = require("typescript");\nexport default ts;\n',
          loader: "js",
        }));
      },
    },
  ],
  logLevel: "warning",
});

// Studio is loaded on demand; keep its browser assets alongside the bundled server chunk.
await cp(join(root, "packages/studio/web"), join(out, "dist/web"), { recursive: true });

// Public types: the config schema + defineConfig + main.
let types = await readFile(join(root, "packages/config/src/types.ts"), "utf8");
types = types.replace(
  /^import type \{ SafetyMode \} from "@smarttest\/shared";\n/m,
  'export type SafetyMode = "fast" | "balanced" | "safe";\n',
);
types += `
/** Identity helper that provides type-checking and editor completion for smarttest.config.ts. */
export declare function defineConfig(config: SmartTestConfig): SmartTestConfig;

/** Programmatic entry point of the CLI. Resolves to the process exit code. */
export declare function main(argv: readonly string[]): Promise<number>;
`;
await writeFile(join(out, "dist/index.d.ts"), types);
await writeFile(
  join(out, "dist/studio.d.ts"),
  `export interface StartStudioOptions {
  /** Project root to analyse. */
  root: string;
  /** Explicit config file, like \`--config\` on the CLI. */
  configPath?: string;
  /** Preferred port (default 4173). When it is taken, Studio falls back to an ephemeral port. */
  port?: number;
  /** Loopback host (default 127.0.0.1). Anything else is refused. */
  host?: string;
  /** Override the \`.smarttest\` store directory. */
  storeDir?: string;
  /** Directory containing Studio's \`index.html\`. Defaults to the assets shipped in this package. */
  assetDir?: string;
  /** Re-analyse when project files change (default true). */
  watch?: boolean;
}

export interface StudioServerHandle {
  /** URL to open. The session token travels in the fragment and never reaches the server. */
  url: string;
  port: number;
  token: string;
  root: string;
  /** Stops the server. Calling it again does nothing. */
  close(): Promise<void>;
}

/** Starts Studio on a loopback port for \`options.root\`, like \`smarttest studio\`. */
export declare function startStudio(options: StartStudioOptions): Promise<StudioServerHandle>;
`,
);
await writeFile(
  join(out, "dist/playwright.d.ts"),
  `/** Set by \`smarttest run --coverage\` for Playwright groups: where the page fixture writes V8 coverage. */
export declare const BROWSER_COVERAGE_ENV = "SMARTTEST_BROWSER_COVERAGE_DIR";
/**
 * Wraps Playwright's \`test\` so its \`page\` fixture records Chromium JS coverage on a SmartTest
 * coverage run: \`export const test = withBrowserCoverage(base)\`. Chromium only; does nothing otherwise.
 */
export declare function withBrowserCoverage<T>(base: { extend(fixtures: { page: unknown }): T }): T;
`,
);

// Plugin SDK declarations: emitted from the sources, with `@smarttest/shared` replaced by the
// public contracts only (primitives and contracts/*, which hold types and nothing else).
const sdkEntries = ["index", "conformance"].map((f) =>
  join(root, `packages/plugin-sdk/src/${f}.ts`),
);
const emitted = new Map();
const program = ts.createProgram(sdkEntries, {
  declaration: true,
  emitDeclarationOnly: true,
  strict: true,
  skipLibCheck: true,
  target: ts.ScriptTarget.ES2023,
  lib: ["lib.es2023.d.ts"],
  types: ["node"],
  typeRoots: [join(root, "node_modules/@types")],
  module: ts.ModuleKind.NodeNext,
  moduleResolution: ts.ModuleResolutionKind.NodeNext,
  // A path mapping (not node_modules resolution) so shared's declarations are emitted too.
  paths: { "@smarttest/shared": [join(root, "packages/shared/src/index.ts")] },
  rootDir: join(root, "packages"),
  outDir: "/sdk-types",
});
const emit = program.emit(undefined, (file, text) => emitted.set(file, text));
const errors = ts.getPreEmitDiagnostics(program).concat(emit.diagnostics);
if (errors.length)
  throw new Error(
    ts.formatDiagnostics(errors, {
      getCanonicalFileName: (f) => f,
      getCurrentDirectory: () => root,
      getNewLine: () => "\n",
    }),
  );
const typesDir = join(out, "dist/types");
const publicShared = [
  "primitives.d.ts",
  ...(await readdir(join(root, "packages/shared/src/contracts")))
    .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))
    .map((f) => `contracts/${f.replace(/\.ts$/, ".d.ts")}`),
];
for (const [file, text] of emitted) {
  const rel = file.replace(/^\/sdk-types\//, "");
  let dest;
  if (rel.startsWith("plugin-sdk/src/")) dest = rel.replace("plugin-sdk/src/", "plugin-sdk/");
  else if (publicShared.some((p) => rel === `shared/src/${p}`))
    dest = rel.replace("shared/src/", "shared/");
  else continue;
  await mkdir(dirname(join(typesDir, dest)), { recursive: true });
  await writeFile(
    join(typesDir, dest),
    text.replaceAll('"@smarttest/shared"', '"../shared/index.js"'),
  );
}
await writeFile(
  join(typesDir, "shared/index.d.ts"),
  `${publicShared.map((p) => `export type * from "./${p.replace(/\.d\.ts$/, ".js")}";`).join("\n")}\n`,
);

const manifest = {
  name: "@tkmremi/smarttest",
  version,
  description:
    "Semantic test-impact analysis for TypeScript & JavaScript — run only the tests that matter, through Jest, Vitest, node:test, Playwright or Cypress.",
  keywords: [
    "testing",
    "test-impact-analysis",
    "test-selection",
    "affected-tests",
    "jest",
    "vitest",
    "node-test",
    "playwright",
    "cypress",
    "typescript",
    "javascript",
    "pre-commit",
    "ci",
    "monorepo",
  ],
  homepage: "https://remipelloux.github.io/SmarttyTest/",
  bugs: { url: "https://github.com/RemiPelloux/SmarttyTest/issues" },
  license: "Apache-2.0",
  type: "module",
  bin: { smarttest: "./dist/bin.js" },
  exports: {
    ".": { types: "./dist/index.d.ts", default: "./dist/index.js" },
    "./plugin-sdk": {
      types: "./dist/types/plugin-sdk/index.d.ts",
      default: "./dist/plugin-sdk.js",
    },
    "./plugin-sdk/conformance": {
      types: "./dist/types/plugin-sdk/conformance.d.ts",
      default: "./dist/plugin-sdk-conformance.js",
    },
    "./playwright": { types: "./dist/playwright.d.ts", default: "./dist/playwright.js" },
    "./studio": { types: "./dist/studio.d.ts", default: "./dist/studio.js" },
    "./schemas/*": "./schemas/*",
    "./package.json": "./package.json",
  },
  types: "./dist/index.d.ts",
  files: ["dist", "schemas", "README.md", "LICENSE"],
  engines: { node: rootPkg.engines.node },
  dependencies: { typescript: tsVersion },
  repository: { type: "git", url: "git+https://github.com/RemiPelloux/SmarttyTest.git" },
  publishConfig: { access: "public" },
};
await writeFile(join(out, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);
await cp(join(cli, "schemas"), join(out, "schemas"), { recursive: true });
await cp(join(root, "LICENSE"), join(out, "LICENSE"));
// The npm README is for users: install from the registry, and leave contributor workflows
// (unreleased tarballs, the Development section) to the repository.
const repoReadme = await readFile(join(root, "README.md"), "utf8");
const userReadme = repoReadme
  .replace(/ To try an unreleased build, run `pnpm release:pack`[^\n]*/, "")
  .replace(
    /## Development\n[\s\S]*?(?=\n## )/,
    "## Development\n\nTo build SmartTest from source or contribute, see the [repository](https://github.com/RemiPelloux/SmarttyTest) and [CONTRIBUTING.md](CONTRIBUTING.md).\n",
  );
if (
  userReadme.includes("release:pack") ||
  !userReadme.includes("npm install -D @tkmremi/smarttest")
)
  throw new Error("README.md changed shape: update the npm README transform in bundle-cli.mjs");
await writeFile(
  join(out, "README.md"),
  userReadme
    // Images need raw URLs on npmjs.com; other relative links point at the GitHub tree.
    .replace(
      /src="(?!https?:)([^"]+)"/g,
      'src="https://raw.githubusercontent.com/RemiPelloux/SmarttyTest/main/$1"',
    )
    .replace(
      /href="(?!https?:|#)([^"]+)"/g,
      'href="https://github.com/RemiPelloux/SmarttyTest/blob/main/$1"',
    )
    .replace(
      /\]\((?!https?:|#)([^)]+)\)/g,
      "](https://github.com/RemiPelloux/SmarttyTest/blob/main/$1)",
    ),
);
console.log(`✔ @tkmremi/smarttest@${version} bundled into ${out.slice(root.length + 1)}`);
