# ADR-0012: Ignore rules gate the inbound index too (ignore means isolation)

## Status

Accepted. Supersedes the "user ignore only blocks outbound" behaviour documented in
ADR-0008 §"user-level rules" and in the FAQ.

## Context

User ignore rules (`.gitignore` + `.syncxignore`) used to affect the **outbound** side only:

- `scanFolder` prunes ignored directories before recursing, so local changes under an
  ignored path never become a change, a version bump, a broadcast or a history record;
- `filterIndexedEntries` drops ignored **live** entries from the in-memory index (tombstones
  are deliberately kept).

The inbound gate in `peer.onPeerIndex` only checked `isHardIgnored(HARD_IGNORE_NAMES)`. So a
peer could still push an ignored path at us and we would happily apply it.

Observed on 2026-09-16 in `/Users/11048490/shared/mo`:

| time | event |
|---|---|
| 22:31:08 | local add of `.workbuddy/memory/2026-09-16.md` — the rule did not exist yet, so it was pushed and stored in the peer's index |
| 22:37:13 | local `.gitignore` gained `.workbuddy/` — the next scan round stopped pushing it |
| 22:40:05 | the local daemon restarted (self-update) → sessions re-attached → both sides exchanged **full** indexes; the peer still declared that path, the local in-memory index had filtered it out, so `buildPlan` concluded "remote has it, local does not" = `remote-newer` → **pulled it back and overwrote the local file**, plus a 「对端 新增」 history record |

The pull is not merely noisy. Ignored paths are no longer scanned, so local edits to them are in
no index and nothing protects them; and `completeIfReady`'s cold-start guard
(`preserveLocalAsConflict`) is **deliberately skipped** for ignored paths ("忽略规则命中的文件不
保护"), so the overwrite leaves **no conflict copy**. The same applies to the six `.idea/*` files
whose peer-side snapshot was frozen at 22:11 — every restart would roll the IDE's `workspace.xml`
back.

Two details are worth recording because they shaped the fix:

- **The trigger is a restart, not a reconnect.** `localIndex` is rebuilt only in
  `createFolderState`, `refreshFolderIgnoreRules` and on a folder path change. A plain reconnect
  keeps the map, and a received entry is written back into it (`localIndex.set`), so the event
  appears once per restart rather than once per reconnect.
- **Adding a rule never cleans either side's index.** Only hard ignore runs `removeEntry`. Both
  indexes keep the row, so the peer keeps declaring it and we keep meeting the same condition.

An equally important trap: `SyncPeerDeps.ignoreLines` was a **snapshot** taken when the session
was attached, while `scanOnce` re-reads the rule files and replaces `folder.ignoreLines` wholesale
every round. With that snapshot, a freshly ignored path would take effect outbound within one scan
round but inbound only after a reconnect — the same rule behaving differently in the two directions
depending on timing.

## Decision

1. **`peer.onPeerIndex` drops entries matching the local ignore rules — live entries *and*
   tombstones — before planning**, exactly like hard-ignored ones. An ignored path therefore
   receives nothing: no create, no update, no delete, no history record, no block request.
2. **`ignoreLines: string[]` became `readIgnoreLines: () => string[]`.** The session manager hands
   over a getter (`() => folder.ignoreLines`) so the gate always sees the rules the scanner is
   using right now. Parsed rules are cached per array instance, so one index message parses them
   once instead of once per entry (a real `.gitignore` is over a hundred lines).
3. **Hard ignore stays in front and stays stronger.** It is checked first and cannot be undone by
   `!` negation; the user-rule branch is a silent drop with no callback, because dropping ignored
   paths is the normal steady state — unlike a hard-ignore hit, which is logged as a warning
   (it can only happen when the peer is old or has negated the builtin rules).

## Consequences

- Ignoring a path now means "this device does not touch it", in both directions. For ignored paths
  the two devices diverge quietly: the peer keeps whatever it has, and neither side's later edits
  or deletions reach the other.
- One earlier semantic is reversed and should be named explicitly: a **stored tombstone** for a
  path deleted *before* the rule was added is still propagated outbound (`filterIndexedEntries`
  keeps user-ignored tombstones, so the peer follows our deletion), but an **inbound** tombstone
  for an ignored path is now dropped — the peer deleting an ignored file no longer deletes ours.
  That asymmetry is intentional: our own unfinished deletion should still complete, while the
  peer's view must not reach in.
- Index rows for ignored paths are still **not** cleaned, so `countEntries()` (the "索引条目 N"
  figure) keeps counting them and can exceed the number of entries that actually sync. Cleaning
  them means removing and re-adding the folder with the index purge, on **both** sides — a peer
  that still holds the row keeps declaring it, and we now drop it every time instead of applying it.
- Regression tests: `test/peer.test.ts` (an ignored path is left completely alone, live entry and
  tombstone alike; rules are re-read per message rather than snapshotted) and
  `test/integration/two-devices.test.ts` (over a real socket, a peer change for an ignored path is
  never applied). Both fail against the previous behaviour.
