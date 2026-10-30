/**
 * SmartTest Studio server.
 *
 * A loopback HTTP server with one job: serve the Studio web app and answer its questions from a
 * single, real analysis of the project. Start it with {@link startStudio}.
 */

import { existsSync } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { dirname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { type Analysis, SmartTest, VERSION } from "@smarttest/core";
import { type SafetyMode, SmartTestError } from "@smarttest/shared";
import type { ChangeSource } from "@smarttest/vcs-core";
import { STUDIO_SCHEMA_VERSION, type StudioSessionInfo } from "./contracts.js";
import {
  booleanField,
  contentTypeOf,
  isRecord,
  readJsonBody,
  sendError,
  sendFile,
  sendJson,
  setBaseHeaders,
  sseWrite,
  stringField,
} from "./http.js";
import { RunManager } from "./runs.js";
import {
  assertLoopbackHost,
  checkApiRequest,
  checkHost,
  createSessionToken,
  originsFor,
  type SecurityPolicy,
} from "./security.js";
import {
  buildSnapshot,
  cacheInfo,
  fileIndexOf,
  isIndexedFile,
  type LastRunFacts,
  loadCoverage,
  loadLastRun,
  overviewOf,
  readLastRunReport,
  type Snapshot,
  safeProjectPath,
  sourceOf,
  testsOf,
  trustOf,
} from "./snapshot.js";

export interface StartStudioOptions {
  /** Project root to analyse. */
  root: string;
  /** Explicit config file, like `--config` on the CLI. */
  configPath?: string;
  /** Preferred port. When it is taken, Studio falls back to an ephemeral port. */
  port?: number;
  /** Loopback host. Anything else is refused. */
  host?: string;
  /** Override the `.smarttest` store directory (tests use this). */
  storeDir?: string;
  /**
   * Directory containing Studio's `index.html`. Defaults to the package's `web/` next to this
   * module, then `SMARTTEST_STUDIO_ASSETS`. Builds that bundle Studio into another output need to
   * copy `packages/studio/web` next to the bundle (see the Studio handoff) or pass this option.
   */
  assetDir?: string;
  /** Re-analyse when project files change (default true). */
  watch?: boolean;
}

export interface StudioServerHandle {
  /** URL to open. The session token travels in the fragment and never reaches the server. */
  url: string;
  port: number;
  token: string;
  root: string;
  close(): Promise<void>;
}

const DEFAULT_PORT = 4173;
const REPORT_FILES = new Set([
  "last-run.html",
  "last-run.json",
  "last-run.junit.xml",
  "last-run.md",
  "benchmark.json",
  "benchmark.md",
]);

const EMPTY_LAST: LastRunFacts = {
  run: null,
  cache: { files: 0, results: 0, lastCached: 0, integrityIssues: [] },
  flaky: [],
};

function sameSource(a: ChangeSource | null, b: ChangeSource | null): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

class Studio {
  readonly runs: RunManager;
  private snapshot: Snapshot | null = null;
  private inflight: { source: ChangeSource | null; promise: Promise<Snapshot> } | null = null;
  private last: LastRunFacts = EMPTY_LAST;
  private coverage: Snapshot["coverage"] = null;
  private source: ChangeSource | null = null;
  private readonly clients = new Set<ServerResponse>();
  private heartbeat: NodeJS.Timeout | null = null;
  private watcher: { close(): void } | null = null;
  private closing = false;

  constructor(readonly st: SmartTest) {
    this.runs = new RunManager(st, () => {
      // The run may have written coverage and traces: rebuild the snapshot that shows them.
      void this.loadRunState()
        .then(() => this.broadcast({ type: "lastRun", at: new Date().toISOString() }))
        .then(() => this.refresh())
        .catch((error) => this.broadcastError(error));
    });
    this.runs.listen((event) => this.broadcast(event));
  }

  get currentSource(): ChangeSource | null {
    return this.source;
  }

  boundPort = 0;

  async init(watch: boolean): Promise<void> {
    await this.refresh();
    if (watch && !this.closing) this.startWatching();
  }

  private async loadRunState(): Promise<void> {
    const [report, cache, flaky] = await Promise.all([
      readLastRunReport(this.st.storeDir),
      cacheInfo(this.st.storeDir),
      this.st.flakyTests().catch(() => []),
    ]);
    const [run, coverage] = await Promise.all([
      loadLastRun(this.st.storeDir, report),
      loadCoverage(this.st.storeDir, report),
    ]);
    this.last = {
      run,
      cache: {
        ...cache,
        lastCached: run?.summary?.cached ?? 0,
        integrityIssues: run?.integrityIssues ?? [],
      },
      flaky,
    };
    if (coverage) this.coverage = coverage;
    else if (run?.coverage)
      this.coverage = {
        runAt: run.finishedAt ?? run.startedAt,
        summary: {
          scope: run.coverage.scope,
          lines: run.coverage.lines,
          branches: run.coverage.branches,
          functions: run.coverage.functions,
          statements: run.coverage.statements,
          files: run.coverage.files,
        },
      };
  }

  async ensureSnapshot(): Promise<Snapshot> {
    if (this.snapshot) return this.snapshot;
    return this.refresh();
  }

  /**
   * Re-analyses the change. Concurrent callers for the same source share one analysis; a caller
   * that changes the source waits for the analysis in flight, then analyses the new source.
   */
  async refresh(source?: ChangeSource | null): Promise<Snapshot> {
    if (source !== undefined) this.source = source;
    while (this.inflight) {
      const pending = this.inflight;
      if (sameSource(pending.source, this.source)) return pending.promise;
      await pending.promise.catch(() => undefined);
      if (this.inflight === pending) this.inflight = null;
    }
    const wanted = this.source;
    const run = (async () => {
      const started = Date.now();
      const analysis: Analysis = await this.st.analyze(wanted ? { source: wanted } : {});
      const view = await this.st.traceView(analysis.input, analysis.index);
      // Runs started outside Studio (terminal, commit hook) change the last run and coverage.
      await this.loadRunState();
      const snapshot = await buildSnapshot(this.st, view, this.coverage, analysis);
      this.snapshot = snapshot;
      this.broadcast({
        type: "snapshot",
        at: new Date().toISOString(),
        counts: snapshot.impact.counts,
        change: snapshot.impact.change.description,
        analysisMs: Date.now() - started,
      });
      return snapshot;
    })();
    const entry = { source: wanted, promise: run };
    this.inflight = entry;
    try {
      return await run;
    } finally {
      if (this.inflight === entry) this.inflight = null;
    }
  }

  async current(): Promise<{ snapshot: Snapshot; last: LastRunFacts }> {
    const snapshot = await this.ensureSnapshot();
    return { snapshot, last: this.last };
  }

  private startWatching(): void {
    void (async () => {
      try {
        const profile = await this.st.profile();
        const { watchProject } = await import("@smarttest/core");
        const watcher = watchProject(this.st.root, {
          exclude: this.st.config.exclude,
          git: profile.vcs.provider === "git",
          debounceMs: 220,
          onCycle: async () => {
            try {
              await this.refresh();
            } catch (error) {
              this.broadcastError(error);
            }
          },
          onError: (error) => this.broadcastError(error),
        });
        if (this.closing) watcher.close();
        else this.watcher = watcher;
      } catch (error) {
        this.broadcastError(error);
      }
    })();
  }

  private broadcastError(error: unknown): void {
    const e = error as { code?: string; message?: string; hint?: string };
    this.broadcast({
      type: "error",
      at: new Date().toISOString(),
      error: {
        code: typeof e.code === "string" ? e.code : "ST_STUDIO_REFRESH",
        message: e.message ?? "Studio could not refresh",
        hint: e.hint ?? null,
      },
    });
  }

  broadcast(event: unknown): void {
    if (!this.clients.size) return;
    const payload = `data: ${JSON.stringify(event)}\n\n`;
    for (const client of this.clients) {
      try {
        client.write(payload);
      } catch {
        this.clients.delete(client);
      }
    }
  }

  addStream(req: IncomingMessage, res: ServerResponse): void {
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-store",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
      "Cross-Origin-Resource-Policy": "same-origin",
    });
    res.write("retry: 3000\n\n");
    this.clients.add(res);
    if (!this.heartbeat)
      this.heartbeat = setInterval(() => {
        for (const client of this.clients) client.write(": ping\n\n");
      }, 25_000);
    const cleanup = () => {
      this.clients.delete(res);
      if (!this.clients.size && this.heartbeat) {
        clearInterval(this.heartbeat);
        this.heartbeat = null;
      }
    };
    req.on("close", cleanup);
    res.on("close", cleanup);
    sseWrite(res, { type: "hello", at: new Date().toISOString() });
    const snapshot = this.snapshot;
    if (snapshot)
      sseWrite(res, {
        type: "snapshot",
        at: new Date(snapshot.createdAt).toISOString(),
        counts: snapshot.impact.counts,
        change: snapshot.impact.change.description,
        analysisMs: 0,
      });
  }

  async close(): Promise<void> {
    if (this.closing) return;
    this.closing = true;
    this.watcher?.close();
    this.watcher = null;
    await this.runs.close();
    for (const client of this.clients) {
      try {
        client.end();
      } catch {
        /* already gone */
      }
    }
    this.clients.clear();
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;
  }
}

