/**
 * PHP source analysis without running PHP (preview). The tokenizer (tokenize.ts) feeds a reader
 * that follows PHP's name resolution: namespaces, `use` (grouped, aliased, `use function`,
 * `use const`), names in the same namespace, fully qualified names. It finds classes, interfaces,
 * traits and enums with their methods, constants, properties and cases; top-level functions and
 * constants; and the code that runs when the file is included (routes, configs, bootstrap files).
 *
 * Precision: a member used through `$this->`, `self::`, `static::`, `parent::`, `X::` or a typed
 * parameter or property links to that member; any other use of a class links to the whole class.
 * What cannot be read statically (`new $class`, `$class::$method()`, `app($name)`,
 * `call_user_func($callable)`, class names built from strings, `require $path`) is uncertainty.
 *
 * Every name is resolved to its fully qualified name here; the resolver (resolve.ts) maps it to a
 * file. Specifiers:
 * - `@class/A/B/C`: class `A\B\C`; `@fn/A/f`, `@fn?/A/f` (unqualified: `A\f`, else global `f`),
 *   `@const/…` and `@const?/…` likewise;
 * - `./x.php`, `../x.php` (from this file's folder), `@composer/routes/api.php` (from the
 *   Composer project's root): literal paths given to `require`/`include` and Laravel's loaders;
 * - `@bound/A/B/C`: what the Laravel container binds `A\B\C` to; `@bind-key/name` likewise for a
 *   string key (a facade accessor, `app('name')`);
 * - `@app-boot`: the application's `bootstrap/app.php`, for tests that boot Laravel;
 * - `@pest/<dir>`: the nearest `Pest.php`, for Pest test files.
 */
import { sha256 } from "@smarttest/shared";
import type { FileAnalysis, ImportRecord, SymbolRecord } from "@smarttest/source-parser";
import { PHP_FUNCTIONS } from "./builtins.js";
import { bracketPairs, type Tok, tokenize } from "./tokenize.js";

export const PHP_ANALYZER_VERSION = "php-2";

/** Whether a file is a test PHPUnit collects by default (`*Test.php`). */
export const PHP_TEST_FILE = /(?:^|\/)[^/]*Test\.php$/;

const TYPE_KEYWORDS = new Set([
  "int",
  "integer",
  "float",
  "double",
  "string",
  "bool",
  "boolean",
  "array",
  "callable",
  "iterable",
  "object",
  "mixed",
  "void",
  "null",
  "never",
  "false",
  "true",
  "self",
  "static",
  "parent",
  "resource",
]);

/** Words followed by `(` that are not function calls. */
const NOT_CALLS = new Set([
  "from",
  "if",
  "elseif",
  "else",
  "while",
  "for",
  "foreach",
  "switch",
  "match",
  "array",
  "list",
  "isset",
  "empty",
  "unset",
  "eval",
  "exit",
  "die",
  "function",
  "fn",
  "echo",
  "print",
  "return",
  "include",
  "include_once",
  "require",
  "require_once",
  "catch",
  "declare",
  "use",
  "static",
  "clone",
  "and",
  "or",
  "xor",
  "new",
  "yield",
  "throw",
  "case",
  "default",
  "self",
  "parent",
  "instanceof",
  "insteadof",
  "as",
  "global",
  "const",
  "class",
  "interface",
  "trait",
  "enum",
  "abstract",
  "final",
  "readonly",
  "public",
  "protected",
  "private",
  "var",
  "do",
  "try",
  "finally",
  "goto",
  "namespace",
  "extends",
  "implements",
  "endif",
  "endwhile",
  "endfor",
  "endforeach",
  "endswitch",
]);

/** Constant-like words that are never project constants. */
const NOT_CONSTANTS = new Set([
  "true",
  "false",
  "null",
  "TRUE",
  "FALSE",
  "NULL",
  "INF",
  "NAN",
  "DIRECTORY_SEPARATOR",
  "PATH_SEPARATOR",
  "STDIN",
  "STDOUT",
  "STDERR",
  "__DIR__",
  "__FILE__",
  "__LINE__",
  "__CLASS__",
  "__FUNCTION__",
  "__METHOD__",
  "__NAMESPACE__",
  "__TRAIT__",
  "__COMPILER_HALT_OFFSET__",
]);
/** Prefixes of PHP's own constants (`PHP_EOL`, `E_ALL`, `JSON_THROW_ON_ERROR`, …). */
const BUILTIN_CONSTANT =
  /^(?:PHP|E|JSON|PREG|FILTER|SORT|COUNT|ARRAY|PATHINFO|ENT|HTML|LC|M|DATE|SEEK|LOCK|FILE|GLOB|STR|MB|CURL|CURLOPT|CURLINFO|CURLE|PDO|LIBXML|XML|DOM|OPENSSL|PASSWORD|INI|INTL|IMG|IMAGETYPE|ZIP|SODIUM|DEBUG|UPLOAD|CASE|EXTR|CREDITS|INFO|DNS|LOG|SIG|PCNTL|FNM|SCANDIR|CRYPT|MT|T|U|X|ZEND|CAL|CONNECTION|INPUT|STREAM|PSFS|SOCK|SOL|SO|MSG|AF|IPPROTO|IP|TCP|PREG|NUMBER|GRAPHEME|IDNA|ULOC|IntlChar|LIBXML|EXIF|IMAGE|GD|PNG|IMG|ICONV|BC|RANDOM|FTP|FORCE|SCRIPT|CHAR|LEVEL|DEFAULT|MCRYPT|ASSERT|CONNECTION|ABDAY|DAY|MON|ABMON|AM|PM|D|RADIXCHAR|THOUSEP|YESEXPR|NOEXPR|CODESET|ERA|ALT|CRNCYSTR|SQLITE3|MYSQLI|PGSQL|OCI|DB|LDAP|IMAP|SNMP|SEGMENT|POSIX|PHP_INT|ENC|HASH|MHASH|XDEBUG|OPCACHE|APC|APCU|REDIS|MEMCACHED|SWOOLE)_/;

const LARAVEL_PATH_HELPERS: Record<string, string> = {
  base_path: "",
  app_path: "app",
  config_path: "config",
  database_path: "database",
  resource_path: "resources",
  lang_path: "lang",
  public_path: "public",
};

/** Laravel's test case classes: a test extending one boots the application. */
const BOOTING_TEST_CASES = new Set([
  "illuminate\\foundation\\testing\\testcase",
  "laravel\\lumen\\testing\\testcase",
]);

const BINDING_METHODS = new Set([
  "bind",
  "singleton",
  "scoped",
  "instance",
  "bindIf",
  "singletonIf",
  "scopedIf",
]);

/** Laravel's test request methods and the HTTP method each sends ("?": the first argument). */
const REQUEST_VERBS: Record<string, string> = {
  get: "GET",
  getJson: "GET",
  post: "POST",
  postJson: "POST",
  put: "PUT",
  putJson: "PUT",
  patch: "PATCH",
  patchJson: "PATCH",
  delete: "DELETE",
  deleteJson: "DELETE",
  options: "OPTIONS",
  optionsJson: "OPTIONS",
  head: "HEAD",
  json: "?",
  call: "?",
};

const hash = (parts: readonly string[]) => sha256(parts.join("\n"));
const lc = (s: string) => s.toLowerCase();

/** `A\B\C` → `$A$B$C`: a local name the graph can hold (no dots, no backslashes). */
const classKey = (fqcn: string) => `$${fqcn.replace(/\\/g, "$")}`;
const fnKey = (fqn: string) => `fn$${fqn.replace(/\\/g, "$")}`;
const constKey = (fqn: string) => `const$${fqn.replace(/\\/g, "$")}`;
const asPath = (fqn: string) => fqn.replace(/\\/g, "/");
const shortOf = (fqn: string) => fqn.slice(fqn.lastIndexOf("\\") + 1);

/** A string that names a class (`'App\Models\User'`): two segments at least. */
const CLASS_STRING = /^\\?[A-Za-z_][A-Za-z0-9_]*(?:\\[A-Za-z_][A-Za-z0-9_]*)+$/;

interface UseMaps {
  classes: Map<string, string>;
  functions: Map<string, string>;
  consts: Map<string, string>;
}

interface MemberInfo {
  name: string;
  kind: "method" | "property";
  /** Tokens [start, end] of the member (attributes included). */
  from: number;
  to: number;
  /** Header end (exclusive) for methods: the `{` or `;`. */
  headerEnd: number;
}

/** A binding of the Laravel container (`$this->app->singleton(Contract::class, Impl::class)`). */
export interface PhpBinding {
  /** The bound key: a class (fully qualified) or a string id. */
  key: string;
  isClass: boolean;
  /** The class the binding builds, when it can be read (`Impl::class`, `new Impl(…)`). */
  concrete?: string;
}

interface Collected {
  refs: Set<string>;
  uses: Set<string>;
  escapes: Set<string>;
  thisUses: Set<string>;
  superUses: Set<string>;
  thisEscapes: boolean;
  /** Requests a test makes (`http-request:GET /api/x`) and routes a route file defines. */
  resources: Set<string>;
}

const collected = (): Collected => ({
  refs: new Set(),
  uses: new Set(),
  escapes: new Set(),
  thisUses: new Set(),
  superUses: new Set(),
  thisEscapes: false,
  resources: new Set(),
});

/** Reads one file. `path` is project-relative POSIX. */
export function analyzePhp(path: string, content: string): FileAnalysis {
  try {
    return readPhp(path, content).analysis;
  } catch (error) {
    // Never a crash, never a silent gap: what the analyzer cannot read is uncertainty.
    return {
      path,
      hash: sha256(content),
      language: "php",
      moduleKind: "unknown",
      imports: [],
      symbols: [],
      localExports: [],
      topLevelRefs: [],
      topLevelHash: sha256(content),
      importsHash: hash([]),
      dynamicUnresolved: [
        `the PHP analyzer could not read this file (${String((error as Error).message).slice(0, 120)})`,
      ],
      parseErrors: 1,
      analyzerVersion: PHP_ANALYZER_VERSION,
    };
  }
}

/** The container bindings a file declares (service providers). */
export function phpBindings(path: string, content: string): PhpBinding[] {
  try {
    return readPhp(path, content).bindings;
  } catch {
    return [];
  }
}

