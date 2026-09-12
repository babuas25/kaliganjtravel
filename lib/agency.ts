/**
 * The agency code — the identity of a B2B agency.
 *
 * `ST-B2B` followed by six digits, e.g. `ST-B2B513548`. It is what ties a
 * partner to their sub users, and it is deliberately readable: it can be
 * quoted to support over the phone, printed on a report, and searched for.
 *
 * Nothing in this file knows about the authentication provider, the database
 * or the request. The format lives here and in the `check` constraint in
 * `0002_agencies_and_sub_users.sql`, and nowhere else.
 */

export const AGENCY_CODE_PREFIX = 'ST-B2B';

/** Digits after the prefix. Six, as agreed — ~900k codes. */
const DIGITS = 6;

export const AGENCY_CODE_PATTERN = new RegExp(
  `^${AGENCY_CODE_PREFIX}\\d{${DIGITS}}$`
);

const FIRST = 10 ** (DIGITS - 1); // 100000
const RANGE = 9 * FIRST; // 100000–999999

/**
 * A candidate code. Random rather than sequential: a sequence would leak how
 * many agencies exist and make one code guessable from another.
 *
 * Uniqueness is **not** established here — it cannot be, without a race. The
 * caller inserts this against a primary key and asks for another on conflict.
 * See `ensureAgency()` in `lib/db/agencies.ts`.
 *
 * The low bound skips leading zeros so every code is the same length on
 * screen; the cost is the 000000–099999 tenth of the space, which at this
 * scale is not worth the ragged column.
 */
export function generateAgencyCode(): string {
  return `${AGENCY_CODE_PREFIX}${FIRST + Math.floor(Math.random() * RANGE)}`;
}

/**
 * Whether a value is a well-formed agency code.
 *
 * Used before a code that arrived from outside the database — the provider's
 * user metadata, an invitation — is allowed anywhere near a query.
 */
export function isAgencyCode(value: unknown): value is string {
  return typeof value === 'string' && AGENCY_CODE_PATTERN.test(value);
}

/**
 * One agency, as a picker offers it.
 *
 * Declared here rather than beside `listAgencies()` so client components can
 * import the type without reaching into a module that builds a service-role
 * database client.
 */
export type AgencyOption = {
  agencyCode: string;
  /** The agency's business name, its owner's email, or '' — best available. */
  label: string;
};

/** How an agency reads in a dropdown: name first where there is one. */
export function agencyOptionLabel(option: AgencyOption): string {
  return option.label
    ? `${option.label} — ${option.agencyCode}`
    : option.agencyCode;
}
