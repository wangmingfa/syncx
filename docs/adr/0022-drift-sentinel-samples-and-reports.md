# ADR-0022: The drift sentinel samples and reports; it never repairs

## Status

Accepted. v1 of the ROADMAP item 「抽样审计(drift 哨兵)」. It rests on ADR-0002 (version vectors are
the conflict primitive) and is deliberately shaped so it works on a mixed-version fleet (ADR-0018)
without a wire change.

## Context

`compareFileState` decides `'equal'` from the **version vectors alone** (`src/index.ts:45-64` →
`compareVersions`, which compares per-device counters), and `planPath` returns `undefined` for
`'equal'` (`src/plan.ts:19-21`). So two declarations that carry the same version but different
bytes produce no action, no history record and no log line. The protocol has no second thing that
notices: once the vectors agree, the block hashes riding in the same index message are simply never
compared.

That gap is not hypothetical. The receive-claim ledger exists because of a case that lived in it —
two pipelines landing the same path, the second overwriting a local edit made during the window,
recorded as 「事后两侧索引一致、扫描无感 = 静默永久分叉」 (`src/peer.ts:185-193`). The echo-loop
incident (`src/plan.ts:58-66`) is the same shape one level up: hours of divergence with nothing
printed anywhere, because every individual step was "correct".

Making that class visible costs a periodic comparison of what each side *declares* against what is
actually on disk. Deciding **how much** to do with a detection is where the real trade lives, so it
gets written down.

## Decision

**Two checks, one candidate set, zero new frames** (`src/drift.ts`):

- **A — declaration vs declaration**: for pairs the round judged `equal`, compare `size`, then the
  hash lists — `cdh`/`clens` when both sides carry a usable CDC view, else `blocks`. No IO, no
  traffic: the peer's declarations are already in hand inside `onPeerIndex`.
- **B — declaration vs disk**: `executor.verifySampledSlots` reads *one slot* per sampled path and
  hashes it, using the same `slotLayout` `beginReceive` writes through, so the position verified and
  the position written cannot disagree with each other.

**Only `equal` pairs are candidates.** A path that is `local-newer`, `remote-newer` or `conflict`
has content disagreeing as part of its normal job; the next round converges it or files a conflict
copy. Calling that drift would print a false alarm for every in-flight change, and a sentinel that
cries wolf gets muted.

**Sampling is a deterministic stride, and the slot is hashed from (path, round).** Not random:
rotation coverage has to be assertable (`strideSample`, `pickSlot`, `test/drift.test.ts`), and random
picks re-audit the same few files on small sets while proving nothing on large ones. Not slot 0
either: a fixed slot only ever reads the head of the file, which is exactly the shape that hides an
offset-arithmetic bug — ADR-0021 records the "3-arg `writeSync` writes every block to the file
start" mistake, and under a fixed slot 0 that bug looks perfectly healthy.

**Cost ceiling: one slot read per sampled path** (default 8 per round per connection), independent
of folder size — 8 reads and 8 sha256. A slot is `BLOCK_SIZE` (1 MiB) on the fixed view but up to
`CDC_MAX_CHUNK` (4 MiB) on the content-defined view, which is what an audit between two
CDC-carrying sides uses, so a round reads ~8 MB typically and 32 MB in the worst case.
Knobs are environment-only —
`SYNCX_DRIFT_SAMPLE_N` (0 = off), `SYNCX_DRIFT_INTERVAL_MS` (30 min) — read when the pipeline is
built rather than as module constants so a test can drive them.
They are not in `config.json` on purpose: a config key implies UI, migration and a user decision,
and this is a diagnostic that should never need touching.

**It runs at the tail of `onPeerIndex`, gated on an idle connection and the interval** — `pending`
non-empty means the receive path is writing those very files; `serving` non-empty means the disk is
busy for the transfer. Not hooked into the scanner, because the candidate set only exists *in this
message*: no per-peer index is persisted (`onPeerIndex` builds a request-local Map and drops it), so
outside a round there is nothing to compare declarations against. The cost is that the audit follows
index traffic rather than the clock; that direction is safe, since a device exchanging no index
changes is not accumulating divergence.

