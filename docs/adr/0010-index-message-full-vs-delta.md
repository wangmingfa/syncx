# ADR-0010: Index messages are full or delta, and "sending" is a lease

## Status

Accepted.

## Context

On 2026-09-16 both devices' folder cards sat at "传输中 · 发送 19 / 发送 246"
indefinitely, with no transfer in flight. Device A's daemon was burning ~52% of
a core. Nothing was written to any sync history, no error was logged, and no file
was missing — the local index and the disk agreed exactly (265 files, 265
entries, 0 tombstones).

The two counts were the giveaway: **19 + 246 = 265**. Each side was pushing
"every entry the other side's message did not mention".

Two independent defects combined:

1. **One message type carried two meanings.** `broadcastFolderUpdates` sends
   *only the entries the local scan just changed* (a delta), while
   `attachFolderToSession` sends *the whole local index* (a snapshot). Both went
   out as the same `{ type: 'index', payload }` frame, and
   `peer.onPeerIndex` planned with `buildPlan`, whose semantics are a **union**:
   for every path in `local ∪ remote`, act. With a delta message, "local has it,
   the message doesn't mention it" is read as "the peer lacks it" → `send`.
   The peer then does the same with the entries we just left out:

   ```
   A scans 19 changed entries → broadcasts 19
     → B plans: only 19 mentioned, so the other 246 are "missing on A" → sends 246
        → A plans: only 246 mentioned, so the other 19 are "missing on B" → sends 19
           → B sends 246 … forever
   ```

   Every round compares *equal* versions, so no file is ever written, no history
   is recorded, nothing is logged: a silent ping-pong at tens of thousands of
   index frames per second. Any single local change lights it (a full exchange at
   connect time does not, which is why it appeared only after edits).

2. **`sending` had no decay path.** `pendingSendCount` was set to the number of
   entries the last round planned to send and only recomputed when the *next*
   peer index arrived. With the loop above, that number was never small; but the
   counter is sticky on its own, and one real-daemon run shows this precisely:
   with the union reading forced, A's status sat at
   `{pending: 0, sending: 1, receiving: 0}` unchanged for the whole observation
   window while B reported nothing at all. One planned reply pins the card
   forever — the loop makes it worse, it is not required.

## Decision

**The `index` frame carries its own semantics, and progress is derived from
observable work rather than from a sticky counter.**

1. `{ type: 'index', folder, payload, full }`. `full: true` means "this is my
   complete index"; absent means "these are the paths that changed".
2. `peer.onPeerIndex(entries, opts)`:
   - `full` → `buildPlan` (union): "the peer lacks this" is a real conclusion,
     which is what makes the initial exchange converge.
   - otherwise → `buildDeltaPlan` (restricted to the paths the message actually
     mentions). "Not mentioned" is not evidence of absence.
3. **An absent flag means delta** (old peers do not send it, and they *do* send
   deltas). This is deliberately the conservative direction: misreading a full
   index as a delta loses at most one push-back opportunity, and both sides send
   their full index when a session is established anyway, so convergence is
   unaffected. Misreading a delta as full re-creates the loop. As a bonus, the
   loop also stops against a peer running the old version: it still echoes, but
   we never echo back, so the ping-pong dies after one round.
4. **In-flight state is only discarded on full rounds.** Clearing `pending`
   (in-flight receives) and the block-request retry timers on every index message
   is what the union reading implied; under delta semantics it would decapitate
   downloads that the message simply did not mention, and nothing would ever
   re-plan them. A delta that *does* mention a path as a tombstone aborts that
   path's in-flight receive explicitly (otherwise a late block response
   resurrects a file the peer just deleted).
5. **`sending` is a 15 s lease over "paths I actually served blocks for".**
   `onBlockRequest` renews the lease for that path; `getSyncProgress` counts the
   unexpired ones and drops the rest. The definition is "files the peer is
   currently pulling from me", which is what the card claims, and it decays on
   its own with no external event needed. Planned replies add nothing: an entry
   push is metadata, and if no blocks are requested there is nothing to transfer.
   The lease window is safely above `BLOCK_REQUEST_TIMEOUT_MS` (5 s), so a slow
   link (and the retry that follows a timeout) always renews before it expires.

## Consequences

- 2026-09-16's shape cannot recur: a delta can only ever reconcile the paths it
  names, so a reply can only ever be about those paths. Two devices with disjoint
  sets of files settle after one round each. The regression test counts index
  frames on both sides and asserts they stop growing (the bug produced ~22 000
  frames in 400 ms).
- Mixed-version deployments degrade instead of looping: an old peer's deltas are
  treated as deltas here, so its echo is ignored rather than amplified.
- `buildPlan` and `buildDeltaPlan` share `planPath`, so the per-path decision
  table exists once. Callers that plan must now be explicit about which of the
  two they mean, which is the point.
- Progress no longer needs a "did the peer send anything lately?" input, and the
  card returns to 已同步 without user action.
