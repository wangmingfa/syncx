# ADR-0020: The sender bounds block responses by in-flight bytes, not by request count

## Status

Accepted. Implemented alongside ADR-0019 (2026-09-30). Complements, and does not replace, the
receiver-side per-chunk landing of stage 1a: that removed the whole-file `Buffer.concat` on the
*receive* path; this one bounds the *send* path, which had a ceiling of its own.

## Context

A receiver does not drip requests — it plans a file and fires **every** missing-block request at
once (`requestMissingBlocks` / `requestMissingChunks`, `src/peer.ts`). The sender answered each one
synchronously: read the block, encrypt it, base64 it, push the resulting string onto the folder's
outbox (`makePeerTransport`, `src/net/wire.ts`).

That outbox had no bound. Its drain rate is set by the link (and by the optional rate limiter,
which is absent unless the user configured `maxSendKbps`), while its fill rate is set by the peer.
So the sender's memory peak was a property of *how much the other side asked for* — i.e. the file
size, times ~1.34 for base64, since each queued item is a fully materialised JSON string. Measured
on 2026-09-30 with `bench/rss-bench.mjs` (two real daemons over loopback, in-process RSS sampler):
a 300MB file put the sending daemon at 1.61GB RSS, and a 2.2GB file killed it with a V8 heap OOM at
the 8GB limit that the bench raises specifically so regressions show up as a visible peak rather
than as a crashed process.

Nothing on the wire was wrong, and no error was reported: the transfer simply died partway.

## Decision

**1. Bound the sender by bytes in flight, measured at the transport.** `makePeerTransport` now
counts the bytes it has queued (`outboxBytes`, decremented in a `try/finally` around `socket.send` —
a leaked count would close the window forever, which is worse than the OOM because it looks like a
hang), and reports `pendingOutboundBytes() = outboxBytes + socket.bufferedAmount`. The
`bufferedAmount` term matters: handing bytes to the socket is not the same as them leaving the
machine, and `ws` reports the underlying writable length for exactly this purpose. Both members are
**optional** on `PeerTransport`, so a transport that cannot see its buffer (test fakes) simply does
not have a window — the gate must never turn "unknown" into "full".

**2. The gate sits in front of the disk read, at `SEND_WINDOW_BYTES` = 64MB.** A block request whose
response would not fit is *deferred*: only its metadata goes on a FIFO (`deferredQueue`, keyed by
the same `blockKey` the retry ledger uses, capped at `DEFERRED_MAX` = 4096), and nothing is read or
encrypted until it is replayed. Requests flagged `priority` (`优先同步`) are unshifted, so a
user-named small file still overtakes a queue of chunks belonging to a large one. When the window
drops below the size of the head's block, `pumpDeferred()` replays it by calling the same
`handleBlockRequest(request, { fromPump })` that the wire path calls — one code path, so replayed
requests re-run every guard (share-root escape, index bounds, tombstones) against *current* state
and cannot smuggle a stale block. Both supply paths are gated: plain (`onBlockRequest`) and
end-to-end (`serveE2EBlock`), and `wrapTransportBlind` forwards the two new members so an encrypted
share keeps its window instead of silently losing it to the wrapper.

The size estimate never reads the file: the block length is already in the index (`clens[i]` for
CDC, `size − i·BLOCK_SIZE` for the tail of the fixed view), and the estimate over-counts on purpose
(plaintext + tag → base64 → envelope) — over-estimating costs one round of deferral, under-estimating
would defeat the window.

**3. Wake-up is event-driven with a polling backstop.** `onOutboundSpace(cb)` fires from the drain
loop after each send, and while bytes are still outstanding a 100ms `unref`'d interval nudges it too
— `ws` exposes no drain signal for the socket, and without the poll the deferred queue could only
advance when the *peer* happened to ask again (every 5s), which turns a bounded window into a
throughput cliff. The peer coalesces wake-ups with `queueMicrotask` rather than pumping on the send
stack: pumping there would put a whole window's worth of read + encrypt + base64 inside one drain
iteration, delaying the socket for hundreds of milliseconds and gaining nothing.

**4. Rejected: drop the request when busy.** Silently ignoring a request is the same visible result
(no response), and the requester's patience is finite: 3 fast retries at 5s, then 30s intervals, up
to `MAX_BLOCK_RETRIES_TOTAL` = 23 ≈ 10 minutes, after which `dropIfUnservable` abandons the whole
entry. A drop-on-busy sender therefore caps throughput at `window / retry-interval` and, on a slow
link, eventually *loses* the file: 23 rounds × 64MB ≈ 1.5GB of headroom, against a 2.2GB file that
already OOM'd. Deferring keeps the byte budget and the correctness of "the peer will get an answer".

**5. Rejected: make the receiver rate-limit its own requests.** The receiver cannot fix this — from
its side the requests are cheap; the bytes are only expensive once the sender materialises them. And
a receiver-side window would still leave the sender unbounded against any *other* peer, or against a
malicious one asking for blocks of a file it has no business asking for.

