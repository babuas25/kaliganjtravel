-- Schedule lifecycle observation and email retries outside Vercel Cron so the
-- application remains compatible with the Vercel Hobby plan.

create extension if not exists pg_cron with schema pg_catalog;
create extension if not exists pg_net with schema extensions;

do $migration$
begin
  if not exists (
    select 1 from vault.secrets where name = 'booking_status_app_url'
  ) then
    raise exception 'Vault secret booking_status_app_url is required';
  end if;
  if not exists (
    select 1 from vault.secrets where name = 'booking_status_cron_secret'
  ) then
    raise exception 'Vault secret booking_status_cron_secret is required';
  end if;

  -- Make the migration safe after any manually-created trial schedule.
  perform cron.unschedule(jobid)
  from cron.job
  where jobname in (
    'booking-status-emails-every-5-minutes',
    'booking-status-emails-every-15-minutes'
  );

  perform cron.schedule(
    'booking-status-emails-every-15-minutes',
    '*/15 * * * *',
    $job$
      select net.http_get(
        url := (
          select decrypted_secret
          from vault.decrypted_secrets
          where name = 'booking_status_app_url'
        ) || '/api/cron/booking-status-emails',
        headers := jsonb_build_object(
          'Authorization',
          'Bearer ' || (
            select decrypted_secret
            from vault.decrypted_secrets
            where name = 'booking_status_cron_secret'
          )
        ),
        timeout_milliseconds := 60000
      ) as request_id;
    $job$
  );
end
$migration$;

comment on extension pg_cron is
  'Runs the protected booking status email dispatcher every 15 minutes.';
