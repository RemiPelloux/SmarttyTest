import { describe, expect, it } from "vitest";
import { analyzePython, CONFTEST_LOAD, tokenize } from "./analyze.js";
import { pythonMutationPoints } from "./mutate.js";

const src = `"""Module docs."""
from __future__ import annotations

import os.path as osp
import json, re
from .base import Source, build as make
from ..util import (
    first,
    second,  # trailing comment
)

LIMIT = 10
PATTERN = re.compile(r"\\d+")


@cache
def parse(text: str, *, strict: bool = False) -> dict:
    """Docs."""
    value = f"{first(text)!r} and {{literal}}"
    return json.loads(value) if strict else {"v": osp.join(text, LIMIT)}


class Feed(Source):
    name = "feed"

    def __init__(self, url):
        self.url = url

    def fetch(self):
        return self.parse_page(make(self.url))

    async def parse_page(self, page):
        return [second(x) for x in page]


if __name__ == "__main__":
    print(parse("{}"))
`;

describe("tokenize", () => {
  it("keeps strings, f-string expressions, continuations and comments apart", () => {
    const { lines, errors } = tokenize(
      'x = (1,\n  2)  # c\ny = """a\nb"""\nz = f"{w.v}"\\\n  + "q"\n',
    );
    expect(errors).toBe(0);
    expect(lines.map((l) => [l.start, l.end, l.indent])).toEqual([
      [1, 2, 0],
      [3, 4, 0],
      [5, 6, 0],
    ]);
    expect(lines[2]?.toks.map((t) => t.v)).toContain("w");
  });
});