// ── Assets ────────────────────────────────────────────────────────────────────────────────

function assetCandidates(): string[] {
  const here = dirname(fileURLToPath(import.meta.url));
  return [
    resolve(here, "..", "web"),
    resolve(here, "web"),
    resolve(here, "..", "..", "studio", "web"),
    resolve(process.cwd(), "packages", "studio", "web"),
    resolve(process.cwd(), "node_modules", "@smarttest", "studio", "web"),
  ];
}

export function findAssetDir(explicit?: string): string {
  const candidates = [
    ...(explicit ? [resolve(explicit)] : []),
    ...(process.env.SMARTTEST_STUDIO_ASSETS ? [resolve(process.env.SMARTTEST_STUDIO_ASSETS)] : []),
    ...assetCandidates(),
  ];
  for (const dir of candidates) if (existsSync(join(dir, "index.html"))) return dir;
  throw new SmartTestError("Studio's web assets were not found", {
    code: "ST_STUDIO_ASSETS",
    category: "infrastructure",
    hint: `Copy packages/studio/web next to the Studio server bundle, or set SMARTTEST_STUDIO_ASSETS. Tried: ${candidates.join(", ")}`,
  });
}

// ── Request routing ───────────────────────────────────────────────────────────────────────

type Handler = (req: IncomingMessage, res: ServerResponse, url: URL) => Promise<void>;

