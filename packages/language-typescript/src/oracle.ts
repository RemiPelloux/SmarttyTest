/**
 * What `smarttest audit` compares SmartTest with: functions to break on purpose (fault
 * injection) and the TypeScript compiler's own module resolution.
 */
import { dirname, isAbsolute, join, relative } from "node:path";
import { toPosix } from "@smarttest/shared";
import ts from "typescript";

/** The text a mutant runs first: makes the function throw, whatever it was doing. */
export const MUTANT_ERROR = 'throw new Error("smarttest audit: injected fault");';

export interface MutationPoint {
  /** `name`, `Class.method`, `Class.prop` (an arrow function), or `<anonymous>@line`. */
  name: string;
  /** 1-based line of the function. */
  line: number;
  /** Replaces `text.slice(start, end)` with `replacement` to break the function. */
  start: number;
  end: number;
  replacement: string;
}

function nameOf(node: ts.Node, sf: ts.SourceFile): string {
  const owner = (n: ts.Node): string | undefined => {
    const cls = n.parent;
    return cls && (ts.isClassLike(cls) || ts.isObjectLiteralExpression(cls))
      ? ts.isClassLike(cls) && cls.name
        ? `${cls.name.text}.`
        : ""
      : undefined;
  };
  const named = (n: ts.Node) =>
    "name" in n && n.name && ts.isIdentifier(n.name as ts.Node)
      ? (n.name as ts.Identifier).text
      : undefined;
  if (
    ts.isFunctionDeclaration(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isGetAccessor(node) ||
    ts.isSetAccessor(node)
  ) {
    const n = named(node);
    if (n) return `${owner(node) ?? ""}${n}`;
  }
  if (ts.isConstructorDeclaration(node)) return `${owner(node) ?? ""}constructor`;
  // `const f = () => …`, `prop = () => …`
  const p = node.parent;
  if (
    p &&
    (ts.isVariableDeclaration(p) || ts.isPropertyDeclaration(p) || ts.isPropertyAssignment(p))
  ) {
    const n = named(p);
    if (n) return `${ts.isPropertyDeclaration(p) ? (owner(p) ?? "") : ""}${n}`;
  }
  return `<anonymous>@${sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1}`;
}

/** Every function with a body, and how to make it throw. */
export function mutationPoints(path: string, text: string): MutationPoint[] {
  const kind = /\.[cm]?tsx$|\.jsx$/.test(path) ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sf = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, kind);
  const out: MutationPoint[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isFunctionLike(node) && "body" in node && node.body) {
      const body = node.body as ts.Node;
      const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
      const name = nameOf(node, sf);
      if (ts.isBlock(body)) {
        const at = body.getStart(sf) + 1; // after `{`
        out.push({ name, line, start: at, end: at, replacement: ` ${MUTANT_ERROR}` });
      } else {
        // An arrow function's expression body.
        out.push({
          name,
          line,
          start: body.getStart(sf),
          end: body.getEnd(),
          replacement: `(() => { ${MUTANT_ERROR} })()`,
        });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

export function applyMutation(text: string, point: MutationPoint): string {
  return text.slice(0, point.start) + point.replacement + text.slice(point.end);
}

export type CompilerResolution =
  | { kind: "project"; file: string }
  | { kind: "external" }
  | { kind: "types-only"; file: string }
  | { kind: "unresolved" };

/**
 * How the TypeScript compiler resolves imports, with the compiler options of the `tsconfig.json`
 * nearest to each importing file (`allowJs` on, so JavaScript projects resolve too).
 */
export class CompilerResolver {
  private readonly configs = new Map<
    string,
    { options: ts.CompilerOptions; cache: ts.ModuleResolutionCache }
  >();

  constructor(private readonly root: string) {}

  private settings(file: string) {
    const config = ts.findConfigFile(dirname(join(this.root, file)), ts.sys.fileExists) ?? "";
    let s = this.configs.get(config);
    if (!s) {
      let options: ts.CompilerOptions = {
        allowJs: true,
        moduleResolution: ts.ModuleResolutionKind.Bundler,
        module: ts.ModuleKind.ESNext,
      };
      if (config) {
        const parsed = ts.getParsedCommandLineOfConfigFile(
          config,
          {},
          {
            ...ts.sys,
            onUnRecoverableConfigFileDiagnostic: () => undefined,
          },
        );
        if (parsed) options = { ...parsed.options, allowJs: true };
      }
      s = { options, cache: ts.createModuleResolutionCache(this.root, (x) => x, options) };
      this.configs.set(config, s);
    }
    return s;
  }

  resolve(file: string, specifier: string): CompilerResolution {
    const { options, cache } = this.settings(file);
    const r = ts.resolveModuleName(
      specifier,
      join(this.root, file),
      options,
      ts.sys,
      cache,
    ).resolvedModule;
    if (!r) return { kind: "unresolved" };
    const abs = r.resolvedFileName;
    const rel = toPosix(relative(this.root, abs));
    if (
      r.isExternalLibraryImport ||
      rel.split("/").includes("node_modules") ||
      rel.startsWith("..") ||
      isAbsolute(rel)
    )
      return { kind: "external" };
    if (/\.d\.[cm]?ts$/.test(rel)) return { kind: "types-only", file: rel };
    return { kind: "project", file: rel };
  }
}
