# ADR-0018: Version consistency is enforced in the UI, not on the wire

## Status

Accepted. Implemented in `9130016` (2026-09-29). The first published artifact carrying it is
`@wangmingfa/syncx@0.3.3` (2026-09-30) — so the bootstrap consequence below is about the devices
still sitting on 0.3.2 and older.

2026-09-30: extended from "status page only" to **every route** by mounting it from an App-level
host (§6). The verdict, the non-dismissibility and the daemon-side `canUpgrade` are unchanged;
what changed is which pages the lock reaches.

## Context

syncx pairs devices that run the same software, and the wire protocol is **additive**
(ADR-0017): a message carries extra optional fields, an older peer simply never reads
them. Nothing rejects a mismatched peer — `hello` (`src/net/wire.ts:51`) announces
`version`, and the receive path does one thing with it: `if (message.kind === 'hello') return;`
(`src/session-manager.ts:2737`). The value is stored for display and for the `canUpgrade`
verdict. Two devices on different versions connect, sync files, and look healthy.

What mixed versions actually cost is **silently missing features**, and every one of them is
a promise the newer version makes to the user:

- an old peer never announces a CDC view (no `cdh`/`clens` on its wire entries,
  `src/messages.ts:19`), so block planning stays on fixed 1MB blocks and the "large file, small
  edit" saving disappears (ADR-0017 §"announce-gating, not negotiation");
- an old peer never sends `git-commit-ack`, so the notify ledger resends five times
  (`GIT_NOTIFY_MAX_RESENDS = 5`, `src/session-manager.ts:136`) and then gives up with a log
  line — content lands, the commit is permanently missing on one side;
- an old peer never answers `self-binary-request`, so "upgrade from peer" is unavailable.

The reason this was made a hard UI constraint rather than a warning is attribution: a
mixed-version run produces behaviour differences with no error anywhere, and untangling
"is this a bug or is one side old" costs more than the upgrade costs the user.

## Decision

**1. The invariant "paired devices run the same version" is product-level, enforced by the
Web UI, not by the protocol.** No handshake gate, no refused sync, no version check in
`peer.onPeerIndex`.

**2. A wire-level gate was rejected on purpose, not by omission.** The one action that fixes
a version mismatch is *pulling the package from the higher-version peer*, and that request
(`self-binary-request` / `self-binary-response`, `src/session-manager.ts:1852` and
`:1944`) rides the very connection a mismatch gate would sever. Refusing to speak to a
mismatched peer would make the lock unescapable — which is also why the lock offers a
per-row upgrade button instead of just blocking the page.

**3. The prompt is not dismissible.** `ModalShell` gained `hideClose`, which kills all three
exits: the × is not rendered, overlay clicks do not emit `close`, and Esc was never handled by
the shell (`web/components/ModalShell.vue:68`). A dismissible version of this would be read as
one more banner, and the drift it prevents is invisible — so dismissal is exactly the failure
mode. Pinned by `test/web-upgrade-lock.test.ts`, which asserts on source text: the × is not
rendered, the overlay click is gated, the host is the last node of `App.vue`'s template, and
neither the modal nor its host nor `useDevices` contains a `compareVersions` call.

**4. The verdict is computed daemon-side and never re-derived in the browser.**
`canUpgrade` (`src/cli.ts:595-598`) requires *both* versions to be concrete semver and the
local one to be lower; the modal filters on `d.online && d.canUpgrade` and the test asserts
that neither the modal nor `useDevices` contains `compareVersions`. Two consequences of
putting the verdict in the daemon: the browser holds no second copy of semver rules to drift
from the first, and each row keeps its own button — the user picks which peer to pull from
rather than the front end guessing "the highest".

**5. Two deliberate non-triggers.**
- *dev / source runs never lock.* `compareVersions('dev', '0.3.2')` returns −3, so without the
  `isRealVersion` guard a source checkout would be told to P2P-upgrade itself into a build —
  which the "target directory looks like a source repo" self-update guard would then refuse.
  The guard is load-bearing, not cosmetic.
- *Offline peers never lock.* You cannot pull a package from a device that is down, and
  locking anyway would trap the user in an app whose only exit they cannot satisfy — after §6
  there is no un-locked page to retreat to, so this non-trigger carries more weight than it used
  to. The lock appears the moment that peer reconnects and re-announces.

