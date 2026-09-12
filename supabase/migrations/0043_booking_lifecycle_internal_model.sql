-- Additive internal lifecycle model.
--
-- This migration deliberately does not change the seven public booking
-- statuses, existing lifecycle projection, current writers, wallet behavior,
-- or email worker. Later migrations will backfill and activate each path behind
-- independently reversible application gates.

-- 1. Durable booking operations --------------------------------------------

create table if not exists public.booking_operations (
  id                            uuid primary key default gen_random_uuid(),
  booking_id                    uuid not null
                                references public.flight_bookings (id)
                                on delete restrict,
  kind                          text not null,
  state                         text not null,
  reason_code                   text not null,
  reason_detail                 text,
  request_key                   text not null,
  request_payload_hash          text not null,
  actor_user_id                 text not null,
  actor_role                    text not null,
  source                        text not null,
  prior_stored_status           text,
  prior_lifecycle_status        text,
  supplier                     text,
  supplier_operation            text,
  supplier_unique_trans_id      text,
  supplier_booking_code_ref     text,
  supplier_pnr                  text,
  supplier_evidence             jsonb not null default '{}'::jsonb,
  error_code                    text,
  error_message                 text,
  policy_version                integer not null default 1,
  claimed_at                    timestamptz not null default now(),
  supplier_call_started_at      timestamptz,
  supplier_response_received_at timestamptz,
  external_action_due_at        timestamptz,
  reconciliation_required_at    timestamptz,
  completed_at                  timestamptz,
  created_at                    timestamptz not null default now(),
  updated_at                    timestamptz not null default now()
);

drop trigger if exists booking_operations_touch_updated_at
  on public.booking_operations;
create trigger booking_operations_touch_updated_at
  before update on public.booking_operations
  for each row execute function public.touch_updated_at();

alter table public.booking_operations
  add constraint booking_operations_kind_check
  check (kind in (
    'ticketing',
    'cancellation',
    'imported_manual_ticketing'
  ));

alter table public.booking_operations
  add constraint booking_operations_state_check
  check (state in (
    'claimed',
    'supplier_call_started',
    'awaiting_external_action',
    'needs_reconciliation',
    'succeeded',
    'failed'
  ));

create unique index if not exists booking_operations_one_active_per_booking_idx
  on public.booking_operations (booking_id)
  where state in (
    'claimed',
    'supplier_call_started',
    'awaiting_external_action',
    'needs_reconciliation'
  );

alter table public.flight_bookings
  add column if not exists active_operation_id uuid;

alter table public.flight_bookings
  add constraint flight_bookings_active_operation_fk
  foreign key (active_operation_id)
  references public.booking_operations (id)
  on delete set null
  not valid;

-- 2. Owned reconciliation cases --------------------------------------------

create table if not exists public.booking_reconciliation_cases (
  id                         uuid primary key default gen_random_uuid(),
  subject_booking_id         uuid
                             references public.flight_bookings (id)
                             on delete restrict,
  subject_booking_attempt_id uuid
                             references public.booking_attempts (id)
                             on delete restrict,
  operation_id               uuid
                             references public.booking_operations (id)
                             on delete restrict,
  case_type                  text not null,
  state                      text not null default 'open',
  reason_code                text not null,
  reason_detail              text,
  opened_source              text not null,
  opened_by_user_id          text not null,
  opened_by_role             text not null,
  opened_at                  timestamptz not null default now(),
  policy_version             integer not null default 1,
  created_at                 timestamptz not null default now(),
  updated_at                 timestamptz not null default now(),
  constraint booking_reconciliation_cases_one_subject_check
    check (num_nonnulls(subject_booking_id, subject_booking_attempt_id) = 1)
);

drop trigger if exists booking_reconciliation_cases_touch_updated_at
  on public.booking_reconciliation_cases;
create trigger booking_reconciliation_cases_touch_updated_at
  before update on public.booking_reconciliation_cases
  for each row execute function public.touch_updated_at();

