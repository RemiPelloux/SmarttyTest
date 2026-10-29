# Runtime evidence

Static analysis says what a test can reach. A trace says what it ran. SmartTest combines both.

## Collecting traces

`smarttest trace` runs every test file on its own with V8 coverage (`NODE_V8_COVERAGE`). Vitest runs in worker-thread mode for this, Jest runs in band, `node --test` needs nothing special. For each test, `.smarttest/state/traces.json` stores:

- the functions it ran in each project file, by name (methods, functions, arrow functions assigned to a name),
- every function name V8 reported for those files, to detect names that do not map to a declaration,
- the content hash of every project file it loaded,
- a fingerprint of the Node.js major version and the lockfiles.

A failing test is not traced. Collection takes about one run of each test file; on LeadsIt (100 test files, three runners) it takes 23 seconds with four workers.

## When a trace is used

A trace is fresh while every file it loaded has, at the base of the change being analysed, the content it had when the trace was taken, and the runtime fingerprint is unchanged. A file changed by the current change is compared through its old content, so a trace taken at `HEAD` stays usable for the working tree. A stale trace is ignored, never reused. `smarttest trace --stale` refreshes only the stale ones.

## How traces change the selection

Only code changes are compared with traces. Environment keys, translation keys, assets and deleted files keep their static edges.

| Mode           | Effect of a fresh trace                                                                                                                                                                                                                                                                                                             |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| FAST, BALANCED | A test selected only by static dependency edges is skipped when its trace never ran any changed unit. A test with unresolved dynamic imports is not selected for uncertainty when its trace never ran the changed code. A test static analysis does not reach is selected when its trace ran a changed unit (`observed-execution`). |
| SAFE           | Static selections are kept. Observed execution can only add tests.                                                                                                                                                                                                                                                                  |

"Ran a changed unit" is decided per function where V8 reports a name that matches the changed declaration. For values, classes as a whole, constructors, anonymous code and names V8 does not report, loading the file counts as running it.

The argument that skipping is safe: a changed function that a test never called can only start being called through code the test does run, and that code would then be part of the change too. This assumes the test is deterministic. Shadow Mode exists to catch the cases where that assumption fails.

`explain` shows skipped tests with the trace date: "Reachable statically, but its trace (date) never ran the changed code".

## Unprotected changes

`impact` lists changed units that no test reaches statically and no fresh trace ran. These are the places a change has no test coverage at all.

## Shadow Mode

`smarttest shadow` runs the full suite next to the selection and records the comparison in `.smarttest/shadow/history.jsonl`. `smarttest shadow --report` summarises the drift over all runs. Run it nightly or on a schedule in any CI system; it needs no hosted service.
