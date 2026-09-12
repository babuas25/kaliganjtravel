import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';

const migration = fs.readFileSync(
  path.join(
    process.cwd(),
    'supabase',
    'migrations',
    '0116_canonical_supplier_evidence_v2.sql'
  ),
  'utf8'
);

const BASELINE = `
  create extension if not exists pgcrypto;
  create role anon; create role authenticated; create role service_role;

  create table public.flight_bookings (
    id uuid primary key,
    public_ref text not null,
    attempt_id uuid,
    supplier_account text,
    supplier_refs jsonb not null default '{}'::jsonb,
    booking_code_ref text,
    ticket_code_ref text,
    pnr text,
    booking_ref_number text,
    pricing_snapshot jsonb not null default '{}'::jsonb,
    ticket_numbers jsonb not null default '[]'::jsonb,
    airlines_pnr jsonb not null default '[]'::jsonb,
    status text,
    payment_state text,
    payment_amount bigint,
    captured_amount bigint not null default 0,
    refunded_amount bigint not null default 0,
    currency text,
    active_operation_id uuid,
    operation_kind text,
    operation_reason text,
    operation_request_id text,
    operation_actor_user_id text,
    operation_started_at timestamptz,
    operation_prior_status text,
    ticketing_deadline_at timestamptz,
    charged_wallet_account_id uuid,
    issued_by_user_id text,
    issued_at timestamptz,
    booking_status text
  );

  create table public.booking_operations (
    id uuid primary key,
    booking_id uuid not null,
    kind text,
    state text,
    claimed_at timestamptz,
    completed_at timestamptz,
    error_code text,
    error_message text,
    supplier_evidence jsonb not null default '{}'::jsonb
  );

  create table public.booking_reconciliation_cases (
    id uuid primary key,
    subject_booking_id uuid,
    operation_id uuid,
    case_type text,
    state text,
    reason_code text,
    opened_source text,
    opened_at timestamptz not null default clock_timestamp(),
    proposed_outcome text,
    proposal jsonb,
    proposal_hash text,
    financial_disposition text not null default 'none',
    resolution jsonb,
    resolution_outcome text,
    resolution_reason text,
    resolved_by_user_id text,
    resolved_at timestamptz,
    closed_at timestamptz,
    evidence_latest_at timestamptz,
    evidence_normalizer_version integer,
    version integer not null default 1
  );

  create table public.booking_reconciliation_observations (
    id uuid primary key default gen_random_uuid(),
    reconciliation_case_id uuid,
    observation_key text,
    observation_kind text,
    observation_source text,
    actor_user_id text,
    actor_role text,
    normalized_facts jsonb,
    normalized_facts_hash text,
    observed_at timestamptz,
    unique (reconciliation_case_id, observation_key)
  );

  create table public.wallet_reservations (
    id uuid primary key,
    wallet_account_id uuid,
    booking_id uuid,
    booking_attempt_id uuid,
    state text,
    amount bigint,
    currency text,
    issued_by_user_id text,
    captured_at timestamptz,
    reconciliation_at timestamptz,
    reconciliation_reason text
  );

  create table public.wallet_accounts (
    id uuid primary key,
    available_balance bigint not null default 0,
    hold_balance bigint not null default 0,
    currency text not null
  );

  create table public.wallet_ledger_entries (
    id uuid primary key default gen_random_uuid(),
    wallet_account_id uuid,
    transaction_type text,
    amount bigint,
    currency text,
    available_before bigint,
    available_after bigint,
    hold_before bigint,
    hold_after bigint,
    booking_id uuid,
    booking_reference text,
    reservation_id uuid,
    idempotency_key text unique,
    created_by_user_id text,
    created_by_role text,
    remarks text,
    metadata jsonb
  );

  create table public.booking_status_events (
    id bigint generated always as identity primary key,
    booking_id uuid,
    from_lifecycle_status text,
    to_lifecycle_status text,
    stored_status_before text,
    stored_status_after text,
    operation_kind text,
    operation_reason text,
    actor_user_id text,
    supplier_operation text,
    supplier_evidence jsonb,
    idempotency_key text unique,
    operation_id uuid,
    reconciliation_case_id uuid,
    occurrence_number integer,
    effective_at timestamptz,
    observed_at timestamptz,
    event_snapshot jsonb,
    event_version integer
  );

  create table public.security_audit_events (
    actor_user_id text,
    actor_role text,
    action text,
    target_type text,
    target_id text,
    outcome text,
    metadata jsonb
  );

  create function public.resolve_booking_lifecycle(text, jsonb, timestamptz, text)
    returns text language sql immutable as $$ select $1 $$;

  create function public.booking_reconciliation_resolution_contract_v1(
    p_booking_id uuid,
    p_case_id uuid,
    p_expected_case_version integer,
    p_proposal_hash text,
    p_actor_user_id text,
    p_execution_request_key text,
    p_resolution_kind text
  ) returns jsonb language plpgsql as $$
  declare
    v_case public.booking_reconciliation_cases;
    v_reservation public.wallet_reservations;
  begin
    select * into v_case from public.booking_reconciliation_cases
     where id = p_case_id and subject_booking_id = p_booking_id for update;
    if v_case.state = 'resolved'
       and v_case.resolution->>'executionRequestKey' = p_execution_request_key
       and v_case.resolution->>'resolutionKind' = p_resolution_kind then
      return coalesce(v_case.resolution->'result', '{}'::jsonb) ||
        jsonb_build_object('ok', true, 'replay', true, 'caseId', p_case_id);
    end if;
    if v_case.version <> p_expected_case_version
       or v_case.proposal_hash is distinct from p_proposal_hash then
      return jsonb_build_object('ok', false, 'code', 'CASE_VERSION_CONFLICT');
    end if;
    select * into v_reservation from public.wallet_reservations
     where booking_id = p_booking_id for update;
    return jsonb_build_object(
      'ok', true, 'replay', false, 'actorRole', 'superadmin',
      'reservationId', v_reservation.id,
      'walletAccountId', v_reservation.wallet_account_id
    );
  end $$;
`;

