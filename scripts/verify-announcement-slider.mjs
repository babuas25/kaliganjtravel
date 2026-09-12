import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { PGlite } from '@electric-sql/pglite';

function source(...parts) {
  return fs.readFileSync(path.join(process.cwd(), ...parts), 'utf8');
}

const roles = source('lib', 'roles.ts');
const page = source('app', '(dashboard)', 'dashboard', 'media', 'page.tsx');
const actions = source('app', '(dashboard)', 'dashboard', 'media', 'actions.ts');
const home = source('app', 'page.tsx');
const dashboardLayout = source('app', '(dashboard)', 'layout.tsx');
const dashboardShell = source('components', 'dashboard', 'DashboardShell.tsx');
const dashboardFlightSearch = source(
  'app',
  '(dashboard)',
  'dashboard',
  'flight-search',
  'page.tsx'
);
const bar = source('components', 'layout', 'AnnouncementBar.tsx');
const migration = source(
  'supabase',
  'migrations',
  '0111_announcement_slider_management.sql'
);
const speedMigration = source(
  'supabase',
  'migrations',
  '0112_announcement_slider_speed.sql'
);

assert.match(roles, /const MEDIA_MANAGERS = \[\.\.\.ADMINS, 'staff_media'\] as const/);
assert.match(roles, /segment: 'media'[\s\S]*roles: MEDIA_MANAGERS,[\s\S]*built: true/);
assert.match(page, /if \(!canManageMedia\(session\.role\)\) notFound\(\)/);
assert.match(
  actions,
  /if \(!session \|\| !canManageMedia\(session\.role\)\)[\s\S]*checkActionLimit\('manageAnnouncements'/,
  'the server action must authorize before consuming a rate-limit or writing'
);
assert.match(actions, /recordSecurityAuditEvent\([\s\S]*announcement_slider\.saved/);
assert.match(home, /getAnnouncementSlider\(\)[\s\S]*<AnnouncementBar/);
assert.match(
  dashboardLayout,
  /getAnnouncementSlider\(\)[\s\S]*announcementMessages=[\s\S]*announcementDurationSeconds=/,
  'the dashboard layout must load and pass the managed ticker settings'
);
assert.match(
  dashboardShell,
  /pathname === '\/dashboard' \|\| pathname === '\/dashboard\/flight-search'/,
  'the dashboard ticker must be limited to home and flight search'
);
assert.match(
  dashboardShell,
  /<DashboardTopbar[\s\S]*showAnnouncement[\s\S]*<AnnouncementBar[\s\S]*<main/,
  'the dashboard ticker must sit directly between the header and page content'
);
assert.match(
  dashboardShell,
  /fullBleedContent[\s\S]*pathname === '\/dashboard\/flight-search'[\s\S]*fullBleedContent \? 'p-0'/,
  'dashboard flight search must remove the shared main padding'
);
assert.match(
  dashboardFlightSearch,
  /absolute inset-x-0 top-0 h-\[255px\] bg-cover bg-center[\s\S]*!background && 'bg-search-gradient'[\s\S]*mx-auto max-w-7xl[\s\S]*<FlightSearchPanel/,
  'the managed image band must stay full width with the search panel centered across its lower edge'
);
assert.match(bar, /bg-navy-950 px-4 py-2 text-white/);
assert.match(bar, /bg-brand-red px-2\.5 py-1/);
assert.match(bar, /ticker-track text-sm text-navy-100/);

const database = new PGlite();
try {
  await database.exec(`
    create role anon;
    create role authenticated;
    create role service_role;
  `);
  await database.exec(migration);
  await database.exec(speedMigration);

  const seeded = await database.query(`
    select message, is_active, sort_order
      from public.announcement_slider_messages
     order by sort_order
  `);
  assert.equal(seeded.rows.length, 4);
  assert.equal(seeded.rows[0].message, 'Summer Sale — up to 40% off select flights to Europe');
  assert.equal(seeded.rows[3].sort_order, 3);

  const replaced = await database.query(`
    select public.replace_announcement_slider_messages_v2(
      'user_media',
      1,
      18,
      '[
        {
          "id":"435fbed5-14c5-4530-a84d-e23af430bb29",
          "text":"First managed message",
          "active":true
        },
        {
          "id":"834c5ffd-b94f-4382-a397-434994e29bed",
          "text":"Saved but hidden",
          "active":false
        }
      ]'::jsonb
    ) as version
  `);
  assert.equal(replaced.rows[0].version, 2);

  const settings = await database.query(`
    select version, scroll_duration_seconds
      from public.announcement_slider_settings
     where id = 'primary'
  `);
  assert.equal(settings.rows[0].version, 2);
  assert.equal(settings.rows[0].scroll_duration_seconds, 18);

  const current = await database.query(`
    select message, is_active, sort_order, updated_by
      from public.announcement_slider_messages
     order by sort_order
  `);
  assert.deepEqual(
    current.rows.map((row) => [row.message, row.is_active, row.sort_order]),
    [
      ['First managed message', true, 0],
      ['Saved but hidden', false, 1],
    ]
  );
  assert.equal(current.rows[0].updated_by, 'user_media');

  await assert.rejects(
    database.query(`
      select public.replace_announcement_slider_messages_v2(
        'user_admin', 1, 28, '[]'::jsonb
      )
    `),
    /changed in another session/
  );
  await assert.rejects(
    database.query(`
      select public.replace_announcement_slider_messages_v2(
        'user_admin',
        2,
        28,
        '[{
          "id":"c32b714b-78c4-4e06-a6e6-1448f78fb629",
          "text":"",
          "active":true
        }]'::jsonb
      )
    `),
    /invalid announcement message/
  );
  await assert.rejects(
    database.query(`
      select public.replace_announcement_slider_messages_v2(
        'user_admin', 2, 5, '[]'::jsonb
      )
    `),
    /invalid announcement slider speed/
  );

  const rls = await database.query(`
    select relname, relrowsecurity
      from pg_class
     where relname in (
       'announcement_slider_settings',
       'announcement_slider_messages'
     )
     order by relname
  `);
  assert.equal(rls.rows.length, 2);
  assert.ok(rls.rows.every((row) => row.relrowsecurity === true));
} finally {
  await database.close();
}

console.log('announcement slider verification passed');
