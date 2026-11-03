/**
 * Python source analysis without running Python (preview). A small tokenizer (strings, f-string
 * expressions, comments, line continuations, indentation) feeds a statement reader that finds
 * imports, top-level functions, classes and their methods, module-level assignments and the code
 * that runs when the module loads.
 *
 * Precision is coarser than the TypeScript analyzer (no types): a name used through an attribute
 * (`geo.parse`, `self.save`) links to that member, any other use links to the whole symbol. What
 * cannot be read statically (`importlib.import_module(name)`) is reported as uncertainty.
 *
 * Import specifiers are encoded for the resolver (resolve.ts):
 * - `import a.b` → `a.b`; `from a.b import c` → `a.b:c` (`c` may be a submodule or a name);
 * - relative imports keep their dots: `from ..x import y` → `..x:y`, `from . import z` → `.:z`;
 * - a test file depends on each `conftest.py` above it: `@conftest:<dir>`.
 */
import { sha256 } from "@smarttest/shared";
import type { FileAnalysis, ImportRecord, SymbolRecord } from "@smarttest/source-parser";

export const PYTHON_ANALYZER_VERSION = "py-2";

type Tok = { t: "name" | "op" | "num" | "str"; v: string; line: number };

interface Line {
  indent: number;
  start: number;
  end: number;
  toks: Tok[];
  text: string;
}

const KEYWORDS = new Set([
  "False",
  "None",
  "True",
  "and",
  "as",
  "assert",
  "async",
  "await",
  "break",
  "class",
  "continue",
  "def",
  "del",
  "elif",
  "else",
  "except",
  "finally",
  "for",
  "from",
  "global",
  "if",
  "import",
  "in",
  "is",
  "lambda",
  "nonlocal",
  "not",
  "or",
  "pass",
  "raise",
  "return",
  "try",
  "while",
  "with",
  "yield",
  "match",
  "case",
  "self",
  "cls",
]);

