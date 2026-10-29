#!/usr/bin/env node
/**
 * Writes a CycloneDX 1.5 SBOM for the packed `smarttest` package (packages/cli/.publish/sbom.cdx.json):
 * the package itself, the workspace packages bundled into it, and its runtime dependency.
 */
import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "../..");
const out = join(root, "packages/cli/.publish");
const pkg = JSON.parse(await readFile(join(out, "package.json"), "utf8"));
const manifest = JSON.parse(await readFile(join(root, "scripts/packages.manifest.json"), "utf8"));
const ts = JSON.parse(await readFile(join(root, "node_modules/typescript/package.json"), "utf8"));
const purl = (name, version) => `pkg:npm/${name.replace("@", "%40")}@${version}`;
const main = {
  type: "application",
  "bom-ref": purl(pkg.name, pkg.version),
  name: pkg.name,
  version: pkg.version,
  purl: purl(pkg.name, pkg.version),
  licenses: [{ license: { id: pkg.license } }],
};
const bundled = manifest.packages
  .filter((p) => p.name !== "cli")
  .map((p) => ({
    type: "library",
    "bom-ref": purl(`@smarttest/${p.name}`, pkg.version),
    name: `@smarttest/${p.name}`,
    version: pkg.version,
    description: `${p.description} (bundled into smarttest)`,
    licenses: [{ license: { id: pkg.license } }],
    scope: "required",
  }));
const deps = Object.entries(pkg.dependencies ?? {}).map(([name]) => {
  const version = name === "typescript" ? ts.version : "unknown";
  return {
    type: "library",
    "bom-ref": purl(name, version),
    name,
    version,
    purl: purl(name, version),
    licenses: [{ license: { id: name === "typescript" ? ts.license : "NOASSERTION" } }],
    scope: "required",
  };
});
const sbom = {
  bomFormat: "CycloneDX",
  specVersion: "1.5",
  serialNumber: `urn:uuid:${randomUUID()}`,
  version: 1,
  metadata: {
    timestamp: new Date().toISOString(),
    tools: [{ name: "scripts/release/sbom.mjs" }],
    component: main,
  },
  components: [...bundled, ...deps],
  dependencies: [
    { ref: main["bom-ref"], dependsOn: [...bundled, ...deps].map((c) => c["bom-ref"]) },
  ],
};
await writeFile(join(out, "sbom.cdx.json"), `${JSON.stringify(sbom, null, 2)}\n`);
pkg.files = [...new Set([...(pkg.files ?? []), "sbom.cdx.json"])];
await writeFile(join(out, "package.json"), `${JSON.stringify(pkg, null, 2)}\n`);
console.log(
  `✔ SBOM: ${bundled.length} bundled packages, ${deps.length} runtime dependenc${deps.length === 1 ? "y" : "ies"} → packages/cli/.publish/sbom.cdx.json`,
);
