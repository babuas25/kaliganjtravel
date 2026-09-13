import 'server-only';

import { supabaseAdmin } from '@/lib/supabase/server';

/**
 * A deployment-wide fixed-window limiter. Production consumes counters through
 * one atomic Postgres RPC; the in-memory implementation below is only a local
 * development fallback when Supabase is intentionally unconfigured.
 */

type Bucket = {
  count: number;
  /** Epoch ms at which the window closes and the count restarts. */
  resetAt: number;
};

const buckets = new Map<string, Bucket>();

/**
 * Ceiling on tracked keys, so a long-lived instance cannot grow the map
 * without bound. Reaching it needs this many distinct actors inside one
 * window on a single instance, which is far beyond what this application
 * sees.
 */
const MAX_TRACKED_KEYS = 5_000;

export type RateLimitResult =
  | { ok: true }
  | { ok: false; retryAfterSeconds: number };

/**
 * Drops closed windows, then the nearest-to-closing entry if still at cap.
 *
 * `forEach` rather than `for...of`: the project compiles to ES5, where
 * iterating a Map directly is not available. Deleting during the walk is
 * safe — an entry removed before it is reached is simply not visited.
 */
function makeRoom(now: number): void {
  buckets.forEach((bucket, key) => {
    if (bucket.resetAt <= now) buckets.delete(key);
  });

  if (buckets.size < MAX_TRACKED_KEYS) return;

  let oldestKey: string | null = null;
  let oldestResetAt = Infinity;
  buckets.forEach((bucket, key) => {
    if (bucket.resetAt < oldestResetAt) {
      oldestResetAt = bucket.resetAt;
      oldestKey = key;
    }
  });
  if (oldestKey) buckets.delete(oldestKey);
}

/**
 * Records an attempt against `key` and reports whether it is allowed.
 *
 * Call it only after the caller has been authenticated and authorised: the
 * key should identify a known actor, and a rejected caller should never get
 * as far as consuming someone's allowance.
 */
export function rateLimit(
  key: string,
  limit: number,
  windowMs: number
): RateLimitResult {
  const now = Date.now();
  const bucket = buckets.get(key);

  if (!bucket || bucket.resetAt <= now) {
    if (buckets.size >= MAX_TRACKED_KEYS) makeRoom(now);
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    return { ok: true };
  }

  if (bucket.count >= limit) {
    return {
      ok: false,
      retryAfterSeconds: Math.max(1, Math.ceil((bucket.resetAt - now) / 1000)),
    };
  }

  bucket.count += 1;
  return { ok: true };
}

/** Human wording for a refusal, rounded to whole minutes once past one. */
export function rateLimitMessage(retryAfterSeconds: number): string {
  if (retryAfterSeconds <= 90) {
    return 'Too many attempts just now. Try again in a moment.';
  }

  const minutes = Math.ceil(retryAfterSeconds / 60);
  return `Too many attempts just now. Try again in about ${minutes} minute${
    minutes === 1 ? '' : 's'
  }.`;
}

/* ── Limits per action ─────────────────────────────────────────────
 *
 * Set well above what the interface makes possible by hand, so ordinary
 * work — onboarding a batch of staff, correcting a profile a few times —
 * never meets them, while a scripted flood does.
 */

const HOUR = 60 * 60 * 1000;
const MINUTE = 60 * 1000;

