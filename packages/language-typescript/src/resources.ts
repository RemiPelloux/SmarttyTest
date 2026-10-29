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
  const tr = translationBindings(root);
  /** Qualifies a key read through a translation function with the namespaces it is bound to. */
  const i18nKeys = (fn: string, key: string, explicitNs?: string): string[] => {
    if (explicitNs) return [`i18n:${explicitNs}.${key}`];
    if (key.includes(":")) return [`i18n:${key.replace(":", ".")}`];
    const ns = tr.namespacesOf(fn);
    return ns.length ? ns.map((n) => `i18n:${n}.${key}`) : [`i18n:${key}`];
  };
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
      // A translation function received as a parameter reads in its caller's namespaces: the
      // caller records that when it passes the function on (below).
      if (tr.isTranslate(name) && arg && !(ts.isIdentifier(c) && tr.isParam(name))) {
        const opts = n.arguments[1];
        let explicitNs: string | undefined;
        if (opts && ts.isObjectLiteralExpression(opts))
          for (const p of opts.properties)
            if (
              ts.isPropertyAssignment(p) &&
              p.name.getText() === "ns" &&
              ts.isStringLiteralLike(p.initializer)
            )
              explicitNs = p.initializer.text;
        const keys = ts.isStringLiteralLike(arg)
          ? i18nKeys(name, arg.text, explicitNs)
          : ts.isTemplateExpression(arg)
            ? i18nKeys(name, `${arg.head.text}*`, explicitNs)
            : i18nKeys(name, "*", explicitNs);
        for (const k of keys) out.add(k);
      }
      // Passing a translation function on: the callee may read any key of its namespaces.
      for (const a of n.arguments)
        if (ts.isIdentifier(a) && tr.isTranslate(a.text) && !tr.isParam(a.text))
          for (const k of i18nKeys(a.text, "*")) out.add(k);
        else if (ts.isPropertyAccessExpression(a) && a.name.text === "t") out.add("i18n:*"); // i18n.t
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

/**
 * Translation functions in a declaration and their namespaces: `const { t } = useTranslation("ns")`,
 * `const { t: tl } = useTranslation(["a", "b"])`, `const t = i18n.getFixedT(lng, "ns")`,
 * `withTranslation("ns")`. Parameters named like a translation function (`t`, `translate`) are
 * bound by the caller.
 */
function translationBindings(root: ts.Node): {
  isTranslate(name: string): boolean;
  isParam(name: string): boolean;
  namespacesOf(name: string): string[];
} {
  const DEFAULT = new Set(["t", "$t", "translate"]);
  const bound = new Map<string, string[] | undefined>(); // undefined = dynamic namespace
  const params = new Set<string>();
  const declared = new Set<string>();
  let hocNamespaces: string[] | undefined = [];
  const namespacesOfCall = (call: ts.CallExpression): string[] | undefined => {
    const c = call.expression;
    const name = ts.isIdentifier(c) ? c.text : ts.isPropertyAccessExpression(c) ? c.name.text : "";
    if (name !== "useTranslation" && name !== "withTranslation" && name !== "getFixedT") return [];
    const arg = name === "getFixedT" ? call.arguments[1] : call.arguments[0];
    if (!arg) return [];
    const items = ts.isArrayLiteralExpression(arg) ? [...arg.elements] : [arg];
    const out: string[] = [];
    for (const i of items) {
      if (!ts.isStringLiteralLike(i)) return undefined;
      out.push(i.text);
    }
    return out;
  };
  const visit = (n: ts.Node): void => {
    if (ts.isParameter(n) && ts.isIdentifier(n.name) && DEFAULT.has(n.name.text))
      params.add(n.name.text);
    if (ts.isVariableDeclaration(n) && n.initializer) {
      const init = ts.isAwaitExpression(n.initializer) ? n.initializer.expression : n.initializer;
      if (ts.isCallExpression(init)) {
        const ns = namespacesOfCall(init);
        const c = init.expression;
        const callee = ts.isIdentifier(c)
          ? c.text
          : ts.isPropertyAccessExpression(c)
            ? c.name.text
            : "";
        if (
          ns === undefined ||
          ns.length ||
          callee === "useTranslation" ||
          callee === "getFixedT"
        ) {
          if (ts.isObjectBindingPattern(n.name)) {
            for (const el of n.name.elements)
              if ((el.propertyName ?? el.name).getText() === "t" && ts.isIdentifier(el.name)) {
                bound.set(el.name.text, ns);
                declared.add(el.name.text);
              }
          } else if (ts.isIdentifier(n.name)) {
            bound.set(n.name.text, ns);
            declared.add(n.name.text);
          }
        }
      }
    }
    if (ts.isCallExpression(n)) {
      const c = n.expression;
      if (ts.isIdentifier(c) && c.text === "withTranslation") {
        const ns = namespacesOfCall(n);
        hocNamespaces =
          ns === undefined || hocNamespaces === undefined ? undefined : [...hocNamespaces, ...ns];
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(root);
  return {
    isTranslate: (name) => DEFAULT.has(name) || bound.has(name),
    isParam: (name) => params.has(name) && !declared.has(name),
    namespacesOf: (name) => {
      if (bound.has(name)) return bound.get(name) ?? [];
      return hocNamespaces ?? [];
    },
  };
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
