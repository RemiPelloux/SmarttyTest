# Definition of Ready & Definition of Done

## Definition of Ready (a story may enter a sprint when…)

- [ ] It is written as _As a … I want … so that …_ and has a single, testable outcome.
- [ ] Acceptance criteria are concrete (Given/When/Then or checkable bullets) and agreed with the PO.
- [ ] It is estimated at **≤ 8 points**, or it has been split.
- [ ] Its dependencies are done or scheduled earlier in the same sprint (the generator enforces this).
- [ ] Spec references (§ / letter codes) are listed, so the reviewer knows which requirements apply.
- [ ] The fixtures it needs exist or are part of the story.
- [ ] Any UX output (CLI text, report section) has a sketch or example in the story or linked doc.
- [ ] Security impact is identified: does it touch FS writes, process execution, secrets or network?

## Definition of Done (story level)

This is PRD §36, adapted to the repository.

**Functionality**
- [ ] All acceptance criteria are met and demonstrated against fixtures.
- [ ] Errors use `SmartTestError` with a stable `code`, a `category` and an actionable `hint`.
- [ ] Edge cases are covered: empty project, monorepo, Windows paths, no VCS.
- [ ] Fallback behaviour is defined. Unknown input never means "safe to skip".

**Quality**
- [ ] Unit tests and the relevant integration tests pass (`pnpm verify`).
- [ ] The regression harness still reports 0 missed failures, and new edge types or runners come with a fixture in it.
- [ ] No new `any` and no `// @ts-ignore` without a linked issue.
- [ ] Performance is measured where relevant, with numbers in the PR description.

**Safety & honesty**
- [ ] Nothing writes outside `.smarttest/` without explicit user approval (dry-run first).
- [ ] Reports and CLI output never present skipped as passed, cached as fresh, or partial as full.
- [ ] Secrets are redacted in logs. No network calls (the core is local-first).
- [ ] Security review checklist is done for FS / process / network changes.

**Documentation & DX**
- [ ] Public APIs are typed and documented (TSDoc).
- [ ] The CLI reference and configuration reference are updated for new commands and options.
- [ ] Examples still run.
- [ ] `CHANGELOG.md` has an entry for user-visible changes.

**Review**
- [ ] Changes to `impact-engine`, `dependency-graph`, `rules-engine` or the report integrity suite are checked against a real repository (`benchmark` on LeadsIt or an external repository) before release.
- [ ] `pnpm verify` passes locally (the pre-push hook runs it); before a release, on Linux, macOS and Windows.

## Definition of Done (sprint level)

- [ ] Sprint goal met, or the gap has been explained at review.
- [ ] The version's gate is measured and the result written in the [delivery log](delivery.md), including what was not met.
- [ ] `main` is releasable: `pnpm verify` passes, the version is tagged, docs and the site are rebuilt.
- [ ] Risks and assumptions in `risks.md` reviewed.
- [ ] Unfinished stories re-estimated and moved explicitly. Nothing carries over silently.
