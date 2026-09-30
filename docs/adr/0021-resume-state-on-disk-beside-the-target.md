# ADR-0021: Resume state is a pair of files beside the target, not a buffer in the peer

## Status

Accepted. Stage 2 of the 断点续传 plan. It follows stage 1a (per-block landing, commit `0a3a575`) and
ADR-0020 (send window), and it **supersedes** the "the receiver is still O(file)" consequence of
ADR-0020.

## Context

Stage 1a had taken the whole-file `Buffer.concat` out of the landing (`writeFileSync(tmp,
Buffer.concat(blocks))` → `openSync` + per-block `writeSync` + `fsync` + rename), but the receive path
still *held* every block: `PendingEntry.blocks` was a `Buffer[]` accumulating the whole file until the
last one turned up, and only then was any of it written to disk. So the receiver's memory peak was
still the file size — measured on 2026-09-30 with `bench/rss-bench.mjs` (two real daemons over
loopback, in-process RSS sampler): 1.34GB RSS for a 600MB file, 1.98GB for 1.2GB.

The same buffer produced a second, more visible defect: nothing survived an interruption. A daemon
restart, a crash, or a reconnect mid-transfer dropped every block received so far — the user-facing
symptom was a large file starting over from zero after each blip, and the FAQ said so plainly
("不会。已收块只缓冲在内存").

Both problems were the same one: the answer to "which bytes do I already have?" lived in process
memory. Deciding to move it to disk has consequences for crash safety, for the ignore semantics of
every shared folder, and for what a `rename` is allowed to mean — hence this record.

## Decision

**1. `ReceiveHandle` is the only landing channel on the receive path** (`src/executor.ts`). The
peer plans a file, calls `beginReceive`, and hands each arriving block straight to `append(index,
data)`; slot offsets are computed once, up front, from the entry (`clens` prefix sums under CDC,
`i * BLOCK_SIZE` under the fixed view), so blocks land at their final positions in
`<target>.syncx-tmp` **in any arrival order** and the rename that completes the file moves no bytes.
The old entry point (`applyReceive(entry, provider)`, whose caller had to assemble the block array
first) is deleted rather than deprecated: while it exists, re-introducing O(file) is one refactor
away, and it is the kind of refactor that looks like an improvement.

**2. "Which slots are durable" lives in a sidecar** — `<target>.syncx-partial`, a JSON manifest
carrying `{v, fingerprint, cdc, slots, bitmap, startedAt, updatedAt}` with the bitmap as base64.
Not a header inside the tmp: the tmp's content must *be* the final file bytes, because rename is the
whole landing and any second pass over it would reintroduce the reassembly this stage removes. The
two files are created and destroyed as a pair (`partialPaths` / `removePartial`).

**3. The fingerprint is a statement about content only** — `size + blocks + cdh + clens`
(`entryFingerprint`), deliberately excluding `version`, `mtime` and `path`. Resume asks "are the
bytes I already have a correct description of *this content*?", and version says nothing about byte
layout: a peer that reverts a file to identical bytes should be resumed, not restarted. `path` is
carried by the file name. Conversely any content change — even one block — flips the fingerprint and
the entire pair is voided. **宁可重传,不可错接**: re-transferring is a cost, splicing old bytes into
new content is a corruption.

**4. Commit order is the correctness guarantee: `fsyncSync(fd)` then `writeManifest`, never the
reverse**, every `PARTIAL_COMMIT_SLOTS` = 8 slots or when the bitmap becomes full
(`commit`, `src/executor.ts`). A set bit therefore means *durable* bytes. Inverted, a crash leaves a
manifest claiming a hole is a good block — and the resume self-check below only catches that by
accident (it reads back and hashes, so it does; but then the manifest has stopped being the thing we
rely on, and the ordering is cheap). Eight is a trade: one fsync per block would measurably slow
large files, a larger group loses more re-transfer on crash.