alter table public.booking_reconciliation_cases
  add constraint booking_reconciliation_cases_type_check
  check (case_type in (
    'ticketing_uncertainty',
    'cancellation_uncertainty',
    'legacy_review',
    'terminal_conflict',
    'direct_ticket_payment_failure',
    'imported_manual_ticketing',
    'imported_payment_conflict',
    'attempt_uncertainty',
    'historical_inconsistency'
  ));

alter table public.booking_reconciliation_cases
  add constraint booking_reconciliation_cases_state_check
  check (state in (
    'open',
    'assigned',
    'awaiting_supplier',
    'awaiting_finance',
    'awaiting_approval',
    'resolved',
    'closed_no_change'
  ));

alter table public.booking_reconciliation_cases
  add column assigned_team text,
  add column assignee_user_id text,
  add column assigned_at timestamptz,
  add column severity text not null default 'medium',
  add column priority smallint not null default 50,
  add column due_at timestamptz,
  add column escalated_at timestamptz,
  add column escalation_level smallint not null default 0,
  add column escalation_reason text,
  add column evidence jsonb not null default '[]'::jsonb,
  add column evidence_latest_at timestamptz,
  add column evidence_normalizer_version integer,
  add column proposed_outcome text,
  add column proposal jsonb not null default '{}'::jsonb,
  add column proposal_hash text,
  add column proposed_by_user_id text,
  add column proposed_at timestamptz,
  add column approved_by_user_id text,
  add column approved_at timestamptz,
  add column rejected_by_user_id text,
  add column rejected_at timestamptz,
  add column rejection_reason text,
  add column resolution_outcome text,
  add column resolution jsonb not null default '{}'::jsonb,
  add column resolution_reason text,
  add column resolved_by_user_id text,
  add column resolved_at timestamptz,
  add column closed_at timestamptz,
  add column version integer not null default 1;

alter table public.booking_reconciliation_cases
  add column financial_disposition text not null default 'none',
  add column financial_amount bigint,
  add column financial_currency text,
  add column external_settlement_reference text,
  add constraint booking_reconciliation_cases_financial_disposition_check
    check (financial_disposition in (
      'none',
      'capture_existing_hold',
      'release_existing_hold',
      'full_refund',
      'partial_refund',
      'no_refund_due',
      'externally_settled',
      'manual_adjustment_required'
    ));

create unique index if not exists
  booking_reconciliation_cases_one_open_booking_type_idx
  on public.booking_reconciliation_cases (subject_booking_id, case_type)
  where subject_booking_id is not null
    and state in (
      'open', 'assigned', 'awaiting_supplier',
      'awaiting_finance', 'awaiting_approval'
    );

create unique index if not exists
  booking_reconciliation_cases_one_open_attempt_type_idx
  on public.booking_reconciliation_cases (subject_booking_attempt_id, case_type)
  where subject_booking_attempt_id is not null
    and state in (
      'open', 'assigned', 'awaiting_supplier',
      'awaiting_finance', 'awaiting_approval'
    );

-- 3. Occurrence-aware lifecycle history ------------------------------------

alter table public.booking_status_events
  add column if not exists operation_id uuid,
  add column if not exists reconciliation_case_id uuid,
  add column if not exists occurrence_id uuid not null default gen_random_uuid(),
  add column if not exists occurrence_number integer,
  add column if not exists effective_at timestamptz,
  add column if not exists observed_at timestamptz,
  add column if not exists event_snapshot jsonb not null default '{}'::jsonb,
  add column if not exists event_version integer not null default 1;

alter table public.booking_status_events
  add constraint booking_status_events_operation_fk
  foreign key (operation_id)
  references public.booking_operations (id)
  on delete restrict
  not valid;

alter table public.booking_status_events
  add constraint booking_status_events_reconciliation_case_fk
  foreign key (reconciliation_case_id)
  references public.booking_reconciliation_cases (id)
  on delete restrict
  not valid;

create unique index if not exists booking_status_events_occurrence_id_idx
  on public.booking_status_events (occurrence_id);

-- 4. Transactional notification outbox -------------------------------------

