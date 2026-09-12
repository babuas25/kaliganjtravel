/**
 * Cabin classes, exactly as the Triplover API defines them (doc §3.3).
 *
 * This is the single source of truth: the traveller popup renders these labels,
 * and the search request sends the matching integer. The panel used to offer a
 * seven-rung ladder with combined rungs ("Economy/Premium Economy"), which the
 * API has no value for — those are gone, because a rung the supplier cannot be
 * told about is a rung that silently searches something else.
 *
 * Client-safe: pure data, no secrets, no server imports. `lib/triplover/*` is
 * the server-only half and imports from here rather than redeclaring it.
 */

export const CABIN_CLASSES = [
  { value: 1, label: 'Economy' },
  { value: 2, label: 'Premium Economy' },
  { value: 3, label: 'Business' },
  { value: 4, label: 'First' },
  { value: 5, label: 'Premium First' },
] as const;

export type CabinClassValue = (typeof CABIN_CLASSES)[number]['value'];
export type CabinClassLabel = (typeof CABIN_CLASSES)[number]['label'];

export const DEFAULT_CABIN_CLASS: CabinClassLabel = 'Economy';

const VALUE_BY_LABEL = new Map<string, CabinClassValue>(
  CABIN_CLASSES.map((c) => [c.label, c.value])
);

/** Label shown in the traveller popup → the integer the API expects. */
export function cabinClassValue(label: string): CabinClassValue {
  return VALUE_BY_LABEL.get(label) ?? 1;
}

export function isCabinClassValue(value: unknown): value is CabinClassValue {
  return CABIN_CLASSES.some((c) => c.value === value);
}
