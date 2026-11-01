#!/usr/bin/env node
/**
 * Builds the publishable `smarttest` package into packages/cli/.publish/ (ST-099):
 *   - one ESM bundle for the CLI and the config API (all @smarttest/* packages inlined)
 *   - only runtime dependency: typescript (used to parse projects and load smarttest.config.ts)
 *   - hand-written public types (defineConfig + config schema)
 *   - the Plugin SDK (`smarttest/plugin-sdk`, `smarttest/plugin-sdk/conformance`) with its
 *     declarations, and the JSON schemas (`smarttest/schemas/*`)
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
    // `smarttest/playwright`: the page fixture that records browser coverage for `--coverage`.
    playwright: join(root, "packages/adapter-playwright/src/coverage.ts"),
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
  name: "smarttest",
  version,
  description:
    "Semantic test-impact analysis for TypeScript & JavaScript — run only the tests that matter, on top of Jest and Vitest.",
  keywords: [
    "testing",
    "test-impact-analysis",
    "affected-tests",
    "jest",
    "vitest",
    "typescript",
    "ci",
    "monorepo",
  ],
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
await writeFile(
  join(out, "README.md"),
  (await readFile(join(root, "README.md"), "utf8"))
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
console.log(`✔ smarttest@${version} bundled into ${out.slice(root.length + 1)}`);
