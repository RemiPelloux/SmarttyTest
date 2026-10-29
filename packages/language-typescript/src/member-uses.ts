import ts from "typescript";

/**
 * Member-level usage of names inside a declaration.
 *
 * - `uses`: "Name.member" where Name is a class, namespace or object named in this file
 *   (import local or top-level symbol). Values whose class is known locally are resolved to it:
 *   `new X()`, `x: X`, constructor parameter properties and `this.p` with a known type.
 * - `escapes`: names referenced as a whole (called, passed, returned, assigned, JSX tag…).
 *   An escaping class is a class-level dependency.
 * - `thisUses` / `superUses`: members reached through `this.` / `super.` (intra-class edges).
 *
 * Sound by construction: anything not understood is either an escape (class level) or not a
 * reference to a file-level name at all. Untyped locals shadow outer typed names.
 */
export interface MemberUses {
  uses: string[];
  escapes: string[];
  thisUses: string[];
  superUses: string[];
  /** `this` leaves the method (returned, passed, stored): callers can reach any member. */
  thisEscapes?: boolean;
}

/** name -> class name, or null for a local whose type is unknown (shadows outer names). */
type Scope = Map<string, string | null>;

export function classOfNew(expr: ts.Expression | undefined): string | undefined {
  if (!expr) return undefined;
  let e = expr;
  while (ts.isParenthesizedExpression(e) || ts.isAsExpression(e) || ts.isAwaitExpression(e))
    e = e.expression;
  if (ts.isNewExpression(e) && ts.isIdentifier(e.expression)) return e.expression.text;
  return undefined;
}

export function classOfType(type: ts.TypeNode | undefined): string | undefined {
  if (type && ts.isTypeReferenceNode(type) && ts.isIdentifier(type.typeName))
    return type.typeName.text;
  return undefined;
}

function boundNames(name: ts.BindingName, out: string[]): void {
  if (ts.isIdentifier(name)) out.push(name.text);
  else for (const el of name.elements) if (ts.isBindingElement(el)) boundNames(el.name, out);
}

/** Module-level variables whose class is known (`const auth = new AuthService()`). */
export function moduleScope(sf: ts.SourceFile): Scope {
  const scope: Scope = new Map();
  for (const stmt of sf.statements) {
    if (!ts.isVariableStatement(stmt)) continue;
    for (const d of stmt.declarationList.declarations) {
      if (!ts.isIdentifier(d.name)) continue;
      const cls = classOfType(d.type) ?? classOfNew(d.initializer);
      if (cls) scope.set(d.name.text, cls);
    }
  }
  return scope;
}

/** `this.p` types inside a class: property declarations and constructor parameter properties. */
export function thisScope(cls: ts.ClassLikeDeclaration): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of cls.members) {
    if (ts.isPropertyDeclaration(m) && ts.isIdentifier(m.name)) {
      const c = classOfType(m.type) ?? classOfNew(m.initializer);
      if (c) out.set(m.name.text, c);
    }
    if (ts.isConstructorDeclaration(m)) {
      for (const p of m.parameters) {
        const isProperty =
          ts.canHaveModifiers(p) &&
          (ts.getModifiers(p) ?? []).some((mod) =>
            [
              ts.SyntaxKind.PublicKeyword,
              ts.SyntaxKind.PrivateKeyword,
              ts.SyntaxKind.ProtectedKeyword,
              ts.SyntaxKind.ReadonlyKeyword,
            ].includes(mod.kind),
          );
        if (isProperty && ts.isIdentifier(p.name)) {
          const c = classOfType(p.type) ?? classOfNew(p.initializer);
          if (c) out.set(p.name.text, c);
        }
      }
    }
  }
  return out;
}

