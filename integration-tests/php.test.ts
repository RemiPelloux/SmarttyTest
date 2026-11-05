/**
 * PHP preview (S32): PHPUnit and Laravel projects are detected, analysed without running PHP, and
 * run through PHPUnit (or `php artisan test`). A targeted change selects only the tests that reach
 * it; what cannot be read statically is uncertainty; a broken file is a failure, never a pass.
 * Skipped when PHP or the fixtures' Composer dependencies are not installed (CI installs them:
 * `composer install` in fixtures/projects/php-*).
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { cp, mkdir, mkdtemp, readdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SmartTest } from "@smarttest/core";
import { describe, expect, it } from "vitest";
import { edit, FIXTURES, git } from "./helpers.js";

/** A PHP that runs: SMARTTEST_PHP, then `php` on PATH. */
const php = [process.env.SMARTTEST_PHP, "php"].find(
  (p) => !!p && spawnSync(p, ["-v"], { stdio: "ignore" }).status === 0,
);
if (php) process.env.SMARTTEST_PHP = php;
const installed = (fixture: string) =>
  existsSync(join(FIXTURES, fixture, "vendor", "autoload.php"));
const ready = (fixture: string) => !!php && installed(fixture);

/**
 * Copies a PHP fixture into a temp dir. Composer's autoloader (`vendor/autoload.php`,
 * `vendor/composer`, `vendor/bin`) and PHPUnit (which finds the autoloader from its own folder)
 * are copied, so they load the copy's classes; the other packages are linked. Laravel's generated
 * caches are left out.
 */
async function materializePhp(name: string): Promise<string> {
  const src = join(FIXTURES, name);
  const dir = await mkdtemp(join(tmpdir(), `st-${name}-`));
  await cp(src, dir, {
    recursive: true,
    filter: (p) => {
      const rel = p.slice(src.length).replace(/\\/g, "/");
      return (
        !rel.startsWith("/vendor") &&
        !/^\/bootstrap\/cache\/[^/]+\.php$/.test(rel) &&
        !rel.includes(".phpunit") &&
        !rel.includes(".smarttest")
      );
    },
  });
  const vendor = join(src, "vendor");
  await mkdir(join(dir, "vendor"));
  for (const e of await readdir(vendor, { withFileTypes: true })) {
    const from = join(vendor, e.name);
    const to = join(dir, "vendor", e.name);
    if (!e.isDirectory() || e.name === "composer" || e.name === "bin" || e.name === "phpunit")
      await cp(from, to, { recursive: true, dereference: false });
    else await symlink(from, to, process.platform === "win32" ? "junction" : "dir");
  }
  await writeFile(join(dir, ".gitignore"), "/vendor/\n.smarttest/\n/bootstrap/cache/*.php\n");
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "core.autocrlf", "false");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "initial");
  return dir;
}

const selected = (a: { decision: { selectedTests: { filePath: string }[] } }) =>
  a.decision.selectedTests.map((t) => t.filePath).sort();

async function after(fixture: string, changes: [string, string, string][]) {
  const dir = await materializePhp(fixture);
  for (const [file, find, replace] of changes) await edit(dir, file, find, replace);
  const st = await SmartTest.open({ root: dir });
  return { dir, st, analysis: await st.analyze({ mode: "balanced" }) };
}

// PluginLoader builds a class named at run time: its test is never ruled out.
const PLUGIN = "tests/PluginTest.php";

