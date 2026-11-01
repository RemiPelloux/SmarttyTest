# Security policy

SmartTest runs inside developer repositories and executes project tests, so we take security seriously (PRD §30).

## Reporting a vulnerability

**Please don't open a public issue.** Use GitHub's private vulnerability reporting (_Security → Report a vulnerability_) on this repository.

We aim to acknowledge reports within **3 business days** and to agree a disclosure timeline with you, normally **90 days** or less.

## Supported versions

| Version          | Supported    |
| ---------------- | ------------ |
| pre-1.0 (`next`) | Best effort  |
| 1.x              | Yes, from GA |

## Scope highlights

- Writing files outside approved paths, path traversal, or overwriting user files
- Secret leakage into logs, reports or the local store
- Command injection through config, test names, paths or VCS data
- Script injection in HTML reports from untrusted repository content
- Supply-chain issues in published packages
- Studio authentication, cross-origin requests, report access and project source containment

## Local execution and Studio

A TypeScript or JavaScript configuration file, hook checks and tests execute code with the current user's permissions, like `npm test`. Use SmartTest only in repositories whose code you would run. The temporary checkout isolates Git state, but it is not a process sandbox.

In CI, run pull requests from forks without secrets: use `pull_request`, not `pull_request_target`, and never in a job that holds deploy credentials.

Repository content cannot redirect SmartTest itself:

- **Configuration paths.** `storeDir`, `reports.outputDir`, generator paths and runner paths must stay inside the project.
- **Symbolic links.** State, reports, logs, generated tests and hooks are never written through a link inside the project.
- **Committed state.** A store committed to Git is refused (`ST_STORE_TRACKED`), so planted caches cannot turn tests into passes.
- **Option injection.** Revision and file names cannot be read as options by `git`, `svn` or `hg`.
- **Rendering.** Terminal output and the markdown summary are stripped of escape sequences and markup.

State restored from a CI cache is still trusted. Never restore a cache saved by an untrusted pull request into a trusted job.

The VS Code extension does nothing in Restricted Mode, and `smarttest.executablePath` is a restricted setting.

Studio binds to loopback and checks Host and Origin, which prevents DNS rebinding. It requires an unpredictable session token. The token is compared in constant time, passed in a header and never sent in a URL query or a Referer. Mutations are restricted to JSON POST requests, and bundled assets are served under a restrictive Content Security Policy.

Source reads check real paths against the project root. Report downloads use an explicit filename allowlist and refuse links. Served reports are sandboxed.

None of this protects against a local process racing filesystem renames. Do not expose the port through a public tunnel or share the printed token URL.

The 1.0.0 [security review](documentation/architecture/security-review.md) records the threat model, the findings and their fixes, the accepted risks, and what was not reviewed.

## Our commitments

No telemetry. No network calls from the core. Secret redaction in every log sink. Releases are built locally from a verified tree (`pnpm verify`); `release:pack` writes a CycloneDX SBOM (`sbom.cdx.json`, shipped in the package) and runs `npm audit` on the runtime dependencies.
