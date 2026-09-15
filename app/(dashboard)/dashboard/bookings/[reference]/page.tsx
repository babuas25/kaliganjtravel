import { ArrowLeft } from 'lucide-react';
import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';

import BookingDetails from '@/components/flights/BookingDetails';
import BookingUserVisibilityPanel from '@/components/dashboard/bookings/BookingUserVisibilityPanel';
import BookingEvidenceReader from '@/components/dashboard/bookings/BookingEvidenceReader';
import BookingLifecycleTimeline from '@/components/dashboard/bookings/BookingLifecycleTimeline';
import LocalTimeLimitDecisionPanel from '@/components/dashboard/bookings/LocalTimeLimitDecisionPanel';
import ImportedManualTicketFinancialPanel from '@/components/dashboard/bookings/ImportedManualTicketFinancialPanel';
import ImportedBookingTicketingResolutionPanel from '@/components/dashboard/bookings/ImportedBookingTicketingResolutionPanel';
import ManualBookingStatusPanel from '@/components/dashboard/bookings/ManualBookingStatusPanel';
import SuperAdminBookingDecisionPanel from '@/components/dashboard/bookings/SuperAdminBookingDecisionPanel';
import { bookingLifecycleRolloutState } from '@/lib/booking-lifecycle/rollout';
import { ticketManagementRolloutEnabled } from '@/lib/ticket-management/rollout';
import { ticketManagementActionsForBooking } from '@/lib/ticket-management/booking-actions';
import type { TicketManagementRequestReference } from '@/lib/ticket-management/types';
import {
  canManageBookingUserVisibility,
  type BookingUserVisibilityContext,
} from '@/lib/booking-visibility';
import {
  bookingLifecycleAccessForRole,
  canApproveBookingReconciliation,
  canAcquireBookingLifecycleEvidence,
  canExecuteApprovedBookingReconciliation,
  canProposeBookingFinancialOutcome,
  canRefreshBookingSupplierDetails,
  canRefreshBookingTicketingTime,
  type StaffBookingLifecycle,
} from '@/lib/dashboard/booking-lifecycle';
import {
  canDecideLocalTimeLimit,
  canRequestLocalTimeLimit,
  type LocalTimeLimitContext,
} from '@/lib/booking-lifecycle/local-time-limit';
import type { BookingLifecycleTimelineItem } from '@/lib/dashboard/booking-lifecycle-timeline';
import {
  bookingPiiAccessFor,
  bookingScopeFor,
} from '@/lib/dashboard/bookings';
import { getDashboardSession } from '@/lib/dashboard/session';
import {
  listTicketManagementRequestReferencesForBookings,
} from '@/lib/db/ticket-management';
import {
  publicBookingWithHeaderContact,
  readBookingByPublicRef,
  readBookingByPublicRefForSuperAdmin,
} from '@/lib/db/flight-bookings';
import { readStaffBookingLifecycleTimeline } from '@/lib/db/booking-lifecycle-timeline';
import { readBookingLocalTimeLimitContext } from '@/lib/db/booking-local-time-limit';
import { storedTicketReferences, usesStoredBookingReferences } from '@/lib/booking-lifecycle/ticketing-flow';
import { readBookingUserVisibilityContext } from '@/lib/db/booking-visibility';
import { listStaffBookingLifecycle } from '@/lib/db/booking-lifecycle';
import {
  readImportedTicketingResolutionContext,
} from '@/lib/db/impexp';
import {
  readImportedManualTicketFinancialContext,
  type ImportedManualTicketFinancialContext,
} from '@/lib/db/impexp-financial-disposition';
import {
  readSuperAdminIssueResolutionContext,
  type SuperAdminIssueResolutionContext,
} from '@/lib/db/superadmin-booking-decisions';
import {
  type BookingGender,
  type BookingPassengerType,
  type BookingTitle,
  type BookingTraveller,
} from '@/lib/flights/booking';
import { canAccessImpExp } from '@/lib/impexp/access';
import type { ImportedTicketingResolutionAssessment } from '@/lib/impexp/ticketing-resolution';
import {
  canCancelBooking,
  canConfirmImportedBooking,
  canIssueBooking,
} from '@/lib/wallet/permissions';
import {
  canCreateOwnTicketManagementRequest,
  canViewTicketManagementRequest,
} from '@/lib/ticket-management/permissions';

export const dynamic = 'force-dynamic';

