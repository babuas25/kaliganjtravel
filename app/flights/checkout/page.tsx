import { hiddenDashboardSegments } from '@/lib/dashboard/features';
import { redirect } from 'next/navigation';

import BookingCheckout from '@/components/flights/BookingCheckout';
import DashboardShell from '@/components/dashboard/DashboardShell';
import { getSiteLogo } from '@/lib/appearance';
import { bookingScopeFor } from '@/lib/dashboard/bookings';
import { getDashboardSession, IS_DEV } from '@/lib/dashboard/session';
import { readBookingByAttemptId } from '@/lib/db/flight-bookings';

export const dynamic = 'force-dynamic';

export default async function CheckoutPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [logo, params, session] = await Promise.all([
    getSiteLogo(),
    searchParams,
    getDashboardSession(),
  ]);
  if (!session) redirect('/sign-in');
  const bookingId =
    typeof params.bookingId === 'string' ? params.bookingId : '';

  // A successful submission closes the private attempt. Resolve its durable
  // booking before rendering the client checkout so refreshing an old checkout
  // URL lands on the permanent, authorization-scoped confirmation page.
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(bookingId)) {
    const completed = await readBookingByAttemptId(
      bookingId,
      bookingScopeFor(session)
    );
    if (completed?.public_ref) {
      redirect(`/dashboard/bookings/${encodeURIComponent(completed.public_ref)}`);
    }
  }

  return (
    <DashboardShell
        hiddenNavSegments={hiddenDashboardSegments()}
      role={session.role}
      name={session.name}
      agencyCode={session.agencyCode}
      logo={logo}
      showDevRoleSwitcher={IS_DEV}
    >
      <div className="mx-auto w-full max-w-[1180px]">
        {/* The trip summary below carries the page's visible identity; this
            heading exists so the document still has one for screen readers. */}
        <h1 className="sr-only">Traveller details</h1>
        <BookingCheckout
          bookingId={bookingId}
          customerEmail={
            session.role === 'b2b' || session.role === 'b2b_sub'
              ? session.email
              : ''
          }
        />
      </div>
    </DashboardShell>
  );
}
