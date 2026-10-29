/**
 * @smarttest/test-generator — source-aware test architecture (spec §13).
 * Never overwrites: existing tests and collisions are reported, not replaced. Scaffolds use
 * `it.todo`, so gaps stay visible and never count as passing tests.
 */

import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, posix } from "node:path";
import type { TestLayout } from "@smarttest/config";
import type { DependencyGraph } from "@smarttest/dependency-graph";
import type { RulesEngine } from "@smarttest/rules-engine";
import { exists, matchGlob, SmartTestError } from "@smarttest/shared";
import type { FileAnalysis, SymbolRecord } from "@smarttest/source-parser";
import { topLevelSymbols } from "@smarttest/source-parser";
import type { TestCategory } from "@smarttest/test-discovery";

export interface GenerateOptions {
  root: string;
  layout: TestLayout;
  directory: string;
  naming?: string;
  runner: "vitest" | "jest" | "node";
  type: TestCategory;
  moduleType: "esm" | "cjs";
  templatesDir?: string;
  filter?: { class?: string; module?: string; path?: string; files?: string[] };
  rules: RulesEngine;
  packageOf?: (path: string) => string | undefined;
}

export type ItemStatus = "create" | "covered" | "exists" | "collision" | "skipped";

export interface GenerationItem {
  source: string;
  target: string;
  status: ItemStatus;
  reason: string;
  template: string;
  symbols: string[];
  content?: string;
}

const SKIP_SOURCE = /(?:^|\/)(?:index|main|types?|constants?|.*\.config|.*\.d)\.[cm]?[jt]sx?$/;

function extOf(path: string): string {
  return path.slice(path.lastIndexOf(".") + 1);
}

function stripSrc(path: string): { prefix: string; rest: string } {
  const parts = path.split("/");
  const i = parts.findIndex((p) => ["src", "lib", "app", "source"].includes(p));
  if (i === -1) return { prefix: "", rest: path };
  return { prefix: parts.slice(0, i).join("/"), rest: parts.slice(i + 1).join("/") };
}

function domainOf(rest: string): string {
  const parts = rest.split("/");
  if (["modules", "domains", "features"].includes(parts[0] ?? "") && parts.length > 2)
    return parts[1] as string;
  return parts.length > 1 ? (parts[0] as string) : "core";
}

export function applyTokens(template: string, tokens: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (m, k: string) => {
    if (!(k in tokens))
      throw new SmartTestError(`Unknown naming token ${m}`, {
        code: "ST_TEMPLATE_TOKEN",
        category: "configuration",
        hint: `Valid tokens: ${Object.keys(tokens)
          .map((t) => `{${t}}`)
          .join(" ")}`,
      });
    return tokens[k] as string;
  });
}

export function targetPath(
  source: string,
  analysis: FileAnalysis | undefined,
  opts: Pick<GenerateOptions, "layout" | "directory" | "naming" | "type" | "packageOf">,
  customPath?: string,
): string {
  const base = posix.basename(source).replace(/\.[^.]+$/, "");
  const ext = extOf(source);
  const { prefix, rest } = stripSrc(source);
  const restDir = posix.dirname(rest) === "." ? "" : posix.dirname(rest);
  const symbols = analysis ? topLevelSymbols(analysis) : [];
  const tokens: Record<string, string> = {
    ClassName: symbols.find((s) => s.kind === "class" && s.exportNames.length)?.name ?? base,
    FunctionName: symbols.find((s) => s.kind === "function" && s.exportNames.length)?.name ?? base,
    MethodName: "",
    FileName: base,
    ModuleName: posix.basename(posix.dirname(source)) || base,
    PackageName: opts.packageOf?.(source) ?? "",
    DomainName: domainOf(rest),
    Type: opts.type,
    Extension: ext,
  };
  const fileName = applyTokens(opts.naming ?? "{FileName}.test.{Extension}", tokens);
  if (customPath) return posix.normalize(applyTokens(customPath, tokens));
  const join2 = (...p: string[]) => p.filter(Boolean).join("/");
  switch (opts.layout) {
    case "colocated":
      return join2(posix.dirname(source) === "." ? "" : posix.dirname(source), fileName);
    case "domain":
      return join2(prefix, opts.directory, opts.type, tokens.DomainName as string, fileName);
    default:
      return join2(prefix, opts.directory, opts.type, restDir, fileName);
  }
}

function importPath(from: string, to: string, moduleType: "esm" | "cjs"): string {
  let rel = posix.relative(posix.dirname(from), to);
  if (!rel.startsWith(".")) rel = `./${rel}`;
  if (/\.[cm]?tsx?$/.test(to)) return rel.replace(/\.[cm]?tsx?$/, "");
  if (moduleType === "esm") return rel;
  return rel.replace(/\.c?js$/, "");
}

function membersOf(a: FileAnalysis, cls: SymbolRecord): SymbolRecord[] {
  return a.symbols.filter(
    (s) =>
      s.parent === cls.qualifiedName &&
      s.kind === "method" &&
      s.visibility !== "private" &&
      s.name !== "constructor",
  );
}

