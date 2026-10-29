/**
 * @smarttest/native-snapshots — testing-oriented history without a VCS (spec §8).
 * Stores content hashes (and optionally deduplicated, compressed content) — never repository copies.
 */
import { randomBytes } from "node:crypto";
import { readdir, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import {
  type ChangeSet,
  changedLineRange,
  exists,
  type FileChange,
  readJson,
  SmartTestError,
  sha256,
  writeFileAtomic,
  writeJson,
} from "@smarttest/shared";
import type { ChangeAnalysisInput, ChangeProvider, ChangeSource } from "@smarttest/vcs-core";

export interface SnapshotEntry {
  hash: string;
  size: number;
  mtimeMs: number;
}

export interface Snapshot {
  id: string;
  createdAt: string;
  label?: string;
  storeContent: boolean;
  files: Record<string, SnapshotEntry>;
  /** A verified baseline has execution evidence attached (spec §8.7). */
  verified?: { runId: string; status: "passed" | "failed" };
  /** Optional Git revision this snapshot was taken at (hybrid mode). Never compared as a commit. */
  gitHead?: string;
}

export interface SnapshotSummary {
  id: string;
  createdAt: string;
  label?: string;
  files: number;
  storeContent: boolean;
  verified?: Snapshot["verified"];
}

export interface CreateSnapshotOptions {
  label?: string;
  storeContent?: boolean;
  gitHead?: string;
}

export class SnapshotStore implements ChangeProvider {
  readonly id = "native";
  private readonly dir: string;
  private readonly blobs: string;

  constructor(
    private readonly root: string,
    storeDir: string,
    private readonly listFiles: () => Promise<string[]>,
  ) {
    this.dir = join(storeDir, "state", "snapshots");
    this.blobs = join(storeDir, "state", "blobs");
  }

  private async read(id: string): Promise<Snapshot> {
    const snap = await readJson<Snapshot>(join(this.dir, `${id}.json`));
    if (!snap) {
      throw new SmartTestError(`Snapshot ${id} not found`, {
        code: "ST_SNAPSHOT_NOT_FOUND",
        category: "usage",
        hint: "List snapshots with `smarttest snapshot list`.",
      });
    }
    return snap;
  }

  async list(): Promise<SnapshotSummary[]> {
    if (!(await exists(this.dir))) return [];
    const ids = (await readdir(this.dir))
      .filter((f) => f.endsWith(".json"))
      .map((f) => f.slice(0, -5));
    const out: SnapshotSummary[] = [];
    for (const id of ids) {
      const s = await readJson<Snapshot>(join(this.dir, `${id}.json`));
      if (!s) continue;
      out.push({
        id: s.id,
        createdAt: s.createdAt,
        files: Object.keys(s.files).length,
        storeContent: s.storeContent,
        ...(s.label ? { label: s.label } : {}),
        ...(s.verified ? { verified: s.verified } : {}),
      });
    }
    return out.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  }

  async latest(): Promise<Snapshot | undefined> {
    const all = await this.list();
    const last = all.at(-1);
    return last ? this.read(last.id) : undefined;
  }

  async inspect(id?: string): Promise<Snapshot> {
    if (id) return this.read(id);
    const latest = await this.latest();
    if (!latest) {
      throw new SmartTestError("No snapshots yet", {
        code: "ST_SNAPSHOT_NONE",
        category: "usage",
        hint: "Create one with `smarttest snapshot create`.",
      });
    }
    return latest;
  }

  /** Fingerprints files: mtime+size pre-check against the previous snapshot, content hash to confirm. */
  private async fingerprint(
    previous: Snapshot | undefined,
    storeContent: boolean,
  ): Promise<Record<string, SnapshotEntry>> {
    const files = await this.listFiles();
    const out: Record<string, SnapshotEntry> = {};
    for (const path of files) {
      const abs = join(this.root, path);
      let st: import("node:fs").Stats;
      try {
        st = await stat(abs);
      } catch {
        continue;
      }
      const prev = previous?.files[path];
      if (
        prev &&
        prev.size === st.size &&
        prev.mtimeMs === st.mtimeMs &&
        (!storeContent || (await exists(this.blobPath(prev.hash))))
      ) {
        out[path] = prev;
        continue;
      }
      const content = await readFile(abs);
      const hash = sha256(content);
      out[path] = { hash, size: st.size, mtimeMs: st.mtimeMs };
      if (storeContent && !(await exists(this.blobPath(hash))))
        await writeFileAtomic(this.blobPath(hash), gzipSync(content));
    }
    return out;
  }

  private blobPath(hash: string): string {
    return join(this.blobs, hash.slice(0, 2), `${hash}.gz`);
  }

  async create(options: CreateSnapshotOptions = {}): Promise<Snapshot> {
    const previous = await this.latest();
    const storeContent = options.storeContent ?? false;
    const files = await this.fingerprint(previous, storeContent);
    const id = `snap_${Date.now().toString(36)}_${randomBytes(3).toString("hex")}`;
    const snapshot: Snapshot = {
      id,
      createdAt: new Date().toISOString(),
      storeContent,
      files,
      ...(options.label ? { label: options.label } : {}),
      ...(options.gitHead ? { gitHead: options.gitHead } : {}),
    };
    await writeJson(join(this.dir, `${id}.json`), snapshot);
    return snapshot;
  }

  async markVerified(id: string, runId: string, status: "passed" | "failed"): Promise<void> {
    const snap = await this.read(id);
    snap.verified = { runId, status };
    await writeJson(join(this.dir, `${id}.json`), snap);
  }

  async readContent(snapshot: Snapshot, path: string): Promise<string | undefined> {
    const entry = snapshot.files[path];
    if (!entry || !snapshot.storeContent) return undefined;
    try {
      return gunzipSync(await readFile(this.blobPath(entry.hash))).toString("utf8");
    } catch {
      return undefined;
    }
  }

  /** Compares the working tree with a snapshot. Missing content is reported as partial (spec §8.7). */
  async diff(id?: string): Promise<{ changeSet: ChangeSet; snapshot: Snapshot }> {
    const snapshot = await this.inspect(id);
    const current = await this.fingerprint(snapshot, false);
    const changes: FileChange[] = [];
    const removed = new Map<string, string>(); // hash -> path
    for (const [path, entry] of Object.entries(snapshot.files)) {
      if (!current[path]) removed.set(entry.hash, path);
    }
    const warnings: string[] = [];
    let unknownRanges = false;
    for (const [path, entry] of Object.entries(current)) {
      const prev = snapshot.files[path];
      if (!prev) {
        const from = removed.get(entry.hash);
        if (from) {
          removed.delete(entry.hash);
          changes.push({
            type: "renamed",
            path,
            previousPath: from,
            previousHash: entry.hash,
            currentHash: entry.hash,
          });
        } else changes.push({ type: "added", path, currentHash: entry.hash });
      } else if (prev.hash !== entry.hash) {
        const change: FileChange = {
          type: "modified",
          path,
          previousHash: prev.hash,
          currentHash: entry.hash,
        };
        const before = await this.readContent(snapshot, path);
        if (before !== undefined) {
          const after = await readFile(join(this.root, path), "utf8");
          const r = changedLineRange(before, after);
          if (r)
            change.changedRanges = [
              {
                start: { line: r.start, column: 0 },
                end: { line: r.end, column: Number.MAX_SAFE_INTEGER },
              },
            ];
        } else unknownRanges = true;
        changes.push(change);
      }
    }
    for (const [hash, path] of removed) changes.push({ type: "deleted", path, previousHash: hash });
    if (unknownRanges)
      warnings.push(
        "Snapshot stores hashes only — changed line ranges are unknown, whole files are treated as changed",
      );
    return {
      snapshot,
      changeSet: {
        provider: "native",
        baseRevision: snapshot.id,
        targetRevision: "working-tree",
        changes: changes.sort((a, b) => a.path.localeCompare(b.path)),
        completeness: unknownRanges ? "partial" : "complete",
        warnings,
      },
    };
  }

  async getChangeInput(source: ChangeSource): Promise<ChangeAnalysisInput> {
    const id = source.kind === "snapshot" ? source.id : undefined;
    const latest = id ? undefined : await this.latest();
    if (!id && !latest) {
      return {
        changeSet: {
          provider: "native",
          changes: [],
          completeness: "unknown",
          warnings: ["No snapshot yet — there is no baseline to compare against"],
        },
        readBefore: async () => undefined,
        description: "native snapshots · no baseline",
      };
    }
    const { changeSet, snapshot } = await this.diff(id ?? latest?.id);
    return {
      changeSet,
      readBefore: (path) => this.readContent(snapshot, path),
      description: `native snapshots · ${snapshot.id}…working tree`,
    };
  }

  /** Keeps the newest `keep` snapshots; verified baselines are kept unless `force`. */
  async prune(options: { keep: number; force?: boolean; dryRun?: boolean }): Promise<string[]> {
    const all = await this.list();
    const victims = all
      .slice(0, Math.max(0, all.length - options.keep))
      .filter((s) => options.force || !s.verified);
    if (!options.dryRun) {
      for (const v of victims) await rm(join(this.dir, `${v.id}.json`), { force: true });
      await this.collectGarbage();
    }
    return victims.map((v) => v.id);
  }

  private async collectGarbage(): Promise<void> {
    if (!(await exists(this.blobs))) return;
    const live = new Set<string>();
    for (const s of await this.list()) {
      const snap = await this.read(s.id);
      if (snap.storeContent) for (const e of Object.values(snap.files)) live.add(e.hash);
    }
    for (const shard of await readdir(this.blobs)) {
      for (const file of await readdir(join(this.blobs, shard))) {
        if (!live.has(file.replace(/\.gz$/, "")))
          await rm(join(this.blobs, shard, file), { force: true });
      }
    }
  }
}