interface ApiRoute {
  pattern: RegExp;
  /** Explicit allowlist: a read route never mutates, and every mutation is a POST. */
  methods: readonly ("GET" | "POST")[];
  handler: Handler;
}

function originSources(body: unknown): ChangeSource | null {
  if (body === undefined || body === null) return null;
  if (!isRecord(body))
    throw new SmartTestError("Invalid change source", {
      code: "ST_STUDIO_SOURCE",
      category: "usage",
    });
  const kind = body.kind;
  if (kind === "staged" || kind === "push" || kind === "uncommitted") return { kind };
  if (kind === "snapshot") {
    const id = stringField(body, "id");
    return id ? { kind: "snapshot", id } : { kind: "snapshot" };
  }
  if (kind === "base") {
    const ref = stringField(body, "ref")?.trim();
    if (!ref)
      throw new SmartTestError("A base comparison needs a ref", {
        code: "ST_STUDIO_SOURCE",
        category: "usage",
        hint: "For example main or origin/main.",
      });
    const target = stringField(body, "target");
    const direct = booleanField(body, "direct");
    return {
      kind: "base",
      ref,
      ...(target ? { target } : {}),
      ...(direct === true ? { direct: true } : {}),
    };
  }
  throw new SmartTestError(`Unknown change source ${String(kind)}`, {
    code: "ST_STUDIO_SOURCE",
    category: "usage",
  });
}

