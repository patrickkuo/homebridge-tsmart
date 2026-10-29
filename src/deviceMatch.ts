/** Normalize heater display names for fuzzy equality checks. */
export function normalizeDeviceName(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, ' ');
}

/**
 * True when two names likely refer to the same heater.
 * Empty / placeholder names do not count as a match on their own.
 */
export function deviceNamesMatch(a: string, b: string): boolean {
  const left = normalizeDeviceName(a);
  const right = normalizeDeviceName(b);
  if (!left || !right) {
    return false;
  }
  return left === right;
}

/** Case-insensitive deviceId equality. Missing ids never match. */
export function deviceIdsMatch(
  a: string | undefined,
  b: string | undefined,
): boolean {
  if (!a || !b) {
    return false;
  }
  return a.toUpperCase() === b.toUpperCase();
}

/** True when mode toggle lists are the same sequence. */
export function modeListsEqual(
  a: string[] | undefined,
  b: string[] | undefined,
): boolean {
  if (a === b) {
    return true;
  }
  if (!a || !b || a.length !== b.length) {
    return false;
  }
  return a.every((id, index) => id === b[index]);
}
