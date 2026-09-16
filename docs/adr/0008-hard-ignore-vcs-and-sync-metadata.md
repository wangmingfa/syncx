# ADR-0008: Hard ignore for VCS metadata and syncx's own metadata

## Status

Accepted.

## Context

`.git` was destroyed on one device during the 2026-09-15 incident. The proximate
cause was a Windows path-separator bug (ADR-0007's sibling, commit `6213456`),
but the *reason it was unrecoverable* was structural: `.git` was being treated
as ordinary content, so "this file is missing here" became "the peer deleted
it" became a tombstone, became a real deletion on the other machine.

Three properties made the blast radius worse than a bug report:

1. **Deletions are commands, not hints.** A tombstone for `.git/HEAD` is
   indistinguishable from a tombstone for `notes.txt`. Recovery requires the
   user to notice, and by then git's own invariants are gone.
2. **Ignore rules could not be relied on to prevent it.** The built-in ignore
   list (`.git`, `.hg`, `.svn`, `.syncx-trash`, `.syncx-folder`) is just
   *default text* merged ahead of `.gitignore` / `.syncxignore`; a negation rule
   (`!.git`, documented as supported) re-enables the path. Worse, the ignore set
   is per-device: whatever the *local* config says, it says nothing about what
   the *peer* will push.
3. **Tombstones of ignored paths were deliberately propagated.**
   `filterIndexedEntries` kept tombstones even for ignored entries, so that
   adding an ignore rule later did not strand a deletion. That is the right
   default for `*.log` and the wrong rule for `.git`: a stale tombstone in the
   local index re-deletes the peer's real `.git` on every reconnect, and the
   scar propagates both ways.

## Decision

**`.git`, `.hg`, `.svn`, `.syncx-trash` and `.syncx-folder` become hard-ignored:
a property of the software, not a configuration.**

`isHardIgnored(relPath)` matches by *path segment* (case-insensitively, both
separators tolerated), so `.github/workflows/ci.yml` is unaffected while
`.GIT/config` is caught. Four independent gates use it:

1. **Scanner** — never walks into them, and never emits tombstones for them.
   (Outbound origin.)
2. **`filterIndexedEntries`** — drops hard-ignored entries **including
   tombstones**, so they cannot enter the in-memory index that is exchanged.
   User-level rules keep the old tombstone-propagating semantics; the two cases
   are deliberately different.
3. **`peer.onPeerIndex`** — inbound gate: entries arriving from the peer that
   are hard-ignored are discarded outright (live entries *and* tombstones)
   before `buildPlan` sees them, so they are neither written to disk nor echoed
   back. The outbound `sends` array is filtered once more at the exit, so the
   "nothing hard-ignored reaches the wire" property does not depend on every
   upstream caller remembering to filter.
4. **`resolveSharePath`** — the filesystem boundary: every read/write/delete
   resolves its path through it, and it now refuses these paths. Even if all
   three gates above regressed, syncx still cannot write into the local `.git`
   or move it to the trash. This is the layer that makes the guarantee
   structural rather than a matter of bookkeeping.

On folder-state creation, hard-ignored entries left in an index by older
versions are deleted from the database outright, so the historical seeds stop
being reported in entry counts and cannot mislead later diagnosis.

## Consequences

- A peer running an older version, or one whose `.syncxignore` says `!.git`,
  can no longer damage this machine's `.git`. Entries are dropped and logged
  once per index exchange (`onHardIgnoredDropped`), which is how a user finds
  out that the other end is out of date.
- `!.git` in `.syncxignore` is now a no-op rather than a supported escape
  hatch. The README documents this; the rule is still parsed (gitignore
  semantics are unchanged), it simply cannot win against the hard layer.
- `.git` history is no longer shared between devices, and never was in a
  supportable way. Users who want repository state on both machines should use
  git itself (a remote, or `git bundle`); syncx deliberately will not do it.
- The ignore story is now two-tier and must stay that way: `isIgnored` is pure
  gitignore semantics (and is what the ignore-rule tests exercise), while
  `isIgnoredPath` is the sync decision. Call sites that ask "should this path
  sync?" must use the latter.
