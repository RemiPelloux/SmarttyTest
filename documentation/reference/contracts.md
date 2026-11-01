# Public contracts

SmartTest follows [semantic versioning](https://semver.org) from 1.0.0. This page lists what is public, so that scripts, CI pipelines, editors and plugins can rely on it, and which changes need a major version.

## What is frozen at 1.0.0

| Contract                  | Where it is defined                                                                                                      | Checked by                                                                  |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------- |
| Configuration file        | [`config.v1.schema.json`](../../packages/cli/schemas/config.v1.schema.json), [configuration reference](configuration.md) | `packages/config/src/schema.test.ts` (schema = type = validator)            |
| Exit codes and categories | [Exit codes](#exit-codes) below, `packages/shared/src/errors.ts`                                                         | `packages/shared/src/errors.test.ts`, `integration-tests/contracts.test.ts` |
| `--json` documents        | One `<command>.v1.schema.json` per frozen command in [`packages/cli/schemas/`](../../packages/cli/schemas)               | `integration-tests/contracts.test.ts` validates real CLI output             |
| Error document            | [`error.v1.schema.json`](../../packages/cli/schemas/error.v1.schema.json)                                                | `integration-tests/contracts.test.ts`                                       |
| Plugin SDK v1             | `@tkmremi/smarttest/plugin-sdk`, `@tkmremi/smarttest/plugin-sdk/conformance` ([Plugins guide](../guides/plugins.md))     | the conformance kit, run against every built-in adapter                     |
| Commands and flags        | [CLI reference](cli.md)                                                                                                  | `integration-tests/docs.test.ts` parses every documented command line       |

The schemas ship in the package: `node_modules/@tkmremi/smarttest/schemas/<name>.v1.schema.json`, also importable as `@tkmremi/smarttest/schemas/<name>.v1.schema.json`.

`@tkmremi/smarttest/studio` exports `startStudio(options)` ([Studio guide](../guides/studio.md#embedding-and-assets)): its options and handle follow the semver policy below, while what Studio shows is not a contract.

Not public, and free to change in any release: everything under `.smarttest/` (index, graph, traces, history, caches, logs; SmartTest rebuilds what it cannot read), the HTML report's layout, human-readable terminal output, log messages, and the `@smarttest/*` workspace packages, which are bundled into `smarttest` and not published.

### `--json` documents

With `--json`, a command prints exactly one JSON document on stdout; logs and progress go to stderr. Every document has `"schemaVersion": 1` and `"command"`. When the command fails, the document is the error document instead, and the exit code follows its category.

| Command                         | Schema                              | Notes                                                                  |
| ------------------------------- | ----------------------------------- | ---------------------------------------------------------------------- |
| `run`                           | `run.v1.schema.json`                | `smarttest ci --json` (without `--dry-run`) prints this document too   |
| `impact`                        | `impact.v1.schema.json`             |                                                                        |
| `scan`                          | `scan.v1.schema.json`               |                                                                        |
| `explain`                       | `explain.v1.schema.json`            | `kind` is `test` or `source`; `units` with `--units`                   |
| `ci --dry-run`                  | `ci.v1.schema.json`                 | The comparison plan                                                    |
| `doctor`                        | `doctor.v1.schema.json`             |                                                                        |
| `shard`                         | `shard.v1.schema.json`              |                                                                        |
| `flaky`                         | `flaky.v1.schema.json`              |                                                                        |
| `validate-selection`            | `validate-selection.v1.schema.json` |                                                                        |
| `hook status/install/uninstall` | `hook.v1.schema.json`               | One of three shapes, one per subcommand                                |
| `sync`                          | `sync.v1.schema.json`               |                                                                        |
| any command, on failure         | `error.v1.schema.json`              | `error.code`, `error.category`, `error.message`, optional `error.hint` |

`run --hook --json` adds a `hook` object to the `run` document. When the hook ran nothing (bypassed with `SMARTTEST_SKIP=1`, `hook.skipped: true`, or a push that only deletes remote refs, `hook.nothingPushed: true`), the document has `schemaVersion`, `command` and `hook` only: there is no `report`, and nothing is reported as passed.

`trace`, `shadow`, `migrate`, `init`, `uninstall`, `generate`, `rules`, `snapshot`, `vcs`, `benchmark`, `graph`, `coverage`, `report` and `studio` also accept `--json`. Their documents carry `schemaVersion: 1` but are **experimental**: their shape may change in a minor release. A test fails when a command starts printing JSON without being listed as frozen or experimental.

Consumers should ignore fields they do not know and tolerate new values in enumerations of output fields (a new selection reason `kind`, a new doctor `check`).

### Exit codes

| Code | Category         | Meaning                                                                         |
| ---- | ---------------- | ------------------------------------------------------------------------------- |
| 0    | —                | Success                                                                         |
| 1    | `test-failure`   | A test failed, timed out or was cancelled                                       |
| 2    | `usage`          | Unknown command or flag, bad argument                                           |
| 3    | `configuration`  | Invalid configuration or plugin, rule conflict, confirmation required           |
| 4    | `infrastructure` | A runner, the version control or an edge provider failed; a base ref is missing |
| 5    | `policy`         | A safety check found a missed failure; a rollback would overwrite edited files  |
| 70   | `internal`       | A SmartTest bug                                                                 |

Errors also carry a stable `code` such as `ST_CONFIG_INVALID` or `ST_GIT_BASE_MISSING`. A code is never renamed, reused for another condition, or moved to another category within a major version.

A write that needs confirmation and gets neither `--yes` nor a prompt (non-interactive, or `--json`) exits 3 with `ST_INIT_CONFIRMATION_REQUIRED` (`init`, `sync`, `migrate`), `ST_HOOK_CONFIRMATION_REQUIRED` (`hook install`, `hook uninstall`; 0.x used `ST_INIT_CONFIRMATION_REQUIRED` there) or `ST_CONFIRMATION_REQUIRED` (`uninstall`).

## Semver policy

**Breaking, only in a major version (2.0.0):**

- Removing or renaming a field of a frozen `--json` document, changing its type, or changing what it means.
- Removing a frozen document, or making it print something other than one JSON document.
- Changing the exit code of an existing condition, the category of an error code, or reusing an exit code or error code for another condition.
- Removing or renaming a configuration key or one of its accepted values, changing what a key or its default means, or rejecting a configuration that the frozen schema accepts.
- Removing or renaming a command or a documented flag, or changing what it does.
- Plugin SDK: removing or renaming an exported type, function or member; adding a required member to an interface that plugins implement; changing `PLUGIN_API_VERSION`.
- Anything that lets a test that should have run be skipped. That is a bug, fixed in a patch release, never a behaviour change.

**Not breaking, in a minor or patch release:**

- Adding optional fields to `--json` documents, and new values in output enumerations.
- Adding configuration keys (always optional) and new accepted values.
- New error codes for new conditions, with an existing category.
- New commands, flags and experimental `--json` documents; promoting an experimental document to frozen.
- Plugin SDK: new optional members on interfaces that plugins implement (SmartTest handles their absence), new members on objects SmartTest passes to plugins, new capability keys (undeclared counts as unsupported), new edge kinds, new conformance checks for behaviour the contract already required.
- Selecting more tests where the analysis was too narrow, and fewer where it can prove they are unaffected, within the rules of the selected safety mode.

**Deprecation:** something deprecated keeps working and warns (a configuration warning, `deprecated` in the schema, a note in `--help`) for at least one minor version, and is removed only in the next major. A future breaking change to a document ships as `<command>.v2.schema.json` with `schemaVersion: 2`.

## Migrating from 0.x

No configuration key was renamed or removed between 0.1 and 1.0, so a 0.x configuration keeps its meaning. Run `smarttest doctor` and `smarttest sync --check` after upgrading. (`smarttest migrate --to vitest` moves Jest projects to Vitest; it is not needed for the upgrade.)

What can change for you:

- **Stricter validation.** 1.0.0 validates values that 0.x silently ignored. A configuration that set them to a wrong type now fails with `ST_CONFIG_INVALID` (exit 3) and names the key: rules inside `projects.<dir>.rules` (not checked at all before) and `projects.<dir>.tests.*`, `snapshots.storeContent`, `snapshots.keep`, `reports.outputDir`, a rule's `generate`, `execution.retries`, `execution.alwaysRunOnAffected`, `match.visibility` (`public`, `protected` or `private`), and empty `plugins` entries. Validate a JSON configuration against `config.v1.schema.json` to find them all at once.
- **`$schema`** in `smarttest.config.json` is accepted without a warning.
- **One document per `--json` call.** `init --json` and `migrate --to vitest --json` without `--yes` used to print the plan and then an error document. They now print only the error (`ST_INIT_CONFIRMATION_REQUIRED`, exit 3); use `--dry-run --json` to get the plan, or `--yes` to apply it.
- **Documents frozen in 1.0.0** (`ci`, `doctor`, `shard`, `flaky`, `validate-selection`, `hook`, `sync`) kept their 0.9 shape; they now have schemas.
- **Adapters written against `@smarttest/plugin-sdk` 0.x** must declare `apiVersion: 1`. `LanguageAdapter`, `SymbolGraph`, `TestTarget` and `SourceSymbol` were specification sketches that SmartTest never called; they are no longer exported. Implement `LanguageAnalyzer` instead (see the [Plugins guide](../guides/plugins.md)).
