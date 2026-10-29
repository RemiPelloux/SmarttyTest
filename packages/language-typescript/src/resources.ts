import ts from "typescript";

/**
 * Non-code resources a declaration reads:
 *   env:NAME     process.env.NAME, process.env["NAME"], import.meta.env.NAME, destructuring
 *   env:*        process.env used dynamically (any key)
 *   model:Name   Wasp `context.entities.Name`, Prisma `prisma.name` / `db.name` (incl. this.prisma)
 *   i18n:key     t("key"), i18n.t("key"), $t("key"), translate("key"), <Trans i18nKey="key">
 */
export function collectResources(root: ts.Node): string[] {
  const out = new Set<string>();
  const isProcessEnv = (e: ts.Expression) =>
    ts.isPropertyAccessExpression(e) &&
    e.name.text === "env" &&
    ((ts.isIdentifier(e.expression) && e.expression.text === "process") ||
      (ts.isMetaProperty(e.expression) && e.expression.name.text === "meta"));
  const PRISMA_ROOTS = new Set(["prisma", "db"]);
  const visit = (n: ts.Node): void => {
    if (ts.isPropertyAccessExpression(n)) {
      if (isProcessEnv(n.expression)) out.add(`env:${n.name.text}`);
      const obj = n.expression;
      if (
        ts.isPropertyAccessExpression(obj) &&
        obj.name.text === "entities" &&
        /^[A-Z]/.test(n.name.text)
      )
        out.add(`model:${n.name.text}`);
      const rootName = ts.isIdentifier(obj)
        ? obj.text
        : ts.isPropertyAccessExpression(obj) && obj.expression.kind === ts.SyntaxKind.ThisKeyword
          ? obj.name.text
          : undefined;
      if (rootName && PRISMA_ROOTS.has(rootName) && /^[a-z]/.test(n.name.text))
        out.add(`model:${n.name.text[0]?.toUpperCase()}${n.name.text.slice(1)}`);
    } else if (ts.isElementAccessExpression(n) && isProcessEnv(n.expression)) {
      out.add(
        ts.isStringLiteralLike(n.argumentExpression) ? `env:${n.argumentExpression.text}` : "env:*",
      );
    } else if (
      ts.isVariableDeclaration(n) &&
      n.initializer &&
      isProcessEnv(n.initializer as ts.Expression) &&
      ts.isObjectBindingPattern(n.name)
    ) {
      for (const el of n.name.elements) {
        if (el.dotDotDotToken) out.add("env:*");
        else out.add(`env:${(el.propertyName ?? el.name).getText()}`);
      }
    } else if (ts.isCallExpression(n)) {
      const c = n.expression;
      const name = ts.isIdentifier(c)
        ? c.text
        : ts.isPropertyAccessExpression(c)
          ? c.name.text
          : "";
      const arg = n.arguments[0];
      if (["t", "$t", "translate"].includes(name) && arg) {
        if (ts.isStringLiteralLike(arg)) out.add(`i18n:${arg.text}`);
        else if (ts.isTemplateExpression(arg)) out.add(`i18n:${arg.head.text}*`);
        else out.add("i18n:*");
      }
    } else if (
      ts.isJsxAttribute(n) &&
      n.name.getText() === "i18nKey" &&
      n.initializer &&
      ts.isStringLiteral(n.initializer)
    ) {
      out.add(`i18n:${n.initializer.text}`);
    } else if (
      ts.isIdentifier(n) &&
      n.text === "process" &&
      n.parent &&
      ts.isPropertyAccessExpression(n.parent) &&
      n.parent.name.text === "env"
    ) {
      // `process.env` passed or spread as a whole: any key
      const pa = n.parent;
      const p = pa.parent;
      const usedWhole =
        !(ts.isPropertyAccessExpression(p) && p.expression === pa) &&
        !(ts.isElementAccessExpression(p) && p.expression === pa) &&
        !(ts.isVariableDeclaration(p) && ts.isObjectBindingPattern(p.name));
      if (usedWhole) out.add("env:*");
    }
    ts.forEachChild(n, visit);
  };
  visit(root);
  return [...out].sort();
}

/** Modules whose named type/value exports are database models (Prisma client, Wasp entities). */
export const MODEL_MODULES = new Set(["@prisma/client", ".prisma/client", "wasp/entities"]);

const unwrap = (e: ts.Expression): ts.Expression =>
  ts.isAsExpression(e) ||
  ts.isSatisfiesExpression(e) ||
  ts.isParenthesizedExpression(e) ||
  ts.isTypeAssertionExpression(e)
    ? unwrap(e.expression)
    : e;

/**
 * Flattened key paths of a data-only module's exported object literal ("a.b.c" → value hash), or
 * undefined when the file is not a plain catalog (functions, computed keys, spreads…).
 */
export function catalogKeys(
  sf: ts.SourceFile,
  hash: (s: string) => string,
): Record<string, string> | undefined {
  const consts = new Map<string, ts.Expression>();
  let exported: ts.Expression | undefined;
  for (const stmt of sf.statements) {
    if (ts.isImportDeclaration(stmt) && stmt.importClause?.isTypeOnly) continue;
    if (ts.isTypeAliasDeclaration(stmt) || ts.isInterfaceDeclaration(stmt)) continue;
    if (ts.isVariableStatement(stmt)) {
      for (const d of stmt.declarationList.declarations) {
        if (!ts.isIdentifier(d.name) || !d.initializer) return undefined;
        consts.set(d.name.text, unwrap(d.initializer));
        if (stmt.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword))
          exported ??= unwrap(d.initializer);
      }
      continue;
    }
    if (ts.isExportAssignment(stmt)) {
      exported = unwrap(stmt.expression);
      continue;
    }
    return undefined;
  }
  if (exported && ts.isIdentifier(exported)) exported = consts.get(exported.text);
  if (!exported || !ts.isObjectLiteralExpression(exported)) return undefined;
  const out: Record<string, string> = {};
  const walk = (obj: ts.ObjectLiteralExpression, prefix: string): boolean => {
    for (const p of obj.properties) {
      if (!ts.isPropertyAssignment(p)) return false;
      const name =
        ts.isIdentifier(p.name) || ts.isStringLiteral(p.name) || ts.isNumericLiteral(p.name)
          ? p.name.text
          : undefined;
      if (name === undefined) return false;
      const k = prefix ? `${prefix}.${name}` : name;
      const v = unwrap(p.initializer);
      if (ts.isObjectLiteralExpression(v)) {
        if (!walk(v, k)) return false;
      } else out[k] = hash(v.getText(sf));
    }
    return true;
  };
  return walk(exported, "") ? out : undefined;
}