export function renderScaffold(
  source: string,
  target: string,
  a: FileAnalysis,
  opts: Pick<GenerateOptions, "runner" | "moduleType">,
  template: string,
): { content: string; symbols: string[] } {
  const exported = topLevelSymbols(a).filter(
    (s) => s.exportNames.length && s.kind !== "interface" && s.kind !== "type",
  );
  const cjs =
    a.moduleKind === "cjs" || (opts.moduleType === "cjs" && !/\.(?:mjs|mts|ts|tsx)$/.test(target));
  const imp = importPath(target, source, cjs ? "cjs" : opts.moduleType);
  const named = exported.filter((s) => !s.exportNames.includes("default")).map((s) => s.name);
  const def = exported.find((s) => s.exportNames.includes("default"));
  const lines: string[] = [
    `// Generated by SmartTest — ${template} scaffold for ${source}`,
    "// Each it.todo is a visible gap: it is reported as todo, never as a passing test.",
    "",
  ];
  if (opts.runner === "vitest" && !cjs) lines.push(`import { describe, it } from "vitest";`);
  if (opts.runner === "node")
    lines.push(
      cjs
        ? `const { describe, it } = require("node:test");`
        : `import { describe, it } from "node:test";`,
    );
  if (cjs) {
    const names = a.moduleKind === "cjs" ? [] : named;
    lines.push(
      names.length
        ? `const { ${names.join(", ")} } = require("${imp}");`
        : `const subject = require("${imp}");`,
    );
  } else {
    const parts = [
      def ? (def.name === "default" ? "subject" : def.name) : "",
      named.length ? `{ ${named.join(", ")} }` : "",
    ].filter(Boolean);
    if (parts.length) lines.push(`import ${parts.join(", ")} from "${imp}";`);
  }
  lines.push("");
  const symbols: string[] = [];
  const targets = exported.length
    ? exported
    : topLevelSymbols(a).filter((s) => s.kind === "function" || s.kind === "class");
  if (!targets.length) {
    lines.push(
      `describe("${posix.basename(source)}", () => {`,
      `  it.todo("describe the behaviour of ${posix.basename(source)}");`,
      "});",
      "",
    );
  }
  for (const s of targets) {
    const title = s.name === "default" ? posix.basename(source).replace(/\.[^.]+$/, "") : s.name;
    lines.push(`describe("${title}", () => {`);
    if (template === "database")
      lines.push(
        "  // TODO: set up an isolated datastore in beforeEach / tear it down in afterEach",
      );
    if (s.kind === "class") {
      const members = membersOf(a, s);
      for (const m of members) {
        lines.push(
          `  it.todo("${m.name}${m.signature.replace(/^(public|protected) (static )?/, "").replace(/"/g, "'")}");`,
        );
        symbols.push(m.qualifiedName);
      }
      if (!members.length) lines.push(`  it.todo("constructs ${s.name}");`);
      if (template === "service") lines.push('  it.todo("handles error cases");');
      if (template === "controller") lines.push('  it.todo("rejects invalid input");');
    } else {
      lines.push(`  it.todo("${title}${s.signature.replace(/"/g, "'")}");`);
      if (template !== "default") lines.push('  it.todo("handles edge cases");');
      symbols.push(s.qualifiedName);
    }
    lines.push("});", "");
  }
  return { content: lines.join("\n"), symbols };
}

