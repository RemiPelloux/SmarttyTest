/**
 * Python module resolution (preview), as `python -m pytest` or `python -m unittest` would find
 * modules from the project directory: the project root, `src/`, the `pythonpath` of the pytest
 * configuration, and the directory above a file's top package (pytest's rootdir insertion).
 *
 * A module found nowhere in the project is external when it is in the standard library, declared
 * (requirements, pyproject, Pipfile, setup.cfg) or installed in the project's virtual environment.
 * Anything else is unresolved: uncertainty, so the tests that reach it are selected.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { ModuleResolver, ResolveResult } from "@smarttest/source-parser";
import { PYTHON_STDLIB } from "./stdlib.js";

export const PYTHON_RESOLVER_VERSION = "py-r3";

/** Distribution names whose import name differs (`pip install pyyaml` → `import yaml`). */
const IMPORT_NAMES: Record<string, string[]> = {
  pyyaml: ["yaml"],
  beautifulsoup4: ["bs4"],
  pillow: ["PIL"],
  "python-dateutil": ["dateutil"],
  "scikit-learn": ["sklearn"],
  "opencv-python": ["cv2"],
  "opencv-python-headless": ["cv2"],
  attrs: ["attr", "attrs"],
  protobuf: ["google"],
  pyjwt: ["jwt"],
  "psycopg2-binary": ["psycopg2"],
  "python-dotenv": ["dotenv"],
  "python-multipart": ["multipart"],
  "typing-extensions": ["typing_extensions"],
  "google-cloud-storage": ["google"],
  pymongo: ["pymongo", "bson", "gridfs"],
  setuptools: ["setuptools", "pkg_resources"],
};

/** pytest and its own modules: importable wherever pytest runs the tests. */
const RUNNER_MODULES = new Set(["pytest", "_pytest", "pluggy", "py"]);

const PROJECT_FILES = ["pyproject.toml", "setup.py", "setup.cfg", "pytest.ini", "tox.ini"];

const normalize = (dist: string) => dist.toLowerCase().replace(/[_.]+/g, "-");

export class PythonResolver implements ModuleResolver {
  private readonly cache = new Map<string, ResolveResult>();
  private readonly rootsByBase = new Map<string, string[]>();
  private readonly known = new Map<string, Set<string>>();

  constructor(private readonly root: string) {}

  private isFile(rel: string): boolean {
    try {
      return statSync(join(this.root, rel)).isFile();
    } catch {
      return false;
    }
  }

  private isDir(rel: string): boolean {
    try {
      return statSync(join(this.root, rel)).isDirectory();
    } catch {
      return false;
    }
  }

  private read(rel: string): string {
    try {
      return readFileSync(join(this.root, rel), "utf8");
    } catch {
      return "";
    }
  }

  /** The nearest folder above `dir` (or `dir`) holding a Python project file, below the root. */
  private pythonProjectOf(dir: string): string | undefined {
    for (let d = dir; d; d = d.includes("/") ? d.slice(0, d.lastIndexOf("/")) : "")
      if (PROJECT_FILES.some((f) => this.isFile(`${d}/${f}`))) return d;
    return undefined;
  }

  /** Directories modules are imported from, for the Python project at `base` ("" = the root). */
  private sourceRoots(base = ""): string[] {
    const cached = this.rootsByBase.get(base);
    if (cached) return cached;
    const at = (p: string) => (base && p ? `${base}/${p}` : base || p);
    const roots = [at("")];
    if (this.isDir(at("src"))) roots.push(at("src"));
    // [tool.pytest.ini_options] pythonpath = ["lib", "."] / pytest.ini `pythonpath = lib`
    const cfg = ["pyproject.toml", "pytest.ini", "setup.cfg", "tox.ini"]
      .map((f) => this.read(at(f)))
      .join("\n");
    for (const m of cfg.matchAll(/^\s*pythonpath\s*=\s*(.+)$/gm)) {
      const raw = m[1] as string;
      const values = raw.includes("[")
        ? [...raw.matchAll(/["']([^"']+)["']/g)].map((x) => x[1] as string)
        : raw.split(/\s+/);
      for (const v of values) {
        const dir = at(v.replace(/^\.\/?/, "").replace(/\/$/, ""));
        if (!roots.includes(dir)) roots.push(dir);
      }
    }
    // setup.cfg [options] package_dir = =src
    for (const m of cfg.matchAll(/^\s*package_dir\s*=\s*\n?\s*=\s*(\S+)/gm)) {
      const dir = at((m[1] as string).replace(/\/$/, ""));
      if (!roots.includes(dir)) roots.push(dir);
    }
    this.rootsByBase.set(base, roots);
    return roots;
  }

