import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { OPTIONS } from "./args.js";
import { ALIASES, COMMANDS, commandHelp, LATER, rootHelp } from "./help.js";

// The parser accepts every option for every command, so "what a command accepts" is what its
// handler reads: `flags.x` / `flags["x"]` in its body and in the helpers it calls.
const SOURCE = readFileSync(new URL("./main.ts", import.meta.url), "utf8");
const FUNCTIONS = new Map<string, string>();
{
  const starts = [...SOURCE.matchAll(/^(?:export )?(?:async )?function (\w+)\(/gm)];
  for (const [i, m] of starts.entries())
    FUNCTIONS.set(m[1] as string, SOURCE.slice(m.index, starts[i + 1]?.index ?? SOURCE.length));
}
/** Helpers whose flags count for the command that calls them. */
const HELPERS = ["modeOf", "sourceOf", "onlyOf", "cmdHookRun"];
/** Flags every command takes, documented once under "Global flags". */
const GLOBAL = ["config", "json", "quiet", "verbose", "non-interactive", "help", "version"];
/** Flags a command reads only to refuse them, or sets itself before delegating. */
const REFUSED: Record<string, string[]> = {
  ci: ["base-mode"],
};

function flagsRead(body: string, seen = new Set<string>()): Set<string> {
  const flags = new Set<string>();
  for (const m of body.matchAll(/\bflags(?:\.(\w+)|\["([\w-]+)"\])/g))
    flags.add((m[1] ?? m[2]) as string);
  for (const helper of HELPERS) {
    if (seen.has(helper) || !new RegExp(`\\b${helper}\\(`).test(body)) continue;
    seen.add(helper);
    for (const f of flagsRead(FUNCTIONS.get(helper) ?? "", seen)) flags.add(f);
  }
  return flags;
}

function handlers(): [string, string][] {
  const table = /const HANDLERS[^{]*\{([\s\S]*?)\n\};/.exec(SOURCE)?.[1] ?? "";
  return [...table.matchAll(/^\s*"?([\w-]+)"?: (cmd\w+),/gm)].map((m) => [
    m[1] as string,
    m[2] as string,
  ]);
}

const mentions = (text: string, flag: string) => {
  const short = (OPTIONS as Record<string, { short?: string }>)[flag]?.short;
  return (
    new RegExp(`--${flag}(?![\\w-])`).test(text) ||
    (short !== undefined && new RegExp(`(^|[\\s[(])-${short}\\b`, "m").test(text))
  );
};

describe("help", () => {
  it("lists, for every command, each flag its handler reads", () => {
    const pairs = handlers();
    expect(pairs.length).toBeGreaterThan(20);
    // The scan sees the handler's own flags and those of the helpers it calls.
    expect([...flagsRead(FUNCTIONS.get("cmdRun") ?? "")]).toEqual(
      expect.arrayContaining(["timeout", "workers", "open", "output", "base", "target", "mode"]),
    );
    const missing: string[] = [];
    for (const [command, fn] of pairs) {
      const help = commandHelp(command);
      expect(help, command).toBeDefined();
      const body = FUNCTIONS.get(fn);
      expect(body, fn).toBeDefined();
      for (const flag of flagsRead(body as string)) {
        if (GLOBAL.includes(flag) || REFUSED[command]?.includes(flag)) continue;
        if (!(flag in OPTIONS)) continue;
        if (!mentions(help as string, flag)) missing.push(`${command}: --${flag}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it("documents every parser option somewhere", () => {
    const all = [rootHelp("0.0.0"), ...Object.keys(COMMANDS).map((c) => commandHelp(c))].join("\n");
    // `--fail-on-missed` is accepted for compatibility and has no effect.
    const undocumented = Object.keys(OPTIONS).filter(
      (f) => f !== "fail-on-missed" && !mentions(all, f),
    );
    expect(undocumented).toEqual([]);
  });

  it("answers aliases and reserved commands with their own text", () => {
    for (const alias of Object.keys(ALIASES))
      expect(commandHelp(alias)).toBe(commandHelp(ALIASES[alias] as string));
    for (const name of Object.keys(LATER)) {
      expect(commandHelp(name)).toContain(LATER[name]);
      expect(commandHelp(name)).not.toContain("Commands:");
    }
    const root = rootHelp("1.0.0");
    for (const f of ["-y, --yes", "-o, --output", "open"]) expect(root).toContain(f);
  });
});
