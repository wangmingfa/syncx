# ADR-0018: Version consistency is enforced in the UI, not on the wire

## Status

Accepted. Documents the decision implemented in `9130016` (first shipped in 0.3.2).

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
mode. Pinned by `test/web-upgrade-lock.test.ts`, which asserts on the source of all three
routes.

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
  locking anyway would trap the user outside a page they cannot satisfy. The lock appears the
  moment that peer reconnects and re-announces.

**6. Scope: the status page only.** `/terminal`, `/files`, `/fleet`, `/compare`, `/trash` do
not mount the modal — `web/StatusPage.vue` is its only host (mounted last in the template so
DOM order puts it above same-z-index overlays). This is a known hole in the invariant, not a
design: the page a user lands on is the status page, and that is where a mixed fleet gets
caught.

## Consequences

- **The lock cannot bootstrap itself.** It only exists in the version that shipped it, so a
  0.3.1 ↔ 0.3.2 pair is protected on one side only and must be resolved by hand. Same shape
  as the updater's one-generation lag: whatever a release fixes, the *previous* release's code
  is what performs the fix.
- **The invariant is advisory with respect to actual syncing.** Two mismatched devices do
  still sync if the lower side never opens the status page. Treating a bug report as
  "upgrade both sides first" remains a manual step.
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
