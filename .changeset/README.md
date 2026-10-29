# Changesets

Add one for every user-visible change:

```bash
pnpm changeset
```

Only `smarttest` (packages/cli) is published — as a single bundle built by `scripts/release/bundle-cli.mjs`.
Internal `@smarttest/*` packages are private and versioned in lockstep.
