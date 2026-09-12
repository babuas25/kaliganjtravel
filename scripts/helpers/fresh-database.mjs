import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const expectedProjectRef = 'ljzoizsogbirlvlsrwzi';
export const artifactPath = path.join(root, 'supabase/fresh-install/supabase/migrations/20260911000000_kaliganj_baseline.sql');
export const hash = (text) => createHash('sha256').update(text).digest('hex');

function replaceOnce(sql, pattern, replacement) {
  const matches = [...sql.matchAll(new RegExp(pattern.source, 'g'))];
  assert.equal(matches.length, 1, `Expected exactly one reviewed SQL block: ${pattern}`);
  return sql.replace(pattern, replacement);
}

export const preamble = `
-- Kaliganj Travels: NEW, EMPTY database only. No data dump or remote reads.
-- This guard deliberately refuses both populated and empty existing app tables.
do $fresh$
begin
  if exists (select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind in ('r', 'p', 'v', 'm', 'f')) then
    raise exception 'FRESH_INSTALL_REQUIRES_EMPTY_PUBLIC_SCHEMA';
  end if;
end $fresh$;

create table public.company_settings (
  id boolean primary key default true check (id),
  display_name text not null check (length(btrim(display_name)) > 0),
  license_number text,
  phone text,
  email text,
  address text
);
alter table public.company_settings enable row level security;
revoke all on public.company_settings from public, anon, authenticated;
grant select, insert, update on public.company_settings to service_role;
insert into public.company_settings (display_name) values ('Kaliganj Travels');

create table public.company_admin_sms_recipients (
  phone text primary key check (phone ~ '^[1-9][0-9]{7,14}$'),
  enabled boolean not null default true
);
alter table public.company_admin_sms_recipients enable row level security;
revoke all on public.company_admin_sms_recipients from public, anon, authenticated;
grant select, insert, update, delete on public.company_admin_sms_recipients to service_role;
-- No phone, email, licence, address, user or payment-account values are invented.
`;

export const postamble = `
-- The legacy supersession table revoked client grants but omitted RLS.
-- Keep its existing RPC-only privileges and enable RLS for the fresh project.
alter table public.booking_reconciliation_proposal_supersessions enable row level security;
insert into public.supplier_operational_settings
  (id, active_supplier, booking_enabled, ticketing_enabled)
values ('triplover', 'triplover', false, false);
-- Background schedules are deliberately installed separately after service setup.
`;

