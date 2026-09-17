# ADR-0013: Content diff between two devices (a read-only diagnostic on top of the planner)

## Status

Accepted.

## Context

There is no way to answer "do these two devices actually hold the same content in this shared
folder?" other than reading both disks by hand. When sync looks wrong the user needs to know
*which* files differ and *why* — and the reasons are not all faults.

The comparison logic itself already exists: `compareFileState` (index.ts) is what the planner
runs on every index exchange to decide "what has to move". But it answers a different question,
and reusing its output verbatim would produce a misleading report in three specific ways:

- **Equal version vectors with different content.** `compareFileState` returns `equal` and the
  planner moves on. That is exactly the state a corrupted/incorrectly written index produces, and
  it is the one class the planner can *never* repair by itself: with equal versions no side will
  ever transfer the file, so the divergence persists forever. A tool built only on the planner
  would never surface it.
- **A peer-only path is not necessarily a fault.** Since ADR-0012 the local ignore rules also gate
  the inbound index, and the in-memory index is filtered by them. So "the peer declares it, we do
  not have it" can mean "our rules say we do not want it". Reporting that as `remote-newer`
  ("you should pull it") sends the user off to fix a non-problem.
- **Index vs disk.** An empty edit window, a daemon that was offline, or a file touched by some
  other program all make the index stale. "The index says it exists but the disk does not" and
  "the two devices disagree" are different conclusions with different remedies.

There is also the question of *where* the peer's index comes from. The session already exchanges a
full index at attach time, so an in-memory mirror would need no new protocol at all — but it is
accurate only at the instant of the attach. A peer that later adds an ignore rule, or that is long
lived and only broadcasts deltas, leaves that mirror silently stale, and a diagnostic that returns
a stale conclusion is worse than one that returns none.

## Decision

1. **A pure function, not a new comparison engine.** `src/diff.ts` (`buildFolderDiff`) sits on
   `compareFileState` and adds only the missing classes: `content-mismatch`, `ignored-locally` /
   `ignored-remotely`, and the local disk re-check. No filesystem, no network, no state — so the
   classification is testable without sockets.
2. **Fetch the peer index on demand** over the existing control channel with a
   `folder-index-request` / `folder-index-snapshot` pair, following the same request/response
   pattern as `self-binary-request` (`requestId` + pending map + timeout). The attach-time mirror
   was rejected for the reason above. If the peer is offline, does not answer within 20s (old
   version), or reports an error, the caller gets an **error** — never a degraded answer.
3. **The snapshot folds `blocks` into one digest per entry** (`contentDigest` = sha256 over the
   joined block hashes) and ships in chunks of ~2000 entries. A raw block list is one 64-character
   hash per 1MB, so entry size grows with file size and a few thousand large files would not fit a
   frame; the digest is a fixed 64 characters, and both sides compute it with the same function so
   it is directly comparable.
4. **The snapshot carries the peer's effective ignore lines for that folder, plus its current
   transfer progress.** The rules are what turn "the peer does not have it" into "the peer is not
   supposed to have it"; without them the report degrades to plain `remote-newer` and says so
   (`remoteRulesKnown: false`). Progress is what lets the report warn that the peer is mid-transfer
   and the snapshot may contain intermediate state.
5. **Read-only, end to end.** No scan, no index write, no version bump, nothing written to either
   disk. "Force a reconnect so both sides re-exchange a full index" was explicitly rejected: a
   diagnostic must not perturb the system it observes, or the user ends up looking at their own
   disturbance.
6. **`mtime` is displayed but never participates in any decision.** FAT/NTFS timestamp granularity
   and timezone differences generate mass false positives; the version vector plus the content
   digest are the only evidence used.
7. **Serving is gated exactly like a folder peer**: the folder must list the requester in
   `devices`, otherwise the peer answers with an error. Without that gate this diagnostic path
   would be an index-read entry point that bypasses the sharing relationship.
8. **Differences (normally tens of entries, not thousands) are re-checked against the local disk**
   with a single `stat`, so "our index is stale" is reported as such instead of as a difference.
   Paths that would resolve outside the shared root are skipped rather than reported as missing.

## Consequences

- Two entry points over one JSON shape: the folder card's 「对比」 button in the Web UI, and
  `syncx diff <folder-path> [--device <id>]`. The CLI exists because this kind of investigation is
  usually done over ssh — its output is quicker than a screenshot and lands in logs.
- The report is a list of conclusions rather than paths: every difference carries a category and,
  where applicable, the exact rule text that matched, whether the path is hard-ignored, and the
  disk re-check verdict.
- **`content-mismatch` is the headline signal and a healthy run must never produce one.** Because
  equal versions make both sides stand still, the condition is stable — which is what makes it
  both the most useful finding and a safe thing to assert in tests (diff, wait, diff again, same
  answer).
- Boundary: files only. The index does not record directories, so empty directories are out of
  scope.
- A peer that predates this feature produces a 20s timeout error, not a silent fallback. Chunk
  counts are validated against `MAX_SNAPSHOT_CHUNKS` and malformed or inconsistent declarations
  are dropped, with the timeout as the backstop so a bad message cannot pin memory.
- Two shutdown-hygiene fixes fell out of this work, both triggered by the new end-to-end tests:
  - `close()` marks the manager closed so the `close` events of the sockets it just terminated
    cannot schedule a fresh reconnect (first half of `test/session-shutdown.test.ts`). The same
    events also reject pending snapshot requests, so a diff in flight during shutdown fails fast
    instead of waiting for its timeout.
  - A closed manager now **drops inbound control messages** instead of processing them (second
    half of the same file). `terminate()` only tears down TCP; messages already queued in the event
    loop still reach the dispatcher, and by then the index stores are closed and the config lock is
    released. A `folder-sync-list` arriving after `close()` would run `pruneRevokedOffers` →
    `mutateConfig` and rewrite the config file — harmless-looking in production, but in a test
    whose temp directory has already been removed it spins for 5s on the config lock and then
    throws, which shows up as a randomly failing suite.
