import type { DashboardSession } from '@/lib/dashboard/session';
import type {
  PassengerProfile,
  PassengerProfileInput,
  PassengerProfileUpdateInput,
} from '@/lib/passengers';
import { supabaseAdmin } from '@/lib/supabase/server';

const TABLE = 'passenger_profiles';
const COLUMNS = 'id, public_ref, owner_user_id, passenger_type, title, given_name, surname, gender, nationality, phone_country_code, phone, email, date_of_birth, passport_number, passport_expiry, issuing_country, loyalty_airline_code, loyalty_account_number, ssr_requests, organization, created_at, updated_at';

type PassengerProfileRow = {
  id: string;
  public_ref: string;
  owner_user_id: string;
  passenger_type: PassengerProfile['passengerType'];
  title: PassengerProfile['title'];
  given_name: string;
  surname: string;
  gender: PassengerProfile['gender'];
  nationality: string;
  phone_country_code: string | null;
  phone: string | null;
  email: string | null;
  date_of_birth: string | null;
  passport_number: string | null;
  passport_expiry: string | null;
  issuing_country: string | null;
  loyalty_airline_code: string | null;
  loyalty_account_number: string | null;
  ssr_requests: PassengerProfile['ssrRequests'] | null;
  organization: string | null;
  created_at: string;
  updated_at: string;
};

type PassengerAccess = { kind: 'all' } | { kind: 'owner'; clerkId: string };

export function passengerAccessFor(session: DashboardSession): PassengerAccess | null {
  if (session.role === 'superadmin' || session.role === 'admin') return { kind: 'all' };
  if (session.role === 'customer' || session.role === 'b2b' || session.role === 'b2b_sub') {
    return { kind: 'owner', clerkId: session.clerkId };
  }
  return null;
}