function parseMode(body: Record<string, unknown>): SafetyMode | undefined {
  const mode = stringField(body, "mode");
  if (mode === undefined) return undefined;
  if (mode !== "safe" && mode !== "fast" && mode !== "balanced")
    throw new SmartTestError(`Unknown safety mode ${mode}`, {
      code: "ST_STUDIO_RUN_INPUT",
      category: "usage",
    });
  return mode;
}

function statusFor(error: unknown): number {
  if (!(error instanceof SmartTestError)) return 500;
  switch (error.category) {
    case "usage":
      return 400;
    case "policy":
      return 403;
    case "configuration":
      return 400;
    default:
      return 500;
  }
}

function handleError(res: ServerResponse, error: unknown): void {
  if (res.headersSent) {
    try {
      res.end();
    } catch {
      /* client went away */
    }
    return;
  }
  if (error instanceof SmartTestError) {
    sendError(res, statusFor(error), error.code, error.message, error.hint ?? null);
    return;
  }
  const e = error as { code?: string; message?: string; hint?: string; status?: unknown };
  // readJsonBody tags its own client errors (400 malformed, 413 too large).
  const status = e.status === 400 || e.status === 413 ? e.status : 500;
  sendError(
    res,
    status,
    typeof e.code === "string"
      ? e.code
      : status === 413
        ? "ST_STUDIO_BODY_TOO_LARGE"
        : status === 400
          ? "ST_STUDIO_BODY"
          : "ST_STUDIO_INTERNAL",
    e.message ?? "Studio hit an unexpected error",
    e.hint ?? null,
  );
}