create table if not exists public.booking_notification_outbox (
  id                       uuid primary key default gen_random_uuid(),
  lifecycle_event_id       bigint not null
                           references public.booking_status_events (id)
                           on delete restrict,
  booking_id               uuid not null
                           references public.flight_bookings (id)
                           on delete restrict,
  notification_kind        text not null default 'booking_status',
  lifecycle_status         text not null,
  event_snapshot           jsonb not null,
  delivery_policy          text not null default 'send',
  state                    text not null default 'pending',
  policy_version           integer not null default 1,
  available_at             timestamptz not null default now(),
  grace_expires_at         timestamptz,
  claimed_at               timestamptz,
  claim_token              uuid,
  attempt_count            integer not null default 0,
  max_attempts             integer not null default 8,
  last_error               text,
  suppression_reason       text,
  superseded_by_outbox_id  uuid
                           references public.booking_notification_outbox (id)
                           on delete restrict,
  completed_at             timestamptz,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now(),
  constraint booking_notification_outbox_event_kind_key
    unique (lifecycle_event_id, notification_kind),
  constraint booking_notification_outbox_kind_check
    check (notification_kind = 'booking_status'),
  constraint booking_notification_outbox_status_check
    check (lifecycle_status in (
      'on-hold', 'pending', 'in-progress', 'confirmed', 'expired',
      'unconfirmed', 'cancelled'
    )),
  constraint booking_notification_outbox_delivery_policy_check
    check (delivery_policy in ('send', 'grace', 'suppress')),
  constraint booking_notification_outbox_state_check
    check (state in (
      'pending', 'processing', 'sent', 'suppressed', 'superseded',
      'dead_letter'
    ))
);

drop trigger if exists booking_notification_outbox_touch_updated_at
  on public.booking_notification_outbox;
create trigger booking_notification_outbox_touch_updated_at
  before update on public.booking_notification_outbox
  for each row execute function public.touch_updated_at();

create table if not exists public.booking_notification_deliveries (
  id                     uuid primary key default gen_random_uuid(),
  outbox_id              uuid not null
                          references public.booking_notification_outbox (id)
                          on delete restrict,
  recipient_kind         text not null,
  recipient_address      text not null,
  recipient_address_hash text not null,
  is_hidden_copy         boolean not null default false,
  channel                text not null default 'email',
  state                  text not null default 'pending',
  rendered_content       jsonb,
  attempt_count          integer not null default 0,
  max_attempts           integer not null default 8,
  next_attempt_at        timestamptz not null default now(),
  claimed_at             timestamptz,
  claim_token            uuid,
  last_attempt_at        timestamptz,
  sent_at                timestamptz,
  completed_at           timestamptz,
  provider_message_id    text,
  last_error             text,
  suppression_reason     text,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  constraint booking_notification_deliveries_recipient_key
    unique (outbox_id, channel, recipient_address_hash),
  constraint booking_notification_deliveries_recipient_kind_check
    check (recipient_kind in (
      'customer_contact', 'booking_user', 'agency_user', 'system_copy'
    )),
  constraint booking_notification_deliveries_channel_check
    check (channel = 'email'),
  constraint booking_notification_deliveries_state_check
    check (state in (
      'pending', 'processing', 'retry', 'sent', 'failed', 'suppressed',
      'superseded', 'dead_letter'
    ))
);

drop trigger if exists booking_notification_deliveries_touch_updated_at
  on public.booking_notification_deliveries;
create trigger booking_notification_deliveries_touch_updated_at
  before update on public.booking_notification_deliveries
  for each row execute function public.touch_updated_at();

-- 5. Additive safety constraints -------------------------------------------

