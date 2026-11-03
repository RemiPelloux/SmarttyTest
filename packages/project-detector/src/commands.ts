import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { readJson, readText } from "@smarttest/shared";

/** A test command found in hooks, package scripts or CI workflows. */
export interface ExistingTestCommand {
  /** File the command lives in (project-relative). */
  source: string;
  line: number;
  adapter: "jest" | "vitest" | "node";
  command: string;
  /** Directory the command runs in, when it can be inferred (`cd backend`, `--prefix`, package dir). */
  dir?: string;
  /** Paths the command explicitly skips (converted to project-relative globs). */
  ignores: string[];
  /** False when replacing this invocation would remove non-test work in its package script. */
  replaceable?: boolean;
}

const HOOK_FILES = [
  ".husky/pre-commit",
  ".husky/pre-push",
  ".git/hooks/pre-commit",
  ".git/hooks/pre-push",
  "lefthook.yml",
  ".lefthook.yml",
  "lefthook.yaml",
  ".lefthook.yaml",
  ".pre-commit-config.yaml",
];

/** Jest's --testPathIgnorePatterns takes regexes; turn simple ones into globs. */
function regexToGlob(regex: string, dir: string | undefined): string | undefined {
  const cleaned = regex.replace(/^["']|["']$/g, "").replace(/\\\./g, ".");
  if (/[()[\]|+^$]/.test(cleaned)) return undefined; // too complex to translate faithfully
  const body = cleaned.replace(/\.\*/g, "*");
  const prefix = dir ? `${dir}/` : "";
  return `${prefix}**/*${body.replace(/^\*|\*$/g, "")}*`;
}

function parseLine(
  line: string,
  cwdDir: string | undefined,
): Omit<ExistingTestCommand, "source" | "line"> | undefined {
  const adapter = /\bjest\b/.test(line)
    ? "jest"
    : /\bvitest\b/.test(line)
      ? "vitest"
      : /\bnode\b[^&|;]*\s--test\b/.test(line)
        ? "node"
        : undefined;
  if (!adapter) return undefined;
  const ignores: string[] = [];
  if (adapter === "jest") {
    for (const m of line.matchAll(/--testPathIgnorePatterns[= ]+(\S+)/g)) {
      const g = regexToGlob(m[1] as string, cwdDir);
      if (g) ignores.push(g);
    }
  }
  if (adapter === "vitest") {
    for (const m of line.matchAll(/--exclude[= ]+(\S+)/g))
      ignores.push(`${cwdDir ? `${cwdDir}/` : ""}${(m[1] as string).replace(/^["']|["']$/g, "")}`);
  }
  return { adapter, command: line.trim(), ...(cwdDir ? { dir: cwdDir } : {}), ignores };
}

async function scanScript(
  root: string,
  source: string,
  text: string,
  scripts: Record<string, string> = {},
): Promise<ExistingTestCommand[]> {
  const out: ExistingTestCommand[] = [];
  let cwdDir: string | undefined;
  // Join backslash-continued lines so multi-line invocations are seen whole.
  const raw = text.split(/\r?\n/);
  const lines: { text: string; line: number }[] = [];
  for (let i = 0; i < raw.length; i++) {
    let t = raw[i] as string;
    const start = i;
    while (t.trimEnd().endsWith("\\") && i + 1 < raw.length)
      t = `${t.trimEnd().slice(0, -1)} ${raw[++i]}`;
    lines.push({ text: t, line: start + 1 });
  }
  for (const { text: l, line } of lines) {
    // Comments and messages mention runners without running them.
    if (
      l.includes("# smarttest-replaced:") ||
      /^\s*(?::\s*)?(?:#|echo\b|printf\b|-\s*name:|name:)/.test(l) ||
      /\|\s*grep\b/.test(l)
    )
      continue;
    const cd = /^\s*cd\s+["']?([^"'\s;&]+)/.exec(l);
    if (cd) {
      const target = cd[1] as string;
      cwdDir =
        target.startsWith("$") || target === ".." || target === "-"
          ? undefined
          : target.replace(/\/$/, "");
    }
    let parsed = parseLine(l, cwdDir);
    // `npm test`, `npm run test:unit`, `pnpm test`, `yarn test` calling a test script.
    const run =
      /\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+|run-script\s+)?(test(?::[\w:-]+)?|[\w:-]+)\b/.exec(l);
    if (!parsed && run && !cwdDir) {
      const script = scripts[run[1] as string];
      const viaScript = script ? parseLine(script, undefined) : undefined;
      if (viaScript && !/playwright|cypress/.test(script as string))
        parsed = {
          ...viaScript,
          command: l.trim(),
          replaceable: !/[;&|`\n]/.test(script as string),
        };
    }
    if (parsed) out.push({ source, line, ...parsed });
  }
  void root;
  return out;
}

/** Finds how the project currently runs its tests (read-only). */
export async function detectTestCommands(
  root: string,
  projectDirs: readonly string[],
): Promise<ExistingTestCommand[]> {
  const out: ExistingTestCommand[] = [];
  const scripts =
    (await readJson<{ scripts?: Record<string, string> }>(join(root, "package.json")))?.scripts ??
    {};
  const copied = (await detectCopiedHooks(root)).map((c) => c.source);
  for (const f of [...new Set([...HOOK_FILES, ...copied])]) {
    const text = await readText(join(root, f));
    if (text) out.push(...(await scanScript(root, f, text, scripts)));
  }
  try {
    for (const f of await readdir(join(root, ".github", "workflows"))) {
      if (!/\.ya?ml$/.test(f)) continue;
      const text = await readText(join(root, ".github", "workflows", f));
      if (text) out.push(...(await scanScript(root, `.github/workflows/${f}`, text)));
    }
  } catch {
    /* no workflows */
  }
  for (const dir of ["", ...projectDirs]) {
    const pkg = await readJson<{ scripts?: Record<string, string> }>(
      join(root, dir, "package.json"),
    );
    for (const [name, cmd] of Object.entries(pkg?.scripts ?? {})) {
      const parsed = parseLine(cmd, dir || undefined);
      if (parsed)
        out.push({
          source: `${dir ? `${dir}/` : ""}package.json#scripts.${name}`,
          line: 0,
          ...parsed,
        });
    }
  }
  return out;
}

/** A hook script the repository keeps in its own tree and copies into Git's hooks directory. */
export interface CopiedHook {
  stage: "pre-commit" | "pre-push";
  /** Project-relative script that is copied (`scripts/hooks/pre-commit`). */
  source: string;
  /** Where the copy command lives (`package.json#scripts.prepare`, `scripts/install-hooks.sh`). */
  by: string;
  command: string;
}

/** Git's hooks directory however a script spells it: `$(git rev-parse --git-path hooks)`, … */
const HOOKS_DIR =
  /\$\(\s*git rev-parse --git-path hooks\s*\)|`\s*git rev-parse --git-path hooks\s*`|\$\(\s*git rev-parse --git-(?:common-)?dir\s*\)\/hooks|`\s*git rev-parse --git-(?:common-)?dir\s*`\/hooks/g;

/** Words of one shell command, quotes removed (no expansion). */
function words(command: string): string[] {
  return [...command.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)].map((m) => m[1] ?? m[2] ?? m[3] ?? "");
}

/**
 * Hook scripts that `package.json` scripts (or the shell scripts they run) copy into `.git/hooks`
 * with `cp` or `install`: SmartTest must edit the source, since the copy is overwritten by the
 * next install. (A symbolic link needs nothing: Git's path already resolves to the source.)
 */
export async function detectCopiedHooks(root: string): Promise<CopiedHook[]> {
  const scripts =
    (await readJson<{ scripts?: Record<string, string> }>(join(root, "package.json")))?.scripts ??
    {};
  const texts: { by: string; text: string }[] = Object.entries(scripts).map(([name, text]) => ({
    by: `package.json#scripts.${name}`,
    text,
  }));
  // Shell scripts a package script runs (`sh scripts/install-hooks.sh`, `./setup-hooks.sh`).
  for (const { text } of [...texts])
    for (const m of text.matchAll(
      /(?:^|[\s;&|])(?:(?:ba|z|da)?sh\s+)?((?:\.\/)?[\w./-]+\.sh)\b/g,
    )) {
      const file = (m[1] as string).replace(/^\.\//, "");
      const body = await readText(join(root, file));
      if (body) texts.push({ by: file, text: body });
    }
  const out: CopiedHook[] = [];
  const isDir = async (p: string) =>
    !!(await readdir(join(root, p)).then(
      () => true,
      () => false,
    ));
  for (const { by, text } of texts)
    for (const raw of text.replace(HOOKS_DIR, ".git/hooks").split(/&&|\|\||;|\n/)) {
      const w = words(raw.trim());
      if (w[0] !== "cp" && w[0] !== "install") continue;
      const args: string[] = [];
      for (let i = 1; i < w.length; i++) {
        const a = w[i] as string;
        if (a.startsWith("-")) {
          if (w[0] === "install" && /^-[mgo]$/.test(a)) i++; // `install -m 755 …`
          continue;
        }
        args.push(a);
      }
      const dest = args.pop();
      if (!dest || !/(?:^|\/)\.git\/hooks(?:\/|$)/.test(dest) || !args.length) continue;
      const destName = dest.replace(/\/$/, "").split("/").pop() ?? "";
      for (const stage of ["pre-commit", "pre-push"] as const)
        for (const src of args) {
          const clean = src.replace(/^\.\//, "").replace(/\/\*$/, "").replace(/\/$/, "");
          let source: string | undefined;
          if (destName === stage) source = clean;
          else if (clean.split("/").pop() === stage) source = clean;
          else if (src.endsWith("/*") || (await isDir(clean))) source = `${clean}/${stage}`;
          if (source && (await readText(join(root, source))) !== undefined)
            out.push({ stage, source, by, command: raw.trim() });
        }
    }
  return out;
}