export async function generateMetadata({
  params,
}: {
  params: Promise<{ reference: string }>;
}): Promise<Metadata> {
  const { reference } = await params;

  return {
    title: /^(?:STR\d{12}|KTT[A-Z0-9]{1,100})$/.test(reference)
      ? `Booking Confirmation Ref ${reference}`
      : 'Booking Confirmation',
  };
}

const PASSENGER_TYPES = new Set<BookingPassengerType>([
  'ADT',
  'CHD',
  'CNN',
  'INF',
  'INS',
]);
const TITLES = new Set<BookingTitle>(['Mr', 'Mrs', 'Ms', 'Mstr', 'Miss']);
const GENDERS = new Set<BookingGender>(['Male', 'Female']);

function storedTravellers(value: unknown): BookingTraveller[] {
  if (!value || typeof value !== 'object') return [];
  const travellers = (value as { travellers?: unknown }).travellers;
  if (!Array.isArray(travellers)) return [];

  return travellers.filter((item): item is BookingTraveller => {
    if (!item || typeof item !== 'object') return false;
    const traveller = item as Record<string, unknown>;
    return (
      PASSENGER_TYPES.has(traveller.passengerType as BookingPassengerType) &&
      TITLES.has(traveller.title as BookingTitle) &&
      GENDERS.has(traveller.gender as BookingGender) &&
      typeof traveller.firstName === 'string' &&
      typeof traveller.lastName === 'string' &&
      typeof traveller.dateOfBirth === 'string' &&
      typeof traveller.nationality === 'string'
    );
  });
}

function maskPassport(value: string | undefined): string | undefined {
  if (!value) return value;
  return `••••${value.slice(-4)}`;
}