alter table public.booking_operations
  add constraint booking_operations_reason_code_check
    check (reason_code ~ '^[a-z][a-z0-9_]{0,99}$'),
  add constraint booking_operations_request_key_check
    check (char_length(request_key) between 1 and 255),
  add constraint booking_operations_payload_hash_check
    check (request_payload_hash ~ '^[a-f0-9]{64}$'),
  add constraint booking_operations_source_check
    check (source in (
      'customer', 'staff', 'system', 'import', 'backfill', 'reconciliation'
    )),
  add constraint booking_operations_prior_stored_status_check
    check (prior_stored_status is null or prior_stored_status in (
      'on-hold', 'pending', 'in-progress', 'confirmed', 'cancelled'
    )),
  add constraint booking_operations_prior_lifecycle_status_check
    check (prior_lifecycle_status is null or prior_lifecycle_status in (
      'on-hold', 'pending', 'in-progress', 'confirmed', 'expired',
      'unconfirmed', 'cancelled'
    )),
  add constraint booking_operations_supplier_evidence_check
    check (jsonb_typeof(supplier_evidence) = 'object'),
  add constraint booking_operations_policy_version_check
    check (policy_version > 0),
  add constraint booking_operations_timestamp_order_check
    check (
      (supplier_call_started_at is null
        or supplier_call_started_at >= claimed_at)
      and (supplier_response_received_at is null
        or (supplier_call_started_at is not null
          and supplier_response_received_at >= supplier_call_started_at))
      and (reconciliation_required_at is null
        or reconciliation_required_at >= claimed_at)
      and (completed_at is null or completed_at >= claimed_at)
    ),
  add constraint booking_operations_completion_state_check
    check (
      (state in ('succeeded', 'failed') and completed_at is not null)
      or (state not in ('succeeded', 'failed') and completed_at is null)
    );

alter table public.booking_reconciliation_cases
  add constraint booking_reconciliation_cases_reason_code_check
    check (reason_code ~ '^[a-z][a-z0-9_]{0,99}$'),
  add constraint booking_reconciliation_cases_opened_source_check
    check (opened_source in (
      'system', 'staff', 'backfill', 'supplier_sync', 'operation',
      'historical_remediation'
    )),
  add constraint booking_reconciliation_cases_opened_actor_check
    check (
      nullif(btrim(opened_by_user_id), '') is not null
      and nullif(btrim(opened_by_role), '') is not null
    ),
  add constraint booking_reconciliation_cases_assigned_team_check
    check (assigned_team is null or assigned_team in (
      'support', 'accounts', 'admin'
    )),
  add constraint booking_reconciliation_cases_severity_check
    check (severity in ('low', 'medium', 'high', 'critical')),
  add constraint booking_reconciliation_cases_priority_check
    check (priority between 0 and 100),
  add constraint booking_reconciliation_cases_escalation_level_check
    check (escalation_level between 0 and 2),
  add constraint booking_reconciliation_cases_evidence_check
    check (jsonb_typeof(evidence) = 'array'),
  add constraint booking_reconciliation_cases_proposal_check
    check (jsonb_typeof(proposal) = 'object'),
  add constraint booking_reconciliation_cases_resolution_check
    check (jsonb_typeof(resolution) = 'object'),
  add constraint booking_reconciliation_cases_proposal_hash_check
    check (proposal_hash is null or proposal_hash ~ '^[a-f0-9]{64}$'),
  add constraint booking_reconciliation_cases_version_check
    check (version > 0 and policy_version > 0),
  add constraint booking_reconciliation_cases_financial_amount_check
    check (financial_amount is null or financial_amount > 0),
  add constraint booking_reconciliation_cases_financial_currency_check
    check (financial_currency is null or financial_currency ~ '^[A-Z]{3}$'),
  add constraint booking_reconciliation_cases_partial_refund_check
    check (
      financial_disposition <> 'partial_refund'
      or (financial_amount is not null and financial_currency is not null)
    ),
  add constraint booking_reconciliation_cases_external_settlement_check
    check (
      financial_disposition <> 'externally_settled'
      or nullif(btrim(external_settlement_reference), '') is not null
    ),
  add constraint booking_reconciliation_cases_maker_checker_check
    check (
      approved_by_user_id is null
      or (proposed_by_user_id is not null
        and approved_by_user_id <> proposed_by_user_id)
    ),
  add constraint booking_reconciliation_cases_resolution_state_check
    check (
      (state in ('resolved', 'closed_no_change') and resolved_at is not null)
      or (state not in ('resolved', 'closed_no_change') and resolved_at is null)
    );

alter table public.booking_status_events
  add constraint booking_status_events_occurrence_number_check
    check (occurrence_number is null or occurrence_number > 0) not valid,
  add constraint booking_status_events_snapshot_check
    check (jsonb_typeof(event_snapshot) = 'object') not valid,
  add constraint booking_status_events_version_check
    check (event_version > 0) not valid,
  add constraint booking_status_events_effective_observed_check
    check (
      effective_at is null or observed_at is null or observed_at >= effective_at
    ) not valid;

