/** Reject carrier-only tokens (for example BG, BS or 2A), not just blanks.
 * Keep locator formats otherwise unrestricted for the supported suppliers.
 */
export function airlinePnrs(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return Array.from(new Set(value
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim())
    .filter((item) => item.length > 2)));
}