export function prepareFreshDatabase() {
  const directory = path.join(root, 'supabase/migrations');
  const files = fs.readdirSync(directory).filter((name) => /^\d+_.+\.sql$/.test(name)).sort();
  const versions = files.map((name) => name.split('_')[0]);
  assert.equal(new Set(versions).size, files.length, 'Duplicate migration version');
  const manifest = [];
  const sections = [];
  for (const name of files) {
    const original = fs.readFileSync(path.join(directory, name), 'utf8');
    let sql = original;
    const changes = [];
    const version = name.slice(0, 4);
    if (['0036', '0039'].includes(version)) {
      assert.match(sql, /expected booking/);
      sql = '-- Historical booking-only repair omitted: there are no previous bookings.\n';
      changes.push('omit historical booking-only repair');
    }
    if (version === '0034') {
      sql = replaceOnce(sql, /do \$\$[\s\S]*$/, '-- Historical booking repair omitted; all preceding functions retained.\n');
      changes.push('retain schema/functions; omit historical booking repair');
    }
    if (version === '0035') {
      sql = replaceOnce(sql, /update public\.flight_bookings\s+set confirmed_email_attempt_count = 1,[\s\S]*?confirmed_email_attempt_count = 0;/, '-- Historical email error record omitted.');
      changes.push('omit historical email error record');
    }
    if (version === '0042') {
      assert.match(sql, /cron\.schedule/);
      sql = '-- Platform cron/Vault setup deferred; see fresh-install README.\n';
      changes.push('defer platform scheduler; no network jobs during installation');
    }
    if (version === '0023') {
      sql = replaceOnce(sql, /insert into public\.wallet_payment_branches[\s\S]*?address = excluded\.address;/, '-- Payment branches start empty for the new company.');
      changes.push('omit old company branch seed');
    }
    if (version === '0111') {
      sql = replaceOnce(sql, /insert into public\.announcement_slider_messages[\s\S]*?on conflict \(id\) do nothing;/, '-- Announcements start empty.');
      changes.push('omit old promotional messages');
    }
    if (version === '0118') {
      sql = replaceOnce(sql, /insert into public\.homepage_travel_offers[\s\S]*?on conflict \(id\) do nothing;/, `
-- The editor requires three existing slots. New, inactive placeholders only.
insert into public.homepage_travel_offers
  (id, eyebrow, title, description, is_active, sort_order, created_by, updated_by)
select gen_random_uuid(), 'Not configured', 'Offer ' || (slot + 1),
  'Configure this offer before publishing.', false, slot,
  'system:fresh-install', 'system:fresh-install'
from generate_series(0, 2) slot;`);
      sql = sql.replace('Save Big with Limited-Time Travel Offers', 'Kaliganj Travels Offers')
        .replace('Exclusive flight deals, all in one place.', 'New offers will be published here.');
      changes.push('replace old offers with three new inactive editor slots');
    }
    if (version === '0073') {
      sql = replaceOnce(sql, /  v_header jsonb;/, '  v_header jsonb;\n  v_company public.company_settings;');
      sql = replaceOnce(sql, /begin\n  select candidate\.\*/, 'begin\n  select * into strict v_company from public.company_settings where id;\n  select candidate.*');
      sql = sql.replaceAll("'Shapon Travels International'", 'v_company.display_name')
        .replaceAll("'0016548'", "coalesce(v_company.license_number, '--')")
        .replaceAll("'+8801921-232941'", "coalesce(v_company.phone, '--')")
        .replaceAll("'support@shapontravels.com'", "coalesce(v_company.email, '--')")
        .replaceAll("'Shomobai Shopping Market (2nd Floor), Dhankhola Bazar, Gangni, Meherpur-7110'", "coalesce(v_company.address, '--')");
      changes.push('read new company settings for notification snapshot identity');
    }
    if (version === '0153') {
      sql = replaceOnce(sql, /foreach v_number in array array\['8801921232941', '8801989715039'\] loop/, 'for v_number in select phone from public.company_admin_sms_recipients where enabled loop');
      sql = sql.replace('-- Durable new-deposit alerts sent only to the two designated admin numbers.\n-- Each future B2B request creates two independent, retryable deliveries.', '-- Durable new-deposit alerts for explicitly configured new-company recipients.\n-- No recipients are seeded; future requests create one delivery per enabled number.');
      changes.push('use empty, configurable new-company SMS recipient table');
    }
    // Remaining old brand mentions are comments/service-fee descriptions.
    sql = sql.replaceAll('Shapon Travels International', 'Kaliganj Travels')
      .replaceAll('Shopon Travels International', 'Kaliganj Travels')
      .replaceAll('ShopOnTravels', 'Kaliganj Travels')
      .replaceAll('Shapon Travels', 'Kaliganj Travels')
      .replaceAll('gvbovgdjqmskcjgowppa', expectedProjectRef);
    assert.doesNotMatch(sql, /shapon|shopon|0016548|8801921232941|8801989715039|Meherpur|Dhankhola/i, name);
    manifest.push({ source: name, sourceSha256: hash(original), preparedSha256: hash(sql), changes });
    sections.push({ name, sql });
  }
  return { manifest, sections, sql: ['begin;', preamble, ...sections.map(({ name, sql }) => `\n-- SOURCE: ${name}\n${sql}`), postamble, 'commit;\n'].join('\n') };
}