describe.skipIf(!ready("php-phpunit"))("php-phpunit", () => {
  it("is detected as PHPUnit; the full suite gives PHPUnit's results", async () => {
    const dir = await materializePhp("php-phpunit");
    const st = await SmartTest.open({ root: dir });
    expect((await st.runnerRoots()).map((r) => `${r.adapter}:${r.configFile}`)).toEqual([
      "phpunit:phpunit.xml",
    ]);
    const run = await st.run({ all: true, formats: [] });
    expect(run.exitCode).toBe(0);
    expect(run.report.summary.passed).toBe(12);
    // tests/SlowTest.php is in an excluded group, tests/Fixtures is excluded: PHPUnit runs neither.
    expect(run.report.executions.map((e) => e.file).sort()).toEqual([
      "tests/CartTest.php",
      "tests/DiscountTest.php",
      "tests/HelpersTest.php",
      "tests/InvoiceTest.php",
      "tests/LegacyTest.php",
      "tests/MoneyTest.php",
      "tests/PluginTest.php",
      "tests/RoundingTest.php",
    ]);
    // SmartTest writes nothing in the project (no result cache, no configured logging).
    expect(existsSync(join(dir, ".phpunit.result.cache"))).toBe(false);
  }, 180_000);

  it("a static method change selects the tests calling it, not the class's other users", async () => {
    const { analysis } = await after("php-phpunit", [
      ["src/Pricing/Rounding.php", "return 'half up';", "return 'half-up';"],
    ]);
    // Discount::apply calls Rounding::cents only.
    expect(selected(analysis)).toEqual([PLUGIN, "tests/RoundingTest.php"]);
  }, 120_000);

  it("a class built by a test or by a factory of its own is used whole", async () => {
    // Money::fromCents() returns `new self`: its callers can call any member of the result.
    const format = await after("php-phpunit", [["src/Money.php", "' EUR'", "' €'"]]);
    expect(selected(format.analysis)).toEqual([
      "tests/CartTest.php",
      "tests/DiscountTest.php",
      "tests/MoneyTest.php",
      PLUGIN,
    ]);
    // CartTest builds a Discount (`new Discount(10)`): any change to Discount reaches it.
    const percent = await after("php-phpunit", [
      ["src/Pricing/Discount.php", "return $this->percent . '%';", "return $this->percent . ' %';"],
    ]);
    expect(selected(percent.analysis)).toEqual([
      "tests/CartTest.php",
      "tests/DiscountTest.php",
      PLUGIN,
    ]);
  }, 120_000);

  it("a trait method reaches the classes using the trait", async () => {
    const { analysis } = await after("php-phpunit", [
      ["src/Concerns/HasLabel.php", "'cart of '", "'Cart of '"],
    ]);
    expect(selected(analysis)).toEqual(["tests/CartTest.php", PLUGIN]);
  }, 120_000);

  it("an implementation reaches the code typed by its interface", async () => {
    const { analysis } = await after("php-phpunit", [
      ["src/Pricing/FrenchVat.php", "return 0.2;", "return 0.20;"],
    ]);
    expect(selected(analysis)).toEqual(["tests/InvoiceTest.php", PLUGIN]);
  }, 120_000);

  it("functions from autoload files, literal includes, PSR-0 and classmap classes", async () => {
    const fn = await after("php-phpunit", [["src/helpers.php", "'%d.%02d'", "'%d.%02d' . ''"]]);
    expect(selected(fn.analysis)).toEqual(["tests/HelpersTest.php", PLUGIN]);
    const constant = await after("php-phpunit", [["src/constants.php", "'EUR'", "'EUR' . ''"]]);
    expect(selected(constant.analysis)).toEqual(["tests/HelpersTest.php", PLUGIN]);
    const psr0 = await after("php-phpunit", [
      ["lib/Legacy/Formatter.php", "strtoupper($s)", "mb_strtoupper($s)"],
    ]);
    expect(selected(psr0.analysis)).toEqual(["tests/LegacyTest.php", PLUGIN]);
    const classmap = await after("php-phpunit", [
      ["classes/Coupon.php", "'WELCOME'", "'WELCOME' . ''"],
    ]);
    expect(selected(classmap.analysis)).toEqual(["tests/LegacyTest.php", PLUGIN]);
  }, 240_000);

  it("a dynamic class name is uncertainty: the tests reaching it are selected, with the reason", async () => {
    const { analysis } = await after("php-phpunit", [
      ["src/Pricing/Rounding.php", "return 'half up';", "return 'half-up';"],
    ]);
    const reason = analysis.decision.selectedTests.find((t) => t.filePath === PLUGIN);
    expect(JSON.stringify(reason)).toContain("new $class");
  }, 120_000);

  it("a failing change fails the right tests; a fatal error is a failure, never a pass", async () => {
    const broken = await after("php-phpunit", [
      ["src/Pricing/Discount.php", "(100 - $this->percent)", "(100 + $this->percent)"],
    ]);
    const run = await broken.st.run({ formats: [] });
    expect(run.exitCode).not.toBe(0);
    expect(run.report.executions.filter((e) => e.status === "failed").map((e) => e.file)).toEqual([
      "tests/CartTest.php",
    ]);
    const fatal = await after("php-phpunit", [
      [
        "tests/DiscountTest.php",
        "public function testShowsThePercentage(): void",
        "public function testShowsThePercentage(: void",
      ],
    ]);
    const run2 = await fatal.st.run({ formats: [] });
    expect(run2.exitCode).not.toBe(0);
    expect(run2.report.executions.find((e) => e.file === "tests/DiscountTest.php")?.status).toBe(
      "failed",
    );
  }, 180_000);

  it("a selected file PHPUnit runs no test from is a failure", async () => {
    const empty = await after("php-phpunit", [
      [
        "tests/DiscountTest.php",
        "    public function testShowsThePercentage(): void",
        "    public function showsThePercentage(): void",
      ],
    ]);
    const run = await empty.st.run({ formats: [] });
    expect(run.exitCode).not.toBe(0);
    expect(["failed", "infrastructure-error"]).toContain(
      run.report.executions.find((e) => e.file === "tests/DiscountTest.php")?.status,
    );
  }, 180_000);

  it("benchmark replays a commit in a temporary checkout with Composer's packages", async () => {
    const dir = await materializePhp("php-phpunit");
    await edit(dir, "src/Pricing/Rounding.php", "(int) round($amount)", "(int) floor($amount)");
    git(dir, "commit", "-qam", "round down");
    const st = await SmartTest.open({ root: dir });
    const { benchmarkHistory } = await import("@smarttest/core");
    const b = await benchmarkHistory(st, { commits: 1 });
    const c = b.commits[0];
    // The full run in the checkout passes (its autoloader loads the checkout's classes, so the
    // change is tested): no infrastructure error, nothing missed.
    expect(c?.failingInFull).toEqual([]);
    expect(c?.missed).toEqual([]);
    // Discount::apply calls Rounding::cents: Discount's users and the uncertain plugin test.
    expect(c?.selectedTests).toBe(3);
  }, 240_000);

  it("can be turned off per project", async () => {
    const dir = await materializePhp("php-phpunit");
    await writeFile(join(dir, "smarttest.config.json"), '{ "php": { "enabled": false } }\n');
    const st = await SmartTest.open({ root: dir });
    expect(await st.runnerRoots()).toEqual([]);
    const { index } = await st.loadIndex();
    expect([...index.entries().keys()].filter((f) => f.endsWith(".php"))).toEqual([]);
  }, 120_000);
});

