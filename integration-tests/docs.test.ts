/**
 * Documentation snippets are executed: every `smarttest …` command line in the docs must parse
 * with the real CLI (known command, known flags) and print its help, and every configuration
 * example must pass the configuration validator.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "../packages/cli/src/args.js";
import { COMMANDS } from "../packages/cli/src/help.js";
import { main } from "../packages/cli/src/main.js";
import { validateConfig } from "../packages/config/src/index.js";

const ROOT = resolve(import.meta.dirname, "..");
const files: string[] = [join(ROOT, "README.md")];
const walk = (d: string) => {
  for (const e of readdirSync(d)) {
    const p = join(d, e);
    if (statSync(p).isDirectory()) {
      if (!p.includes("planning/foundation") && !p.includes("/product")) walk(p);
    } else if (p.endsWith(".md")) files.push(p);
  }
};
walk(join(ROOT, "documentation"));

/** Code blocks of a Markdown file with their language. */
function blocks(md: string): { lang: string; code: string }[] {
  return [...md.matchAll(/^```(\w*)\n([\s\S]*?)^```/gm)].map((m) => ({
    lang: m[1] ?? "",
    code: m[2] ?? "",
  }));
}

const commandLines: { file: string; line: string }[] = [];
const configs: { file: string; code: string }[] = [];
for (const f of files) {
  for (const b of blocks(readFileSync(f, "utf8"))) {
    if (["bash", "sh", "shell", ""].includes(b.lang))
      for (const raw of b.code.split("\n")) {
        const line = raw.replace(/\s+#.*$/, "").trim();
        const m = /^(?:npx\s+(?:--no-install\s+)?|pnpm\s+exec\s+)?smarttest(\s.*)?$/.exec(line);
        if (m) commandLines.push({ file: relative(ROOT, f), line });
      }
    if (["ts", "typescript", "js", "mjs"].includes(b.lang) && /defineConfig\(\{/.test(b.code))
      configs.push({ file: relative(ROOT, f), code: b.code });
  }
}

const argvOf = (line: string) =>
  (
    line
      .replace(/^(?:npx\s+(?:--no-install\s+)?|pnpm\s+exec\s+)?smarttest\s*/, "")
      .match(/"[^"]*"|'[^']*'|\S+/g) ?? []
  )
    .map((a) => a.replace(/^["']|["']$/g, ""))
    // placeholders such as <test> or <ref> stand for a value
    .map((a) => (/^<.+>$/.test(a) ? "x" : a))
    .filter((a) => a !== "|" && a !== "…" && a !== "[…]");

describe("documentation snippets", () => {
  it("finds command lines and configuration examples to check", () => {
    expect(commandLines.length).toBeGreaterThan(30);
    expect(configs.length).toBeGreaterThan(0);
  });

  it.each(commandLines.map((c) => [`${c.file}: ${c.line}`, c.line]))("%s", (_name, line) => {
    const argv = argvOf(line as string);
    const parsed = parse(argv);
    if (parsed.command)
      expect(Object.keys(COMMANDS), `unknown command "${parsed.command}"`).toContain(
        parsed.command,
      );
  });

  it("prints help for every documented command", async () => {
    const used = new Set(
      commandLines.map((c) => parse(argvOf(c.line)).command).filter((c): c is string => !!c),
    );
    for (const cmd of used) {
      let out = "";
      const code = await main([cmd, "--help"], {
        stdout: {
          write: (s: string) => {
            out += s;
            return true;
          },
          isTTY: false,
        },
        stderr: { write: () => true, isTTY: false },
      } as never);
      expect(code, cmd).toBe(0);
      expect(out, cmd).toContain(cmd);
    }
  });

  it.each(configs.map((c, i) => [`${c.file} #${i + 1}`, c.code]))(
    "configuration example %s is valid",
    (_n, code) => {
      const body = (code as string)
        .replace(/^import .*$/gm, "")
        .replace(/^\/\/.*$/gm, "")
        .replace(/export default defineConfig\(/, "return (")
        .replace(/\)\s*;?\s*$/, ")");
      const config = new Function(body)();
      const { errors } = validateConfig(config);
      expect(errors).toEqual([]);
    },
  );
});
