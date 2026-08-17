/**
 * Version vector: one monotonically increasing counter per device.
 * Concurrent edits yield non-comparable vectors, which is a conflict.
 */
export type VersionVector = Map<string, number>;

export function createVersionVector(): VersionVector {
  return new Map();
}

export function incrementVersion(vector: VersionVector, deviceId: string): VersionVector {
  const next = new Map(vector);
  next.set(deviceId, (next.get(deviceId) ?? 0) + 1);
  return next;
}

export type VersionRelation = 'equal' | 'a-newer' | 'b-newer' | 'concurrent';

/**
 * Compare two version vectors.
 * `a-newer` means a dominates b, `b-newer` vice versa,
 * `equal` means identical, `concurrent` means neither dominates (a conflict).
 */
export function compareVersions(a: VersionVector, b: VersionVector): VersionRelation {
  let aDominates = true;
  let bDominates = true;

  const devices = new Set([...a.keys(), ...b.keys()]);
  for (const device of devices) {
    const aCount = a.get(device) ?? 0;
    const bCount = b.get(device) ?? 0;
    if (aCount < bCount) aDominates = false;
    if (bCount < aCount) bDominates = false;
  }

  if (aDominates && bDominates) return 'equal';
  if (aDominates) return 'a-newer';
  if (bDominates) return 'b-newer';
  return 'concurrent';
}

/**
 * Merge two version vectors by taking the per-device maximum.
 * Returns a new vector; the inputs are not mutated.
 */
export function mergeVersions(a: VersionVector, b: VersionVector): VersionVector {
  const merged = new Map(a);
  for (const [device, count] of b) {
    merged.set(device, Math.max(merged.get(device) ?? 0, count));
  }
  return merged;
}
