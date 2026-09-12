import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';

import { createClient } from '@supabase/supabase-js';

function loadEnvFile(path) {
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
    if (!match) continue;
    let value = match[2].trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) value = value.slice(1, -1);
    process.env[match[1]] ??= value;
  }
}

loadEnvFile('.env.local');
const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
assert(url && serviceKey && anonKey, 'Supabase verification credentials are missing');

const options = { auth: { persistSession: false, autoRefreshToken: false } };
const admin = createClient(url, serviceKey, options);
const anonymous = createClient(url, anonKey, options);

const attempts = await admin
  .from('booking_attempts')
  .select('created_by_user_id,staff_on_behalf')
  .limit(1);
assert(!attempts.error, `Attempt audit columns unavailable: ${attempts.error?.message}`);

const list = await admin
  .from('booking_dashboard_creator_v')
  .select('id,creator_name,creator_role,creator_email,creator_agency_code,creator_agency_name,booking_agency_code,booking_agency_name')
  .order('created_at', { ascending: false })
  .limit(50);
assert(!list.error, `Creator projection unavailable: ${list.error?.message}`);
assert((list.data ?? []).length <= 50, 'Creator projection did not honor the page limit');

const anonymousList = await anonymous
  .from('booking_dashboard_creator_v')
  .select('id')
  .limit(1);
assert(anonymousList.error, 'Anonymous access can read booking creator identities');

for (const role of ['superadmin', 'admin']) {
  const legacy = await admin.rpc('wallet_begin_booking_issue', {
    p_booking_id: randomUUID(),
    p_actor_user_id: `verification-${role}`,
    p_actor_role: role,
    p_idempotency_key: randomUUID(),
  });
  assert(!legacy.error, `${role} legacy denial RPC failed: ${legacy.error?.message}`);
  assert.equal(legacy.data?.code, 'BOOKING_NOT_FOUND', `${role} cannot reach legacy owner-wallet issue logic`);

  const v2 = await admin.rpc('wallet_begin_booking_issue_v2', {
    p_booking_id: randomUUID(),
    p_actor_user_id: `verification-${role}`,
    p_actor_role: role,
    p_request_key: randomUUID(),
    p_request_payload_hash: '0'.repeat(64),
  });
  assert(!v2.error, `${role} v2 denial RPC failed: ${v2.error?.message}`);
  assert.equal(v2.data?.code, 'BOOKING_NOT_FOUND', `${role} cannot reach v2 owner-wallet issue logic`);
}

for (const rpc of ['wallet_begin_booking_issue', 'wallet_begin_booking_issue_v2']) {
  const args = rpc.endsWith('_v2')
    ? {
        p_booking_id: randomUUID(),
        p_actor_user_id: 'verification-staff-support',
        p_actor_role: 'staff_support',
        p_request_key: randomUUID(),
        p_request_payload_hash: '0'.repeat(64),
      }
    : {
        p_booking_id: randomUUID(),
        p_actor_user_id: 'verification-staff-support',
        p_actor_role: 'staff_support',
        p_idempotency_key: randomUUID(),
      };
  const denied = await admin.rpc(rpc, args);
  assert(!denied.error, `Support ${rpc} denial failed: ${denied.error?.message}`);
  assert.equal(denied.data?.code, 'ISSUE_FORBIDDEN', `Support can reach ${rpc} wallet logic`);
}

console.log(
  `Live Admin owner-wallet ticketing and Support guards verified; creator projection returned ${list.data?.length ?? 0} rows (max 50).`
);
