/**
 * The impact map: the part of the dependency graph the current change reaches, as nodes, edges
 * and one path per selection reason. Built from the same analysis as every other screen.
 *
 * Every hop of a reason's path is matched to the graph edge it came from, to name its kind and
 * confidence. A hop the graph stores no single edge for is never dropped or called unrelated: it
 * is `CONTAINS` when the traversal stepped into a unit of the same file, and `UNCLASSIFIED`
 * otherwise. Reasons without a graph path (traces, rules, triggers, fallback) become one edge
 * from their evidence to the test, named after the reason.
 */
import type {
  StudioImpactMap,
  StudioMapEdge,
  StudioMapEdgeKind,
  StudioMapNode,
  StudioMapPath,
} from "./contracts.js";
import type { Snapshot } from "./snapshot.js";

/** Paths sent to the browser at most; the rest are counted, never silently dropped. */
export const MAX_MAP_PATHS = 600;

const RESOURCE = "@resource";
const RANK = ["high", "medium", "low", "unknown"];

const fileOf = (label: string): string => {
  const hash = label.indexOf("#");
  return hash === -1 ? label : label.slice(0, hash);
};

/** The traversal's path label for a graph key (`file#unit`). */
function labelOf(key: string): string {
  const hash = key.indexOf("#");
  if (hash === -1) return key;
  const file = key.slice(0, hash);
  const unit = key.slice(hash + 1);
  if (file === RESOURCE) return unit;
  if (unit === "*" || unit === "@any") return file;
  return `${file}#${unit.replace(".@init", ".constructor")}`;
}

interface IndexedEdge {
  kind: string;
  confidence: string;
}

const edgeIndexMemo = new WeakMap<Snapshot, Map<string, IndexedEdge>>();

/** Graph edges keyed `dependent \0 dependency`, by the labels the traversal prints. */
function edgeIndex(snapshot: Snapshot): Map<string, IndexedEdge> {
  const memo = edgeIndexMemo.get(snapshot);
  if (memo) return memo;
  const index = new Map<string, IndexedEdge>();
  const graph = snapshot.analysis.graph as { toGraph?: () => { edges: IndexedEdgeSource[] } };
  for (const edge of graph?.toGraph?.().edges ?? []) {
    const key = `${labelOf(edge.from)}\u0000${labelOf(edge.to)}`;
    const prev = index.get(key);
    if (!prev || RANK.indexOf(edge.confidence) < RANK.indexOf(prev.confidence))
      index.set(key, { kind: edge.kind, confidence: edge.confidence });
  }
  edgeIndexMemo.set(snapshot, index);
  return index;
}

interface IndexedEdgeSource {
  from: string;
  to: string;
  kind: string;
  confidence: string;
}

/** The graph edge behind one hop `from → to` of a traversal path (the change flows to dependents). */
function hopOf(
  index: Map<string, IndexedEdge>,
  from: string,
  to: string,
): { kind: StudioMapEdgeKind; confidence: string | null } {
  const tries = [
    `${to}\u0000${from}`,
    `${fileOf(to)}\u0000${from}`,
    `${to}\u0000${fileOf(from)}`,
    `${fileOf(to)}\u0000${fileOf(from)}`,
  ];
  for (const key of tries) {
    const hit = index.get(key);
    if (hit) return { kind: hit.kind as StudioMapEdgeKind, confidence: hit.confidence };
  }
  if (fileOf(from) === fileOf(to)) return { kind: "CONTAINS", confidence: null };
  return { kind: "UNCLASSIFIED", confidence: null };
}

const EVIDENCE: Record<string, { kind: StudioMapEdgeKind; label: string }> = {
  "observed-execution": { kind: "OBSERVED_EXECUTION", label: "fresh trace" },
  "rule-match": { kind: "RULE", label: "rule" },
  "mandatory-trigger": { kind: "TRIGGER", label: "mandatory trigger" },
  fallback: { kind: "FALLBACK", label: "fallback: whole suite" },
  uncertainty: { kind: "UNCERTAINTY", label: "unresolved import" },
  "test-file-changed": { kind: "TEST_CHANGED", label: "test file changed" },
  "modified-symbol": { kind: "MODIFIED", label: "modified symbol" },
};

const mapMemo = new WeakMap<Snapshot, StudioImpactMap>();

/** Memoised per snapshot: a snapshot is never mutated after it is built. */
export function impactMapOf(snapshot: Snapshot): StudioImpactMap {
  const memo = mapMemo.get(snapshot);
  if (memo) return memo;
  const map = buildImpactMap(snapshot);
  mapMemo.set(snapshot, map);
  return map;
}

