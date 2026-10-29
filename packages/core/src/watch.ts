/**
 * `smarttest watch`: reruns the tests affected by each save. A save is compared with the previous
 * save of the same file (or, the first time, with HEAD in Git repositories), so a cycle runs only
 * what the latest edit can affect.
 */
import { watch as fsWatch } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, sep } from "node:path";
import { matchGlob, runProcess } from "@smarttest/shared";
import type { ChangeAnalysisInput } from "@smarttest/vcs-core";

export interface WatchCycle {
  files: string[];
  input: ChangeAnalysisInput;
}

const IGNORED =
  /(^|\/)(node_modules|\.git|\.smarttest|dist|build|coverage|\.next|\.turbo|\.cache)(\/|$)/;

export interface Watcher {
  close(): void;
}

/**
 * Watches `root` and calls `onCycle` with a change set for each batch of saves (debounced).
 * Cycles never overlap: saves made while a cycle runs are batched into the next one.
 */
export function watchProject(
  root: string,
  options: {
    exclude: readonly string[];
    git: boolean;
    debounceMs?: number;
    onCycle: (cycle: WatchCycle) => Promise<void>;
    onError?: (error: Error) => void;
  },
): Watcher {
  const previous = new Map<string, string | undefined>();
  const pending = new Set<string>();
  let timer: NodeJS.Timeout | undefined;
  let running = false;
  const headContent = async (path: string): Promise<string | undefined> => {
    if (!options.git) return undefined;
    const r = await runProcess("git", ["show", `HEAD:${path}`], { cwd: root });
    return r.code === 0 ? r.stdout : undefined;
  };
  const flush = async () => {
    if (running || !pending.size) return;
    running = true;
    const files = [...pending].sort();
    pending.clear();
    try {
      const now = new Map<string, string | undefined>();
      for (const f of files)
        now.set(f, await readFile(join(root, f), "utf8").catch(() => undefined));
      const before = new Map<string, string | undefined>();
      for (const f of files)
        before.set(f, previous.has(f) ? previous.get(f) : await headContent(f));
      const changes = files
        .filter((f) => before.get(f) !== now.get(f))
        .map((f) => ({
          type: (before.get(f) === undefined
            ? "added"
            : now.get(f) === undefined
              ? "deleted"
              : "modified") as "added" | "deleted" | "modified",
          path: f,
        }));
      for (const [f, c] of now) previous.set(f, c);
      if (changes.length) {
        const input: ChangeAnalysisInput = {
          changeSet: {
            provider: options.git ? "git" : "native",
            completeness: "complete",
            warnings: [],
            changes,
          },
          readBefore: async (p) => before.get(p),
          description: `watch · ${changes.length} saved file${changes.length === 1 ? "" : "s"}`,
        };
        await options.onCycle({ files: changes.map((c) => c.path), input });
      }
    } catch (error) {
      options.onError?.(error as Error);
    } finally {
      running = false;
      if (pending.size) schedule();
    }
  };
  const schedule = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => void flush(), options.debounceMs ?? 150);
  };
  const w = fsWatch(root, { recursive: true }, (_event, name) => {
    if (!name) return;
    const rel = name.toString().split(sep).join("/");
    if (IGNORED.test(rel) || options.exclude.some((e) => matchGlob(rel, e))) return;
    pending.add(rel);
    schedule();
  });
  return {
    close: () => {
      if (timer) clearTimeout(timer);
      w.close();
    },
  };
}