alter table public.booking_notification_outbox
  add constraint booking_notification_outbox_snapshot_check
    check (jsonb_typeof(event_snapshot) = 'object'),
  add constraint booking_notification_outbox_attempts_check
    check (
      attempt_count >= 0 and max_attempts > 0
      and attempt_count <= max_attempts
    ),
  add constraint booking_notification_outbox_policy_version_check
    check (policy_version > 0),
  add constraint booking_notification_outbox_grace_check
    check (
      delivery_policy <> 'grace' or grace_expires_at is not null
    ),
  add constraint booking_notification_outbox_completion_check
    check (
      (state in ('sent', 'suppressed', 'superseded', 'dead_letter')
        and completed_at is not null)
      or (state in ('pending', 'processing') and completed_at is null)
    ),
  add constraint booking_notification_outbox_superseded_check
    check (
      state <> 'superseded' or superseded_by_outbox_id is not null
    );

alter table public.booking_notification_deliveries
  add constraint booking_notification_deliveries_address_check
    check (nullif(btrim(recipient_address), '') is not null),
  add constraint booking_notification_deliveries_address_hash_check
    check (recipient_address_hash ~ '^[a-f0-9]{64}$'),
  add constraint booking_notification_deliveries_hidden_copy_check
    check (is_hidden_copy = (recipient_kind = 'system_copy')),
  add constraint booking_notification_deliveries_rendered_content_check
    check (
      rendered_content is null or jsonb_typeof(rendered_content) = 'object'
    ),
  add constraint booking_notification_deliveries_attempts_check
    check (
      attempt_count >= 0 and max_attempts > 0
      and attempt_count <= max_attempts
    ),
  add constraint booking_notification_deliveries_completion_check
    check (
      (state in (
        'sent', 'failed', 'suppressed', 'superseded', 'dead_letter'
      ) and completed_at is not null)
      or (state in ('pending', 'processing', 'retry')
        and completed_at is null)
    );

-- 6. Operational indexes ----------------------------------------------------

create unique index if not exists booking_operations_request_key_idx
  on public.booking_operations (request_key);

create index if not exists booking_operations_booking_created_idx
  on public.booking_operations (booking_id, created_at desc, id);

create index if not exists booking_operations_watchdog_idx
  on public.booking_operations (supplier_call_started_at, id)
  where state = 'supplier_call_started';

create index if not exists booking_operations_external_due_idx
  on public.booking_operations (external_action_due_at, id)
  where state = 'awaiting_external_action';

create index if not exists flight_bookings_active_operation_id_idx
  on public.flight_bookings (active_operation_id)
  where active_operation_id is not null;

create index if not exists booking_reconciliation_cases_open_queue_idx
  on public.booking_reconciliation_cases (
    assigned_team, severity, priority, due_at, created_at, id
  )
  where state in (
    'open', 'assigned', 'awaiting_supplier',
    'awaiting_finance', 'awaiting_approval'
  );

create index if not exists booking_reconciliation_cases_due_idx
  on public.booking_reconciliation_cases (due_at, id)
  where state in (
    'open', 'assigned', 'awaiting_supplier',
    'awaiting_finance', 'awaiting_approval'
  ) and due_at is not null;

create index if not exists booking_reconciliation_cases_operation_idx
  on public.booking_reconciliation_cases (operation_id)
  where operation_id is not null;

create unique index if not exists
  booking_status_events_occurrence_number_idx
  on public.booking_status_events (
    booking_id, to_lifecycle_status, occurrence_number
  )
  where occurrence_number is not null;

create index if not exists booking_status_events_operation_created_idx
  on public.booking_status_events (operation_id, created_at, id)
  where operation_id is not null;

create index if not exists booking_status_events_case_created_idx
  on public.booking_status_events (reconciliation_case_id, created_at, id)
  where reconciliation_case_id is not null;

create index if not exists booking_notification_outbox_claim_idx
  on public.booking_notification_outbox (available_at, created_at, id)
  where state = 'pending';

