/**
 * The access state controlled by Users & Roles.
 *
 * Clerk's ban endpoint is a paid-plan feature on this instance. Keeping the
 * application-level state in public metadata makes the access switch work on
 * every plan, while the shared dashboard session gate enforces it everywhere
 * that needs an authenticated account.
 */
export const ACCOUNT_ACTIVE_METADATA_KEY = 'accountActive' as const;

/**
 * Accounts created before this flag existed are active by default. Only the
 * boolean `false` disables an account; malformed metadata must not lock a
 * customer out by accident.
 */
export function isAccountActive(metadata: unknown): boolean {
  if (!metadata || typeof metadata !== 'object') return true;

  return (
    (metadata as Record<string, unknown>)[ACCOUNT_ACTIVE_METADATA_KEY] !==
    false
  );
}

/** The roster also respects a legacy Clerk ban if one was set previously. */
export function isUserActive(user: {
  banned?: boolean;
  publicMetadata?: unknown;
}): boolean {
  return !user.banned && isAccountActive(user.publicMetadata);
}

/** Metadata payload for Clerk's merge-style `updateUserMetadata` API. */
export function accountActiveMetadata(active: boolean) {
  return { [ACCOUNT_ACTIVE_METADATA_KEY]: active };
}
