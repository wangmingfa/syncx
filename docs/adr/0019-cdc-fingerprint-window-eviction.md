# ADR-0019: The CDC fingerprint carries a window-eviction term (corrects ADR-0017)

## Status

Accepted. Amends ADR-0017: the property its last consequence bullet asserted ("a 32-byte window
expires each byte's influence and re-syncs boundaries almost immediately") was **the design
intent, not what the code did**. The fingerprint had no eviction term, so the property did not
hold, and the bullet — plus the `chunkContent` comment and README's feature line — described
behaviour that never existed. This ADR records the defect, the fix, and the protocol consequence.

Data was never wrong. The cost of the defect was purely bandwidth, which is why it survived.

## Context

ADR-0017 replaced fixed 1MB blocks with a content-defined layout so that a mid-file edit repaints
one chunk instead of the whole tail. The rolling fingerprint in `src/blockstore.ts` was:

```
fp = rot1(fp) ^ GEAR[b]
```

That is Buzhash's *shape* without Buzhash's defining term. A correct sliding-window Buzhash is

```
fp = rot1(fp) ^ GEAR[in] ^ rot^W(GEAR[out])
```

where `out` is the byte that entered the window `W` steps ago and is now leaving (`src/blockstore.ts`
now documents the derivation). Without the removal term nothing ever leaves: `rot^32` on a 32-bit
value is the identity, so the difference a small edit introduces keeps rotating forever at full
strength. Boundary decisions read only the low 20 bits, so "re-sync" degenerated into "after the
difference has rotated a few times, do its low 20 bits happen to be zero" — a function of *how many
bytes were inserted*, not of locality in the content.

Measured before the fix (4MiB pseudo-random file, edit at offset 1MiB+512, intersect chunk hash
sets, four seeds): a 1-byte in-place overwrite and a 7-byte insert repainted **every downstream
chunk** — 0 reused. From about a 512-byte insert the rotation occasionally landed back on a
boundary and it started working by luck; the 10KiB insert used by the integration test happened to
be one of those cases, which is precisely why the test suite was green.

Three independent statements in the repo asserted the opposite of the measurements, and the test
that looked like proof (`test/integration/cdc-transfer.test.ts`) asserted a loose byte budget
("<2MB for a 6MB file") rather than a derived expectation, so it could not see the difference
between "CDC works" and "CDC worked this time".

## Decision

**1. Add the eviction term, keeping everything else frozen.** Window stays 32 bytes, so the removal
term is `GEAR[out]` unrotated; the table, its seed, the mask (`2^20−1`), `CDC_MIN_CHUNK` and
`CDC_MAX_CHUNK` are unchanged. The fingerprint remains a pure function of the byte sequence and
boundary detection still does not reset per chunk.

**2. One implementation of the recurrence, shared by both scanners.** A `RollingFingerprint` class
owns the folding — `chunkContent` (in-memory) and `hashFileViews` (streaming, 1MB read windows)
both call it. Previously the same line was duplicated in both loops, and the streaming side would
have needed a hand-rolled 32-byte carry across every window boundary to stay equivalent. The
duplicated form fails silently and catastrophically: a chunk hash that disagrees with the file's
content makes every per-chunk verification on the receiver fail, i.e. "this file never finishes
syncing" with no error anywhere. Sharing one implementation removes that class of bug instead of
testing for it.

Cost: none measurable. The shared version does strictly *more* work per byte (ring read, ring
write, one call) and measured faster: 64MiB scan, three alternating rounds, order-swapped —
289ms (64 chunks) vs 432ms (48 chunks) for the previous inline form.

**3. The test seam asserts behaviour, not equivalence.** `test/blockstore.test.ts`
「CDC 重同步局部性」 checks how many chunks a 1-byte overwrite / 7-byte insert repaints, at seven
offsets including one whose perturbation region straddles a read-window boundary. Equivalence
(streaming == in-memory) stays pinned separately, but it is a weaker claim: both implementations
can be wrong together, and that is exactly what had happened.

## Consequences

- **Every historical `cdh` is invalidated → one full retransmission per changed file.** Chunk
  boundaries move, so no old chunk hash appears in a new scan. ADR-0017 already classified changing
  the table or seed as a protocol change; the folding is the same class of thing and is now
  documented as frozen alongside them.
- **Nothing corrupts, and the fixed layout is unaffected.** `blocks` (the 1MB view) is unchanged,
  is still what legacy peers see, and remains the correctness backbone; blocks are verified per
  chunk on landing, so a layout disagreement can only cost bytes.
- **Mixed generations mismatch quietly, and there is no channel to detect it.** A new peer's
  `cdh` and an old peer's `cdh` for identical content share no element. `planCdc` only checks that
  both sides *have* a usable CDC view (`src/peer.ts:502`), so it will plan CDC and prefill nothing —
  transferring the whole file where the fixed layout might have skipped most of it. This is bounded
  and self-healing: the receiver stores the announced (new-generation) `cdh` when the file lands,
  and a file that never changes needs no transfer at all. The real mitigation already in place is
  the version consistency lock (ADR-0018); a "CDC layout generation" field was not added, because
  it would be new protocol surface to solve a cost that is one transfer per changed file.
- **Measured after the fix** (same fixtures as above): 1-byte overwrite, 7B / 512B / 10KiB insert
  and 4KiB append each repaint exactly **1** chunk out of 3–6, across all four seeds; on an 8MiB
  file at seven offsets, 1 of 11. The 32-byte perturbation region can still shift one boundary, so
  the tests bound it at ≤2 rather than claiming 1.
- **The integration test's budget is now derived, not tuned.** `test/integration/cdc-transfer.test.ts`
  inserts into the *shortest* chunk of the file, recomputes the expected missing bytes with
  `chunkContent`, and asserts the traffic ledger lands in `[expected, 2×expected]` (the doubling
  leaves room for one version-race replay). It also computes the fixed-layout cost of the same edit
  and asserts it is more than 4× the CDC figure, so "this proved a saving" is part of the assertion.
  Measured: 332,140 bytes over the wire for a 10KiB insert into a 6MiB file (fixed layout for the
  same edit: ~5.7MiB).
- **ADR-0017's last consequence bullet should be read as intent, not history.** It is annotated
  there; the implementation it described arrived only with this change.
