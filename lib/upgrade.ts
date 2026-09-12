/**
 * The customer → B2B upgrade request — what a customer fills in when they press
 * "Upgrade to Business", and what an admin reads before accepting it.
 *
 * Separate from `lib/profile.ts` and `lib/staff.ts` on purpose. A profile is
 * current truth its owner edits freely; this is an *application*, fixed at the
 * moment it was submitted, which is exactly what makes it reviewable.
 *
 * Pure: no database, no auth provider, no request. Safe to import from a client
 * component. Column names in `upgrade_requests` are the snake_case of the field
 * names below and `lib/db/upgrade-requests.ts` converts between them
 * mechanically — so adding a field here plus a column of the matching name is
 * the whole change.
 */

import type { StoredDoc } from '@/lib/documents';

export const UPGRADE_FIELDS = [
  // Business info
  'agencyName',
  'businessMobile',
  'businessEmail',
  'businessAddress',
  // Personal info
  'fullName',
  'businessType',
  'personalMobile',
  'personalAddress',
] as const;

export type UpgradeField = (typeof UPGRADE_FIELDS)[number];

export type UpgradeValues = Record<UpgradeField, string>;

export const EMPTY_UPGRADE: UpgradeValues = Object.fromEntries(
  UPGRADE_FIELDS.map((field) => [field, ''])
) as UpgradeValues;

/* ── Business type ─────────────────────────────────────────────── */

/**
 * How the business is constituted. A closed set rather than free text: the
 * reviewer reads it at a glance, and the database has a matching `check`.
 */
export const BUSINESS_TYPES = ['proprietor', 'partner'] as const;

export type BusinessType = (typeof BUSINESS_TYPES)[number];

export const BUSINESS_TYPE_LABELS: Record<BusinessType, string> = {
  proprietor: 'Proprietor',
  partner: 'Partner',
};

export function isBusinessType(value: unknown): value is BusinessType {
  return BUSINESS_TYPES.includes(value as BusinessType);
}

/* ── Form layout ───────────────────────────────────────────────── */

export type UpgradeFieldSpec = {
  name: UpgradeField;
  label: string;
  type: 'text' | 'email' | 'tel' | 'textarea' | 'radio';
  placeholder?: string;
  /** True for fields that take the full row rather than half of it. */
  wide?: boolean;
};

export type UpgradeSection = {
  title: string;
  hint: string;
  fields: readonly UpgradeFieldSpec[];
};

export const UPGRADE_SECTIONS: readonly UpgradeSection[] = [
  {
    title: 'Business Info',
    hint: 'The agency this account would trade as.',
    fields: [
      {
        name: 'agencyName',
        label: 'Agency Name',
        type: 'text',
        placeholder: 'Kaliganj Travels',
      },
      {
        name: 'businessMobile',
        label: 'Mobile',
        type: 'tel',
        placeholder: '+880 1XXX XXXXXX',
      },
      { name: 'businessEmail', label: 'Email', type: 'email' },
      {
        name: 'businessAddress',
        label: 'Address',
        type: 'textarea',
        wide: true,
      },
    ],
  },
  {
    title: 'Personal Info',
    hint: 'The person who would own the agency account.',
    fields: [
      { name: 'fullName', label: 'Full Name', type: 'text' },
      { name: 'businessType', label: 'Business Type', type: 'radio' },
      {
        name: 'personalMobile',
        label: 'Mobile',
        type: 'tel',
        placeholder: '+880 1XXX XXXXXX',
      },
      {
        name: 'personalAddress',
        label: 'Address',
        type: 'textarea',
        wide: true,
      },
    ],
  },
];

/** Longest value any single field accepts. Address is the demanding one. */
export const MAX_UPGRADE_LENGTH = 500;

/* ── Supporting documents ──────────────────────────────────────── */

/**
 * Optional, and genuinely optional: an application with no attachments is
 * submitted, reviewed and accepted exactly like one carrying five. They are
 * evidence an admin may want, not a condition of applying.
 *
 * The formats and size limit are in `lib/upload-verify.ts`, shared with every
 * other upload in the application.
 */
export const MAX_UPGRADE_DOCS = 5;

/* ── Status ────────────────────────────────────────────────────── */

export const UPGRADE_STATUSES = ['pending', 'accepted', 'rejected'] as const;

export type UpgradeStatus = (typeof UPGRADE_STATUSES)[number];

export function isUpgradeStatus(value: unknown): value is UpgradeStatus {
  return UPGRADE_STATUSES.includes(value as UpgradeStatus);
}

/** One submitted application, as everything outside the database sees it. */
export type UpgradeRequest = {
  userId: string;
  values: UpgradeValues;
  /** Cloudinary handles, never URLs — see `lib/documents.ts`. */
  documents: StoredDoc[];
  status: UpgradeStatus;
  reviewedBy: string | null;
  /** Epoch ms, or null while pending. */
  reviewedAt: number | null;
  reviewNote: string | null;
  createdAt: number;
  updatedAt: number;
};

/* ── Validation ────────────────────────────────────────────────── */

/** `businessMobile` → `business_mobile`. */
export function toUpgradeColumn(field: UpgradeField): string {
  return field.replace(/[A-Z]/g, (char) => `_${char.toLowerCase()}`);
}

/**
 * Narrows an arbitrary payload to the known fields.
 *
 * A server action is a public endpoint, so the shape that arrives is a claim.
 * Driven by `UPGRADE_FIELDS` rather than by what was sent, so an unexpected key
 * can never reach a column.
 */
export function coerceUpgradeValues(input: unknown): UpgradeValues {
  const source = (input ?? {}) as Record<string, unknown>;
  const values = { ...EMPTY_UPGRADE };

  for (const field of UPGRADE_FIELDS) {
    const raw = source[field];
    if (typeof raw === 'string') values[field] = raw;
  }
  return values;
}

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Why this application cannot be submitted, or null when it can.
 *
 * **Every field here is required**, which is the opposite of the profile form —
 * and deliberately so. A profile is filled in over time by the person it
 * describes; an application is read once by somebody deciding on it, and a
 * half-filled one wastes both their time and the applicant's. The one optional
 * part is the documents.
 *
 * Shared by the form (which disables Submit) and the server action (which
 * refuses the write), so the two cannot disagree about what is complete.
 */
export function upgradeBlockedReason(values: UpgradeValues): string | null {
  for (const section of UPGRADE_SECTIONS) {
    for (const spec of section.fields) {
      const value = values[spec.name].trim();

      if (!value) return `${section.title}: ${spec.label} is required.`;
      if (value.length > MAX_UPGRADE_LENGTH) {
        return `${section.title}: ${spec.label} is too long.`;
      }
      if (spec.type === 'email' && !EMAIL_PATTERN.test(value)) {
        return `${section.title}: enter a valid ${spec.label.toLowerCase()}.`;
      }
    }
  }

  if (!isBusinessType(values.businessType)) {
    return 'Personal Info: choose Proprietor or Partner.';
  }

  return null;
}
