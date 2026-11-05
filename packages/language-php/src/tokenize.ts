/**
 * A PHP tokenizer good enough for dependency analysis (preview): inline HTML outside `<?php … ?>`
 * is skipped, comments are dropped, strings (single, double, backtick, heredoc, nowdoc) are one
 * token each, and the expressions interpolated into double-quoted strings and heredocs are
 * tokenized as code. Qualified names (`\App\Models\User`, `namespace\Foo`) are one token, as in
 * PHP 8's lexer.
 */

export type TokType = "name" | "var" | "str" | "num" | "op";

export interface Tok {
  t: TokType;
  /** Source text (a string token keeps its quotes). */
  v: string;
  line: number;
  /** Offsets in the source (end exclusive). */
  start: number;
  end: number;
  /** Strings: the literal value when it holds no interpolation. */
  value?: string;
  /** Strings: holds `$var` or `{$expr}` interpolation. */
  interpolated?: boolean;
  /** Tokens of an interpolated expression: they belong to the string before them. */
  inString?: boolean;
}

const NAME = /[A-Za-z_\u0080-\uffff][\w\u0080-\uffff]*/y;
const QUALIFIED =
  /\\?[A-Za-z_\u0080-\uffff][\w\u0080-\uffff]*(?:\\[A-Za-z_\u0080-\uffff][\w\u0080-\uffff]*)*/y;
const NUMBER =
  /(?:0[xX][0-9a-fA-F_]+|0[bB][01_]+|0[oO][0-7_]+|(?:\d[\d_]*)?\.\d[\d_]*(?:[eE][+-]?\d+)?|\d[\d_]*\.?(?:[eE][+-]?\d+)?)/y;
const OPS = [
  "<=>",
  "===",
  "!==",
  "**=",
  "...",
  "??=",
  "?->",
  "<<=",
  ">>=",
  "::",
  "->",
  "=>",
  "==",
  "!=",
  "<>",
  "<=",
  ">=",
  "&&",
  "||",
  "??",
  "++",
  "--",
  "+=",
  "-=",
  "*=",
  "/=",
  ".=",
  "%=",
  "&=",
  "|=",
  "^=",
  "<<",
  ">>",
  "**",
];
const SINGLE = "()[]{};,=.+-*/%&|^~!?:<>@$\\";

function unescapeDouble(body: string): string {
  return body.replace(
    /\\(?:([nrtvef\\$"0])|x([0-9a-fA-F]{1,2})|u\{([0-9a-fA-F]+)\})/g,
    (m, c, x, u) => {
      if (x) return String.fromCharCode(Number.parseInt(x, 16));
      if (u) return String.fromCodePoint(Number.parseInt(u, 16));
      switch (c) {
        case "n":
          return "\n";
        case "r":
          return "\r";
        case "t":
          return "\t";
        case "v":
          return "\v";
        case "e":
          return "\x1b";
        case "f":
          return "\f";
        case "0":
          return "\0";
        default:
          return c ?? m;
      }
    },
  );
}

/** `{$expr}`, `${expr}` and `$var->prop` / `$var[…]` inside a double-quoted string or heredoc. */
function interpolations(body: string): { code: string; at: number }[] {
  const out: { code: string; at: number }[] = [];
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c === "\\") {
      i++;
      continue;
    }
    if ((c === "{" && body[i + 1] === "$") || (c === "$" && body[i + 1] === "{")) {
      let depth = 0;
      let j = i;
      for (; j < body.length; j++) {
        if (body[j] === "{") depth++;
        else if (body[j] === "}" && --depth === 0) break;
      }
      const inner = c === "{" ? body.slice(i + 1, j) : `$${body.slice(i + 2, j)}`;
      out.push({ code: inner, at: i });
      i = j;
      continue;
    }
    if (c === "$" && /[A-Za-z_]/.test(body[i + 1] ?? "")) {
      const m = /^\$[A-Za-z_]\w*(?:(?:->|\?->)[A-Za-z_]\w*|\[[^\]]*\])?/.exec(body.slice(i));
      if (m) {
        out.push({ code: m[0], at: i });
        i += m[0].length - 1;
      }
    }
  }
  return out;
}

