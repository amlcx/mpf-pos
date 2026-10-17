/** Register versions are plain X.Y.Z, as set from the release tag. */
export const VERSION_PATTERN = /^\d{1,6}\.\d{1,6}\.\d{1,6}$/;

/** True when `candidate` is a higher X.Y.Z than `current`. Compares numbers, so 1.10.0 > 1.9.0. */
export function isNewerVersion(candidate: string, current: string): boolean {
  const a = candidate.split('.').map(Number);
  const b = current.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if (a[i]! !== b[i]!) return a[i]! > b[i]!;
  }
  return false;
}
