# PHP (preview)

SmartTest selects and runs the tests of PHP projects that use PHPUnit, Pest or `php artisan test`, Laravel applications included. PHP is a **preview**: it never hides a failure, but its precision is coarser than for TypeScript. SmartTest reads the PHP sources in TypeScript, without running PHP, and runs your own test runner as a subprocess.

## Installing beside PHP

SmartTest is an npm package. A PHP repository needs Node (22.12 or later) on the machine, not a `package.json`:

```bash
npx --yes @tkmremi/smarttest init      # writes smarttest.config.json and the Git hook
npx --yes @tkmremi/smarttest run       # runs the tests the uncommitted change can affect
```

In a repository without `package.json`, `init` writes the configuration as `smarttest.config.json`, which loads without installing the package, and the hook runs SmartTest through `npx --yes @tkmremi/smarttest`. If the repository also has a `package.json` (a Laravel app with Vite), you can instead `npm install -D @tkmremi/smarttest`; the hook then runs the installed copy.

PHP itself must be installed with the project's Composer dependencies (`composer install`): SmartTest runs `vendor/bin/phpunit`, `vendor/bin/pest` or `php artisan test`. The PHP binary is, in this order: `SMARTTEST_PHP`, `php.binary` in the config, then `php` on `PATH`. A bare command (`php8.3`) is looked up on `PATH`; a relative path is relative to the project.

```json
{
  "php": { "enabled": true, "binary": "php8.3" }
}
```

`"php": { "enabled": false }` turns the preview off: `.php` files are no longer analysed and PHPUnit is no longer run.

## Supported setups

| Setup                                                | How SmartTest finds and runs the tests                                                                                                                                                                                                      |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| PHPUnit 10 or 11 (`phpunit.xml`, `phpunit.xml.dist`) | `--list-tests-xml` lists the test classes PHPUnit collects from the configuration: its test suites, folders, suffixes, `exclude` entries and excluded groups. A selection runs with the files as arguments; results come from `--log-junit` |
| `php artisan test` (a Composer script runs it)       | The same, through `php artisan test`, which runs PHPUnit or Pest with Laravel's own options                                                                                                                                                 |
| Pest (`vendor/bin/pest`)                             | The same, through Pest                                                                                                                                                                                                                      |

A PHP project is any folder with a `composer.json` (outside `vendor/`) whose PHPUnit configuration or `*Test.php` files show tests; `smarttest doctor` shows `phpunit (. · phpunit.xml) collects 1998 test file(s)`. SmartTest turns off the project's own PHPUnit logging and result cache for its runs (`--no-logging`, `--do-not-cache-result`): it writes nothing in the project. Xdebug is off unless you set `XDEBUG_MODE`.

A fatal error, a selected file PHPUnit runs no test from, and "No tests executed" are failures, never passes. When PHPUnit fails a run without a failing test (a risky test with `failOnRisky`, a warning with `failOnWarning`), the tests its event log names fail; if it names none, every file of that run fails.

## What is understood

- **Names, as PHP resolves them.** Namespaces; `use` statements, grouped (`use App\Models\{User, Post}`), aliased, `use function` and `use const`; names in the same namespace used without `use`; fully qualified names.
- **Declarations.** Classes, interfaces, traits and enums, with their methods, constants, properties and cases; top-level functions (including those declared inside `if (! function_exists(…))`), constants and `define()`.
- **Edges.** `extends`, `implements` and trait `use`; `new X`, `X::method()`, `X::CONST`, `X::class`, `instanceof` and attributes. A method used through `$this->`, `self::`, `static::`, `parent::`, a typed parameter or a typed property (`$this->orders->latest()` with `private OrderRepository $orders`) links to that method; any other use links to the whole class. A call through an interface reaches every implementation of that method.
- **Files.** Composer's `autoload` and `autoload-dev`: PSR-4, PSR-0, `classmap` and `files`; a class found elsewhere in the project is found too. `require`/`include` of a literal path (`__DIR__.'/x.php'`, `dirname(__DIR__).'/x.php'`, `base_path('routes/api.php')`, a variable holding such a path).
- **Laravel.** A facade links to the class behind it (`getFacadeAccessor()` returning a class or a container key, and the aliases in `config/app.php`); `bind`, `singleton`, `scoped` and `instance` in service providers link an interface or a key to its implementation; `app(X::class)`, `resolve()` and `->make()` link to `X`. A test extending Laravel's test case boots the application: it reaches `bootstrap/app.php`, the providers in `bootstrap/providers.php`, every `config/` file, and the listeners and policies Laravel discovers. The boot also loads the route files, migrations, translations, views and commands, but only their own code reaches it: what a route or a command names is reached through the tests that request it.
- **Routes.** `routes/*.php` is read without running it: `Route::get`/`post`/`put`/`patch`/`delete`/`options`/`any`/`match`, `view`, `redirect`, `fallback`, `resource` and `apiResource` (`only`, `except`, nested names), groups (fluent `prefix`, `name`, `middleware`, `controller`, or an attribute array) and the files they `require`. Each route links to its action (`[C::class, 'm']`, an invokable controller, `'m'` inside a controller group, `'C@m'`, a closure), the constructor of its controller and the middleware it names. `routes/api.php` routes are under `/api`; a route file another one includes has an unknown prefix and serves any request ending with its path.
- **Requests.** A test's `$this->get`/`post`/`put`/`patch`/`delete` (and their `Json` forms), `json('METHOD', …)` and `call(…)` link it to the routes that can serve the url: literal, concatenated (`'/api/posts/'.$id`), interpolated, `sprintf`, a class constant, `url(…)` or `route('name')`; the computed parts match any value. A test-case method whose request url is its own parameter (`authenticatedRequest($method, $uri)`) is a request helper: each call with a literal url is a request. A command a test runs (`$this->artisan('x:y')`, `Artisan::call('x:y')`) links to the class whose `$signature` names it.
- **Classes chosen at run time, read statically.** A class list in a `foreach` or a class constant, a `match` whose arms are `X::class`, a list read from configuration (`foreach (config('prospection.connectors') as $class)` reaches that config file), and a private method's class parameter that every caller in the class fills with `X::class`. A typed parameter's constructor runs before the method (its caller or the container builds it); a controller action's parameters are used whole (form requests validate, models bind).