**5. Resume verifies rather than trusts.** `beginReceive` reads the old manifest, then re-reads and
hash-checks every slot the bitmap claims, clearing bits that fail (half-written block, another
process touching the tmp) so they are simply re-requested (`beginReceive`'s self-verify, `src/executor.ts`). Reading the
disk twice for those slots is a cost paid once per resume, and it is what buys the right to trust the
bitmap for the other 99%.

**6. `beginReceive` touches no disk until the first block arrives** (`ensureFd`, `src/executor.ts`).
A planned-then-abandoned receive — on-demand placeholder, both-sides
tombstone, path rejected by the executor's own guards — would otherwise leave an empty tmp in the
user's folder that nobody owns. When the fd is finally opened it is `'r+'` if the bitmap claims
content and `'w'` otherwise: `'w'` on a resumable tmp truncates the resume itself.

**7. The final gate is on-disk and layout-agnostic**: `blocksMatchOnDisk(tmp, entry.blocks)` before
rename (streaming, early-exit — `blocksMatchOnDisk`, `src/blockstore.ts`). Because the fixed block view is the
correctness backbone that both layouts agree on (re-chunking CDC bytes yields the same `blocks`),
the terminal check does not need to know which layout produced them. This is the assertion that
makes `Buffer.concat` unnecessary rather than merely discouraged.

**8. The pair is invisible to synchronization in *both* directions** — `.syncx-tmp` /
`.syncx-partial` are folded into `isHardIgnored` by suffix (`SCRATCH_SUFFIXES`, `src/ignore.ts`),
not added to the builtin ignore lines. A builtin line is a *rule*, and rules can be negated: one
`!.syncx-tmp` in a user's `.syncxignore` would put in-flight bytes back on the wire, and a peer
could push `x.syncx-tmp` at us as an ordinary file. Hard ignore is not negotiable, which is exactly
the property wanted. Accepted cost: a real user file whose name ends in either suffix no longer
syncs, on any device.

**9. Only the peer declaring a deletion may void the pair** (`abort(false)` in `abortPending`).
Connection teardown, a stale plan, the disk guard, block-retry exhaustion — all of them keep it
(`abort(true)`), because all of them are situations where continuing is still possible.

**10. A 7-day TTL sweeper, run by the scanner** (`PARTIAL_TTL_MS`, `pruneScratchFile`). Some aborts
are "the peer cannot supply these blocks at all" — the 2026-09-22 incident where an editor's tmp
file got indexed and then renamed away. Such a partial will never be resumed *and* will never be
announced, so nothing would ever collect it: without a sweeper the user's shared folder accumulates
unowned multi-gigabyte files. It keys on the tmp's own mtime (each block updates it; 7 days of
silence means nobody is coming back) and removes the whole pair, including orphan tmps that never
had a manifest.

### Rejected

- **Persist the bitmap in the index DB / one central scratch dir.** The pair must travel with its
  target: the tmp is where the bytes are, and a state store that outlives a moved or manually cleaned
  folder is a lie about what is on disk.
- **Resume by file size, no bitmap.** Blocks arrive out of order, so a correct-looking size can hide
  a hole in the middle; the only repair would be to re-hash the whole file and re-plan, which is the
  traffic this stage exists to avoid.
- **Keep the block buffer and flush it on abort.** The abort paths that matter most are the ones
  where no code runs (crash, `SIGKILL`, power loss), and the residency is the peak being removed.
- **Bind the fingerprint to the version vector.** Cuts the revert-to-identical-content resume, gains
  nothing, and couples a byte-layout question to sync metadata.

## Consequences

- **Measured end-to-end** with `bench/rss-bench.mjs` (loopback, two real daemons, in-process RSS
  sampling, one build):

  | file | receiver RSS peak, before (stage 1a) | after (stage 2) | sender peak | outcome |
  |---|---|---|---|---|
  | 600MB | 1.34GB | **0.64GB** | 0.68GB | converged, sha256 matched |
  | 1.2GB | 1.98GB | **1.16GB** | 1.03GB | converged, sha256 matched |
  | 2.4GB | — | **1.26GB** | 1.06GB | converged, sha256 matched |

  The 1.2GB → 2.4GB pair is the shape that matters: doubling the file moves the receiver by
  ~0.1GB, where before stage 2 a 1.2GB file alone cost 1.98GB. 2.4GB is also past the point where the
  old `PendingEntry.blocks` residency plus baseline would have needed >2.4GB live.
- **RSS is still not the live set, and this ADR does not claim it is.** The 600MB → 1.2GB step really
  did rise (0.64 → 1.16GB): per-block allocation churn (decrypt → verify → `writeSync`) plus the
  post-landing index pass over the new file push V8's high-water mark up, and RSS never returns that
  to the OS. Same caveat ADR-0020 recorded for the sender. The live set is pinned **structurally**,
  not by the bench:
  - `test/receive-shape.test.ts` asserts `src/peer.ts` contains no `Buffer.concat(` and no
    `blocks: Buffer[]` field, that `PendingEntry` carries `handle: ReceiveHandle`, and that
    `src/executor.ts` has no `applyReceive` and does use the 5-argument random-write `writeSync`;
  - the 192MB landing case in `test/executor.test.ts` drives a large entry through
    `beginReceive` / `append` × N / `finalizeReceive` with **one reused 1MB buffer** and a patched
    `Buffer.concat` recording the largest concatenation, asserting it stays under 50% of the file size.