function newDb() {
  return new PGlite({ extensions: { pgcrypto } });
}

async function functionCount(db) {
  const result = await db.query(`
    select count(*)::integer as count
      from pg_proc
     where proname in (
       'booking_reconciliation_evidence_v2_authoritative',
       'record_booking_reconciliation_evidence_read_v2',
       'close_booking_reconciliation_no_change_v2',
       'close_booking_ticketing_race_no_change_v2',
       'resolve_booking_reconciliation_ticketed_v2'
     )
  `);
  return result.rows[0].count;
}

const rollbackDb = newDb();
await rollbackDb.exec(BASELINE);
await rollbackDb.exec(`begin; ${migration} rollback;`);
assert.equal(await functionCount(rollbackDb), 0, 'transaction rollback removes all V2 RPCs');
await rollbackDb.close();

const db = newDb();
await db.exec(BASELINE);
const historicalCaseId = '00000000-0000-4000-8000-000000000001';
const historicalObservationId = '00000000-0000-4000-8000-000000000002';
await db.query(
  `insert into public.booking_reconciliation_observations (
    id, reconciliation_case_id, observation_key, observation_kind,
    observation_source, actor_user_id, actor_role, normalized_facts,
    normalized_facts_hash, observed_at
  ) values ($1, $2, $3, 'staff_evidence', 'supplier_read',
    'historical', 'system', '{"version":1}'::jsonb, $4, clock_timestamp())`,
  [
    historicalObservationId,
    historicalCaseId,
    `evidence-read:v1:${'1'.repeat(64)}`,
    '1'.repeat(64),
  ]
);
await db.exec(migration);
assert.equal(await functionCount(db), 5, 'all V2 RPCs compile');
const historical = await db.query(
  `select observation_key, normalized_facts from public.booking_reconciliation_observations
    where id = $1`,
  [historicalObservationId]
);
assert.equal(historical.rows[0].observation_key, `evidence-read:v1:${'1'.repeat(64)}`);
assert.equal(historical.rows[0].normalized_facts.version, 1, 'V1 evidence remains untouched');

