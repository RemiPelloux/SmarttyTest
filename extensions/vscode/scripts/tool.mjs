#!/usr/bin/env node
import { spawnSync } from "node:child_process";
// Runs a tool from the nearest node_modules/.bin. The extension is a member of
// the root pnpm workspace, so `pnpm install` at the repository root provisions
// TypeScript, Vitest and esbuild here; this helper also finds the root binaries
// when a local install has not been materialised yet.
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const tool = process.argv[2];
if (!tool) {
  console.error("usage: node scripts/tool.mjs <binary> [...args]");
  process.exit(2);
}

function findBinary(name) {
  let dir = packageRoot;
  for (;;) {
    const candidate = join(dir, "node_modules", ".bin", name);
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

const binary = findBinary(tool);
if (!binary) {
  console.error(
    `SmartTest extension: ${tool} is not installed. Run \`pnpm install\` at the repository root.`,
  );
  process.exit(1);
}

const result = spawnSync(binary, process.argv.slice(3), {
  cwd: packageRoot,
  stdio: "inherit",
  env: process.env,
});
if (result.error) {
  console.error(result.error.message);
  process.exit(1);
}
process.exit(result.status ?? 1);
