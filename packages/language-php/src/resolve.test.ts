import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { PhpResolver } from "./resolve.js";

function project(files: Record<string, string>): { root: string; list: string[] } {
  const root = mkdtempSync(join(tmpdir(), "st-php-resolve-"));
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), text);
  }
  return { root, list: Object.keys(files) };
}

const composer = JSON.stringify({
  autoload: {
    "psr-4": { "App\\": "app/", "Database\\Factories\\": "database/factories/" },
    "psr-0": { Legacy_: "lib/" },
    classmap: ["classes/"],
    files: ["app/helpers.php"],
  },
  "autoload-dev": { "psr-4": { "Tests\\": "tests/" } },
});

describe("PhpResolver", () => {
  const { root, list } = project({
    "composer.json": composer,
    "app/Models/User.php": "<?php namespace App\\Models; class User {}",
    "app/Misplaced.php": "<?php namespace App\\Support; final class Oddly {}",
    "app/helpers.php":
      "<?php if (!function_exists('money')) { function money() {} }\nconst VERSION = 1;",
    "app/Support/functions.php": "<?php namespace App\\Support; function slug() {}",
    "lib/Legacy/Formatter.php": "<?php class Legacy_Formatter {}",
    "classes/Coupon.php": "<?php final class Coupon {}",
    "app/Facades/Pay.php": "<?php namespace App\\Facades; class Pay {}",
    "config/app.php": "<?php return ['aliases' => ['Pay' => App\\Facades\\Pay::class]];",
    "app/Providers/AppServiceProvider.php": `<?php
namespace App\\Providers;
use App\\Contracts\\Gateway;
use App\\Services\\StripeGateway;
class AppServiceProvider { public function register(): void {
  $this->app->bind(Gateway::class, StripeGateway::class);
  $this->app->singleton('payments', fn () => new \\App\\Services\\Payments());
  $this->app->singleton('clock', fn () => now());
} }`,
    "app/Contracts/Gateway.php": "<?php namespace App\\Contracts; interface Gateway {}",
    "app/Services/StripeGateway.php": "<?php namespace App\\Services; class StripeGateway {}",
    "app/Services/Payments.php": "<?php namespace App\\Services; class Payments {}",
    "bootstrap/app.php": "<?php return 1;",
    "tests/Pest.php": "<?php uses(Tests\\TestCase::class);",
    "tests/Feature/HomeTest.php": "<?php it('x', fn () => 1);",
    "routes/api.php": "<?php",
  });
  const r = new PhpResolver(root, () => list);
  const from = "app/Http/Controllers/HomeController.php";

  it("finds classes by PSR-4, PSR-0, classmap and wherever the project declares them", () => {
    expect(r.resolve(from, "@class/App/Models/User")).toEqual({ resolved: "app/Models/User.php" });
    expect(r.resolve(from, "@class/Legacy_Formatter")).toEqual({
      resolved: "lib/Legacy/Formatter.php",
    });
    expect(r.resolve(from, "@class/Coupon")).toEqual({ resolved: "classes/Coupon.php" });
    expect(r.resolve(from, "@class/App/Support/Oddly")).toEqual({ resolved: "app/Misplaced.php" });
    expect(r.resolve(from, "@class/Pay")).toEqual({ resolved: "app/Facades/Pay.php" });
  });

  it("a class outside the project's namespaces is external; one inside them that no file declares is uncertain", () => {
    expect(r.resolve(from, "@class/Illuminate/Support/Str")).toEqual({ external: true });
    expect(r.resolve(from, "@class/Exception")).toEqual({ external: true });
    expect(r.resolve(from, "@class/App/Models/Ghost").reason).toContain(
      "no class App\\Models\\Ghost",
    );
    // A string that only looks like a class is no reference.
    expect(r.resolve(from, "@class-string/App/Http")).toEqual({ external: true });
  });

  it("finds functions and constants, namespaced first, then global", () => {
    expect(r.resolve(from, "@fn?/App/Http/Controllers/money")).toEqual({
      resolved: "app/helpers.php",
    });
    expect(r.resolve(from, "@fn/App/Support/slug")).toEqual({
      resolved: "app/Support/functions.php",
    });
    expect(r.resolve(from, "@fn?/App/Http/Controllers/collect")).toEqual({ external: true });
    expect(r.resolve(from, "@const/VERSION")).toEqual({ resolved: "app/helpers.php" });
  });

  it("follows container bindings, the application boot, Pest and literal paths", () => {
    expect(r.resolve("app/Contracts/Gateway.php", "@bound/App/Contracts/Gateway")).toEqual({
      resolved: "app/Services/StripeGateway.php",
    });
    expect(r.resolve(from, "@bind-key/payments")).toEqual({
      resolved: "app/Services/Payments.php",
    });
    // A binding whose class cannot be read adds nothing (booting tests load every provider).
    expect(r.resolve(from, "@bind-key/clock")).toEqual({ external: true });
    expect(r.resolve(from, "@bind-key/cache")).toEqual({ external: true });
    expect(r.resolve("tests/TestCase.php", "@app-boot")).toEqual({ resolved: "bootstrap/app.php" });
    expect(r.resolve("tests/Feature/HomeTest.php", "@pest/tests/Feature")).toEqual({
      resolved: "tests/Pest.php",
    });
    expect(r.resolve("bootstrap/app.php", "../routes/api.php")).toEqual({
      resolved: "routes/api.php",
    });
    expect(r.resolve("tests/TestCase.php", "../vendor/autoload.php")).toEqual({ external: true });
    expect(r.resolve(from, "@composer/routes/api.php")).toEqual({ resolved: "routes/api.php" });
  });

  it("keys the stored resolutions on Composer's manifest, the aliases and the providers", () => {
    expect(r.inputs(list)).toEqual([
      "app/Providers/AppServiceProvider.php",
      "composer.json",
      "config/app.php",
      "vendor/composer/autoload_psr4.php",
    ]);
  });
});