function facts(input) {
  const now = new Date();
  const responseAt = new Date(now.getTime() - 2_000).toISOString();
  const requestAt = new Date(now.getTime() - 3_000).toISOString();
  const freshUntil = new Date(now.getTime() + 298_000).toISOString();
  return {
    version: 2,
    evidenceContract: 'canonical_supplier_evidence_v2',
    action: 'supplier_evidence_read',
    bookingId: input.bookingId,
    caseId: input.caseId,
    caseType: 'ticketing_uncertainty',
    requestedPurpose: 'ticketed',
    requestedAirTicketingStatus: 'Confirmed',
    acquiredAt: now.toISOString(),
    evidenceObservedAt: responseAt,
    recordedSources: ['pnr', 'ticket-report'],
    sourceResults: [],
    localContext: {
      storedStatus: input.status,
      paymentState: input.paymentState,
      hasLocalTicketEvidence: input.ticketNumbers.length > 0,
    },
    expectedIdentity: {
      supplierFamily: 'triplover',
      supplierAccount: input.supplierAccount,
      bookingIdentity: {
        transactionId: input.transactionId,
        supplierBookingId: null,
        supplierPnr: input.pnr,
        bookingReference: input.bookingReference,
        airlinePnrs: ['AIRPNR'],
        responseLocators: [],
        identityConflicts: [],
        operationalReferences: {
          itemCodeRef: 'ITEM', priceCodeRef: 'PRICE', bookingCodeRef: 'BOOK',
        },
      },
      passengers: [], itinerary: [],
      tickets: input.ticketNumbers.map((fullNumber) => ({ fullNumber })),
      supplierWorkflowReference: 'OPAQUE',
      financial: {
        currency: 'BDT', supplierPayableMinor: input.supplierPayableMinor,
        supplierGrossMinor: null, currencySource: 'local-booking',
      },
    },
    evidence: {
      pnr: {
        schemaVersion: 2, normalizerVersion: 2,
        supplierFamily: 'triplover', supplierAccount: input.supplierAccount,
        adapterVersion: 2, source: 'pnr', observedAt: responseAt, freshUntil,
        receipt: { requestStartedAt: requestAt, responseReceivedAt: responseAt,
          httpStatus: 200, rawPayloadHash: 'a'.repeat(64) },
        query: { requestedLifecycleState: null },
        requestIdentity: {
          transactionId: input.transactionId, supplierBookingId: null,
          supplierPnr: input.pnr, bookingReference: input.bookingReference,
          airlinePnrs: [], responseLocators: [], identityConflicts: [],
          operationalReferences: {
            itemCodeRef: 'ITEM', priceCodeRef: 'PRICE', bookingCodeRef: 'BOOK',
          },
        },
        bookingIdentity: {
          transactionId: input.transactionId, supplierBookingId: null,
          supplierPnr: null, bookingReference: null, airlinePnrs: ['AIRPNR'],
          responseLocators: [{ value: 'AIRPNR', kind: 'airline-pnr' }],
          identityConflicts: [],
          operationalReferences: {
            itemCodeRef: null, priceCodeRef: null, bookingCodeRef: null,
          },
        },
        passengers: [], itinerary: [], tickets: [], supplierWorkflowReference: null,
        lifecycle: { state: 'ticketed' }, financial: {}, completeness: {},
      },
      ticketReport: {
        schemaVersion: 2, normalizerVersion: 2,
        supplierFamily: 'triplover', supplierAccount: input.supplierAccount,
        adapterVersion: 2, source: 'ticket-report', observedAt: responseAt, freshUntil,
        receipt: { requestStartedAt: requestAt, responseReceivedAt: responseAt,
          httpStatus: 200, rawPayloadHash: 'b'.repeat(64) },
        query: { requestedLifecycleState: 'ticketed' },
        requestIdentity: { transactionId: input.transactionId },
        bookingIdentity: {
          transactionId: input.transactionId, supplierBookingId: '807632',
          supplierPnr: input.pnr, bookingReference: input.bookingReference,
          airlinePnrs: ['AIRPNR'], responseLocators: [], identityConflicts: [],
          operationalReferences: {
            itemCodeRef: 'ITEM', priceCodeRef: 'PRICE', bookingCodeRef: 'BOOK',
          },
        },
        passengers: input.ticketNumbers.map((_, sequence) => ({ sequence })),
        itinerary: [{ sequence: 0 }],
        tickets: input.ticketNumbers.map((fullNumber) => ({ fullNumber })),
        supplierWorkflowReference: null,
        lifecycle: {
          state: 'ticketed', rawStatus: 'Issued',
          issuedAt: '2026-08-27T06:02:16.123Z',
        },
        financial: {
          currency: 'BDT', supplierPayableMinor: input.supplierPayableMinor,
          supplierGrossMinor: null, currencySource: 'supplier',
        },
        completeness: {},
      },
    },
    validation: {
      contractVersion: 2, valid: true, complete: true, fresh: true,
      identityMatches: true, authoritativeFor: 'ticketed', issues: [],
    },
    statusMutation: false,
    walletMutation: false,
    destructiveSupplierCall: false,
  };
}

