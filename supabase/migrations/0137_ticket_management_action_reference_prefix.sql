-- Make Ticket Management references self-describing without changing their
-- unique UUID-derived suffix:
--   TMRR = Refund, TMRE = Reissue/Exchange, TMRV = VOID.

alter table public.ticket_management_requests
  drop constraint ticket_management_requests_public_ref_check;

alter table public.ticket_management_requests
  alter column public_ref drop default;

update public.ticket_management_requests
   set public_ref = case action
     when 'refund' then 'TMRR' || substring(public_ref from 4)
     when 'reissue' then 'TMRE' || substring(public_ref from 4)
     when 'void' then 'TMRV' || substring(public_ref from 4)
   end
 where public_ref ~ '^TMR[A-F0-9]{12}$';

alter table public.ticket_management_requests
  add constraint ticket_management_requests_public_ref_check
    check (public_ref ~ '^TMR[REV][A-F0-9]{12}$');

create or replace function public.assign_ticket_management_public_ref_v1()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  -- The old generic TMR default is treated as an automatic value and replaced.
  -- Explicit valid action-prefixed references remain available for controlled
  -- data imports.
  if new.public_ref is null or new.public_ref ~ '^TMR[A-F0-9]{12}$' then
    new.public_ref := case new.action
      when 'refund' then 'TMRR'
      when 'reissue' then 'TMRE'
      when 'void' then 'TMRV'
    end || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 12));
  end if;
  return new;
end;
$$;

drop trigger if exists ticket_management_requests_assign_public_ref
  on public.ticket_management_requests;
create trigger ticket_management_requests_assign_public_ref
  before insert on public.ticket_management_requests
  for each row execute function public.assign_ticket_management_public_ref_v1();

comment on column public.ticket_management_requests.public_ref is
  'Action-specific Ticket Management reference: TMRR (Refund), TMRE (Reissue/Exchange), or TMRV (VOID), followed by 12 uppercase hexadecimal characters.';
