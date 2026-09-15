# ADR-0007: Index instance lifetime, orphan sweep, and the mount marker

## Status

Accepted.

## Context

A real incident (2026-09-15) destroyed data on both sides of a share: a folder
had been removed from one device and re-added later, and the local index
database (`~/.syncx/index-<hash(folderId)>.db`) survived the removal. The
re-added folder reused that stale index, whose entries referenced files that no
longer existed on disk. The scan therefore classified them as *local
deletions*, produced tombstones, and broadcast them to the peer — hundreds of
files were hard-deleted on both machines (including a `.git` directory).

Two properties of the design turned a bookkeeping mistake into data loss:

1. **Indexes outlived the folders they described.** The index was named after
   the wire identity (`folderId`), which is preserved across a remove/re-add
   (and re-assigned when accepting an invitation), so a new logical folder
   could open an old index. Deletions propagate *trustingly*, so stale entries
   are not merely noise — they are delete commands.
2. **"Missing" and "deleted" were indistinguishable at the filesystem level.**
   A share root that exists but is empty (unmounted filesystem, wiped
   directory) looks exactly like "the user deleted everything".

The purge mechanism that existed (`pendingIndexPurge`) was an in-memory `Set`,
so a restart between "mark for purge" and "reload and unlink" silently lost the
intent. Syncthing solves the same problems with a per-folder index ID and the
`.stfolder` marker; we mirror those two ideas locally.

## Decision

**1. Directory instance (`instanceId`) — index lifetime is bound to instance
lifetime.** Each shared folder carries a local-only `instanceId` (never sent on
the wire, never used for routing). The index file is named after
`instanceId ?? folderId`. New entries — a fresh add, a brand-new accepted
invitation — get a new `instanceId`, so they open a brand-new empty index and
*structurally cannot* inherit stale entries or tombstones. Legacy configs
without `instanceId` fall back to `folderId`, keeping their existing index file
and avoiding a rescan on upgrade. A change of `indexKey` for an existing entry
(hot-reload path) discards the old index and closes/reopens the store.

Correctness no longer depends on deleting an index at all: a surviving orphan
is unreachable because nobody will ever compute its name again.

**2. Startup orphan sweep.** Before the session manager opens any index handle,
`purgeOrphanIndexFiles()` deletes every `index-*.db` (and its SQLite sidecars)
whose name is not in the set expected by the current config. Indexes are
regenerable caches — the worst case is a rescan — so deleting is safe, and it
covers the two paths the in-memory marker could not: editing `config.json`
while the daemon is stopped, and a process restart between mark and unlink.

**3. Mount marker (`.syncx-folder`).** A marker file at the share root records
"this directory is mounted and trustworthy". If it is missing, the scan for
that folder is skipped entirely — no tombstones are inferred — and a folder
error tells the user how to recover. The marker is added to the built-in ignore
list so it is never itself synced. It is created when a folder is added, when a
new folder appears via hot reload with an empty index (safe: an empty index can
only *send*, never delete), and once for pre-existing folders at daemon start
(`markerChecked` records that adoption). Adoption is refused when the index has
live entries but the root is empty, since that is precisely the "unmounted or
wiped" shape and adopting would re-enable the deletion it exists to prevent.

Known blind spot, shared with Syncthing: the marker only lives at the share
root, so a subdirectory that is itself a mount point is not protected.

## Consequences

- A remove/re-add, a re-assigned folder id, or a hand-edited config can no
  longer resurrect an old index; the failure mode is a rescan, not a mass
  delete.
- Existing installs are adopted transparently on first start: folders get
  their marker, the index naming is unchanged for legacy entries, and leftover
  orphan indexes (including the ones that caused the incident) are removed
  automatically.
- Users who empty a folder while the daemon is stopped, or who mount a share on
  a device that is not present, will see the folder paused with an explanatory
  error rather than a silently-propagated mass deletion. Recovery is
  "remove and re-add the folder".
