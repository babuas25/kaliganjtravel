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
    ) {
      value = value.slice(1, -1);
    }
    process.env[match[1]] ??= value;
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function rpcRow(data) {
  return Array.isArray(data) ? data[0] : data;
}

loadEnvFile('.env.local');
const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
assert(url && serviceKey && anonKey, 'Supabase verification credentials are missing');

const options = { auth: { persistSession: false, autoRefreshToken: false } };
const admin = createClient(url, serviceKey, options);
const anonymous = createClient(url, anonKey, options);
const suffix = randomUUID();

const rateResults = [];
for (let index = 0; index < 3; index += 1) {
  const response = await admin.rpc('consume_security_rate_limit', {
    p_key: `security-verification:${suffix}`,
    p_limit: 2,
    p_window_ms: 60_000,
  });
  assert(!response.error, `Shared limiter failed: ${response.error?.message}`);
  rateResults.push(rpcRow(response.data));
}
assert(rateResults[0]?.allowed === true, 'First rate-limit call was refused');
assert(rateResults[1]?.allowed === true, 'Second rate-limit call was refused');
assert(rateResults[2]?.allowed === false, 'Shared rate limit did not enforce its ceiling');

const anonRate = await anonymous.rpc('consume_security_rate_limit', {
  p_key: `anonymous-verification:${suffix}`,
  p_limit: 1,
  p_window_ms: 60_000,
});
assert(Boolean(anonRate.error), 'Anonymous role can execute the security limiter');

const firstHolder = randomUUID();
const secondHolder = randomUUID();
const lockName = `security-verification-${suffix}`;
const firstLock = await admin.rpc('try_acquire_security_lock', {
  p_name: lockName,
  p_holder: firstHolder,
  p_lease_seconds: 30,
});
assert(!firstLock.error && firstLock.data === true, 'First security lock failed');
const conflictingLock = await admin.rpc('try_acquire_security_lock', {
  p_name: lockName,
  p_holder: secondHolder,
  p_lease_seconds: 30,
});
assert(
  !conflictingLock.error && conflictingLock.data === false,
  'Concurrent security lock was not refused'
);
const release = await admin.rpc('release_security_lock', {
  p_name: lockName,
  p_holder: firstHolder,
});
assert(!release.error && release.data === true, 'Security lock did not release');
const secondLock = await admin.rpc('try_acquire_security_lock', {
  p_name: lockName,
  p_holder: secondHolder,
  p_lease_seconds: 30,
});
assert(!secondLock.error && secondLock.data === true, 'Released lock was not reusable');
await admin.rpc('release_security_lock', {
  p_name: lockName,
  p_holder: secondHolder,
});

const audit = await admin.from('security_audit_events').insert({
  actor_user_id: 'system:verification',
  actor_role: 'system',
  action: 'security.hardening_verified',
  target_type: 'migration',
  target_id: '0018',
  outcome: 'succeeded',
  metadata: { verificationId: suffix },
});
assert(!audit.error, `Audit insert failed: ${audit.error?.message}`);
const anonAudit = await anonymous.from('security_audit_events').select('id').limit(1);
assert(Boolean(anonAudit.error), 'Anonymous role can read the security audit trail');

const retention = await admin.rpc('enforce_security_retention');
assert(!retention.error, `Retention enforcement failed: ${retention.error?.message}`);

const { data: attempts, error: attemptsError } = await admin
  .from('booking_attempts')
  .select('state, created_at, resolved_at, passenger_snapshot');
assert(!attemptsError, `Attempt verification failed: ${attemptsError?.message}`);
const now = Date.now();
const remainingViolation = (attempts ?? []).find((attempt) => {
  const ageFromCreated = now - Date.parse(attempt.created_at);
  const ageFromResolved = now - Date.parse(attempt.resolved_at ?? attempt.created_at);
  return (
    (attempt.state === 'draft' && ageFromCreated > 7 * 86_400_000) ||
    (attempt.state === 'failed' && ageFromResolved > 90 * 86_400_000) ||
    (attempt.state === 'succeeded' && attempt.passenger_snapshot !== null) ||
    (attempt.state === 'unknown' &&
      ageFromResolved > 90 * 86_400_000 &&
      attempt.passenger_snapshot !== null)
  );
});
assert(!remainingViolation, 'Retention left a row outside the approved policy');

console.log(
  JSON.stringify({
    sharedRateLimit: 'passed',
    anonymousDatabaseAccess: 'denied',
    distributedLock: 'passed',
    auditTrail: 'passed',
    retention: rpcRow(retention.data),
  })
);
