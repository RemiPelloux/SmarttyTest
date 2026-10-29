/**
 * Key-level diffs of non-code resources: environment files, Prisma schemas and translation
 * catalogs. A change to one key selects only the code that reads that key.
 */
import { sha256 } from "@smarttest/shared";

export type ResourceKind = "env" | "model" | "i18n";

export interface ResourceChange {
  file: string;
  kind: ResourceKind;
  /** Changed keys: env var names, model/enum names, translation key paths ("ns.a.b"). */
  keys: string[];
  /** Parts that cannot be attributed to keys (Prisma datasource/generator blocks…). */
  global: boolean;
}

const base = (p: string) => p.slice(p.lastIndexOf("/") + 1);

/** `.env`, `.env.test`, `.env.server`…, excluding documentation copies (`.env.example`). */
export function isEnvFile(path: string): boolean {
  const b = base(path);
  return /^\.env(\..+)?$/.test(b) && !/\.(example|sample|template|dist|defaults)$/.test(b);
}

export const isPrismaSchema = (path: string) => path.endsWith(".prisma");

export const isJsonCatalog = (path: string, localePath: RegExp) =>
  path.endsWith(".json") && localePath.test(path);

export function parseEnv(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_.-]*)\s*=\s*(.*)$/.exec(line);
    if (m) out.set(m[1] as string, m[2] as string);
  }
  return out;
}

/** Top-level Prisma blocks: "model:User" / "enum:Role" / "type:Address" / "other:datasource db". */
export function prismaBlocks(text: string): Map<string, string> {
  const out = new Map<string, string>();
  const clean = text.replace(/\/\/.*$/gm, "");
  let rest = "";
  let last = 0;
  const re = /^\s*(model|enum|type|view|datasource|generator)\s+(\w+)\s*\{/gm;
  let m: RegExpExecArray | null = re.exec(clean);
  while (m) {
    let depth = 1;
    let i = re.lastIndex;
    while (i < clean.length && depth > 0) {
      if (clean[i] === "{") depth++;
      else if (clean[i] === "}") depth--;
      i++;
    }
    rest += clean.slice(last, m.index);
    last = i;
    const kind = m[1] as string;
    const name = m[2] as string;
    const body = clean.slice(re.lastIndex, i).replace(/\s+/g, " ").trim();
    const isModel = kind === "model" || kind === "enum" || kind === "type" || kind === "view";
    out.set(isModel ? `model:${name}` : `other:${kind} ${name}`, body);
    re.lastIndex = i;
    m = re.exec(clean);
  }
  rest += clean.slice(last);
  if (rest.trim()) out.set("other:rest", rest.replace(/\s+/g, " ").trim());
  return out;
}

export function flattenJson(
  value: unknown,
  prefix = "",
  out: Record<string, string> = {},
): Record<string, string> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    for (const [k, v] of Object.entries(value)) flattenJson(v, prefix ? `${prefix}.${k}` : k, out);
  } else out[prefix] = sha256(JSON.stringify(value)).slice(0, 16);
  return out;
}

const changedKeys = <V>(a: Map<string, V>, b: Map<string, V>): string[] =>
  [...new Set([...a.keys(), ...b.keys()])].filter((k) => a.get(k) !== b.get(k)).sort();

/** Translation namespace of a catalog file: `locales/en/auth.json` → "auth"; `en.json` → "". */
function namespaceOf(path: string): string {
  const name = base(path).replace(/\.[^.]+$/, "");
  return /^[a-z]{2}([-_][A-Za-z]{2,4})?$/.test(name) ? "" : name;
}

export function diffCatalog(
  path: string,
  before: Record<string, string> | undefined,
  after: Record<string, string> | undefined,
): ResourceChange {
  const keys = changedKeys(
    new Map(Object.entries(before ?? {})),
    new Map(Object.entries(after ?? {})),
  );
  const ns = namespaceOf(path);
  return {
    file: path,
    kind: "i18n",
    keys: keys.map((k) => (ns ? `${ns}.${k}` : k)),
    global: false,
  };
}

/**
 * Key-level diff of a resource file, or undefined when the file is not a resource or cannot be
 * read as one (the caller then falls back to file-level handling).
 */
export function diffResource(
  path: string,
  before: string | undefined,
  after: string | undefined,
  localePath: RegExp,
): ResourceChange | undefined {
  if (isEnvFile(path)) {
    const keys = changedKeys(parseEnv(before ?? ""), parseEnv(after ?? ""));
    return { file: path, kind: "env", keys, global: false };
  }
  if (isPrismaSchema(path)) {
    const changed = changedKeys(prismaBlocks(before ?? ""), prismaBlocks(after ?? ""));
    return {
      file: path,
      kind: "model",
      keys: changed.filter((k) => k.startsWith("model:")).map((k) => k.slice(6)),
      global: changed.some((k) => k.startsWith("other:")),
    };
  }
  if (isJsonCatalog(path, localePath)) {
    try {
      const a = before === undefined ? {} : flattenJson(JSON.parse(before));
      const b = after === undefined ? {} : flattenJson(JSON.parse(after));
      return diffCatalog(path, a, b);
    } catch {
      return undefined;
    }
  }
  return undefined;
}
