# ADR-0014: Relay of received changes across sibling peers (mesh transit)

## Status

Accepted.

## Context

syncx models every shared folder as an independent point-to-point link. On a
`A↔B↔C` chain (directory id `1` shared `A–B` and `B–C`, but **not** `A–C`),
an edit made on `C` reaches `B` but stops there: `B` merges it into the shared
`folder.localIndex` (`peer.ts:completeIfReady`) and never re-broadcasts it to
`A`. `A` only ever receives `B`'s **own** local scans (`session-manager.ts:
scanOnce` → `broadcastFolderUpdates`), and there is no periodic re-push of the
index, so the change never flows to `A`. This is by design (see `MEMORY.md`,
"不做中转"), not a bug — but it surprises users who expect a hub-and-spoke
topology to behave like a mesh.

The earlier 2026-09-16 accident forbade treating received deltas as fresh local
edits and re-pushing them, because that produced an echo loop. This ADR adds
relay **safely**, reusing the existing version-vector machinery, so a hub
(`B`) forwards a leaf's (`C`) change to its other leaf (`A`) without echo.

## Decision

1. **Relay-on-receive, version-vector driven.** When a `SyncPeer` lands one or
   more remote entries received from peer `X`, it notifies the folder via an
   `onLanded(entries)` callback. The folder relays those entries to its **other**
   transports (all except `X`) as a `delta` index frame tagged `relayed: true`.
   No new scanning, no faked local edits.

2. **Boomerang is structurally impossible.** Each relayed `delta` only names
   the changed paths, so the receiver judges *only those paths* (the 2026-09-16
   trap was treating a received delta as a `full` frame). On the receiver,
   `compareVersions(local, relayed)` for the origin peer is `equal` (the relay
   keeps the **original author's counter** — e.g. `{C:5}` — it is never
   rewritten as a "new edit by B"), so no `send`/`receive` action is produced
   and `onLanded` does not fire again for it. Even a stray mispush to `C` is a
   harmless no-op: `C` sees `equal`, does not increment, does not re-broadcast.

3. **Exclude the source transport.** `relayToSiblings(transports, source,
   entries)` skips the transport the frame arrived on, so a relayed frame never
   bounces straight back to the peer that sent it. Combined with (2) this
   bounds the message graph: once every device holds `{C:5}`, every comparison
   is `equal` and the system goes quiet.

4. **Concurrent versions on a sibling: distinguish "genuine local edit" from
   "stale synced copy".** A relayed entry whose version is *concurrent* with the
   receiver's local version is **not** automatically a conflict. The receiver's
   local entry is a genuine local edit iff its version vector carries the
   receiver's own device-id counter `> 0`. If it does → keep the existing
   conflict behaviour (preserve local as `.sync-conflict`, land remote). If it
   does **not** (the local copy is merely an older synced copy authored by
   someone else) → overwrite with the relayed entry and create **no** conflict
   copy. This avoids spraying `.sync-conflict` files onto devices that never
   touched the file, while still protecting a device that genuinely edited
   since the last common version.

5. **Gate relay on `delta` only, and never on a receive-only node.**
   `onLanded` fires only when `!opts.full && !receiveOnly`. The
   session-establishment `full` index exchange already converges the mesh (it
   carries every version); relaying it would be a needless burst on every
   (re)connect. Relay exists to propagate *incremental* changes the current code
   drops. A receive-only device (`receiveOnly`) does not relay: its contract is
   to push no index frame outward, and a relay frame is an outward push.

## Mechanism

- `src/peer.ts`: `PeerTransport.sendEntries(entries, mode, opts?: { relayed?:
  boolean })`; `PeerIndexOptions.relayed?`; `SyncPeerDeps.onLanded?`. In
  `onPeerIndex`, collect entries that enter `receive`/`conflict` pending; after
  the action loop, if `!opts.full && landed.length > 0`, call
  `deps.onLanded?.(landed)`. The `conflict` branch overrides to a `receive`
  (overwrite, no `.sync-conflict`) when `opts.relayed && !receiveOnly &&
  localEntry.version.get(deviceId) ?? 0 === 0`.
- `src/net/wire.ts`: `WireMessage` index variant gains `relayed?: boolean`;
  `makePeerTransport.sendEntries` sets it; `attachPeerMessages` passes
  `relayed: message.relayed === true` into `onPeerIndex`.
- `src/relay.ts` (new): `relayToSiblings(transports, source, entries)` — `delta`
  + `relayed: true` to every transport except `source`, early-returns on empty.
- `src/session-manager.ts`: `attachFolderToSession` passes `onLanded: (entries)
  => relayToSiblings(folder.transports, transport, entries)`.

## Backwards compatibility

Old peers ignore the extra `relayed` field on the index message. A mesh mixing
old and new peers simply degrades to "no relay across the old hop" — no loop,
no corruption.

## Tests

`test/integration/relay.test.ts` (reuses the `two-devices` socket harness):

- **Chain propagation:** `C` edits → `B` receives → `A` (linked only to `B`)
  converges to `C`'s version.
- **No echo loop:** after settling, `C`'s and `A`'s index-message counts stop
  growing; `B` never re-sends to `C`.
- **No spurious conflict:** `A` holds a stale synced copy (authored by a third
  device, no `A` counter); a relayed concurrent edit overwrites it and creates
  **no** `.sync-conflict` file. A genuine concurrent edit (local `A` counter
  `> 0`) still produces a conflict copy.
