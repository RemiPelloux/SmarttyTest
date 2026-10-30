import { mkdir, rm, writeFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { edit, materialize } from "../../../integration-tests/helpers.js";
import type {
  StudioApiError,
  StudioFileIndex,
  StudioOverview,
  StudioSource,
  StudioTests,
} from "./contracts.js";
import { type StudioServerHandle, startStudio } from "./index.js";

let root = "";
let handle: StudioServerHandle;
let base = "";

const api = async (
  path: string,
  options: {
    method?: string;
    body?: unknown;
    headers?: Record<string, string>;
    token?: string | null;
  } = {},
): Promise<{ res: Response; json: unknown }> => {
  const { method = "GET", body, headers = {}, token = handle.token } = options;
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      ...(token === null ? {} : { "x-smarttest-token": token }),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...headers,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    redirect: "manual",
  });
  const type = res.headers.get("content-type") ?? "";
  return { res, json: type.includes("application/json") ? await res.json() : await res.text() };
};

const origin = () => `http://127.0.0.1:${handle.port}`;

function raw(
  path: string,
  headers: Record<string, string>,
): Promise<{
  status: number;
  body: string;
  headers: Record<string, string | string[] | undefined>;
}> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: "127.0.0.1",
        port: handle.port,
        path,
        method: "GET",
        headers: { connection: "close", ...headers },
      },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => (body += chunk));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body, headers: res.headers }));
      },
    );
    req.on("error", reject);
    req.end();
  });
}

it("serves last-run download names from the reports written by core", async () => {
  await mkdir(join(root, ".smarttest/reports"), { recursive: true });
  await writeFile(join(root, ".smarttest/reports/summary.md"), "# Real run report\n");
  const { res, json } = await api("/api/reports/last-run.md");
  expect(res.status).toBe(200);
  expect(json).toBe("# Real run report\n");
});

beforeAll(async () => {
  root = await materialize("ts-lib-vitest", { git: true });
  await edit(root, "src/util/strings.ts", "s.charAt(0).toUpperCase()", "s.charAt(0)");
  handle = await startStudio({
    root,
    port: 0,
    watch: false,
    storeDir: join(root, ".smarttest"),
  });
  base = `http://127.0.0.1:${handle.port}`;
}, 120_000);

afterAll(async () => {
  await handle?.close();
  if (root) await rm(root, { recursive: true, force: true });
});

