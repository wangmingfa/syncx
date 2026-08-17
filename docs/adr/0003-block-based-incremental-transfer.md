# Block-based incremental transfer (1MB blocks, SHA-256)

File changes are synced by transferring only changed blocks: files are split into fixed 1MB blocks addressed by SHA-256 content hash, and peers request only blocks they lack. We deliberately chose 1MB blocks rather than Syncthing's 128KiB to keep index and hashing overhead low for typical personal files, accepting some extra re-transfer waste on large files; SHA-256 uses Node's built-in crypto so no dependency is added. Whole-file transfer was rejected because a one-byte change to a large file would resend everything.
