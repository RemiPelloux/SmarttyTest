import type { SymbolKind } from "@smarttest/shared";
import { sha256 } from "@smarttest/shared";
import type { FileAnalysis, ImportRecord, SymbolRecord } from "@smarttest/source-parser";
import { LOCALE_PATH, unitOf } from "@smarttest/source-parser";
import ts from "typescript";
import {
  classesOf,
  collectMemberUses,
  type MemberUses,
  moduleScope,
  thisScope,
} from "./member-uses.js";
import { ProcessScripts } from "./processes.js";
import { catalogKeys, collectResources, MODEL_MODULES } from "./resources.js";
import { StaticPathEvaluator } from "./static-path.js";

export const ANALYZER_VERSION = "ts-12";

function scriptKind(path: string): ts.ScriptKind {
  if (path.endsWith(".tsx")) return ts.ScriptKind.TSX;
  if (path.endsWith(".jsx")) return ts.ScriptKind.JSX;
  if (/\.[cm]?js$/.test(path)) return ts.ScriptKind.JS;
  if (path.endsWith(".json")) return ts.ScriptKind.JSON;
  return ts.ScriptKind.TS;
}

const hash = (s: string) => sha256(s).slice(0, 16);

/** Hash of the token stream: identical for comment/whitespace-only edits. */
export function tokenHash(text: string, jsx: boolean): string {
  const sf = ts.createSourceFile(
    jsx ? "t.tsx" : "t.ts",
    text,
    ts.ScriptTarget.Latest,
    true,
    jsx ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  return new TokenHasher(sf, jsx).hash(sf);
}

/**
 * JSX text as React reads it: lines are trimmed, blank lines dropped and the rest joined by a
 * space. Text on a single line is kept as written.
 */
function jsxTextValue(raw: string): string {
  if (!/[\r\n]/.test(raw)) return raw;
  const lines = raw.split(/\r\n|\n|\r/);
  const out: string[] = [];
  lines.forEach((line, i) => {
    let l = line;
    if (i > 0) l = l.replace(/^[ \t]+/, "");
    if (i < lines.length - 1) l = l.replace(/[ \t]+$/, "");
    if (l) out.push(l);
  });
  return out.join(" ");
}

const scanners = new Map<boolean, ts.Scanner>();
const SEP = "\u0001";

/** JSX nodes made of other nodes: hashed as markers around their parts. */
const JSX_STRUCTURE = new Set([
  ts.SyntaxKind.JsxElement,
  ts.SyntaxKind.JsxSelfClosingElement,
  ts.SyntaxKind.JsxFragment,
  ts.SyntaxKind.JsxOpeningElement,
  ts.SyntaxKind.JsxClosingElement,
  ts.SyntaxKind.JsxOpeningFragment,
  ts.SyntaxKind.JsxClosingFragment,
  ts.SyntaxKind.JsxAttributes,
  ts.SyntaxKind.JsxAttribute,
  ts.SyntaxKind.JsxSpreadAttribute,
  ts.SyntaxKind.JsxExpression,
]);

/**
 * Token hashes of the nodes of one file: identical for comment- and whitespace-only edits.
 *
 * Tokens are read the way the parser reads them: the text after `}` in `${a}, ${b}` is template
 * text, `/a//b/` is a regular expression (not a comment), and JSX text is text (the scanner alone
 * would read `<p>http://x</p>` as code and a comment), so an edit inside them is never mistaken for
 * formatting.
 */
class TokenHasher {
  /** Positions of the `}` that resumes a template's text. */
  private readonly templateParts = new Set<number>();
  /** Positions of regular expression literals. */
  private readonly regexps = new Set<number>();
  /** JSX elements and fragments, by position. */
  private readonly jsxAt = new Map<number, ts.Node>();

  constructor(
    private readonly sf: ts.SourceFile,
    private readonly jsx: boolean,
  ) {
    const visit = (n: ts.Node): void => {
      if (ts.isTemplateSpan(n)) this.templateParts.add(n.literal.getStart(sf));
      else if (ts.isRegularExpressionLiteral(n)) this.regexps.add(n.getStart(sf));
      else if (ts.isJsxElement(n) || ts.isJsxSelfClosingElement(n) || ts.isJsxFragment(n))
        this.jsxAt.set(n.getStart(sf), n);
      ts.forEachChild(n, visit);
    };
    visit(sf);
  }

  /** Hash of a node's tokens; `skip` nodes (method bodies) count as `{}`. */
  hash(node: ts.Node, skip?: ReadonlySet<ts.Node>): string {
    const skipAt = new Map<number, number>();
    for (const b of skip ?? []) skipAt.set(b.getStart(this.sf), b.getEnd());
    return hash(this.scan(node.getStart(this.sf), node.getEnd(), skipAt));
  }

  private scanner(): ts.Scanner {
    let scanner = scanners.get(this.jsx);
    if (!scanner) {
      scanner = ts.createScanner(
        ts.ScriptTarget.Latest,
        true,
        this.jsx ? ts.LanguageVariant.JSX : ts.LanguageVariant.Standard,
      );
      scanners.set(this.jsx, scanner);
    }
    return scanner;
  }

  private scan(start: number, end: number, skipAt: ReadonlyMap<number, number>): string {
    const scanner = this.scanner();
    let acc = "";
    let pos = start;
    let guard = 0;
    // The scanner is shared: JSX parts scan their own ranges, so it is set up again after them.
    scanner.setText(this.sf.text, pos, end - pos);
    let token = scanner.scan();
    while (token !== ts.SyntaxKind.EndOfFileToken && guard++ < 1_000_000) {
      const at = scanner.getTokenStart();
      const skipEnd = skipAt.get(at);
      const jsx = this.jsxAt.get(at);
      if (skipEnd !== undefined || jsx) {
        if (skipEnd !== undefined) acc += `{${SEP}}${SEP}`;
        else acc += this.jsxTokens(jsx as ts.Node, skipAt);
        pos = skipEnd ?? (jsx as ts.Node).getEnd();
        scanner.setText(this.sf.text, pos, end - pos);
        token = scanner.scan();
        continue;
      }
      if (token === ts.SyntaxKind.CloseBraceToken && this.templateParts.has(at))
        scanner.reScanTemplateToken(false);
      else if (
        (token === ts.SyntaxKind.SlashToken || token === ts.SyntaxKind.SlashEqualsToken) &&
        this.regexps.has(at)
      )
        scanner.reScanSlashToken();
      acc += `${scanner.getTokenText()}${SEP}`;
      token = scanner.scan();
    }
    scanner.setText(undefined);
    return acc;
  }

  /** JSX: markers around its structure, its text as React reads it, the code inside scanned. */
  private jsxTokens(node: ts.Node, skipAt: ReadonlyMap<number, number>): string {
    let acc = "";
    const walk = (n: ts.Node): void => {
      if (ts.isJsxText(n)) {
        const text = jsxTextValue(n.getText(this.sf));
        if (text) acc += `${text}${SEP}`;
        return;
      }
      if (JSX_STRUCTURE.has(n.kind)) {
        acc += `<${n.kind}${SEP}`;
        ts.forEachChild(n, walk);
        acc += `>${n.kind}${SEP}`;
        return;
      }
      acc += this.scan(n.getStart(this.sf), n.getEnd(), skipAt);
    };
    walk(node);
    return acc;
  }
}

function hasModifier(node: ts.Node, kind: ts.SyntaxKind): boolean {
  const mods = ts.canHaveModifiers(node) ? ts.getModifiers(node) : undefined;
  return !!mods?.some((m) => m.kind === kind);
}

function decoratorsOf(node: ts.Node, sf: ts.SourceFile): string[] {
  const decs = ts.canHaveDecorators(node) ? ts.getDecorators(node) : undefined;
  return (decs ?? []).map((d) => d.expression.getText(sf).replace(/\(.*$/s, ""));
}

function collectRefs(node: ts.Node, out: Set<string>): void {
  const visit = (n: ts.Node): void => {
    if (ts.isIdentifier(n)) {
      const p = n.parent;
      // skip "b" in "a.b", property names in object literals / declarations
      if (p && ts.isPropertyAccessExpression(p) && p.name === n) return;
      if (p && ts.isPropertyAssignment(p) && p.name === n) return;
      if (
        p &&
        (ts.isMethodDeclaration(p) ||
          ts.isPropertyDeclaration(p) ||
          ts.isPropertySignature(p) ||
          ts.isMethodSignature(p)) &&
        p.name === n
      )
        return;
      out.add(n.text);
      return;
    }
    if (ts.isJsxOpeningLikeElement(n) || ts.isJsxClosingElement(n)) {
      const tag = n.tagName;
      if (ts.isIdentifier(tag)) out.add(tag.text);
    }
    ts.forEachChild(n, visit);
  };
  visit(node);
}

/** `vi.*` / `jest.*` calls that name a module. */
const MOCK_CALLS = new Set([
  "mock",
  "doMock",
  "unmock",
  "doUnmock",
  "dontMock",
  "deepUnmock",
  "requireActual",
  "importActual",
  "requireMock",
  "importMock",
]);

/** Globals a mock factory may call without reaching the module it replaces. */
const INERT_GLOBALS = new Set([
  "Array",
  "Boolean",
  "Date",
  "Error",
  "JSON",
  "Map",
  "Math",
  "Number",
  "Object",
  "Promise",
  "RangeError",
  "Set",
  "String",
  "Symbol",
  "TypeError",
  "WeakMap",
  "WeakSet",
  "structuredClone",
]);

/** The identifier a call chain starts from: `vi` in `vi.fn().mockReturnValue(1)`. */
function chainRoot(e: ts.Expression): ts.Expression {
  let cur = e;
  for (;;) {
    if (ts.isPropertyAccessExpression(cur) || ts.isElementAccessExpression(cur))
      cur = cur.expression;
    else if (ts.isCallExpression(cur) || ts.isNonNullExpression(cur)) cur = cur.expression;
    else if (ts.isParenthesizedExpression(cur) || ts.isAsExpression(cur)) cur = cur.expression;
    else return cur;
  }
}

const REAL_MODULE_CALLS =
  /^(require|requireActual|importActual|importOriginal|requireMock|importMock)$/;

/**
 * Whether code may load a real module: an import or require, `importActual`-like calls, or a call
 * to anything other than the mocking API (`vi.fn()`…), builtins, names declared inside the code
 * itself, or `safe` names (top-level `vi.fn()` / `vi.hoisted(…)` values). A helper could reach the
 * real module, so any other call counts.
 */
function mayLoadModules(root: ts.Node, safe: ReadonlySet<string>): boolean {
  const local = new Set<string>();
  const declare = (n: ts.Node): void => {
    if (
      (ts.isVariableDeclaration(n) ||
        ts.isParameter(n) ||
        ts.isFunctionDeclaration(n) ||
        ts.isBindingElement(n)) &&
      n.name &&
      ts.isIdentifier(n.name)
    )
      local.add(n.name.text);
    ts.forEachChild(n, declare);
  };
  declare(root);
  let found = false;
  const visit = (n: ts.Node): void => {
    if (found) return;
    if (ts.isCallExpression(n) || ts.isNewExpression(n)) {
      const callee = n.expression;
      if (callee.kind === ts.SyntaxKind.ImportKeyword) {
        found = true;
        return;
      }
      for (let c: ts.Expression = callee; ; ) {
        const name = ts.isPropertyAccessExpression(c)
          ? c.name.text
          : ts.isIdentifier(c)
            ? c.text
            : undefined;
        if (name && REAL_MODULE_CALLS.test(name)) {
          found = true;
          return;
        }
        if (ts.isPropertyAccessExpression(c) || ts.isCallExpression(c)) c = c.expression;
        else break;
      }
      const r = chainRoot(callee);
      const ok =
        ts.isIdentifier(r) &&
        (["vi", "jest"].includes(r.text) ||
          INERT_GLOBALS.has(r.text) ||
          local.has(r.text) ||
          safe.has(r.text));
      if (!ok) {
        found = true;
        return;
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(root);
  return found;
}

/**
 * How a `vi.*` / `jest.*` call treats the module it names.
 * "factory": the module is replaced by a factory that never loads it; "actual": the real module is
 * loaded (requireActual, importActual, a factory taking `importOriginal`, or one calling code that
 * could); "auto": automock, spy options, or a mock that does not cover the file's static imports
 * (`doMock` is not hoisted, a `mock` call nested in a block runs after them); "unmock".
 */
function mockKind(
  name: string,
  second: ts.Expression | undefined,
  hoisted: boolean,
  safe: ReadonlySet<string>,
): "factory" | "auto" | "actual" | "unmock" {
  if (name === "requireActual" || name === "importActual") return "actual";
  if (name === "unmock" || name === "doUnmock" || name === "dontMock" || name === "deepUnmock")
    return "unmock";
  if (name !== "mock" || !hoisted || !second) return "auto";
  if (ts.isArrowFunction(second) || ts.isFunctionExpression(second)) {
    if (second.parameters.length) return "actual";
    return mayLoadModules(second.body, safe) ? "actual" : "factory";
  }
  return "auto";
}

function range(node: ts.Node, sf: ts.SourceFile) {
  const start = sf.getLineAndCharacterOfPosition(node.getStart(sf));
  const end = sf.getLineAndCharacterOfPosition(node.getEnd());
  return {
    start: { line: start.line, column: start.character },
    end: { line: end.line, column: end.character },
  };
}

const norm = (s: string) => s.replace(/\s+/g, " ").trim();

function functionSignature(node: ts.SignatureDeclarationBase, sf: ts.SourceFile): string {
  const params = node.parameters.map((p) => norm(p.getText(sf))).join(", ");
  const ret = node.type ? `: ${norm(node.type.getText(sf))}` : "";
  const tps = node.typeParameters
    ? `<${node.typeParameters.map((t) => norm(t.getText(sf))).join(", ")}>`
    : "";
  return `${tps}(${params})${ret}`;
}

/** Token hash of a class with method, accessor and constructor bodies removed. */
function classShellHash(cls: ts.ClassDeclaration, tokens: TokenHasher): string {
  const bodies = new Set<ts.Node>();
  for (const m of cls.members)
    if (
      (ts.isMethodDeclaration(m) ||
        ts.isGetAccessorDeclaration(m) ||
        ts.isSetAccessorDeclaration(m) ||
        ts.isConstructorDeclaration(m)) &&
      m.body
    )
      bodies.add(m.body);
  return tokens.hash(cls, bodies);
}

/**
 * Whether evaluating `e` while the module loads cannot run user code or throw: literals, function
 * and arrow expressions, object and array literals of those, and names bound before (imports,
 * hoisted functions, earlier declarations). Anything else (a call, `new`, a getter read through a
 * property access, a template that converts a value, a spread) may run code. When unsure: false.
 */
function isInert(e: ts.Expression | undefined, bound: ReadonlySet<string>): boolean {
  if (!e) return true;
  if (
    ts.isParenthesizedExpression(e) ||
    ts.isAsExpression(e) ||
    ts.isSatisfiesExpression(e) ||
    ts.isTypeAssertionExpression(e) ||
    ts.isNonNullExpression(e)
  )
    return isInert(e.expression, bound);
  if (
    ts.isStringLiteral(e) ||
    ts.isNumericLiteral(e) ||
    ts.isBigIntLiteral(e) ||
    ts.isNoSubstitutionTemplateLiteral(e) ||
    ts.isRegularExpressionLiteral(e) ||
    ts.isArrowFunction(e) ||
    ts.isFunctionExpression(e)
  )
    return true;
  switch (e.kind) {
    case ts.SyntaxKind.TrueKeyword:
    case ts.SyntaxKind.FalseKeyword:
    case ts.SyntaxKind.NullKeyword:
      return true;
  }
  if (ts.isIdentifier(e)) return e.text === "undefined" || bound.has(e.text);
  if (ts.isPrefixUnaryExpression(e))
    return ts.isNumericLiteral(e.operand) || ts.isBigIntLiteral(e.operand);
  if (ts.isVoidExpression(e)) return isInert(e.expression, bound);
  if (ts.isArrayLiteralExpression(e))
    return e.elements.every(
      (el) => ts.isOmittedExpression(el) || (!ts.isSpreadElement(el) && isInert(el, bound)),
    );
  if (ts.isObjectLiteralExpression(e))
    return e.properties.every((p) => {
      if (p.name && ts.isComputedPropertyName(p.name) && !isInert(p.name.expression, bound))
        return false;
      if (ts.isPropertyAssignment(p)) return isInert(p.initializer, bound);
      if (ts.isShorthandPropertyAssignment(p))
        return !p.objectAssignmentInitializer && bound.has(p.name.text);
      return (
        ts.isMethodDeclaration(p) ||
        ts.isGetAccessorDeclaration(p) ||
        ts.isSetAccessorDeclaration(p)
      );
    });
  if (ts.isClassExpression(e)) return !classRunsCode(e, bound);
  return false;
}

/**
 * Whether defining the class runs user code: decorators, static blocks, static field initializers
 * and computed member names that are not inert, or a heritage clause that is not a plain name.
 */
function classRunsCode(cls: ts.ClassLikeDeclaration, bound: ReadonlySet<string>): boolean {
  if (ts.getDecorators(cls)?.length) return true;
  for (const h of cls.heritageClauses ?? [])
    if (h.token === ts.SyntaxKind.ExtendsKeyword)
      for (const t of h.types)
        if (!ts.isIdentifier(t.expression) && !ts.isPropertyAccessExpression(t.expression))
          return true;
  for (const m of cls.members) {
    if (ts.isClassStaticBlockDeclaration(m)) return true;
    if (ts.canHaveDecorators(m) && ts.getDecorators(m)?.length) return true;
    for (const p of ts.isMethodDeclaration(m) || ts.isConstructorDeclaration(m) ? m.parameters : [])
      if (ts.getDecorators(p)?.length) return true;
    if (m.name && ts.isComputedPropertyName(m.name) && !isInert(m.name.expression, bound))
      return true;
    if (
      ts.isPropertyDeclaration(m) &&
      hasModifier(m, ts.SyntaxKind.StaticKeyword) &&
      !isInert(m.initializer, bound)
    )
      return true;
  }
  return false;
}

/** Whether a namespace body or an enum runs user code when the module loads. */
function declarationRunsCode(stmt: ts.Statement, bound: ReadonlySet<string>): boolean {
  if (hasModifier(stmt, ts.SyntaxKind.DeclareKeyword)) return false;
  if (ts.isEnumDeclaration(stmt))
    return stmt.members.some(
      (m) =>
        !!m.initializer &&
        !ts.isStringLiteral(m.initializer) &&
        !ts.isNumericLiteral(m.initializer) &&
        !(ts.isPrefixUnaryExpression(m.initializer) && ts.isNumericLiteral(m.initializer.operand)),
    );
  if (ts.isModuleDeclaration(stmt)) {
    const body = stmt.body;
    if (!body) return false;
    if (ts.isModuleDeclaration(body)) return declarationRunsCode(body as ts.Statement, bound);
    if (!ts.isModuleBlock(body)) return true;
    return body.statements.some(
      (s) =>
        !ts.isInterfaceDeclaration(s) &&
        !ts.isTypeAliasDeclaration(s) &&
        !(ts.isFunctionDeclaration(s) && !!s.body) &&
        !(ts.isModuleDeclaration(s) && !declarationRunsCode(s, bound)),
    );
  }
  return true;
}

export function analyzeSource(path: string, content: string): FileAnalysis {
  const kind = scriptKind(path);
  const sf = ts.createSourceFile(path, content, ts.ScriptTarget.Latest, true, kind);
  const tokens = new TokenHasher(sf, kind === ts.ScriptKind.TSX || kind === ts.ScriptKind.JSX);
  // Resource reads (env, models, translations) are only looked for when the text can contain one.
  const scanResources =
    /process\.env|import\.meta\.env|\.entities\.|\bprisma\b|\bdb\.|(?:^|[^\w$.])\$?t[(),]|\.t\b|translate\(|i18n|useTranslation|withTranslation|getFixedT|\.goto\(|\.visit\(|request\./.test(
      content,
    );
  const language =
    kind === ts.ScriptKind.JS || kind === ts.ScriptKind.JSX ? "javascript" : "typescript";
  const imports: ImportRecord[] = [];
  const symbols: SymbolRecord[] = [];
  const localExports: { exported: string; local: string }[] = [];
  const topRefs = new Set<string>();
  const topTokens: string[] = [];
  const dynamicUnresolved: string[] = [];
  const dynamicHints: { pattern: string; line: number; expr: string }[] = [];
  const assetLines: { pattern: string; line: number }[] = [];
  const pathEval = new StaticPathEvaluator(sf, path);
  const modScope = moduleScope(sf);
  const topUses = new Set<string>();
  const topEscapes = new Set<string>();
  const topResources = new Set<string>();
  let esm = false;
  let cjs = false;
  const lineOf = (n: ts.Node) => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line;

  const addSymbol = (
    node: ts.Node,
    name: string,
    kindOf: SymbolKind,
    opts: {
      exportNames?: string[];
      parent?: string;
      signature?: string;
      visibility?: SymbolRecord["visibility"];
      heritage?: { extends?: string; implements?: string[] };
      thisTypes?: Map<string, string[]>;
      memberUses?: MemberUses;
      /** Classes: only these parts (decorators) count for refs and resources; members carry theirs. */
      shell?: ts.Node[];
    },
  ): SymbolRecord => {
    const qualifiedName = opts.parent ? `${opts.parent}.${name}` : name;
    const text = node.getText(sf);
    const refs = new Set<string>();
    for (const n of opts.shell ?? [node]) collectRefs(n, refs);
    refs.delete(name);
    const rec: SymbolRecord = {
      id: `${path}#${qualifiedName}`,
      name,
      qualifiedName,
      kind: kindOf,
      exportNames: opts.exportNames ?? [],
      range: range(node, sf),
      signature: opts.signature ?? "",
      tokenHash: tokens.hash(node),
      textHash: hash(text),
      refs: [...refs].sort(),
      decorators: decoratorsOf(node, sf),
    };
    if (opts.parent) rec.parent = opts.parent;
    if (opts.visibility) rec.visibility = opts.visibility;
    if (opts.heritage?.extends) rec.extends = opts.heritage.extends;
    if (opts.heritage?.implements?.length) rec.implements = opts.heritage.implements;
    const mu = opts.memberUses ?? collectMemberUses(node, modScope, opts.thisTypes);
    if (mu.uses.length) rec.uses = mu.uses;
    if (mu.escapes.length) rec.escapes = mu.escapes.filter((e) => e !== name || !!opts.parent);
    if (mu.thisUses.length) rec.thisUses = mu.thisUses;
    if (mu.superUses.length) rec.superUses = mu.superUses;
    if (mu.thisEscapes && opts.parent) rec.thisEscapes = true;
    if (scanResources) {
      const res = [...new Set((opts.shell ?? [node]).flatMap((n) => collectResources(n)))].sort();
      if (res.length) rec.resources = res;
    }
    symbols.push(rec);
    return rec;
  };

  /** `module.exports = …`, `module.exports.x = …`, `exports.x = …` become exports, not module code. */
  const handleCommonJsExport = (stmt: ts.Statement): boolean => {
    if (!ts.isExpressionStatement(stmt)) return false;
    const e = stmt.expression;
    if (!ts.isBinaryExpression(e) || e.operatorToken.kind !== ts.SyntaxKind.EqualsToken)
      return false;
    const left = e.left;
    const right = e.right;
    const isModuleExports = (n: ts.Expression) =>
      ts.isPropertyAccessExpression(n) &&
      ts.isIdentifier(n.expression) &&
      n.expression.text === "module" &&
      n.name.text === "exports";
    const kindOf = (v: ts.Expression): SymbolKind =>
      ts.isArrowFunction(v) || ts.isFunctionExpression(v)
        ? "function"
        : ts.isClassExpression(v)
          ? "class"
          : "property";
    if (isModuleExports(left)) {
      if (ts.isObjectLiteralExpression(right)) {
        for (const p of right.properties) {
          if (ts.isShorthandPropertyAssignment(p))
            localExports.push({ exported: p.name.text, local: p.name.text });
          else if (
            ts.isPropertyAssignment(p) &&
            ts.isIdentifier(p.initializer) &&
            (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name))
          )
            localExports.push({ exported: p.name.text, local: p.initializer.text });
          else if (
            (ts.isPropertyAssignment(p) || ts.isMethodDeclaration(p)) &&
            (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name))
          ) {
            const k = ts.isMethodDeclaration(p)
              ? "function"
              : kindOf((p as ts.PropertyAssignment).initializer);
            const rec = addSymbol(p, p.name.text, k, { exportNames: [p.name.text] });
            if (ts.isPropertyAssignment(p) && !isInert(p.initializer, bound)) evaluates(rec, p);
          } else return false; // spread or computed keys: keep as module code (whole file)
        }
        return true;
      }
      if (ts.isIdentifier(right)) {
        localExports.push({ exported: "default", local: right.text });
        return true;
      }
      const rec = addSymbol(stmt, "default", kindOf(right), { exportNames: ["default"] });
      if (!isInert(right, bound)) evaluates(rec, stmt);
      return true;
    }
    const target =
      ts.isPropertyAccessExpression(left) &&
      (isModuleExports(left.expression) ||
        (ts.isIdentifier(left.expression) && left.expression.text === "exports"))
        ? left.name.text
        : undefined;
    if (!target) return false;
    if (ts.isIdentifier(right)) localExports.push({ exported: target, local: right.text });
    else {
      const rec = addSymbol(stmt, target, kindOf(right), { exportNames: [target] });
      if (!isInert(right, bound)) evaluates(rec, stmt);
    }
    return true;
  };

  const exportNamesFor = (node: ts.Node, name: string): string[] => {
    if (!hasModifier(node, ts.SyntaxKind.ExportKeyword)) return [];
    return hasModifier(node, ts.SyntaxKind.DefaultKeyword) ? ["default"] : [name];
  };

  // Names an initializer can read without running code or hitting the temporal dead zone: imports
  // and hoisted functions, then each declaration once it has been evaluated.
  const bound = new Set<string>();
  for (const stmt of sf.statements) {
    if (ts.isFunctionDeclaration(stmt) && stmt.name) bound.add(stmt.name.text);
    else if (ts.isImportEqualsDeclaration(stmt)) bound.add(stmt.name.text);
    else if (ts.isImportDeclaration(stmt) && stmt.importClause) {
      const c = stmt.importClause;
      if (c.name) bound.add(c.name.text);
      if (c.namedBindings && ts.isNamespaceImport(c.namedBindings))
        bound.add(c.namedBindings.name.text);
      else if (c.namedBindings) for (const el of c.namedBindings.elements) bound.add(el.name.text);
    }
  }
  /** Records the module-evaluation code of a declaration (see `SymbolRecord.evalHash`). */
  const evaluates = (rec: SymbolRecord, node: ts.Node) => {
    rec.evalHash = tokens.hash(node);
  };

  for (const stmt of sf.statements) {
    if (ts.isImportDeclaration(stmt)) {
      esm = true;
      const spec = (stmt.moduleSpecifier as ts.StringLiteral).text;
      const clause = stmt.importClause;
      if (!clause) {
        imports.push({
          specifier: spec,
          kind: "side-effect",
          bindings: [],
          typeOnly: false,
          line: lineOf(stmt),
        });
        continue;
      }
      const bindings: { imported: string; local: string }[] = [];
      let namespace = false;
      let allTypeOnly = clause.isTypeOnly;
      if (clause.name) bindings.push({ imported: "default", local: clause.name.text });
      const nb = clause.namedBindings;
      if (nb && ts.isNamespaceImport(nb)) {
        namespace = true;
        bindings.push({ imported: "*", local: nb.name.text });
      } else if (nb && ts.isNamedImports(nb)) {
        const elements = nb.elements;
        if (!clause.isTypeOnly && elements.length && !clause.name)
          allTypeOnly = elements.every((e) => e.isTypeOnly);
        for (const el of elements)
          bindings.push({ imported: (el.propertyName ?? el.name).text, local: el.name.text });
      }
      imports.push({
        specifier: spec,
        kind: namespace ? "namespace" : "named",
        bindings,
        typeOnly: allTypeOnly,
        line: lineOf(stmt),
      });
      continue;
    }
    if (ts.isImportEqualsDeclaration(stmt) && ts.isExternalModuleReference(stmt.moduleReference)) {
      const expr = stmt.moduleReference.expression;
      if (ts.isStringLiteral(expr)) {
        imports.push({
          specifier: expr.text,
          kind: "require",
          bindings: [{ imported: "*", local: stmt.name.text }],
          typeOnly: stmt.isTypeOnly,
          line: lineOf(stmt),
        });
      }
      continue;
    }
    if (ts.isExportDeclaration(stmt)) {
      esm = true;
      if (stmt.moduleSpecifier && ts.isStringLiteral(stmt.moduleSpecifier)) {
        const spec = stmt.moduleSpecifier.text;
        const ec = stmt.exportClause;
        if (!ec)
          imports.push({
            specifier: spec,
            kind: "reexport-all",
            bindings: [],
            typeOnly: stmt.isTypeOnly,
            line: lineOf(stmt),
          });
        else if (ts.isNamespaceExport(ec))
          imports.push({
            specifier: spec,
            kind: "reexport",
            bindings: [{ imported: "*", local: ec.name.text }],
            typeOnly: stmt.isTypeOnly,
            line: lineOf(stmt),
          });
        else
          imports.push({
            specifier: spec,
            kind: "reexport",
            bindings: ec.elements.map((e) => ({
              imported: (e.propertyName ?? e.name).text,
              local: e.name.text,
            })),
            typeOnly: stmt.isTypeOnly,
            line: lineOf(stmt),
          });
      } else if (stmt.exportClause && ts.isNamedExports(stmt.exportClause)) {
        for (const e of stmt.exportClause.elements)
          localExports.push({ exported: e.name.text, local: (e.propertyName ?? e.name).text });
      }
      continue;
    }
    if (ts.isExportAssignment(stmt)) {
      esm = true;
      if (ts.isIdentifier(stmt.expression))
        localExports.push({ exported: "default", local: stmt.expression.text });
      else {
        const rec = addSymbol(
          stmt,
          "default",
          ts.isArrowFunction(stmt.expression) || ts.isFunctionExpression(stmt.expression)
            ? "function"
            : "property",
          { exportNames: ["default"] },
        );
        const inst = classesOf(undefined, stmt.expression);
        if (inst.length) rec.instanceOf = inst;
        if (!isInert(stmt.expression, bound)) evaluates(rec, stmt);
      }
      continue;
    }
    if (ts.isFunctionDeclaration(stmt)) {
      const name = stmt.name?.text ?? "default";
      addSymbol(stmt, name, "function", {
        exportNames: exportNamesFor(stmt, name),
        signature: functionSignature(stmt, sf),
      });
      if (hasModifier(stmt, ts.SyntaxKind.ExportKeyword)) esm = true;
      continue;
    }
    if (ts.isClassDeclaration(stmt)) {
      const name = stmt.name?.text ?? "default";
      let ext: string | undefined;
      const impl: string[] = [];
      for (const h of stmt.heritageClauses ?? []) {
        for (const t of h.types) {
          const text = t.expression.getText(sf);
          if (h.token === ts.SyntaxKind.ExtendsKeyword) ext = text;
          else impl.push(text);
        }
      }
      const heritage = norm((stmt.heritageClauses ?? []).map((h) => h.getText(sf)).join(" "));
      // Class-level dependencies: decorators only. Members carry their own; `extends` is linked
      // by the graph to the base's construction, with inherited members resolved individually.
      const shellParts: ts.Node[] = [...(ts.getDecorators(stmt) ?? [])];
      const shellUses = shellParts.map((n) => collectMemberUses(n, modScope));
      const classRec = addSymbol(stmt, name, "class", {
        exportNames: exportNamesFor(stmt, name),
        signature: `${decoratorsOf(stmt, sf).join(" ")} class ${heritage}`.trim(),
        heritage: { ...(ext ? { extends: ext } : {}), implements: impl },
        shell: shellParts,
        memberUses: {
          uses: [...new Set(shellUses.flatMap((u) => u.uses))],
          escapes: [...new Set(shellUses.flatMap((u) => u.escapes))],
          thisUses: [],
          superUses: [],
        },
      });
      classRec.shellHash = classShellHash(stmt, tokens);
      // Decorators, static initializers and blocks run when the module loads: the class shell
      // (bodies of methods removed) is that code.
      if (classRunsCode(stmt, bound)) classRec.evalHash = classRec.shellHash;
      if (stmt.name) bound.add(stmt.name.text);
      const thisTypes = thisScope(stmt);
      if (hasModifier(stmt, ts.SyntaxKind.ExportKeyword)) esm = true;
      for (const m of stmt.members) {
        let mName: string | undefined;
        let mKind: SymbolKind = "method";
        let sig = "";
        if (ts.isConstructorDeclaration(m)) {
          mName = "constructor";
          sig = functionSignature(m, sf);
        } else if (
          ts.isMethodDeclaration(m) ||
          ts.isGetAccessorDeclaration(m) ||
          ts.isSetAccessorDeclaration(m)
        ) {
          mName = m.name.getText(sf);
          sig = functionSignature(m, sf);
        } else if (ts.isPropertyDeclaration(m)) {
          mName = m.name.getText(sf);
          mKind = "property";
          sig = m.type ? norm(m.type.getText(sf)) : "";
        }
        if (!mName) continue;
        const visibility =
          hasModifier(m, ts.SyntaxKind.PrivateKeyword) || mName.startsWith("#")
            ? "private"
            : hasModifier(m, ts.SyntaxKind.ProtectedKeyword)
              ? "protected"
              : "public";
        const isStatic = hasModifier(m, ts.SyntaxKind.StaticKeyword) ? "static " : "";
        addSymbol(m, mName, mKind, {
          parent: name,
          signature: `${visibility} ${isStatic}${sig}`.trim(),
          visibility,
          thisTypes,
        });
      }
      continue;
    }
    if (
      ts.isInterfaceDeclaration(stmt) ||
      ts.isTypeAliasDeclaration(stmt) ||
      ts.isEnumDeclaration(stmt)
    ) {
      const name = stmt.name.text;
      // An interface's `extends` list is recorded as `implements`: the types it is a subtype of.
      const supers = ts.isInterfaceDeclaration(stmt)
        ? (stmt.heritageClauses ?? []).flatMap((h) => h.types.map((t) => t.expression.getText(sf)))
        : [];
      const rec = addSymbol(stmt, name, ts.isInterfaceDeclaration(stmt) ? "interface" : "type", {
        exportNames: exportNamesFor(stmt, name),
        signature: ts.isEnumDeclaration(stmt) ? "enum" : "",
        heritage: { implements: supers },
      });
      if (ts.isEnumDeclaration(stmt)) {
        if (declarationRunsCode(stmt, bound)) evaluates(rec, stmt);
        bound.add(name);
      }
      if (hasModifier(stmt, ts.SyntaxKind.ExportKeyword)) esm = true;
      continue;
    }
    if (ts.isModuleDeclaration(stmt) && ts.isIdentifier(stmt.name)) {
      const rec = addSymbol(stmt, stmt.name.text, "module", {
        exportNames: exportNamesFor(stmt, stmt.name.text),
      });
      if (declarationRunsCode(stmt, bound)) evaluates(rec, stmt);
      bound.add(stmt.name.text);
      continue;
    }
    if (ts.isVariableStatement(stmt)) {
      const exported = hasModifier(stmt, ts.SyntaxKind.ExportKeyword);
      if (exported) esm = true;
      for (const decl of stmt.declarationList.declarations) {
        const init = decl.initializer;
        // const x = require("./y") / const { a } = require("./y")
        if (
          init &&
          ts.isCallExpression(init) &&
          ts.isIdentifier(init.expression) &&
          init.expression.text === "require"
        ) {
          const arg = init.arguments[0];
          if (arg && ts.isStringLiteralLike(arg)) {
            cjs = true;
            const bindings = ts.isIdentifier(decl.name)
              ? [{ imported: "*", local: decl.name.text }]
              : ts.isObjectBindingPattern(decl.name)
                ? decl.name.elements.map((e) => ({
                    imported: (e.propertyName ?? e.name).getText(sf),
                    local: e.name.getText(sf),
                  }))
                : [];
            imports.push({
              specifier: arg.text,
              kind: "require",
              bindings,
              typeOnly: false,
              line: lineOf(decl),
            });
            for (const b of bindings) bound.add(b.local);
            continue;
          }
        }
        const names: string[] = ts.isIdentifier(decl.name)
          ? [decl.name.text]
          : ts.isObjectBindingPattern(decl.name) || ts.isArrayBindingPattern(decl.name)
            ? decl.name.elements.flatMap((e) =>
                ts.isBindingElement(e) && ts.isIdentifier(e.name) ? [e.name.text] : [],
              )
            : [];
        const symKind: SymbolKind =
          init && (ts.isArrowFunction(init) || ts.isFunctionExpression(init))
            ? "function"
            : init && ts.isClassExpression(init)
              ? "class"
              : "property";
        for (const name of names) {
          const sig =
            init && (ts.isArrowFunction(init) || ts.isFunctionExpression(init))
              ? functionSignature(init, sf)
              : decl.type
                ? norm(decl.type.getText(sf))
                : "";
          const rec = addSymbol(decl, name, symKind, {
            exportNames: exported ? [name] : [],
            signature: sig,
          });
          if (ts.isIdentifier(decl.name)) {
            const inst = classesOf(decl.type, init);
            if (inst.length) rec.instanceOf = inst;
          }
          // Destructuring reads properties (getters) and iterators: only a plain name is inert.
          if (
            !hasModifier(stmt, ts.SyntaxKind.DeclareKeyword) &&
            (!isInert(init, bound) || (!!init && !ts.isIdentifier(decl.name)))
          )
            evaluates(rec, decl);
        }
        for (const name of names) bound.add(name);
      }
      continue;
    }
    // CommonJS exports are declarations, not module-level code.
    if (handleCommonJsExport(stmt)) {
      cjs = true;
      continue;
    }
    // Any other top-level statement: module-level code.
    collectRefs(stmt, topRefs);
    const tu = collectMemberUses(stmt, modScope);
    for (const u of tu.uses) topUses.add(u);
    for (const e of tu.escapes) topEscapes.add(e);
    if (scanResources) for (const r of collectResources(stmt)) topResources.add(r);
    topTokens.push(tokens.hash(stmt));
    const text = stmt.getText(sf);
    if (/\b(?:module\.exports|exports\.[A-Za-z_$])/.test(text)) cjs = true;
  }

  // Top-level values a mock factory may use without loading modules: `const m = vi.fn()`,
  // `const mocks = vi.hoisted(() => ({ … }))`.
  const mockSafe = new Set<string>();
  for (const stmt of sf.statements) {
    if (!ts.isVariableStatement(stmt)) continue;
    for (const d of stmt.declarationList.declarations) {
      const init = d.initializer;
      if (!init || !ts.isCallExpression(init)) continue;
      const r = chainRoot(init.expression);
      if (!ts.isIdentifier(r) || !["vi", "jest"].includes(r.text)) continue;
      if (mayLoadModules(init, mockSafe)) continue;
      const names: string[] = [];
      const collect = (b: ts.BindingName): void => {
        if (ts.isIdentifier(b)) names.push(b.text);
        else for (const el of b.elements) if (ts.isBindingElement(el)) collect(el.name);
      };
      collect(d.name);
      for (const n of names) mockSafe.add(n);
    }
  }

  // Nested require/import()/jest.mock/vi.mock anywhere in the file.
  const seen = new Set(imports.map((i) => `${i.kind}:${i.specifier}:${i.line}`));
  const processes = new ProcessScripts(imports, sf, path, pathEval);
  const visit = (n: ts.Node): void => {
    // Worker and child-process scripts: an edge to the script, or uncertainty.
    if (ts.isCallExpression(n) || ts.isNewExpression(n)) {
      const run = processes.scriptOf(n);
      if (run) {
        const expr = `line ${lineOf(n) + 1}: ${n.getText(sf).slice(0, 80)}`;
        if ("pattern" in run) dynamicHints.push({ pattern: run.pattern, line: lineOf(n), expr });
        else dynamicUnresolved.push(expr);
      }
    }
    if (ts.isCallExpression(n)) {
      const callee = n.expression;
      const arg = n.arguments[0];
      const literal = arg && ts.isStringLiteralLike(arg) ? arg.text : undefined;
      let kind: ImportRecord["kind"] | undefined;
      if (callee.kind === ts.SyntaxKind.ImportKeyword) kind = "dynamic";
      else if (ts.isIdentifier(callee) && callee.text === "require") kind = "require";
      else if (
        ts.isPropertyAccessExpression(callee) &&
        ts.isIdentifier(callee.expression) &&
        ["jest", "vi"].includes(callee.expression.text)
      ) {
        if (MOCK_CALLS.has(callee.name.text)) kind = "mock";
      }
      // Vite's import.meta.glob("./dir/*.ts" | [...]) imports every matching file.
      if (
        ts.isPropertyAccessExpression(callee) &&
        callee.name.text === "glob" &&
        ts.isMetaProperty(callee.expression) &&
        arg
      ) {
        const patterns = ts.isArrayLiteralExpression(arg) ? [...arg.elements] : [arg];
        for (const p of patterns) {
          const expr = `line ${lineOf(n) + 1}: ${n.getText(sf).slice(0, 80)}`;
          if (ts.isStringLiteralLike(p) && !p.text.startsWith("!") && !p.text.startsWith("/"))
            dynamicHints.push({ pattern: p.text.replace(/^\.\//, ""), line: lineOf(n), expr });
          else if (!(ts.isStringLiteralLike(p) && p.text.startsWith("!")))
            dynamicUnresolved.push(expr);
        }
      }
      // fs reads with a path built from the file's location become asset edges
      const calleeName = ts.isIdentifier(callee)
        ? callee.text
        : ts.isPropertyAccessExpression(callee)
          ? callee.name.text
          : "";
      if (
        !kind &&
        arg &&
        [
          "readFile",
          "readFileSync",
          "createReadStream",
          "readJson",
          "readJSON",
          "readJsonSync",
        ].includes(calleeName)
      ) {
        const pattern = pathEval.evaluateAnchored(arg);
        if (pattern) assetLines.push({ pattern, line: lineOf(n) });
      }
      if (kind) {
        if (literal !== undefined) {
          const key = `${kind}:${literal}:${lineOf(n)}`;
          const already = [...seen].some((k) => k.endsWith(`:${literal}:${lineOf(n)}`));
          if (!already) {
            seen.add(key);
            const mockName =
              kind === "mock" && ts.isPropertyAccessExpression(callee) ? callee.name.text : "";
            imports.push({
              specifier: literal,
              kind,
              bindings: [],
              typeOnly: false,
              line: lineOf(n),
              ...(kind === "mock"
                ? {
                    mock: mockKind(
                      mockName,
                      n.arguments[1],
                      ts.isExpressionStatement(n.parent) && ts.isSourceFile(n.parent.parent),
                      mockSafe,
                    ),
                  }
                : {}),
            } as ImportRecord);
          }
          if (kind === "require") cjs = true;
        } else if (kind === "dynamic" || kind === "require") {
          // Try to evaluate computed paths (constants, new URL(…, import.meta.url), resolve(__dirname…)).
          const pattern = arg ? pathEval.evaluate(arg) : undefined;
          const expr = `line ${lineOf(n) + 1}: ${n.getText(sf).slice(0, 80)}`;
          if (pattern) dynamicHints.push({ pattern, line: lineOf(n), expr });
          else dynamicUnresolved.push(expr);
        }
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);

  const parseErrors =
    (sf as unknown as { parseDiagnostics?: unknown[] }).parseDiagnostics?.length ?? 0;

  // Model types imported from the Prisma client / Wasp entities are model resources.
  const modelLocals = new Map<string, string>();
  for (const imp of imports)
    if (MODEL_MODULES.has(imp.specifier))
      for (const b of imp.bindings)
        if (/^[A-Z]/.test(b.imported)) modelLocals.set(b.local, b.imported);
  if (modelLocals.size) {
    const addModels = (refs: readonly string[], into: Set<string>) => {
      for (const r of refs) {
        const m = modelLocals.get(r);
        if (m) into.add(`model:${m}`);
      }
    };
    for (const s of symbols) {
      const res = new Set(s.resources ?? []);
      addModels(s.refs, res);
      if (res.size) s.resources = [...res].sort();
    }
    addModels([...topRefs], topResources);
  }
  // Asset reads are attributed to the innermost declaration around them.
  const assetReads = assetLines.map((h) => {
    let best: SymbolRecord | undefined;
    for (const s of symbols)
      if (s.range.start.line <= h.line && h.line <= s.range.end.line && (!best || s.parent))
        best = s;
    return { pattern: h.pattern, line: h.line, unit: best ? unitOf(best) : "*" };
  });
  const catalog = LOCALE_PATH.test(path) ? catalogKeys(sf, hash) : undefined;
  const importsKey = imports
    .map(
      (i) =>
        `${i.kind}|${i.specifier}|${i.typeOnly}|${i.bindings.map((b) => `${b.imported}>${b.local}`).join(",")}`,
    )
    .sort()
    .join(";");
  return {
    path,
    hash: sha256(content),
    language,
    moduleKind: esm ? "esm" : cjs ? "cjs" : "unknown",
    imports,
    symbols,
    localExports,
    topLevelRefs: [...topRefs].sort(),
    ...(topUses.size ? { topLevelUses: [...topUses].sort() } : {}),
    ...(topEscapes.size ? { topLevelEscapes: [...topEscapes].sort() } : {}),
    ...(topResources.size ? { topLevelResources: [...topResources].sort() } : {}),
    topLevelHash: hash(topTokens.join("|")),
    importsHash: hash(importsKey),
    dynamicUnresolved,
    ...(dynamicHints.length ? { dynamicHints } : {}),
    ...(assetReads.length ? { assetReads } : {}),
    ...(catalog ? { catalogKeys: catalog } : {}),
    parseErrors,
    analyzerVersion: ANALYZER_VERSION,
  };
}