const FEATURE = ["tests/Feature/GreetingTest.php", "tests/Feature/NoteTest.php"];

describe.skipIf(!ready("php-laravel"))("php-laravel", () => {
  it("runs through php artisan test; the full suite gives its results, RefreshDatabase included", async () => {
    const dir = await materializePhp("php-laravel");
    const st = await SmartTest.open({ root: dir });
    expect((await st.runnerRoots()).map((r) => r.adapter)).toEqual(["phpunit"]);
    const run = await st.run({ all: true, formats: [] });
    expect(run.exitCode).toBe(0);
    expect(run.report.summary.passed).toBe(4);
  }, 180_000);

  it("links facades, container bindings and the application boot", async () => {
    const dir = await materializePhp("php-laravel");
    const st = await SmartTest.open({ root: dir });
    const { index } = await st.loadIndex();
    const graph = st.buildGraph(index);
    // Greeter::greet() → the 'greeter' binding → App\Services\Greeter.
    expect([...graph.dependenciesOf("app/Facades/Greeter.php")]).toContain(
      "app/Services/Greeter.php",
    );
    // NoteRepository is bound to EloquentNoteRepository.
    expect([...graph.dependenciesOf("app/Contracts/NoteRepository.php")]).toContain(
      "app/Repositories/EloquentNoteRepository.php",
    );
    // A test extending Laravel's test case boots the application: providers, config, routes,
    // migrations.
    const booted = [...graph.dependenciesOf("tests/Feature/NoteTest.php")];
    for (const f of [
      "bootstrap/app.php",
      "bootstrap/providers.php",
      "app/Providers/AppServiceProvider.php",
      "config/app.php",
      "routes/api.php",
      "app/Http/Controllers/NoteController.php",
      "database/migrations/2024_01_01_000000_create_notes_table.php",
    ])
      expect(booted).toContain(f);
    // A plain PHPUnit test does not.
    expect([...graph.dependenciesOf("tests/Unit/SlugTest.php")]).not.toContain("bootstrap/app.php");
  }, 120_000);

  it("a class only a unit test uses selects that test only", async () => {
    const { analysis } = await after("php-laravel", [
      ["app/Support/Slug.php", "strtolower(", "mb_strtolower("],
    ]);
    expect(selected(analysis)).toEqual(["tests/Unit/SlugTest.php"]);
  }, 120_000);

  it("a service behind a facade selects its unit test and the tests booting the application", async () => {
    const { analysis } = await after("php-laravel", [
      ["app/Services/Greeter.php", "', '.$name.'!'", "', '.$name.'!'.''"],
    ]);
    expect(selected(analysis)).toEqual([...FEATURE, "tests/Unit/GreeterTest.php"].sort());
  }, 120_000);

  it("a migration, the test case or the bound implementation selects the booting tests only", async () => {
    for (const change of [
      [
        "database/migrations/2024_01_01_000000_create_notes_table.php",
        "$table->string('body');",
        "$table->text('body');",
      ],
      ["tests/TestCase.php", "    //\n", "    protected bool $seed = false;\n"],
      ["app/Repositories/EloquentNoteRepository.php", "trim($body)", "trim($body, ' ')"],
    ] as [string, string, string][]) {
      const { analysis } = await after("php-laravel", [change]);
      expect(selected(analysis), change[0]).toEqual(FEATURE);
    }
  }, 240_000);

  it("phpunit.xml and .env.testing are runner inputs: every test", async () => {
    const all = [...FEATURE, "tests/Unit/GreeterTest.php", "tests/Unit/SlugTest.php"].sort();
    const env = await after("php-laravel", [[".env.testing", "Hello", "Hello"]]);
    void env;
    const cfg = await after("php-laravel", [["phpunit.xml", 'value="4"', 'value="5"']]);
    expect(selected(cfg.analysis)).toEqual(all);
    const dotenv = await after("php-laravel", [
      [".env.testing", "APP_GREETING=Hello", "APP_GREETING=Hello\nAPP_DEBUG=false"],
    ]);
    expect(selected(dotenv.analysis)).toEqual(all);
  }, 240_000);

  it("a broken service fails the feature and unit tests that use it", async () => {
    const { st } = await after("php-laravel", [
      ["app/Services/Greeter.php", "', '.$name.'!'", "' '.$name"],
    ]);
    const run = await st.run({ formats: [] });
    expect(run.exitCode).not.toBe(0);
    expect(
      run.report.executions
        .filter((e) => e.status === "failed")
        .map((e) => e.file)
        .sort(),
    ).toEqual(["tests/Feature/GreetingTest.php", "tests/Unit/GreeterTest.php"]);
  }, 180_000);
});

