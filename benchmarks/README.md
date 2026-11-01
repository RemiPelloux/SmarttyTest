# Benchmarks

Reproducible performance benchmarks under documented conditions (ST-096). Latest results: **[RESULTS.md](RESULTS.md)**.

```bash
pnpm build && pnpm bundle:cli
node benchmarks/run.mjs                      # small (50), medium (500), large (2,000), xlarge (10,000 modules)
node benchmarks/run.mjs --sizes small,medium
node benchmarks/run.mjs --generate xlarge    # only generate one repository and print its path (profiling)
```

The script generates seeded, layered TypeScript repositories (one test per module), commits them to Git, mutates a mid-graph method and measures SmartTest's own overhead. Each warm run follows a new edit, so the persisted graph is patched rather than reloaded unchanged. Test execution time is excluded. Targets come from PRD §31.3 and the 1.0.0 performance story, and are reported as met or missed:

| Operation                                       | Target   |
| ----------------------------------------------- | -------- |
| Warm CLI startup                                | < 300 ms |
| Warm analysis, end to end (CLI, 10,000 modules) | < 1 s    |
| Cold start, end to end (CLI, 2,000 modules)     | < 1 s    |
| Simple diff analysis, warm index                | < 500 ms |
| Warm graph selection                            | < 200 ms |
| Standard report generation                      | < 2 s    |

To profile one run end to end: `node benchmarks/run.mjs --generate xlarge`, edit a module in the printed repository, then `node --cpu-prof packages/cli/.publish/dist/bin.js impact` inside it.
