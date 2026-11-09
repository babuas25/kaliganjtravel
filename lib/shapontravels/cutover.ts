import 'server-only';

// The temporary bridge keeps the old Shapon writers away from the migrated schema.
export function shaponCutoverPaused(supplier: string | null | undefined): boolean {
  return supplier === 'shapontravels';
}

export const SHAPON_CUTOVER_FAILURE = [
  503,
  'SHAPONTRAVELS_MAINTENANCE',
  'Shapon booking actions are temporarily unavailable for maintenance. Please try again shortly.',
] as const;
