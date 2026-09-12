import {
  EMPTY_UPGRADE,
  isUpgradeStatus,
  toUpgradeColumn,
  UPGRADE_FIELDS,
  type UpgradeRequest,
  type UpgradeStatus,
  type UpgradeValues,
} from '@/lib/upgrade';
import { coerceDocumentList, type StoredDoc } from '@/lib/documents';
import { supabaseAdmin } from '@/lib/supabase/server';

/**
 * Reads and writes `upgrade_requests` — a customer's application to become a
 * B2B partner.
 *
 * `lib/upgrade.ts` describes the form; the migration names every field column
 * as the snake_case of a field there, so the mapping below is mechanical rather
 * than a second list to keep in sync.
 *
 * **This table never decides anybody's role.** It records that somebody asked
 * and what an admin answered. Granting the role is still `mirrorUserRole()` plus
 * the Clerk write, exactly as it is when an admin sets a role by hand.
 */

const TABLE = 'upgrade_requests';

const FIELD_COLUMNS = UPGRADE_FIELDS.map(toUpgradeColumn);

const COLUMNS = [
  'user_id',
  ...FIELD_COLUMNS,
  'documents',
  'status',
  'reviewed_by',
  'reviewed_at',
  'review_note',
  'created_at',
  'updated_at',
].join(', ');

/** Timestamptz string → epoch ms, tolerating null and unparseable values. */
function toEpoch(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

/**
 * A stored row as the rest of the application sees it.
 *
 * A row whose status is not one of the three known values is treated as
 * `pending`: the database has a matching `check`, so it cannot happen, and
 * pending is the reading that puts it in front of a human rather than silently
 * granting or denying anything.
 */
function toRequest(row: Record<string, unknown>): UpgradeRequest {
  const values: UpgradeValues = { ...EMPTY_UPGRADE };
  for (const field of UPGRADE_FIELDS) {
    const raw = row[toUpgradeColumn(field)];
    if (raw !== null && raw !== undefined) values[field] = String(raw);
  }

  const status = row.status;

  return {
    userId: String(row.user_id),
    values,
    documents: coerceDocumentList(row.documents),
    status: isUpgradeStatus(status) ? status : 'pending',
    reviewedBy: (row.reviewed_by as string | null) ?? null,
    reviewedAt: toEpoch(row.reviewed_at),
    reviewNote: (row.review_note as string | null) ?? null,
    createdAt: toEpoch(row.created_at) ?? 0,
    updatedAt: toEpoch(row.updated_at) ?? 0,
  };
}

/**
 * Outcome of reading a request.
 *
 * A failed read is kept separate from "has never applied", for the same reason
 * `getProfile()` does it: the page seeds a form from this, and rendering a blank
 * one after a failed read would let the next submit overwrite an application
 * that was sitting there all along.
 */
export type UpgradeRead =
  | { ok: true; request: UpgradeRequest | null }
  | { ok: false };

/** This user's application, or null when they have never made one. */
export async function getUpgradeRequest(
  userId: string
): Promise<UpgradeRead> {
  const supabase = supabaseAdmin();
  if (!supabase) return { ok: false };

  const { data, error } = await supabase
    .from(TABLE)
    .select(COLUMNS)
    .eq('user_id', userId)
    .maybeSingle();

  if (error) {
    console.error('[db] getUpgradeRequest failed:', error.message);
    return { ok: false };
  }
  if (!data) return { ok: true, request: null };

  // The column list is built at runtime, which supabase-js cannot type, so the
  // row comes back as a plain record.
  return {
    ok: true,
    request: toRequest(data as unknown as Record<string, unknown>),
  };
}

/**
 * Stores an application, replacing any previous one by the same person.
 *
 * The upsert is what makes resubmitting after a rejection work: status returns
 * to `pending` and the previous reviewer's decision is cleared, so an admin is
 * never shown a stale verdict beside fresh answers.
 */
export async function submitUpgradeRequest(
  userId: string,
  values: UpgradeValues,
  documents: StoredDoc[]
): Promise<boolean> {
  const supabase = supabaseAdmin();
  if (!supabase) return false;

  const row: Record<string, unknown> = {
    user_id: userId,
    documents,
    status: 'pending',
    reviewed_by: null,
    reviewed_at: null,
    review_note: null,
  };

  // Driven by UPGRADE_FIELDS rather than by what arrived, so an unexpected key
  // in the payload can never reach a column.
  for (const field of UPGRADE_FIELDS) {
    row[toUpgradeColumn(field)] = values[field].trim();
  }

  const { error } = await supabase
    .from(TABLE)
    .upsert(row, { onConflict: 'user_id' });

  if (error) {
    // Postgres names the table, the column and the constraint it tripped on.
    // That belongs in the log, not on someone's screen.
    console.error('[db] submitUpgradeRequest failed:', error.message);
    return false;
  }
  return true;
}

/**
 * Which of these people have an application waiting, and since when — one query
 * for the whole roster page rather than one per row.
 *
 * Only `pending` rows come back. A decided one is history and has no place on
 * the roster; the applicant sees the outcome on their own page.
 *
 * A failed read returns an empty map, which hides the badge rather than
 * inventing one. The reviewing actions re-read the row before acting either
 * way, so nothing is decided on the strength of this.
 */
export async function pendingUpgradesFor(
  userIds: string[]
): Promise<Map<string, number>> {
  const found = new Map<string, number>();
  if (!userIds.length) return found;

  const supabase = supabaseAdmin();
  if (!supabase) return found;

  const { data, error } = await supabase
    .from(TABLE)
    .select('user_id, created_at')
    .eq('status', 'pending')
    .in('user_id', userIds);

  if (error) {
    console.error('[db] pendingUpgradesFor failed:', error.message);
    return found;
  }

  for (const row of (data ?? []) as {
    user_id: string;
    created_at: string | null;
  }[]) {
    found.set(row.user_id, toEpoch(row.created_at) ?? 0);
  }
  return found;
}

/**
 * Records an admin's verdict.
 *
 * Guarded on the row still being `pending`, so two admins opening the same
 * request cannot both decide it — the second write matches no row and reports
 * false, and the caller stops rather than applying a role change on the back of
 * a decision somebody else already made.
 *
 * `expectStatus` is what makes the same function serve the rollback in
 * `decideUpgradeRequest`: putting a row back to `pending` is only correct while
 * it still holds the verdict that failed to apply.
 */
export async function recordUpgradeDecision(
  userId: string,
  status: UpgradeStatus,
  reviewerId: string | null,
  note: string | null,
  expectStatus: UpgradeStatus
): Promise<boolean> {
  const supabase = supabaseAdmin();
  if (!supabase) return false;

  const { data, error } = await supabase
    .from(TABLE)
    .update({
      status,
      reviewed_by: reviewerId,
      reviewed_at: reviewerId ? new Date().toISOString() : null,
      review_note: note,
    })
    .eq('user_id', userId)
    .eq('status', expectStatus)
    .select('user_id');

  if (error) {
    console.error('[db] recordUpgradeDecision failed:', error.message);
    return false;
  }
  return (data ?? []).length > 0;
}