async function recordEvidence(input, existing = null) {
  const normalizedFacts = existing?.facts ?? facts(input);
  const hash = existing?.hash ?? crypto.createHash('sha256')
    .update(JSON.stringify(normalizedFacts)).digest('hex');
  const result = await db.query(
    `select public.record_booking_reconciliation_evidence_read_v2(
      $1, $2, 'system:test', 'system', $3, $4::jsonb, $5,
      $6::timestamptz, $7::timestamptz
    ) as result`,
    [input.bookingId, input.caseId, input.observationKey,
      JSON.stringify(normalizedFacts), hash,
      normalizedFacts.acquiredAt, normalizedFacts.evidenceObservedAt]
  );
  return { result: result.rows[0].result, facts: normalizedFacts, hash };
}

const raceBookingId = '10000000-0000-4000-8000-000000000001';
const raceOperationId = '10000000-0000-4000-8000-000000000002';
const raceCaseId = '10000000-0000-4000-8000-000000000003';
const raceReservationId = '10000000-0000-4000-8000-000000000004';
await db.query(
  `insert into public.flight_bookings (
    id, public_ref, supplier_account, supplier_refs, booking_code_ref,
    ticket_code_ref, pnr, booking_ref_number, pricing_snapshot, ticket_numbers,
    airlines_pnr, status, payment_state, payment_amount, captured_amount,
    refunded_amount, currency
  ) values ($1, 'STRTESTRACE001', 'firsttrip', $2::jsonb, 'BOOK', 'OPAQUE',
    'SUPPNR', 'BOOKREF', $3::jsonb, '["6182480763274"]'::jsonb,
    '["AIRPNR"]'::jsonb, 'confirmed', 'captured', 12000, 12000, 0, 'BDT')`,
  [raceBookingId, JSON.stringify({ uniqueTransId: 'FST-RACE', itemCodeRef: 'ITEM', priceCodeRef: 'PRICE' }),
    JSON.stringify({ supplierTotalPrice: 100 })]
);
await db.query(
  `insert into public.booking_operations (
    id, booking_id, kind, state, claimed_at, completed_at
  ) values ($1, $2, 'ticketing', 'succeeded',
    clock_timestamp()-interval '30 seconds', clock_timestamp()-interval '10 seconds')`,
  [raceOperationId, raceBookingId]
);
await db.query(
  `insert into public.booking_reconciliation_cases (
    id, subject_booking_id, operation_id, case_type, state, reason_code,
    opened_source, opened_at, financial_disposition
  ) values ($1, $2, $3, 'ticketing_uncertainty', 'open',
    'pnr_sync_conflicts_with_local_truth', 'supplier_sync',
    clock_timestamp()-interval '20 seconds', 'none')`,
  [raceCaseId, raceBookingId, raceOperationId]
);
await db.query(
  `insert into public.wallet_reservations (id, booking_id, state, amount, currency)
   values ($1, $2, 'captured', 12000, 'BDT')`,
  [raceReservationId, raceBookingId]
);
const raceInput = {
  bookingId: raceBookingId, caseId: raceCaseId, status: 'confirmed',
  paymentState: 'captured', supplierAccount: 'firsttrip',
  transactionId: 'FST-RACE', pnr: 'SUPPNR', bookingReference: 'BOOKREF',
  supplierPayableMinor: 10000, ticketNumbers: ['6182480763274'],
  observationKey: `evidence-read:v2:${'2'.repeat(64)}`,
};
const raceRecorded = await recordEvidence(raceInput);
assert.equal(raceRecorded.result.replay, false);
const raceVersionAfterRecord = (await db.query(
  `select version, evidence_normalizer_version from public.booking_reconciliation_cases where id=$1`,
  [raceCaseId]
)).rows[0];
assert.equal(raceVersionAfterRecord.evidence_normalizer_version, 2);
const raceReplay = await recordEvidence(raceInput, raceRecorded);
assert.equal(raceReplay.result.replay, true);
assert.equal(raceReplay.result.observationId, raceRecorded.result.observationId);
const observationCount = await db.query(
  `select count(*)::integer as count from public.booking_reconciliation_observations
    where reconciliation_case_id=$1 and observation_key like 'evidence-read:v2:%'`,
  [raceCaseId]
);
assert.equal(observationCount.rows[0].count, 1);