/** Declarations directly inside a function body (not nested functions), with known classes. */
function functionScope(fn: ts.SignatureDeclaration): Scope {
  const scope: Scope = new Map();
  for (const p of fn.parameters) {
    const names: string[] = [];
    boundNames(p.name, names);
    const cls = ts.isIdentifier(p.name)
      ? (classOfType(p.type) ?? classOfNew(p.initializer))
      : undefined;
    for (const n of names) scope.set(n, cls ?? null);
  }
  const body = (fn as { body?: ts.Node }).body;
  if (!body) return scope;
  const visit = (n: ts.Node): void => {
    if (ts.isFunctionLike(n) && n !== fn) return; // nested function: its own scope
    if (ts.isVariableDeclaration(n)) {
      const names: string[] = [];
      boundNames(n.name, names);
      const cls = ts.isIdentifier(n.name)
        ? (classOfType(n.type) ?? classOfNew(n.initializer))
        : undefined;
      for (const name of names) scope.set(name, cls ?? null);
    } else if (ts.isCatchClause(n) && n.variableDeclaration) {
      const names: string[] = [];
      boundNames(n.variableDeclaration.name, names);
      for (const name of names) scope.set(name, null);
    } else if ((ts.isFunctionDeclaration(n) || ts.isClassDeclaration(n)) && n.name && n !== fn) {
      scope.set(n.name.text, null);
    }
    ts.forEachChild(n, visit);
  };
  ts.forEachChild(body, visit);
  return scope;
}

function isDeclarationName(id: ts.Identifier): boolean {
  const p = id.parent;
  if (!p) return false;
  if (
    (ts.isVariableDeclaration(p) ||
      ts.isParameter(p) ||
      ts.isBindingElement(p) ||
      ts.isFunctionDeclaration(p) ||
      ts.isClassDeclaration(p) ||
      ts.isFunctionExpression(p) ||
      ts.isClassExpression(p) ||
      ts.isMethodDeclaration(p) ||
      ts.isPropertyDeclaration(p) ||
      ts.isGetAccessorDeclaration(p) ||
      ts.isSetAccessorDeclaration(p) ||
      ts.isEnumMember(p) ||
      ts.isPropertySignature(p) ||
      ts.isMethodSignature(p) ||
      ts.isInterfaceDeclaration(p) ||
      ts.isTypeAliasDeclaration(p) ||
      ts.isEnumDeclaration(p) ||
      ts.isImportSpecifier(p) ||
      ts.isImportClause(p) ||
      ts.isNamespaceImport(p) ||
      ts.isExportSpecifier(p) ||
      ts.isLabeledStatement(p) ||
      ts.isTypeParameterDeclaration(p)) &&
    (p as { name?: ts.Node }).name === id
  )
    return true;
  if (ts.isBindingElement(p) && p.propertyName === id) return true;
  if (ts.isPropertyAssignment(p) && p.name === id) return true;
  if (ts.isJsxAttribute(p) && p.name === id) return true;
  if ((ts.isBreakStatement(p) || ts.isContinueStatement(p)) && p.label === id) return true;
  if (ts.isMetaProperty(p)) return true;
  return false;
}

function isBoundNew(n: ts.NewExpression): boolean {
  let child: ts.Node = n;
  let p = n.parent;
  while (
    p &&
    (ts.isParenthesizedExpression(p) || ts.isAsExpression(p) || ts.isAwaitExpression(p))
  ) {
    child = p;
    p = p.parent;
  }
  if (!p) return false;
  if (ts.isVariableDeclaration(p) && p.initializer === child && ts.isIdentifier(p.name))
    return true;
  if (ts.isPropertyDeclaration(p) && p.initializer === child) return true;
  if (ts.isParameter(p) && p.initializer === child) return true;
  if (ts.isExpressionStatement(p)) return true; // result discarded
  return false;
}