**6. Scope: every route, from one App-level host.** `web/components/UpgradeLockHost.vue` is
mounted in `web/App.vue` as the last node in the template, so DOM order puts it above the
modals a page mounts itself — they all sit on `--z-overlay` (100), and ties break by tree order.
Two things are deliberately *above* it and neither is an escape: `--z-toast` (2000), because a
toast raised from inside the lock must be readable, and `--z-drop` (900), the page-level
"drop a package here" overlay — which is itself an upgrade path. No page hosts the modal any
more: `web/StatusPage.vue` used to, and that was an accepted gap rather than a boundary — the
lock says *this machine's version is wrong*, which is true on `/terminal` exactly as it is on
`/`. Per-page hosting only moves the failure around: someday one route forgets to mount it, and
nobody reports "why does `/terminal` still work" as a bug.
Three things fell out of that placement and are pinned in `test/web-upgrade-lock.test.ts`:
- The host **subscribes to status itself** (`web/composables/useStatusFeed.ts`) rather than
  receiving it by props. `/terminal` and `/files` fetch their own data and have no shared
  `status` instance to hand over; the alternative was duplicating the reconnect/backoff/poll
  fallback per page. The extra connection costs almost nothing because push is
  change-driven — an unchanged snapshot sends no frame at all (ADR-0011).
- It mounts only **after the session is known good** (`v-if="status"` in `App.vue`). `/login` is
  rendered by this same client, so an always-mounted host would fetch `/api/status` there, get
  401, and `apiJson` responds to 401 with `location.assign('/login')` — the page reloading
  itself forever. A lock on a login screen is meaningless anyway: there is no `devices` to lock on.
- The upgrade POST lives in `web/composables/useUpgrade.ts`, used by both the device card
  (`askUpgrade`) and the host. The lock is the one surface where the action has no alternative,
  so its feedback (toast, wait out the restart, refresh) must be identical to the ordinary path
  — that only holds if there is one implementation.

Measured in a browser against a stubbed daemon (six routes walked in one page load, no reload):
the overlay is present on every one of them, it is the last `--z-overlay` node in document order
each time, it has no × and survives both a backdrop click and an Escape keydown, and clicking
"upgrade from peer" posts `/api/devices/upgrade` exactly once and then *leaves on its own* when
the host's own `/api/status` refresh comes back with `canUpgrade` false. On the 401 path the
host never mounts and the boot counter stays put — no self-refresh.

## Consequences

- **The lock cannot bootstrap itself.** It only exists in the version that ships it, so in a
  mixed pair the side without it is never prompted and must be brought up by hand. That is not
  hypothetical: the first artifact carrying it is 0.3.3, and npm's previous `0.3.2` predates the
  commit entirely. Measured with an ASCII probe — the bundle escapes CJK, so searching it for
  Chinese text finds nothing — the modal's class prefix `upgrade-lock` occurs 14 times in the
  0.3.3 tarball and 0 times in 0.3.2's. Same shape as the updater's one-generation lag:
  whatever a release fixes, the *previous* release's code is what performs the fix.
- **The invariant is advisory with respect to actual syncing.** Two mismatched devices do
  still sync if the lower side never opens the Web UI — the lock is a page, not a check, and a
  daemon running headless (`syncx start` and nothing else) is outside its reach entirely.
  Treating a bug report as "upgrade both sides first" remains a manual step.
- **Prerelease and locally packed builds are judged outdated and get overwritten.**
  `compareVersions('0.3.2-local.1', '0.3.2')` is −1 (a base version outranks its own
  prereleases — `src/upgrade.ts:33`), so a `pack:local --append` build paired with a fleet on
  0.3.2 will be locked and will happily **downgrade** itself onto the published 0.3.2. Nothing
  catches it: the peer-upgrade guard is "refuse when the local version is *not lower*"
  (`src/session-manager.ts:1932`), which by construction permits this direction. The same
  applies to a `x.y.z-beta.N` device paired with a stable peer. `pack:local` has no
  `--version` flag, so testing against a fleet means temporarily raising `package.json`'s own
  `version` above every peer's and packing that.
- Upgrading the local daemon from within the lock restarts it, so the page is briefly
  unreachable; the modal disappears on its own once `status` returns with `canUpgrade` false.
