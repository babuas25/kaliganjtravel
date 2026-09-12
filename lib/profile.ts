import type { Role } from '@/lib/roles';

/**
 * Shape of the dashboard profile, and how it groups on screen.
 *
 * Every role fills the same personal, passport and contact details. B2B
 * partners additionally supply agency information and business documents.
 *
 * This file is the single description of the form's shape; `lib/db/profiles.ts`
 * maps it to columns mechanically, so the two cannot drift. Text fields persist
 * to Postgres today — the document uploads do not yet.
 */

export const GENDER_OPTIONS = [
  { value: 'male', label: 'Male' },
  { value: 'female', label: 'Female' },
  { value: 'other', label: 'Other' },
] as const;

export const PROFILE_FIELDS = [
  // Personal
  'givenName',
  'surname',
  'gender',
  'dateOfBirth',
  'address',
  // Passport
  'nationality',
  'passportNo',
  'passportExpiry',
  // Contact
  'mobile',
  'email',
  // Business info (B2B only)
  'agencyName',
  'agencyLicenseNo',
  'agencyAddress',
  'agencyEmail',
  'agencyMobile',
  'website',
  'facebookPage',
  // Business documents (B2B only)
  'tradeLicense',
  'tinCertificate',
  'travelAgencyLicense',
  'nidCard',
  'logo',
  // Bank account (B2B and customers)
  'bankName',
  'accountName',
  'accountNumber',
  'routingNumber',
  'swiftCode',
  'branchCode',
] as const;

export type ProfileField = (typeof PROFILE_FIELDS)[number];

/**
 * The agency identity fields a B2B account may establish once but may not
 * replace later from its own profile. Managers use the separate Users & Roles
 * action, where these remain editable.
 */
export const AGENCY_IDENTITY_FIELDS = ['agencyName', 'agencyEmail'] as const;
export type AgencyIdentityField = (typeof AGENCY_IDENTITY_FIELDS)[number];

/**
 * The B2B document uploads. Files, not text — they need a private bucket and
 * signed URLs, so they are excluded from the database round-trip, from the
 * completion meter and from the required-field check until that lands.
 * Leaving them in would strand a B2B partner below 100% forever.
 */
export const FILE_FIELDS: readonly ProfileField[] = [
  'tradeLicense',
  'tinCertificate',
  'travelAgencyLicense',
  'nidCard',
  'logo',
];

/** Fields with a column in `user_profiles` — everything except the uploads. */
export const PERSISTED_FIELDS = PROFILE_FIELDS.filter(
  (field) => !FILE_FIELDS.includes(field)
);

export function isFileField(field: ProfileField): boolean {
  return FILE_FIELDS.includes(field);
}

/**
 * Every value the form holds. File fields keep the chosen filename until real
 * uploads exist, so one string map covers the whole form.
 */
export type ProfileValues = Record<ProfileField, string>;

export const EMPTY_PROFILE: ProfileValues = Object.fromEntries(
  PROFILE_FIELDS.map((field) => [field, ''])
) as ProfileValues;

export type FieldType =
  | 'text'
  | 'select'
  | 'textarea'
  | 'date'
  | 'tel'
  | 'email'
  | 'url'
  | 'file';

export type FieldSpec = {
  name: ProfileField;
  label: string;
  type: FieldType;
  /** Browser autofill hint; omitted where no standard token fits. */
  autoComplete?: string;
  placeholder?: string;
  /** True for fields that take the full row rather than half of it. */
  wide?: boolean;
  uppercase?: boolean;
  /** File fields only: accepted types, and the hint shown in the drop zone. */
  accept?: string;
  accepts?: string;
};

export type SectionId =
  | 'personal'
  | 'passport'
  | 'contact'
  | 'business'
  | 'documents'
  | 'bank';

export type SectionSpec = {
  id: SectionId;
  title: string;
  hint: string;
  fields: readonly FieldSpec[];
};

const DOC_ACCEPT = 'application/pdf,image/*';

