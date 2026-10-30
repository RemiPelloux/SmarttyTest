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

Project configuration, hook checks and tests execute code with the current user's permissions. Use SmartTest only in repositories you trust; temporary checkout isolation preserves Git state but is not a process sandbox. The VS Code extension refuses execution in an untrusted workspace.

Studio binds to loopback, checks Host and Origin, requires an unpredictable session token and restricts mutations to JSON POST requests. It serves bundled assets under a restrictive Content Security Policy. Source reads check real paths against the project root, including symlink replacements since the last analysis; this is not protection against a local process racing filesystem renames. Report downloads use an explicit filename allowlist. Do not expose the port through a public tunnel or share the printed token URL.

The 0.9.0 tests cover these API boundaries, path traversal, symlinks, cancellation and shutdown. A broader security review remains a 1.0.0 release gate.

## Our commitments

No telemetry. No network calls from the core. Secret redaction in every log sink. Releases are built locally from a verified tree (`pnpm verify`); `release:pack` writes a CycloneDX SBOM (`sbom.cdx.json`, shipped in the package) and runs `npm audit` on the runtime dependencies.
