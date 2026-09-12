import type { TriploverSupplier } from '@/lib/triplover/config';

const SUPPLIER_LOCAL_TIMESTAMP =
  /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})(?:\.(\d+))?$/;
const EXPLICIT_TIME_ZONE = /(?:Z|[+-]\d{2}:?\d{2})$/i;

/**
 * FirstTrip and TakeOff lifecycle dates are Bangladesh wall-clock values when
 * their response omits an offset. Convert that contract into an explicit
 * instant before using Date so parsing never depends on the server timezone.
 * Explicit supplier offsets remain authoritative.
 */
export function supplierLifecycleInstant(
  _supplier: TriploverSupplier,
  value: unknown,
): string | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  const normalized = value.trim();
  let timestamp = normalized;

  if (!EXPLICIT_TIME_ZONE.test(normalized)) {
    const local = SUPPLIER_LOCAL_TIMESTAMP.exec(normalized);
    if (!local) return null;
    const fraction = local[3]
      ? `.${local[3].slice(0, 3).padEnd(3, '0')}`
      : '';
    timestamp = `${local[1]}T${local[2]}${fraction}+06:00`;
  }

  const parsed = Date.parse(timestamp);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}