/** Filled by every role. */
export const SHARED_SECTIONS: readonly SectionSpec[] = [
  {
    id: 'personal',
    title: 'Personal Details',
    hint: 'Must match your passport exactly — tickets are issued from this.',
    fields: [
      {
        name: 'givenName',
        label: 'Given Name',
        type: 'text',
        autoComplete: 'given-name',
      },
      {
        name: 'surname',
        label: 'Surname',
        type: 'text',
        autoComplete: 'family-name',
      },
      { name: 'gender', label: 'Gender', type: 'select' },
      {
        name: 'dateOfBirth',
        label: 'Date of Birth',
        type: 'date',
        autoComplete: 'bday',
      },
      {
        name: 'address',
        label: 'Address',
        type: 'textarea',
        autoComplete: 'street-address',
        wide: true,
      },
    ],
  },
  {
    id: 'passport',
    title: 'Passport',
    hint: 'Travel document details, as printed on the photo page.',
    fields: [
      {
        name: 'nationality',
        label: 'Nationality',
        type: 'text',
        autoComplete: 'country-name',
      },
      {
        name: 'passportNo',
        label: 'Passport No.',
        type: 'text',
        uppercase: true,
      },
      { name: 'passportExpiry', label: 'Date of Expiry', type: 'date' },
    ],
  },
  {
    id: 'contact',
    title: 'Contact',
    hint: 'Where booking confirmations and travel updates are sent.',
    fields: [
      {
        name: 'mobile',
        label: 'Mobile',
        type: 'tel',
        autoComplete: 'tel',
        placeholder: '+880 1XXX XXXXXX',
      },
      { name: 'email', label: 'Email', type: 'email', autoComplete: 'email' },
    ],
  },
];

/** Filled by B2B partners only, in addition to the shared sections. */
export const BUSINESS_SECTIONS: readonly SectionSpec[] = [
  {
    id: 'business',
    title: 'Business Info',
    hint: 'Your agency as it should appear on invoices and itineraries.',
    fields: [
      { name: 'agencyName', label: 'Agency Name', type: 'text' },
      {
        name: 'agencyLicenseNo',
        label: 'License No.',
        type: 'text',
        placeholder: 'Your travel agency licence number',
      },
      {
        name: 'agencyAddress',
        label: 'Agency Address',
        type: 'textarea',
        wide: true,
      },
      { name: 'agencyEmail', label: 'Agency Email', type: 'email' },
      {
        name: 'agencyMobile',
        label: 'Mobile',
        type: 'tel',
        placeholder: '+880 1XXX XXXXXX',
      },
      {
        name: 'website',
        label: 'Website',
        type: 'url',
        placeholder: 'https://example.com',
      },
      {
        name: 'facebookPage',
        label: 'Facebook Page',
        type: 'url',
        placeholder: 'https://facebook.com/yourpage',
      },
    ],
  },
  {
    id: 'documents',
    title: 'Business Docs',
    hint: 'Clear scans or photos, PDF or image. Each one saves as soon as you pick it — the Save button covers the rest of the page. Only you and our team can open them.',
    fields: [
      {
        name: 'tradeLicense',
        label: 'Trade License',
        type: 'file',
        accept: DOC_ACCEPT,
        accepts: 'PDF or image',
      },
      {
        name: 'tinCertificate',
        label: 'TIN Certificate',
        type: 'file',
        accept: DOC_ACCEPT,
        accepts: 'PDF or image',
      },
      {
        name: 'travelAgencyLicense',
        label: 'Travel Agency License',
        type: 'file',
        accept: DOC_ACCEPT,
        accepts: 'PDF or image',
      },
      {
        name: 'nidCard',
        label: 'NID Card',
        type: 'file',
        accept: DOC_ACCEPT,
        accepts: 'Both sides, PDF or image',
      },
      {
        name: 'logo',
        label: 'Logo',
        type: 'file',
        accept: 'image/*',
        accepts: 'PNG or SVG, square works best',
      },
    ],
  },
];

