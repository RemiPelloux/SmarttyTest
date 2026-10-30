#!/usr/bin/env node
/**
 * Reproducible VSIX packaging without vsce.
 *
 * `--check` validates the manifest and the packaging rules (no runtime
 * dependencies, stable main, declared engine). `--check --require-build` also
 * requires dist/extension.cjs. Packaging fixes every mtime to 1980-01-01, sorts
 * file names and uses `zip -X`, so two runs from the same source produce the
 * same bytes.
 */
import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const check = args.includes("--check");
const requireBuild = args.includes("--require-build");
const outIndex = args.indexOf("--out");
const outDir = outIndex >= 0 ? args[outIndex + 1] : packageRoot;

const manifest = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));
const problems = [];

if (manifest.main !== "./dist/extension.cjs")
  problems.push("package.json main must be ./dist/extension.cjs");
if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(String(manifest.version)))
  problems.push("package.json version must be semver");
if (!manifest.publisher) problems.push("package.json publisher is required");
if (!manifest.engines?.vscode) problems.push("package.json engines.vscode is required");
if (manifest.dependencies && Object.keys(manifest.dependencies).length > 0)
  problems.push(
    "runtime dependencies are not allowed: the extension must use only the local executable",
  );
if (!Array.isArray(manifest.contributes?.commands) || manifest.contributes.commands.length === 0)
  problems.push("at least one command must be contributed");
for (const command of manifest.contributes?.commands ?? []) {
  if (!command.command || !command.title)
    problems.push(`command ${command.command ?? "?"} needs a title`);
}
if (!manifest.contributes?.views?.explorer?.some((view) => view.id === "smarttest.results"))
  problems.push("the smarttest.results explorer view must be contributed");
if (!manifest.capabilities?.untrustedWorkspaces)
  problems.push("untrustedWorkspaces capability must be declared");
if (requireBuild && !existsSync(join(packageRoot, "dist", "extension.cjs")))
  problems.push("dist/extension.cjs is missing; run `node scripts/build.mjs` first");

if (problems.length > 0) {
  for (const problem of problems) console.error(`error: ${problem}`);
  process.exit(1);
}

if (check) {
  console.log(
    `SmartTest extension manifest OK: ${manifest.name}@${manifest.version} (${manifest.contributes.commands.length} commands, no runtime dependencies).`,
  );
  process.exit(0);
}

if (!existsSync(join(packageRoot, "dist", "extension.cjs"))) {
  const build = spawnSync(process.execPath, [join(packageRoot, "scripts", "build.mjs")], {
    cwd: packageRoot,
    stdio: "inherit",
  });
  if (build.status !== 0) process.exit(build.status ?? 1);
}

const version = manifest.version;
const vsixPath = join(outDir, `${manifest.name}-${version}.vsix`);
const staging = join(packageRoot, ".vsix-stage");
rmSync(staging, { recursive: true, force: true });
mkdirSync(join(staging, "extension", "dist"), { recursive: true });

function escapeXml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

const contentTypes = `<?xml version="1.0" encoding="utf-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension=".json" ContentType="application/json"/>
<Default Extension=".js" ContentType="application/javascript"/>
<Default Extension=".cjs" ContentType="application/javascript"/>
<Default Extension=".map" ContentType="application/json"/>
<Default Extension=".md" ContentType="text/markdown"/>
<Default Extension=".txt" ContentType="text/plain"/>
<Default Extension=".vsixmanifest" ContentType="text/xml"/>
<Override PartName="/extension/package.json" ContentType="application/json"/>
</Types>`;

const vsixManifest = `<?xml version="1.0" encoding="utf-8"?>
<PackageManifest Version="2.0.0" xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011">
<Metadata>
<Identity Language="en-US" Id="${escapeXml(manifest.name)}" Version="${escapeXml(version)}" Publisher="${escapeXml(manifest.publisher)}"/>
<DisplayName>${escapeXml(manifest.displayName ?? manifest.name)}</DisplayName>
<Description>${escapeXml(manifest.description ?? "")}</Description>
<Categories>${escapeXml((manifest.categories ?? []).join(","))}</Categories>
<GalleryFlags>Public</GalleryFlags>
<Properties>
<Property Id="Microsoft.VisualStudio.Code.Engine" Value="${escapeXml(manifest.engines.vscode)}"/>
<Property Id="Microsoft.VisualStudio.Code.ExtensionKind" Value="workspace"/>
<Property Id="Microsoft.VisualStudio.Code.ExtensionDependencies" Value=""/>
<Property Id="Microsoft.VisualStudio.Code.ExtensionPack" Value=""/>
</Properties>
</Metadata>
<Installation>
<InstallationTarget Id="Microsoft.VisualStudio.Code"><TargetPlatform Version="${escapeXml(
  String(manifest.engines.vscode).replace(/^[^0-9]*/, ""),
)}"/></InstallationTarget>
</Installation>
<Dependencies/>
<Assets><Asset Type="Microsoft.VisualStudio.Code.Manifest" Path="extension/package.json" Addressable="true"/></Assets>
</PackageManifest>`;

writeFileSync(join(staging, "[Content_Types].xml"), contentTypes);
writeFileSync(join(staging, "extension.vsixmanifest"), vsixManifest);
for (const file of ["package.json", "README.md", "CHANGELOG.md", "LICENSE"]) {
  const source = join(packageRoot, file);
  if (existsSync(source)) cpSync(source, join(staging, "extension", file));
}
for (const file of ["extension.cjs", "extension.cjs.map"]) {
  const source = join(packageRoot, "dist", file);
  if (existsSync(source)) cpSync(source, join(staging, "extension", "dist", file));
}

// Fixed timestamp (the ZIP epoch) and sorted paths make the archive repeatable.
const files = [];
function collect(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
    a.name.localeCompare(b.name),
  )) {
    const absolute = join(dir, entry.name);
    if (entry.isDirectory()) collect(absolute);
    else files.push(relative(staging, absolute));
  }
}
collect(staging);

const epoch = "198001010000.00";
for (const file of files) {
  const touched = spawnSync("touch", ["-t", epoch, join(staging, file)]);
  if (touched.status !== 0) {
    console.error("error: touch is required for reproducible VSIX packaging");
    process.exit(1);
  }
}
mkdirSync(outDir, { recursive: true });
rmSync(vsixPath, { force: true });
const zip = spawnSync("zip", ["-X", "-q", "-@", vsixPath], {
  cwd: staging,
  input: `${files.join("\n")}\n`,
  encoding: "utf8",
});
if (zip.status !== 0) {
  console.error(zip.stderr || "error: zip failed");
  process.exit(zip.status ?? 1);
}
rmSync(staging, { recursive: true, force: true });
console.log(`SmartTest extension: wrote ${vsixPath} (${files.length} files)`);