let mismatchRejected = false;
try {
  await db.query(
    `select public.record_booking_reconciliation_evidence_read_v2(
      $1, $2, 'system:test', 'system', $3, $4::jsonb, $5,
      $6::timestamptz, $7::timestamptz
    )`,
    [raceBookingId, raceCaseId, raceInput.observationKey,
      JSON.stringify(raceRecorded.facts), 'f'.repeat(64),
      raceRecorded.facts.acquiredAt, raceRecorded.facts.evidenceObservedAt]
  );
} catch (error) {
  mismatchRejected = /payload mismatch/i.test(String(error));
}
assert.equal(mismatchRejected, true, 'same idempotency key rejects a different hash');

const beforeRaceClosure = (await db.query(
  `select status, payment_state, captured_amount, refunded_amount, ticket_numbers
     from public.flight_bookings where id=$1`, [raceBookingId]
)).rows[0];
const raceClosure = await db.query(
  `select public.close_booking_ticketing_race_no_change_v2($1,$2,$3) as result`,
  [raceBookingId, raceCaseId, raceRecorded.result.observationId]
);
assert.equal(raceClosure.rows[0].result.closedNoChange, true);
const afterRaceClosure = (await db.query(
  `select status, payment_state, captured_amount, refunded_amount, ticket_numbers
     from public.flight_bookings where id=$1`, [raceBookingId]
)).rows[0];
assert.deepEqual(afterRaceClosure, beforeRaceClosure, 'race closure changes no booking/financial truth');
assert.equal((await db.query(`select count(*)::integer as count from public.wallet_ledger_entries`)).rows[0].count, 0);
const raceClosureReplay = await db.query(
  `select public.close_booking_ticketing_race_no_change_v2($1,$2,$3) as result`,
  [raceBookingId, raceCaseId, raceRecorded.result.observationId]
);
assert.equal(raceClosureReplay.rows[0].result.replay, true);