export const LIMITS = {
  /** Sends an email to an arbitrary address: the one outbound side effect. */
  inviteUser: { limit: 20, windowMs: HOUR },
  /** Mints an account outright. Same allowance as an invitation. */
  createUserAccount: { limit: 20, windowMs: HOUR },
  /** Each call can page the whole Clerk roster to check the last superadmin. */
  setUserRole: { limit: 30, windowMs: HOUR },
  /** Destructive, and pages the roster for the same reason. */
  deleteUserAccount: { limit: 10, windowMs: HOUR },
  /** Reversible, but it pages the roster on the same last-Super-Admin check. */
  setUserActive: { limit: 40, windowMs: HOUR },
  revokeInvite: { limit: 30, windowMs: HOUR },
  /** A partner emailing their own staff. Same outbound risk as inviteUser. */
  inviteSubUser: { limit: 20, windowMs: HOUR },
  /** Rename, disable, enable and remove share one allowance per partner. */
  manageSubUser: { limit: 40, windowMs: HOUR },
  /** Ordinary editing saves a handful of times; a script would not stop. */
  saveProfile: { limit: 20, windowMs: 5 * MINUTE },
  /**
   * Applying to become a B2B partner. Tighter than a profile save because each
   * call can carry five files into Storage, and because applying is something a
   * person does once and corrects once or twice, not repeatedly.
   */
  submitUpgradeRequest: { limit: 6, windowMs: HOUR },
  /** An admin working through the pending applications. Reading and deciding. */
  reviewUpgradeRequest: { limit: 60, windowMs: HOUR },
  /**
   * An admin opening an account's details from the roster. A read, but each
   * call mints signed links to somebody's identity documents, so it is capped
   * like the review above rather than left open.
   */
  viewUserProfile: { limit: 60, windowMs: HOUR },
  /** An admin correcting somebody else's details from the same dialog. */
  editUserProfile: { limit: 40, windowMs: HOUR },
  /** Each upload rewrites site-wide branding and churns storage. */
  siteLogo: { limit: 10, windowMs: HOUR },
  /** Super Admin pricing-rule creates, edits, toggles and removals. */
  manageMarkup: { limit: 60, windowMs: HOUR },
  /** Super Admin changes the account that new supplier searches use. */
  manageSupplierControls: { limit: 30, windowMs: HOUR },
  /** Super Admin changes supplier daily budgets or individual search access. */
  manageFlightSearchControls: { limit: 120, windowMs: HOUR },
  /** Admin and Media Staff changes to the public announcement message set. */
  manageAnnouncements: { limit: 60, windowMs: HOUR },
  /** Fixed-id dashboard hero uploads and removals by the media team. */
  manageMediaBackground: { limit: 10, windowMs: HOUR },
  /** Homepage offer copy and image changes by administrators and media staff. */
  manageHomepageOffers: { limit: 60, windowMs: HOUR },
  /**
   * A partner attaching their five business documents, with room to replace a
   * few. Shared by upload and remove, and by the re-signing call the form makes
   * when its links have aged out.
   */
  businessDocument: { limit: 40, windowMs: HOUR },
  /**
   * Flight search. The tightest limit here, and the only one that guards an
   * *outbound* cost rather than our own database: one search occupies the
   * supplier for the better part of a minute, and Triplover documents a 429
   * without publishing any budget. Twenty in five minutes is far more than
   * refining a route by hand takes and far less than a script would want.
   *
   * Like FareRules below, this is also applied to signed-out visitors because
   * flight results are public, so its key can be an address rather than a
   * person. See `checkActionLimit`.
   */
  flightSearch: { limit: 20, windowMs: 5 * MINUTE },
  /** Public, read-only supplier call for one displayed fare's policy narrative. */
  flightFareRules: { limit: 60, windowMs: 5 * MINUTE },
  /** Revalidates one selected Search option against the live supplier fare. */
  flightReprice: { limit: 30, windowMs: 5 * MINUTE },
  /** Creates a short-lived private draft after a successful RePrice. */
  flightBookingPrepare: { limit: 20, windowMs: 5 * MINUTE },
  /** Irreversible supplier call: hold creation or immediate ticketing. */
  flightBookingSubmit: { limit: 30, windowMs: HOUR },
  /** Privileged read-only preview from an external supplier. */
  impexpRetrieve: { limit: 40, windowMs: HOUR },
  /** Privileged imported-booking creation, including direct-confirmed capture. */
  impexpImport: { limit: 20, windowMs: HOUR },
  /** Staff-entered canonical booking creation, including direct-confirmed capture. */
  manualBookingImport: { limit: 20, windowMs: HOUR },
  /** Staff-only manual source lifecycle commands. */
  manualBookingStatus: { limit: 60, windowMs: HOUR },
  /** Privileged non-financial supplier synchronization. */
  impexpSync: { limit: 40, windowMs: HOUR },
  /** Customer/agency wallet hold for an imported On Hold booking. */
  impexpConfirm: { limit: 10, windowMs: HOUR },
  /** Customer/agency deposit submissions. */
  walletDeposit: { limit: 20, windowMs: HOUR },
  /** Customer/agency changes to saved sender bank accounts. */
  walletBankAccount: { limit: 40, windowMs: HOUR },
  /** Customer/agency saved-passenger creates, corrections, and admin removals. */
  passengerProfile: { limit: 40, windowMs: HOUR },
  /** Financial queue decisions, adjustments, freezes and refunds. */
  walletManage: { limit: 60, windowMs: HOUR },
  /** Super Admin creates, edits and activates payment-receiving bank accounts. */
  managePaymentAccounts: { limit: 40, windowMs: HOUR },
  /** Irreversible ticket issue call guarded by a durable wallet reservation. */
  flightTicketIssue: { limit: 10, windowMs: HOUR },
  flightBookingCancel: { limit: 10, windowMs: HOUR },
  /** Sends an existing confirmed ticket to an address chosen by an authorised viewer. */
  bookingConfirmationShare: { limit: 20, windowMs: HOUR },
  /** Confirmation SMS; the database separately enforces three per B2B booking. */
  bookingSmsShare: { limit: 20, windowMs: HOUR },
  itineraryShare: { limit: 20, windowMs: HOUR },
  // Date-scoped actor keys reset this allowance at midnight in Bangladesh.
  b2bItinerarySmsDaily: { limit: 5, windowMs: 24 * HOUR },
  /** Customer/agency requests for staff-verified local ticketing time. */
  bookingTimeLimitRequest: { limit: 10, windowMs: HOUR },
  /** Staff approval or rejection of a local ticketing-time request. */
  bookingTimeLimitDecision: { limit: 60, windowMs: HOUR },
  /** Staff-only PNR/report investigation; supplier reads are safe but costly. */
  bookingEvidenceRead: { limit: 40, windowMs: HOUR },
  /** Staff reconciliation proposal/approval/rejection writes. */
  bookingReconciliationWrite: { limit: 60, windowMs: HOUR },
  /** Staff-only, reversible B2B booking visibility changes. */
  manageBookingVisibility: { limit: 60, windowMs: HOUR },
  /** Customer Refund/Reissue/VOID requests and quotation decisions. */
  ticketManagementCustomer: { limit: 30, windowMs: HOUR },
  /** Support/Admin request review, quotation, requotation, and assignment. */
  ticketManagementOperations: { limit: 120, windowMs: HOUR },
  /** Assigned Accounts/Admin/Superadmin wallet settlement actions. */
  ticketManagementSettlement: { limit: 60, windowMs: HOUR },
} as const;