**Report only. This is the load-bearing decision.** A detection produces a log line and nothing
else:

```
audit folder=<id> peer=<dev> round=<n> candidates=<c> sampled=<s> declared=<a> disk=<b> unreadable=<u>
drift folder=<id> peer=<dev> disk <path> slot=<i>: slot[i] declared abcd1234… != on disk ff00ee11…
```

Repair is refused for v1 for three reasons:

1. **Fixing means choosing a winner, and the choice is the one fact a detection does not supply.**
   Check A says two devices disagree about bytes while both believe their own index; nothing in the
   evidence ranks the two copies. Check B says the local index lies about local disk — and the
   honest repair there ("re-index from disk") is a scan, which is not a sentinel's business and
   would run anyway on the next real change.
2. **The plausible-looking safe subset is not safe.** "Convert it to a conflict" stays inside the
   existing vocabulary, but conflict resolution is *also* version-based, so forcing it means
   bumping our own version — asserting authority over bytes we may not have. If the local index is
   the liar, that assertion pushes the wrong content to every device that trusts us, turning one
   bad copy into a fleet-wide one. The write this destroys user data is the one made on a guess.
3. **We do not yet know which side is usually wrong.** Until a detection sample exists, a repair is
   a guess with unrecoverable consequences; a log line is a guess with a grep. The first real
   findings decide what the fix should be — that is the precondition for revisiting this, not a
   timer.

**`unreadable` is a first-class verdict, never counted as drift**: file absent, path rejected, CDC
view incomplete, slot out of range, and — the one that actually bites — *the local index is known
stale for that path*. That last judgment reuses `isUnchanged` (`src/scanner.ts:22`), the scanner's
own hash-free fast-path predicate, rather than re-deriving it: one answer in the codebase to "does
this entry still represent this disk". `verifySampledSlots` never throws; a sample it cannot read is
a sample it did not check.

## Consequences

- **A round with nothing to audit still reports.** `candidates=0 sampled=0` is printed anyway,
  because "no drift" and "the sentinel never ran" must not be the same log. The counters are the
  negative control for the whole feature.
- **Nothing reaches the UI.** Not `folderErrors`: that channel holds one slot per folder and a clean
  scan clears it, so a finding raised once per half hour would flash and vanish. The log is the
  surface for v1; a status-line or history entry needs a consumer that does not exist yet.
- **A narrow false-positive window is accepted**: a local save landing within `MTIME_TOLERANCE_MS`
  (2 s) of the stat that produced the entry, same size, can raise one `disk` line that the next scan
  resolves on its own. Tightening it to a strict `mtime >` comparison would disable check B entirely
  on FAT/exFAT shares, where every re-stat reads up to 2 s newer than the recorded value.
- **Blind (e2e) peers are not audited**: `onPeerIndex` returns before any of this when `e2eKey` is
  set (`src/peer.ts:1047`), which is correct — a blind peer declares ciphertext-view hashes, and
  comparing those against the plaintext disk would report every path as drift.
- **Coverage is a rotation, not a guarantee**: at 8 paths per round, a file is audited about once
  per `(N/8) × interval`. Three cases stay invisible by design: a path never sampled in the window,
  a fork where both devices' disks agree with their own declarations *and* the declarations are
  identical (nothing disagrees — only an out-of-band comparison to a known-good copy would catch
  it), and anything a blind peer holds.
- **Mixed-version fleet support is a property of the design, not an add-on**: check A reads the
  declarations old peers already send, so the sentinel works from the upgraded side alone. Nothing
  announces it and nothing can disagree about it.
- Deferred, and blocked on the first real detection rather than on a date: repair policy, a
  sampling-rate knob in config, an audit surface in the web UI, and cross-checking a third device.