  /** Top-level import names that are declared or installed: external, not missing. */
  private knownPackages(base: string): Set<string> {
    const cached = this.known.get(base);
    if (cached) return cached;
    const at = (p: string) => (base ? `${base}/${p}` : p);
    const names = new Set<string>();
    const addDist = (dist: string) => {
      const d = normalize(dist.trim());
      if (!d) return;
      for (const n of IMPORT_NAMES[d] ?? [d.replace(/-/g, "_")]) names.add(n);
    };
    const reqName = (spec: string) => /^\s*([A-Za-z0-9][A-Za-z0-9._-]*)/.exec(spec)?.[1];
    let top: string[] = [];
    try {
      top = readdirSync(join(this.root, base));
    } catch {
      top = [];
    }
    for (const f of top.filter((x) => /^requirements.*\.(txt|in)$/.test(x)))
      for (const line of this.read(at(f)).split("\n")) {
        if (/^\s*(#|-)/.test(line)) continue;
        const n = reqName(line);
        if (n) addDist(n);
      }
    const pyproject = this.read(at("pyproject.toml"));
    // [project] dependencies = ["requests>=2", …] and optional-dependencies.
    for (const m of pyproject.matchAll(/^\s*(?:dependencies|[\w-]+)\s*=\s*\[([\s\S]*?)\]/gm))
      for (const s of (m[1] as string).matchAll(/["']([^"']+)["']/g)) {
        const n = reqName(s[1] as string);
        if (n) addDist(n);
      }
    // [tool.poetry.dependencies] / [tool.poetry.group.dev.dependencies] / Pipfile [packages]
    const tables = `${pyproject}\n${this.read(at("Pipfile"))}`;
    for (const t of tables.matchAll(
      /^\[(?:tool\.poetry(?:\.group\.[\w-]+)?\.dependencies|tool\.poetry\.dev-dependencies|packages|dev-packages)\]\s*\n([\s\S]*?)(?=^\[|$(?![\s\S]))/gm,
    ))
      for (const line of (t[1] as string).split("\n")) {
        const n = /^\s*["']?([A-Za-z0-9][A-Za-z0-9._-]*)["']?\s*=/.exec(line)?.[1];
        if (n && n !== "python") addDist(n);
      }
    for (const m of this.read(at("setup.cfg")).matchAll(
      /install_requires\s*=\s*\n((?:[ \t]+.+\n?)+)/g,
    ))
      for (const line of (m[1] as string).split("\n")) {
        const n = reqName(line);
        if (n) addDist(n);
      }
    // Installed in the project's virtual environment.
    const envs = [
      ".venv",
      "venv",
      "env",
      ...(process.env.VIRTUAL_ENV ? [process.env.VIRTUAL_ENV] : []),
    ];
    for (const env of envs) {
      const lib = env.startsWith("/") ? join(env, "lib") : join(this.root, base, env, "lib");
      let pythons: string[] = [];
      try {
        pythons = readdirSync(lib).filter((d) => d.startsWith("python"));
      } catch {
        continue;
      }
      for (const py of pythons) {
        const site = join(lib, py, "site-packages");
        let entries: string[] = [];
        try {
          entries = readdirSync(site);
        } catch {
          continue;
        }
        for (const e of entries) {
          if (e.endsWith(".dist-info") || e.endsWith(".egg-info")) {
            try {
              for (const n of readFileSync(join(site, e, "top_level.txt"), "utf8").split("\n"))
                if (n.trim()) names.add(n.trim());
            } catch {
              addDist(e.replace(/-\d.*$/, ""));
            }
          } else names.add(e.replace(/\.(py|pyd|so)$/, "").replace(/\.cpython.*$/, ""));
        }
      }
    }
    this.known.set(base, names);
    return names;
  }

  /** `a/b` as a module: `a/b.py` or the package `a/b/__init__.py`. */
  private moduleFile(base: string): string | undefined {
    if (this.isFile(`${base}.py`)) return `${base}.py`;
    if (this.isFile(`${base}/__init__.py`)) return `${base}/__init__.py`;
    return undefined;
  }

  resolve(fromFile: string, specifier: string): ResolveResult {
    const fromDir = fromFile.includes("/") ? fromFile.slice(0, fromFile.lastIndexOf("/")) : "";
    // Every rule depends on where the importing file is (relative imports, its top package, its
    // Python project), so the cache is per directory.
    const cacheKey = `${fromDir}\u0000${specifier}`;
    const hit = this.cache.get(cacheKey);
    if (hit) return hit;
    const r = this.resolveUncached(fromFile, fromDir, specifier);
    this.cache.set(cacheKey, r);
    return r;
  }

  private resolveUncached(fromFile: string, fromDir: string, specifier: string): ResolveResult {
    if (specifier.startsWith("@fixture:")) {
      // `@fixture:<dir>:<name>`: the nearest conftest.py from <dir> up that names it (a trailing
      // `^` starts one directory up: a conftest's own fixtures are its own symbols).
      const rest = specifier.slice("@fixture:".length);
      const sep = rest.lastIndexOf(":");
      let dir = rest.slice(0, sep);
      const name = rest.slice(sep + 1);
      const up = (d: string) => (d.includes("/") ? d.slice(0, d.lastIndexOf("/")) : "");
      let skip = false;
      if (dir.endsWith("^")) {
        dir = dir.slice(0, -1);
        skip = true;
      }
      const word = new RegExp(`\\b${name.replace(/[^\w]/g, "")}\\b`);
      for (let d = dir, first = true; ; first = false) {
        if (!(skip && first)) {
          const file = d ? `${d}/conftest.py` : "conftest.py";
          if (this.isFile(file) && word.test(this.read(file))) return { resolved: file };
        }
        if (!d) break;
        d = up(d);
      }
      // A fixture of pytest itself or of a plugin (tmp_path, monkeypatch, client…).
      return { external: true };
    }
    if (specifier.startsWith("@package:")) {
      const file = `${specifier.slice("@package:".length)}/__init__.py`;
      // A folder without __init__.py is a namespace package: nothing runs.
      return this.isFile(file) ? { resolved: file } : { external: true };
    }
    if (specifier.startsWith("@conftest:")) {
      const dir = specifier.slice("@conftest:".length);
      const file = dir ? `${dir}/conftest.py` : "conftest.py";
      // No conftest.py there: nothing is loaded.
      return this.isFile(file) ? { resolved: file } : { external: true };
    }
    const colon = specifier.indexOf(":");
    const mod = colon === -1 ? specifier : specifier.slice(0, colon);
    const name = colon === -1 ? undefined : specifier.slice(colon + 1);
    const join2 = (a: string, b: string) => (a && b ? `${a}/${b}` : a || b);
    const asPath = (dotted: string) => dotted.split(".").filter(Boolean).join("/");
    let bases: string[];
    if (mod.startsWith(".")) {
      const dots = /^\.+/.exec(mod)?.[0].length ?? 1;
      const parts = fromDir ? fromDir.split("/") : [];
      if (dots - 1 > parts.length)
        return {
          reason: `relative import ${specifier.replace(":", " import ")} goes above the project`,
        };
      bases = [join2(parts.slice(0, parts.length - (dots - 1)).join("/"), asPath(mod.slice(dots)))];
    } else {
      // pytest's rootdir insertion: the directory above a file's top package is on sys.path.
      const above: string[] = [];
      let dir = fromDir;
      while (dir && this.isFile(`${dir}/__init__.py`))
        dir = dir.includes("/") ? dir.slice(0, dir.lastIndexOf("/")) : "";
      above.push(dir);
      above.push(fromDir); // the script's own directory (python file.py, pytest without packages)
      // The Python project the file belongs to (`python -m pytest` starts there, so its folder,
      // its `src/` and its `pythonpath` are on sys.path): a service beside a JavaScript app.
      // The Python project the file belongs to comes first: `python -m pytest` starts there, so
      // its folder, its `src/` and its `pythonpath` lead sys.path (a service beside a JS app).
      const project = this.pythonProjectOf(fromDir);
      bases = [
        ...new Set([
          ...(project ? this.sourceRoots(project) : []),
          ...this.sourceRoots(),
          ...above,
        ]),
      ].map((r) => join2(r, asPath(mod)));
    }
    for (const base of bases) {
      if (name) {
        const sub = this.moduleFile(join2(base, name));
        if (sub) return { resolved: sub };
      }
      const file = this.moduleFile(base);
      if (file) return { resolved: file };
      // A namespace package (a folder without __init__.py) runs no code of its own.
      if (base && this.isDir(base) && !name) return { external: true };
    }
    if (mod.startsWith("."))
      return { reason: `no module ${specifier.replace(":", ".")} relative to ${fromFile}` };
    const top = mod.split(".")[0] as string;
    // The test runner is installed wherever its tests run.
    const project = this.pythonProjectOf(fromDir) ?? "";
    if (
      PYTHON_STDLIB.has(top) ||
      RUNNER_MODULES.has(top) ||
      this.knownPackages("").has(top) ||
      (project && this.knownPackages(project).has(top))
    )
      return { external: true };
    return {
      reason: `no module "${mod}" in the project, the standard library or the declared and installed packages`,
    };
  }

  /** Files that change how modules resolve (they key the stored resolutions). */
  inputs(): string[] {
    return ["pyproject.toml", "pytest.ini", "setup.cfg", "tox.ini", "Pipfile", "requirements.txt"];
  }
}
