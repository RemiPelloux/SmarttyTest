#!/usr/bin/env node
// Bundles the extension into one CommonJS file. `vscode` is provided by the
// extension host and is the only external module.
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(join(packageRoot, "package.json"));
const esbuild = require("esbuild");
const watch = process.argv.includes("--watch");

const options = {
  entryPoints: [join(packageRoot, "src", "extension.ts")],
  outfile: join(packageRoot, "dist", "extension.cjs"),
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node20",
  external: ["vscode"],
  sourcemap: true,
  sourcesContent: true,
  logLevel: "info",
  absWorkingDir: packageRoot,
  legalComments: "none",
};

if (watch) {
  const context = await esbuild.context(options);
  await context.watch();
  console.log("SmartTest extension: watching src/extension.ts");
} else {
  await esbuild.build(options);
  console.log("SmartTest extension: built dist/extension.cjs");
}
