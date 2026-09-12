-- Change passenger display references without changing profile identity or details.
begin;
set local lock_timeout = '5s';
lock table public.passenger_profiles, public.passenger_profile_ref_counters in access exclusive mode;

create or replace function public.allocate_passenger_profile_ref_for(p_date date)
returns text
language plpgsql
as $$
declare
  v_next integer;
begin
  insert into public.passenger_profile_ref_counters as c (ref_date, last_value)
  values (p_date, 1)
  on conflict (ref_date) do update
    set last_value = c.last_value + 1,
        updated_at = now()
  returning c.last_value into v_next;

  return 'KTP' || to_char(p_date, 'YYMMDD') || lpad(v_next::text, 6, '0');
end;
$$;

alter table public.passenger_profiles drop constraint passenger_profiles_public_ref_format_check;
alter table public.passenger_profiles disable trigger passenger_profiles_public_ref_immutable;
alter table public.passenger_profiles disable trigger passenger_profiles_touch_updated_at;
update public.passenger_profiles
  set public_ref = 'KTP' || substring(public_ref from 4)
  where public_ref ~ '^STP[0-9]{12}$';
alter table public.passenger_profiles enable trigger passenger_profiles_touch_updated_at;
alter table public.passenger_profiles enable trigger passenger_profiles_public_ref_immutable;
alter table public.passenger_profiles add constraint passenger_profiles_public_ref_format_check
  check (public_ref ~ '^KTP[0-9]{12}$');
comment on column public.passenger_profiles.public_ref is
  'Immutable public passenger identifier, KTPYYMMDD###### (for example, KTP260911000001).';
commit;
