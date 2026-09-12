import {
  EMPTY_PROFILE,
  FILE_FIELDS,
  PERSISTED_FIELDS,
  type ProfileField,
  type ProfileValues,
} from '@/lib/profile';
import {
  coerceDocumentMap,
  type DocumentMap,
  type StoredDoc,
} from '@/lib/documents';
import { supabaseAdmin } from '@/lib/supabase/server';

/**
 * Reads and writes the dashboard profile form.
 *
 * `lib/profile.ts` describes the form; the migration names every column as the
 * snake_case of a field there, so the mapping below is mechanical rather than a
 * second list to keep in sync. Adding a field means adding a column of the
 * matching name — nothing here changes.
 */

const TABLE = 'user_profiles';

/** `dateOfBirth` → `date_of_birth`. */
function toColumn(field: ProfileField): string {
  return field.replace(/[A-Z]/g, (char) => `_${char.toLowerCase()}`);
}

const COLUMNS = [...PERSISTED_FIELDS.map(toColumn), 'documents'].join(', ');

/**
 * Outcome of reading a profile.
 *
 * A failed read is kept separate from an empty one, and the difference
 * matters: the form submits every field at once, so a blank form rendered
 * from a failed read would, on the next save, write NULL over a passport
 * number and bank account that were stored all along. `ok: false` means the
 * values are unknown, not that they are empty, and the caller must not offer
 * them for editing.
 */
export type ProfileRead =
  | { ok: true; values: ProfileValues; documents: DocumentMap }
  | { ok: false };

/**
 * The saved profile.
 *
 * Blank values are returned for a user who has not filled anything in yet,
 * and for an environment with no storage configured — in both cases there is
 * nothing stored to lose, and `saveProfile` refuses the write on its own when
 * storage is missing. A read that *fails* returns `ok: false` instead.
 */
export async function getProfile(clerkId: string): Promise<ProfileRead> {
  const values: ProfileValues = { ...EMPTY_PROFILE };

  const supabase = supabaseAdmin();
  if (!supabase) return { ok: true, values, documents: {} };

  const { data, error } = await supabase
    .from(TABLE)
    .select(COLUMNS)
    .eq('clerk_id', clerkId)
    .maybeSingle();

  if (error) {
    console.error('[db] getProfile failed:', error.message);
    return { ok: false };
  }
  if (!data) return { ok: true, values, documents: {} };

  // The column list is built at runtime, which supabase-js cannot type, so the
  // row comes back as a plain record.
  const row = data as unknown as Record<string, unknown>;
  for (const field of PERSISTED_FIELDS) {
    const raw = row[toColumn(field)];
    // NULL means "not filled in", which the form represents as ''.
    if (raw !== null && raw !== undefined) values[field] = String(raw);
  }

  return {
    ok: true,
    values,
    documents: coerceDocumentMap(row.documents, FILE_FIELDS),
  };
}

/**
 * Agency name per user, for the roster — one query for the page rather than
 * one per row.
 *
 * Read from the partner's **own** profile row, which is where a B2B partner
 * fills their agency name in. Anyone with nothing on file is simply absent
 * from the map, as is anyone who has no such field to fill.
 *
 * Deliberately not `listAgencies()`, which is built for a picker and falls
 * back to the owner's email when the name is blank. Here a missing name has to
 * stay missing, so the caller can fall back to the person's own name rather
 * than printing an address where a business should be.
 */
export async function agencyNamesFor(
  clerkIds: string[]
): Promise<Map<string, string>> {
  const found = new Map<string, string>();
  if (!clerkIds.length) return found;

  const supabase = supabaseAdmin();
  if (!supabase) return found;

  const { data, error } = await supabase
    .from(TABLE)
    .select('clerk_id, agency_name')
    .in('clerk_id', clerkIds);

  if (error) {
    console.error('[db] agencyNamesFor failed:', error.message);
    return found;
  }

  for (const row of (data ?? []) as {
    clerk_id: string;
    agency_name: string | null;
  }[]) {
    const name = row.agency_name?.trim();
    if (name) found.set(row.clerk_id, name);
  }
  return found;
}

/** Longest value any single field accepts. Address is the demanding one. */
const MAX_LENGTH = 500;

export async function saveProfile(
  clerkId: string,
  values: Partial<ProfileValues>
): Promise<{ ok: boolean; message: string }> {
  const supabase = supabaseAdmin();
  if (!supabase) {
    return {
      ok: false,
      message: 'The database is not configured on this environment.',
    };
  }

  const row: Record<string, string | null> = { clerk_id: clerkId };

  // Driven by PERSISTED_FIELDS rather than by what arrived, so an unexpected
  // key in the payload can never reach a column.
  for (const field of PERSISTED_FIELDS) {
    const value = (values[field] ?? '').trim();
    if (value.length > MAX_LENGTH) {
      return { ok: false, message: `${field} is too long.` };
    }
    // Empty stays NULL — '' would fail the date columns outright.
    row[toColumn(field)] = value === '' ? null : value;
  }

  const { error } = await supabase
    .from(TABLE)
    .upsert(row, { onConflict: 'clerk_id' });

  if (error) {
    // Postgres names the table, the column and the constraint it tripped on.
    // That belongs in the log, not on someone's screen: it describes our
    // schema, and it tells the reader nothing they can act on.
    console.error('[db] saveProfile failed:', error.message);
    return {
      ok: false,
      message:
        'Your profile could not be saved. Nothing has been changed — try again, and contact support if it keeps happening.',
    };
  }

  return { ok: true, message: 'Profile saved.' };
}

/**
 * Attaches or clears one business document.
 *
 * Deliberately **not** part of `saveProfile`. That function writes every text
 * field at once, seeded from the stored row, which is what stops one tab
 * blanking another — files cannot join that payload, and a document uploaded
 * from the Business Docs tab must not wait on a Save that also rewrites the
 * passport page.
 *
 * The read-modify-write on a `jsonb` column is safe here because the only
 * writer is the row's own owner, working one document at a time from one page:
 * the concurrent case is a person double-clicking, and both writes carry the
 * same result. Two *different* documents saved in the same instant is the one
 * losable case, and the form uploads one at a time.
 *
 * Returns the stored map so the caller can hand it straight back to the form
 * without a second read.
 */
export async function setProfileDocument(
  clerkId: string,
  field: ProfileField,
  doc: StoredDoc | null
): Promise<{ ok: true; documents: DocumentMap } | { ok: false }> {
  const supabase = supabaseAdmin();
  if (!supabase) return { ok: false };

  const current = await getProfile(clerkId);
  if (!current.ok) return { ok: false };

  const documents: DocumentMap = { ...current.documents };
  if (doc) documents[field] = doc;
  else delete documents[field];

  const { error } = await supabase
    .from(TABLE)
    // Upsert, not update: someone may attach a document before they have ever
    // pressed Save, and an update would match no row and lose it silently.
    .upsert({ clerk_id: clerkId, documents }, { onConflict: 'clerk_id' });

  if (error) {
    console.error('[db] setProfileDocument failed:', error.message);
    return { ok: false };
  }

  return { ok: true, documents };
}
