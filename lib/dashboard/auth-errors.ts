/**
 * Telling "this session names nobody" apart from "Clerk could not answer".
 *
 * Pure, and deliberately in its own module: `session.ts` builds on React's
 * `cache()` and Clerk's request context, so it cannot be loaded outside a
 * server render — and this rule is the part worth exercising on its own.
 */

/**
 * Statuses that mean the session no longer identifies an account.
 *
 * 404 is the one that bites. The middleware verifies the session token
 * *locally*, so a token minted before an account was deleted keeps passing
 * `auth.protect()` until it expires — while `currentUser()` asks the Backend
 * API for a user id that is no longer there and throws.
 */
const GONE_STATUSES = [401, 403, 404];

/**
 * Whether a thrown error means the caller should be treated as signed out.
 *
 * Both conditions matter. `clerkError` marks this as Clerk's own error class,
 * so an unrelated failure that happens to carry a `status` is not mistaken for
 * a dead session. The status then separates "gone" from "Clerk is having a bad
 * day" — a 5xx or a rate limit has to keep propagating, because silently
 * signing everyone out during an outage turns a visible incident into a
 * mystery, and the sign-in page they land on would not work either.
 */
export function isSessionGoneError(error: unknown): boolean {
  const clerk = error as { clerkError?: boolean; status?: number } | null;
  return (
    Boolean(clerk?.clerkError) && GONE_STATUSES.includes(clerk?.status ?? 0)
  );
}