export function collectMemberUses(
  root: ts.Node,
  module: Scope,
  thisTypes?: Map<string, string>,
): MemberUses {
  const uses = new Set<string>();
  const escapes = new Set<string>();
  const thisUses = new Set<string>();
  const superUses = new Set<string>();
  let thisEscapes = false;
  const scopes: Scope[] = [module];
  const lookup = (name: string): string | null | undefined => {
    for (let i = scopes.length - 1; i >= 0; i--) {
      const s = scopes[i] as Scope;
      if (s.has(name)) return s.get(name) as string | null;
    }
    return undefined;
  };
  const memberOf = (obj: ts.Expression, member: string): boolean => {
    if (ts.isIdentifier(obj)) {
      const t = lookup(obj.text);
      if (typeof t === "string") uses.add(`${t}.${member}`);
      else if (t === undefined) uses.add(`${obj.text}.${member}`);
      return true;
    }
    if (obj.kind === ts.SyntaxKind.ThisKeyword) {
      thisUses.add(member);
      return true;
    }
    if (obj.kind === ts.SyntaxKind.SuperKeyword) {
      superUses.add(member);
      return true;
    }
    if (
      ts.isPropertyAccessExpression(obj) &&
      obj.expression.kind === ts.SyntaxKind.ThisKeyword &&
      thisTypes?.has(obj.name.text)
    ) {
      thisUses.add(obj.name.text);
      uses.add(`${thisTypes.get(obj.name.text)}.${member}`);
      return true;
    }
    if (ts.isNewExpression(obj) && ts.isIdentifier(obj.expression)) {
      uses.add(`${obj.expression.text}.${member}`);
      uses.add(`${obj.expression.text}.constructor`);
      for (const a of obj.arguments ?? []) visit(a);
      return true;
    }
    return false;
  };
  const visit = (n: ts.Node): void => {
    if (ts.isTypeNode(n) || ts.isInterfaceDeclaration(n) || ts.isTypeAliasDeclaration(n)) return; // types don't execute
    if (ts.isFunctionLike(n) && n !== root) {
      scopes.push(functionScope(n));
      ts.forEachChild(n, visit);
      scopes.pop();
      return;
    }
    if (ts.isPropertyAccessExpression(n)) {
      if (memberOf(n.expression, n.name.text)) return;
      visit(n.expression);
      return;
    }
    if (ts.isElementAccessExpression(n) && ts.isStringLiteralLike(n.argumentExpression)) {
      if (memberOf(n.expression, n.argumentExpression.text)) return;
      visit(n.expression);
      return;
    }
    if (ts.isNewExpression(n) && ts.isIdentifier(n.expression)) {
      const cls = n.expression.text;
      const t = lookup(cls);
      if (t === undefined) {
        uses.add(`${cls}.constructor`);
        if (!isBoundNew(n)) escapes.add(cls);
      }
      for (const a of n.arguments ?? []) visit(a);
      return;
    }
    if (n.kind === ts.SyntaxKind.ThisKeyword) {
      thisEscapes = true;
      return;
    }
    if (ts.isIdentifier(n)) {
      if (isDeclarationName(n)) return;
      const t = lookup(n.text);
      if (typeof t === "string") escapes.add(t);
      else if (t === undefined) escapes.add(n.text);
      return;
    }
    if (ts.isJsxOpeningLikeElement(n) || ts.isJsxClosingElement(n)) {
      const tag = n.tagName;
      if (ts.isIdentifier(tag)) escapes.add(tag.text);
      else if (ts.isPropertyAccessExpression(tag)) memberOf(tag.expression, tag.name.text);
      if (!ts.isJsxClosingElement(n)) for (const a of n.attributes.properties) visit(a);
      return;
    }
    ts.forEachChild(n, visit);
  };
  if (ts.isFunctionLike(root)) {
    scopes.push(functionScope(root));
    ts.forEachChild(root, visit);
  } else {
    visit(root);
  }
  return {
    uses: [...uses].sort(),
    escapes: [...escapes].sort(),
    thisUses: [...thisUses].sort(),
    superUses: [...superUses].sort(),
    ...(thisEscapes ? { thisEscapes } : {}),
  };
}
