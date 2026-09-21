# ADR-0016: Directory ignore rules match at any depth (gitignore conformance)

## Status

Accepted. Corrects a matching bug in `src/ignore.ts` that existed since user ignore rules were
introduced; it is not a change of intent, but the intent (gitignore semantics) was never met for
directory-only patterns.

## Context

A shared folder using `.gitignore` to keep build output out of the sync was still syncing it:

```
# /Volumes/share/.gitignore
node_modules/
```

The sync history on the other device showed `admin/node_modules/estree-walker/**`,
`admin/node_modules/.vite/deps/**` and friends arriving as plain additions, while the root-level
`node_modules/` was correctly held back.

The asymmetry pointed at the matcher rather than the gates. `ruleMatches` had a dedicated branch
for directory rules (`pattern.endsWith('/')`) that compared **literal strings**:

```ts
if (dirOnly) {
  return relPath === pattern || relPath.startsWith(`${pattern}/`);
}
```

Two gitignore rules were consequently missing:

1. **A pattern without a separator matches at any level.** Only `*`, `?` and a leading `/` are
   special; whether the pattern contains a `/` (other than a trailing one) decides between
   "any depth" and "relative to the .gitignore directory". The literal-prefix compare implements
   "relative to the root" for *every* directory rule, so `node_modules/` could only ever match the
   top-level directory. `admin/node_modules/…` never matched, on either side of the wire — the
   scanner recursed into it and indexed it, and the inbound gate in `peer.onPeerIndex`
   (ADR-0012) failed to drop what the peer sent.
2. **Directory rules are not wildcard-free.** Because the branch never consulted the compiled
   regex, patterns such as `**/tmp/` or `node_*/` were dead code: they compiled fine and matched
   nothing.

`isDir` was accepted by `isIgnored` but deliberately ignored ("判定只看规则自身是否以 `/` 结尾"),
so the one piece of information needed to tell "an ignored directory itself" from "a file that
happens to share its name" was already being passed in and thrown away.

## Decision

1. **Directory rules match by walking the path's directory prefixes**, each prefix tested with the
   same semantics as any other pattern (`anchored || contains a slash` → full relative path;
   otherwise → any level). Prefixes rather than the whole path, because ignore-the-directory means
   ignore-everything-under-it while our input is a *file* path: `admin/node_modules/pkg/index.js`
   matches through the prefix `admin/node_modules`.
2. **The last segment only counts as an ignored directory when the target really is one.** `isDir`
   is now load-bearing: `node_modules/` does not match a *file* named `node_modules`, exactly as in
   git. Call sites already pass it correctly (`scanner` from the `Dirent`; index and peer paths are
   files).
3. **`matchIgnoreRule` takes `isDir` (default `false`)** so the diff report explains a path with the
   same rule the sync gates would use, instead of drifting from `isIgnored`.
4. **gitignore is the specification.** Matching changes are validated by diffing our answers against
   real `git check-ignore` over a matrix of patterns and paths, not by reasoning about the regex.
   Paths are compared on both separators (`\` accepted) as before.

## Consequences

- `.gitignore` and `.syncxignore` behave the way users already expect from git. Nested build output,
  nested `node_modules`, and wildcard directory rules such as `**/tmp/` are all held back.
- Adding a rule still does **not** clean either side's index or disk (ADR-0012). Fixing the matcher
  stops *future* propagation of `admin/node_modules/**`, but the copies already written to the other
  device stay there, no tombstone is emitted for them (ignored paths never produce one), and the
  index rows still count toward "索引条目 N". Cleaning up means deleting the stray directory by hand,
  or removing and re-adding the folder with the index purge on both sides.
- Anchored rules keep their meaning: `admin/dist/` still only matches that path under the shared
  root, so `a/b/admin/dist/` is unaffected — this was already right and is now covered by a test.
- Cost: directory rules now do up to one regex test per path segment instead of a single prefix
  compare. Literal directory names (the overwhelmingly common case, e.g. `node_modules/`,
  `dist/`) take a string-equality fast path, and the compiled-regex cache is unchanged.
- Regression tests: `test/ignore.test.ts` (any-depth directory rule, including that it does not
  match a same-named file and does not catch `node_modules_backup`; internal-slash anchoring;
  wildcards inside directory rules) and `test/scanner-paths.test.ts` (a nested `node_modules` is
  pruned, and an index row under it produces **no tombstone** — otherwise the peer would be told to
  delete a file the user never meant to touch). All three fail against the previous matcher.
