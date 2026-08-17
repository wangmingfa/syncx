# Per-file version vectors for conflict detection

Each file carries a version vector — one monotonically increasing counter per device that modified it — and two concurrent edits yield non-comparable vectors, which is detected as a conflict rather than resolved by timestamp or last-writer-wins. Timestamps were rejected because they depend on clock skew across devices; a lost update is silently corrupting data, so the vector model plus conflict copies and tombstones (never silently discarding either side) is the project's core data-integrity promise.
