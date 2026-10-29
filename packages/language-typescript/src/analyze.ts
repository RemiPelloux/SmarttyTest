import type { SymbolKind } from "@smarttest/shared";
import { sha256 } from "@smarttest/shared";
import type { FileAnalysis, ImportRecord, SymbolRecord } from "@smarttest/source-parser";
import ts from "typescript";
import { StaticPathEvaluator } from "./static-path.js";

export const ANALYZER_VERSION = "ts-2";

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
  const scanner = ts.createScanner(
    ts.ScriptTarget.Latest,
    true,
    jsx ? ts.LanguageVariant.JSX : ts.LanguageVariant.Standard,
    text,
  );
  const parts: string[] = [];
  let token = scanner.scan();
  let guard = 0;
  while (token !== ts.SyntaxKind.EndOfFileToken && guard++ < 1_000_000) {
    parts.push(scanner.getTokenText());
    token = scanner.scan();
  }
  return hash(parts.join("\u0001"));
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

export function analyzeSource(path: string, content: string): FileAnalysis {
  const kind = scriptKind(path);
  const sf = ts.createSourceFile(path, content, ts.ScriptTarget.Latest, true, kind);
  const jsx = kind === ts.ScriptKind.TSX || kind === ts.ScriptKind.JSX;
  const language =
    kind === ts.ScriptKind.JS || kind === ts.ScriptKind.JSX ? "javascript" : "typescript";
  const imports: ImportRecord[] = [];
  const symbols: SymbolRecord[] = [];
  const localExports: { exported: string; local: string }[] = [];
  const topRefs = new Set<string>();
  const topTokens: string[] = [];
  const dynamicUnresolved: string[] = [];
  const dynamicHints: { pattern: string; line: number; expr: string }[] = [];
  const pathEval = new StaticPathEvaluator(sf, path);
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
    },
  ): SymbolRecord => {
    const qualifiedName = opts.parent ? `${opts.parent}.${name}` : name;
    const text = node.getText(sf);
    const refs = new Set<string>();
    collectRefs(node, refs);
    refs.delete(name);
    const rec: SymbolRecord = {
      id: `${path}#${qualifiedName}`,
      name,
      qualifiedName,
      kind: kindOf,
      exportNames: opts.exportNames ?? [],
      range: range(node, sf),
      signature: opts.signature ?? "",
      tokenHash: tokenHash(text, jsx),
      textHash: hash(text),
      refs: [...refs].sort(),
      decorators: decoratorsOf(node, sf),
    };
    if (opts.parent) rec.parent = opts.parent;
    if (opts.visibility) rec.visibility = opts.visibility;
    if (opts.heritage?.extends) rec.extends = opts.heritage.extends;
    if (opts.heritage?.implements?.length) rec.implements = opts.heritage.implements;
    symbols.push(rec);
    return rec;
  };

  const exportNamesFor = (node: ts.Node, name: string): string[] => {
    if (!hasModifier(node, ts.SyntaxKind.ExportKeyword)) return [];
    return hasModifier(node, ts.SyntaxKind.DefaultKeyword) ? ["default"] : [name];
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
      else
        addSymbol(
          stmt,
          "default",
          ts.isArrowFunction(stmt.expression) || ts.isFunctionExpression(stmt.expression)
            ? "function"
            : "property",
          { exportNames: ["default"] },
        );
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
      addSymbol(stmt, name, "class", {
        exportNames: exportNamesFor(stmt, name),
        signature: `${decoratorsOf(stmt, sf).join(" ")} class ${heritage}`.trim(),
        heritage: { ...(ext ? { extends: ext } : {}), implements: impl },
      });
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
      addSymbol(stmt, name, ts.isInterfaceDeclaration(stmt) ? "interface" : "type", {
        exportNames: exportNamesFor(stmt, name),
        signature: ts.isEnumDeclaration(stmt) ? "enum" : "",
      });
      if (hasModifier(stmt, ts.SyntaxKind.ExportKeyword)) esm = true;
      continue;
    }
    if (ts.isModuleDeclaration(stmt) && ts.isIdentifier(stmt.name)) {
      addSymbol(stmt, stmt.name.text, "module", {
        exportNames: exportNamesFor(stmt, stmt.name.text),
      });
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
          addSymbol(decl, name, symKind, { exportNames: exported ? [name] : [], signature: sig });
        }
      }
      continue;
    }
    // Any other top-level statement: module-level code.
    collectRefs(stmt, topRefs);
    topTokens.push(tokenHash(stmt.getText(sf), jsx));
    const text = stmt.getText(sf);
    if (/\b(?:module\.exports|exports\.[A-Za-z_$])/.test(text)) cjs = true;
  }

  // Nested require/import()/jest.mock/vi.mock anywhere in the file.
  const seen = new Set(imports.map((i) => `${i.kind}:${i.specifier}:${i.line}`));
  const visit = (n: ts.Node): void => {
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
        if (
          ["mock", "doMock", "requireActual", "importActual", "unmock"].includes(callee.name.text)
        )
          kind = "mock";
      }
      if (kind) {
        if (literal !== undefined) {
          const key = `${kind}:${literal}:${lineOf(n)}`;
          const already = [...seen].some((k) => k.endsWith(`:${literal}:${lineOf(n)}`));
          if (!already) {
            seen.add(key);
            imports.push({
              specifier: literal,
              kind,
              bindings: [],
              typeOnly: false,
              line: lineOf(n),
            });
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
    topLevelHash: hash(topTokens.join("|")),
    importsHash: hash(importsKey),
    dynamicUnresolved,
    ...(dynamicHints.length ? { dynamicHints } : {}),
    parseErrors,
    analyzerVersion: ANALYZER_VERSION,
  };
}