describe("assets", () => {
  it("serves the Studio document with a locked-down CSP and no CORS", async () => {
    const res = await fetch(base);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const csp = res.headers.get("content-security-policy") ?? "";
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("script-src 'self'");
    expect(csp).not.toContain("'unsafe-inline'");
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("serves client-side routes from index.html and 404s missing assets", async () => {
    const impact = await fetch(`${base}/impact`);
    expect(impact.status).toBe(200);
    expect(await impact.text()).toContain("SmartTest Studio");
    const missing = await fetch(`${base}/missing.css`);
    expect(missing.status).toBe(404);
  });

  it("serves the app's own scripts and styles with their real content types", async () => {
    const script = await fetch(`${base}/js/app.js`);
    expect(script.status).toBe(200);
    expect(script.headers.get("content-type")).toContain("text/javascript");
    expect(await script.text()).toContain("SmartTest Studio");
    const style = await fetch(`${base}/app.css`);
    expect(style.status).toBe(200);
    expect(style.headers.get("content-type")).toContain("text/css");
    expect((await style.text()).length).toBeGreaterThan(1_000);
  });

  it("does not serve arbitrary files outside the asset directory", async () => {
    const traversal = await fetch(`${base}/%2e%2e/%2e%2e/etc/passwd`);
    expect(traversal.status).toBeGreaterThanOrEqual(400);
    const body = await traversal.text();
    expect(body).not.toContain("root:x:");
  });
});

describe("API authentication", () => {
  it("refuses an API call with no token", async () => {
    const { res, json } = await api("/api/session", { token: null });
    expect(res.status).toBe(401);
    expect((json as StudioApiError).error.code).toBe("ST_STUDIO_TOKEN");
  });

  it("refuses a wrong token even with a valid Origin", async () => {
    const { res, json } = await api("/api/session", {
      token: "not-the-token",
      headers: { origin: origin() },
    });
    expect(res.status).toBe(401);
    expect((json as StudioApiError).error.code).toBe("ST_STUDIO_TOKEN");
  });

  it("answers a token-authenticated session with real project facts", async () => {
    const { res, json } = await api("/api/session");
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
    expect(json).toMatchObject({
      schemaVersion: 1,
      project: "fixture-ts-lib-vitest",
      port: handle.port,
      root,
    });
  });

  it("rejects a foreign Host header (DNS rebinding)", async () => {
    const result = await raw("/api/session", {
      host: "evil.example",
      "x-smarttest-token": handle.token,
    });
    expect(result.status).toBe(403);
    expect(result.body).toContain("ST_STUDIO_HOST");
  });

  it("rejects a Host port that is not Studio's port", async () => {
    const result = await raw("/api/session", {
      host: "localhost:1",
      "x-smarttest-token": handle.token,
    });
    expect(result.status).toBe(403);
    expect(result.body).toContain("ST_STUDIO_HOST");
  });
});

describe("methods", () => {
  it("does not let a GET cancel a run", async () => {
    const { res, json } = await api("/api/runs/anything/cancel");
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toBe("POST");
    expect((json as StudioApiError).error.code).toBe("ST_STUDIO_METHOD");
  });

  it("does not let a GET start a run", async () => {
    const { res, json } = await api("/api/run");
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toBe("POST");
    expect((json as StudioApiError).error.code).toBe("ST_STUDIO_METHOD");
    const runs = await api("/api/runs");
    expect((runs.json as { active: string | null }).active).toBeNull();
  });

  it("does not let a GET refresh the analysis", async () => {
    const { res } = await api("/api/refresh");
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toBe("POST");
  });

  it("only reaches the cancel handler through a same-origin JSON POST", async () => {
    const noOrigin = await api("/api/runs/anything/cancel", { method: "POST" });
    expect(noOrigin.res.status).toBe(403);
    expect((noOrigin.json as StudioApiError).error.code).toBe("ST_STUDIO_ORIGIN");

    const formPost = await api("/api/runs/anything/cancel", {
      method: "POST",
      body: { anything: true },
      headers: { origin: origin(), "content-type": "application/x-www-form-urlencoded" },
    });
    expect(formPost.res.status).toBe(415);

    const crossSite = await api("/api/runs/anything/cancel", {
      method: "POST",
      body: {},
      headers: { origin: "http://evil.example" },
    });
    expect(crossSite.res.status).toBe(403);

    const ok = await api("/api/runs/anything/cancel", {
      method: "POST",
      body: {},
      headers: { origin: origin() },
    });
    expect(ok.res.status).toBe(200);
    expect(ok.json).toEqual({ cancelled: false });
  });

  it("answers a malformed or oversized body as a client error, not a server error", async () => {
    const post = (body: string) =>
      fetch(`${base}/api/refresh`, {
        method: "POST",
        headers: {
          "x-smarttest-token": handle.token,
          "content-type": "application/json",
          origin: origin(),
        },
        body,
      });
    const malformed = await post("{not json");
    expect(malformed.status).toBe(400);
    expect(((await malformed.json()) as StudioApiError).error.code).toBe("ST_STUDIO_BODY");
    const oversized = await post(JSON.stringify({ pad: "x".repeat(70 * 1024) }));
    expect(oversized.status).toBe(413);
    expect(((await oversized.json()) as StudioApiError).error.code).toBe(
      "ST_STUDIO_BODY_TOO_LARGE",
    );
  });

  it("refuses a protocol method that no route allows", async () => {
    const { res } = await api("/api/session", { method: "PUT" });
    expect(res.status).toBe(405);
  });

  it("refuses an unknown API route rather than falling back to the app", async () => {
    const { res, json } = await api("/api/nope");
    expect(res.status).toBe(404);
    expect((json as StudioApiError).error.code).toBe("ST_STUDIO_NOT_FOUND");
  });
});

describe("read models", () => {
  it("reports the edited file, its units and the tests it selects", async () => {
    const { res, json } = await api("/api/overview");
    expect(res.status).toBe(200);
    const overview = json as StudioOverview;
    expect(overview.counts.files).toBe(1);
    expect(overview.counts.total).toBe(4);
    expect(overview.counts.selected).toBeGreaterThan(0);
    expect(overview.change.files[0]?.path).toBe("src/util/strings.ts");
    expect(overview.topSelected.length).toBeGreaterThan(0);
    expect(overview.analysis.status).toBe("complete");
  });

  it("keeps selected and skipped test counts consistent with the rows", async () => {
    const tests = (await api("/api/tests")).json as StudioTests;
    expect(tests.rows.length).toBe(4);
    expect(tests.counts.selected).toBe(tests.rows.filter((r) => r.selection === "selected").length);
    expect(tests.counts.skipped).toBe(tests.rows.filter((r) => r.selection === "skipped").length);
    expect(tests.counts.selected + tests.counts.skipped).toBe(tests.rows.length);
    for (const row of tests.rows) expect(row.result).toBeNull();
  });

  it("serves the changed lines and units of a source file", async () => {
    const files = (await api("/api/files")).json as StudioFileIndex;
    expect(files.files.find((f) => f.path === "src/util/strings.ts")?.changed).toBe(true);
    expect(files.files.find((f) => f.path === "test/strings.test.ts")?.test).toBe(true);

    const source = (await api("/api/source?path=src/util/strings.ts")).json as StudioSource;
    expect(source.exists).toBe(true);
    expect(source.language).toBe("typescript");
    expect(source.lines.length).toBeGreaterThan(0);
    expect(source.changedLines.length).toBeGreaterThan(0);
    expect(source.units.some((unit) => unit.changed)).toBe(true);
    // Unit spans use the same one-based numbering as the lines they mark.
    const capitalize = source.units.find((unit) => unit.name === "capitalize");
    expect(capitalize?.startLine).toBe(
      source.lines.find((line) => line.text.includes("function capitalize"))?.n,
    );
    expect(source.note).toBeNull();
  });

  it("refuses a source path outside the project", async () => {
    const { res, json } = await api("/api/source?path=..%2F..%2F..%2Fetc%2Fpasswd");
    expect(res.status).toBe(400);
    expect((json as StudioApiError).error.code).toBe("ST_STUDIO_FILE");
  });

  it("answers trust with zeros, not invented history", async () => {
    const { json } = await api("/api/trust");
    expect(json).toMatchObject({
      schemaVersion: 1,
      shadow: { runs: 0, missed: 0, runsWithMisses: 0, selected: 0, total: 0, savedPct: 0 },
      benchmark: null,
      flaky: [],
      hooks: { runs: 0, failures: 0, bypasses: [] },
      cache: { files: 0, results: 0, lastRunCached: 0 },
      coverage: null,
    });
    expect((json as { shadow: { records: unknown[] } }).shadow.records).toEqual([]);
  });

  it("only serves allowlisted report names that exist", async () => {
    const missing = await api("/api/reports/last-run.json");
    expect(missing.res.status).toBe(404);
    expect((missing.json as StudioApiError).error.code).toBe("ST_STUDIO_FILE");
    const traversal = await api("/api/reports/..%2F..%2Fpackage.json");
    expect(traversal.res.status).toBe(400);
    expect((traversal.json as StudioApiError).error.code).toBe("ST_STUDIO_FILE");
  });

  it("keeps the Studio run id when the core report finishes under its own id", async () => {
    const started = await api("/api/run", {
      method: "POST",
      body: { scope: "affected" },
      headers: { origin: origin() },
    });
    expect(started.res.status).toBe(202);
    const runId = (started.json as { runId: string }).runId;
    expect(runId).toMatch(/^run_/);

    let run: Record<string, unknown> | null = null;
    for (let attempt = 0; attempt < 80; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      const polled = await api(`/api/runs/${runId}`);
      if (polled.res.status !== 200) continue;
      run = (polled.json as { run: Record<string, unknown> }).run;
      if (run.state === "done" || run.state === "failed") break;
    }
    expect(run).not.toBeNull();
    expect(run?.id).toBe(runId);
    expect(run?.state).toBe("done");
    expect(run?.summary).not.toBeNull();
    expect(Array.isArray(run?.executions)).toBe(true);
  }, 60_000);

  it("re-analyses through POST /api/refresh and keeps the counts", async () => {
    const { res, json } = await api("/api/refresh", {
      method: "POST",
      body: {},
      headers: { origin: origin() },
    });
    expect(res.status).toBe(200);
    expect(json).toMatchObject({ ok: true, counts: { files: 1 } });
  });
});

describe("shutdown", () => {
  it("closes even while an SSE client is connected", async () => {
    const res = await fetch(`${base}/api/stream`, {
      headers: { "x-smarttest-token": handle.token },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const reader = res.body?.getReader();
    if (!reader) throw new Error("SSE response has no body");
    const decoder = new TextDecoder();
    let received = "";
    // TCP may split the retry directive and hello event into separate chunks under contention.
    while (!received.includes('"type":"hello"')) {
      const chunk = await reader.read();
      if (chunk.done) throw new Error("SSE ended before hello");
      received += decoder.decode(chunk.value, { stream: true });
    }
    let deadline: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        Promise.all([handle.close(), handle.close()]),
        new Promise<never>((_, reject) => {
          deadline = setTimeout(() => reject(new Error("Studio shutdown did not settle")), 10_000);
        }),
      ]);
    } finally {
      clearTimeout(deadline);
      await reader?.cancel().catch(() => {});
    }
  }, 30_000);
});