describe("analyzePython", () => {
  const a = analyzePython("pkg/feeds/feed.py", src);
  it("reads every import form, with the resolver's encoding", () => {
    expect(a.parseErrors).toBe(0);
    expect(
      a.imports.map(
        (i) =>
          `${i.kind} ${i.specifier} ${i.bindings.map((b) => `${b.imported}>${b.local}`).join(",")}`,
      ),
    ).toEqual([
      "named __future__:annotations annotations>annotations",
      "namespace os.path *>osp",
      "side-effect os ",
      "namespace json *>json",
      "namespace re *>re",
      "named .base:Source Source>Source",
      "named .base:build build>make",
      "named ..util:first first>first",
      "named ..util:second second>second",
    ]);
  });
  it("finds functions, classes, methods and module values, with what runs at load", () => {
    const by = new Map(a.symbols.map((s) => [s.qualifiedName, s]));
    expect([...by.keys()]).toEqual([
      "LIMIT",
      "PATTERN",
      "parse",
      "Feed",
      "Feed.__init__",
      "Feed.fetch",
      "Feed.parse_page",
    ]);
    expect(by.get("LIMIT")?.evalHash).toBeUndefined();
    expect(by.get("PATTERN")?.evalHash).toBeDefined(); // a call at load
    expect(by.get("parse")?.evalHash).toBeDefined(); // a decorator
    expect(by.get("Feed")?.evalHash).toBeDefined(); // the class body runs
    expect(by.get("Feed.__init__")?.kind).toBe("property"); // the constructor: the whole class
    expect(by.get("parse")?.refs).toEqual(
      expect.arrayContaining(["first", "json", "osp", "LIMIT"]),
    );
    expect(by.get("parse")?.uses).toEqual(expect.arrayContaining(["json.loads", "osp.join"]));
    expect(by.get("Feed.fetch")?.thisUses).toEqual(["parse_page", "url"]);
    expect(by.get("Feed.fetch")?.refs).toContain("make");
    expect(a.topLevelRefs).toEqual(expect.arrayContaining(["print", "parse"]));
  });
  it("a comment or a blank line changes no token hash", () => {
    const b = analyzePython(
      "pkg/feeds/feed.py",
      src.replace("return json.loads", "# note\n    return json.loads"),
    );
    const tok = (x: typeof a, n: string) => x.symbols.find((s) => s.qualifiedName === n)?.tokenHash;
    expect(tok(b, "parse")).toBe(tok(a, "parse"));
    expect(b.topLevelHash).toBe(a.topLevelHash);
  });
  it("dynamic imports: a literal is an import, anything else is uncertainty", () => {
    const d = analyzePython(
      "m.py",
      'import importlib\nx = importlib.import_module("pkg.mod")\ny = importlib.import_module(name)\n',
    );
    expect(d.imports.some((i) => i.kind === "dynamic" && i.specifier === "pkg.mod")).toBe(true);
    expect(d.dynamicUnresolved).toEqual(["import_module(…) on line 3"]);
  });
  it("a test asks for its conftest.py files and the fixtures it names", () => {
    const t = analyzePython(
      "tests/unit/test_x.py",
      'import pytest\n\n@pytest.mark.usefixtures("db")\ndef test_a(cart, tmp_path, n=1):\n    pass\n\nclass TestB:\n    def test_b(self, client: "Client"):\n        pass\n',
    );
    const specs = t.imports.map((i) => i.specifier);
    expect(specs).toEqual(
      expect.arrayContaining(["@conftest:tests/unit", "@conftest:tests", "@conftest:"]),
    );
    expect(t.imports.find((i) => i.specifier === "@conftest:tests")?.bindings).toEqual([
      { imported: CONFTEST_LOAD, local: CONFTEST_LOAD },
    ]);
    expect(specs.filter((s) => s.startsWith("@fixture:")).sort()).toEqual([
      "@fixture:tests/unit:cart",
      "@fixture:tests/unit:client",
      "@fixture:tests/unit:db",
      "@fixture:tests/unit:tmp_path",
    ]);
    expect(t.localExports).toEqual([]); // a test module is not a re-exporter
  });
  it("an autouse fixture or a pytest hook in conftest.py runs for every test", () => {
    const c = analyzePython(
      "tests/conftest.py",
      "import pytest\n\n@pytest.fixture(autouse=True)\ndef env():\n    return 1\n\ndef pytest_configure(config):\n    pass\n\n@pytest.fixture\ndef cart():\n    return 2\n",
    );
    const by = new Map(c.symbols.map((s) => [s.name, s]));
    expect(by.get("env")?.evalHash).toBeDefined();
    expect(by.get("pytest_configure")?.evalHash).toBeDefined();
    const changed = analyzePython(
      "tests/conftest.py",
      "import pytest\n\n@pytest.fixture(autouse=True)\ndef env():\n    return 3\n",
    );
    expect(changed.symbols[0]?.evalHash).not.toBe(by.get("env")?.evalHash);
  });
});

describe("pythonMutationPoints", () => {
  it("puts a raise first in every function body, at its indentation", () => {
    const text =
      "def a(x):\n    return x\n\nclass B:\n    def m(self):  # c\n        return 1\n\ndef one(): return 1\n";
    const points = pythonMutationPoints("m.py", text);
    expect(points.map((p) => p.name)).toEqual(["a", "B.m"]);
    const [p] = points;
    if (!p) throw new Error("no point");
    expect(text.slice(0, p.start) + p.replacement + text.slice(p.end)).toBe(
      'def a(x):\n    raise RuntimeError("smarttest audit: injected fault")\n    return x\n\nclass B:\n    def m(self):  # c\n        return 1\n\ndef one(): return 1\n',
    );
  });
});

describe("self and cls used whole", () => {
  it("a classmethod building an instance with cls(...) reaches the whole class", () => {
    const a = analyzePython(
      "m.py",
      "class C:\n    def __init__(self, v):\n        self.v = self.check(v)\n\n    @classmethod\n    def parse(cls, raw):\n        return cls(raw)\n\n    def check(self, v):\n        return v\n\n    def size(self):\n        return self.v\n",
    );
    const by = new Map(a.symbols.map((s) => [s.qualifiedName, s]));
    expect(by.get("C.parse")?.thisEscapes).toBe(true);
    expect(by.get("C.size")?.thisEscapes).toBeUndefined(); // only self.v
    expect(by.get("C.check")?.thisEscapes).toBeUndefined(); // `self` in the parameter list
  });
});
