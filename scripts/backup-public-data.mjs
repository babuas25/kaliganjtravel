import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { resolve } from 'node:path';

import { createClient } from '@supabase/supabase-js';

function loadEnvFile(path) {
  if (!existsSync(path)) return;
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

const TABLES = {
  app_users: 'clerk_id',
  user_profiles: 'clerk_id',
  agencies: 'agency_code',
  staff_details: 'user_id',
  upgrade_requests: 'user_id',
  markup_rules: 'id',
  flight_search_quotes: 'id',
  flight_bookings: 'id',
  booking_attempts: 'id',
  booking_ref_counters: 'ref_date',
};
const PAGE_SIZE = 1_000;

loadEnvFile('.env.local');
const target = process.argv[2] ? resolve(process.argv[2]) : null;
assert(target, 'Usage: node scripts/backup-public-data.mjs <new-backup-file>');
assert(!existsSync(target), `Backup target already exists: ${target}`);

const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
assert(url && serviceKey, 'Supabase backup credentials are missing');

const admin = createClient(url, serviceKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});
const tables = {};

for (const [table, primaryKey] of Object.entries(TABLES)) {
  const rows = [];
  for (let offset = 0; ; offset += PAGE_SIZE) {
    const { data, error } = await admin
      .from(table)
      .select('*')
      .order(primaryKey, { ascending: true })
      .range(offset, offset + PAGE_SIZE - 1);
    if (error) throw new Error(`Could not back up ${table}: ${error.message}`);
    rows.push(...(data ?? []));
    if ((data?.length ?? 0) < PAGE_SIZE) break;
  }
  tables[table] = rows;
}

const payload = JSON.stringify(
  {
    format: 'kaliganj-travels-public-data-backup-v1',
    createdAt: new Date().toISOString(),
    schemaAuthority: 'repository supabase/migrations through 0017',
    tables,
  },
  null,
  2
);
mkdirSync(resolve(target, '..'), { recursive: true });
writeFileSync(target, payload, { encoding: 'utf8', flag: 'wx', mode: 0o600 });

console.log(
  JSON.stringify({
    target,
    bytes: Buffer.byteLength(payload),
    sha256: createHash('sha256').update(payload).digest('hex'),
    rows: Object.fromEntries(
      Object.entries(tables).map(([table, rows]) => [table, rows.length])
    ),
  })
);
