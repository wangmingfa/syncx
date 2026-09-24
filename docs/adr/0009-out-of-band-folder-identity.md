# ADR-0009: Out-of-band folder identity, and keeping syncx out of the shared directory

## Status

Accepted. Supersedes the mount-marker decision in ADR-0007 (§3).

## Context

ADR-0007 adopted Syncthing's `.stfolder` idea: a marker file at the share root
whose presence means "this folder is mounted and its contents are trustworthy".
Its absence means "the drive is gone / the directory was wiped", which must
never be interpreted as "the user deleted everything". The marker works, and it
works for the reason Syncthing's does — the proof lives *on the filesystem whose
mounting is in question*, so unmounting takes the proof with it.

But the marker is a file in the user's directory, and so is the deletion recycle
bin (`.syncx-trash/`, ADR-0005's sibling change in `5dfa3e4`). Both show up as
untracked files in `git status` the moment a share root is a git repository, and
in a directory tree the user diffs, archives, or backs up by other means. The
user's requirement is explicit and reasonable: **using syncx must not change the
contents of the directory being shared.**

Two facts forced the design:

1. **A marker in `~/.syncx/` cannot replace the marker in the share root.**
   Storing "the folder is fine" in the config directory would make the assertion
   unconditional — it survives unmounting, since it is not on the unmounted
   filesystem. That is strictly worse than no marker: it asserts trust at the
   exact moment trust is due to be re-evaluated.
2. **What we actually need is identity, not a flag.** "Is this the same
   directory I adopted?" is answerable from the *directory's own metadata*:
   `st_dev` + `st_ino`. Unmounting a volume makes the path either disappear
   (Windows drive letters, macOS `/Volumes`) or revert to the directory on the
   hosting filesystem underneath (Linux mountpoints) — in both cases the
   observed `dev`/`ino` differ from what was recorded while the volume was
   mounted. A different volume mounted at the same path also differs, which a
   marker file cannot detect at all (the new volume may well contain its own
   marker).

## Decision

**Syncx writes nothing into a shared directory except the files it is asked to
sync, and mount detection uses an out-of-band identity fingerprint.**

1. **`src/folder-identity.ts`, replacing `src/marker.ts`.** `readFolderIdentity`
   stats the share root with `{ bigint: true }` and stores `dev`/`ino` as
   decimal *strings* in `sharedFolders[].folderIdentity`. Strings because JSON
   cannot serialise `BigInt` and because inodes above 2^53 (XFS, ZFS) would lose
   precision as `number`, risking two distinct directories comparing equal.
2. **`checkFolderIdentity` returns one of four verdicts**, and `scanOnce`
   branches on them before scanning:
   - `ok` — proceed normally.
   - `missing` / `changed` — skip the folder this round, record the reason on
     the folder card, never emit tombstones. Recovery is "remove and re-add the
     folder", which is also what mints a fresh `instanceId` and therefore a
     fresh index store.
   - `unknown` — no fingerprint recorded, or the filesystem reports no inode.
     Proceed, but with a **structural guard**: if the scan saw zero files while
     the index still holds live entries, refuse to apply that batch of
     deletions. That is the shape of "the drive is gone", and it is the only
     shape blocked; ordinary deletions are unaffected. `ScanDiff.filesSeen`
     exists for exactly this check.
3. **The recycle bin moves to `<configDir>/trash/<index-key hash>`**
   (`config.folderTrashPath`, hashed the same way as the index file, so a folder
   instance maps to both identically). `moveToTrash` already had a
   copy-then-delete fallback for cross-filesystem renames; that is now the
   common path when the share is on another volume.
4. **One-time startup migration** (`cli.ts`): adopt the fingerprint for folders
   that predate this change, delete a leftover `.syncx-folder` that syncx itself
   wrote (content-verified, so a user's identically named file is left alone),
   and move `.syncx-trash` contents into the new location before removing the
   now-empty directory. If any file cannot be moved, the legacy directory is
   kept — recoverable data is never discarded because a move failed.
5. **`.syncx-folder` and `.syncx-trash` stay in the hard-ignore list**
   (ADR-0008). Nothing creates them any more, but a peer running an older
   version can still have them in its index, and they must not be synchronised
   if they appear.

## Consequences

- `git status` in a share root is now clean. The only transient artefact is
  `*.syncx-tmp` during a file transfer, which exists for the duration of one
  atomic rename (it must be a sibling of the target to be renamed into place)
  and is skipped by the scanner if a crash leaves one behind.
- Mount detection is *stronger* than the marker file in one respect (a swapped
  volume is caught) and *weaker* in another: it depends on the filesystem
  reporting an inode. Where it does not (some network filesystems), the
  `unknown` branch's structural guard takes over — narrower protection, but it
  still covers the dangerous case.
- Adoption must stay one-shot and persisted. Auto-repair would defeat the whole
  mechanism: wipe a directory, restart the daemon, and a re-captured
  fingerprint would bless an empty directory, which is then broadcast as mass
  deletion. The pre-existing dangerous-state guard (index has live entries, but
  the directory's top level is empty → refuse to adopt) is therefore carried
  over verbatim, and a `changed`/`missing` verdict never overwrites the record.
- Changing a folder's `path` no longer silently re-adopts. The old path's
  fingerprint no longer matches, so the folder pauses with an explicit error
  until the user removes and re-adds it. This matches the old behaviour (a new
  path had no marker file) and is the safe reading: pointing an existing index
  at a different directory would send that directory in full and tombstone
  everything the index used to describe.
- Deletions on a share that lives on a different filesystem than `~/.syncx` are
  now slower (copy + unlink instead of rename) and briefly use double the disk
  space for the affected file. Accepted: correctness and the user's directory
  hygiene both matter more than deletion throughput.
- `~/.syncx/trash` is not garbage-collected. Entries are recoverable data, so
  nothing prunes them automatically; orphans accumulate when folders are
  removed. Cleaning it is a manual operation.

## Addendum (2026-09-24): `st_dev` is not stable on Android A/B devices

Two changes since this ADR was written. The first is bookkeeping: `ee4ffc4`
split `changed` in §2 into `changed` (inode differs — a different directory) and
`remounted` (only `dev` differs — same filesystem, re-mounted), and added
`POST /api/folders/re-adopt-identity`, which re-captures the fingerprint without
touching the index or `instanceId`. Read §2 as five verdicts.

The second is a measured fact that changed what `remounted` should *do*.

**Observed.** On a real device — syncx under Termux on Android, two consecutive
over-the-air updates — `sharedFolders[].folderIdentity.dev` went `65114` →
`65115` → `65114`. The `ino` never changed.

**Mechanism.** `/data` is not part of an A/B update: userdata is a single
partition, so the filesystem and its inode numbers survive the update untouched.
But `st_dev` is not a disk serial number — it is the device number of whatever
the mount happens to be backed by *this boot*. On Android `/data` sits on a
device-mapper target (metadata encryption), and dm minor numbers are handed out
in creation order during boot. Each A/B update boots the **other** slot, whose
vendor ramdisk / `fstab` creates a slightly different number of dm targets
before `/data` is mapped, so the minor shifts by one — and the next update boots
the first slot again and shifts it back. The value does not drift; it
**oscillates, indefinitely, once per update**.

**Consequence for the design.** `remounted` is not a rare anomaly on such a
device; it recurs on every single update. A confirmation prompt that fires
repeatedly, and whose correct answer is always the same, trains the user to
click through it without reading — which is worse than having no prompt,
because it spends the attention the guard needs for the case that actually
matters.

**Amended decision.** `folderIdentity` records the **set of `dev` values
accepted** for that folder, not just one:

1. A `remounted` verdict whose new `dev` is already in the accepted set is
   **auto-adopted**: the fingerprint is updated, a log line records it, and no
   banner is shown. The A/B oscillation therefore costs the user nothing after
   the first occurrence of each value.
2. A `remounted` verdict with a `dev` never seen before still **prompts once**,
   and confirming adds that value to the set.
3. `changed` (the inode differs) is untouched: always manual, never
   auto-adopted.
4. Configs written before this hold a single `dev`; it is read as a one-element
   set, so the first re-mount after an upgrade behaves exactly like today's.

**Why not simply auto-adopt every `remounted`.** That discards half of the
fingerprint and reopens the precise case this ADR exists for: a *different*
volume mounted at the same path whose root directory happens to carry the same
inode number (§2, fact 2). Keying the auto-repair on a set of previously
confirmed device numbers keeps that gate shut — an attacker's or an accident's
new filesystem presents a `dev` that is not in the set — while removing the
recurring noise. The cost is one confirmation per genuinely new device number,
which is the information we actually need a human for.