/** Filled by whoever gets paid out — B2B partners and customers. */
export const BANK_SECTION: SectionSpec = {
  id: 'bank',
  title: 'Bank Account',
  hint: 'Where refunds and payouts are sent. Must match your bank records.',
  fields: [
    { name: 'bankName', label: 'Bank Name', type: 'text' },
    { name: 'accountName', label: 'Account Name', type: 'text' },
    { name: 'accountNumber', label: 'Account Number', type: 'text' },
    { name: 'routingNumber', label: 'Routing Number', type: 'text' },
    { name: 'swiftCode', label: 'Swift Code', type: 'text', uppercase: true },
    { name: 'branchCode', label: 'Branch Code', type: 'text' },
  ],
};

/**
 * Roles working inside a B2B agency. A sub user fills the same form as the
 * partner, business sections included — the agency's details are the agency's,
 * and either of them may be the one to keep them current.
 *
 * Note this puts the agency's bank account within reach of its staff. That is
 * the agreed behaviour: the sub user's dashboard is the partner's dashboard
 * apart from Sub User management. Narrowing it later means a read-only mode in
 * ProfileDetailsForm, not a change here.
 */
export const AGENCY_ROLES: readonly Role[] = ['b2b', 'b2b_sub'];

/**
 * Whether this role has the Business Docs section at all — the gate on every
 * document upload action.
 *
 * Exported because a server action cannot infer it from the payload: the file
 * arrives with a field name, and only the role says whether that person has
 * such a field.
 */
export function canUploadBusinessDocs(role: Role): boolean {
  return AGENCY_ROLES.includes(role);
}

/** Roles that keep a bank account on file. */
const BANK_ROLES: readonly Role[] = [...AGENCY_ROLES, 'customer'];

/** The sections a given role has to fill. */
export function sectionsFor(role: Role): readonly SectionSpec[] {
  const sections = [...SHARED_SECTIONS];

  if (AGENCY_ROLES.includes(role)) sections.push(...BUSINESS_SECTIONS);
  if (BANK_ROLES.includes(role)) sections.push(BANK_SECTION);

  return sections;
}

export type TabSpec = {
  id: string;
  label: string;
  sections: readonly SectionId[];
};

/**
 * The Staff tab, which is unlike every other one here.
 *
 * It holds **no `user_profiles` sections** — it edits `staff_details`, a
 * separate table — so its `sections` list is empty and the form renders a
 * dedicated panel in its place. Two consequences worth keeping:
 *
 * - staff fields never enter the profile completion meter, which counts the
 *   fields in `sectionsFor(role)`. For a B2B admin they are somebody else's
 *   fields entirely, so counting them would put their own profile permanently
 *   short of 100%.
 * - the panel sits **outside** the profile `<form>`. It writes other people's
 *   records through its own action, and a nested form is invalid HTML anyway.
 */
export const STAFF_TAB_ID = 'staff';

/** Sections grouped into the page's tab strip. */
export function tabsFor(role: Role): TabSpec[] {
  const tabs: TabSpec[] = [
    { id: 'basic', label: 'Basic', sections: ['personal', 'contact'] },
    { id: 'passport', label: 'Passport', sections: ['passport'] },
  ];

  if (AGENCY_ROLES.includes(role)) {
    tabs.push(
      { id: 'business', label: 'Business Info', sections: ['business'] },
      { id: 'documents', label: 'Business Docs', sections: ['documents'] }
    );
  }

  if (BANK_ROLES.includes(role)) {
    tabs.push({ id: 'bank', label: 'Bank', sections: ['bank'] });
  }

  // Named for what the role actually sees: an admin gets the agency's roster,
  // a sub user gets the one record that is theirs. Calling both "Staff List"
  // would promise a sub user a list they are not allowed to have.
  if (AGENCY_ROLES.includes(role)) {
    tabs.push({
      id: STAFF_TAB_ID,
      label: role === 'b2b' ? 'Staff List' : 'My Staff Details',
      sections: [],
    });
  }

  return tabs;
}

/** Heading for the page banner, matching the role's sidebar label. */
export function profileTitleFor(role: Role): string {
  if (AGENCY_ROLES.includes(role)) return 'Company Profile';
  if (role.startsWith('staff_')) return 'Staff Profile';
  return 'User Profile';
}