export type LimitName = keyof typeof LIMITS;

/**
 * Applies the named limit to one actor. The key is namespaced per action so a
 * busy invite session does not spend the allowance for editing a profile.
 *
 * `actorKey` identifies whoever is being limited. For the authenticated actions
 * that is a Clerk id, and the caller must already have been authenticated and
 * authorised — a rejected caller should never consume someone's allowance. The
 * public flight search has no such identity for signed-out visitors and keys on
 * a prefixed address instead (`ip:203.0.113.4`); the prefix is what keeps the
 * two namespaces from colliding.
 */
export async function checkActionLimit(
  name: LimitName,
  actorKey: string
): Promise<RateLimitResult> {
  const { limit, windowMs } = LIMITS[name];
  const key = `${name}:${actorKey}`.slice(0, 512);
  const supabase = supabaseAdmin();

  // Local development stays usable without database credentials. Production
  // fails closed rather than silently restoring a per-instance bypass.
  if (!supabase) {
    return process.env.NODE_ENV === 'production'
      ? { ok: false, retryAfterSeconds: 60 }
      : rateLimit(key, limit, windowMs);
  }

  const { data, error } = await supabase.rpc('consume_security_rate_limit', {
    p_key: key,
    p_limit: limit,
    p_window_ms: windowMs,
  });
  if (error) {
    console.error('[security] shared rate limit failed:', error.message);
    return process.env.NODE_ENV === 'production'
      ? { ok: false, retryAfterSeconds: 60 }
      : rateLimit(key, limit, windowMs);
  }

  const row = Array.isArray(data) ? data[0] : data;
  if (!row || typeof row.allowed !== 'boolean') {
    console.error('[security] shared rate limit returned an invalid result');
    return { ok: false, retryAfterSeconds: 60 };
  }

  return row.allowed
    ? { ok: true }
    : {
        ok: false,
        retryAfterSeconds:
          typeof row.retry_after_seconds === 'number'
            ? Math.max(1, row.retry_after_seconds)
            : 60,
      };
}

/** Reserve before contacting the SMS provider; uncertain deliveries still count. */
export function checkB2bItinerarySmsDailyLimit(userId: string, now = new Date()) {
  const day = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Dhaka', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(now);
  return checkActionLimit('b2bItinerarySmsDaily', `user:${userId}:day:${day}`);
}
