import 'server-only';

import {
  isTriploverSupplier,
  type TriploverSupplier,
} from '@/lib/triplover/config';
import { supabaseAdmin } from '@/lib/supabase/server';

const TABLE = 'supplier_operational_settings';
const SETTINGS_ID = 'triplover';

export type SupplierOperationalControls = {
  activeSupplier: TriploverSupplier;
  bookingEnabled: boolean;
  ticketingEnabled: boolean;
  /** Zero means the pre-migration environment fallback is still in use. */
  version: number;
  source: 'database' | 'legacy_environment' | 'unavailable';
};

type SupplierOperationalControlsRow = {
  active_supplier: string;
  booking_enabled: boolean;
  ticketing_enabled: boolean;
  version: number;
};

type UnknownSupplierOperationalControlsRow = {
  active_supplier: unknown;
  booking_enabled: unknown;
  ticketing_enabled: unknown;
  version: unknown;
};

function legacySupplier(): TriploverSupplier {
  const configured = process.env.TRIPLOVER_ACTIVE_SUPPLIER?.trim().toLowerCase();
  return isTriploverSupplier(configured) ? configured : 'takeoff';
}

/**
 * Kept solely for a rolling transition: the two legacy operational switches
 * continue to govern traffic until a Super Admin saves the first database row.
 */
function legacyEnvironmentControls(): SupplierOperationalControls {
  return {
    activeSupplier: legacySupplier(),
    bookingEnabled: process.env.TRIPLOVER_BOOKING_ENABLED === 'true',
    ticketingEnabled: process.env.TRIPLOVER_TICKETING_ENABLED === 'true',
    version: 0,
    source: 'legacy_environment',
  };
}

function unavailableControls(): SupplierOperationalControls {
  return {
    activeSupplier: 'takeoff',
    bookingEnabled: false,
    ticketingEnabled: false,
    version: 0,
    source: 'unavailable',
  };
}

/**
 * Supabase's REST schema cache reports a not-yet-migrated table as PGRST205,
 * while direct PostgreSQL callers report 42P01. Both are the same controlled
 * pre-migration state; do not surface either as a development overlay.
 */
function supplierControlsTableIsMissing(error: {
  code?: string | null;
  message?: string | null;
}): boolean {
  return (
    error.code === '42P01' ||
    error.code === 'PGRST205' ||
    /Could not find the table 'public\.supplier_operational_settings'/i.test(
      error.message ?? ''
    )
  );
}

function validRow(value: unknown): value is SupplierOperationalControlsRow {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const row = value as UnknownSupplierOperationalControlsRow;
  return (
    isTriploverSupplier(row.active_supplier) &&
    typeof row.booking_enabled === 'boolean' &&
    typeof row.ticketing_enabled === 'boolean' &&
    typeof row.version === 'number' &&
    Number.isInteger(row.version) &&
    row.version > 0
  );
}

function controlsFromRow(row: SupplierOperationalControlsRow): SupplierOperationalControls {
  return {
    activeSupplier: row.active_supplier.trim().toLowerCase() as TriploverSupplier,
    bookingEnabled: row.booking_enabled,
    ticketingEnabled: row.ticketing_enabled,
    version: row.version,
    source: 'database',
  };
}

/**
 * Reads the one global operational choice. This is intentionally evaluated at
 * the start of each new search, never by an already-created search or booking.
 */
export async function getSupplierOperationalControls(): Promise<SupplierOperationalControls> {
  const supabase = supabaseAdmin();
  if (!supabase) return legacyEnvironmentControls();

  const { data, error } = await supabase
    .from(TABLE)
    .select('active_supplier, booking_enabled, ticketing_enabled, version')
    .eq('id', SETTINGS_ID)
    .maybeSingle();

  if (error) {
    // During a rolling release the table may not exist yet. Only that known
    // schema state may use the old flags; all other database failures fail
    // closed so a disabled control cannot accidentally be re-enabled.
    if (supplierControlsTableIsMissing(error)) {
      return legacyEnvironmentControls();
    }
    console.error('[supplier-controls] read failed:', error.message);
    return unavailableControls();
  }
  if (!data) return legacyEnvironmentControls();
  if (!validRow(data)) {
    console.error('[supplier-controls] invalid settings row.');
    return unavailableControls();
  }

  return controlsFromRow(data as SupplierOperationalControlsRow);
}

export type SaveSupplierOperationalControlsResult =
  | { ok: true; controls: SupplierOperationalControls }
  | { ok: false; message: string };

function supplierControlsSaveError(error: { code?: string | null }): string {
  return error.code === '23514'
    ? 'The database does not support this supplier account yet. Apply the latest database migrations and try again.'
    : 'Supplier settings could not be saved.';
}

/**
 * Compares the visible version to prevent one Super Admin overwriting another
 * person's choice with a stale form.
 */
export async function saveSupplierOperationalControls(input: {
  activeSupplier: TriploverSupplier;
  bookingEnabled: boolean;
  ticketingEnabled: boolean;
  expectedVersion: number;
}): Promise<SaveSupplierOperationalControlsResult> {
  const supabase = supabaseAdmin();
  if (!supabase) {
    return { ok: false, message: 'Database configuration is unavailable.' };
  }
  if (input.ticketingEnabled && !input.bookingEnabled) {
    return {
      ok: false,
      message: 'Ticketing cannot be enabled while booking is disabled.',
    };
  }

  const now = new Date().toISOString();
  if (input.expectedVersion === 0) {
    const { data, error } = await supabase
      .from(TABLE)
      .insert({
        id: SETTINGS_ID,
        active_supplier: input.activeSupplier,
        booking_enabled: input.bookingEnabled,
        ticketing_enabled: input.ticketingEnabled,
        version: 1,
        updated_at: now,
      })
      .select('active_supplier, booking_enabled, ticketing_enabled, version')
      .maybeSingle();
    if (error) {
      return {
        ok: false,
        message: error.code === '23505'
          ? 'Settings changed in another session. Reload and try again.'
          : supplierControlsSaveError(error),
      };
    }
    if (!validRow(data)) {
      return { ok: false, message: 'Supplier settings returned an invalid row.' };
    }
    return {
      ok: true,
      controls: controlsFromRow(data as SupplierOperationalControlsRow),
    };
  }

  const { data, error } = await supabase
    .from(TABLE)
    .update({
      active_supplier: input.activeSupplier,
      booking_enabled: input.bookingEnabled,
      ticketing_enabled: input.ticketingEnabled,
      version: input.expectedVersion + 1,
      updated_at: now,
    })
    .eq('id', SETTINGS_ID)
    .eq('version', input.expectedVersion)
    .select('active_supplier, booking_enabled, ticketing_enabled, version')
    .maybeSingle();
  if (error) {
    console.error('[supplier-controls] save failed:', error.message);
    return { ok: false, message: supplierControlsSaveError(error) };
  }
  if (!data) {
    return { ok: false, message: 'Settings changed in another session. Reload and try again.' };
  }
  if (!validRow(data)) {
    return { ok: false, message: 'Supplier settings returned an invalid row.' };
  }
  return {
    ok: true,
    controls: controlsFromRow(data as SupplierOperationalControlsRow),
  };
}
