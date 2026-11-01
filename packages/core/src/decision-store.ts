/**
 * `runs/last-decision.json`: the last impact decision, which `explain` shows again while the change
 * is the same. Every selected test carries the dependency path that selected it, and those paths
 * share their beginnings (they start at the same changed files): stored as they were, they were
 * most of a 2.3 MB file for 1,200 tests. Here each path is a node of a prefix tree (parent
 * pointers), each file or unit name stored once; reading gives back the exact same paths.
 */

/** Format of the stored file; 1 (no `format` field) stored the paths as they are. */
export const DECISION_FORMAT = 2;

interface PathTable {
  /** Path elements (`src/a.ts#fn`, `test/a.test.ts`), each once. */
  strings: string[];
  /** Flat pairs: [parent node or -1, string]; a path is the node of its last element. */
  nodes: number[];
}

/** Arrays of strings under a `path` key: dependency paths (selection reasons, runner hits). */
const isPath = (key: string, value: unknown): value is string[] =>
  key === "path" && Array.isArray(value) && value.every((v) => typeof v === "string");

/** JSON text of `record`, its `path` arrays stored in a shared prefix tree. */
export function encodeDecisionRecord(record: Record<string, unknown>): string {
  const strings: string[] = [];
  const stringIds = new Map<string, number>();
  const nodes: number[] = [];
  const nodeIds = new Map<string, number>();
  const node = (path: readonly string[]): number => {
    let parent = -1;
    for (const s of path) {
      let sid = stringIds.get(s);
      if (sid === undefined) {
        sid = strings.length;
        strings.push(s);
        stringIds.set(s, sid);
      }
      const key = `${parent}:${sid}`;
      let id = nodeIds.get(key);
      if (id === undefined) {
        id = nodes.length / 2;
        nodes.push(parent, sid);
        nodeIds.set(key, id);
      }
      parent = id;
    }
    return parent;
  };
  const body = JSON.stringify(record, (key, value: unknown) =>
    isPath(key, value) ? node(value) : value,
  );
  const paths: PathTable = { strings, nodes };
  // `format` and the table first; the body's own fields follow unchanged.
  return `{"format":${DECISION_FORMAT},"paths":${JSON.stringify(paths)},${body.slice(1)}\n`;
}

/** Reads what `encodeDecisionRecord` wrote (or a record of format 1); undefined if unreadable. */
export function decodeDecisionRecord<T>(text: string): T | undefined {
  let format: { format?: unknown; paths?: PathTable } | undefined;
  try {
    // The table is needed before the body can be revived: read the head first.
    format = JSON.parse(text) as typeof format;
  } catch {
    return undefined;
  }
  if (!format || typeof format !== "object") return undefined;
  if (format.format === undefined) return format as T;
  if (format.format !== DECISION_FORMAT) return undefined;
  const table = format.paths;
  if (!table || !Array.isArray(table.strings) || !Array.isArray(table.nodes)) return undefined;
  const cache = new Map<number, string[]>();
  const pathOf = (id: number): string[] | undefined => {
    if (id === -1) return [];
    const hit = cache.get(id);
    if (hit) return hit;
    const out: string[] = [];
    for (let n = id, steps = 0; n !== -1; steps++) {
      const parent = table.nodes[n * 2];
      const s = table.strings[table.nodes[n * 2 + 1] as number];
      if (typeof parent !== "number" || typeof s !== "string" || parent >= n || steps > 1e6)
        return undefined;
      out.push(s);
      n = parent;
    }
    out.reverse();
    cache.set(id, out);
    return out;
  };
  let damaged = false;
  const revive = (value: unknown, key: string): unknown => {
    if (key === "path" && typeof value === "number") {
      const p = pathOf(value);
      if (!p) damaged = true;
      return p ? [...p] : undefined;
    }
    if (Array.isArray(value)) return value.map((v) => revive(v, ""));
    if (value && typeof value === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value)) out[k] = revive(v, k);
      return out;
    }
    return value;
  };
  const { format: _f, paths: _p, ...rest } = format;
  const decoded = revive(rest, "") as T;
  return damaged ? undefined : decoded;
}
