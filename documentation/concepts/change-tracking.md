# Change tracking: Git, Subversion, Mercurial, native snapshots

## Git (default when a repo is detected)

| Flag            | Compares                                                                           |
| --------------- | ---------------------------------------------------------------------------------- |
| `--base <ref>`  | merge-base(`<ref>`, HEAD) → working tree (`--base-mode direct` to skip merge-base) |
| `--staged`      | HEAD → index                                                                       |
| `--uncommitted` | HEAD → working tree + untracked (honours `.gitignore`)                             |

Renames carry `previousPath`. Deletions mark dependent tests as affected. Worktrees and nested repositories are supported, and each repository boundary is reported, never mixed. A shallow clone that doesn't contain the base gives a clear error (exit 4) with a `git fetch` hint.

## Subversion and Mercurial

Detected automatically when there is no Git repository (`vcs.provider: "auto"`), or chosen with `vcs.provider: "svn"` / `"hg"`. Neither has a staging area, so `run`, `--staged` and `--uncommitted` all compare the working copy with its base (`BASE` in Subversion, the working directory's parent in Mercurial), unversioned files included. `--base <rev>` takes a revision: in Subversion it is compared directly (`svn diff -r <rev>`); in Mercurial with the common ancestor of `<rev>` and the working directory (`--base-mode direct` compares with `<rev>` itself). Changed line ranges and the content before the change come from `svn diff` / `svn cat` and `hg diff` / `hg cat`. `benchmark`, `ci` and `hook` are Git-only.

## Native snapshots (no VCS required)

```bash
smarttest snapshot create            # baseline: content hashes, not copies
# …edit files…
smarttest snapshot diff              # ChangeSet vs latest snapshot
smarttest run --affected             # uses the latest snapshot automatically
```

- Fingerprints use mtime and size as a pre-check, then a content hash to confirm.
- Content isn't stored by default. In that case changed ranges are _unknown_, and the ChangeSet is marked `partial`, which widens selection.
- A snapshot becomes a verified baseline only once execution evidence is attached to it.

## Hybrid mode

With Git present and `vcs.snapshots: true` (the default), SmartTest records a native snapshot after every fully passing run. `smarttest run --since-snapshot` then compares against the last green run, which is fast and incremental between commits, while `--base main` still compares against Git. Snapshot IDs are never treated as commits.

The baseline only moves forward on green runs. A failing test therefore stays selected until it passes.

## Not in 1.0

SVN and Mercurial (roadmap 0.8.0) and other systems through plugins will implement the same `VersionControlAdapter` contract. Their markers are detected and reported as unsupported in 1.0.
