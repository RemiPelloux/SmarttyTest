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
- [ ] Regression harness still reports 0 missed failures (once ST-095 exists).
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
- [ ] A Changeset is added for user-visible changes.

**Review**
- [ ] At least one approving review, or two for changes to `impact-engine`, `rules-engine` or the report integrity suite.
- [ ] CI is green on the 3-OS matrix.

## Definition of Done (sprint level)

- [ ] Sprint goal met, or the gap has been explained at review.
- [ ] Demo script from `sprints.md` executed live.
- [ ] `main` is releasable. Pre-release published to `next` at milestone sprints.
- [ ] Risks and assumptions in `risks.md` reviewed.
- [ ] Unfinished stories re-estimated and moved explicitly. Nothing carries over silently.
