import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { PythonResolver } from "./resolve.js";

async function project(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "st-py-"));
  for (const [f, t] of Object.entries(files)) {
    await mkdir(dirname(join(root, f)), { recursive: true });
    await writeFile(join(root, f), t);
  }
  return root;
}

describe("PythonResolver", () => {
  it("resolves absolute, relative, submodule and src-layout imports", async () => {
    const root = await project({
      "pyproject.toml": '[project]\ndependencies = ["requests>=2", "PyYAML"]\n',
      "src/shop/__init__.py": "",
      "src/shop/cart.py": "",
      "src/shop/sub/__init__.py": "",
      "src/shop/sub/deep.py": "",
      "tests/__init__.py": "",
      "tests/test_a.py": "",
      "ns/mod.py": "",
    });
    const r = new PythonResolver(root);
    expect(r.resolve("tests/test_a.py", "shop.cart:Cart")).toEqual({
      resolved: "src/shop/cart.py",
    });
    expect(r.resolve("tests/test_a.py", "shop:cart")).toEqual({ resolved: "src/shop/cart.py" }); // a submodule
    expect(r.resolve("tests/test_a.py", "shop:VERSION")).toEqual({
      resolved: "src/shop/__init__.py",
    });
    expect(r.resolve("src/shop/sub/deep.py", "..cart:Cart")).toEqual({
      resolved: "src/shop/cart.py",
    });
    expect(r.resolve("src/shop/sub/deep.py", ".:x")).toEqual({
      resolved: "src/shop/sub/__init__.py",
    });
    expect(r.resolve("tests/test_a.py", "ns.mod")).toEqual({ resolved: "ns/mod.py" }); // namespace package
    expect(r.resolve("tests/test_a.py", "ns")).toEqual({ external: true });
  });
  it("the standard library, declared and runner packages are external; anything else is unresolved", async () => {
    const root = await project({
      "requirements.txt": "beautifulsoup4==4\n# comment\n-r other.txt\n",
      "a.py": "",
    });
    const r = new PythonResolver(root);
    expect(r.resolve("a.py", "json:loads")).toEqual({ external: true });
    expect(r.resolve("a.py", "bs4:BeautifulSoup")).toEqual({ external: true });
    expect(r.resolve("a.py", "pytest")).toEqual({ external: true });
    expect(r.resolve("a.py", "nowhere.mod").reason).toContain('no module "nowhere.mod"');
    expect(r.resolve("a.py", "..up:x").reason).toContain("goes above the project");
  });
  it("conftest.py files and fixtures resolve to the nearest conftest.py naming them", async () => {
    const root = await project({
      "tests/conftest.py": "import pytest\n@pytest.fixture\ndef db(): ...\n",
      "tests/unit/conftest.py": "import pytest\n@pytest.fixture\ndef cart(db): ...\n",
      "tests/unit/test_x.py": "",
    });
    const r = new PythonResolver(root);
    expect(r.resolve("tests/unit/test_x.py", "@conftest:tests")).toEqual({
      resolved: "tests/conftest.py",
    });
    expect(r.resolve("tests/unit/test_x.py", "@conftest:")).toEqual({ external: true });
    expect(r.resolve("tests/unit/test_x.py", "@fixture:tests/unit:cart")).toEqual({
      resolved: "tests/unit/conftest.py",
    });
    expect(r.resolve("tests/unit/test_x.py", "@fixture:tests/unit:db")).toEqual({
      resolved: "tests/unit/conftest.py",
    }); // named there (a parameter)
    expect(r.resolve("tests/unit/conftest.py", "@fixture:tests/unit^:db")).toEqual({
      resolved: "tests/conftest.py",
    });
    expect(r.resolve("tests/unit/test_x.py", "@fixture:tests/unit:tmp_path")).toEqual({
      external: true,
    });
  });
  it("a Python project in a subfolder resolves from its own folder, with its own dependencies", async () => {
    const root = await project({
      "package.json": "{}",
      "service/pyproject.toml": '[project]\ndependencies = ["fastapi"]\n',
      "service/api/__init__.py": "",
      "service/api/hello.py": "",
      "service/tests/test_hello.py": "",
      "api/hello.py": "", // a same-named module at the root must not win
    });
    const r = new PythonResolver(root);
    expect(r.resolve("service/tests/test_hello.py", "api.hello:greet")).toEqual({
      resolved: "service/api/hello.py",
    });
    expect(r.resolve("service/tests/test_hello.py", "fastapi")).toEqual({ external: true });
    expect(r.resolve("api/hello.py", "fastapi").reason).toContain("no module");
  });
});
