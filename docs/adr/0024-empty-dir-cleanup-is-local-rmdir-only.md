# ADR-0024: Empty-directory cleanup is a local, rmdir-only inventory

## Status

Accepted 2026-10-13. v1 of the folder-card 「空文件夹」 tool (`src/empty-dirs.ts`). It ships in the
same change as the 「Git 提交历史」 modal; that one is a read-only git passthrough with no protocol or
storage decision to record, so this ADR covers only the empty-directory half.

## Context

Directories are not sync entities. Every entry the protocol carries has a file's shape —
`IndexEntry` is `path`/`version`/`size`/`blocks`(`cdh`) plus a `deleted` tombstone for files
(`src/index.ts:4-37`) — and the scanner derives entries from files only. A directory holding no
files therefore contributes nothing to any index, and no mechanism in the project can express it:

- Deleting an empty directory on one side writes no tombstone, produces no index message, and
  changes nothing on the other side. There is no frame whose shape could even say "remove
  directory X".
- The empty shells therefore accumulate and **never disappear on their own**. Both sides' indexes
  agree perfectly (there is nothing in them to disagree about), so not even the drift sentinel
  (ADR-0022) can flag them. Git does not record empty directories either, so a git-backed folder's
  auto-commit (`git add -A`, `src/git-monitor.ts`) neither sees them nor is affected by their
  removal — they are residue visible only to a human's file manager.

A prior pass priced making the protocol carry directories and parked it; this tool deliberately
does not reopen that. The request being answered is smaller: 「检查所有空文件夹(不同步的文件夹
忽略),以树形显示这些空文件夹,支持删除」. What needs recording is therefore not *whether* to
sync directories (no), but **what "empty" means, what the delete refuses, and what it is allowed
to touch** — the places where a wrong answer costs a file.

## Decision

**The tool is local-only; directories stay non-entities.** `deleteEmptyDirs` deliberately does not
call `runScan` and touches no index (`src/session-manager.ts:3607-3613`) — there is nothing to
broadcast, because no index ever carried the directory. The confirm dialog says this to the user's
face: 「目录不参与同步:此操作不广播、不影响对端,对端各自的空目录需在对端处理」
(`web/components/EmptyDirsModal.vue:186`).

**One definition of "empty", shared by the listing and the delete.** A directory is empty iff its
whole subtree holds no non-directory entry; files, symlinks and other special entries all count as
content (`src/empty-dirs.ts:106-113`) — symlinks are not followed, matching the scanner's lstat
semantics. An unreadable directory counts as content too: unable to prove empty means never
proposed for deletion (`src/empty-dirs.ts:99-104`). The delete side re-walks with `verifyEmpty`
before removing (`src/empty-dirs.ts:145-161`), so it can never delete something the listing would
not have shown. If the two definitions ever diverged, the tool could display a row it then refuses
— a lie in the one place the user extends trust.

**The delete is rmdir-only; "no file is ever lost" is structural, not procedural.** `rmdirBottomUp`
(`src/empty-dirs.ts:174-197`) recurses directories and calls `rmdirSync`; any non-directory entry at
any level aborts that path with a reason (`:182-185`). The module contains no `unlink`. Even a wrong
listing cannot destroy content — the worst failure mode is a refusal that names why.

**Deletion is explicit and confirm-gated.** The modal lists exactly the paths to be removed (first
12, then a count), and only then does the user confirm (`web/components/EmptyDirsModal.vue:181-187`).
Nothing in this feature deletes on a timer, on a scan, or in the background — the empty-shell
residue is cosmetic, and only the machine's owner can say a given shell has no value.

**What is listed — and what is excluded** (`walk`, `src/empty-dirs.ts:97-130`):

- **Empty chains, leaf through top**: a leaf and every ancestor that contains nothing but the chain
  are all listed (`test/empty-dirs.test.ts:26-39`) — that is the tree the request asked for, and it
  is what lets deleting the parent clear the whole chain in one pass (deep-first ordering,
  `src/empty-dirs.ts:228-234`). The modal renders it as a tree by indenting on path depth.