export async function planGeneration(
  files: ReadonlyMap<string, FileAnalysis>,
  testFiles: readonly string[],
  graph: DependencyGraph,
  opts: GenerateOptions,
): Promise<GenerationItem[]> {
  const items: GenerationItem[] = [];
  const testSet = new Set(testFiles);
  const testBases = new Map<string, string>();
  for (const t of testFiles)
    testBases.set(
      posix
        .basename(t)
        .replace(/\.(?:test|spec)\.[^.]+$/, "")
        .replace(/\.[^.]+$/, ""),
      t,
    );
  const directlyTested = new Map<string, string>();
  for (const t of testFiles) {
    for (const imp of files.get(t)?.imports ?? [])
      if (imp.resolved) directlyTested.set(imp.resolved, t);
  }
  const targetsSeen = new Map<string, string>();
  for (const [source, a] of [...files].sort(([x], [y]) => x.localeCompare(y))) {
    if (testSet.has(source) || SKIP_SOURCE.test(source)) continue;
    const f = opts.filter;
    if (f?.files && !f.files.includes(source)) continue;
    if (
      f?.path &&
      !matchGlob(source, f.path) &&
      !source.startsWith(`${f.path.replace(/\/$/, "")}/`)
    )
      continue;
    if (f?.module && !source.split("/").includes(f.module)) continue;
    const symbols = topLevelSymbols(a);
    if (f?.class && !symbols.some((s) => s.kind === "class" && s.name === f.class)) continue;
    const exported = symbols.filter(
      (s) => s.exportNames.length && s.kind !== "interface" && s.kind !== "type",
    );
    if (!exported.length && a.moduleKind !== "cjs") continue;
    const pkg = opts.packageOf?.(source);
    const policy = opts.rules.evaluateAll([
      { path: source, ...(pkg ? { package: pkg } : {}) },
      ...symbols.map((s) => ({
        path: source,
        ...(pkg ? { package: pkg } : {}),
        symbol: {
          name: s.name,
          qualifiedName: s.qualifiedName,
          kind: s.kind,
          decorators: s.decorators,
        },
      })),
    ]);
    opts.rules.assertNoConflicts(policy);
    const template =
      policy.generate?.template ??
      (exported.some((s) => /Repository$/.test(s.name))
        ? "database"
        : exported.some((s) => /Service$/.test(s.name))
          ? "service"
          : exported.some((s) => /Controller$/.test(s.name))
            ? "controller"
            : "default");
    const target = targetPath(source, a, opts, policy.generate?.path);
    const base = posix.basename(source).replace(/\.[^.]+$/, "");
    const item: GenerationItem = {
      source,
      target,
      status: "create",
      reason: "no test found",
      template,
      symbols: [],
    };
    const coveredBy = directlyTested.get(source);
    if (coveredBy)
      Object.assign(item, { status: "covered", reason: `already tested by ${coveredBy}` });
    else if (testBases.has(base) && testBases.get(base) !== target)
      Object.assign(item, {
        status: "covered",
        reason: `a test with the same name exists: ${testBases.get(base)}`,
      });
    else if (testSet.has(target) || (await exists(join(opts.root, target))))
      Object.assign(item, {
        status: "exists",
        reason: "target file already exists — never overwritten",
      });
    else if (targetsSeen.has(target))
      Object.assign(item, {
        status: "collision",
        reason: `same target as ${targetsSeen.get(target)}`,
      });
    if (item.status === "create") {
      const custom = opts.templatesDir
        ? await loadCustomTemplate(join(opts.root, opts.templatesDir), template)
        : undefined;
      const rendered = renderScaffold(source, target, a, opts, template);
      item.content = custom
        ? custom.replace("{{source}}", source).replace("{{scaffold}}", rendered.content)
        : rendered.content;
      item.symbols = rendered.symbols;
      targetsSeen.set(target, source);
    }
    items.push(item);
  }
  void graph;
  return items;
}

async function loadCustomTemplate(dir: string, name: string): Promise<string | undefined> {
  try {
    return await readFile(join(dir, `${name}.tpl`), "utf8");
  } catch {
    return undefined;
  }
}

/** All-or-nothing write: stage every file, then rename; nothing is ever overwritten. */
export async function applyGeneration(
  root: string,
  items: readonly GenerationItem[],
): Promise<string[]> {
  const toWrite = items.filter((i) => i.status === "create" && i.content !== undefined);
  for (const i of toWrite) {
    if (await exists(join(root, i.target))) {
      throw new SmartTestError(`Refusing to overwrite ${i.target}`, {
        code: "ST_GENERATE_COLLISION",
        category: "policy",
        hint: "Re-run `smarttest generate --dry-run` to see the current plan.",
      });
    }
  }
  const staged: { tmp: string; final: string }[] = [];
  try {
    for (const i of toWrite) {
      const final = join(root, i.target);
      await mkdir(dirname(final), { recursive: true });
      const tmp = `${final}.${randomBytes(4).toString("hex")}.tmp`;
      await writeFile(tmp, i.content as string, { flag: "wx" });
      staged.push({ tmp, final });
    }
    for (const s of staged) await rename(s.tmp, s.final);
  } catch (error) {
    for (const s of staged) await rm(s.tmp, { force: true });
    throw error;
  }
  return toWrite.map((i) => i.target);
}

export interface SyncReport {
  missing: GenerationItem[];
  orphaned: { test: string; reason: string }[];
  renamed: { from: string; to: string; test: string; proposedTarget: string }[];
}

export function syncReport(
  items: readonly GenerationItem[],
  files: ReadonlyMap<string, FileAnalysis>,
  testFiles: readonly string[],
  renames: readonly { from: string; to: string }[],
  opts: Pick<GenerateOptions, "layout" | "directory" | "naming" | "type" | "packageOf">,
): SyncReport {
  const orphaned: SyncReport["orphaned"] = [];
  for (const t of testFiles) {
    const a = files.get(t);
    if (!a) continue;
    const internal = a.imports.filter((i) => i.specifier.startsWith(".") && i.kind !== "mock");
    const broken = internal.filter((i) => i.missing || (!i.resolved && !i.external));
    if (broken.length && broken.length === internal.length)
      orphaned.push({
        test: t,
        reason: `imports no longer resolve: ${broken.map((b) => b.specifier).join(", ")}`,
      });
  }
  const renamed: SyncReport["renamed"] = [];
  for (const r of renames) {
    for (const t of testFiles) {
      const a = files.get(t);
      if (a?.imports.some((i) => i.resolved === r.from || (i.missing && i.resolved === r.from))) {
        renamed.push({
          from: r.from,
          to: r.to,
          test: t,
          proposedTarget: targetPath(r.to, files.get(r.to), opts),
        });
      }
    }
  }
  return { missing: items.filter((i) => i.status === "create"), orphaned, renamed };
}
