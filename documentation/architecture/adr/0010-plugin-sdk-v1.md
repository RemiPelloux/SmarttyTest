# ADR-0010: Plugin SDK v1 and edge providers

- **Status:** Accepted (1.0.0)
- **Related:** roadmap 1.0.0, PRD §27, §27.7, §32.2, ADR-0004, ADR-0005, ADR-0006, [Plugins guide](../../guides/plugins.md), [Public contracts](../../reference/contracts.md)

## Context

1.0.0 freezes the adapter contracts so that others can extend SmartTest. Three already had implementations (five runners, three version-control adapters, two analyzers) but no versioning and only a minimal conformance check. The PRD's language contract (§27.4 `LanguageAdapter`: whole-project `analyze` and `findTestTargets`) was never implemented: the engine is built on a per-file analyzer and a graph SmartTest owns. Other languages and cross-language relationships (§27.7) need a way to add dependencies without writing a full analyzer.

## Decision

- The Plugin SDK v1 exports four contracts from `@tkmremi/smarttest/plugin-sdk`: `TestAdapter`, `VersionControlAdapter`, `LanguageAnalyzer` (the per-file analyzer SmartTest uses, replacing the §27.4 sketch) and `EdgeProvider`. Each implementation declares `apiVersion: 1`. The types stay in `shared` (ADR-0006) and `plugin-sdk` re-exports them.
- A plugin is a module listed in the `plugins` option; its default export is a `SmartTestPlugin`. In 1.0 it contributes edge providers. Registering runners, version control and analyzers from a plugin is a later, additive change.
- An edge provider returns file-to-file edges `{ from, to, kind, confidence }` and what it could not resolve. Edges enter the graph with provenance `plugin` and only add dependents. Unresolved relationships become uncertainty. A provider that throws or returns malformed output fails the run (`ST_PLUGIN_FAILED`, exit 4), never "no edges". A change to a plugin file inside the project is a trigger for the whole suite.
- Capabilities are declared (ADR-0005): a provider without `fileEdges` is not called; one without `unresolved` is used with a warning.
- A test-framework-agnostic conformance kit (`@tkmremi/smarttest/plugin-sdk/conformance`) checks each contract against a fixture. Every built-in adapter runs it in SmartTest's own suite.

## Consequences

- Third parties get a stable contract and a way to prove they follow it.
- Plugin code runs in the SmartTest process, with the same trust as `smarttest.config.ts`. Providers are asked to stay local (ADR-0004); SmartTest cannot enforce it.
- A project with plugins rebuilds the graph on every analysis (provider output is recomputed), so watch mode does not patch it incrementally.
- Edges are file level. Symbol-level edges can come as a declared capability.

## Alternatives considered

- Freezing the §27.4 `LanguageAdapter`: no implementation, and it would put graph construction in every adapter.
- Edge providers as objects in `smarttest.config.ts`: the config is transpiled into `.smarttest/tmp`, so relative imports from it break, and JSON configs could not use them. Module paths work for both.
- Treating a failing provider as having no edges: silently narrower selections, against §32.2.