describe.skipIf(!php)("init in a PHP repository", () => {
  it("works without package.json and replaces a CaptainHook action that runs changed tests", async () => {
    const dir = await mkdtemp(join(tmpdir(), "st-php-init-"));
    await cp(join(FIXTURES, "php-phpunit"), dir, {
      recursive: true,
      filter: (p) => !p.includes("vendor") && !p.includes(".phpunit"),
    });
    await mkdir(join(dir, "scripts"));
    await writeFile(
      join(dir, "scripts", "test-changed.sh"),
      "#!/usr/bin/env bash\nvendor/bin/phpunit\n",
    );
    const hooks = {
      config: { "fail-on-first-error": false },
      "pre-commit": {
        enabled: true,
        actions: [
          { action: "bash scripts/check-quality.sh" },
          { action: "env TEST_STATS=1 bash scripts/test-changed.sh" },
        ],
      },
      "pre-push": {
        enabled: true,
        actions: [{ action: "composer analyse" }, { action: "bash scripts/test-changed.sh" }],
      },
    };
    await writeFile(join(dir, "captainhook.json"), `${JSON.stringify(hooks, null, 4)}\n`);
    await writeFile(join(dir, ".gitignore"), "/vendor/\n");
    git(dir, "init", "-q", "-b", "main");
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", "initial");
    const st = await SmartTest.open({ root: dir });
    const plan = await st.initPlan();
    expect(plan.warnings.join("\n")).not.toContain("No package.json");
    const config = plan.files.find((f) => f.path.startsWith("smarttest.config"));
    // No package.json: a JSON config, which loads without installing SmartTest's package.
    expect(config?.path).toBe("smarttest.config.json");
    expect(JSON.parse(config?.after ?? "{}")).toMatchObject({
      adapters: ["phpunit"],
      php: { enabled: true },
    });
    expect(plan.files.some((f) => f.path === "package.json")).toBe(false);
    const hook = plan.files.find((f) => f.path === "captainhook.json");
    const after = JSON.parse(hook?.after ?? "{}") as typeof hooks;
    expect(after["pre-commit"].actions.map((a) => a.action)).toEqual([
      "bash scripts/check-quality.sh",
      "npx --yes @tkmremi/smarttest run --staged --hook",
    ]);
    expect(after["pre-push"].actions.map((a) => a.action)).toEqual([
      "composer analyse",
      "npx --yes @tkmremi/smarttest run --push --hook",
    ]);
    // The replaced command is kept, so `smarttest hook uninstall` can restore it.
    expect(JSON.stringify(after)).toContain(
      "SmartTest: affected tests, in place of: bash scripts/test-changed.sh",
    );
    // `hook uninstall` gives the replaced actions back.
    await writeFile(join(dir, "captainhook.json"), hook?.after ?? "");
    const [restore] = await st.hookUninstallPlan();
    expect(JSON.parse(restore?.after ?? "{}")).toEqual(hooks);
  }, 120_000);
});
