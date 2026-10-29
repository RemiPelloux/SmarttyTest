## Story

Closes ST-___ (#issue)

## What & why

<!-- One paragraph. Link spec sections (§) if relevant. -->

## Acceptance criteria

- [ ] AC 1 …

## Safety checklist

- [ ] No skipped/cached/partial result can be presented as passed/fresh/full
- [ ] Unknown dependencies widen selection (never dropped)
- [ ] No writes outside `.smarttest/` without dry-run + approval; writes are atomic
- [ ] No network calls / AI deps in core
- [ ] Exit codes & JSON schemas unchanged (or flagged as breaking)

## Definition of Done

- [ ] Tests added/updated · `pnpm verify` green
- [ ] Docs updated (CLI/config reference, concepts)
- [ ] Changeset added (user-visible changes)
- [ ] Performance measured (if relevant): numbers here