const conflictingFacts = structuredClone(raceRecorded.facts);
conflictingFacts.evidence.ticketReport.financial.supplierPayableMinor = 9999;
const conflictObservationId = '10000000-0000-4000-8000-000000000005';
await db.query(
  `insert into public.booking_reconciliation_observations (
    id, reconciliation_case_id, observation_key, observation_kind,
    observation_source, actor_user_id, actor_role, normalized_facts,
    normalized_facts_hash, observed_at
  ) values ($1,$2,$3,'staff_evidence','supplier_read','system:test','system',
    $4::jsonb,$5,clock_timestamp())`,
  [conflictObservationId, raceCaseId, `evidence-read:v2:${'3'.repeat(64)}`,
    JSON.stringify(conflictingFacts), '3'.repeat(64)]
);
const conflictAuthority = await db.query(
  `select public.booking_reconciliation_evidence_v2_authoritative($1,$2,$3,'ticketed') as valid`,
  [raceBookingId, raceCaseId, conflictObservationId]
);
assert.equal(conflictAuthority.rows[0].valid, false, 'database independently rejects financial conflict');

const ticketBookingId = '20000000-0000-4000-8000-000000000001';
const ticketOperationId = '20000000-0000-4000-8000-000000000002';
const ticketCaseId = '20000000-0000-4000-8000-000000000003';
const ticketReservationId = '20000000-0000-4000-8000-000000000004';
const walletAccountId = '20000000-0000-4000-8000-000000000005';
await db.query(
  `insert into public.flight_bookings (
    id, public_ref, attempt_id, supplier_account, supplier_refs, booking_code_ref,
    ticket_code_ref, pnr, booking_ref_number, pricing_snapshot, ticket_numbers,
    airlines_pnr, status, payment_state, payment_amount, captured_amount,
    refunded_amount, currency, active_operation_id, operation_kind,
    operation_reason, ticketing_deadline_at
  ) values ($1,'STRTESTTICKET01',gen_random_uuid(),'takeoff',$2::jsonb,'BOOK','OPAQUE',
    'SUPPNR','BOOKREF',$3::jsonb,'[]'::jsonb,'["AIRPNR"]'::jsonb,
    'on-hold','held',12000,0,0,'BDT',$4,'reconciliation',
    'ticketing_reconciliation','2026-08-28T00:00:00Z')`,
  [ticketBookingId, JSON.stringify({ uniqueTransId: 'TOT-TICKET', itemCodeRef: 'ITEM', priceCodeRef: 'PRICE' }),
    JSON.stringify({ supplierTotalPrice: 100 }), ticketOperationId]
);
await db.query(
  `insert into public.booking_operations (id,booking_id,kind,state,claimed_at)
   values ($1,$2,'ticketing','needs_reconciliation',clock_timestamp()-interval '1 minute')`,
  [ticketOperationId, ticketBookingId]
);
await db.query(
  `insert into public.booking_reconciliation_cases (
    id,subject_booking_id,operation_id,case_type,state,financial_disposition,
    proposed_outcome,proposal,proposal_hash
  ) values ($1,$2,$3,'ticketing_uncertainty','assigned','capture_existing_hold',
    'ticketed','{}'::jsonb,$4)`,
  [ticketCaseId, ticketBookingId, ticketOperationId, '4'.repeat(64)]
);
await db.query(
  `insert into public.wallet_accounts (id,available_balance,hold_balance,currency)
   values ($1,50000,12000,'BDT')`, [walletAccountId]
);
await db.query(
  `insert into public.wallet_reservations (
    id,wallet_account_id,booking_id,state,amount,currency
  ) values ($1,$2,$3,'active',12000,'BDT')`,
  [ticketReservationId, walletAccountId, ticketBookingId]
);
const ticketInput = {
  bookingId: ticketBookingId, caseId: ticketCaseId, status: 'on-hold',
  paymentState: 'held', supplierAccount: 'takeoff', transactionId: 'TOT-TICKET',
  pnr: 'SUPPNR', bookingReference: 'BOOKREF', supplierPayableMinor: 10000,
  ticketNumbers: ['6182480763274'],
  observationKey: `evidence-read:v2:${'4'.repeat(64)}`,
};
const ticketRecorded = await recordEvidence(ticketInput);
const ticketCase = (await db.query(
  `select version from public.booking_reconciliation_cases where id=$1`, [ticketCaseId]
)).rows[0];
await db.query(
  `update public.booking_reconciliation_cases
      set proposal=jsonb_build_object('evidenceObservationIds',jsonb_build_array($2::text),'reason','verified'),
          proposal_hash=$3
    where id=$1`,
  [ticketCaseId, ticketRecorded.result.observationId, '4'.repeat(64)]
);
const executionKey = 'canonical-v2-test-execution';
const firstResolution = await db.query(
  `select public.resolve_booking_reconciliation_ticketed_v2($1,$2,$3,$4,$5,$6) as result`,
  [ticketBookingId, ticketCaseId, ticketCase.version, '4'.repeat(64),
    'staff:test', executionKey]
);
assert.equal(firstResolution.rows[0].result.ok, true);
assert.equal(firstResolution.rows[0].result.replay, false);
const resolvedBooking = (await db.query(
  `select status,payment_state,captured_amount,refunded_amount,issued_at,
          ticket_code_ref,ticket_numbers,supplier_refs,ticketing_deadline_at
     from public.flight_bookings where id=$1`, [ticketBookingId]
)).rows[0];
assert.equal(resolvedBooking.status, 'confirmed');
assert.equal(resolvedBooking.payment_state, 'captured');
assert.equal(resolvedBooking.captured_amount, 12000);
assert.equal(resolvedBooking.refunded_amount, 0);
assert.equal(resolvedBooking.ticket_code_ref, 'OPAQUE');
assert.deepEqual(resolvedBooking.ticket_numbers, ['6182480763274']);
assert.equal(resolvedBooking.supplier_refs.uniqueTransId, 'TOT-TICKET');
assert.equal(new Date(resolvedBooking.issued_at).toISOString(), '2026-08-27T06:02:16.123Z');
const firstLedgerCount = (await db.query(
  `select count(*)::integer as count from public.wallet_ledger_entries where booking_id=$1`,
  [ticketBookingId]
)).rows[0].count;
assert.equal(firstLedgerCount, 1);
assert.equal((await db.query(`select hold_balance from public.wallet_accounts where id=$1`, [walletAccountId])).rows[0].hold_balance, 0);
const replayResolution = await db.query(
  `select public.resolve_booking_reconciliation_ticketed_v2($1,$2,$3,$4,$5,$6) as result`,
  [ticketBookingId, ticketCaseId, ticketCase.version, '4'.repeat(64),
    'staff:test', executionKey]
);
assert.equal(replayResolution.rows[0].result.replay, true);
assert.equal((await db.query(
  `select count(*)::integer as count from public.wallet_ledger_entries where booking_id=$1`,
  [ticketBookingId]
)).rows[0].count, 1, 'exact replay creates no duplicate ledger movement');
assert.equal((await db.query(`select hold_balance from public.wallet_accounts where id=$1`, [walletAccountId])).rows[0].hold_balance, 0);

await db.close();

console.log(JSON.stringify({
  checks: 'passed',
  environment: 'disposable embedded PostgreSQL (PGlite)',
  migration: '0116_canonical_supplier_evidence_v2.sql',
  verified: {
    rpcCompilation: true,
    transactionRollbackRemovesMigration: true,
    historicalV1ObservationUnchanged: true,
    v2RecordReplayIdempotent: true,
    requestHashMismatchRejected: true,
    financialConflictRejected: true,
    ticketingRaceClosureNoBookingOrWalletMutation: true,
    ticketedCaptureAtomic: true,
    ticketedCaptureExactReplayNoDuplicateLedger: true,
  },
}, null, 2));