create index if not exists booking_notification_outbox_booking_created_idx
  on public.booking_notification_outbox (booking_id, created_at desc, id);

create index if not exists booking_notification_deliveries_claim_idx
  on public.booking_notification_deliveries (next_attempt_at, created_at, id)
  where state in ('pending', 'retry');

create index if not exists booking_notification_deliveries_outbox_state_idx
  on public.booking_notification_deliveries (outbox_id, state, created_at, id);

-- 7. Least privilege and schema documentation ------------------------------

alter table public.booking_operations enable row level security;
alter table public.booking_reconciliation_cases enable row level security;
alter table public.booking_notification_outbox enable row level security;
alter table public.booking_notification_deliveries enable row level security;

revoke all on table public.booking_operations
  from public, anon, authenticated, service_role;
revoke all on table public.booking_reconciliation_cases
  from public, anon, authenticated, service_role;
revoke all on table public.booking_notification_outbox
  from public, anon, authenticated, service_role;
revoke all on table public.booking_notification_deliveries
  from public, anon, authenticated, service_role;

grant select, insert, update on table public.booking_operations
  to service_role;
grant select, insert, update on table public.booking_reconciliation_cases
  to service_role;
grant select, insert, update on table public.booking_notification_outbox
  to service_role;
grant select, insert, update on table public.booking_notification_deliveries
  to service_role;

comment on table public.booking_operations is
  'Durable internal supplier/manual operation identity and timing. Separate from the seven public booking statuses.';
comment on column public.booking_operations.request_key is
  'Server-generated idempotency identity. Reuse is valid only with the same payload hash and operation subject.';
comment on column public.booking_operations.reason_code is
  'Stable internal subtype explaining the operation without expanding the seven public status values.';
comment on column public.booking_operations.supplier_call_started_at is
  'Authoritative instant immediately before the irreversible supplier HTTP call; never derived from booking creation time.';
comment on column public.booking_operations.supplier_evidence is
  'Protected normalized supplier evidence/identifiers. Passenger-safe rendering uses lifecycle event snapshots instead.';

comment on column public.flight_bookings.active_operation_id is
  'Nullable rolling-deployment pointer to the current internal operation. Existing operation_* columns remain compatibility fields until Phase 10.';

comment on table public.booking_reconciliation_cases is
  'Owned, SLA-bound, evidence-backed workflow for booking or attempt uncertainty and financial/terminal conflicts.';
comment on column public.booking_reconciliation_cases.reason_code is
  'Stable reason the case was opened; reason_detail may add bounded human context but never replaces this code.';
comment on column public.booking_reconciliation_cases.opened_source is
  'Immutable origin of the case: system, staff, backfill, supplier sync, operation, or historical remediation.';
comment on column public.booking_reconciliation_cases.financial_disposition is
  'Explicit case outcome for wallet/settlement handling; never authorizes money movement without an approved case-bound RPC.';
comment on column public.booking_reconciliation_cases.version is
  'Optimistic concurrency version checked by every proposal, approval, assignment, and resolution mutation.';

comment on column public.booking_status_events.occurrence_id is
  'Stable identity for this lifecycle occurrence, including status re-entry.';
comment on column public.booking_status_events.effective_at is
  'Business-effective status instant when authoritatively known.';
comment on column public.booking_status_events.observed_at is
  'Instant this system observed and persisted the authoritative status fact.';
comment on column public.booking_status_events.event_snapshot is
  'Versioned render-safe snapshot used by notifications so later booking edits cannot alter historical email meaning.';

comment on table public.booking_notification_outbox is
  'Transactional lifecycle-event notification intent with grace, suppression, supersession, retry, and dead-letter state.';
comment on table public.booking_notification_deliveries is
  'Independent recipient delivery outcomes, including the hidden system-copy recipient, keyed by normalized address hash.';
comment on column public.booking_notification_deliveries.recipient_address is
  'Protected delivery address. Never expose system_copy rows or addresses through customer DTOs.';

comment on table public.booking_status_email_deliveries is
  'Legacy once-per-booking/status delivery evidence retained during occurrence-outbox migration. Do not reset or resend baseline rows.';
