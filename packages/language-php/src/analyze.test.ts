import { describe, expect, it } from "vitest";
import { analyzePhp, phpBindings } from "./analyze.js";
import { phpMutationPoints } from "./mutate.js";
import { tokenize } from "./tokenize.js";

const sym = (a: ReturnType<typeof analyzePhp>, q: string) => {
  const s = a.symbols.find((x) => x.qualifiedName === q);
  if (!s) throw new Error(`no symbol ${q}: ${a.symbols.map((x) => x.qualifiedName).join(", ")}`);
  return s;
};
const specs = (a: ReturnType<typeof analyzePhp>) => a.imports.map((i) => i.specifier).sort();

describe("tokenize", () => {
  it("skips inline HTML and comments, keeps strings whole, reads interpolations as code", () => {
    const { toks, errors } = tokenize(
      `<html><?php // a comment ?>\n<?php /* block */ $a = "x {$b->c()} y"; echo 'it\\'s'; # done\n$h = <<<EOT\nHi $name\nEOT;\n`,
    );
    expect(errors).toBe(0);
    expect(toks.map((t) => t.v)).toEqual([
      ";",
      "$a",
      "=",
      '"x {$b->c()} y"',
      "$b",
      "->",
      "c",
      "(",
      ")",
      ";",
      "echo",
      "'it\\'s'",
      ";",
      "$h",
      "=",
      "<<<EOT\nHi $name\nEOT",
      "$name",
      ";",
    ]);
    expect(toks.find((t) => t.v === "'it\\'s'")?.value).toBe("it's");
  });

  it("keeps qualified names and attributes as tokens", () => {
    const { toks } = tokenize("<?php #[\\Attr] new \\App\\Models\\User(); namespace\\Foo::bar();");
    expect(toks.map((t) => t.v)).toEqual([
      "#[",
      "\\Attr",
      "]",
      "new",
      "\\App\\Models\\User",
      "(",
      ")",
      ";",
      "namespace\\Foo",
      "::",
      "bar",
      "(",
      ")",
      ";",
    ]);
  });
});