function apiRoutes(studio: Studio): ApiRoute[] {
  const sourceFile = async (path: string) => {
    const { snapshot } = await studio.current();
    if (!isIndexedFile(snapshot, path))
      throw new SmartTestError(`${path} is not part of this project's analysed files`, {
        code: "ST_STUDIO_FILE",
        category: "usage",
        hint: "Pick a file from the list.",
      });
    return sourceOf(studio.st, snapshot, path);
  };

  return [
    {
      pattern: /^\/api\/session$/,
      methods: ["GET"],
      handler: async (_req, res) => {
        const { snapshot } = await studio.current();
        const info: StudioSessionInfo = {
          schemaVersion: STUDIO_SCHEMA_VERSION,
          version: VERSION,
          project: snapshot.impact.project.name,
          root: studio.st.root,
          port: studio.boundPort,
        };
        sendJson(res, 200, info);
      },
    },
    {
      pattern: /^\/api\/overview$/,
      methods: ["GET"],
      handler: async (_req, res) => {
        const { snapshot, last } = await studio.current();
        sendJson(res, 200, overviewOf(snapshot, last));
      },
    },
    {
      pattern: /^\/api\/impact$/,
      methods: ["GET"],
      handler: async (_req, res) => {
        const { snapshot } = await studio.current();
        sendJson(res, 200, snapshot.impact);
      },
    },
    {
      pattern: /^\/api\/tests$/,
      methods: ["GET"],
      handler: async (_req, res) => {
        const { snapshot, last } = await studio.current();
        sendJson(res, 200, testsOf(snapshot, last));
      },
    },
    {
      pattern: /^\/api\/trust$/,
      methods: ["GET"],
      handler: async (_req, res) => {
        const { snapshot, last } = await studio.current();
        const trust = await trustOf(studio.st, snapshot, last);
        if (last.cache.integrityIssues.length)
          trust.cache.integrityIssues = last.cache.integrityIssues;
        sendJson(res, 200, trust);
      },
    },
    {
      pattern: /^\/api\/files$/,
      methods: ["GET"],
      handler: async (_req, res) => {
        const { snapshot } = await studio.current();
        sendJson(res, 200, fileIndexOf(snapshot));
      },
    },
    {
      pattern: /^\/api\/source$/,
      methods: ["GET"],
      handler: async (_req, res, url) => {
        const path = url.searchParams.get("path") ?? "";
        const abs = safeProjectPath(studio.st.root, path);
        if (!abs)
          throw new SmartTestError("Invalid source path", {
            code: "ST_STUDIO_FILE",
            category: "usage",
          });
        sendJson(res, 200, await sourceFile(path));
      },
    },
    {
      pattern: /^\/api\/refresh$/,
      methods: ["POST"],
      handler: async (req, res) => {
        const body = await readJsonBody(req);
        const source = originSources(isRecord(body) ? body.source : undefined);
        const snapshot = await studio.refresh(source);
        sendJson(res, 200, {
          ok: true,
          description: snapshot.impact.change.description,
          counts: snapshot.impact.counts,
          analysis: snapshot.impact.analysis,
        });
      },
    },
    {
      pattern: /^\/api\/run$/,
      methods: ["POST"],
      handler: async (req, res) => {
        const body = await readJsonBody(req);
        if (!isRecord(body))
          throw new SmartTestError("Expected a JSON object", {
            code: "ST_STUDIO_RUN_INPUT",
            category: "usage",
          });
        const scope = stringField(body, "scope") ?? "affected";
        if (scope !== "affected" && scope !== "all" && scope !== "file")
          throw new SmartTestError(`Unknown run scope ${scope}`, {
            code: "ST_STUDIO_RUN_INPUT",
            category: "usage",
          });
        const { snapshot } = await studio.current();
        const file = stringField(body, "file");
        if (scope === "file" && (!file || !safeProjectPath(studio.st.root, file)))
          throw new SmartTestError("A single-file run needs a project-relative test file", {
            code: "ST_STUDIO_RUN_INPUT",
            category: "usage",
          });
        const mode = parseMode(body);
        const source = originSources(body.source);
        const cache = booleanField(body, "cache");
        const coverage = booleanField(body, "coverage");
        const bail = booleanField(body, "bail");
        const run = studio.runs.start({
          scope,
          ...(file ? { file } : {}),
          knownTests: snapshot.analysis.testFiles,
          ...(mode ? { mode } : {}),
          ...(cache !== undefined ? { cache } : {}),
          ...(coverage !== undefined ? { coverage } : {}),
          ...(bail !== undefined ? { bail } : {}),
          ...(source ? { source } : {}),
        });
        sendJson(res, 202, { runId: run.id, run });
      },
    },
    {
      pattern: /^\/api\/runs$/,
      methods: ["GET"],
      handler: async (_req, res) => {
        sendJson(res, 200, { active: studio.runs.activeId, runs: studio.runs.recent() });
      },
    },
    {
      pattern: /^\/api\/runs\/([^/]+)$/,
      methods: ["GET"],
      handler: async (_req, res, url) => {
        const id = url.pathname.slice("/api/runs/".length);
        const run = studio.runs.get(id);
        if (!run)
          throw new SmartTestError(`Unknown run ${id}`, {
            code: "ST_STUDIO_RUN",
            category: "usage",
          });
        sendJson(res, 200, { run, events: studio.runs.eventsOf(id) });
      },
    },
    {
      pattern: /^\/api\/runs\/([^/]+)\/cancel$/,
      methods: ["POST"],
      handler: async (_req, res, url) => {
        const id = url.pathname.slice("/api/runs/".length, -"/cancel".length);
        const cancelled = studio.runs.cancel(id);
        sendJson(res, 200, { cancelled });
      },
    },
    {
      pattern: /^\/api\/stream$/,
      methods: ["GET"],
      handler: async (req, res) => {
        studio.addStream(req, res);
      },
    },
    {
      pattern: /^\/api\/reports\/([^/]+)$/,
      methods: ["GET"],
      handler: async (_req, res, url) => {
        // Report names are a fixed allowlist with no characters to decode.
        const name = url.pathname.slice("/api/reports/".length);
        if (!REPORT_FILES.has(name))
          throw new SmartTestError(`${name} is not a Studio-served report`, {
            code: "ST_STUDIO_FILE",
            category: "usage",
          });
        const reportAliases: Record<string, string> = {
          "last-run.html": "report.html",
          "last-run.json": "report.json",
          "last-run.junit.xml": "junit.xml",
          "last-run.md": "summary.md",
        };
        const abs = join(studio.st.storeDir, "reports", reportAliases[name] ?? name);
        const sent = await sendFile(res, abs, "no-store", {
          "Content-Disposition": `inline; filename="${name}"`,
        });
        if (!sent)
          sendError(
            res,
            404,
            "ST_STUDIO_FILE",
            `${name} has not been generated yet`,
            "Run the tests once to create it.",
          );
      },
    },
  ];
}

