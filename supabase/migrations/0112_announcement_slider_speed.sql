-- Adjustable announcement-slider speed. The value is the duration of one
-- complete ticker loop: lower values move faster and higher values move slower.

alter table public.announcement_slider_settings
  add column if not exists scroll_duration_seconds integer not null default 28;

alter table public.announcement_slider_settings
  drop constraint if exists announcement_slider_settings_scroll_duration_check;
alter table public.announcement_slider_settings
  add constraint announcement_slider_settings_scroll_duration_check
  check (scroll_duration_seconds between 12 and 90);

create or replace function public.replace_announcement_slider_messages_v2(
  p_actor_user_id text,
  p_expected_version integer,
  p_scroll_duration_seconds integer,
  p_messages jsonb
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_next_version integer;
begin
  if p_scroll_duration_seconds is null
     or p_scroll_duration_seconds not between 12 and 90 then
    raise exception 'invalid announcement slider speed' using errcode = '22023';
  end if;

  -- v1 owns all message validation, row replacement, locking, and optimistic
  -- versioning. Calling it here keeps the speed and message update in this same
  -- transaction while preserving the already-deployed v1 migration contract.
  v_next_version := public.replace_announcement_slider_messages_v1(
    p_actor_user_id,
    p_expected_version,
    p_messages
  );

  update public.announcement_slider_settings
     set scroll_duration_seconds = p_scroll_duration_seconds
   where id = 'primary';

  return v_next_version;
end;
$$;

revoke all on function public.replace_announcement_slider_messages_v2(
  text, integer, integer, jsonb
) from public, anon, authenticated;
grant execute on function public.replace_announcement_slider_messages_v2(
  text, integer, integer, jsonb
) to service_role;

comment on column public.announcement_slider_settings.scroll_duration_seconds is
  'Seconds for one complete ticker animation loop; lower is faster.';
comment on function public.replace_announcement_slider_messages_v2(
  text, integer, integer, jsonb
) is
  'Atomically replaces the announcement messages and their public ticker speed.';