function buildImpactMap(snapshot: Snapshot): StudioImpactMap {
  const impact = snapshot.impact;
  const index = edgeIndex(snapshot);
  const nodes = new Map<string, StudioMapNode>();
  const edges = new Map<string, StudioMapEdge>();
  const paths: StudioMapPath[] = [];
  const changedFiles = new Set(impact.change.files.map((f) => f.path));
  const unprotected = new Set(impact.unprotected.map((u) => `${u.file}\u0000${u.unit}`));

  const node = (id: string, role: StudioMapNode["role"], label = id): StudioMapNode => {
    const existing = nodes.get(id);
    if (existing) {
      // A node is a test, else changed, else merely affected.
      if (role === "test" || (role === "changed" && existing.role === "affected"))
        existing.role = role;
      return existing;
    }
    const hash = id.indexOf("#");
    const file = id.startsWith("@") ? null : fileOf(id);
    const created: StudioMapNode = {
      id,
      label,
      file,
      unit: hash === -1 || id.startsWith("@") ? null : id.slice(hash + 1),
      role: file && changedFiles.has(file) && role === "affected" ? "changed" : role,
      unprotected: false,
    };
    nodes.set(id, created);
    return created;
  };

  // Every changed unit is a node, reached or not.
  const changed: StudioImpactMap["changed"] = [];
  for (const file of impact.change.files)
    for (const unit of file.units.length ? file.units : ["*"]) {
      const id = unit === "*" ? file.path : `${file.path}#${unit}`;
      const n = node(id, "changed");
      n.unprotected = unprotected.has(`${file.path}\u0000${unit}`);
      changed.push({ id, file: file.path, unit: unit === "*" ? null : unit });
    }

  const edge = (
    from: string,
    to: string,
    kind: StudioMapEdgeKind,
    confidence: string | null,
    test: string,
  ): string => {
    const id = `${from}\u0000${to}\u0000${kind}`;
    const existing = edges.get(id);
    if (existing) {
      if (!existing.tests.includes(test)) existing.tests.push(test);
      return id;
    }
    edges.set(id, { id, from, to, kind, confidence, tests: [test] });
    return id;
  };

  let total = 0;
  for (const test of impact.selected) {
    for (const reason of test.reasons) {
      total++;
      if (paths.length >= MAX_MAP_PATHS) continue;
      const route = reason.path?.filter(Boolean) ?? [];
      let ids: string[];
      let edgeIds: string[];
      let kinds: StudioMapEdgeKind[];
      if (route.length >= 2) {
        ids = [...route];
        if (fileOf(ids[ids.length - 1] as string) !== test.filePath) ids.push(test.filePath);
        // The traversal labels a test node by its file; keep one node per test file.
        ids[ids.length - 1] = test.filePath;
        ids.forEach((id, i) => {
          node(id, i === ids.length - 1 ? "test" : i === 0 ? "changed" : "affected");
        });
        edgeIds = [];
        kinds = [];
        for (let i = 0; i + 1 < ids.length; i++) {
          const from = ids[i] as string;
          const to = ids[i + 1] as string;
          const hop = hopOf(index, from, to);
          kinds.push(hop.kind);
          edgeIds.push(edge(from, to, hop.kind, hop.confidence, test.filePath));
        }
      } else {
        const evidence = EVIDENCE[reason.kind] ?? {
          kind: "UNCLASSIFIED" as const,
          label: reason.kind,
        };
        // A trace names the changed file it ran; tie the edge to it rather than to a pseudo node.
        const ran = /^Ran (.+?) when traced/.exec(reason.message)?.[1];
        const origin =
          route[0] ??
          (ran && changedFiles.has(ran)
            ? ran
            : `@${reason.kind}${reason.ruleName ? `:${reason.ruleName}` : ""}`);
        if (origin.startsWith("@"))
          node(
            origin,
            "evidence",
            reason.ruleName ? `${evidence.label}: ${reason.ruleName}` : evidence.label,
          );
        else node(origin, "changed");
        node(test.filePath, "test");
        ids = origin === test.filePath ? [origin] : [origin, test.filePath];
        kinds = ids.length > 1 ? [evidence.kind] : [];
        edgeIds =
          ids.length > 1
            ? [edge(origin, test.filePath, evidence.kind, reason.confidence, test.filePath)]
            : [];
      }
      paths.push({
        test: test.filePath,
        origin: ids[0] as string,
        originFile: ids[0]?.startsWith("@") ? null : fileOf(ids[0] as string),
        reasonKind: reason.kind,
        message: reason.message,
        confidence: reason.confidence,
        nodes: ids,
        edges: edgeIds,
        edgeKinds: kinds,
      });
    }
  }

  const reached = new Set(paths.map((p) => p.origin));
  const reachedFiles = new Set([...reached].map(fileOf));
  const edgeKinds = [...new Set([...edges.values()].map((e) => e.kind))].sort();
  const confidences = [...new Set(paths.map((p) => p.confidence ?? "not graded"))].sort(
    (a, b) => rankOf(a) - rankOf(b),
  );
  return {
    schemaVersion: 1,
    generatedAt: new Date(snapshot.createdAt).toISOString(),
    change: impact.change.description,
    nodes: [...nodes.values()],
    edges: [...edges.values()],
    paths,
    changed,
    // A whole-file change is reached when any path starts in that file; a unit, only by its own.
    unreached: changed
      .filter((c) => (c.unit === null ? !reachedFiles.has(c.file) : !reached.has(c.id)))
      .map((c) => ({ ...c, unprotected: nodes.get(c.id)?.unprotected ?? false })),
    edgeKinds,
    confidences,
    totalPaths: total,
    truncated: total > paths.length,
  };
}

const rankOf = (c: string) => {
  const i = RANK.indexOf(c);
  return i === -1 ? RANK.length : i;
};