- **Ignore rules scope the report, not the emptiness test.** An ignored directory is never listed,
  nor is anything below it (`src/empty-dirs.ts:120-127`, mirroring the scanner, which does not
  descend into ignored subtrees — comment `:94-95`); that is 「不同步的文件夹忽略」. But files
  inside an ignored subtree still count as content for their ancestors: a directory holding only
  `node_modules/` **with files in it** must not be listed, or the delete would aim at a directory
  full of things (reverse control, `test/empty-dirs.test.ts:53-67`).
- **Nested shared roots are barriers** (`src/empty-dirs.ts:114-117`): another folder's root inside
  this tree is never entered, never listed, and always counts as content — its cleanup belongs to
  that folder, and refusing the parent too keeps this tool's delete away from other folders' ground.
  `buildNestedSet` (`:59-74`) keeps only roots strictly inside this one; an ancestor/outer root must
  be filtered out or every path would read as "someone else's" and the whole tool would be dead on
  arrival (regression pinned at `test/empty-dirs.test.ts:93-101`).
- **The shared root itself is never listed or deletable** (`src/empty-dirs.ts:251-253`): an empty
  root is the 「移除目录」 flow's semantic, not a cleanup tool's.

**Delete gates, in order, per path** (`src/empty-dirs.ts:203-209` documents the order; the loop is
`:237-276`): `resolveFolderSubpath` — the traversal / absolute-path / symlink-escape gate that file
browsing already uses (`src/filebrowser.ts:61`) — then root-itself refusal, ignore-rule refusal
(including hard-ignore entries like `.git`), nested-root refusal, then `verifyEmpty` re-check plus
bottom-up rmdir. Each path fails independently with a user-readable reason; one bad path never
poisons the batch. A path that is already gone is `ok: true` — idempotent, the goal is met.

**Cap and rule sources match the rest of the system.** `EMPTY_DIRS_MAX` (2000) bounds one listing
(`src/empty-dirs.ts:34`), and the delete route enforces the same bound so a request cannot exceed
what a scan could ever show (`src/api/routes/folders.ts:1088-1106`); truncation is reported, not
silent. The rules come from the same source the scanner reads — `.gitignore` (per the folder's
config) plus `.syncxignore`, re-read at call time — and the nested-root set is the same
other-folders' roots, both assembled in `src/session-manager.ts:3583-3591`.

## Consequences

- **The removal is per-machine by design.** The peer keeps its own empty directories; cleaning them
  is a separate action there, and the confirm copy says so. The fleet converges on files only, as it
  always did — this ADR accepts that residue rather than changing the protocol for it.
- **Staleness between scan and delete is expected, and the answer is refusal.** A directory can gain
  content in the window; the delete re-checks and reports 「目录内现在有文件,跳过」, file untouched
  (`test/empty-dirs.test.ts:156-172`). There is no best-effort path.
- **Results are per-path; a partial chain is harmless.** The UI aggregates (deleted k of n; failures
  with reasons). A mid-chain stop can leave some already-removed empty directories — by
  construction they were empty, so nothing is lost; re-scan and repeat. No partial outcome can
  involve a file.
- **No scan trigger, no history entry, one log line.** `empty dirs removed: <id> (k/n)` is the
  observability (`src/session-manager.ts:3612`); sync history records sync events and this is not
  one. The modal's per-path reasons are the user-facing surface.
- **git-backed folders are unaffected in both directions**: an empty directory was never a pending
  git change, so removing it cannot create one, trigger the auto-commit, or collide with it.
- **Unreadable and vanished states degrade to refusals, conservatively**: unreadable directory →
  counts as content, never listed; gone shared root → every path fails with 「共享目录不存在或不可
  读」 rather than a false "deleted" (`test/empty-dirs.test.ts:259-268`).
- **The residue can re-form at any time** — another device, another program, the user can all
  create empty directories. The tool is on-demand cleanup, not a guarantee; nothing here deletes
  anything a user did not select.
