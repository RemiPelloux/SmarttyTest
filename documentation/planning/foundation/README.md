# Foundation backlog

The first backlog of SmartTest: 15 epics, 103 stories, 422 points, planned in 11 sprints of about 40 points. It was delivered in 0.1.0 and 0.2.0. Open items continue in the [roadmap](../roadmap.md).

|           |                                                                                             |
| --------- | ------------------------------------------------------------------------------------------- |
| Scope     | Every P0 module of the [PRD](../../product/PRD.md#32-functional-modules) (Releases 0 and 1) |
| Delivered | 386 of 422 points                                                                           |
| Not done  | partial, todo, changed or dropped stories, each with a note in its epic page                |

## Files

| File                                   | Content                                                                    |
| -------------------------------------- | -------------------------------------------------------------------------- |
| [`epics/`](epics/README.md)            | One page per epic with stories, acceptance criteria and status (generated) |
| [`sprints.md`](sprints.md)             | Sprint plan and milestones (generated)                                     |
| [`backlog.csv`](backlog.csv)           | Import file for issue trackers (generated)                                 |
| [`backlog.data.mjs`](backlog.data.mjs) | Source of truth for the three files above                                  |

Regenerate after editing the data:

```bash
pnpm planning:build          # writes epics/, sprints.md, backlog.csv and checks dependencies and capacity
pnpm planning:build --check  # used by `pnpm verify`
```

## Changes from the original plan

- No hosted CI. Quality gates run locally (`pnpm verify`, `scripts/hooks/pre-push`). ST-006 is marked changed, ST-093 (GitHub Actions template) dropped, ST-100 changed.
- Local store is a JSON store, not SQLite ([ADR-0003](../../architecture/adr/0003-local-store-sqlite.md)).
- 0.2.0 added work outside this backlog, driven by the [LeadsIt migration](../../case-studies/leadsit.md): `node:test`, nested projects, runner-accurate discovery, `.gitignore`-aware listing, computed imports, `benchmark`.