/** Tokenizes PHP source. `errors` counts unterminated strings and comments. */
export function tokenize(source: string, startInPhp = false): { toks: Tok[]; errors: number } {
  const src = source;
  const toks: Tok[] = [];
  let errors = 0;
  let i = 0;
  let line = 1;
  let php = startInPhp;
  const lineAt = (from: number, to: number) => {
    for (let k = from; k < to; k++) if (src.charCodeAt(k) === 10) line++;
  };
  const push = (t: Tok) => toks.push(t);
  const pushInterpolations = (body: string, bodyStart: number, startLine: number) => {
    for (const ip of interpolations(body)) {
      const inner = tokenize(ip.code, true);
      for (const t of inner.toks)
        push({
          ...t,
          line: startLine + (body.slice(0, ip.at).match(/\n/g)?.length ?? 0) + t.line - 1,
          start: bodyStart + ip.at,
          end: bodyStart + ip.at + ip.code.length,
          inString: true,
        });
    }
  };
  while (i < src.length) {
    if (!php) {
      const open = src.indexOf("<?", i);
      if (open < 0) {
        lineAt(i, src.length);
        break;
      }
      lineAt(i, open);
      if (src.startsWith("<?php", open)) i = open + 5;
      else if (src.startsWith("<?=", open)) {
        i = open + 3;
        push({ t: "name", v: "echo", line, start: open, end: i });
      } else if (src.startsWith("<?xml", open)) {
        i = open + 2;
        continue;
      } else i = open + 2;
      php = true;
      continue;
    }
    const c = src[i] as string;
    if (c === "\n") {
      line++;
      i++;
      continue;
    }
    if (c === " " || c === "\t" || c === "\r" || c === "\f" || c === "\v") {
      i++;
      continue;
    }
    if (c === "?" && src[i + 1] === ">") {
      push({ t: "op", v: ";", line, start: i, end: i + 2 });
      i += 2;
      if (src[i] === "\n") {
        line++;
        i++;
      }
      php = false;
      continue;
    }
    if (c === "#" && src[i + 1] === "[") {
      push({ t: "op", v: "#[", line, start: i, end: i + 2 });
      i += 2;
      continue;
    }
    if (c === "#" || (c === "/" && src[i + 1] === "/")) {
      while (i < src.length && src[i] !== "\n" && !(src[i] === "?" && src[i + 1] === ">")) i++;
      continue;
    }
    if (c === "/" && src[i + 1] === "*") {
      const end = src.indexOf("*/", i + 2);
      const stop = end < 0 ? src.length : end + 2;
      if (end < 0) errors++;
      lineAt(i, stop);
      i = stop;
      continue;
    }
    if (c === "'" || ((c === "b" || c === "B") && src[i + 1] === "'")) {
      const q = c === "'" ? i : i + 1;
      let j = q + 1;
      while (j < src.length && src[j] !== "'") j += src[j] === "\\" ? 2 : 1;
      if (j >= src.length) errors++;
      const body = src.slice(q + 1, Math.min(j, src.length));
      const startLine = line;
      lineAt(i, Math.min(j + 1, src.length));
      push({
        t: "str",
        v: src.slice(i, j + 1),
        line: startLine,
        start: i,
        end: Math.min(j + 1, src.length),
        value: body.replace(/\\(['\\])/g, "$1"),
      });
      i = j + 1;
      continue;
    }
    if (c === '"' || c === "`" || ((c === "b" || c === "B") && src[i + 1] === '"')) {
      const quote = c === "`" ? "`" : '"';
      const q = c === quote ? i : i + 1;
      let j = q + 1;
      while (j < src.length && src[j] !== quote) j += src[j] === "\\" ? 2 : 1;
      if (j >= src.length) errors++;
      const body = src.slice(q + 1, Math.min(j, src.length));
      const startLine = line;
      lineAt(i, Math.min(j + 1, src.length));
      const ips = interpolations(body);
      push({
        t: "str",
        v: src.slice(i, j + 1),
        line: startLine,
        start: i,
        end: Math.min(j + 1, src.length),
        ...(ips.length || quote === "`" ? { interpolated: true } : { value: unescapeDouble(body) }),
      });
      pushInterpolations(body, q + 1, startLine);
      i = j + 1;
      continue;
    }
    if (c === "<" && src.startsWith("<<<", i)) {
      const head = /^<<<[ \t]*(["']?)([A-Za-z_]\w*)\1\r?\n/.exec(src.slice(i, i + 200));
      if (head) {
        const nowdoc = head[1] === "'";
        const label = head[2] as string;
        const bodyStart = i + head[0].length;
        const close = new RegExp(`(^|\\n)[ \\t]*${label}(?![A-Za-z0-9_])`, "g");
        close.lastIndex = bodyStart - 1;
        const m = close.exec(src);
        const bodyEnd = m ? m.index + (m[1] ? 1 : 0) : src.length;
        const end = m ? m.index + m[0].length : src.length;
        if (!m) errors++;
        const body = src.slice(bodyStart, bodyEnd);
        const startLine = line;
        lineAt(i, end);
        const ips = nowdoc ? [] : interpolations(body);
        push({
          t: "str",
          v: src.slice(i, end),
          line: startLine,
          start: i,
          end,
          ...(ips.length
            ? { interpolated: true }
            : { value: nowdoc ? body : unescapeDouble(body) }),
        });
        if (!nowdoc) pushInterpolations(body, bodyStart, startLine + 1);
        i = end;
        continue;
      }
    }
    if (c === "$") {
      NAME.lastIndex = i + 1;
      const m = NAME.exec(src);
      if (m) {
        push({ t: "var", v: `$${m[0]}`, line, start: i, end: i + 1 + m[0].length });
        i += 1 + m[0].length;
        continue;
      }
      push({ t: "op", v: "$", line, start: i, end: i + 1 });
      i++;
      continue;
    }
    if (c === "\\" || /[A-Za-z_\u0080-\uffff]/.test(c)) {
      QUALIFIED.lastIndex = i;
      const m = QUALIFIED.exec(src);
      if (m) {
        push({ t: "name", v: m[0], line, start: i, end: i + m[0].length });
        i += m[0].length;
        continue;
      }
    }
    if (/[0-9]/.test(c) || (c === "." && /[0-9]/.test(src[i + 1] ?? ""))) {
      NUMBER.lastIndex = i;
      const m = NUMBER.exec(src);
      if (m?.[0]) {
        push({ t: "num", v: m[0], line, start: i, end: i + m[0].length });
        i += m[0].length;
        continue;
      }
    }
    const op = OPS.find((o) => src.startsWith(o, i));
    if (op) {
      push({ t: "op", v: op, line, start: i, end: i + op.length });
      i += op.length;
      continue;
    }
    if (SINGLE.includes(c)) {
      push({ t: "op", v: c, line, start: i, end: i + 1 });
      i++;
      continue;
    }
    // Anything else (a stray byte): skipped, not an error that would make the file unreadable.
    i++;
  }
  return { toks, errors };
}

/** Index of the token closing the bracket at `open` (or the last token when unbalanced). */
export function matchingClose(toks: readonly Tok[], pairs: Int32Array, open: number): number {
  const p = pairs[open];
  return p !== undefined && p >= 0 ? p : toks.length - 1;
}

/** For every `(`, `[`, `{` and `#[`: the index of its closer (-1 when unbalanced). */
export function bracketPairs(toks: readonly Tok[]): Int32Array {
  const pairs = new Int32Array(toks.length).fill(-1);
  const stack: number[] = [];
  const closer: Record<string, string> = { "(": ")", "[": "]", "{": "}", "#[": "]" };
  for (let k = 0; k < toks.length; k++) {
    const t = toks[k] as Tok;
    if (t.t !== "op") continue;
    if (t.v in closer) stack.push(k);
    else if (t.v === ")" || t.v === "]" || t.v === "}") {
      // Pop to the matching opener; a stray closer is ignored.
      for (let s = stack.length - 1; s >= 0; s--) {
        const o = toks[stack[s] as number] as Tok;
        if (closer[o.v] === t.v) {
          pairs[stack[s] as number] = k;
          pairs[k] = stack[s] as number;
          stack.length = s;
          break;
        }
      }
    }
  }
  return pairs;
}
