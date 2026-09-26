# ADR-0017: Content-defined chunking (CDC) as a purely additive block view

## Status

Accepted. Supersedes the fixed-block-only assumption in ADR-0003; the fixed
1MB layout remains as the fallback and as what every legacy peer still sees.

## Context

ADR-0003 pinned the transfer unit to fixed 1MB blocks: a mid-file insertion
shifts every downstream block boundary, so all subsequent hashes mismatch and
the receiver re-pulls roughly the whole tail even though one byte changed.
That is the dominant waste for the "large file, small edit" case (VM images,
databases, archives) that users actually complain about.

The ROADMAP's in-block-delta research (2026-09) deferred a delta engine and
listed its restart condition as "when the block format upgrades to variable /
content-defined chunking (CDC) — CDC absorbs most of delta's benefit". This
ADR implements that upgrade.

Two hard constraints shaped the design:

1. **No capability negotiation exists.** The hello exchange carries a version
   string (and `dev` builds are unorderable), so there is no channel in which
   "do you speak CDC?" could be asked. Any format change must be invisible to
   peers that do not implement it.
2. **Correctness must not depend on the layout.** Blocks are addressed by
   SHA-256 content hash and verified per block on landing; the plan-to-land
   pipeline (`plan.ts`, executor landing, `landRemote`) must keep working
   unchanged no matter which layout produced the bytes on the wire.

## Decision

**Index entries carry a second, additive chunk view alongside the legacy one.**
`IndexEntry` gains optional `cdh: string[]` (chunk hashes) and `clens: number[]`
(chunk lengths; offsets are prefix sums). `blocks` stays exactly as before.
Chunking is content-defined via a 32-bit rotating-window Buzhash over a frozen
256-entry table (mulberry32 seed `0x9e3779b9`, permanently fixed — changing it
is a protocol change), with boundaries at `fp & (2²⁰−1) == 0` once ≥256KiB has
accumulated, forced at 4MiB. Average chunk ≈1MB, matching the old block size.

**Compatibility comes from announce-gating, not negotiation.** Old peers drop
unknown fields when mapping `WireEntry` (explicit field lists), never announce
`cdh`, and never set `cdc` on requests. Therefore:

- The receive planner (`planCdc` in `peer.ts`) only picks the CDC layout when
  the *remote* entry carries a usable `cdh` **and** the *local* entry (present,
  not a tombstone, not a placeholder) carries one too **and** a local chunk
  reader is wired. Any leg missing → fixed layout, i.e. exactly the old
  behavior. Against an old peer this path can never fire, because they never
  announce `cdh`.
- `BlockRequest`/`BlockResponse` gain an optional `cdc` flag: the responder
  serves chunk *i* by prefix-summing its own `clens` and echoes `cdc` back; a
  responder without a usable CDC view simply ignores a `cdc` request (the
  requester's retry then falls back via a fresh plan). The `cdc` flag is not
  echoed into legacy-shaped responses.
- The E2E-encrypted path is unaffected: blind views (`toBlindEntries`) build
  fresh objects that structurally exclude `cdh`/`clens`, and `serveE2EBlock`
  ignores `cdc` requests.

**Prefill matches by hash-set membership, not by index.** On a CDC receive we
re-chunk the local file, and any local chunk whose hash appears in the remote
`cdh` set is read from disk and skipped over the wire (first occurrence wins).
This also covers mild boundary skew: chunks that shifted position but kept
content still transfer zero bytes.

**Landing stays layout-agnostic.** The provider concatenates received chunks
and re-splits them into the fixed 1MB layout, so the executor, the blocks
stored in the index, and every other consumer see the same shapes as before.
A late or mispositioned response can only fail its per-block hash gate — it
cannot corrupt content.

## Consequences

- Measured (integration test `test/integration/cdc-transfer.test.ts`): a 10KiB
  insert into a 6MiB file transfers ≈0.6–1.3MB of block payload instead of
  ≈6MB — one chunk over the wire, verified against the traffic ledger
  (`/api/status.traffic`) between two real daemons.
- Skew is an *efficiency* concern only. A worst-case insert can repaint at most
  two chunk boundaries; per-chunk verification keeps correctness independent
  of layout agreement.
- Mixed-version fleets degrade silently to the old behavior — no flag day, no
  upgrade ordering. The cost is doubled index storage for changed files
  (`blocks` + `cdh`/`clens`), which is negligible next to the file itself.
- Tombstones and empty files carry no CDC view; placeholder (on-demand) entries
  never materialize via CDC, since there is no old local content to compare.
- In-block delta's remaining benefit shrinks to "several small edits inside
  one variable-size chunk"; the ROADMAP entry was updated accordingly.
- A rotating Buzhash window was chosen over accumulating Gear deliberately:
  with an accumulating fingerprint, inserting bytes permanently shifts every
  downstream boundary (the classic gear failure mode), while a 32-byte window
  expires each byte's influence and re-syncs boundaries almost immediately.
