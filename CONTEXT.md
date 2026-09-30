# syncx Context

syncx is a peer-to-peer, LAN-focused file synchronization tool for an individual's own devices. Each running instance is a full peer; there is no central server.

## Language

**Device**:
A single running instance of syncx on one machine, identified by an Ed25519 keypair fingerprint.
_Avoid_: Node, client, server, peer (when meaning a specific machine)

**Device ID**:
A short, human-readable code derived from the device's public key fingerprint, used for pairing and display.
_Avoid_: node ID, token

**Shared Folder**:
A local directory that the user chooses to synchronize, tied to a set of approved devices.
_Avoid_: share, folder (alone), directory (when meaning the sync unit)

**Pairing**:
The two-way exchange of public keys by which two devices agree to trust each other before any synchronization happens.
_Avoid_: adding, connecting (without trust)

**mTLS Session**:
The encrypted, authenticated connection between two paired devices; all sync traffic flows through it.
_Avoid_: connection (alone), channel

**mDNS Discovery**:
Automatic detection of other syncx devices on the local network; manual pairing still works when discovery is unavailable.
_Avoid_: broadcast, auto-find

**Version Vector**:
The per-file conflict-detection metadata: one monotonically increasing counter per device that has modified the file. Concurrent edits yield non-comparable vectors, which is a conflict.
_Avoid_: timestamp, revision number (alone)

**Conflict Copy**:
A copy of a file preserved alongside the winning version when a conflict is detected, never silently discarding either side's edits.
_Avoid_: backup, duplicate

**Tombstone**:
A recorded deletion with its own version; prevents a deleted file from resurrecting on another device that edited it while offline.
_Avoid_: delete marker, ghost

**Drift**:
The state in which what a device believes about a file's bytes and what is actually true stop agreeing, while version vectors say the file is equal — the one inconsistency version comparison structurally cannot see (ADR-0022). A drift audit surfaces it by sampling and *reports only*: a finding is a fact to act on, never an automatic rewrite of either side. Two kinds of audit rounds look for it, split by where their evidence lives: a **peer round** compares our declarations against a peer's declarations, only at the moment that peer's index arrives (zero IO); a **local round** compares our own index against our own disk, on the scan clock, needing no peer at all. A peer round never produces a disk finding, a local round never a declared one.
_Avoid_: corruption (names a damaged file, not the disagreement — a local round's disk finding does involve damaged bytes, but its subject is still the index-vs-disk relation), desync (too vague — it also covers plain lag, which is not drift), checksum verification (that is the receiver's per-block gate at landing time, which is how drift gets ruled out rather than detected), self-heal / repair / resync (the deliberately rejected dispositions: when both versions are equal there is no evidence for a winner)

**Block**:
A fixed-size chunk of a file identified by a content hash; only changed blocks are transferred during incremental sync.
_Avoid_: chunk (that word names the content-defined unit below), part, segment

**Chunk**:
A variable-length, content-defined unit of a file, announced alongside the fixed block view as `cdh`/`clens` (ADR-0017). Its boundaries come from a rolling fingerprint that carries a *window-eviction term*, which is what makes an edit repaint only the chunk containing it (ADR-0019) — drop that term and the content-defined property is gone while everything still looks correct.
_Avoid_: variable block, smart block, slice

**Send Window**:
The cap on how many bytes the sender of a block response may have queued-but-not-yet-flushed (`src/peer.ts` SEND_WINDOW_BYTES). A block request that would exceed it is *deferred* as metadata and replayed when the link drains, so the sender's memory peak is a property of this window rather than of how many blocks the peer asks for at once (ADR-0020).
_Avoid_: backpressure (too vague — it names the effect, not the mechanism), throttle (that word belongs to the rate limiter, which shapes speed and does not bound memory), drop-on-busy (the rejected alternative: silently ignoring a request turns a slow link into a 10-minute timeout race)

**Resume Pair**:
The two files one in-flight receive leaves beside its target — the bytes gathered so far, and the record of which of them are already durable. They appear and disappear together, are invisible to synchronization in both directions, and are what turns an interruption (disconnect, restart, crash) into a pause instead of a restart.
_Avoid_: temp file (names only the content half, and reads as "safe to delete"), partial download, scratch file (that is the wider class — every resume pair is scratch, but not every in-flight file is resumable)

**Ignore Rule**:
A pattern (gitignore-style) that excludes files or directories from synchronization within a shared folder.
_Avoid_: filter, exclude list

**Invitation**:
The flow by which one device proposes adding another device to a shared folder; the invited device accepts and chooses the local path.
_Avoid_: request, share (as verb)

**Version Consistency Lock**:
The product-level requirement that all paired devices run the same syncx version. A device that is behind its online peers is held at an upgrade prompt with no other exit until it catches up.
_Avoid_: upgrade banner, warning modal, version gate (which would mean the wire refusing a mismatched peer — that is deliberately *not* what happens)