/** Splits source into logical lines of tokens; string contents are kept as one token. */
export function tokenize(text: string): { lines: Line[]; errors: number } {
  const src = text.replace(/\r\n?/g, "\n");
  const lines: Line[] = [];
  let errors = 0;
  let i = 0;
  let line = 1;
  let depth = 0;
  let current: Line | undefined;
  let atLineStart = true;
  let lineStartPos = 0;
  const push = (t: Tok) => {
    if (!current) {
      // Indentation of the logical line's first physical line (a tab advances to the next 8).
      let w = 0;
      for (let p = lineStartPos; src[p] === " " || src[p] === "\t"; p++)
        w = src[p] === "\t" ? w + 8 - (w % 8) : w + 1;
      current = { indent: w, start: t.line, end: t.line, toks: [], text: "" };
    }
    current.toks.push(t);
    current.end = t.line;
  };
  const endLine = () => {
    if (current?.toks.length) lines.push(current);
    current = undefined;
  };
  /** f-string replacement fields: their expressions are code. */
  const fExpressions = (body: string, at: number) => {
    let j = 0;
    while (j < body.length) {
      if (body[j] === "{" && body[j + 1] === "{") j += 2;
      else if (body[j] === "{") {
        let d = 1;
        let k = j + 1;
        while (k < body.length && d) {
          if (body[k] === "{") d++;
          else if (body[k] === "}") d--;
          k++;
        }
        const inner = body.slice(j + 1, k - 1).split(/[!:](?![=])/)[0] ?? "";
        for (const m of inner.matchAll(/[A-Za-z_][A-Za-z0-9_]*|\./g))
          push(m[0] === "." ? { t: "op", v: ".", line: at } : { t: "name", v: m[0], line: at });
        j = k;
      } else j++;
    }
  };
  while (i < src.length) {
    const c = src[i] as string;
    if (atLineStart) {
      lineStartPos = i;
      atLineStart = false;
    }
    if (c === "\n") {
      line++;
      i++;
      if (depth === 0) endLine();
      atLineStart = depth === 0;
      continue;
    }
    if (c === "\\" && src[i + 1] === "\n") {
      i += 2;
      line++;
      continue;
    }
    if (c === " " || c === "\t" || c === "\f") {
      i++;
      continue;
    }
    if (c === "#") {
      while (i < src.length && src[i] !== "\n") i++;
      continue;
    }
    const str = /^([rRbBuUfF]{0,2})('''|"""|'|")/.exec(src.slice(i, i + 5));
    if (str && (str[1] === "" || /[A-Za-z]/.test(c))) {
      const prefix = (str[1] as string).toLowerCase();
      const quote = str[2] as string;
      const startLine = line;
      let j = i + (str[0] as string).length;
      const raw = prefix.includes("r");
      while (j < src.length && !src.startsWith(quote, j)) {
        if (src[j] === "\\" && !raw) j++;
        else if (src[j] === "\\" && raw) j++;
        if (src[j] === "\n") {
          if (quote.length === 1) {
            errors++;
            break;
          }
          line++;
        }
        j++;
      }
      const body = src.slice(i + (str[0] as string).length, j);
      push({ t: "str", v: `${prefix}${quote}${body}${quote}`, line: startLine });
      if (current) current.end = line; // a string over several lines ends the line where it ends
      if (prefix.includes("f")) fExpressions(body, startLine);
      i = Math.min(src.length, j + quote.length);
      continue;
    }
    const name = /^[A-Za-z_\u0080-￿][A-Za-z0-9_\u0080-￿]*/.exec(src.slice(i, i + 200));
    if (name) {
      push({ t: "name", v: name[0], line });
      i += name[0].length;
      continue;
    }
    const num =
      /^(?:0[xob][0-9a-f_]+|\d[\d_]*(?:\.[\d_]*)?(?:e[+-]?\d+)?j?|\.\d[\d_]*(?:e[+-]?\d+)?j?)/i.exec(
        src.slice(i, i + 64),
      );
    if (num) {
      push({ t: "num", v: num[0], line });
      i += num[0].length;
      continue;
    }
    const op =
      /^(?:\*\*=|\/\/=|>>=|<<=|\.\.\.|->|:=|[-+*/%&|^@<>=!]=|\*\*|\/\/|<<|>>|[()[\]{},:;.@=+\-*/%&|^~<>])/.exec(
        src.slice(i, i + 3),
      );
    if (op) {
      const v = op[0];
      if ("([{".includes(v)) depth++;
      else if (")]}".includes(v)) depth = Math.max(0, depth - 1);
      push({ t: "op", v, line });
      i += v.length;
      continue;
    }
    errors++;
    i++;
  }
  endLine();
  for (const l of lines) l.text = l.toks.map((t) => t.v).join(" ");
  return { lines, errors };
}

const hash = (parts: readonly string[]) => sha256(parts.join("\n"));

/** Names a token run reads: bare names, `X.y` uses, and the bare ones that escape whole. */
function namesOf(toks: readonly Tok[]): {
  refs: string[];
  uses: string[];
  escapes: string[];
  selfUses: string[];
  /** `self`/`cls` used whole: `cls(...)` constructs, `return self`, `f(self)` passes it on. */
  selfEscapes: boolean;
} {
  const refs = new Set<string>();
  const uses = new Set<string>();
  const escapes = new Set<string>();
  const selfUses = new Set<string>();
  let selfEscapes = false;
  for (let k = 0; k < toks.length; k++) {
    const t = toks[k] as Tok;
    if (t.t !== "name") continue;
    const prev = toks[k - 1];
    if (prev?.t === "op" && prev.v === ".") continue; // an attribute, not a name
    // A keyword argument name (`f(x=1)`) is not a reference.
    const next = toks[k + 1];
    if (
      next?.t === "op" &&
      next.v === "=" &&
      prev?.t === "op" &&
      (prev.v === "(" || prev.v === ",")
    )
      continue;
    const attr = next?.t === "op" && next.v === "." ? toks[k + 2] : undefined;
    if (t.v === "self" || t.v === "cls") {
      if (attr?.t === "name") selfUses.add(attr.v);
      // The parameter list names it too (`def m(self, …)`): not a use.
      else if (!(prev?.v === "(" && toks[k - 2]?.t === "name" && toks[k - 3]?.v === "def"))
        selfEscapes = true;
      continue;
    }
    if (KEYWORDS.has(t.v)) continue;
    refs.add(t.v);
    if (attr?.t === "name") uses.add(`${t.v}.${attr.v}`);
    else escapes.add(t.v);
  }
  return {
    refs: [...refs],
    uses: [...uses],
    escapes: [...escapes],
    selfUses: [...selfUses],
    selfEscapes,
  };
}

const CONSTRUCTORS = new Set(["__init__", "__new__", "__post_init__", "__init_subclass__"]);

/** The binding a test's conftest.py import carries: the load, not a unit. */
export const CONFTEST_LOAD = "__conftest_load__";

/**
 * Fixture names a module asks for: parameters of its functions and methods without a default
 * (`def test_x(self, cart, tmp_path)`), and `@pytest.mark.usefixtures("db")` strings.
 */
function fixtureNames(lines: readonly Line[]): string[] {
  const names = new Set<string>();
  for (const l of lines) {
    const t = l.toks;
    const at = t[0]?.v === "async" ? 1 : 0;
    if (t[at]?.v === "def" && t[at + 2]?.v === "(") {
      let depth = 0;
      let param: Tok[] = [];
      const flush = () => {
        const first = param[0];
        if (
          first?.t === "name" &&
          !param.some((p) => p.v === "=") &&
          first.v !== "self" &&
          first.v !== "cls"
        )
          names.add(first.v);
        param = [];
      };
      for (let k = at + 3; k < t.length; k++) {
        const x = t[k] as Tok;
        if (x.v === "(" || x.v === "[" || x.v === "{") depth++;
        if (x.v === ")" || x.v === "]" || x.v === "}") {
          if (depth === 0) {
            flush();
            break;
          }
          depth--;
        }
        if (depth === 0 && x.v === ",") flush();
        else if (depth === 0 && (x.v === "*" || x.v === "**" || x.v === "/"))
          param = [{ ...x, t: "op" }];
        else if (!(depth === 0 && x.v === ":" && param.length)) param.push(x);
        else {
          // an annotation follows: keep only the name
          let d = 0;
          while (k + 1 < t.length) {
            const y = t[k + 1] as Tok;
            if (d === 0 && (y.v === "," || y.v === ")" || y.v === "=")) break;
            if ("([{".includes(y.v)) d++;
            if (")]}".includes(y.v)) d--;
            k++;
          }
        }
      }
    }
    // @pytest.mark.usefixtures("db", "client")
    const u = t.findIndex((x) => x.v === "usefixtures");
    if (u > 0)
      for (const x of t.slice(u + 1))
        if (x.t === "str") {
          const v = /^[a-z]*(['"])(.*)\1$/is.exec(x.v)?.[2];
          if (v && /^[A-Za-z_]\w*$/.test(v)) names.add(v);
        }
  }
  return [...names];
}

/** Whether a file is a test pytest or unittest collects by default. */
export const PYTHON_TEST_FILE = /(?:^|\/)(?:test[^/]*|[^/]+_test)\.py$/;

/** Reads one file. `path` is project-relative POSIX. */
export function analyzePython(path: string, content: string): FileAnalysis {
  const { lines, errors } = tokenize(content);
  const isConftest = /(?:^|\/)conftest\.py$/.test(path);
  const isTestModule = PYTHON_TEST_FILE.test(path);
  // Every name a module imports is an attribute other modules can import from it. Test modules
  // and conftest.py are not imported that way: treating them as re-exporters would make every
  // change to what they import reach them.
  const reexports = !isTestModule && !isConftest;
  const imports: ImportRecord[] = [];
  const symbols: SymbolRecord[] = [];
  const localExports: { exported: string; local: string }[] = [];
  const dynamicUnresolved: string[] = [];
  const moduleCode: Tok[] = [];
  const srcLines = content.replace(/\r\n?/g, "\n").split("\n");
  const rawText = (start: number, end: number) => srcLines.slice(start - 1, end).join("\n");
  const range = (start: number, end: number) => ({
    start: { line: start, column: 0 },
    end: { line: end, column: (srcLines[end - 1] ?? "").length },
  });

  /** The lines of a block: those after `at` indented more than it. */
  const blockEnd = (at: number): number => {
    const base = (lines[at] as Line).indent;
    let k = at + 1;
    while (k < lines.length && (lines[k] as Line).indent > base) k++;
    return k; // exclusive
  };

  /** Every import statement and dynamic import, wherever it is (lazy imports in functions too). */
  const readImports = (l: Line) => {
    const tk = l.toks;
    for (let k = 0; k < tk.length; k++) {
      const t = tk[k] as Tok;
      if (t.t !== "name") continue;
      const prevOp = tk[k - 1];
      const startsStatement =
        k === 0 || (prevOp?.t === "op" && (prevOp.v === ";" || prevOp.v === ":"));
      if (t.v === "import" && startsStatement) {
        // import a.b.c [as d], e
        let j = k + 1;
        while (j < tk.length) {
          let mod = "";
          while (j < tk.length && ((tk[j] as Tok).t === "name" || (tk[j] as Tok).v === ".")) {
            if ((tk[j] as Tok).v === "as") break;
            mod += (tk[j] as Tok).v;
            j++;
          }
          let alias: string | undefined;
          if ((tk[j] as Tok | undefined)?.v === "as") {
            alias = (tk[j + 1] as Tok | undefined)?.v;
            j += 2;
          }
          if (mod) {
            const local = alias ?? (mod.split(".")[0] as string);
            imports.push({
              specifier: mod,
              kind: "namespace",
              bindings: [{ imported: "*", local: alias ? local : mod }],
              typeOnly: false,
              line: t.line,
            });
            // Importing a.b.c runs a/__init__.py and a/b/__init__.py first.
            const parts = mod.split(".");
            for (let p = 1; p < parts.length; p++)
              imports.push({
                specifier: parts.slice(0, p).join("."),
                kind: "side-effect",
                bindings: [],
                typeOnly: false,
                line: t.line,
              });
          }
          if ((tk[j] as Tok | undefined)?.v === ",") j++;
          else break;
        }
        return;
      }
      if (t.v === "from" && startsStatement) {
        let j = k + 1;
        let mod = "";
        while (j < tk.length && (tk[j] as Tok).v !== "import") {
          mod += (tk[j] as Tok).v;
          j++;
        }
        j++; // import
        if ((tk[j] as Tok | undefined)?.v === "(") j++;
        if ((tk[j] as Tok | undefined)?.v === "*") {
          imports.push({
            specifier: mod,
            kind: "side-effect",
            bindings: [],
            typeOnly: false,
            line: t.line,
          });
          return;
        }
        while (j < tk.length) {
          const n = tk[j] as Tok;
          if (n.t !== "name") break;
          let local = n.v;
          j++;
          if ((tk[j] as Tok | undefined)?.v === "as") {
            local = (tk[j + 1] as Tok | undefined)?.v ?? local;
            j += 2;
          }
          imports.push({
            specifier: `${mod}:${n.v}`,
            kind: "named",
            bindings: [{ imported: n.v, local }],
            typeOnly: false,
            line: t.line,
          });
          if (l.indent === 0 && reexports) localExports.push({ exported: local, local });
          if ((tk[j] as Tok | undefined)?.v === ",") j++;
          else break;
        }
        // The package of `from a.b import c` runs a/__init__.py (and a.b's, when it is a package).
        if (!mod.startsWith(".")) {
          const parts = mod.split(".");
          for (let p = 1; p < parts.length; p++)
            imports.push({
              specifier: parts.slice(0, p).join("."),
              kind: "side-effect",
              bindings: [],
              typeOnly: false,
              line: t.line,
            });
        }
        return;
      }
    }
    // importlib.import_module("x") / __import__("x"): a literal is an import, anything else is
    // uncertainty.
    for (let k = 0; k < tk.length; k++) {
      const t = tk[k] as Tok;
      const call =
        (t.v === "import_module" && tk[k - 1]?.v === "." && tk[k - 2]?.v === "importlib") ||
        (t.v === "__import__" && tk[k - 1]?.v !== ".");
      if (!call || tk[k + 1]?.v !== "(") continue;
      const arg = tk[k + 2];
      const closes = tk[k + 3]?.v === ")" || tk[k + 3]?.v === ",";
      const literal =
        arg?.t === "str" && closes ? /^[a-z]*(['"])(.*)\1$/is.exec(arg.v)?.[2] : undefined;
      if (literal && !literal.includes("{"))
        imports.push({
          specifier: literal,
          kind: "dynamic",
          bindings: [],
          typeOnly: false,
          line: t.line,
        });
      else dynamicUnresolved.push(`${t.v}(…) on line ${t.line}`);
    }
  };
  for (const l of lines) readImports(l);

  // pytest: a test loads every conftest.py in its directory and above (their module code,
  // autouse fixtures and hooks run for it: a dummy binding links the load without naming a unit),
  // and uses the fixtures it names as parameters, from the nearest conftest.py defining them.
  if (isTestModule || isConftest) {
    const dirs = path.split("/").slice(0, -1);
    for (let d = dirs.length; d >= 0; d--) {
      if (isConftest && d === dirs.length) continue;
      imports.push({
        specifier: `@conftest:${dirs.slice(0, d).join("/")}`,
        kind: "named",
        bindings: [{ imported: CONFTEST_LOAD, local: CONFTEST_LOAD }],
        typeOnly: false,
        line: 1,
      });
    }
    const dir = dirs.join("/");
    for (const name of fixtureNames(lines))
      imports.push({
        specifier: `@fixture:${isConftest ? `${dir}^` : dir}:${name}`,
        kind: "named",
        bindings: [{ imported: name, local: name }],
        typeOnly: false,
        line: 1,
      });
  }

  const addSymbol = (
    rec: Omit<SymbolRecord, "id" | "signature" | "textHash" | "decorators" | "exportNames"> & {
      exportNames?: string[];
      decorators?: string[];
      signature?: string;
      raw: string;
    },
  ) => {
    const { raw, ...rest } = rec;
    symbols.push({
      id: `${path}#${rec.qualifiedName}`,
      exportNames: rec.exportNames ?? [],
      decorators: rec.decorators ?? [],
      signature: rec.signature ?? "",
      textHash: sha256(raw),
      ...rest,
    });
  };

  const isDef = (l: Line) =>
    l.toks[0]?.v === "def" || (l.toks[0]?.v === "async" && l.toks[1]?.v === "def");
  const defName = (l: Line) => (l.toks[0]?.v === "async" ? l.toks[2]?.v : l.toks[1]?.v) ?? "";
  const isImport = (l: Line) => l.toks[0]?.v === "import" || l.toks[0]?.v === "from";

  const top = lines.length ? Math.min(...lines.map((l) => l.indent)) : 0;
  let decorators: Line[] = [];
  for (let k = 0; k < lines.length; k++) {
    const l = lines[k] as Line;
    if (l.indent !== top) continue; // inside a block read below
    if (l.toks[0]?.v === "@") {
      decorators.push(l);
      continue;
    }
    const end = blockEnd(k);
    const body = lines.slice(k, end);
    const startLine = decorators[0]?.start ?? l.start;
    const endLine = (lines[end - 1] as Line).end;
    const decoToks = decorators.flatMap((d) => d.toks);
    const decoNames = decorators.map((d) =>
      d.toks
        .slice(1)
        .map((t) => t.v)
        .join(""),
    );
    if (isDef(l)) {
      const name = defName(l);
      const toks = [...decoToks, ...body.flatMap((b) => b.toks)];
      const n = namesOf(toks);
      addSymbol({
        name,
        qualifiedName: name,
        kind: "function",
        exportNames: [name],
        range: range(startLine, endLine),
        signature: l.text,
        tokenHash: hash(toks.map((t) => t.v)),
        refs: n.refs.filter((r) => r !== name),
        uses: n.uses,
        escapes: n.escapes.filter((r) => r !== name),
        decorators: decoNames,
        // Decorators run when the module loads. In a conftest.py, an autouse fixture and a
        // `pytest_*` hook run for every test below it, whichever fixtures the test names.
        ...(isConftest && (/^pytest_/.test(name) || decoToks.some((t) => t.v === "autouse"))
          ? { evalHash: hash(toks.map((t) => t.v)) }
          : decorators.length
            ? { evalHash: hash([...decoToks.map((t) => t.v), l.text]) }
            : {}),
        raw: rawText(startLine, endLine),
      });
    } else if (l.toks[0]?.v === "class") {
      const name = l.toks[1]?.v ?? "";
      // The class body runs at load: decorators, bases and every statement that is not a method.
      const memberLines: [number, number, Line[]][] = [];
      const classCode: Tok[] = [...decoToks, ...l.toks];
      const inner = body.slice(1);
      const childIndent = inner[0]?.indent;
      let memberDecos: Line[] = [];
      for (let m = 0; m < inner.length; m++) {
        const ml = inner[m] as Line;
        if (ml.indent !== childIndent) continue;
        if (ml.toks[0]?.v === "@") {
          memberDecos.push(ml);
          continue;
        }
        const mEnd = (() => {
          let q = m + 1;
          while (q < inner.length && (inner[q] as Line).indent > ml.indent) q++;
          return q;
        })();
        if (isDef(ml)) memberLines.push([m, mEnd, memberDecos]);
        else
          for (const x of inner.slice(m, mEnd))
            classCode.push(...x.toks, ...memberDecos.flatMap((d) => d.toks));
        memberDecos = [];
        m = mEnd - 1;
      }
      const cn = namesOf(classCode);
      addSymbol({
        name,
        qualifiedName: name,
        kind: "class",
        exportNames: [name],
        range: range(startLine, endLine),
        signature: l.text,
        tokenHash: hash(classCode.map((t) => t.v)),
        refs: cn.refs.filter((r) => r !== name),
        uses: cn.uses,
        escapes: cn.escapes.filter((r) => r !== name),
        decorators: decoNames,
        evalHash: hash(classCode.map((t) => t.v)),
        ...(l.toks.some((t) => t.v === "(")
          ? { extends: l.toks[3]?.t === "name" ? l.toks[3].v : "" }
          : {}),
        raw: rawText(startLine, endLine),
      });
      for (const [m, mEnd, mDecos] of memberLines) {
        const ml = inner[m] as Line;
        const mName = defName(ml);
        const mStart = mDecos[0]?.start ?? ml.start;
        const mLast = (inner[mEnd - 1] as Line).end;
        const toks = [
          ...mDecos.flatMap((d) => d.toks),
          ...inner.slice(m, mEnd).flatMap((x) => x.toks),
        ];
        const n = namesOf(toks);
        addSymbol({
          name: mName,
          qualifiedName: `${name}.${mName}`,
          kind: CONSTRUCTORS.has(mName) ? "property" : "method",
          parent: name,
          range: range(mStart, mLast),
          signature: ml.text,
          tokenHash: hash(toks.map((t) => t.v)),
          refs: n.refs,
          uses: n.uses,
          escapes: n.escapes,
          thisUses: n.selfUses,
          // `cls(...)` (a classmethod building an instance) or `return self`: callers can reach
          // any member, the constructor included.
          ...(n.selfEscapes ? { thisEscapes: true } : {}),
          decorators: mDecos.map((d) =>
            d.toks
              .slice(1)
              .map((t) => t.v)
              .join(""),
          ),
          raw: rawText(mStart, mLast),
        });
      }
    } else if (isImport(l)) {
      // Imports are read above; their changes are compared through importsHash.
    } else {
      // A module-level assignment is a value other modules can import; anything else is code that
      // runs at load.
      const eq = l.toks.findIndex((t, idx) => t.v === "=" && idx > 0);
      const targets =
        eq > 0 && body.length === 1
          ? l.toks
              .slice(0, eq)
              .filter(
                (t, idx, all) =>
                  t.t === "name" && all[idx - 1]?.v !== "." && all[idx + 1]?.v !== ".",
              )
              .map((t) => t.v)
              .filter((v) => !KEYWORDS.has(v))
          : [];
      const annotated = l.toks[1]?.v === ":" && l.toks[0]?.t === "name";
      if (targets.length || annotated) {
        const names = targets.length ? targets : [l.toks[0]?.v as string];
        const toks = body.flatMap((b) => b.toks);
        const value = toks.slice(Math.max(eq, 0) + 1);
        const n = namesOf(value);
        const runs = value.some((t) => t.v === "(" || t.v === "[") || n.uses.length > 0;
        for (const name of names)
          addSymbol({
            name,
            qualifiedName: name,
            kind: "property",
            exportNames: [name],
            range: range(startLine, endLine),
            signature: l.text.slice(0, 200),
            tokenHash: hash(toks.map((t) => t.v)),
            refs: n.refs,
            uses: n.uses,
            escapes: n.escapes,
            ...(runs ? { evalHash: hash(toks.map((t) => t.v)) } : {}),
            raw: rawText(startLine, endLine),
          });
      } else moduleCode.push(...body.flatMap((b) => b.toks));
    }
    decorators = [];
  }

  const mod = namesOf(moduleCode);
  return {
    path,
    hash: sha256(content),
    language: "python",
    moduleKind: "unknown",
    imports,
    symbols,
    localExports,
    topLevelRefs: mod.refs,
    topLevelUses: mod.uses,
    topLevelEscapes: mod.escapes,
    topLevelHash: hash(moduleCode.map((t) => t.v)),
    importsHash: hash(
      imports.map(
        (i) =>
          `${i.kind}|${i.specifier}|${i.bindings.map((b) => `${b.imported}>${b.local}`).join(",")}`,
      ),
    ),
    dynamicUnresolved,
    parseErrors: errors,
    analyzerVersion: PYTHON_ANALYZER_VERSION,
  };
}
