import { notFound, redirect } from 'next/navigation';

import BookingsView from '@/components/dashboard/bookings/BookingsView';
import { canManageBookingUserVisibility } from '@/lib/booking-visibility';
import { canDecideLocalTimeLimit } from '@/lib/booking-lifecycle/local-time-limit';
import { listDashboardBookings } from '@/lib/dashboard/bookings';
import { bookingListQueryFromSearchParams } from '@/lib/dashboard/booking-list-query';
import { getDashboardSession } from '@/lib/dashboard/session';
import {
  listPendingLocalTimeLimitRequests,
} from '@/lib/db/booking-local-time-limit';
import type { PendingLocalTimeLimitQueueItem } from '@/lib/booking-lifecycle/local-time-limit';
import { ticketManagementRolloutEnabled } from '@/lib/ticket-management/rollout';

/** Bookings change the moment one is made, so this never serves a cached list. */
export const dynamic = 'force-dynamic';

export default async function BookingsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await getDashboardSession();
  if (!session) redirect('/sign-in');
  if (session.role === 'staff_media') notFound();

  const query = bookingListQueryFromSearchParams(await searchParams);
  const localTimeLimitRequestsPromise: Promise<PendingLocalTimeLimitQueueItem[]> =
    canDecideLocalTimeLimit(session.role)
      ? listPendingLocalTimeLimitRequests()
      : Promise.resolve([]);
  const [bookingPage, localTimeLimitRequests] = await Promise.all([
    listDashboardBookings(session, query),
    localTimeLimitRequestsPromise,
  ]);

  return (
    <>
      <h1 className="sr-only">My Bookings</h1>
      <BookingsView
        bookings={bookingPage.bookings}
        totalBookings={bookingPage.total}
        loadError={bookingPage.loadError}
        query={query}
        showActions={
          session.role !== 'customer' &&
          session.role !== 'b2b' &&
          session.role !== 'b2b_sub'
        }
        canManageUserVisibility={canManageBookingUserVisibility(session.role)}
        showSupplierPayable={session.role === 'superadmin'}
        showGross={session.role === 'b2b' || session.role === 'b2b_sub'}
        showProfit={session.role === 'superadmin'}
        showSupplierReference={
          session.role === 'superadmin' ||
          session.role === 'admin' ||
          session.role === 'staff_support' ||
          session.role === 'staff_account'
        }
        allowHistoricalReferenceOpen={session.role === 'superadmin'}
        localTimeLimitRequests={localTimeLimitRequests}
        role={session.role}
        currentUserId={session.clerkId}
        ticketManagementEnabled={ticketManagementRolloutEnabled()}
      />
    </>
  );
}
