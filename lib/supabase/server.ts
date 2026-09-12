import { createClient, type SupabaseClient } from '@supabase/supabase-js';

/**
 * Service-role Supabase client. **Server-only** — the key bypasses RLS, so this
 * module must never be imported from a `'use client'` file.
 *
 * Returns null when the environment is not configured, which lets every caller
 * degrade to the built-in branding instead of crashing a page. The env is read
 * per call rather than at module scope so a value set at runtime (Vercel) is
 * picked up without a rebuild.
 */
let cached: SupabaseClient | null = null;

export function supabaseAdmin(): SupabaseClient | null {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceKey) return null;

  cached ??= createClient(url, serviceKey, {
    // No user session to keep: every call is a trusted server call.
    auth: { persistSession: false, autoRefreshToken: false },
  });

  return cached;
}

/** Whether storage-backed features can work at all. Drives the setup notice. */
export function isSupabaseConfigured(): boolean {
  return Boolean(
    process.env.NEXT_PUBLIC_SUPABASE_URL &&
      process.env.SUPABASE_SERVICE_ROLE_KEY
  );
}
