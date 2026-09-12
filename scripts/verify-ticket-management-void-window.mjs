import assert from 'node:assert/strict';
import fs from 'node:fs';

import { PGlite } from '@electric-sql/pglite';

const {
  isTicketVoidRequestOpen,
  ticketVoidRequestDeadline,
} = await import('../lib/ticket-management/void-window.ts');

const issuedAt = '2026-09-04T13:15:00+06:00';
assert.equal(
  ticketVoidRequestDeadline(issuedAt)?.toISOString(),
  '2026-09-04T17:30:00.000Z'
);
assert.equal(
  isTicketVoidRequestOpen(issuedAt, new Date('2026-09-04T23:29:59.999+06:00')),
  true
);
assert.equal(
  isTicketVoidRequestOpen(issuedAt, new Date('2026-09-04T23:30:00+06:00')),
  false
);
assert.equal(
  isTicketVoidRequestOpen(issuedAt, new Date('2026-09-05T00:00:00+06:00')),
  false
);
assert.equal(
  isTicketVoidRequestOpen(issuedAt, new Date('2026-09-04T13:14:59+06:00')),
  false
);
assert.equal(
  isTicketVoidRequestOpen(
    '2026-09-04T23:31:00+06:00',
    new Date('2026-09-04T23:31:01+06:00')
  ),
  false
);

const db = new PGlite();
await db.exec(`
  create role anon;
  create role authenticated;
  create role service_role;
  create table public.flight_bookings (
    id uuid primary key,
    issued_at timestamptz,
    status text not null default 'confirmed',
    direct_ticketing boolean not null default false,
    import_source text,
    booking_origin text
  );
  create table public.ticket_management_requests (
    id uuid primary key,
    booking_id uuid not null references public.flight_bookings(id),
    action text not null
  );
`);
await db.exec(fs.readFileSync(
  'supabase/migrations/0146_ticket_management_void_same_day_cutoff.sql',
  'utf8'
));
await db.exec(fs.readFileSync(
  'supabase/migrations/0147_ticket_management_action_visibility.sql',
  'utf8'
));

const sqlCases = await db.query(`
  select
    public.ticket_management_void_request_window_open_v1(
      '2026-09-04 13:15:00+06', '2026-09-04 23:29:59.999+06'
    ) as before_cutoff,
    public.ticket_management_void_request_window_open_v1(
      '2026-09-04 13:15:00+06', '2026-09-04 23:30:00+06'
    ) as at_cutoff,
    public.ticket_management_void_request_window_open_v1(
      '2026-09-04 13:15:00+06', '2026-09-05 00:00:00+06'
    ) as next_day,
    public.ticket_management_void_request_window_open_v1(
      '2026-09-04 13:15:00+06', '2026-09-04 13:14:59+06'
    ) as before_issue
`);
assert.deepEqual(sqlCases.rows[0], {
  before_cutoff: true,
  at_cutoff: false,
  next_day: false,
  before_issue: false,
});

const bookingId = '11111111-1111-4111-8111-111111111111';
await db.query(
  `insert into public.flight_bookings(id, issued_at)
   values ($1, clock_timestamp() - interval '1 day')`,
  [bookingId]
);
await assert.rejects(
  db.query(
    `insert into public.ticket_management_requests(id, booking_id, action)
     values ('22222222-2222-4222-8222-222222222222', $1, 'void')`,
    [bookingId]
  ),
  /VOID_REQUEST_WINDOW_CLOSED/
);
await db.query(
  `insert into public.ticket_management_requests(id, booking_id, action)
   values ('33333333-3333-4333-8333-333333333333', $1, 'refund')`,
  [bookingId]
);

const directBookingId = '44444444-4444-4444-8444-444444444444';
await db.query(
  `insert into public.flight_bookings(id, issued_at, direct_ticketing)
   values ($1, clock_timestamp(), true)`,
  [directBookingId]
);
await assert.rejects(
  db.query(
    `insert into public.ticket_management_requests(id, booking_id, action)
     values ('55555555-5555-4555-8555-555555555555', $1, 'refund')`,
    [directBookingId]
  ),
  /TICKET_MANAGEMENT_ACTION_UNAVAILABLE/
);
await db.query(
  `insert into public.ticket_management_requests(id, booking_id, action)
   values ('66666666-6666-4666-8666-666666666666', $1, 'reissue')`,
  [directBookingId]
);

const pendingBookingId = '77777777-7777-4777-8777-777777777777';
await db.query(
  `insert into public.flight_bookings(id, issued_at, status)
   values ($1, null, 'pending')`,
  [pendingBookingId]
);
await assert.rejects(
  db.query(
    `insert into public.ticket_management_requests(id, booking_id, action)
     values ('88888888-8888-4888-8888-888888888888', $1, 'reissue')`,
    [pendingBookingId]
  ),
  /TICKET_MANAGEMENT_ACTION_UNAVAILABLE/
);

const component = fs.readFileSync(
  'components/flights/PostTicketActionsPreview.tsx',
  'utf8'
);
const route = fs.readFileSync('app/api/ticket-management/route.ts', 'utf8');
assert.match(component, /item\.value !== "void" \|\| voidWindowOpen/);
assert.match(component, /window\.setTimeout\(syncVoidWindow/);
assert.match(route, /VOID_REQUEST_WINDOW_CLOSED/);
assert.match(route, /isTicketVoidRequestOpen\(booking\.issued_at\)/);
assert.match(route, /ticketManagementActionsForBooking/);
assert.match(route, /TICKET_MANAGEMENT_ACTION_UNAVAILABLE/);

console.log('Ticket Management same-day VOID cutoff verification passed.');
