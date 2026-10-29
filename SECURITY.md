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

## Our commitments

No telemetry. No network calls from the core. Secret redaction in every log sink. npm provenance and an SBOM for every release (ST-099, ST-100).