function isApiPath(pathname: string): boolean {
  return pathname === "/api" || pathname.startsWith("/api/");
}

/** Client-side routes rendered by `web/js/app.js`. */
const SPA_PATHS = new Set(["/overview", "/impact", "/change", "/tests", "/trust", "/source"]);

function serveStatic(assetDir: string): Handler {
  return async (req, res, url) => {
    if (req.method !== "GET" && req.method !== "HEAD") {
      sendError(res, 405, "ST_STUDIO_METHOD", "Method not allowed", null);
      return;
    }
    let rel: string;
    try {
      rel = decodeURIComponent(url.pathname);
    } catch {
      sendError(res, 400, "ST_STUDIO_PATH", "Invalid path", null);
      return;
    }
    if (rel === "/" || rel === "") rel = "/index.html";
    const clean = normalize(rel).replace(/^([/\\])+/, "");
    if (clean.startsWith("..") || clean.includes("\u0000")) {
      sendError(res, 400, "ST_STUDIO_PATH", "Invalid path", null);
      return;
    }
    const abs = resolve(assetDir, clean);
    if (abs !== assetDir && !abs.startsWith(assetDir + sep)) {
      sendError(res, 400, "ST_STUDIO_PATH", "Invalid path", null);
      return;
    }
    if (req.method === "HEAD") {
      const info = await stat(abs).catch(() => null);
      if (!info?.isFile()) {
        sendError(res, 404, "ST_STUDIO_NOT_FOUND", "Not found", null);
        return;
      }
      res.statusCode = 200;
      res.setHeader("Content-Type", contentTypeOf(abs));
      res.setHeader("Content-Length", info.size);
      res.end();
      return;
    }
    const sent = await sendFile(res, abs);
    if (sent) return;
    // The client renders these routes from the same document. Everything else — including an
    // extensionless traversal attempt such as `/etc/passwd` — is an honest 404.
    const spaPath = rel.length > 1 && rel.endsWith("/") ? rel.slice(0, -1) : rel;
    if (req.method === "GET" && SPA_PATHS.has(spaPath)) {
      if (await sendFile(res, join(assetDir, "index.html"), "no-store")) return;
    }
    sendError(res, 404, "ST_STUDIO_NOT_FOUND", "Not found", null);
  };
}

// ── Startup ──────────────────────────────────────────────────────────────────────────────

async function listenOn(server: Server, host: string, port: number): Promise<number> {
  const tryOnce = (p: number) =>
    new Promise<number>((resolvePort, reject) => {
      const onError = (error: NodeJS.ErrnoException) => {
        server.off("listening", onListening);
        reject(error);
      };
      const onListening = () => {
        server.off("error", onError);
        const address = server.address();
        resolvePort(typeof address === "object" && address ? address.port : p);
      };
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen(p, host);
    });
  try {
    return await tryOnce(port);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (port !== 0 && code === "EADDRINUSE") return tryOnce(0);
    throw error;
  }
}

