#!/usr/bin/env node
/**
 * Builds the publishable `smarttest` package into packages/cli/.publish/ (ST-099):
 *   - one ESM bundle for the CLI and the config API (all @smarttest/* packages inlined)
 *   - only runtime dependency: typescript (used to parse projects and load smarttest.config.ts)
 *   - hand-written public types (defineConfig + config schema)
 *
 *   node scripts/release/bundle-cli.mjs [--version x.y.z]
 */
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

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
  entryPoints: { bin: join(cli, "src/bin.ts"), index: join(cli, "src/index.ts") },
  outdir: join(out, "dist"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  splitting: true,
  conditions: ["@smarttest/source"],
  external: ["typescript"],
  sourcemap: "linked",
  legalComments: "linked",
  banner: {
    js: "import { createRequire as __stCreateRequire } from 'node:module'; const require = __stCreateRequire(import.meta.url);",
  },
  define: { "process.env.SMARTTEST_BUNDLED": '"1"' },
  logLevel: "warning",
});

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
