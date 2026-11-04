# Python (preview)

SmartTest selects and runs the tests of Python projects that use pytest or unittest. Python is a **preview**: it never hides a failure, but its precision is coarser than for TypeScript, since the analysis has no types. It reads the sources without running Python.

## Supported setups

| Setup                                                                                                                    | How SmartTest finds and runs the tests                                                                                                       |
| ------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------- |
| pytest (`pytest.ini`, `[tool.pytest.ini_options]`, `[tool:pytest]`, a `conftest.py`, or pytest declared as a dependency) | `python -m pytest --collect-only -q` lists the files; a selection runs with `python -m pytest <files>`, results read from its JUnit XML      |
| unittest (test modules and no pytest setup)                                                                              | Files named `test*.py` inside packages, as `unittest discover` finds them; a selection runs module by module through `unittest`'s own loader |

A Python project is the project root, or any folder with a `pyproject.toml`, `setup.py`, `setup.cfg`, `pytest.ini`, `tox.ini`, `requirements.txt` or `conftest.py`; `smarttest doctor` shows `pytest (.) collects 12 test file(s)`.

The interpreter is, in this order: `SMARTTEST_PYTHON`, `python.interpreter` in the config, the project's `.venv` or `venv`, the active `VIRTUAL_ENV`, then `python3` (`python` on Windows). A bare command (`python3.13`) is looked up on `PATH`; a relative path (`.venv/bin/python`) is relative to the project.

```ts
export default defineConfig({
  python: { interpreter: ".venv/bin/python" }, // or { enabled: false } to turn the preview off
});
```

## What selects a test

| You change                                                                                                                                               | Selected                                                                                                                        |
| -------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| A function or a method                                                                                                                                   | The tests that reach it: through `from x import f`, `x.f` on an imported module, `self.f` inside the class                      |
| `__init__` (or `__new__`, `__post_init__`)                                                                                                               | Every test that reaches the class                                                                                               |
| Code that runs when the module loads: a statement at module level, a decorator, a class body, a module value built by a call (`PATTERN = re.compile(…)`) | Every test that imports the module                                                                                              |
| A fixture in `conftest.py`                                                                                                                               | The tests that ask for it by name (a parameter, `@pytest.mark.usefixtures("db")`), from the nearest `conftest.py` that names it |
| Code `conftest.py` runs at load, an autouse fixture, a `pytest_*` hook                                                                                   | Every test in that folder and below                                                                                             |
| A test module                                                                                                                                            | That test                                                                                                                       |
| `pyproject.toml`, `setup.py`, `setup.cfg`, `pytest.ini`, `tox.ini`, `requirements*.txt`, `Pipfile*`, `poetry.lock`, `uv.lock`, `.python-version`         | Every test in that folder and below                                                                                             |

Imports are resolved from the project root, `src/`, the `pythonpath` of the pytest configuration and the folder above a file's top package, as pytest finds them. Relative imports (`from ..offer import build`), packages (`__init__.py`) and namespace packages are followed, and so is `from package import submodule`.

## What is uncertainty

An import SmartTest cannot place is uncertainty: the tests that reach it are selected in BALANCED and SAFE. That covers:

- `importlib.import_module(name)` and `__import__(name)` with a name built at run time (a literal name is an import);
- a module found neither in the project, nor in the standard library, nor among the packages the project declares (`requirements*.txt`, `pyproject.toml`, `Pipfile`, `setup.cfg`) or installs in its virtual environment.

Declare the dependencies your code imports, or keep a `.venv` in the project, and these become ordinary external packages.

## Known limits

- Names reached through dynamic attribute access (`getattr(module, name)`) are not seen; neither are monkeypatched functions.
- `smarttest trace` (observed execution, which can narrow a selection) records JavaScript only; Python selection is always static. `audit --traces` and `audit --mutate` cover Python.
- A Python project beside a JavaScript one (`service/pyproject.toml` next to a Vitest app) is analysed by the same run: each side's changes select only its own tests. Its imports resolve from its own folder, as `python -m pytest` run there would.