**6. Not added: a per-socket (rather than per-folder) window.** One socket multiplexes every shared
folder, and each folder's transport sees the same `bufferedAmount`, so with N folders transferring
concurrently the true total is up to N × 64MB. Accepted deliberately: the number is bounded, the
folders are few, and a per-socket budget would have to be threaded through a layer (`peer.ts`) that
currently knows nothing about socket identity.

## Consequences

- **The bound itself is proved by a test, not by RSS.** `test/send-window.test.ts` drives the real
  `makePeerTransport` behind a fake socket whose `bufferedAmount` is released by hand: with the window
  at 8MB and 40 × 1MB blocks requested at once, the bytes sitting between the transport and the wire
  never exceed `window + one block's wire bytes` (asserted on the fake socket's own high-water
  `bufferedAmount`, which is the same quantity `pendingOutboundBytes()` reports), no more than that is
  read from disk, and all 40 blocks are still served eventually. Red/green both ways: raising the
  window to 4GB in the same harness fails three of the five cases (`expected 40 to be less than 20`,
  `expected 44 to be 39`).
- **Measured end-to-end** with `bench/rss-bench.mjs` (loopback, two real daemons, RSS peak from
  in-process sampling, `SYNCX_SEND_WINDOW_BYTES` used as the A/B switch on one build):

  | file | window | sender RSS peak | receiver RSS peak | outcome |
  |---|---|---|---|---|
  | 600MB | 1TiB (off) | **2.27GB** | 0.81GB | never converged in ~11 min; receiver logged 「gave up receiving big.bin … after block retries exhausted (432 block(s) never arrived)」 |
  | 600MB | 64MB | 0.96GB | 1.34GB | converged in ~2s |
  | 1.2GB | 64MB | 1.20GB | 1.98GB | converged, sha256 matched |
  | 1.2GB | 8MB / 64MB / 512MB | 1.07GB / 1.12GB / 1.70GB | — | the window is what moves the number |

  Before the fix the shape was O(file); after it, the transfer converges and the sender's peak stops
  scaling with the requests it accepted.
- **But the sender's RSS does not flatten at 64MB, and the ADR does not claim it does.** At 600MB the
  sender still sits near 0.9GB with the window at its default. Two reasons, both real: every served
  block allocates a fresh read buffer plus its base64 envelope, so the *allocation rate* — not the
  live set — pushes V8's heap high-water up; and RSS never goes back down after a GC, so the sampler
  reports the peak of a transient, not a retained set (the sender in these runs is still at its peak
  1.5s after the file landed, when the window's queue is provably empty). This is why the byte bound is
  asserted through `pendingOutboundBytes()` in the unit test rather than through RSS in the bench.
  Shrinking the RSS figure is a different change — reuse the per-block buffers on the send path — and
  is not part of this one.
- **The receiver is still O(file)** *(superseded by ADR-0021 — stage 2 landed 2026-09-30; kept here
  because it is why that change was scoped the way it was)*. `PendingEntry.blocks` holds every block
  that arrives before the
  file is complete — that is stage 2 (断点续传) territory and this change does not touch it. Bounding
  the sender does not make the pair constant-memory; it removes one of the two ceilings, and the one
  it removes is the one that killed the daemon *first* (the sender OOM'd before the receiver did).
- **Rate-limited senders now self-limit earlier.** With `maxSendKbps` configured, the outbox was
  already the queue that absorbed a burst; the window closes in front of it once the queue holds
  64MB. The observable difference is fewer wasted reads, not less throughput: the link still drains at
  the configured rate, and deferral releases the window as it drains.
- **A deferred request may be served against a changed file.** It is replayed through the same path
  as a fresh one, so it is answered from current index state; if the layout moved under it, the
  requester's per-block hash gate rejects the content exactly as it would for a response delayed by
  rate limiting. Deferral adds no new window of exposure — the pre-existing path could already sit on
  a queued string for minutes.
- **Beyond 4096 deferred requests the surplus is dropped** (treated as unanswered), and the peer's
  retry loop re-requests it. A 16GB file at 4MB chunks is ~4000 requests, so the cap only matters for
  files well past that, and only costs a retry round-trip — bounded, not a stall.
- **`peer.ts` gained its first timer-free but callback-driven control flow.** The peer now holds state
  (`deferredQueue`, `deferredKeys`, `pumpScheduled`) whose lifetime is the connection; nothing clears
  it explicitly on teardown, because the whole `SyncPeer` and its transport are dropped together. If
  a future change lets a peer outlive its transport, that assumption is the first thing to revisit.
- **The window is env-overridable** (`SYNCX_SEND_WINDOW_BYTES`) so `test/send-window.test.ts` can
  drive it with 1MB blocks instead of allocating 64MB of buffers to prove the same property.
