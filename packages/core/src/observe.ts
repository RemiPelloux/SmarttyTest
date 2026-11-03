import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, isAbsolute, join, relative } from "node:path";
import { pathToFileURL } from "node:url";
import { toPosix } from "@smarttest/shared";
import { planExecution } from "@smarttest/test-selector";
import { restrictRunners, type SmartTest } from "./smarttest.js";
import { readV8Coverage } from "./traces.js";

const JS_RECORDER = `import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { join, resolve } from "node:path";
import { threadId } from "node:worker_threads";
// Test workers are often ended without an exit event: each new path is appended at once.
const out = process.env.SMARTTEST_READS;
const seen = new Set();
const append = fs.appendFileSync;
let file;
const note = (p) => {
  try {
    const abs = typeof p === "string" ? resolve(p) : p instanceof URL && p.protocol === "file:" ? decodeURIComponent(p.pathname) : undefined;
    if (!abs || seen.has(abs)) return;
    seen.add(abs);
    if (!file) {
      fs.mkdirSync(out, { recursive: true });
      file = join(out, process.pid + "-" + threadId + ".txt");
    }
    append(file, abs + "\\n");
  } catch {}
};
const wrap = (obj, name) => {
  const orig = obj[name];
  if (typeof orig !== "function") return;
  obj[name] = function (p, ...rest) { note(p); return orig.call(this, p, ...rest); };
};
for (const n of ["readFileSync", "readFile", "createReadStream", "openSync", "open"]) wrap(fs, n);
for (const n of ["readFile", "open"]) wrap(fs.promises, n);
syncBuiltinESMExports();
`;

const PY_RECORDER = `import atexit, builtins, io, json, os, sys
_out = os.environ.get("SMARTTEST_READS")
_seen = set()
_open = builtins.open
def _recording_open(file, *args, **kwargs):
    try:
        if isinstance(file, (str, bytes, os.PathLike)):
            _seen.add(os.path.abspath(os.fsdecode(file)))
    except Exception:
        pass
    return _open(file, *args, **kwargs)
def _dump():
    files = set(_seen)
    for module in list(sys.modules.values()):
        f = getattr(module, "__file__", None)
        if f:
            files.add(os.path.abspath(f))
    os.makedirs(_out, exist_ok=True)
    with _open(os.path.join(_out, "py-%d.json" % os.getpid()), "w") as fh:
        json.dump(sorted(files), fh)
if _out:
    builtins.open = _recording_open
    io.open = _recording_open
    atexit.register(_dump)
`;

const NOT_PROJECT =
  /(?:^|\/)(?:node_modules|\.venv|venv|site-packages|\.smarttest|__pycache__|\.git)\//;

/** For each test file run, the project files it loaded or read (the test itself excluded). */
export async function observeLoads(
  st: SmartTest,
  options: { sample?: number; runners?: readonly string[]; onProgress?: (m: string) => void } = {},
): Promise<{
  loaded: Map<string, string[]>;
  failed: string[];
  compiled: string[];
  /** Untracked build output a test read (`ui/dist/…`), by folder: built from sources SmartTest cannot name. */
  builtOutputs: Map<string, Set<string>>;
}> {
  const { index } = await st.loadIndex();
  // The hook's runners by default, as for `audit --mutate`: never a live end-to-end suite.
  const scope =
    options.runners?.[0] === "all" ? undefined : (options.runners ?? st.config.hook.runners);
  const { tests, roots, assignment } = restrictRunners(
    await st.discoverTests(index),
    scope?.length ? scope : undefined,
  );
  const wanted = options.sample ? tests.slice(0, options.sample) : tests;
  const plan = planExecution(wanted, roots, st.config.adapters, assignment);
  const work = await mkdtemp(join(tmpdir(), "smarttest-observe-"));
  const recorder = join(work, "record.mjs");
  const pyDir = join(work, "py");
  await writeFile(recorder, JS_RECORDER);
  await mkdir(pyDir, { recursive: true });
  await writeFile(join(pyDir, "sitecustomize.py"), PY_RECORDER);
  const loaded = new Map<string, string[]>();
  const failed: string[] = [];
  const compiled: string[] = [];
  const builtOutputs = new Map<string, Set<string>>();
  // Only files the project's version control lists can be part of a change: an ignored build
  // output a test reads (`ui/dist/…`) never is.
  const listed = new Set(await st.allFiles());
  const jobs = plan.groups.flatMap((g) => g.files.map((file) => ({ group: g, file })));
  let done = 0;
  try {
    for (const { group, file } of jobs) {
      const out = join(work, `run-${done}`);
      const coverage = join(out, "v8");
      const reads = join(out, "reads");
      const python = group.adapter === "pytest" || group.adapter === "unittest";
      const env: Record<string, string> = python
        ? {
            SMARTTEST_READS: reads,
            PYTHONPATH: [pyDir, process.env.PYTHONPATH].filter(Boolean).join(delimiter),
          }
        : {
            NODE_V8_COVERAGE: coverage,
            SMARTTEST_READS: reads,
            NODE_OPTIONS:
              `${process.env.NODE_OPTIONS ?? ""} --import ${pathToFileURL(recorder).href}`.trim(),
          };
      const run = await st
        .createAdapterFor({ ...group, files: [file] })
        .execute({ files: [file] }, { env, trace: true, timeoutMs: st.config.timeoutMs })
        .catch(() => undefined);
      done++;
      const files = new Set<string>();
      if (!python)
        // A bundler's module id may carry a query (`x.css?inline`, `x.html?raw`): the file is x.
        for (const f of (await readV8Coverage(coverage, st.root)).executed.keys()) {
          const plain = f.replace(/[?#].*$/, "");
          if (listed.has(plain)) files.add(plain);
        }
      // `ng test` compiles and type-checks the whole project first: its reads are the compiler's,
      // not the test's. Only the code the test ran counts there.
      const compiles = group.adapter === "angular";
      if (compiles) compiled.push(file);
      for (const name of compiles ? [] : await readdir(reads).catch(() => [] as string[])) {
        const text = await readFile(join(reads, name), "utf8").catch(() => "");
        let list: string[] = [];
        try {
          list = name.endsWith(".json") ? JSON.parse(text) : text.split("\n").filter(Boolean);
        } catch {
          list = [];
        }
        for (const abs of list) {
          const rel = toPosix(relative(st.root, abs.replace(/[?#].*$/, "")));
          if (
            !rel ||
            rel.startsWith("..") ||
            isAbsolute(rel) ||
            NOT_PROJECT.test(rel) ||
            rel.endsWith(".pyc")
          )
            continue;
          if (listed.has(rel)) files.add(rel);
          else {
            const out = /^(.*?(?:^|\/)(?:dist|build|out|\.output))\//.exec(rel)?.[1];
            if (out && existsSync(join(st.root, rel))) {
              const set = builtOutputs.get(out) ?? new Set<string>();
              set.add(file);
              builtOutputs.set(out, set);
            }
          }
        }
      }
      files.delete(file);
      if (!run || !files.size) {
        failed.push(file);
        options.onProgress?.(`[${done}/${jobs.length}] ${file} — nothing recorded`);
      } else {
        loaded.set(file, [...files].sort());
        options.onProgress?.(`[${done}/${jobs.length}] ${file} — ${files.size} file(s)`);
      }
      await rm(out, { recursive: true, force: true });
    }
  } finally {
    await rm(work, { recursive: true, force: true });
  }
  return { loaded, failed, compiled, builtOutputs };
}
