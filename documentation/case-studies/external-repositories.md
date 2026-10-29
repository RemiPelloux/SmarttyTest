# External repositories

The 0.6.0 adoption check: take repositories SmartTest has never seen, run `smarttest init --yes`, change nothing in the generated configuration, and replay their recent history with `smarttest benchmark --commits 12`. A failure that the selection did not include counts as a miss unless it also fails on the parent commit.

The CLI was run from the packed build (`packages/cli/.publish/dist/bin.js`), since the package is not on npm yet. Dependencies were installed with each project's own lockfile.

| Repository                                                            | Runner                      | Test files | Commits            | Full runs | SmartTest | Saved | Test files run | Full-suite fallbacks | Missed | Already failing |
| --------------------------------------------------------------------- | --------------------------- | ---------- | ------------------ | --------- | --------- | ----- | -------------- | -------------------- | ------ | --------------- |
| [tj/commander.js](https://github.com/tj/commander.js)                 | `node --test`               | 110        | 12                 | 27.1 s    | 18.1 s    | 33%   | 644 / 1,312    | 5                    | 0      | 6               |
| [pillarjs/path-to-regexp](https://github.com/pillarjs/path-to-regexp) | Vitest                      | 3          | 12                 | 61.4 s    | 47.3 s    | 23%   | 30 / 36        | 4                    | 0      | 0               |
| [unjs/ufo](https://github.com/unjs/ufo)                               | Vitest                      | 13         | 12                 | 9.9 s     | 10.9 s    | −11%  | 99 / 156       | 7                    | 0      | 0               |
| [unjs/defu](https://github.com/unjs/defu)                             | Vitest                      | 2          | 12                 | 8.0 s     | 8.5 s     | −6%   | 14 / 24        | 6                    | 0      | 0               |
| [LeadsIt](leadsit.md)                                                 | Jest, Vitest, `node --test` | 100        | 40 of the last 200 | 240.7 s   | 88.3 s    | 63%   | 522 / 3,052    | 2                    | 0      | 0               |

All five were set up by `init --yes` without configuration edits, and none had a missed failure.

## What the numbers say

- Most of these commits are dependency updates. A change to `package.json` or a lockfile is a mandatory trigger, so those commits run the full suite ("full-suite fallbacks"). That is deliberate.
- On ufo and defu the whole suite takes well under a second. Analysis plus starting the runner costs more than the tests SmartTest skips, so it is slower than running everything. `smarttest run` has an adaptive policy for this case: once a full run is recorded as faster than a typical analysis, it runs everything without building the graph. `benchmark` measures selection only and does not apply that policy.
- The six "already failing" tests on commander.js failed on the parent commits too; they are not misses.
- `init` found the right runner in every case, including commander's `node --test` and path-to-regexp's `vitest.config.mts`.

## Problems found and fixed in SmartTest

| Found on                       | Problem                                                                                                                                | Fix                                                                                             |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `ts-lib-vitest` fixture        | `new Cache().set(…).size()`: a method that returns `this` hid the members called on its result, so a change to `size` selected nothing | A method that lets `this` escape makes its callers depend on the whole class                    |
| `yarn-workspaces-node` fixture | `node --test packages/*/test/`: a glob that matches directories found no test files                                                    | Directory globs are searched like directories, as Node does                                     |
| All five                       | The generated hook would block commits on machines where SmartTest is not installed yet                                                | The hook runs SmartTest when `node_modules/.bin/smarttest` exists and prints a notice otherwise |

## Not covered yet

- The package is not on npm, so "installed from npm" could not be checked.
- Only Linux was used. macOS and Windows are not validated.
- Next.js and Wasp were not among the external repositories (Wasp is covered by LeadsIt).
