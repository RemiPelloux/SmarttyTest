# Benchmarks

Reproducible performance benchmarks under documented conditions (ST-096). Latest results: **[RESULTS.md](RESULTS.md)**.

```bash
pnpm build && pnpm bundle:cli
node benchmarks/run.mjs                      # small (50), medium (500), large (2,000 modules)
node benchmarks/run.mjs --sizes small,medium
```

The script generates seeded, layered TypeScript repositories (one test per module), commits them to Git, mutates a mid-graph method and measures SmartTest's own overhead. Test execution time is excluded. Targets come from PRD §31.3 and are reported as met or missed:

| Operation                        | Target   |
| -------------------------------- | -------- |
| Warm CLI startup                 | < 300 ms |
| Simple diff analysis, warm index | < 500 ms |
| Warm graph selection             | < 200 ms |
| Standard report generation       | < 2 s    |
