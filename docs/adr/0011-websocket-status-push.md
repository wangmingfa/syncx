# ADR-0011: Control-plane status is pushed over a WebSocket, with polling as fallback

## Status

Accepted.

## Context

The Web UI fetched `GET /api/status` every 4 seconds (`web/composables/useStatus.ts`)
— one timer per open tab, ~900 requests per hour. That was the only poller;
history, logs, offers and self-update state are all fetched on demand, so the
complaint that "many things are polled" was really "one endpoint, but each hit is
expensive".

Each hit recomputed the whole world:

1. `loadConfig(configPath)` — read and parse `config.json` from disk.
2. `manager.getIndexStats()` — for **every** shared folder, `SELECT path, version,
   size, deleted, blocks, mtime FROM entries`, deserializing every row into an
   `IndexEntry` (version vector + block list), then walking the array twice to
   count live entries and tombstones.
3. `listOpenOffers()` (another file read) and `updateChecker.available()`.

So an idle daemon was woken every 4 seconds per client to do a full index scan,
and the client still saw data up to 4 seconds stale. Meanwhile the underlying
state changes are discrete and low-frequency: peers connecting and disconnecting,
folder lists changing, invitations arriving, folder errors appearing/clearing,
scan rounds finishing. Only transfer progress is genuinely high-frequency.

## Decision

Add `WS /api/events` and push complete status frames from the server.

**Triggering is two-layered ("events + fallback").**

- *Events* (`SyncSessionManager`'s `onStatusChanged` → `statusHub.notify()`): peer
  connect/disconnect, version/hostname learned, `folder-sync-list` received,
  control messages handled, folder errors recorded/cleared, scan round finished,
  remote change applied, config reloaded — plus the CLI handlers that write
  `config.json` directly (device add/remove, folder device lists, offer
  accept/decline/restore) since those bypass `reloadConfig`. Coalesced into one
  frame per 250 ms window.
- *Fallback*: one timer that recomputes unconditionally every 5 s. It exists so
  that a missed notification means "this change shows up a few seconds late"
  rather than "this part of the UI never updates again". That property is worth
  more than the recomputations it costs.

**Pushing is diff-driven.** `flush()` serializes the snapshot and sends nothing
when it equals the previous one. This is what makes it safe to sprinkle `notify()`
calls generously among coarse-grained mutation points, and what keeps the
fallback tick from degenerating into a fixed-rate push.

**Idle daemons do zero work.** Both timers are created when the first client
attaches and destroyed when the last one leaves.

**Polling stays as a fallback, and the two are mutually exclusive.** The browser
client opens the socket and only starts its 4 s timer when the socket is
unavailable; a successful connect stops the timer. This is not optional: any
reverse proxy in front of the control port that does not forward `Upgrade` would
otherwise silently lose real-time updates. Reconnect uses exponential backoff
(1 s → 30 s).

**`getIndexStats()` was also fixed regardless of transport** — it now issues two
`SELECT COUNT(*) … WHERE deleted = 0/1` aggregates (`IndexStore.countEntries()`)
instead of pulling the whole table into memory. The fallback polling path and any
other caller get cheaper too.

**Authentication is unchanged.** Browsers cannot set headers on a WebSocket
handshake, so the browser path relies on the same-origin `syncx_session` cookie;
`readToken()` already accepts either cookie or Bearer, so both routes work with
the existing check. The handshake is handled on the server's `upgrade` event
(never reaching the request handler), and an unauthorized attempt gets a real
`401` response before the socket is destroyed, so the client can tell "not logged
in" from "network down" instead of looping on an unexplained reconnect.

## Consequences

- Status reaches the browser in well under a second instead of up to 4 seconds;
  nothing changes on the wire when nothing happens.
- `vite.config.ts` must proxy `/api` with `ws: true`. Without it the dev page
  (served from :5173) cannot complete the handshake and silently degrades to
  polling — a failure mode with no error message, so it is called out in the
  config comment.
- The path literal `/api/events` is duplicated between `src/api/helpers.ts`
  (`EVENTS_PATH`) and `web/composables/useStatus.ts`, because the client bundle
  does not import server modules. Divergence degrades silently for the same
  reason.
- Adding a new field to the status payload does not require a new notification
  site — the fallback tick picks it up within 5 s, and the 250 ms coalescing makes
  extra `notify()` calls harmless.
- Shutdown must close the sockets (`statusHub.close()`), otherwise clients keep
  believing the channel is alive through a restart and never re-read the state.
- A frame is a full snapshot, not a patch. With a handful of folders and devices
  that is a few KB; if the payload ever grows large (thousands of files listed
  individually), this becomes the next thing to revisit.