## What selects a test

| You change                                                                                        | Selected                                                                              |
| ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| A method                                                                                          | The tests that reach it through one of the edges above                                |
| A constructor, a property, a constant, an enum case, the class's declaration                      | Every test that reaches the class                                                     |
| A trait                                                                                           | Every test that reaches a class using it                                              |
| A class a test or a factory builds (`new X`, `return new self`)                                   | Every test that builds or receives it: any of its members can be called on the object |
| A controller, or what one uses                                                                    | The tests that request one of its routes                                              |
| A command's `handle()`, or what it uses                                                           | The tests that run that command                                                       |
| A route file, a config file, a provider, a migration, a translation, a view, `tests/TestCase.php` | Every test that boots the application                                                 |
| What the application boot reaches, when the tests run through `php artisan test`                  | Every test: Artisan boots the application before PHPUnit starts, plain test cases too |
| `phpunit.xml`, its `bootstrap` file, `.env.testing`, `tests/Pest.php`                             | Every test of that PHPUnit configuration                                              |
| `composer.json`, `composer.lock`                                                                  | Every test in that folder and below                                                   |
| A test file                                                                                       | That test                                                                             |

## What is uncertainty

A name SmartTest cannot read is uncertainty: the tests that reach it are selected in BALANCED and SAFE, whatever changed. That covers:

- `new $class`, `$class::method()` and `$class::$method()` when `$class` is not a literal (a class list in a `foreach`, or in a class constant, is read);
- `app($name)`, `resolve($name)` and `->make($name)` with an id computed at run time (a string key is looked up in the providers' bindings);
- `call_user_func($callable)` and `$object->$method()` with a callable or a method chosen at run time;
- class names built from strings (`'App\\Models\\'.$name`, `"App\\Models\\{$name}"`);
- `require $path` when the path is not a literal;
- a request whose url is built at run time (`$this->get($this->urlFor($post))`), a request helper called with one, or a request no route SmartTest read serves: uncertainty for that test only;
- a class under one of the project's namespaces (`App\…`) that no file declares.

When you know what such a line can load, say so in a comment on that line or the line above, with globs relative to the project root; those files become its dependencies instead of uncertainty:

```php
// smarttest-loads: app/Models/*.php
$model = $class::query()->find($id);
```

Name every place it can load from: the comment replaces the uncertainty.

## Known limits

- **What the boot runs still selects every booting test.** A provider's `boot()` (and what it calls), a class a config file names, a listener or a policy: a change there selects every test that boots the application, and under `php artisan test` every test.
- Route model binding and form requests are reached through the controller action's parameters; a route's `can()` reaches the policies Laravel discovers (every booting test). Routes registered by packages, `Route::macro` and domains are not read: a request they would serve is uncertainty for its test.
- A request helper called other than as `$this->helper(…)` (from another object, through `static::`) is not followed.
- Values returned by methods are not typed: `X::make()->run()` links to `X::make`, and a method that returns `new self` or `$this` makes its callers reach the whole class.
- Magic methods (`__call`, `__get`), Eloquent attributes and relations, and macros are not followed; the whole class is linked when a member is not found.
- `smarttest trace` (observed execution) records nothing for PHP; PHP selection is always static. `audit --mutate` covers PHP; `audit --resolution` checks JavaScript and TypeScript imports only.
- Blade templates are analysed as files: a change to one selects the tests that boot the application.
