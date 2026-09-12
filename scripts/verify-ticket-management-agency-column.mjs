import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const read = (...parts) => fs.readFileSync(path.join(process.cwd(), ...parts), 'utf8');
const client = read('lib', 'ticket-management', 'client.ts');
const database = read('lib', 'db', 'ticket-management.ts');
const workspace = read(
  'components', 'dashboard', 'ticket-management', 'TicketManagementWorkspace.tsx'
);

for (const field of ['agencyName: string | null', 'agencyId: string | null']) {
  assert.ok(client.includes(field), `Ticket Management client omits ${field}`);
}

for (const required of [
  "row.booking_owner_type === 'agency'",
  'row.booking_owner_key',
  ".from('agencies')",
  ".select('agency_code,owner_user_id')",
  ".from('user_profiles')",
  ".select('clerk_id,agency_name')",
  'agencyName: agencyId ? agencyNames.get(agencyId) ?? null : null',
  'agencyId,',
]) {
  assert.ok(database.includes(required), `Ticket Management agency enrichment omits ${required}`);
}

assert.ok(
  database.includes("staff && row.booking_owner_type === 'agency'"),
  'Agency identity must be returned only to staff readers.'
);
for (const required of [
  "'Agency'",
  "request.agencyName ?? 'Unnamed agency'",
  'request.agencyId',
  'colSpan={11}',
]) {
  assert.ok(workspace.includes(required), `Ticket Management UI omits ${required}`);
}

console.log('Ticket Management agency column verification passed.');
