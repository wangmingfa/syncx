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

**Block**:
A fixed-size chunk of a file identified by a content hash; only changed blocks are transferred during incremental sync.
_Avoid_: chunk (when meaning hash-addressed), part, segment

**Ignore Rule**:
A pattern (gitignore-style) that excludes files or directories from synchronization within a shared folder.
_Avoid_: filter, exclude list

**Invitation**:
The flow by which one device proposes adding another device to a shared folder; the invited device accepts and chooses the local path.
_Avoid_: request, share (as verb)
