import 'server-only';

/**
 * Triplover configuration. **Server-only** — the credentials here are a partner
 * login, so this module must never be imported from a `'use client'` file. The
 * `server-only` import above turns a mistake into a build error rather than a
 * leaked password in the JS bundle.
 *
 * Read per call rather than at module scope, matching `lib/supabase/server.ts`,
 * so a value set at runtime on Vercel is picked up without a rebuild.
 */

export type TriploverConfig = {
  /** Named credential account used for authentication. */
  supplier: TriploverSupplier;
  /** Host for `POST /api/Search` only. */
  searchBaseUrl: string;
  /** Host for LogIn, FareRules, RePrice, Book, Cancel, NewTicket, reports. */
  baseUrl: string;
  email: string;
  /** Already base64-encoded by the provider. Passed through verbatim. */
  password: string;
};

export const TRIPLOVER_SUPPLIERS = ['firsttrip', 'takeoff', 'triplover'] as const;

export type TriploverSupplier = (typeof TRIPLOVER_SUPPLIERS)[number];

/** Accounts whose historical reference prefixes are supported by API import. */
export const TRIPLOVER_REFERENCE_IMPORT_SUPPLIERS = [
  'firsttrip',
  'takeoff',
  'triplover',
] as const;

export type TriploverReferenceImportSupplier =
  (typeof TRIPLOVER_REFERENCE_IMPORT_SUPPLIERS)[number];

/** Narrows a persisted supplier-account value before it can select credentials. */
export function isTriploverSupplier(value: unknown): value is TriploverSupplier {
  return (
    typeof value === 'string' &&
    TRIPLOVER_SUPPLIERS.includes(value.trim().toLowerCase() as TriploverSupplier)
  );
}

/**
 * Resolves one named supplier account. Selection is deliberately not read from
 * an environment variable: the database/Super Admin control chooses a supplier
 * for new searches, then that name is persisted with the workflow.
 */
export function triploverConfig(
  supplier: TriploverSupplier
): TriploverConfig | null {
  const prefix = supplier.toUpperCase();
  const searchBaseUrl = process.env[`${prefix}_SEARCH_BASE_URL`];
  const baseUrl = process.env[`${prefix}_BASE_URL`];
  const email = process.env[`${prefix}_EMAIL`];
  const password = process.env[`${prefix}_PASSWORD`];

  if (!searchBaseUrl || !baseUrl || !email || !password) return null;

  return {
    supplier,
    searchBaseUrl: searchBaseUrl.replace(/\/+$/, ''),
    baseUrl: baseUrl.replace(/\/+$/, ''),
    email,
    password,
  };
}

/** Drives the "flight search is unavailable" notice instead of a crash. */
export function isTriploverConfigured(supplier: TriploverSupplier): boolean {
  return triploverConfig(supplier) !== null;
}

/**
 * How long we wait on the supplier before giving up.
 *
 * Measured against UAT on 2026-07-28: a single one-way DAC→CXB search took
 * **57 seconds** end to end, and a round trip returning 66 offers took longer
 * still. The supplier fans out to several of its own sources and answers only
 * when the slowest has replied or timed out, so this is inherent, not a blip.
 *
 * Kept below the route handler's `maxDuration` so we return a clean error
 * instead of the platform killing the function mid-response.
 */
export const SUPPLIER_TIMEOUT_MS = 110_000;

/** Login is a small call against a fast endpoint; it should never take this. */
export const LOGIN_TIMEOUT_MS = 20_000;