function readPhp(
  path: string,
  content: string,
): { analysis: FileAnalysis; bindings: PhpBinding[] } {
  const { toks, errors: lexErrors } = tokenize(content);
  const pairs = bracketPairs(toks);
  // An unclosed bracket is a syntax error: the file is read whole (semantic-diff), never trusted.
  let errors = lexErrors;
  for (let k = 0; k < toks.length; k++)
    if (pairs[k] === -1 && /^(?:\(|\[|\{|#\[)$/.test((toks[k] as Tok).v)) errors++;
  const close = (open: number) => {
    const p = pairs[open];
    return p !== undefined && p >= 0 ? p : toks.length - 1;
  };
  const dir = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
  const srcLines = content.replace(/\r\n?/g, "\n").split("\n");
  const rawText = (start: number, end: number) => srcLines.slice(start - 1, end).join("\n");
  const range = (start: number, end: number) => ({
    start: { line: start, column: 0 },
    end: { line: end, column: (srcLines[end - 1] ?? "").length },
  });

  const imports: ImportRecord[] = [];
  const importKeys = new Set<string>();
  const symbols: SymbolRecord[] = [];
  const dynamicUnresolved: string[] = [];
  const dynamicHints: NonNullable<FileAnalysis["dynamicHints"]> = [];
  const bindings: PhpBinding[] = [];
  const moduleCode: Tok[] = [];
  const module = collected();

  /**
   * `// smarttest-loads: <glob>[, <glob>…]` (or after `#`, or in a block comment) on a dynamic line or the line
   * above: the author states, relative to the project root, what it may load. Those files become
   * its dependencies instead of uncertainty.
   */
  const declaredLoads = (line: number): string[] | undefined => {
    for (const l of [srcLines[line - 1], srcLines[line - 2]]) {
      const m = /smarttest-loads:\s*(.+?)\s*(?:\*\/)?$/.exec(l ?? "");
      if (m?.[1])
        return m[1]
          .split(",")
          .map((g) => g.trim())
          .filter(Boolean);
    }
    return undefined;
  };
  /** A name SmartTest cannot read: uncertainty, unless a `smarttest-loads:` comment says. */
  const unreadable = (what: string, line: number) => {
    const globs = declaredLoads(line);
    if (globs)
      for (const g of globs)
        dynamicHints.push({ pattern: `@root/${g.replace(/^\.?\//, "")}`, line, expr: what });
    else dynamicUnresolved.push(`${what} on line ${line}`);
  };
  const addImport = (rec: ImportRecord) => {
    const k = `${rec.kind}|${rec.specifier}|${rec.bindings.map((b) => b.local).join(",")}`;
    if (importKeys.has(k)) return;
    importKeys.add(k);
    imports.push(rec);
  };
  const sideEffect = (specifier: string, line: number) =>
    addImport({ specifier, kind: "side-effect", bindings: [], typeOnly: false, line });

  // ── Pre-pass: the class-likes declared here (a reference to one of them is a local name). ──
  const declared = new Map<string, string>(); // lc FQCN → short name
  {
    let ns = "";
    for (let k = 0; k < toks.length; k++) {
      const t = toks[k] as Tok;
      if (t.t !== "name") continue;
      const prev = toks[k - 1];
      if (t.v === "namespace" && toks[k + 1]?.t === "name" && prev?.v !== "\\") {
        ns = (toks[k + 1] as Tok).v.replace(/^\\/, "");
      } else if (
        (t.v === "class" || t.v === "interface" || t.v === "trait" || t.v === "enum") &&
        toks[k + 1]?.t === "name" &&
        prev?.v !== "::" &&
        prev?.v !== "new" &&
        prev?.v !== "->" &&
        !(t.v === "enum" && toks[k + 1]?.v === "extends")
      ) {
        const name = (toks[k + 1] as Tok).v;
        declared.set(lc(ns ? `${ns}\\${name}` : name), name);
      }
    }
  }

  // ── Name resolution ──
  let ns = "";
  let uses: UseMaps = { classes: new Map(), functions: new Map(), consts: new Map() };
  const qualify = (name: string, map: Map<string, string>): string => {
    if (name.startsWith("\\")) return name.slice(1);
    if (lc(name).startsWith("namespace\\")) return ns ? `${ns}\\${name.slice(10)}` : name.slice(10);
    const first = name.includes("\\") ? name.slice(0, name.indexOf("\\")) : name;
    const alias = map.get(lc(first));
    if (alias) return name.includes("\\") ? `${alias}${name.slice(first.length)}` : alias;
    return ns ? `${ns}\\${name}` : name;
  };
  const resolveClass = (name: string): string => {
    if (name.startsWith("\\") || name.includes("\\")) return qualify(name, uses.classes);
    return uses.classes.get(lc(name)) ?? (ns ? `${ns}\\${name}` : name);
  };

  /** The local name of a class reference, recording the import it needs. */
  const classRef = (fqcn: string, line: number, fromString = false): string => {
    const own = declared.get(lc(fqcn));
    if (own) return own;
    const local = classKey(fqcn);
    addImport({
      // A string that only looks like a class name is no reference when no class has it.
      specifier: `${fromString ? "@class-string" : "@class"}/${asPath(fqcn)}`,
      kind: "named",
      bindings: [{ imported: shortOf(fqcn), local }],
      typeOnly: false,
      line,
    });
    return local;
  };
  const functionRef = (name: string, line: number): string | undefined => {
    let specifier: string;
    let fqn: string;
    if (name.startsWith("\\") || name.includes("\\")) {
      fqn = qualify(name, uses.classes);
      specifier = `@fn/${asPath(fqn)}`;
    } else {
      const imported = uses.functions.get(lc(name));
      if (imported) {
        fqn = imported;
        specifier = `@fn/${asPath(fqn)}`;
      } else {
        // PHP's own functions cannot be redeclared: never a project function.
        if (!ns && PHP_FUNCTIONS.has(lc(name))) return undefined;
        if (ns && PHP_FUNCTIONS.has(lc(name))) {
          fqn = `${ns}\\${name}`;
          specifier = `@fn/${asPath(fqn)}`;
        } else {
          fqn = ns ? `${ns}\\${name}` : name;
          specifier = ns ? `@fn?/${asPath(fqn)}` : `@fn/${name}`;
        }
      }
    }
    const local = fnKey(fqn);
    addImport({
      specifier,
      kind: "named",
      bindings: [{ imported: shortOf(fqn), local }],
      typeOnly: false,
      line,
    });
    return local;
  };
  const constRef = (name: string, line: number): string | undefined => {
    let specifier: string;
    let fqn: string;
    if (name.startsWith("\\") || name.includes("\\")) {
      fqn = qualify(name, uses.classes);
      specifier = `@const/${asPath(fqn)}`;
    } else {
      const imported = uses.consts.get(name);
      if (imported) {
        fqn = imported;
        specifier = `@const/${asPath(fqn)}`;
      } else {
        if (NOT_CONSTANTS.has(name) || BUILTIN_CONSTANT.test(name)) return undefined;
        fqn = ns ? `${ns}\\${name}` : name;
        specifier = ns ? `@const?/${asPath(fqn)}` : `@const/${name}`;
      }
    }
    if (NOT_CONSTANTS.has(shortOf(fqn))) return undefined;
    const local = constKey(fqn);
    addImport({
      specifier,
      kind: "named",
      bindings: [{ imported: shortOf(fqn), local }],
      typeOnly: false,
      line,
    });
    return local;
  };

  /** Class names in a type (`?Foo`, `Foo|Bar`, `(A&B)|null`), as local names. */
  const typeNames = (from: number, to: number): string[] => {
    const out: string[] = [];
    for (let k = from; k < to; k++) {
      const t = toks[k] as Tok;
      if (t.t !== "name" || TYPE_KEYWORDS.has(lc(t.v))) continue;
      out.push(classRef(resolveClass(t.v), t.line));
    }
    return out;
  };

  // ── Literal paths (`__DIR__.'/x.php'`, `base_path('routes/api.php')`) ──
  const join = (base: string, rel: string) => {
    const parts = (base ? `${base}/${rel}` : rel).split("/");
    const out: string[] = [];
    for (const p of parts) {
      if (!p || p === ".") continue;
      if (p === ".." && out.length && out[out.length - 1] !== "..") out.pop();
      else out.push(p);
    }
    return out.join("/");
  };
  /**
   * Class constants holding a string or a list of classes (`const MIGRATION = '…'`,
   * `const HANDLERS = [A::class, B::class]`), read through `self::NAME` / `static::NAME`.
   */
  const constStrings = new Map<string, string>();
  const constClasses = new Map<string, string[]>();
  const selfConst = (k: number): string | undefined =>
    toks[k]?.t === "name" &&
    /^(?:self|static)$/i.test((toks[k] as Tok).v) &&
    toks[k + 1]?.v === "::" &&
    toks[k + 2]?.t === "name"
      ? (toks[k + 2] as Tok).v
      : undefined;
  {
    let cns = "";
    let cuses = new Map<string, string>();
    for (let k = 0; k < toks.length; k++) {
      const t = toks[k] as Tok;
      if (t.v === "namespace" && toks[k + 1]?.t === "name") {
        cns = (toks[k + 1] as Tok).v.replace(/^\\/, "");
        cuses = new Map();
      }
      if (t.v === "use" && toks[k + 1]?.t === "name" && /^[;{}]$/.test(toks[k - 1]?.v ?? ";")) {
        const fq = (toks[k + 1] as Tok).v.replace(/^\\/, "");
        const alias =
          toks[k + 2]?.v === "as" && toks[k + 3]?.t === "name"
            ? (toks[k + 3] as Tok).v
            : shortOf(fq);
        cuses.set(lc(alias), fq);
      }
      if (t.v !== "const") continue;
      let n = k + 1;
      if (toks[n + 1]?.t === "name" && toks[n + 2]?.v === "=") n++; // a typed constant
      const name = toks[n];
      if (name?.t !== "name" || toks[n + 1]?.v !== "=") continue;
      const v = toks[n + 2];
      if (v?.t === "str" && v.value !== undefined && /^[;,]$/.test(toks[n + 3]?.v ?? ""))
        constStrings.set(name.v, v.value);
      if (v?.v === "[") {
        const end = close(n + 2);
        const found: string[] = [];
        let ok = true;
        for (let j = n + 3; j < end && ok; j++) {
          const x = toks[j] as Tok;
          if (x.t === "name" && toks[j + 1]?.v === "::" && toks[j + 2]?.v === "class") {
            const first = x.v.includes("\\") ? x.v.slice(0, x.v.indexOf("\\")) : x.v;
            const fq = x.v.startsWith("\\")
              ? x.v.slice(1)
              : cuses.has(lc(first))
                ? `${cuses.get(lc(first))}${x.v.slice(first.length)}`
                : cns
                  ? `${cns}\\${x.v}`
                  : x.v;
            found.push(fq);
            j += 2;
          } else if (x.v !== "," && x.v !== "=>" && x.t !== "str" && x.t !== "num") ok = false;
        }
        if (ok && found.length) constClasses.set(name.v, found);
      }
    }
  }
  /** A path expression starting at `k`: its specifier and the index after it. */
  const pathAt = (k: number): { spec: string; next: number } | undefined => {
    const t = toks[k];
    if (!t) return undefined;
    const strAfterDot = (j: number) =>
      toks[j]?.v === "." && toks[j + 1]?.t === "str" && toks[j + 1]?.value !== undefined
        ? (toks[j + 1] as Tok).value
        : undefined;
    let base: string | undefined;
    let next = k + 1;
    if (t.t === "name" && (t.v === "__DIR__" || t.v === "\\__DIR__")) base = ".";
    else if (
      t.t === "name" &&
      (t.v === "dirname" || t.v === "\\dirname") &&
      toks[k + 1]?.v === "(" &&
      (toks[k + 2]?.v === "__DIR__" || toks[k + 2]?.v === "__FILE__")
    ) {
      const end = close(k + 1);
      const levels =
        toks[k + 3]?.v === "," && toks[k + 4]?.t === "num" ? Number(toks[k + 4]?.v) : 1;
      const up = toks[k + 2]?.v === "__FILE__" ? levels - 1 : levels;
      base = up <= 0 ? "." : Array.from({ length: up }, () => "..").join("/");
      next = end + 1;
    } else if (
      t.t === "name" &&
      t.v.replace(/^\\/, "") in LARAVEL_PATH_HELPERS &&
      toks[k + 1]?.v === "(" &&
      toks[k + 2]?.t === "str" &&
      toks[k + 2]?.value !== undefined &&
      toks[k + 3]?.v === ")"
    ) {
      const helperBase = LARAVEL_PATH_HELPERS[t.v.replace(/^\\/, "")] as string;
      const rel = (toks[k + 2] as Tok).value as string;
      return { spec: `@composer/${join(helperBase, rel)}`, next: k + 4 };
    } else if (
      t.t === "name" &&
      t.v.replace(/^\\/, "") in LARAVEL_PATH_HELPERS &&
      toks[k + 1]?.v === "(" &&
      selfConst(k + 2) !== undefined &&
      constStrings.has(selfConst(k + 2) as string) &&
      toks[k + 5]?.v === ")"
    ) {
      const helperBase = LARAVEL_PATH_HELPERS[t.v.replace(/^\\/, "")] as string;
      const rel = constStrings.get(selfConst(k + 2) as string) as string;
      return { spec: `@composer/${join(helperBase, rel)}`, next: k + 6 };
    } else return undefined;
    const rel = strAfterDot(next);
    if (rel === undefined) return { spec: base === "." ? "./" : `${base}/`, next };
    const joined = join(base === "." ? "" : base, rel);
    return {
      spec: joined.startsWith("..") ? joined : `./${joined}`,
      next: next + 2,
    };
  };
  /** Literal path assignments (`$file = __DIR__.'/../bootstrap/app.php';`), for `require $file`. */
  const pathVars = new Map<string, string>();
  for (let k = 0; k + 2 < toks.length; k++) {
    const t = toks[k] as Tok;
    if (t.t !== "var" || toks[k + 1]?.v !== "=") continue;
    const p = pathAt(k + 2);
    if (p && (toks[p.next]?.v === ";" || toks[p.next]?.v === ")")) pathVars.set(t.v, p.spec);
  }
  /** Files named by path anywhere: loaded by Laravel (routes, configs) or by `require`. */
  const LOADERS = new Set([
    "loadRoutesFrom",
    "loadMigrationsFrom",
    "loadViewsFrom",
    "loadTranslationsFrom",
    "mergeConfigFrom",
    "loadJsonTranslationsFrom",
  ]);
  /** A route file (`routes/…`): Laravel registers its routes; what they name runs per request. */
  const routeTarget = (spec: string) =>
    /(?:^|\/)routes\//.test(spec.startsWith("@composer/") ? spec.slice(10) : join(dir, spec));
  const include = (spec: string, line: number) =>
    routeTarget(spec)
      ? addImport({
          specifier: spec,
          kind: "side-effect",
          bindings: [],
          typeOnly: false,
          line,
          load: true,
        })
      : sideEffect(spec, line);
  const pathTarget = (spec: string, line: number, expr: string) => {
    const file = /\.php$/i.test(spec);
    if (file) {
      const normalized =
        spec.startsWith("./") && dir ? `./${spec.slice(2)}` : spec === "./" ? "." : spec;
      include(normalized, line);
      return;
    }
    // A folder (`loadMigrationsFrom(__DIR__.'/../database/migrations')`): every PHP file in it.
    const rel = spec.startsWith("@composer/") ? undefined : join(dir, spec);
    if (rel !== undefined && !rel.startsWith(".."))
      dynamicHints.push({ pattern: `@root/${rel ? `${rel}/` : ""}**/*.php`, line, expr });
  };
  for (let k = 0; k < toks.length; k++) {
    const t = toks[k] as Tok;
    const isInclude =
      t.t === "name" &&
      /^(?:require|include)(?:_once)?$/i.test(t.v) &&
      !["->", "?->", "::", "function"].includes(toks[k - 1]?.v ?? "");
    if (isInclude) {
      let j = k + 1;
      const paren = toks[j]?.v === "(";
      if (paren) j++;
      const p = pathAt(j);
      const v = toks[j];
      if (p) {
        pathTarget(p.spec, t.line, "");
        k = p.next - 1;
      } else if (v?.t === "str" && v.value !== undefined && /\.php$/i.test(v.value)) {
        // Relative to the including file's folder (PHP looks there after the include path).
        const rel = v.value;
        include(rel.startsWith("/") ? rel : rel.startsWith(".") ? rel : `./${rel}`, t.line);
      } else if (v?.t === "var" && pathVars.has(v.v)) {
        pathTarget(pathVars.get(v.v) as string, t.line, v.v);
      } else {
        unreadable(`${t.v} with a path built at run time`, t.line);
      }
      continue;
    }
    // Laravel loaders and any other literal PHP file path in the code.
    const p = pathAt(k);
    if (p) {
      const loader = toks[k - 2]?.t === "name" && LOADERS.has((toks[k - 2] as Tok).v);
      if (/\.php$/i.test(p.spec) || loader) pathTarget(p.spec, t.line, "");
      k = p.next - 1;
    }
  }

  // ── The walker: what a run of tokens references. ──
  /** Literal class lists held by variables (`foreach ([A::class, B::class] as $m)`). */
  const classValuesOf = (from: number, upTo: number): Map<string, string[]> => {
    const to = Math.min(upTo, toks.length);
    const out = new Map<string, string[]>();
    const classesIn = (a: number, b: number): string[] | undefined => {
      const found: string[] = [];
      for (let k = a; k < b; k++) {
        const t = toks[k] as Tok;
        if (t.t === "name" && toks[k + 1]?.v === "::" && toks[k + 2]?.v === "class") {
          found.push(resolveClass(t.v));
          k += 2;
        } else if (t.t === "str" && t.value !== undefined && CLASS_STRING.test(t.value)) {
          found.push(t.value.replace(/^\\/, ""));
        } else if (t.v !== "," && t.v !== "=>" && t.t !== "str" && t.t !== "num") return undefined;
      }
      return found.length ? found : undefined;
    };
    for (let k = from; k < to; k++) {
      const t = toks[k] as Tok;
      // $m = A::class;
      if (
        t.t === "var" &&
        toks[k + 1]?.v === "=" &&
        toks[k + 2]?.t === "name" &&
        toks[k + 3]?.v === "::" &&
        toks[k + 4]?.v === "class" &&
        toks[k + 5]?.v === ";"
      )
        out.set(t.v, [...(out.get(t.v) ?? []), resolveClass((toks[k + 2] as Tok).v)]);
      // foreach (self::HANDLERS as $h): a constant list of classes
      if (t.v === "foreach" && toks[k + 1]?.v === "(" && selfConst(k + 2) !== undefined) {
        const list = constClasses.get(selfConst(k + 2) as string);
        let v = k + 5;
        if (list && toks[k + 5]?.v === "as") {
          v = k + 6;
          if (toks[v + 1]?.v === "=>") v += 2;
          const target = toks[v];
          if (target?.t === "var") out.set(target.v, [...(out.get(target.v) ?? []), ...list]);
        }
      }
      // foreach (… config('prospection.connectors') … as $class): the classes that file names.
      if (t.v === "foreach" && toks[k + 1]?.v === "(") {
        const end = close(k + 1);
        let keyName: string | undefined;
        let as = -1;
        for (let j = k + 2; j < end; j++) {
          const x = toks[j] as Tok;
          if (x.v === "config" && toks[j + 1]?.v === "(" && toks[j + 2]?.t === "str")
            keyName = toks[j + 2]?.value;
          if (x.v === "as" && x.t === "name") as = j;
        }
        if (keyName && as > 0) {
          let v = as + 1;
          if (toks[v + 1]?.v === "=>") v += 2;
          const target = toks[v];
          if (target?.t === "var")
            out.set(target.v, [`@config:${keyName.split(".")[0] as string}`]);
        }
      }
      // foreach ([A::class, …] as $m) / foreach ([… => A::class] as $k => $m)
      if (t.v === "foreach" && toks[k + 1]?.v === "(" && toks[k + 2]?.v === "[") {
        const listEnd = close(k + 2);
        const classes = classesIn(k + 3, listEnd);
        if (classes && toks[listEnd + 1]?.v === "as") {
          let v = listEnd + 2;
          if (toks[v + 1]?.v === "=>") v += 2;
          const target = toks[v];
          if (target?.t === "var") out.set(target.v, [...(out.get(target.v) ?? []), ...classes]);
        }
      }
    }
    return out;
  };

  /** Typed parameters of a parameter list `(…)`: variable → class local names. */
  const paramTypes = (
    open: number,
    into: Map<string, string[]>,
    promoted?: Map<string, string[]>,
  ) => {
    const end = close(open);
    let start = open + 1;
    const flush = (a: number, b: number) => {
      // [#[…]] [modifiers] [type] [&] [...] $var [= default]
      let k = a;
      while (k < b && toks[k]?.v === "#[") k = close(k) + 1;
      let isPromoted = false;
      while (
        k < b &&
        /^(?:public|protected|private|readonly)$/i.test((toks[k] as Tok).v) &&
        (toks[k] as Tok).t === "name"
      ) {
        isPromoted = true;
        k++;
      }
      let v = k;
      while (v < b && (toks[v] as Tok).t !== "var") v++;
      if (v >= b) return;
      let typeEnd = v;
      while (typeEnd > k && (toks[typeEnd - 1]?.v === "&" || toks[typeEnd - 1]?.v === "..."))
        typeEnd--;
      const types = typeNames(k, typeEnd);
      const name = (toks[v] as Tok).v;
      if (types.length) {
        into.set(name, types);
        if (isPromoted && promoted) promoted.set(`$${name.slice(1)}`, types);
      }
    };
    for (let k = open + 1; k < end; k++) {
      const t = toks[k] as Tok;
      if (t.v === "(" || t.v === "[" || t.v === "{" || t.v === "#[") {
        k = close(k);
        continue;
      }
      if (t.v === ",") {
        flush(start, k);
        start = k + 1;
      }
    }
    flush(start, end);
  };

  const CONTAINER_RECEIVER = (k: number): boolean => {
    // `app()->make(`, `$this->app->make(`, `$app->make(`, `App::make(`, `$container->make(`
    const recv = toks[k - 2];
    if (!recv) return false;
    if (toks[k - 1]?.v === "::")
      return (
        recv.t === "name" && /^\\?(?:App|Container|Illuminate\\Support\\Facades\\App)$/.test(recv.v)
      );
    if (recv.v === ")") {
      const open = pairs[k - 2];
      const fn = open !== undefined && open > 0 ? toks[open - 1] : undefined;
      // app()->make(…): the container; app(X::class)->make(…) is a method of X.
      return fn?.t === "name" && /^\\?app$/.test(fn.v) && open === k - 3;
    }
    return recv.t === "name"
      ? recv.v === "app" && toks[k - 3]?.v === "->" && toks[k - 4]?.v === "$this"
      : recv.t === "var" && /^\$(?:app|container)$/i.test(recv.v);
  };

  // ── HTTP requests in tests and routes in route files (Laravel, preview) ──
  const testish = /(?:^|\/)tests?\//i.test(path) || PHP_TEST_FILE.test(path);
  /** The arguments of the call whose `(` is at `open`: [from, to) ranges. */
  const argRanges = (open: number): [number, number][] => {
    const end = close(open);
    const out: [number, number][] = [];
    let start = open + 1;
    for (let k = open + 1; k < end; k++) {
      const v = toks[k]?.v;
      if (v === "(" || v === "[" || v === "{" || v === "#[") k = close(k);
      else if (v === ",") {
        out.push([start, k]);
        start = k + 1;
      }
    }
    if (start < end) out.push([start, end]);
    return out;
  };
  /** Literal url assignments (`$url = '/api/posts';`), by variable. */
  const urlVars = new Map<string, string>();
  for (let k = 0; k + 3 < toks.length; k++) {
    const t = toks[k] as Tok;
    if (
      t.t === "var" &&
      toks[k + 1]?.v === "=" &&
      toks[k + 2]?.t === "str" &&
      toks[k + 2]?.value !== undefined &&
      toks[k + 3]?.v === ";"
    )
      urlVars.set(t.v, toks[k + 2]?.value as string);
  }
  /** What a url argument reads as: a path (`*` where computed), a route name, or nothing. */
  const evalUrl = (a: number, b: number): { path?: string; name?: string } => {
    let out = "";
    let literal = false;
    for (let k = a; k < b; k++) {
      const t = toks[k] as Tok;
      if (t.inString) continue;
      if (t.t === "str") {
        literal = true;
        out +=
          t.value ??
          t.v
            .replace(/^[bB]?["'`]|["'`]$/g, "")
            .replace(/\{\$[^}]*\}|\$\{[^}]*\}|\$[A-Za-z_]\w*(?:(?:->|\?->)\w+|\[[^\]]*\])*/g, "*");
        continue;
      }
      if (t.v === ".") continue;
      const fn = t.t === "name" ? lc(t.v.replace(/^\\/, "")) : "";
      if ((fn === "route" || fn === "to_route") && toks[k + 1]?.v === "(") {
        const first = argRanges(k + 1)[0];
        const n = first && first[1] - first[0] === 1 ? toks[first[0]] : undefined;
        return n?.t === "str" && n.value !== undefined ? { name: n.value } : {};
      }
      if (fn === "url" && toks[k + 1]?.v === "(") {
        const first = argRanges(k + 1)[0];
        const inner = first ? evalUrl(first[0], first[1]) : {};
        if (inner.path === undefined) return {};
        out += inner.path;
        literal = true;
        k = close(k + 1);
        continue;
      }
      if (fn === "sprintf" && toks[k + 1]?.v === "(" && toks[k + 2]?.t === "str") {
        const f = toks[k + 2]?.value;
        if (f === undefined) return {};
        out += f.replace(/%[-+ 0#]*\d*(?:\.\d+)?[bcdeEfFgGosuxX]/g, "*");
        literal = true;
        k = close(k + 1);
        continue;
      }
      const constName = selfConst(k);
      if (constName !== undefined && constStrings.has(constName)) {
        out += constStrings.get(constName);
        literal = true;
        k += 2;
        continue;
      }
      if (t.t === "var" && urlVars.has(t.v) && toks[k + 1]?.v !== "->" && toks[k + 1]?.v !== "[") {
        out += urlVars.get(t.v);
        literal = true;
        continue;
      }
      if (t.v === "(" || t.v === "[") k = close(k);
      if (!out.endsWith("*")) out += "*";
    }
    if (!literal) return {};
    const path = out.replace(/^https?:\/\/[^/]*/i, "").replace(/\*+/g, "*");
    // Nothing but computed parts (`$url`, `"/{$x}"`); the root `/` itself is a path.
    if (path.includes("*") && !path.replace(/[*/]/g, "")) return {};
    return { path: path.startsWith("/") || path.startsWith("*") ? path : `/${path}` };
  };
  /** The variable a call chain starts from (`$this` in `$this->actingAs($u)->getJson(…)`). */
  const chainRoot = (k: number): string | undefined => {
    let j = k - 1; // the `->` before the method name
    while (j > 0) {
      const p = toks[j - 1] as Tok | undefined;
      if (!p) return undefined;
      if (p.t === "var") return p.v;
      if (p.v === ")") {
        const o = pairs[j - 1];
        if (o === undefined || o < 1) return undefined;
        j = o; // at the `(`: the method name is before it
        const name = toks[j - 1];
        if (name?.t !== "name") return undefined;
        if (toks[j - 2]?.v !== "->" && toks[j - 2]?.v !== "?->") return undefined;
        j -= 2;
        continue;
      }
      if (p.t === "name" && (toks[j - 2]?.v === "->" || toks[j - 2]?.v === "?->")) {
        j -= 2; // a property in the chain
        continue;
      }
      return undefined;
    }
    return undefined;
  };
  /** The command named by the first argument of the call whose `(` is at `open`. */
  const command = (open: number, c: Collected, line: number) => {
    const first = argRanges(open)[0];
    if (!first) return;
    const n = first[1] - first[0] === 1 ? toks[first[0]] : undefined;
    const name = n?.t === "str" ? /^\s*(\S+)/.exec(n.value ?? "")?.[1] : undefined;
    const cls = classOf3(first);
    if (cls) c.escapes.add(cls);
    else if (name) c.resources.add(`http-request:ARTISAN /${name}`);
    else unreadable("a command named at run time", line);
  };
  const classOf3 = (r: [number, number]): string | undefined =>
    r[1] - r[0] === 3 &&
    toks[r[0]]?.t === "name" &&
    toks[r[0] + 1]?.v === "::" &&
    toks[r[0] + 2]?.v === "class"
      ? classRef(resolveClass((toks[r[0]] as Tok).v), (toks[r[0]] as Tok).line)
      : undefined;
  const request = (
    k: number,
    c: Collected,
    owner?: { name: string; params: readonly string[] },
  ) => {
    const t = toks[k] as Tok;
    if (chainRoot(k) !== "$this") return;
    const args = argRanges(k + 1);
    let method = REQUEST_VERBS[t.v] as string;
    let url = args[0];
    let methodVar: string | undefined;
    if (method === "?") {
      // json('GET', $uri, …) / call('POST', $uri, …)
      const m = args[0] && args[0][1] - args[0][0] === 1 ? toks[args[0][0]] : undefined;
      method = m?.t === "str" && m.value ? m.value.toUpperCase() : "*";
      if (m?.t === "var") methodVar = m.v;
      url = args[1];
    }
    if (!url) return;
    // A request helper (`authenticatedRequest($method, $uri)`): the url is its parameter, so its
    // callers say which: each call is a request (see http-call), not this method.
    const urlTok = url[1] - url[0] === 1 ? toks[url[0]] : undefined;
    if (owner && urlTok?.t === "var" && owner.params.includes(urlTok.v)) {
      const m =
        methodVar && owner.params.includes(methodVar)
          ? `@${owner.params.indexOf(methodVar)}`
          : method;
      c.resources.add(`http-wrapper:${owner.name}:${owner.params.indexOf(urlTok.v)}:${m}`);
      return;
    }
    const r = evalUrl(url[0], url[1]);
    if (r.name !== undefined) c.resources.add(`http-request-name:${r.name}`);
    else if (r.path !== undefined) c.resources.add(`http-request:${method} ${r.path}`);
    else unreadable(`a request to a url built at run time (${t.v})`, t.line);
  };

  /**
   * Reads tokens [from, to) into `c`. `self` is the class the code belongs to (its short name),
   * `props` the typed properties of that class.
   */
  const walk = (
    from: number,
    upTo: number,
    c: Collected,
    ctx: {
      self?: string;
      props?: Map<string, string[]>;
      params?: Map<string, string[]>;
      /** A parameter list: its variables are declared here, not used. */
      declaring?: boolean;
      /** Parameters of a private method every caller passes `X::class` to: those classes. */
      paramClasses?: Map<string, string[]>;
      /** The method the code belongs to, and its parameter names in order. */
      owner?: { name: string; params: readonly string[] };
    },
  ) => {
    const to = Math.min(upTo, toks.length);
    const types = new Map<string, string[]>(ctx.params ?? []);
    const values = classValuesOf(from, to);
    for (const [v, l] of ctx.paramClasses ?? []) if (!values.has(v)) values.set(v, l);
    /** A class value: a class, or `@config:<file>` (the classes a config file names). */
    const valueRef = (cls: string, line: number): string | undefined => {
      if (!cls.startsWith("@config:")) return classRef(cls, line);
      sideEffect(`@composer/config/${cls.slice(8)}.php`, line);
      return undefined;
    };
    const dynamic = unreadable;
    const useMember = (local: string, member: string) => {
      c.refs.add(local);
      c.uses.add(`${local}.${member}`);
    };
    const memberAfter = (k: number): string | undefined => {
      // `->name(` → name; `->name` → $name
      const n = toks[k];
      if (n?.t !== "name") return undefined;
      return toks[k + 1]?.v === "(" ? n.v : `$${n.v}`;
    };
    /** Name tokens already read as classes (attribute names, anonymous class headers). */
    const skip = new Set<number>();
    /** The argument of `app(…)`, `resolve(…)`, `->make(…)` at `j`. */
    const container = (j: number) => {
      const a = toks[j];
      if (!a || a.v === ")") return;
      const after = toks[j + 1]?.v;
      const single = after === ")" || after === ",";
      if (a.t === "name" && toks[j + 1]?.v === "::") return; // X::class, self::class: read as such
      if (a.t === "str" && a.value !== undefined && single) {
        if (!CLASS_STRING.test(a.value)) sideEffect(`@bind-key/${a.value}`, a.line);
        return; // a class string is read as a class
      }
      if (a.t === "var" && single) {
        const known = values.get(a.v);
        if (known) {
          for (const cls of known) {
            const r = valueRef(cls, a.line);
            if (r) c.escapes.add(r);
          }
          return;
        }
      }
      dynamic(`a container lookup with an id computed at run time (${a.v}…)`, a.line);
    };
    for (let k = from; k < to; k++) {
      const t = toks[k] as Tok;
      const prev = toks[k - 1];
      const next = toks[k + 1];
      if (skip.has(k)) continue;
      // #[Attr(…), Other]: attribute names are classes; their arguments are code.
      if (t.v === "#[") {
        const end = close(k);
        for (let j = k + 1; j < end; j++) {
          const n = toks[j] as Tok;
          if (n.t === "name" && (j === k + 1 || toks[j - 1]?.v === ",")) {
            c.refs.add(classRef(resolveClass(n.v), n.line));
            skip.add(j);
          }
          if (n.v === "(" || n.v === "[") j = close(j);
        }
        continue;
      }
      // Closures and arrow functions: their typed parameters type their variables.
      if (
        t.t === "name" &&
        (t.v === "function" || t.v === "fn") &&
        (next?.v === "(" || (next?.v === "&" && toks[k + 2]?.v === "("))
      ) {
        const open = next?.v === "(" ? k + 1 : k + 2;
        paramTypes(open, types);
        walk(open + 1, close(open), c, { ...ctx, declaring: true });
        k = close(open);
        continue;
      }
      if (t.t === "var") {
        if (t.v === "$this") {
          if (next?.v === "->" || next?.v === "?->") {
            const n = toks[k + 2];
            if (n?.t === "var") {
              // $this->$method(): any member of this class.
              c.thisEscapes = true;
              continue;
            }
            const member = memberAfter(k + 2);
            if (!member) continue;
            // $this->artisan('prospection:enrich --dry'): a command a test runs.
            if (testish && next?.v === "->" && n?.v === "artisan" && toks[k + 3]?.v === "(") {
              command(k + 3, c, n.line);
              k += 2;
              continue;
            }
            // $this->authenticatedRequest('GET', '/api/x'): maybe a request helper's call. Each
            // argument is recorded as a url, an HTTP method or `?`; the graph keeps the calls of
            // methods that are request helpers (http-wrapper).
            if (
              testish &&
              next?.v === "->" &&
              n?.t === "name" &&
              toks[k + 3]?.v === "(" &&
              !(n.v in REQUEST_VERBS) &&
              !/^(?:assert|expect|actingAs$|be$|with|without|from$|following|travel|freeze|mock|partialMock|spy$|seed|instance$|swap$)/.test(
                n.v,
              )
            ) {
              const args = argRanges(k + 3);
              if (args.length)
                c.resources.add(
                  `http-call:${n.v}|${args
                    .map(([a, b]) => {
                      const one = b - a === 1 ? toks[a] : undefined;
                      if (one?.t === "str" && one.value && /^[A-Za-z]+$/.test(one.value))
                        return one.value.toUpperCase();
                      const r = evalUrl(a, b);
                      return r.path?.startsWith("/") ? r.path : r.name ? `name:${r.name}` : "?";
                    })
                    .join("|")}`,
                );
            }
            // $this->getJson('/api/x'): a request of a test.
            if (
              testish &&
              next?.v === "->" &&
              n &&
              n.v in REQUEST_VERBS &&
              toks[k + 3]?.v === "("
            ) {
              request(k + 2, c, ctx.owner);
              k += 2;
              continue;
            }
            c.thisUses.add(member);
            // $this->repo->find(): the property's type is known.
            const propTypes = member.startsWith("$") ? ctx.props?.get(member) : undefined;
            if (propTypes) {
              const after = toks[k + 3];
              if (after?.v === "->" || after?.v === "?->") {
                const m = memberAfter(k + 4);
                if (m) for (const ty of propTypes) useMember(ty, m);
              } else if (after?.v !== "=" && after?.v !== "??=")
                for (const ty of propTypes) c.escapes.add(ty);
            }
            k += 2;
            continue;
          }
          if (next?.v === "::") {
            // $this::X, $this::m(): as static::
            const n = toks[k + 2];
            if (n?.t === "name" && lc(n.v) !== "class") c.thisUses.add(n.v);
            else if (n?.t === "var") c.thisUses.add(n.v);
            k += 2;
            continue;
          }
          // $this passed on, returned or stored: callers can reach any member.
          if (!(prev?.v === "->" || prev?.v === "?->")) c.thisEscapes = true;
          continue;
        }
        // $var::member — a class held by a variable
        if (next?.v === "::") {
          const n = toks[k + 2];
          if (n?.v === "class") continue; // $e::class: its name only
          const known = values.get(t.v) ?? types.get(t.v);
          if (known && n?.t === "name") {
            for (const cls of known) {
              const r = values.has(t.v) ? valueRef(cls, t.line) : cls;
              if (r) useMember(r, n.v);
            }
          } else if (known && n?.t === "var") {
            for (const cls of known) {
              const r = values.has(t.v) ? valueRef(cls, t.line) : cls;
              if (r) c.escapes.add(r);
            }
          } else dynamic(`${t.v}::${n?.v ?? ""} (a class held in a variable)`, t.line);
          continue;
        }
        const typed = ctx.declaring ? undefined : types.get(t.v);
        if (typed) {
          if (next?.v === "->" || next?.v === "?->") {
            const n = toks[k + 2];
            if (n?.t === "var") {
              for (const ty of typed) c.escapes.add(ty);
              continue;
            }
            const m = memberAfter(k + 2);
            if (m) for (const ty of typed) useMember(ty, m);
            k += 2;
            continue;
          }
          // Assigned, compared or tested: not a use of the object. Anything else passes it on.
          if (
            !(
              next?.v === "=" ||
              next?.v === "??=" ||
              next?.v === "===" ||
              next?.v === "!==" ||
              next?.v === "==" ||
              next?.v === "!=" ||
              next?.v === "instanceof" ||
              (prev?.v === "(" &&
                (toks[k - 2]?.v === "isset" || toks[k - 2]?.v === "empty") &&
                next?.v === ")")
            )
          )
            for (const ty of typed) c.escapes.add(ty);
          continue;
        }
        // $obj->$method(): a member chosen at run time on an object of unknown class.
        if (
          (next?.v === "->" || next?.v === "?->") &&
          toks[k + 2]?.t === "var" &&
          toks[k + 3]?.v === "("
        )
          dynamic(`${t.v}->${(toks[k + 2] as Tok).v}() (a method chosen at run time)`, t.line);
        continue;
      }
      if (t.t === "str") {
        if (t.inString) continue;
        // 'App\Models\User': a class named by a string.
        if (t.value !== undefined && CLASS_STRING.test(t.value) && !/\\\\/.test(t.value)) {
          const fqcn = t.value.replace(/^\\/, "");
          if (fqcn.split("\\").every((s) => /^[A-Za-z_]\w*$/.test(s)))
            c.escapes.add(classRef(fqcn, t.line, true));
          continue;
        }
        // 'App\Models\' . $name, "App\\Models\\{$name}": a class name built at run time.
        const prefix = t.value ?? t.v.slice(1, -1).replace(/\\\\/g, "\\");
        const looksLikeNamespace = /^\\?[A-Z][A-Za-z0-9_]*\\(?:[A-Za-z0-9_]+\\)*/.test(prefix);
        if (
          looksLikeNamespace &&
          ((t.value?.endsWith("\\") && next?.v === ".") ||
            (t.interpolated && /\\\\?\{?\$/.test(t.v)))
        )
          dynamic(`a class name built from "${prefix.slice(0, 60)}"`, t.line);
        continue;
      }
      if (t.t !== "name") continue;
      const word = t.v;
      const lw = lc(word);
      // $this->getJson('/api/posts/1'), $this->actingAs($u)->post(route('posts.store'), …)
      if (testish && prev?.v === "->" && next?.v === "(" && t.v in REQUEST_VERBS) {
        request(k, c, ctx.owner);
        continue;
      }
      if (prev?.v === "->" || prev?.v === "?->") continue; // a member name
      if (prev?.v === "::") continue; // read with the class before it
      if (prev?.t === "name" && (lc(prev.v) === "function" || lc(prev.v) === "const")) continue;
      if (lw === "new") {
        const n = next;
        if (n?.t === "name" && (lc(n.v) === "class" || lc(n.v) === "readonly")) {
          // An anonymous class: what it extends, implements and uses is used whole.
          let h = k + 2;
          if (toks[h]?.v === "(") h = close(h) + 1;
          for (; h < to && toks[h]?.v !== "{"; h++) {
            const x = toks[h] as Tok;
            if (x.t === "name" && !/^(?:extends|implements|class|readonly)$/i.test(x.v)) {
              c.escapes.add(classRef(resolveClass(x.v), x.line));
              skip.add(h);
            }
          }
          const body = toks[h]?.v === "{" ? close(h) : h;
          for (let b = h + 1; b < body; b++)
            if (toks[b]?.v === "use" && toks[b - 1] && /^[;{}]$/.test((toks[b - 1] as Tok).v))
              for (let u = b + 1; u < body && toks[u]?.v !== ";" && toks[u]?.v !== "{"; u++) {
                const x = toks[u] as Tok;
                if (x.t === "name") {
                  c.escapes.add(classRef(resolveClass(x.v), x.line));
                  skip.add(u);
                }
              }
          k += 1;
          continue;
        }
        if (n?.t === "name") {
          const nl = lc(n.v);
          if (nl === "static" || nl === "self") c.thisEscapes = true;
          else if (nl === "parent") c.superUses.add("constructor");
          else c.escapes.add(classRef(resolveClass(n.v), n.line));
          k++;
        } else if (n?.t === "var") {
          const known = values.get(n.v) ?? types.get(n.v);
          if (known)
            for (const cls of known) {
              const r = values.has(n.v) ? valueRef(cls, n.line) : cls;
              if (r) c.escapes.add(r);
            }
          else dynamic(`new ${n.v} (a class chosen at run time)`, n.line);
          k++;
        } else if (n?.v === "(") dynamic("new (…) (a class chosen at run time)", t.line);
        continue;
      }
      if (lw === "instanceof") {
        const n = next;
        if (n?.t === "name" && !TYPE_KEYWORDS.has(lc(n.v))) {
          c.refs.add(classRef(resolveClass(n.v), n.line));
          k++;
        }
        continue;
      }
      if (lw === "catch" && next?.v === "(") {
        const end = close(k + 1);
        for (const n of typeNames(k + 2, end)) c.refs.add(n);
        k = end;
        continue;
      }
      // X::member
      if (next?.v === "::") {
        const member = toks[k + 2];
        if (lw === "self" || lw === "static") {
          if (member?.t === "name" && lc(member.v) !== "class") c.thisUses.add(member.v);
          else if (member?.t === "var" && toks[k + 3]?.v === "(") c.thisEscapes = true;
          else if (member?.t === "var") c.thisUses.add(member.v);
          k += 2;
          continue;
        }
        if (lw === "parent") {
          if (member?.t === "name")
            c.superUses.add(lc(member.v) === "__construct" ? "constructor" : member.v);
          k += 2;
          continue;
        }
        // Artisan::call('x:y') in a test: the command it runs.
        if (
          testish &&
          lc(resolveClass(word)) === "illuminate\\support\\facades\\artisan" &&
          (member?.v === "call" || member?.v === "queue") &&
          toks[k + 3]?.v === "("
        )
          command(k + 3, c, t.line);
        const local = classRef(resolveClass(word), t.line);
        if (member?.t === "name" && lc(member.v) === "class") {
          // [X::class, 'method']: a callable — the method and the constructor.
          const callable =
            prev?.v === "[" &&
            toks[k + 3]?.v === "," &&
            toks[k + 4]?.t === "str" &&
            toks[k + 5]?.v === "]";
          if (callable && toks[k + 4]?.value) {
            useMember(local, toks[k + 4]?.value as string);
            useMember(local, "constructor");
          } else c.escapes.add(local);
          k += 2;
          continue;
        }
        if (member?.t === "name") useMember(local, member.v);
        else if (member?.t === "var" && toks[k + 3]?.v === "(")
          dynamic(`${word}::${member.v}() (a method chosen at run time)`, t.line);
        else if (member?.t === "var") useMember(local, member.v);
        else c.escapes.add(local);
        k += 2;
        continue;
      }
      if (next?.v === "(") {
        if (NOT_CALLS.has(lw)) continue;
        const bare = word.replace(/^\\/, "");
        const lb = lc(bare);
        // The container: app(X::class) and resolve(X::class) are read as X::class; a string id
        // links to its binding; anything else is a class chosen at run time.
        if ((lb === "app" || lb === "resolve") && !word.includes("\\", 1)) {
          container(k + 2);
        }
        if (
          (lb === "call_user_func" || lb === "call_user_func_array") &&
          toks[k + 2] &&
          !(toks[k + 2]?.t === "str" && toks[k + 2]?.value !== undefined) &&
          toks[k + 2]?.v !== "[" &&
          toks[k + 2]?.v !== "function" &&
          toks[k + 2]?.v !== "fn" &&
          toks[k + 2]?.v !== "static"
        )
          dynamic(`${bare}(${toks[k + 2]?.v ?? ""}…) (a callable chosen at run time)`, t.line);
        if (lb === "call_user_func" || lb === "call_user_func_array") {
          const s = toks[k + 2];
          if (s?.t === "str" && s.value?.includes("::")) {
            const [cls, m] = s.value.split("::") as [string, string];
            if (CLASS_STRING.test(cls) || /^[A-Za-z_]\w*$/.test(cls))
              useMember(classRef(resolveClass(cls.startsWith("\\") ? cls : `\\${cls}`), s.line), m);
          }
        }
        const local = functionRef(word, t.line);
        if (local) c.refs.add(local);
        continue;
      }
      if (TYPE_KEYWORDS.has(lw) || NOT_CALLS.has(lw)) continue;
      // A bare name: a class in a type position (`Foo $x`, `?Foo`, `A|B`): its members are linked
      // where they are used. Otherwise a constant.
      // (In code, `A | B` is a bitwise or of constants: only a parameter list has union types.)
      if (
        next?.t === "var" ||
        (ctx.declaring && (prev?.v === "?" || prev?.v === "|" || next?.v === "|")) ||
        (prev?.v === ":" &&
          (toks[k - 2]?.v === ")" || toks[k - 2]?.v === "?") &&
          (next?.v === "{" || next?.v === "=>"))
      ) {
        classRef(resolveClass(word), t.line);
        continue;
      }
      if (/^[A-Z_][A-Z0-9_]*$/.test(word.replace(/^.*\\/, "")) || word.includes("\\")) {
        const local = constRef(word, t.line);
        if (local) c.refs.add(local);
      }
    }
    // ->make(X) / ->makeWith(X) on a container
    for (let k = from; k < to; k++) {
      const t = toks[k] as Tok;
      if (
        t.t === "name" &&
        (t.v === "make" || t.v === "makeWith") &&
        toks[k + 1]?.v === "(" &&
        (toks[k - 1]?.v === "->" || toks[k - 1]?.v === "::") &&
        CONTAINER_RECEIVER(k)
      )
        container(k + 2);
      // ->bind(…) / ->singleton(…): the container bindings this file declares.
      if (
        t.t === "name" &&
        BINDING_METHODS.has(t.v) &&
        toks[k + 1]?.v === "(" &&
        (toks[k - 1]?.v === "->" || toks[k - 1]?.v === "::")
      )
        readBinding(k + 1);
    }
  };

  const readBinding = (open: number) => {
    const end = close(open);
    // First argument
    const a = toks[open + 1];
    if (!a) return;
    let key: string | undefined;
    let isClass = false;
    let at = open + 2;
    if (a.t === "name" && toks[open + 2]?.v === "::" && toks[open + 3]?.v === "class") {
      key = resolveClass(a.v);
      isClass = true;
      at = open + 4;
    } else if (a.t === "str" && a.value !== undefined) {
      key = a.value.replace(/^\\/, "");
      isClass = CLASS_STRING.test(a.value);
    }
    if (key === undefined) return;
    let concrete: string | undefined;
    if (toks[at]?.v === ",") {
      for (let k = at + 1; k < end; k++) {
        const t = toks[k] as Tok;
        if (t.t === "name" && toks[k + 1]?.v === "::" && toks[k + 2]?.v === "class") {
          concrete = resolveClass(t.v);
          break;
        }
        if (
          lc(t.v) === "new" &&
          toks[k + 1]?.t === "name" &&
          lc((toks[k + 1] as Tok).v) !== "class"
        ) {
          concrete = resolveClass((toks[k + 1] as Tok).v);
          break;
        }
        if (t.t === "str" && t.value !== undefined && CLASS_STRING.test(t.value)) {
          concrete = t.value.replace(/^\\/, "");
          break;
        }
      }
    } else if (isClass) concrete = key;
    bindings.push({ key, isClass, ...(concrete ? { concrete } : {}) });
  };

  // ── Declarations ──
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
  const fromCollected = (c: Collected) => ({
    ...(c.resources.size ? { resources: [...c.resources] } : {}),
    refs: [...c.refs],
    uses: [...c.uses],
    escapes: [...c.escapes],
  });
  const textOf = (a: number, b: number) =>
    toks
      .slice(a, b)
      .map((x) => x.v)
      .join(" ");
  const valuesOf = (a: number, b: number) => toks.slice(a, b).map((x) => x.v);

  /** `use` statement at `k` (top level). Returns the index of its `;`. */
  const readUse = (k: number): number => {
    let j = k + 1;
    let kind: "class" | "function" | "const" = "class";
    if (toks[j]?.v === "function") {
      kind = "function";
      j++;
    } else if (toks[j]?.v === "const") {
      kind = "const";
      j++;
    }
    const end = (() => {
      for (let q = j; q < toks.length; q++) {
        if (toks[q]?.v === ";") return q;
        if (toks[q]?.v === "{") q = close(q);
      }
      return toks.length;
    })();
    const add = (k2: "class" | "function" | "const", fq: string, alias?: string) => {
      const name = fq.replace(/^\\/, "");
      const as = alias ?? shortOf(name);
      if (k2 === "class") uses.classes.set(lc(as), name);
      else if (k2 === "function") uses.functions.set(lc(as), name);
      else uses.consts.set(as, name);
    };
    let q = j;
    while (q < end) {
      const t = toks[q] as Tok;
      if (t.t === "name") {
        // A\{B, C as D} (a group) or A\B [as C]
        let base = t.v;
        if (toks[q + 1]?.v === "\\" && toks[q + 2]?.v === "{") q++;
        if (toks[q + 1]?.v === "{") {
          const gEnd = close(q + 1);
          base = base.replace(/\\$/, "");
          let g = q + 2;
          while (g < gEnd) {
            let k2 = kind;
            if (toks[g]?.v === "function") {
              k2 = "function";
              g++;
            } else if (toks[g]?.v === "const") {
              k2 = "const";
              g++;
            }
            const n = toks[g];
            if (n?.t === "name") {
              let alias: string | undefined;
              if (toks[g + 1]?.v === "as" && toks[g + 2]?.t === "name") {
                alias = (toks[g + 2] as Tok).v;
                g += 2;
              }
              add(k2, `${base}\\${n.v}`, alias);
            }
            g++;
            while (g < gEnd && toks[g]?.v === ",") g++;
          }
          q = gEnd + 1;
          continue;
        }
        let alias: string | undefined;
        if (toks[q + 1]?.v === "as" && toks[q + 2]?.t === "name") {
          alias = (toks[q + 2] as Tok).v;
          q += 2;
        }
        add(kind, base, alias);
      }
      q++;
    }
    return end;
  };

  /** Reads a class-like declared at `k` (the `class`/`interface`/`trait`/`enum` word). */
  const readClass = (k: number, startTok: number, attrs: [number, number][]): number => {
    const kindWord = lc((toks[k] as Tok).v);
    const name = (toks[k + 1] as Tok).v;
    const fqcn = ns ? `${ns}\\${name}` : name;
    let open = k + 2;
    while (open < toks.length && toks[open]?.v !== "{") open++;
    const end = close(open);
    const shell = collected();
    const shellToks: Tok[] = [];
    for (const [a, b] of attrs) {
      walk(a, b + 1, shell, {});
      shellToks.push(...toks.slice(a, b + 1));
    }
    // Header: extends / implements / an enum's backing type
    let ext: string | undefined;
    const impl: string[] = [];
    let mode: "none" | "extends" | "implements" = "none";
    for (let h = k + 2; h < open; h++) {
      const t = toks[h] as Tok;
      shellToks.push(t);
      if (t.t !== "name") continue;
      if (lc(t.v) === "extends") mode = "extends";
      else if (lc(t.v) === "implements") mode = "implements";
      else if (mode !== "none") {
        const local = classRef(resolveClass(t.v), t.line);
        shell.refs.add(local);
        if (mode === "extends" && kindWord !== "interface" && !ext) ext = local;
        else impl.push(local);
        // A test case of Laravel boots the application.
        if (mode === "extends" && BOOTING_TEST_CASES.has(lc(resolveClass(t.v))))
          sideEffect("@app-boot", t.line);
      }
    }
    if (kindWord === "interface" && impl.length) ext = impl.shift();
    // Members
    const members: MemberInfo[] = [];
    const controller = /Controller$/.test(name) || /(?:^|\/)Http\/Controllers\//.test(path);
    const props = new Map<string, string[]>();
    let m = open + 1;
    let memberAttrs: [number, number][] = [];
    const facadeKeys: { value: string; line: number }[] = [];
    while (m < end) {
      const t = toks[m] as Tok;
      if (t.v === "#[") {
        memberAttrs.push([m, close(m)]);
        m = close(m) + 1;
        continue;
      }
      if (t.v === ";") {
        m++;
        continue;
      }
      const first = memberAttrs[0]?.[0] ?? m;
      if (t.t === "name" && lc(t.v) === "use") {
        // trait use
        let q = m + 1;
        for (; q < end && toks[q]?.v !== ";" && toks[q]?.v !== "{"; q++) {
          const n = toks[q] as Tok;
          if (n.t === "name") {
            const local = classRef(resolveClass(n.v), n.line);
            shell.refs.add(local);
            shell.escapes.add(local);
          }
        }
        if (toks[q]?.v === "{") q = close(q);
        shellToks.push(...toks.slice(m, q + 1));
        m = q + 1;
        memberAttrs = [];
        continue;
      }
      // modifiers
      let q = m;
      while (
        q < end &&
        (toks[q] as Tok).t === "name" &&
        /^(?:public|protected|private|static|abstract|final|readonly|var)$/i.test(
          (toks[q] as Tok).v,
        )
      )
        q++;
      const w = toks[q] as Tok | undefined;
      if (w?.t === "name" && lc(w.v) === "function") {
        let n = q + 1;
        if (toks[n]?.v === "&") n++;
        const mName = (toks[n] as Tok | undefined)?.v ?? "";
        const paren = n + 1;
        const pEnd = toks[paren]?.v === "(" ? close(paren) : paren;
        let body = pEnd + 1;
        while (body < end && toks[body]?.v !== "{" && toks[body]?.v !== ";") body++;
        const mEnd = toks[body]?.v === "{" ? close(body) : body;
        members.push({
          name: mName,
          kind: "method",
          from: first,
          to: mEnd,
          headerEnd: body,
        });
        // Promoted constructor parameters are typed properties.
        if (lc(mName) === "__construct" && toks[paren]?.v === "(") {
          const promoted = new Map<string, string[]>();
          paramTypes(paren, new Map(), promoted);
          for (const [p, ty] of promoted) {
            props.set(p, ty);
            members.push({ name: p, kind: "property", from: paren, to: paren, headerEnd: paren });
          }
        }
        if (mName === "getFacadeAccessor")
          for (let r = body; r < mEnd; r++)
            if (
              toks[r]?.v === "return" &&
              toks[r + 1]?.t === "str" &&
              toks[r + 1]?.value !== undefined &&
              toks[r + 2]?.v === ";"
            )
              facadeKeys.push({
                value: toks[r + 1]?.value as string,
                line: toks[r + 1]?.line ?? 1,
              });
        m = mEnd + 1;
        memberAttrs = [];
        continue;
      }
      // const / case / property: up to the `;` (or a property hook block)
      let stmtEnd = q;
      while (stmtEnd < end && toks[stmtEnd]?.v !== ";") {
        const v = toks[stmtEnd]?.v;
        if (v === "(" || v === "[" || v === "#[") stmtEnd = close(stmtEnd);
        else if (v === "{") {
          stmtEnd = close(stmtEnd);
          break;
        }
        stmtEnd++;
      }
      if (w?.t === "name" && (lc(w.v) === "const" || lc(w.v) === "case")) {
        // const [type] A = 1, B = 2;  /  case A = 'a';
        for (let r = q + 1; r < stmtEnd; r++) {
          const n = toks[r] as Tok;
          if (
            n.t === "name" &&
            (toks[r + 1]?.v === "=" || toks[r + 1]?.v === ";" || r + 1 === stmtEnd)
          )
            members.push({
              name: n.v,
              kind: "property",
              from: first,
              to: stmtEnd,
              headerEnd: stmtEnd,
            });
          if (n.v === "(" || n.v === "[") r = close(r);
        }
      } else {
        // [type] $a [= …], $b;
        let typeEnd = q;
        while (typeEnd < stmtEnd && (toks[typeEnd] as Tok).t !== "var") typeEnd++;
        const ty = typeNames(q, typeEnd);
        for (let r = typeEnd; r < stmtEnd; r++) {
          const n = toks[r] as Tok;
          if (n.t === "var" && (r === typeEnd || toks[r - 1]?.v === ",")) {
            const pName = `$${n.v.slice(1)}`;
            members.push({
              name: pName,
              kind: "property",
              from: first,
              to: stmtEnd,
              headerEnd: stmtEnd,
            });
            if (ty.length) props.set(pName, ty);
          }
          if (n.v === "(" || n.v === "[") r = close(r);
        }
      }
      shellToks.push(...toks.slice(first, stmtEnd + 1));
      walk(first, stmtEnd + 1, shell, { self: name });
      m = stmtEnd + 1;
      memberAttrs = [];
    }
    for (const fk of facadeKeys)
      if (CLASS_STRING.test(fk.value))
        shell.escapes.add(classRef(fk.value.replace(/^\\/, ""), fk.line));
      else sideEffect(`@bind-key/${fk.value}`, fk.line);
    // An Artisan command: the tests that run it by name (`$this->artisan('x:y')`) reach it.
    for (let q = open + 1; q < end; q++) {
      const x = toks[q] as Tok;
      if (
        x.t === "var" &&
        (x.v === "$signature" || x.v === "$name") &&
        toks[q + 1]?.v === "=" &&
        toks[q + 2]?.t === "str"
      ) {
        const command = /^\s*([^\s{]+)/.exec(toks[q + 2]?.value ?? "")?.[1];
        if (command) shell.resources.add(`http-route:ARTISAN /${command}`);
        break;
      }
    }
    // What the container binds this class to (an interface bound in a service provider).
    sideEffect(`@bound/${asPath(fqcn)}`, (toks[k] as Tok).line);
    const startLine = (toks[startTok] as Tok).line;
    const endLine = (toks[end] as Tok | undefined)?.line ?? startLine;
    addSymbol({
      name,
      qualifiedName: name,
      kind: "class",
      exportNames: [name],
      range: range(startLine, endLine),
      signature: `${kindWord} ${textOf(k + 1, open)}`.slice(0, 300),
      tokenHash: hash(shellToks.map((x) => x.v)),
      ...fromCollected(shell),
      ...(ext ? { extends: ext } : {}),
      ...(impl.length ? { implements: impl } : {}),
      raw: rawText(startLine, endLine),
    });
    // Member names declared here (case-insensitive for methods, as PHP)
    const declaredMethods = new Map<string, string>();
    for (const mi of members) if (mi.kind === "method") declaredMethods.set(lc(mi.name), mi.name);
    const literalParams = (mi: MemberInfo): Map<string, string[]> | undefined => {
      let paren = mi.from;
      while (paren < mi.headerEnd && toks[paren]?.v !== "(") paren++;
      if (toks[paren]?.v !== "(" || !/\bprivate\b/.test(textOf(mi.from, paren))) return undefined;
      const names = argRanges(paren).map(([a, b]) => {
        for (let q = a; q < b; q++) if (toks[q]?.t === "var") return (toks[q] as Tok).v;
        return "";
      });
      const out = new Map<string, string[]>();
      let calls = 0;
      for (let q = open + 1; q < end; q++) {
        const x = toks[q] as Tok;
        const viaSelf =
          (x.v === "self" || x.v === "static") &&
          toks[q + 1]?.v === "::" &&
          toks[q + 2]?.v === mi.name;
        const viaThis = x.v === "$this" && toks[q + 1]?.v === "->" && toks[q + 2]?.v === mi.name;
        if (!(viaSelf || viaThis) || toks[q + 3]?.v !== "(") continue;
        calls++;
        for (const [i, [a, b]] of argRanges(q + 3).entries()) {
          const v = names[i];
          if (!v) continue;
          const cls =
            b - a === 3 &&
            toks[a]?.t === "name" &&
            toks[a + 1]?.v === "::" &&
            toks[a + 2]?.v === "class"
              ? resolveClass((toks[a] as Tok).v)
              : undefined;
          if (cls) out.set(v, [...(out.get(v) ?? []), cls]);
          else out.set(v, [...(out.get(v) ?? []), "\u0000"]);
        }
      }
      if (!calls) return undefined;
      for (const [v, l] of [...out]) if (l.includes("\u0000")) out.delete(v);
      return out;
    };
    const seen = new Set<string>();
    for (const mi of members) {
      if (seen.has(mi.name)) continue;
      seen.add(mi.name);
      const c = collected();
      const params = new Map<string, string[]>();
      const paramClasses = mi.kind === "method" ? literalParams(mi) : undefined;
      if (mi.kind === "method") {
        // parameters, return type, body
        let paren = mi.from;
        while (paren < mi.headerEnd && toks[paren]?.v !== "(") paren++;
        if (toks[paren]?.v === "(") {
          paramTypes(paren, params);
          const pEnd = close(paren);
          // A typed parameter is built before the method runs (by its caller, or by Laravel's
          // container): its constructor is a dependency. A controller action's parameters are
          // resolved by the framework (form requests validate, models bind): used whole.
          const action = controller && !/\bprivate\b|\bprotected\b/.test(textOf(mi.from, paren));
          for (const ty of params.values())
            for (const x of ty) {
              c.refs.add(x);
              c.uses.add(`${x}.constructor`);
              if (action) c.escapes.add(x);
            }
          // return type
          if (toks[pEnd + 1]?.v === ":") typeNames(pEnd + 2, mi.headerEnd);
          walk(paren + 1, pEnd, c, { self: name, props, params, declaring: true });
        }
        walk(mi.from, paren, c, { self: name, props, params });
        const paramNames =
          toks[paren]?.v === "("
            ? argRanges(paren).map(([a, b]) => {
                for (let q = a; q < b; q++) if (toks[q]?.t === "var") return (toks[q] as Tok).v;
                return "";
              })
            : [];
        walk(mi.headerEnd, mi.to + 1, c, {
          self: name,
          props,
          params,
          ...(paramClasses ? { paramClasses } : {}),
          owner: { name: mi.name, params: paramNames },
        });
      } else if (mi.to > mi.from) {
        walk(mi.from, mi.to + 1, c, { self: name, props });
      }
      // this-uses spelled as declared (PHP method names are case-insensitive)
      const thisUses = [...c.thisUses].map((u) =>
        u.startsWith("$") ? u : (declaredMethods.get(lc(u)) ?? u),
      );
      const mStart = (toks[mi.from] as Tok).line;
      const mEnd = (toks[mi.to] as Tok | undefined)?.line ?? mStart;
      const isCtor = mi.kind === "method" && lc(mi.name) === "__construct";
      const mToks = mi.to >= mi.from ? valuesOf(mi.from, mi.to + 1) : [mi.name];
      addSymbol({
        name: mi.name,
        qualifiedName: `${name}.${mi.name}`,
        kind: mi.kind === "method" && !isCtor ? "method" : "property",
        parent: name,
        range: range(mStart, mEnd),
        signature:
          mi.kind === "method"
            ? textOf(mi.from, mi.headerEnd).slice(0, 300)
            : textOf(mi.from, Math.min(mi.to, mi.from + 40)).slice(0, 300),
        tokenHash: hash(mToks),
        ...fromCollected(c),
        thisUses: thisUses.filter((u) => u !== mi.name),
        ...(c.superUses.size ? { superUses: [...c.superUses] } : {}),
        ...(c.thisEscapes ? { thisEscapes: true } : {}),
        raw: rawText(mStart, mEnd),
      });
    }
    return end;
  };

  /** A top-level function at `k` (the `function` word). */
  const readFunction = (k: number, startTok: number): number => {
    let n = k + 1;
    if (toks[n]?.v === "&") n++;
    const name = (toks[n] as Tok).v;
    const paren = n + 1;
    const pEnd = toks[paren]?.v === "(" ? close(paren) : paren;
    let body = pEnd + 1;
    while (body < toks.length && toks[body]?.v !== "{" && toks[body]?.v !== ";") body++;
    const end = toks[body]?.v === "{" ? close(body) : body;
    const c = collected();
    const params = new Map<string, string[]>();
    if (toks[paren]?.v === "(") {
      paramTypes(paren, params);
      walk(paren + 1, pEnd, c, { params, declaring: true });
    }
    if (toks[pEnd + 1]?.v === ":") typeNames(pEnd + 2, body);
    walk(body, end + 1, c, { params });
    const startLine = (toks[startTok] as Tok).line;
    const endLine = (toks[end] as Tok | undefined)?.line ?? startLine;
    addSymbol({
      name,
      qualifiedName: name,
      kind: "function",
      exportNames: [name],
      range: range(startLine, endLine),
      signature: textOf(k, body).slice(0, 300),
      tokenHash: hash(valuesOf(startTok, end + 1)),
      ...fromCollected(c),
      raw: rawText(startLine, endLine),
    });
    return end;
  };

  /** Top-level `const A = 1, B = 2;` at `k`. */
  const readConst = (k: number): number => {
    let end = k + 1;
    while (end < toks.length && toks[end]?.v !== ";") {
      const v = toks[end]?.v;
      if (v === "(" || v === "[") end = close(end);
      end++;
    }
    const c = collected();
    walk(k + 1, end, c, {});
    for (let r = k + 1; r < end; r++) {
      const n = toks[r] as Tok;
      if (n.t === "name" && toks[r + 1]?.v === "=" && (r === k + 1 || toks[r - 1]?.v === ",")) {
        const startLine = (toks[k] as Tok).line;
        const endLine = (toks[end] as Tok | undefined)?.line ?? startLine;
        addSymbol({
          name: n.v,
          qualifiedName: n.v,
          kind: "property",
          exportNames: [n.v],
          range: range(startLine, endLine),
          signature: textOf(k, end).slice(0, 200),
          tokenHash: hash(valuesOf(k, end + 1)),
          ...fromCollected(c),
          raw: rawText(startLine, endLine),
        });
      }
      if (n.v === "(" || n.v === "[") r = close(r);
    }
    return end;
  };

  // ── Route files (Laravel, preview): each route is a symbol, linked to its action ──
  const isRouteFile = /(?:^|\/)routes\/.+\.php$/.test(path);
  interface RouteCtx {
    prefix: string;
    names: string;
    /** Token ranges every route of the group carries (middleware, `can`, `where`…). */
    ranges: [number, number][];
    controller?: string;
    hash: string[];
    open: boolean;
  }
  const rootRoutes: RouteCtx = {
    prefix: /(?:^|\/)routes\/api\.php$/.test(path) ? "/api" : "",
    names: "",
    ranges: [],
    hash: [],
    // Another route file includes this one, maybe inside a group: its prefix is not known here.
    open: !/(?:^|\/)routes\/(?:api|web)\.php$/.test(path),
  };
  const joinUri = (a: string, b: string) =>
    `/${[a, b].join("/").split("/").filter(Boolean).join("/")}`;
  const routeUnits = new Map<string, number>();
  const isRouteStart = (k: number) =>
    toks[k]?.t === "name" &&
    /^\\?(?:Illuminate\\Support\\Facades\\)?Route$/.test((toks[k] as Tok).v) &&
    toks[k + 1]?.v === "::";
  const singleStr = (r: [number, number] | undefined) =>
    r && r[1] - r[0] === 1 && toks[r[0]]?.t === "str" ? toks[r[0]]?.value : undefined;
  const stringsIn = (r: [number, number] | undefined): string[] => {
    const out: string[] = [];
    for (let q = r?.[0] ?? 0; q < (r?.[1] ?? 0); q++) {
      const x = toks[q] as Tok;
      if (x.t === "str" && x.value !== undefined) out.push(x.value);
    }
    return out;
  };
  const classOf = (r: [number, number] | undefined): string | undefined =>
    r &&
    r[1] - r[0] === 3 &&
    toks[r[0]]?.t === "name" &&
    toks[r[0] + 1]?.v === "::" &&
    toks[r[0] + 2]?.v === "class"
      ? classRef(resolveClass((toks[r[0]] as Tok).v), (toks[r[0]] as Tok).line)
      : undefined;
  /** The end (inclusive) of the statement starting at `k`. */
  const statementEnd = (k: number, to: number): number => {
    let end = k;
    while (end < to && toks[end]?.v !== ";") {
      const v = toks[end]?.v;
      if (v === "(" || v === "[" || v === "{" || v === "#[") {
        const c2 = close(end);
        if (
          v === "{" &&
          toks[c2 + 1]?.v !== ")" &&
          toks[c2 + 1]?.v !== "," &&
          toks[c2 + 1]?.v !== "->" &&
          toks[c2 + 1]?.v !== ";"
        ) {
          end = c2;
          break;
        }
        end = c2;
      }
      end++;
    }
    return Math.min(end, to - 1);
  };
  const addRoute = (
    methods: string[],
    uri: string | undefined,
    ctx: RouteCtx,
    name: string | undefined,
    stmt: [number, number],
    action: { range?: [number, number]; cls?: string; method?: string },
  ) => {
    const c = collected();
    for (const [a, b] of ctx.ranges) walk(a, b, c, {});
    if (action.range) walk(action.range[0], action.range[1], c, {});
    if (action.cls) {
      c.refs.add(action.cls);
      c.uses.add(`${action.cls}.${action.method ?? "__invoke"}`);
      c.uses.add(`${action.cls}.constructor`);
    }
    const full = uri === undefined ? "*" : joinUri(ctx.prefix, uri);
    const tag = ctx.open ? "~" : "";
    c.resources.add(`http-route${tag}:${methods.join("|")} ${full}`);
    if (name) c.resources.add(`http-route-name${tag}:${name}`);
    let unit = `${methods.join("|")} ${full}`.replace(/\./g, "·");
    const n = (routeUnits.get(unit) ?? 0) + 1;
    routeUnits.set(unit, n);
    if (n > 1) unit = `${unit} #${n}`;
    const startLine = (toks[stmt[0]] as Tok).line;
    const endLine = (toks[stmt[1]] as Tok | undefined)?.line ?? startLine;
    const tokens = [...ctx.hash, ...valuesOf(stmt[0], stmt[1] + 1)];
    addSymbol({
      name: unit,
      qualifiedName: unit,
      kind: "function",
      exportNames: [],
      range: range(startLine, endLine),
      signature: textOf(stmt[0], Math.min(stmt[1], stmt[0] + 40)).slice(0, 200),
      tokenHash: hash(tokens),
      // Registering a route is code the route file runs: a changed route reaches every test
      // that boots the application (its loaders), not only the tests requesting it.
      evalHash: hash(tokens),
      ...fromCollected(c),
      raw: rawText(startLine, endLine),
    });
  };
  /** Statements [from, to) of a route file or of a group's closure. */
  const readRouteBody = (from: number, to: number, ctx: RouteCtx) => {
    let k = from;
    while (k < to) {
      const stop = statementEnd(k, to);
      if (isRouteStart(k)) readRoute(k, stop, ctx);
      else {
        moduleCode.push(...toks.slice(k, stop + 1));
        walk(k, stop + 1, module, {});
      }
      k = stop + 1;
    }
  };
  const VERBS: Record<string, string[]> = {
    get: ["GET", "HEAD"],
    post: ["POST"],
    put: ["PUT"],
    patch: ["PATCH"],
    delete: ["DELETE"],
    options: ["OPTIONS"],
    any: ["*"],
    view: ["GET", "HEAD"],
    redirect: ["*"],
    permanentRedirect: ["*"],
    fallback: ["*"],
    match: [],
  };
  /** `Route::…` from `from` to `to` (inclusive): routes, groups, resources. */
  const readRoute = (from: number, to: number, ctx: RouteCtx) => {
    const segs: { name: string; open: number }[] = [];
    let j = from + 2;
    while (j <= to) {
      const n = toks[j];
      if (n?.t !== "name" || toks[j + 1]?.v !== "(") break;
      segs.push({ name: n.v, open: j + 1 });
      j = close(j + 1) + 1;
      if (toks[j]?.v === "->") j++;
      else break;
    }
    const local: RouteCtx = {
      ...ctx,
      ranges: [...ctx.ranges],
      hash: [...ctx.hash],
    };
    let ownName = "";
    let verb: { name: string; open: number } | undefined;
    let group: { name: string; open: number } | undefined;
    let resource: { name: string; open: number; api: boolean } | undefined;
    const only: string[] = [];
    const except: string[] = [];
    for (const sg of segs) {
      const args = argRanges(sg.open);
      if (sg.name === "prefix") local.prefix = joinUri(local.prefix, singleStr(args[0]) ?? "*");
      else if (sg.name === "name" || sg.name === "as") ownName += singleStr(args[0]) ?? "";
      else if (sg.name === "controller") {
        const cls = classOf(args[0]);
        if (cls) local.controller = cls;
      } else if (sg.name === "group") group = sg;
      else if (sg.name === "resource" || sg.name === "apiResource")
        resource = { ...sg, api: sg.name === "apiResource" };
      else if (sg.name === "only") only.push(...stringsIn(args[0]));
      else if (sg.name === "except") except.push(...stringsIn(args[0]));
      else if (sg.name in VERBS && !verb) verb = sg;
      else local.ranges.push([sg.open + 1, close(sg.open)]);
    }
    const stmt: [number, number] = [from, to];
    if (group) {
      local.names += ownName;
      local.hash.push(...valuesOf(from, group.open + 1));
      for (const [a, b] of argRanges(group.open)) {
        if (toks[a]?.v === "[") {
          // Route::group(['prefix' => 'x', 'middleware' => [...], 'as' => 'x.'], function () {…})
          for (const [ea, eb] of argRanges(a)) {
            const keyName =
              toks[ea]?.t === "str" && toks[ea + 1]?.v === "=>" ? toks[ea]?.value : undefined;
            const value: [number, number] = [ea + 2, eb];
            if (keyName === "prefix") local.prefix = joinUri(local.prefix, singleStr(value) ?? "*");
            else if (keyName === "as") local.names += singleStr(value) ?? "";
            else if (keyName === "controller") {
              const cls = classOf(value);
              if (cls) local.controller = cls;
            } else local.ranges.push(value);
          }
          continue;
        }
        // The closure's body: its statements are routes of this group.
        for (let q = a; q < b; q++) {
          const w = toks[q]?.v;
          if (w === "fn" || w === "function") {
            let p = q + 1;
            if (toks[p]?.v === "(") p = close(p) + 1;
            if (toks[p]?.v === "use" && toks[p + 1]?.v === "(") p = close(p + 1) + 1;
            if (toks[p]?.v === ":") while (p < b && toks[p]?.v !== "{" && toks[p]?.v !== "=>") p++;
            if (toks[p]?.v === "{") readRouteBody(p + 1, close(p), local);
            else if (toks[p]?.v === "=>") readRouteBody(p + 1, b, local);
            break;
          }
        }
      }
      return;
    }
    const fullName = ownName ? `${ctx.names}${ownName}` : undefined;
    if (resource) {
      const args = argRanges(resource.open);
      const res = singleStr(args[0]);
      const cls = classOf(args[1]);
      if (res === undefined || !cls) {
        addRoute(["*"], undefined, local, undefined, stmt, {
          range: [resource.open + 1, close(resource.open)],
        });
        return;
      }
      const parts = res.split(".");
      const param = (p: string) => `{${p.replace(/s$/, "")}}`;
      const base = parts.map((p, i) => (i < parts.length - 1 ? `${p}/${param(p)}` : p)).join("/");
      const item = `${base}/${param(parts[parts.length - 1] as string)}`;
      const actions: [string, string[], string][] = [
        ["index", ["GET", "HEAD"], base],
        ...(resource.api
          ? []
          : ([["create", ["GET", "HEAD"], `${base}/create`]] as [string, string[], string][])),
        ["store", ["POST"], base],
        ["show", ["GET", "HEAD"], item],
        ...(resource.api
          ? []
          : ([["edit", ["GET", "HEAD"], `${item}/edit`]] as [string, string[], string][])),
        ["update", ["PUT", "PATCH"], item],
        ["destroy", ["DELETE"], item],
      ];
      for (const [act, methods, uri] of actions) {
        if (only.length && !only.includes(act)) continue;
        if (except.includes(act)) continue;
        addRoute(methods, uri, local, `${ctx.names}${res}.${act}`, stmt, { cls, method: act });
      }
      return;
    }
    if (!verb) {
      // Route::bind(), Route::pattern(), Route::model(): code every route depends on.
      moduleCode.push(...toks.slice(from, to + 1));
      walk(from, to + 1, module, {});
      return;
    }
    const args = argRanges(verb.open);
    let methods = VERBS[verb.name] as string[];
    let uriArg = 0;
    if (verb.name === "match") {
      methods = stringsIn(args[0]).map((m) => m.toUpperCase());
      if (!methods.length) methods = ["*"];
      uriArg = 1;
    }
    const uri = verb.name === "fallback" ? undefined : singleStr(args[uriArg]);
    const actionArg = verb.name === "fallback" ? args[0] : args[uriArg + 1];
    const actionStr = singleStr(actionArg);
    const action: { range?: [number, number]; cls?: string; method?: string } = {};
    if (verb.name === "view" || verb.name.endsWith("edirect")) {
      if (actionArg) action.range = actionArg;
    } else if (actionStr?.includes("@")) {
      const [cls, m] = actionStr.split("@") as [string, string];
      action.cls = classRef(
        resolveClass(cls.includes("\\") ? `\\${cls.replace(/^\\/, "")}` : cls),
        verb.open,
      );
      action.method = m;
    } else if (actionStr !== undefined && local.controller) {
      action.cls = local.controller;
      action.method = actionStr;
    } else if (actionArg) {
      const cls = classOf(actionArg);
      if (cls) {
        action.cls = cls;
        action.method = "__invoke";
      } else action.range = actionArg;
    }
    addRoute(methods, uri, local, fullName, stmt, action);
  };

  /** Statements from `from` to `to`, at file level (namespace blocks and `if` blocks included). */
  const readBlock = (from: number, to: number) => {
    let attrs: [number, number][] = [];
    let k = from;
    while (k < to) {
      const t = toks[k] as Tok;
      const prev = toks[k - 1];
      const lw = t.t === "name" ? lc(t.v) : "";
      if (t.v === "#[") {
        attrs.push([k, close(k)]);
        k = close(k) + 1;
        continue;
      }
      if (lw === "namespace" && prev?.v !== "\\" && toks[k + 1]?.v !== "\\") {
        const n = toks[k + 1];
        const named = n?.t === "name" ? n.v.replace(/^\\/, "") : "";
        let j = k + (named ? 2 : 1);
        ns = named;
        uses = { classes: new Map(), functions: new Map(), consts: new Map() };
        if (toks[j]?.v === "{") {
          const end = close(j);
          readBlock(j + 1, end);
          ns = "";
          k = end + 1;
        } else {
          if (toks[j]?.v === ";") j++;
          k = j;
        }
        attrs = [];
        continue;
      }
      if (
        lw === "use" &&
        (prev === undefined || prev.v === ";" || prev.v === "{" || prev.v === "}")
      ) {
        k = readUse(k) + 1;
        continue;
      }
      if (lw === "declare" && toks[k + 1]?.v === "(") {
        k = close(k + 1) + 1;
        if (toks[k]?.v === ";") k++;
        continue;
      }
      // class-likes, with their modifiers and attributes
      let q = k;
      while (
        q < to &&
        (toks[q] as Tok).t === "name" &&
        /^(?:abstract|final|readonly)$/i.test((toks[q] as Tok).v)
      )
        q++;
      const w = toks[q];
      const wl = w?.t === "name" ? lc(w.v) : "";
      if (
        (wl === "class" || wl === "interface" || wl === "trait" || wl === "enum") &&
        toks[q + 1]?.t === "name" &&
        prev?.v !== "::" &&
        prev?.v !== "new" &&
        !(wl === "enum" && toks[q + 1]?.v === "extends")
      ) {
        const startTok = attrs[0]?.[0] ?? k;
        k = readClass(q, startTok, attrs) + 1;
        attrs = [];
        continue;
      }
      if (
        lw === "function" &&
        (toks[k + 1]?.t === "name" || (toks[k + 1]?.v === "&" && toks[k + 2]?.t === "name"))
      ) {
        k = readFunction(k, attrs[0]?.[0] ?? k) + 1;
        attrs = [];
        continue;
      }
      if (lw === "const" && toks[k + 1]?.t === "name") {
        k = readConst(k) + 1;
        continue;
      }
      // `if (!function_exists('x')) { function x() … }`: declarations inside if blocks.
      if ((lw === "if" || lw === "elseif") && toks[k + 1]?.v === "(") {
        const condEnd = close(k + 1);
        moduleCode.push(...toks.slice(k, condEnd + 1));
        walk(k, condEnd + 1, module, {});
        if (toks[condEnd + 1]?.v === "{") {
          const end = close(condEnd + 1);
          readBlock(condEnd + 2, end);
          k = end + 1;
        } else k = condEnd + 1;
        continue;
      }
      if (lw === "else" && toks[k + 1]?.v === "{") {
        const end = close(k + 1);
        readBlock(k + 2, end);
        k = end + 1;
        continue;
      }
      // define('NAME', …) at file level: a constant
      if (
        (lw === "define" || lw === "\\define") &&
        toks[k + 1]?.v === "(" &&
        toks[k + 2]?.t === "str" &&
        toks[k + 2]?.value !== undefined
      ) {
        const end = close(k + 1);
        const c = collected();
        walk(k + 3, end, c, {});
        const name = toks[k + 2]?.value as string;
        const startLine = t.line;
        const endLine = (toks[end] as Tok | undefined)?.line ?? startLine;
        addSymbol({
          name,
          qualifiedName: name,
          kind: "property",
          exportNames: [name],
          range: range(startLine, endLine),
          signature: textOf(k, end + 1).slice(0, 200),
          tokenHash: hash(valuesOf(k, end + 1)),
          ...fromCollected(c),
          raw: rawText(startLine, endLine),
        });
        k = end + 1;
        continue;
      }
      // A route of a route file: a symbol linked to its action (see readRoute).
      if (isRouteFile && isRouteStart(k)) {
        const stop = statementEnd(k, to);
        readRoute(k, stop, rootRoutes);
        attrs = [];
        k = stop + 1;
        continue;
      }
      // Any other statement: code that runs when the file is included. A block that is not an
      // `if` (a closure, a loop, an anonymous class) is read whole.
      let end = k;
      while (end < to && toks[end]?.v !== ";") {
        const v = toks[end]?.v;
        if (v === "(" || v === "[" || v === "{" || v === "#[") {
          const c2 = close(end);
          if (
            v === "{" &&
            toks[c2 + 1]?.v !== ")" &&
            toks[c2 + 1]?.v !== "," &&
            toks[c2 + 1]?.v !== "->" &&
            toks[c2 + 1]?.v !== ";"
          ) {
            end = c2;
            break;
          }
          end = c2;
        }
        end++;
      }
      const stop = Math.min(end, to - 1);
      moduleCode.push(...toks.slice(k, stop + 1));
      walk(k, stop + 1, module, {});
      for (const [a, b] of attrs) walk(a, b + 1, module, {});
      attrs = [];
      k = stop + 1;
    }
  };
  readBlock(0, toks.length);

  // Laravel's application bootstrap (`Application::configure(…)`): loads every configuration
  // file, the service providers, routes, migrations, translations and views, and discovers
  // listeners, policies and commands. A test that boots the application reaches them all.
  const boots =
    path.endsWith("bootstrap/app.php") &&
    toks.some(
      (t, k) =>
        (t.v === "configure" &&
          toks[k - 1]?.v === "::" &&
          /Application$/.test(toks[k - 2]?.v ?? "")) ||
        (t.v === "new" && /(?:^|\\)Application$/.test(toks[k + 1]?.v ?? "")),
    );
  if (boots) {
    const base = dir.includes("/") ? dir.slice(0, dir.lastIndexOf("/")) : "";
    const at = (rel: string, load = false) =>
      `@root${load ? "-load" : ""}/${base ? `${base}/` : ""}${rel}`;
    // Loaded (only a change to their own code reaches the boot): route files, whose routes reach
    // the tests that request them; migrations, translations, views; the providers list, whose
    // providers it names. Used: configuration (it names classes the framework builds) and the
    // classes Laravel discovers.
    for (const rel of [
      "bootstrap/providers.php",
      "routes/**/*.php",
      "database/migrations/**/*.php",
      "lang/**/*.php",
      "resources/lang/**/*.php",
      "resources/views/**/*.php",
      "app/Console/**/*.php",
    ])
      dynamicHints.push({ pattern: at(rel, true), line: 1, expr: "the Laravel application boot" });
    for (const rel of [
      "config/**/*.php",
      "database/seeders/**/*.php",
      "app/Providers/**/*.php",
      "app/Listeners/**/*.php",
      "app/Policies/**/*.php",
    ])
      dynamicHints.push({ pattern: at(rel), line: 1, expr: "the Laravel application boot" });
  }

  // Pest: a test file without a class runs its closures on the test case `Pest.php` names.
  if (
    PHP_TEST_FILE.test(path) &&
    !symbols.some((s) => s.kind === "class") &&
    toks.some(
      (t, k) => (t.v === "test" || t.v === "it" || t.v === "describe") && toks[k + 1]?.v === "(",
    )
  )
    sideEffect(`@pest/${dir}`, 1);

  const mod = module;
  const result: FileAnalysis = {
    path,
    hash: sha256(content),
    language: "php",
    moduleKind: "unknown",
    imports,
    symbols,
    localExports: [],
    topLevelRefs: [...mod.refs],
    topLevelUses: [...mod.uses],
    topLevelEscapes: [...mod.escapes],
    ...(mod.resources.size ? { topLevelResources: [...mod.resources] } : {}),
    topLevelHash: hash(moduleCode.map((t) => t.v)),
    importsHash: hash(
      imports.map(
        (i) =>
          `${i.kind}|${i.specifier}|${i.bindings.map((b) => `${b.imported}>${b.local}`).join(",")}`,
      ),
    ),
    dynamicUnresolved: [...new Set(dynamicUnresolved)],
    ...(dynamicHints.length ? { dynamicHints } : {}),
    parseErrors: errors,
    analyzerVersion: PHP_ANALYZER_VERSION,
  };
  return { analysis: result, bindings };
}