- **Cross-process resume is proven at the executor seam, not against a running daemon.** Each case in
  `test/resume.test.ts` builds a *brand-new* `createLocalExecutor` over the same directory — the disk
  is the only thing carried across, which is exactly what a restart is. `test/peer.test.ts` covers the
  pipeline half: after `releaseClaims()` the pair is still on disk with the two committed slots, the
  reconnected peer requests **only** the missing one, and a peer-declared deletion during flight takes
  the whole pair with it. A real two-daemon kill-mid-transfer test has *not* been run.
- **The disk guard now over-counts a resumed round.** The pre-plan estimate in `src/peer.ts`
  (`needed = incoming.size − current.size`) does not subtract what the in-flight tmp already holds, so
  a resume asks for more free space than it will use and can be deferred a round longer than
  necessary. Safe direction (the guard delays, never corrupts); left as a known imprecision.
- **`writeLocalFile`'s own tmp had to move off the name.** It used to be `<abs>.syncx-tmp`; that name
  is now the resume carrier, so reusing it would truncate another pipeline's progress *and* steal its
  rename target. It writes `<abs>.<stamp36>.syncx-tmp` now (`writeLocalFile`, `src/session-manager.ts`) — same
  suffix, so the scanner still skips it and the TTL sweeper still reaps it.
- **The git auto-commit had to learn about the pair.** Before stage 2 a `.syncx-tmp` existed for the
  milliseconds between "last block arrived" and the rename, so `git add -A` (the receiving folder's
  auto-commit, `autoCommit` in `src/git-monitor.ts`) could practically never see one. Now it lives beside the
  target for the whole transfer, and auto-commits are triggered by *other* files landing — meaning a
  half-written several-hundred-MB file could be committed into the user's history and then mirrored to
  peers by the git-commit chain. Both `autoCommit`'s staging and `hasUncommittedChanges`'s probe now
  pass `:(exclude)*.syncx-tmp` / `:(exclude)*.syncx-partial`. Verified semantics before adopting: a
  negative-only pathspec does **not** narrow `git add -A` to the cwd subtree (run from a subdirectory
  it still staged a file outside it), and `*` in a pathspec crosses `/`, so any depth is covered. The
  probe needed the same exclusion or a worktree holding nothing but an in-flight pair would count as
  "changes pending" and produce an empty commit broadcast for a scratch file. `git status` still
  reports the pair as untracked during a transfer — that is unavoidable while the files are in the
  folder, and is the one place syncx no longer keeps a git worktree pristine.
- **Two pipelines can briefly share one tmp path.** The receive claim TTL is 5 minutes
  (`RECEIVE_CLAIM_TTL_MS`) while the block-retry budget is ~10 (`MAX_BLOCK_RETRIES_TOTAL` = 23), so a
  second connection can plan the same version while the first is still limping. Not a correctness
  problem — offsets are deterministic for a given fingerprint, `append` is idempotent per slot
  (`append`, `src/executor.ts`), and the terminal gate is `blocksMatchOnDisk` — but the loser's bytes are
  wasted traffic.
- **Crash cost is bounded and explicit**: at most the slots written since the last commit (≤ 8) are
  re-sent, because the bitmap never claimed them.
- **`durationMs` in the sync record under-reports a resumed file.** It is measured from this round's
  planning moment (`PendingEntry.startedAt`), so a file that took two rounds reports only the second
  one. Chosen over folding in a `startedAt` from a round that may predate a restart by days.
- **Windows is why every terminal path closes the fd first.** `releaseClaims()` calls `abort(true)`
  per pending item specifically so no handle keeps a tmp open — Windows can rename or delete neither.
- **Empty files never create a tmp.** Zero slots means a trivially full bitmap; `finalize` opens the
  file only to rename an empty one.
- **No wire change.** The manifest is purely local, so nothing new is announced and mixed-version
  fleets (ADR-0018) are unaffected in either direction.
- **The user-visible trade is the naming rule** (point 8): files ending in `.syncx-tmp` /
  `.syncx-partial` do not sync, in either direction. If that ever has to be revisited, the replacement
  must keep "a negating ignore rule cannot reopen this" — otherwise this ADR's reason for existing is
  reintroduced as a bug.