describe("analyzePhp", () => {
  it("resolves use statements (grouped, aliased, function, const) and same-namespace names", () => {
    const a = analyzePhp(
      "app/Services/Checkout.php",
      `<?php
namespace App\\Services;

use App\\Models\\{Order, Line as OrderLine};
use App\\Support\\Money;
use function App\\Support\\format_money;
use const App\\Support\\CURRENCY;

final class Checkout extends BaseService implements Contracts\\Pays
{
    public function total(Order $order): Money
    {
        $sum = Money::zero();
        foreach ($order->lines() as $line) {
            $sum = $sum->plus(OrderLine::price($line));
        }
        return format_money($sum, CURRENCY) ? $sum : Tax::apply($sum);
    }
}
`,
    );
    expect(specs(a)).toEqual([
      "@bound/App/Services/Checkout",
      "@class/App/Models/Line",
      "@class/App/Models/Order",
      "@class/App/Services/BaseService",
      "@class/App/Services/Contracts/Pays",
      "@class/App/Services/Tax",
      "@class/App/Support/Money",
      "@const/App/Support/CURRENCY",
      "@fn/App/Support/format_money",
    ]);
    const cls = sym(a, "Checkout");
    expect(cls.extends).toBe("$App$Services$BaseService");
    expect(cls.implements).toEqual(["$App$Services$Contracts$Pays"]);
    const total = sym(a, "Checkout.total");
    expect(total.kind).toBe("method");
    // Typed parameter used through its members: member-level uses, no escape.
    expect(total.uses).toEqual(
      expect.arrayContaining([
        "$App$Models$Order.lines",
        "$App$Support$Money.zero",
        "$App$Models$Line.price",
        "$App$Services$Tax.apply",
      ]),
    );
    expect(total.escapes).toEqual([]);
    expect(total.refs).toEqual(
      expect.arrayContaining([
        "fn$App$Support$format_money",
        "const$App$Support$CURRENCY",
        "$App$Support$Money",
      ]),
    );
  });

  it("links $this->, self::, static::, parent:: and typed properties to members", () => {
    const a = analyzePhp(
      "app/Http/Controllers/OrderController.php",
      `<?php
namespace App\\Http\\Controllers;

use App\\Repositories\\OrderRepository;

class OrderController extends Controller
{
    private const LIMIT = 10;

    public function __construct(private OrderRepository $orders) {}

    public function index()
    {
        return $this->orders->latest(self::LIMIT) + static::count() + $this->Helper();
    }

    public function show($id)
    {
        parent::show($id);
        return $this->orders;
    }

    protected function helper() { return 1; }
}
`,
    );
    const index = sym(a, "OrderController.index");
    expect(index.thisUses?.sort()).toEqual(["$orders", "LIMIT", "count", "helper"]);
    expect(index.uses).toEqual(["$App$Repositories$OrderRepository.latest"]);
    expect(index.escapes).toEqual([]);
    const show = sym(a, "OrderController.show");
    expect(show.superUses).toEqual(["show"]);
    // The property passed on whole: the class as a whole.
    expect(show.escapes).toEqual(["$App$Repositories$OrderRepository"]);
    expect(sym(a, "OrderController.__construct").kind).toBe("property");
    expect(sym(a, "OrderController.$orders").kind).toBe("property");
    expect(sym(a, "OrderController.LIMIT").kind).toBe("property");
  });

  it("reads interfaces, traits and enums with their members", () => {
    const a = analyzePhp(
      "src/Kinds.php",
      `<?php
namespace Shop;
interface Priced extends Named, Countable { public function price(): int; }
trait HasName { public function name(): string { return $this->name; } }
enum Size: string implements Priced {
    use HasName;
    case Small = 's';
    case Large = 'l';
    public function price(): int { return match($this) { self::Small => 1, self::Large => 2 }; }
}
`,
    );
    expect(sym(a, "Priced").extends).toBe("$Shop$Named");
    expect(sym(a, "Priced").implements).toEqual(["$Shop$Countable"]);
    expect(sym(a, "Priced.price").kind).toBe("method");
    expect(sym(a, "HasName.name").thisUses).toEqual(["$name"]);
    expect(sym(a, "Size").implements).toEqual(["Priced"]);
    expect(sym(a, "Size").escapes).toEqual(["HasName"]);
    expect(sym(a, "Size.Small").kind).toBe("property");
    expect(sym(a, "Size.price").thisUses?.sort()).toEqual(["Large", "Small"]);
  });

  it("reads each route as a symbol linked to its action, its middleware and its uri", () => {
    const a = analyzePhp(
      "routes/api.php",
      `<?php
use App\\Http\\Controllers\\PostController;
use App\\Http\\Middleware\\Audit;
use Illuminate\\Support\\Facades\\Route;

Route::get('/posts', [PostController::class, 'index'])->name('posts.index');
Route::middleware([Audit::class])->prefix('admin')->name('admin.')->group(function (): void {
    Route::apiResource('comments', App\\Http\\Controllers\\CommentController::class)->only(['index', 'show']);
    Route::controller(App\\Http\\Controllers\\TagController::class)->group(function () {
        Route::post('/tags/{tag}', 'store')->whereNumber('tag');
    });
    require __DIR__.'/api/extra.php';
});
Route::match(['get', 'post'], '/search', App\\Http\\Controllers\\SearchController::class);
`,
    );
    const routes = a.symbols.filter((s) => s.resources?.some((r) => r.startsWith("http-route:")));
    expect(routes.map((s) => s.resources?.join(" "))).toEqual([
      "http-route:GET|HEAD /api/posts http-route-name:posts.index",
      "http-route:GET|HEAD /api/admin/comments http-route-name:admin.comments.index",
      "http-route:GET|HEAD /api/admin/comments/{comment} http-route-name:admin.comments.show",
      "http-route:POST /api/admin/tags/{tag}",
      "http-route:GET|POST /api/search",
    ]);
    const index = routes[0];
    expect(index?.uses).toEqual(
      expect.arrayContaining([
        "$App$Http$Controllers$PostController.index",
        "$App$Http$Controllers$PostController.constructor",
      ]),
    );
    // A group's middleware belongs to each of its routes.
    expect(routes[3]?.uses).toContain("$App$Http$Controllers$TagController.store");
    expect(routes[3]?.escapes).toContain("$App$Http$Middleware$Audit");
    expect(routes[4]?.uses).toContain("$App$Http$Controllers$SearchController.__invoke");
    // Registering routes is load-time code: an edit to one reaches the file's loaders.
    expect(routes.every((s) => s.evalHash)).toBe(true);
    // The route file's own code names no controller; an included route file is loaded only.
    expect(a.topLevelEscapes).toEqual([]);
    expect(a.imports.find((i) => i.specifier === "./api/extra.php")?.load).toBe(true);
  });

  it("a route file another one includes has an unknown prefix", () => {
    const a = analyzePhp(
      "routes/api/extra.php",
      `<?php\nuse Illuminate\\Support\\Facades\\Route;\nRoute::delete('/notes/{note}', [App\\N::class, 'destroy']);\n`,
    );
    expect(a.symbols[0]?.resources).toEqual(["http-route~:DELETE /notes/{note}"]);
  });

  it("reads the requests a test makes; a computed url is uncertainty for that test", () => {
    const a = analyzePhp(
      "tests/Feature/PostTest.php",
      `<?php
namespace Tests\\Feature;
use Tests\\TestCase;
class PostTest extends TestCase {
    private const URL = '/api/posts';
    public function test_a(): void {
        $this->getJson('/api/posts?page=2');
        $this->actingAs($u)->postJson("/api/posts/{$post->id}/like", []);
        $this->json('DELETE', '/api/posts/'.$id);
        $this->get(route('posts.index'));
        $this->getJson(self::URL);
        $response->json('data');
        collect([])->get('key');
    }
    public function test_b(): void { $this->get($this->path()); }
    protected function send(string $method, string $uri) { return $this->json($method, $uri); }
    public function test_c(): void { $this->send('PUT', '/api/posts/3'); $this->assertTrue(true); }
}
`,
    );
    const t = a.symbols.find((s) => s.qualifiedName === "PostTest.test_a");
    expect(t?.resources?.sort()).toEqual(
      [
        "http-request:GET /api/posts?page=2",
        "http-request:POST /api/posts/*/like",
        "http-request:DELETE /api/posts/*",
        "http-request-name:posts.index",
        "http-request:GET /api/posts",
      ].sort(),
    );
    expect(a.dynamicUnresolved).toEqual(["a request to a url built at run time (get) on line 15"]);
    // A request helper: its callers' arguments are the requests.
    expect(a.symbols.find((s) => s.qualifiedName === "PostTest.send")?.resources).toEqual([
      "http-wrapper:send:1:@0",
    ]);
    expect(a.symbols.find((s) => s.qualifiedName === "PostTest.test_c")?.resources).toEqual([
      "http-call:send|PUT|/api/posts/3",
    ]);
  });

  it("reads classes from a config list and from a private method's literal callers", () => {
    const a = analyzePhp(
      "app/Harvester.php",
      `<?php
namespace App;
final class Harvester {
    public function all(): array {
        foreach (Coerce::list(config('prospection.connectors')) as $class) { $out[] = app($class); }
        return [self::flags('a', Size::class), self::flags('b', Color::class)];
    }
    private static function flags(string $s, string $enum): bool { return $enum::tryFrom($s) !== null; }
}
`,
    );
    expect(a.dynamicUnresolved).toEqual([]);
    expect(a.imports.map((i) => i.specifier)).toContain("@composer/config/prospection.php");
    expect(a.symbols.find((s) => s.qualifiedName === "Harvester.flags")?.uses).toEqual(
      expect.arrayContaining(["$App$Size.tryFrom", "$App$Color.tryFrom"]),
    );
  });

  it("finds functions declared inside if blocks (helpers) and literal includes", () => {
    const a = analyzePhp(
      "app/helpers.php",
      `<?php
if (! function_exists('money')) {
    function money(int $cents): string { return number_format($cents / 100, 2); }
}
const VERSION = '1';
define('BUILD', 7);
require __DIR__.'/../bootstrap/constants.php';
require_once dirname(__DIR__).'/vendor/autoload.php';
include 'legacy.php';
$file = __DIR__.'/routes.php';
require $file;
require $somewhere;
`,
    );
    expect(sym(a, "money").kind).toBe("function");
    expect(sym(a, "VERSION").exportNames).toEqual(["VERSION"]);
    expect(sym(a, "BUILD").exportNames).toEqual(["BUILD"]);
    // number_format is PHP's own: no import.
    expect(specs(a)).toEqual([
      "../bootstrap/constants.php",
      "../vendor/autoload.php",
      "./legacy.php",
      "./routes.php",
    ]);
    expect(a.dynamicUnresolved).toEqual(["require with a path built at run time on line 12"]);
  });

  it("reports dynamic names as uncertainty, and reads literal class lists", () => {
    const a = analyzePhp(
      "app/Dyn.php",
      `<?php
namespace App;
use App\\Models\\Post;
use App\\Models\\User;
class Dyn {
    public function a($class, $method, $name) {
        new $class;
        $class::$method();
        app($name);
        call_user_func($method);
        $c = "App\\\\Models\\\\{$name}";
        $d = 'App\\\\Jobs\\\\' . $name;
    }
    public function b() {
        foreach ([Post::class, User::class] as $model) {
            $model::observe(Observer::class);
        }
        $this->$name();
        $e = new \\RuntimeException('x');
        return $e::class . app('cache')::class . app(User::class);
    }
}
`,
    );
    expect(a.dynamicUnresolved).toEqual([
      "new $class (a class chosen at run time) on line 7",
      "$class::$method (a class held in a variable) on line 8",
      "a container lookup with an id computed at run time ($name…) on line 9",
      "call_user_func($method…) (a callable chosen at run time) on line 10",
      'a class name built from "App\\Models\\{$name}" on line 11',
      'a class name built from "App\\Jobs\\" on line 12',
    ]);
    const b = sym(a, "Dyn.b");
    expect(b.uses).toEqual(
      expect.arrayContaining(["$App$Models$Post.observe", "$App$Models$User.observe"]),
    );
    expect(b.thisEscapes).toBe(true);
    expect(specs(a)).toContain("@bind-key/cache");
  });

  it("a smarttest-loads comment replaces the uncertainty with the files it names", () => {
    const a = analyzePhp(
      "app/Owner.php",
      `<?php
namespace App;
class Owner {
    public function find(string $class, int $id) {
        // smarttest-loads: app/Models/*.php
        return $class::query()->find($id);
    }
    public function rest($x) { return [$x ? 1 : PHP_INT_MAX, $x | ENT_QUOTES]; }
    public function gen() { yield from $this->items(); }
}
`,
    );
    expect(a.dynamicUnresolved).toEqual([]);
    expect(a.dynamicHints?.map((h) => h.pattern)).toEqual(["@root/app/Models/*.php"]);
    // Neither a ternary's constant, a bitwise or nor `yield from` is a class.
    expect(specs(a).filter((s) => s.startsWith("@class/"))).toEqual([]);
  });

  it("treats a class named by a string as a class, without uncertainty when it is no class", () => {
    const a = analyzePhp(
      "config/app.php",
      `<?php return ['model' => 'App\\Models\\User', 'ns' => 'App\\Http'];`,
    );
    expect(specs(a)).toEqual(["@class-string/App/Http", "@class-string/App/Models/User"]);
    expect(a.topLevelEscapes?.sort()).toEqual(["$App$Http", "$App$Models$User"]);
  });

  it("links a facade accessor and a Laravel test case; reads bindings and attributes", () => {
    const facade = analyzePhp(
      "app/Facades/Payments.php",
      `<?php
namespace App\\Facades;
use Illuminate\\Support\\Facades\\Facade;
class Payments extends Facade { protected static function getFacadeAccessor() { return 'payments'; } }
`,
    );
    expect(specs(facade)).toContain("@bind-key/payments");
    const test = analyzePhp(
      "tests/TestCase.php",
      `<?php
namespace Tests;
use Illuminate\\Foundation\\Testing\\TestCase as BaseTestCase;
abstract class TestCase extends BaseTestCase {}
`,
    );
    expect(specs(test)).toContain("@app-boot");
    const feature = analyzePhp(
      "tests/Feature/PayTest.php",
      `<?php
namespace Tests\\Feature;
use PHPUnit\\Framework\\Attributes\\DataProvider;
use Tests\\TestCase;
class PayTest extends TestCase {
    #[DataProvider('amounts')]
    public function test_pays(int $amount): void { $this->assertTrue(true); }
}
`,
    );
    expect(sym(feature, "PayTest.test_pays").refs).toContain(
      "$PHPUnit$Framework$Attributes$DataProvider",
    );
    expect(feature.imports.find((i) => i.specifier === "@fn/Tests/Feature/DataProvider")).toBe(
      undefined,
    );
    expect(
      phpBindings(
        "app/Providers/AppServiceProvider.php",
        `<?php
namespace App\\Providers;
use App\\Contracts\\Gateway;
use App\\Services\\StripeGateway;
class AppServiceProvider {
    public function register(): void {
        $this->app->bind(Gateway::class, StripeGateway::class);
        $this->app->singleton('payments', fn ($app) => new \\App\\Services\\Payments($app['config']));
        $this->app->scoped(Cart::class);
    }
}
`,
      ),
    ).toEqual([
      { key: "App\\Contracts\\Gateway", isClass: true, concrete: "App\\Services\\StripeGateway" },
      { key: "payments", isClass: false, concrete: "App\\Services\\Payments" },
      { key: "App\\Providers\\Cart", isClass: true, concrete: "App\\Providers\\Cart" },
    ]);
  });

  it("marks the Laravel bootstrap as loading configs, routes, providers and migrations", () => {
    const a = analyzePhp(
      "backend/bootstrap/app.php",
      `<?php
use Illuminate\\Foundation\\Application;
return Application::configure(basePath: dirname(__DIR__))
    ->withRouting(web: __DIR__.'/../routes/web.php')->create();
`,
    );
    expect(specs(a)).toContain("../routes/web.php");
    expect(a.dynamicHints?.map((h) => h.pattern)).toEqual(
      expect.arrayContaining([
        "@root/backend/config/**/*.php",
        "@root-load/backend/bootstrap/providers.php",
        "@root-load/backend/routes/**/*.php",
        "@root-load/backend/database/migrations/**/*.php",
      ]),
    );
  });

  it("a Pest file depends on the nearest Pest.php", () => {
    const a = analyzePhp(
      "tests/Feature/HomeTest.php",
      `<?php\nit('shows the home page', function () { $this->get('/')->assertOk(); });\n`,
    );
    expect(specs(a)).toContain("@pest/tests/Feature");
  });
});

describe("phpMutationPoints", () => {
  it("puts a throw at the start of every named function and method with a body", () => {
    const text = `<?php
function f() { return 1; }
abstract class A {
    abstract public function g();
    public function h(): int { return 2; }
}
$x = function () { return 3; };
`;
    const points = phpMutationPoints("a.php", text);
    expect(points.map((p) => p.name)).toEqual(["f", "A.h"]);
    const p = points[1] as (typeof points)[number];
    expect(text.slice(0, p.start).endsWith("public function h(): int {")).toBe(true);
  });
});
