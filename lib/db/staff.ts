import {
  EMPTY_STAFF,
  MAX_STAFF_LENGTH,
  STAFF_FIELDS,
  toStaffColumn,
  type StaffValues,
} from '@/lib/staff';
import { supabaseAdmin } from '@/lib/supabase/server';

/**
 * Reads and writes `staff_details`.
 *
 * `lib/staff.ts` describes the record; the migration names every column as the
 * snake_case of a field there, so the mapping below is mechanical rather than a
 * second list to keep in step.
 *
 * **Nothing here checks permission.** Callers arrive having already established
 * that the actor may touch this person — the sub user themselves, or the B2B
 * admin who owns their agency. See `lib/dashboard/sub-user-guard.ts`.
 */

const TABLE = 'staff_details';

const COLUMNS = ['user_id', ...STAFF_FIELDS.map(toStaffColumn)].join(', ');

/**
 * Outcome of a read.
 *
 * A failed read is kept apart from an empty one for the same reason as
 * `getProfile()`: the form submits every field at once, so rendering blanks
 * after a failure would, on the next save, write NULL over details that were
 * stored all along. `ok: false` means unknown, not empty.
 */
export type StaffRead = { ok: true; values: StaffValues } | { ok: false };

function rowToValues(row: Record<string, unknown>): StaffValues {
  const values = { ...EMPTY_STAFF };
  for (const field of STAFF_FIELDS) {
    const raw = row[toStaffColumn(field)];
    if (raw !== null && raw !== undefined) values[field] = String(raw);
  }
  return values;
}

/** One person's staff record. Blank values when they have none yet. */
export async function getStaffDetails(userId: string): Promise<StaffRead> {
  const supabase = supabaseAdmin();
  if (!supabase) return { ok: false };

  const { data, error } = await supabase
    .from(TABLE)
    .select(COLUMNS)
    .eq('user_id', userId)
    .maybeSingle();

  if (error) {
    console.error('[db] getStaffDetails failed:', error.message);
    return { ok: false };
  }
  if (!data) return { ok: true, values: { ...EMPTY_STAFF } };

  return {
    ok: true,
    values: rowToValues(data as unknown as Record<string, unknown>),
  };
}

/**
 * Staff records for a set of people, for the admin's list — one query for the
 * page rather than one per row. Anyone without a record is simply absent, which
 * is how the list tells "not filled in yet" from "filled in and blank".
 *
 * Returns null when the read failed, so the caller can withhold the list rather
 * than show it empty.
 */
export async function staffDetailsFor(
  userIds: string[]
): Promise<Map<string, StaffValues> | null> {
  const found = new Map<string, StaffValues>();
  if (!userIds.length) return found;

  const supabase = supabaseAdmin();
  if (!supabase) return null;

  const { data, error } = await supabase
    .from(TABLE)
    .select(COLUMNS)
    .in('user_id', userIds);

  if (error) {
    console.error('[db] staffDetailsFor failed:', error.message);
    return null;
  }

  for (const row of (data ?? []) as unknown as Record<string, unknown>[]) {
    found.set(String(row.user_id), rowToValues(row));
  }
  return found;
}

export type StaffWriteResult = { ok: boolean; message: string };

const WRITE_FAILED =
  'Those details could not be saved. Nothing has been changed — try again, and contact support if it keeps happening.';

/** Creates or updates a staff record. */
export async function saveStaffDetails(
  userId: string,
  values: StaffValues
): Promise<StaffWriteResult> {
  const supabase = supabaseAdmin();
  if (!supabase) {
    return {
      ok: false,
      message: 'The database is not configured on this environment.',
    };
  }

  const row: Record<string, string | null> = { user_id: userId };

  // Driven by STAFF_FIELDS rather than by what arrived, so an unexpected key
  // in the payload can never reach a column.
  for (const field of STAFF_FIELDS) {
    const value = (values[field] ?? '').trim();
    if (value.length > MAX_STAFF_LENGTH) {
      return { ok: false, message: `${field} is too long.` };
    }
    row[toStaffColumn(field)] = value === '' ? null : value;
  }

  const { error } = await supabase
    .from(TABLE)
    .upsert(row, { onConflict: 'user_id' });

  if (error) {
    // Postgres names the table, the column and the constraint. That belongs in
    // the log, not on screen: it describes our schema and tells the reader
    // nothing they can act on.
    console.error('[db] saveStaffDetails failed:', error.message);
    return { ok: false, message: WRITE_FAILED };
  }

  return { ok: true, message: 'Staff details saved.' };
}

/**
 * Removes a staff record.
 *
 * The person's account, profile and login are untouched — this clears their
 * employment details only. Removing someone from the agency is the Sub Users
 * page.
 */
export async function deleteStaffDetails(
  userId: string
): Promise<StaffWriteResult> {
  const supabase = supabaseAdmin();
  if (!supabase) {
    return {
      ok: false,
      message: 'The database is not configured on this environment.',
    };
  }

  const { error } = await supabase.from(TABLE).delete().eq('user_id', userId);

  if (error) {
    console.error('[db] deleteStaffDetails failed:', error.message);
    return { ok: false, message: WRITE_FAILED };
  }

  return { ok: true, message: 'Staff details removed.' };
}
