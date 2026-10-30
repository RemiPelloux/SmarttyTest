#!/usr/bin/env node
/**
 * Enforces package boundaries (ST-002, ADR-0004):
 *   - a package may only import workspace packages declared in scripts/packages.manifest.json
 *   - external npm imports must be declared as `external` in the manifest
 *   - no package may use network modules; nothing at or below core may depend on ai-/studio-/cloud-*
 */
import { readdir, readFile } from "node:fs/promises";
import { builtinModules } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(await readFile(join(root, "scripts/packages.manifest.json"), "utf8"));
const scope = manifest.scope;
const byName = new Map(manifest.packages.map((p) => [p.name, p]));
const publishName = (p) => p.publishName ?? `${scope}/${p.name}`;
const nameToPkg = new Map(manifest.packages.map((p) => [publishName(p), p]));
const NETWORK = new Set(["http", "https", "http2", "net", "tls", "dgram", "dns"]);
const BUILTINS = new Set(builtinModules);

async function files(dir) {
  const out = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...(await files(p)));
    else if (/\.ts$/.test(e.name)) out.push(p);
  }
  return out;
}

const errors = [];
for (const pkg of manifest.packages) {
  const allowed = new Set((pkg.deps ?? []).map((d) => publishName(byName.get(d))));
  const allowedDev = new Set((pkg.devDeps ?? []).map((d) => publishName(byName.get(d))));
  const external = new Set(Object.keys(pkg.external ?? {}));
  for (const file of await files(join(root, "packages", pkg.name, "src"))) {
    const isTest = file.endsWith(".test.ts");
    const text = await readFile(file, "utf8");
    const rel = file.slice(root.length + 1);
    // preProcessFile sees real import/export/require/import() only — never strings or comments.
    for (const { fileName: spec } of ts.preProcessFile(text, true, true).importedFiles) {
      if (spec.startsWith(".")) continue;
      const bare = spec.startsWith("node:") ? spec.slice(5) : spec;
      if (spec.startsWith("node:") || BUILTINS.has(bare.split("/")[0])) {
        if (
          NETWORK.has(bare.split("/")[0]) &&
          !(pkg.name === "studio" && ["http", "net"].includes(bare.split("/")[0]))
        )
          errors.push(`${rel}: network module "${spec}" is not allowed (local-first, ADR-0004)`);
        continue;
      }
      const pkgName = spec.startsWith("@")
        ? spec.split("/").slice(0, 2).join("/")
        : spec.split("/")[0];
      if (nameToPkg.has(pkgName)) {
        if (
          /(^|\/)(ai-|studio|cloud)/.test(pkgName) &&
          !(pkg.name === "cli" && pkgName === `${scope}/studio`)
        )
          errors.push(`${rel}: must not depend on ${pkgName} (ADR-0004)`);
        if (!allowed.has(pkgName) && !(isTest && allowedDev.has(pkgName)))
          errors.push(
            `${rel}: imports ${pkgName} which is not declared in the manifest for ${pkg.name}`,
          );
      } else if (!external.has(pkgName) && !(isTest && pkgName === "vitest")) {
        errors.push(
          `${rel}: imports external package "${pkgName}" not declared as external in the manifest`,
        );
      }
    }
    if (/\bfetch\s*\(/.test(text) && !isTest)
      errors.push(`${rel}: fetch() is not allowed in the local-first core (ADR-0004)`);
  }
}
if (errors.length) {
  console.error(`✖ Package boundary violations:\n  - ${errors.join("\n  - ")}`);
  process.exit(1);
}
console.log(`✔ package boundaries OK (${manifest.packages.length} packages)`);
