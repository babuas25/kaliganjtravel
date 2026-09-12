-- An imported supplier hold is only a payable offer. It has not been charged
-- until the wallet owner explicitly confirms. NOT VALID avoids rewriting or
-- silently repairing historical rows while enforcing the invariant for every
-- new/updated row immediately; historical validation belongs to Phase 9/10.

alter table public.flight_bookings
  add constraint flight_bookings_impexp_on_hold_unpaid_check
  check (
    import_source is distinct from 'IMP_EXP'
    or status <> 'on-hold'
    or (
      payment_state = 'unpaid'
      and charged_wallet_account_id is null
      and captured_amount = 0
      and refunded_amount = 0
    )
  ) not valid;

comment on constraint flight_bookings_impexp_on_hold_unpaid_check
  on public.flight_bookings is
  'An IMP_EXP On Hold row remains Unpaid with no charged account/capture/refund until an explicit owner confirmation atomically moves it out of On Hold.';