function serialize(row: PassengerProfileRow): PassengerProfile {
  return {
    id: row.id,
    publicRef: row.public_ref,
    passengerType: row.passenger_type,
    title: row.title,
    firstName: row.given_name,
    lastName: row.surname,
    gender: row.gender,
    nationality: row.nationality,
    phoneCountryCode: row.phone_country_code ?? '',
    phone: row.phone ?? '',
    email: row.email ?? '',
    dateOfBirth: row.date_of_birth ?? '',
    passportNumber: row.passport_number ?? '',
    passportExpiry: row.passport_expiry ?? '',
    issuingCountry: row.issuing_country ?? '',
    loyaltyAirlineCode: row.loyalty_airline_code ?? '',
    loyaltyAccountNumber: row.loyalty_account_number ?? '',
    ssrRequests: row.ssr_requests ?? [],
    organization: row.organization ?? '',
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function dataRow(input: Partial<PassengerProfileInput>) {
  const values: Record<string, unknown> = {};
  if (input.passengerType !== undefined) values.passenger_type = input.passengerType;
  if (input.title !== undefined) values.title = input.title;
  if (input.firstName !== undefined) values.given_name = input.firstName;
  if (input.lastName !== undefined) values.surname = input.lastName;
  if (input.gender !== undefined) values.gender = input.gender;
  if (input.nationality !== undefined) values.nationality = input.nationality;
  if (input.phoneCountryCode !== undefined) values.phone_country_code = input.phoneCountryCode || null;
  if (input.phone !== undefined) values.phone = input.phone || null;
  if (input.email !== undefined) values.email = input.email || null;
  if (input.dateOfBirth !== undefined) values.date_of_birth = input.dateOfBirth || null;
  if (input.passportNumber !== undefined) values.passport_number = input.passportNumber || null;
  if (input.passportExpiry !== undefined) values.passport_expiry = input.passportExpiry || null;
  if (input.issuingCountry !== undefined) values.issuing_country = input.issuingCountry || null;
  if (input.loyaltyAirlineCode !== undefined) values.loyalty_airline_code = input.loyaltyAirlineCode || null;
  if (input.loyaltyAccountNumber !== undefined) values.loyalty_account_number = input.loyaltyAccountNumber || null;
  if (input.ssrRequests !== undefined) values.ssr_requests = input.ssrRequests;
  if (input.organization !== undefined) values.organization = input.organization || null;
  return values;
}

function storageMessage(message: string) {
  if (/schema cache|could not find the table/i.test(message)) {
    return 'Passenger storage is not ready. Apply migration 0103 to enable it.';
  }
  return 'Passenger storage is temporarily unavailable.';
}

export async function listPassengerProfiles(
  access: PassengerAccess,
  options: { limit: number; passengerType?: PassengerProfile['passengerType'] }
): Promise<{ ok: true; passengers: PassengerProfile[] } | { ok: false; message: string }> {
  const supabase = supabaseAdmin();
  if (!supabase) return { ok: false, message: 'Passenger storage is not configured.' };

  let query = supabase.from(TABLE).select(COLUMNS).order('created_at', { ascending: false }).limit(options.limit);
  if (access.kind === 'owner') query = query.eq('owner_user_id', access.clerkId);
  if (options.passengerType) query = query.eq('passenger_type', options.passengerType);

  const { data, error } = await query;
  if (error) {
    console.error('[db] listPassengerProfiles failed:', error.message);
    return { ok: false, message: storageMessage(error.message) };
  }
  return { ok: true, passengers: ((data ?? []) as PassengerProfileRow[]).map(serialize) };
}

export async function createPassengerProfile(
  ownerUserId: string,
  input: PassengerProfileInput
): Promise<{ ok: true; passenger: PassengerProfile } | { ok: false; message: string }> {
  const supabase = supabaseAdmin();
  if (!supabase) return { ok: false, message: 'Passenger storage is not configured.' };

  const { data, error } = await supabase
    .from(TABLE)
    .insert({ owner_user_id: ownerUserId, ...dataRow(input) })
    .select(COLUMNS)
    .single();
  if (error || !data) {
    if (error) console.error('[db] createPassengerProfile failed:', error.message);
    return { ok: false, message: error ? storageMessage(error.message) : 'Passenger could not be saved.' };
  }
  return { ok: true, passenger: serialize(data as PassengerProfileRow) };
}

export async function updatePassengerProfile(
  access: PassengerAccess,
  id: string,
  input: Omit<PassengerProfileUpdateInput, 'id'>
): Promise<{ ok: true; passenger: PassengerProfile } | { ok: false; notFound?: boolean; message: string }> {
  const supabase = supabaseAdmin();
  if (!supabase) return { ok: false, message: 'Passenger storage is not configured.' };

  let query = supabase.from(TABLE).update(dataRow(input)).eq('id', id);
  if (access.kind === 'owner') query = query.eq('owner_user_id', access.clerkId);
  const { data, error } = await query.select(COLUMNS).maybeSingle();
  if (error) {
    console.error('[db] updatePassengerProfile failed:', error.message);
    return { ok: false, message: storageMessage(error.message) };
  }
  if (!data) return { ok: false, notFound: true, message: 'Passenger profile not found.' };
  return { ok: true, passenger: serialize(data as PassengerProfileRow) };
}

export async function deletePassengerProfile(
  access: Extract<PassengerAccess, { kind: 'all' }>,
  id: string
): Promise<{ ok: true } | { ok: false; notFound?: boolean; message: string }> {
  const supabase = supabaseAdmin();
  if (!supabase) return { ok: false, message: 'Passenger storage is not configured.' };

  const { data, error } = await supabase.from(TABLE).delete().eq('id', id).select('id').maybeSingle();
  if (error) {
    console.error('[db] deletePassengerProfile failed:', error.message);
    return { ok: false, message: storageMessage(error.message) };
  }
  if (!data) return { ok: false, notFound: true, message: 'Passenger profile not found.' };
  return { ok: true };
}
