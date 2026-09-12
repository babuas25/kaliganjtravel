/**
 * The staff record — employment details for a sub user inside an agency.
 *
 * Separate from `lib/profile.ts` on purpose. That file describes a person's own
 * travel identity, filled in by them and counted towards their profile
 * completion; this describes their place in an agency, and either they or their
 * B2B admin may keep it current.
 *
 * Pure: no database, no auth provider, no request. Column names in
 * `staff_details` are the snake_case of the field names below, and
 * `lib/db/staff.ts` converts between them mechanically — so adding a field here
 * plus a column of the matching name is the whole change.
 */

export const STAFF_FIELDS = [
  'designation',
  'email',
  'phone',
  'alternativePhone',
  'address',
  'qualification',
] as const;

export type StaffField = (typeof STAFF_FIELDS)[number];

export type StaffValues = Record<StaffField, string>;

export const EMPTY_STAFF: StaffValues = Object.fromEntries(
  STAFF_FIELDS.map((field) => [field, ''])
) as StaffValues;

export type StaffFieldSpec = {
  name: StaffField;
  label: string;
  type: 'text' | 'email' | 'tel' | 'textarea';
  placeholder?: string;
  /** True for fields that take the full row rather than half of it. */
  wide?: boolean;
};

export const STAFF_FIELD_SPECS: readonly StaffFieldSpec[] = [
  { name: 'designation', label: 'Designation', type: 'text', placeholder: 'Ticketing Officer' },
  { name: 'email', label: 'Email', type: 'email' },
  { name: 'phone', label: 'Phone', type: 'tel', placeholder: '+880 1XXX XXXXXX' },
  {
    name: 'alternativePhone',
    label: 'Alternative Phone',
    type: 'tel',
    placeholder: '+880 1XXX XXXXXX',
  },
  { name: 'qualification', label: 'Qualification', type: 'text' },
  { name: 'address', label: 'Address', type: 'textarea', wide: true },
];

/** Longest value any single field accepts. Address is the demanding one. */
export const MAX_STAFF_LENGTH = 500;

/** `alternativePhone` → `alternative_phone`. */
export function toStaffColumn(field: StaffField): string {
  return field.replace(/[A-Z]/g, (char) => `_${char.toLowerCase()}`);
}

/** Whether anything has been filled in — an all-blank record is no record. */
export function hasStaffValues(values: StaffValues): boolean {
  return STAFF_FIELDS.some((field) => values[field].trim() !== '');
}

/**
 * Narrows an arbitrary payload to the known fields.
 *
 * A server action is a public endpoint, so the shape that arrives is a claim.
 * Driven by `STAFF_FIELDS` rather than by what was sent, so an unexpected key
 * can never reach a column.
 */
export function coerceStaffValues(input: unknown): StaffValues {
  const source = (input ?? {}) as Record<string, unknown>;
  const values = { ...EMPTY_STAFF };

  for (const field of STAFF_FIELDS) {
    const raw = source[field];
    if (typeof raw === 'string') values[field] = raw;
  }
  return values;
}