export async function startStudio(options: StartStudioOptions): Promise<StudioServerHandle> {
  const host = options.host ?? "127.0.0.1";
  assertLoopbackHost(host);
  if (
    options.port !== undefined &&
    (!Number.isInteger(options.port) || options.port < 0 || options.port > 65535)
  )
    throw new SmartTestError(`Invalid port ${options.port}`, {
      code: "ST_STUDIO_PORT",
      category: "usage",
    });
  const assetDir = findAssetDir(options.assetDir);
  const st = await SmartTest.open({
    root: options.root,
    ...(options.configPath ? { configPath: options.configPath } : {}),
    ...(options.storeDir ? { storeDir: options.storeDir } : {}),
  });
  const token = createSessionToken();
  const studio = new Studio(st);
  const server = createServer();
  const routes = apiRoutes(studio);
  const staticHandler = serveStatic(assetDir);
  const port = await listenOn(
    server,
    host,
    options.port ?? Number(process.env.SMARTTEST_STUDIO_PORT ?? DEFAULT_PORT),
  );
  studio.boundPort = port;
  const policy: SecurityPolicy = {
    token,
    port,
    allowedOrigins: originsFor(host, port, ["localhost"]),
  };
  server.on("request", (req, res) => {
    setBaseHeaders(res);
    const hostVerdict = checkHost(req.headers.host, port);
    if (!hostVerdict.ok) {
      sendError(res, hostVerdict.status, hostVerdict.code, hostVerdict.message, hostVerdict.hint);
      return;
    }
    let url: URL;
    try {
      url = new URL(req.url ?? "/", `http://${host}:${port}`);
    } catch {
      sendError(res, 400, "ST_STUDIO_PATH", "Invalid URL", null);
      return;
    }
    const pathname = url.pathname;
    void (async () => {
      try {
        if (isApiPath(pathname)) {
          const verdict = checkApiRequest(req, policy);
          if (!verdict.ok) {
            sendError(res, verdict.status, verdict.code, verdict.message, verdict.hint);
            return;
          }
          const normalized =
            pathname.length > 1 && pathname.endsWith("/") ? pathname.slice(0, -1) : pathname;
          const route = routes.find((candidate) => candidate.pattern.test(normalized));
          if (!route) {
            sendError(res, 404, "ST_STUDIO_NOT_FOUND", `No Studio API at ${normalized}`, null);
            return;
          }
          const method = (req.method ?? "GET").toUpperCase();
          if (!route.methods.includes(method as "GET" | "POST")) {
            res.setHeader("Allow", route.methods.join(", "));
            sendError(
              res,
              405,
              "ST_STUDIO_METHOD",
              `${method} is not allowed on ${normalized}`,
              `Use ${route.methods.join(" or ")}.`,
            );
            return;
          }
          await route.handler(req, res, url);
          return;
        }
        await staticHandler(req, res, url);
      } catch (error) {
        handleError(res, error);
      }
    })();
  });
  const displayHost = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
  let closing: Promise<void> | null = null;
  const handle: StudioServerHandle = {
    url: `http://${displayHost}:${port}/#token=${token}`,
    port,
    token,
    root: st.root,
    close: () => {
      closing ??= (async () => {
        await studio.close();
        await new Promise<void>((resolveClose) => {
          // An SSE client holds its socket open. Studio ended its streams first; this timer is the
          // belt-and-braces so close() cannot hang forever on a stuck connection.
          const force = setTimeout(() => server.closeAllConnections(), 1_000);
          force.unref();
          server.close(() => {
            clearTimeout(force);
            resolveClose();
          });
          server.closeIdleConnections();
        });
      })();
      return closing;
    },
  };
  try {
    await studio.init(options.watch ?? true);
  } catch (error) {
    await handle.close();
    throw error;
  }
  return handle;
}
