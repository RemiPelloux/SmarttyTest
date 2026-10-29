import { posix } from "node:path";
import ts from "typescript";

/**
 * Statically evaluates path expressions used in dynamic imports, relative to the importing file's
 * directory. Unknown parts become `*`, so a partially known path is still a bounded glob.
 *
 * Understands: string/template literals, `+`, module-level `const`s, `__dirname`,
 * `import.meta.dirname`, `import.meta.url`, `new URL(rel, import.meta.url)` (+ `.href`/`.pathname`),
 * `fileURLToPath()`, `pathToFileURL()`, `path.resolve/join()`, `dirname()`.
 */
export class StaticPathEvaluator {
  private consts = new Map<string, ts.Expression>();
  private evaluating = new Set<string>();

  constructor(
    private readonly sf: ts.SourceFile,
    private readonly fileName: string,
  ) {
    for (const stmt of sf.statements) {
      if (!ts.isVariableStatement(stmt) || !(stmt.declarationList.flags & ts.NodeFlags.Const))
        continue;
      for (const d of stmt.declarationList.declarations) {
        if (ts.isIdentifier(d.name) && d.initializer) this.consts.set(d.name.text, d.initializer);
      }
    }
  }

  /** A path (relative to the file's directory, may contain `*`), or undefined when nothing is known. */
  evaluate(node: ts.Expression): string | undefined {
    const raw = this.eval(node);
    if (raw === undefined) return undefined;
    const cleaned = raw.replace(/^file:\/\//, "").replace(/\*+/g, "*");
    if (!/[A-Za-z0-9_-]/.test(cleaned.replace(/\*/g, ""))) return undefined; // nothing literal left
    if (cleaned.startsWith("/")) return undefined; // absolute paths outside our knowledge
    const trailing = cleaned.endsWith("/") ? "/" : "";
    return `${posix.normalize(cleaned)}${trailing}`.replace(/^\.\//, "");
  }

  private eval(node: ts.Expression): string | undefined {
    if (
      ts.isParenthesizedExpression(node) ||
      ts.isAsExpression(node) ||
      ts.isNonNullExpression(node)
    )
      return this.eval(node.expression);
    if (ts.isStringLiteralLike(node)) return node.text;
    if (ts.isTemplateExpression(node)) {
      let out = node.head.text;
      for (const span of node.templateSpans)
        out += (this.eval(span.expression) ?? "*") + span.literal.text;
      return out;
    }
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
      return (this.eval(node.left) ?? "*") + (this.eval(node.right) ?? "*");
    }
    if (ts.isIdentifier(node)) {
      if (node.text === "__dirname") return "./";
      if (node.text === "__filename") return `./${posix.basename(this.fileName)}`;
      const init = this.consts.get(node.text);
      if (!init || this.evaluating.has(node.text)) return undefined;
      this.evaluating.add(node.text);
      try {
        return this.eval(init);
      } finally {
        this.evaluating.delete(node.text);
      }
    }
    if (ts.isPropertyAccessExpression(node)) {
      const text = node.getText(this.sf);
      if (text === "import.meta.dirname") return "./";
      if (text === "import.meta.url" || text === "import.meta.filename")
        return `./${posix.basename(this.fileName)}`;
      if (["href", "pathname"].includes(node.name.text)) return this.eval(node.expression);
      return undefined;
    }
    if (
      ts.isNewExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "URL"
    ) {
      const [rel, base] = node.arguments ?? [];
      if (!rel) return undefined;
      const r = this.eval(rel);
      if (r === undefined) return undefined;
      if (!base) return r;
      const b = this.eval(base);
      if (b === undefined) return undefined;
      // URL resolution: relative to the base's directory
      const baseDir = b.endsWith("/") ? b : posix.dirname(b);
      return joinKeep(baseDir, r);
    }
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      const name = ts.isIdentifier(callee)
        ? callee.text
        : ts.isPropertyAccessExpression(callee)
          ? callee.name.text
          : "";
      const args = node.arguments;
      if (name === "fileURLToPath" || name === "pathToFileURL" || name === "normalize")
        return args[0] ? this.eval(args[0]) : undefined;
      if (name === "dirname") {
        const v = args[0] ? this.eval(args[0]) : undefined;
        return v === undefined ? undefined : `${posix.dirname(v.replace(/\/$/, ""))}/`;
      }
      if (name === "resolve" || name === "join") {
        const parts = args.map((a) => this.eval(a));
        if (!parts.length || parts[0] === undefined) return undefined;
        return parts.slice(1).reduce<string>((acc, p) => joinKeep(acc, p ?? "*"), parts[0]);
      }
    }
    return undefined;
  }
}

/** posix.join that keeps a trailing slash (URL-style directories). */
function joinKeep(a: string, b: string): string {
  if (b.startsWith("/")) return b;
  const joined = posix.join(a, b);
  return b.endsWith("/") && !joined.endsWith("/") ? `${joined}/` : joined;
}