export default async function BookingDetailsPage({
  params,
}: {
  params: Promise<{ reference: string }>;
  searchParams: Promise<{ created?: string | string[] }>;
}) {
  const [{ reference }, session] = await Promise.all([
    params,
    getDashboardSession(),
  ]);
  if (!session) redirect('/sign-in');
  if (session.role === 'staff_media') notFound();
  if (!/^(?:STR\d{12}|KTT[A-Z0-9]{1,100})$/.test(reference)) notFound();

  const row = session.role === 'superadmin'
    ? await readBookingByPublicRefForSuperAdmin(reference, true)
    : await readBookingByPublicRef(reference, bookingScopeFor(session), true);
  if (!row) notFound();
  if (row.public_ref !== reference) redirect(`/dashboard/bookings/${encodeURIComponent(row.public_ref)}`);
  const piiAccess = bookingPiiAccessFor(session.role);
  const stored = storedTravellers(row.passengers);
  const travellers =
    piiAccess === 'financial-only'
      ? []
      : piiAccess === 'masked-passport'
        ? stored.map((traveller) => ({
            ...traveller,
            passportNumber: maskPassport(traveller.passportNumber),
          }))
        : stored;
  const imported = row.import_source === 'IMP_EXP';
  const manual = row.import_source === 'MANUAL';
  const externalBooking = imported || manual;
  const rollout = bookingLifecycleRolloutState();
  let lifecycleTimeline: BookingLifecycleTimelineItem[] | null = null;
  let staffLifecycle: StaffBookingLifecycle | null = null;
  let importedFinancialContext: ImportedManualTicketFinancialContext | null = null;
  let localTimeLimitContext: LocalTimeLimitContext | null = null;
  let superAdminDecisionContext: SuperAdminIssueResolutionContext | null = null;
  let importedResolutionContext: ImportedTicketingResolutionAssessment | null = null;
  let visibilityContext: BookingUserVisibilityContext | null = null;
  if (
    canManageBookingUserVisibility(session.role) &&
    row.audience === 'agency' &&
    !row.legacy_operational
  ) {
    visibilityContext = await readBookingUserVisibilityContext({
      bookingId: row.id,
      actorUserId: session.clerkId,
    });
  }
  if (row.supplier === 'triplover' && !row.legacy_operational) {
    localTimeLimitContext = await readBookingLocalTimeLimitContext(row.id);
  }
  if (bookingLifecycleAccessForRole(session.role)) {
    const [timelineResult, lifecycleResult] = await Promise.allSettled([
      readStaffBookingLifecycleTimeline(session.role, reference),
      listStaffBookingLifecycle(session.role, {
        publicRefs: [reference],
        limit: 1,
      }),
    ]);
    if (timelineResult.status === 'fulfilled') {
      lifecycleTimeline = timelineResult.value;
    } else {
      console.error('[booking] lifecycle timeline unavailable:', timelineResult.reason);
    }
    if (lifecycleResult.status === 'fulfilled') {
      staffLifecycle = lifecycleResult.value[0] ?? null;
    } else {
      // The customer booking view must remain available during a staged
      // observability/evidence rollout or a temporary staff-view failure.
      console.error('[booking] lifecycle evidence context unavailable:', lifecycleResult.reason);
    }
  }
  const evidenceCase =
    rollout.reconciliationActions && canAcquireBookingLifecycleEvidence(session.role)
    ? staffLifecycle?.reconciliation ?? null
    : null;
  const canProposeImportedFinancial =
    canProposeBookingFinancialOutcome(session.role);
  const canApproveImportedFinancial =
    canApproveBookingReconciliation(session.role);
  const canExecuteImportedFinancial =
    canExecuteApprovedBookingReconciliation(session.role);
  if (
    imported &&
    rollout.importedActions &&
    (canProposeImportedFinancial ||
      canApproveImportedFinancial ||
      canExecuteImportedFinancial)
  ) {
    try {
      importedFinancialContext =
        await readImportedManualTicketFinancialContext(row.id);
    } catch (error) {
      console.error('[booking] imported financial case unavailable:', error);
    }
  }
  if (
    externalBooking &&
    row.status === 'in-progress' &&
    canAccessImpExp(session.role)
  ) {
    try {
      importedResolutionContext = await readImportedTicketingResolutionContext({
        actorUserId: session.clerkId,
        bookingId: row.id,
      });
    } catch (error) {
      console.error('[booking] imported ticketing resolution unavailable:', error);
      importedResolutionContext = {
        ok: false,
        code: 'IMPORTED_RESOLUTION_STORAGE_UNAVAILABLE',
      };
    }
  }
  if (session.role === 'superadmin' && !externalBooking) {
    try {
      superAdminDecisionContext = await readSuperAdminIssueResolutionContext({
        actorUserId: session.clerkId,
        bookingId: row.id,
      });
    } catch (error) {
      console.error('[booking] Super Admin decision context unavailable:', error);
      superAdminDecisionContext = {
        ok: false,
        code: 'DECISION_CONTEXT_UNAVAILABLE',
      };
    }
  }
  const evidencePurpose = evidenceCase
    ? evidenceCase.type.includes('cancellation') || row.status === 'cancelled'
      ? 'cancelled'
      : evidenceCase.type.includes('ticket') || row.status === 'confirmed'
        ? 'ticketed'
        : 'held'
    : null;
  let ticketManagementReferences: TicketManagementRequestReference[] = [];
  try {
    const referencesByBooking = await listTicketManagementRequestReferencesForBookings([
      row.id,
    ]);
    ticketManagementReferences = referencesByBooking.get(row.id) ?? [];
  } catch (error) {
    console.error('[booking] Ticket Management references unavailable:', error);
  }

  const publicBooking = await publicBookingWithHeaderContact(row);
  const allowedPostTicketActions = ticketManagementActionsForBooking({
    status: publicBooking.status,
    directTicketing: row.direct_ticketing,
    importSource: row.import_source,
    bookingOrigin: row.booking_origin,
  });

  return (
    <div className="mx-auto w-full max-w-[1116px] space-y-4">
      <Link
        href="/dashboard/bookings"
        className="inline-flex items-center gap-1.5 text-sm font-semibold text-neutral-600 transition hover:text-brand-orange-dark"
      >
        <ArrowLeft className="h-4 w-4" aria-hidden />
        Back to My Bookings
      </Link>

      <BookingDetails
        booking={publicBooking}
        travellers={travellers}
        ticketManagementReferences={ticketManagementReferences}
        showStepper={false}
        allowCancellation={row.supplier === 'triplover' && canCancelBooking(session, row)}
        allowSupplierRefresh={
          row.supplier === 'triplover' &&
          (!usesStoredBookingReferences(row) || row.status === 'confirmed' || row.status === 'cancelled') &&
          canRefreshBookingSupplierDetails(session.role)
        }
        autoRefreshDeadline={false}
        allowTicketingTimeRefresh={
          row.supplier === 'triplover' && row.import_source !== 'MANUAL' &&
          Boolean(row.supplier_account && storedTicketReferences(row)) &&
          canRefreshBookingTicketingTime(session.role)
        }
        allowTicketing={
          row.supplier === 'triplover' && canIssueBooking(session, row)
        }
        showPostTicketActions={
          ticketManagementRolloutEnabled() &&
          canViewTicketManagementRequest(session.role)
        }
        allowPostTicketOwnerActions={canCreateOwnTicketManagementRequest(session.role)}
        allowedPostTicketActions={allowedPostTicketActions}
        issuingForAssignedOwner={
          session.role === 'superadmin' ||
          session.role === 'admin' ||
          (session.role === 'staff_support' && externalBooking)
        }
        allowImportedConfirmation={externalBooking && canConfirmImportedBooking(session, row)}
        allowImportedSync={
          imported && rollout.importedActions && canAccessImpExp(session.role)
        }
        importedBooking={externalBooking}
        manualBooking={manual}
        localTimeLimit={localTimeLimitContext}
        allowLocalTimeLimitRequest={canRequestLocalTimeLimit(session.role)}
        allowSmsShare={
          (
            session.role === 'superadmin' ||
            session.role === 'admin' ||
            session.role === 'staff_support' ||
            session.role === 'b2b' ||
            session.role === 'b2b_sub'
          ) &&
          row.audience === 'agency' &&
          (
            session.role !== 'b2b' && session.role !== 'b2b_sub' ||
            row.agency_code === session.agencyCode
          ) &&
          !row.hidden_from_user
        }
        passengerPrivacyNotice={
          piiAccess === 'financial-only'
            ? 'Passenger personal details are hidden for Accounts Staff.'
            : undefined
        }
        sidebarContent={
          lifecycleTimeline ? (
            <BookingLifecycleTimeline items={lifecycleTimeline} compact />
          ) : undefined
        }
      />
      {visibilityContext?.ok && (
        <BookingUserVisibilityPanel
          bookingReference={reference}
          context={visibilityContext}
        />
      )}
      {session.role === 'superadmin' && superAdminDecisionContext && (
        <SuperAdminBookingDecisionPanel
          bookingReference={reference}
          storedStatus={row.status}
          lifecycleStatus={row.lifecycle_status ?? row.status}
          paymentState={row.payment_state}
          initialContext={superAdminDecisionContext}
        />
      )}
      {importedResolutionContext && (
        <ImportedBookingTicketingResolutionPanel
          bookingReference={reference}
          travellers={stored.map(({ firstName, lastName }) => ({ firstName, lastName }))}
          context={importedResolutionContext}
        />
      )}
      {manual && row.status !== 'in-progress' && canAccessImpExp(session.role) && (
        <ManualBookingStatusPanel
          bookingReference={reference}
          currentStatus={(row.lifecycle_status ?? row.status)}
          pnr={row.pnr}
          airlinePnr={Array.isArray(row.airlines_pnr) && typeof row.airlines_pnr[0] === 'string' ? row.airlines_pnr[0] : null}
          ticketingDeadlineAt={row.ticketing_deadline_at}
        />
      )}
      {localTimeLimitContext &&
        canDecideLocalTimeLimit(session.role) &&
        localTimeLimitContext.requestPending && (
          <LocalTimeLimitDecisionPanel
            bookingReference={reference}
            context={localTimeLimitContext}
          />
        )}
      {row.supplier === 'triplover' && evidenceCase && evidencePurpose && (
        <BookingEvidenceReader
          bookingReference={reference}
          caseId={evidenceCase.id}
          caseType={evidenceCase.type}
          initialPurpose={evidencePurpose}
        />
      )}
      {session.role !== 'superadmin' && row.status !== 'in-progress' && importedFinancialContext &&
        (importedFinancialContext.supplierOutcome ||
          importedFinancialContext.financialDisposition !== 'none') && (
          <ImportedManualTicketFinancialPanel
            bookingReference={reference}
            context={importedFinancialContext}
            capturedAmount={Number(row.captured_amount)}
            refundedAmount={Number(row.refunded_amount)}
            currency={row.currency}
            canPropose={canProposeImportedFinancial}
            canApprove={canApproveImportedFinancial}
            canExecute={canExecuteImportedFinancial}
            isProposalMaker={
              importedFinancialContext.proposedByUserId === session.clerkId
            }
          />
        )}
    </div>
  );
}
