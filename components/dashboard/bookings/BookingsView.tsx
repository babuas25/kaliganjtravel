'use client';

import { AlertTriangle, Inbox, RefreshCw } from 'lucide-react';
import Link from 'next/link';
import { useCallback, useEffect, useRef, useState, useTransition } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';

import BookingsTable, {
  BookingsFilterBar,
} from '@/components/dashboard/bookings/BookingsTable';
import LocalTimeLimitQueuePanel from '@/components/dashboard/bookings/LocalTimeLimitQueuePanel';
import TicketManagementWorkspace from '@/components/dashboard/ticket-management/TicketManagementWorkspace';
import {
  BookingsTabBar,
  ManageActionTabs,
  ManageStatusTabs,
  TicketStatusTabs,
  type BookingsTab,
  type ManageAction,
  type ManageStatus,
  type TicketStatusValue,
} from '@/components/dashboard/bookings/BookingsTabs';
import type { BookingListRow } from '@/lib/dashboard/bookings';
import {
  DEFAULT_BOOKING_PAGE_SIZE,
  type BookingListQuery,
} from '@/lib/dashboard/booking-list-query';
import type { PendingLocalTimeLimitQueueItem } from '@/lib/booking-lifecycle/local-time-limit';
import type { Role } from '@/lib/roles';

/** Shared empty panel for the tabs whose data source is still to come. */
function EmptyPanel({ title, body }: { title: string; body: string }) {
  return (
    <div className="flex flex-col items-center rounded-xl border border-dashed border-neutral-300 bg-white px-6 py-14 text-center">
      <span className="flex h-11 w-11 items-center justify-center rounded-lg bg-navy-50 text-navy-700">
        <Inbox className="h-5 w-5" aria-hidden />
      </span>
      <p className="mt-4 text-sm font-semibold text-navy-950">{title}</p>
      <p className="mt-1 max-w-md text-xs text-neutral-500">{body}</p>
    </div>
  );
}

/**
 * The My Bookings screen: three top tabs, a status row under the first, and the
 * list itself.
 *
 * The rows come in as a prop rather than being fetched here, so connecting the
 * real data source later is a change to the page above this component and
 * nothing else.
 */
export default function BookingsView({
  bookings,
  totalBookings,
  loadError,
  query,
  showActions,
  canManageUserVisibility,
  showSupplierPayable,
  showGross,
  showProfit,
  showSupplierReference,
  allowHistoricalReferenceOpen = false,
  localTimeLimitRequests,
  role,
  currentUserId,
  ticketManagementEnabled,
}: {
  bookings: BookingListRow[];
  totalBookings: number;
  loadError: boolean;
  query: BookingListQuery;
  showActions: boolean;
  canManageUserVisibility: boolean;
  showSupplierPayable: boolean;
  showGross: boolean;
  showProfit: boolean;
  showSupplierReference: boolean;
  allowHistoricalReferenceOpen?: boolean;
  localTimeLimitRequests?: PendingLocalTimeLimitQueueItem[];
  role: Role;
  currentUserId: string;
  ticketManagementEnabled: boolean;
}) {
  const searchParams = useSearchParams();
  const linkedAction = searchParams.get('action');
  const linkedStatus = searchParams.get('status');
  const linkedRequestPublicRef = searchParams.get('request');
  const [activeTab, setActiveTab] = useState<BookingsTab>(
    searchParams.get('tab') === 'manage' ? 1 : 0
  );
  const [manageAction, setManageAction] = useState<ManageAction>(
    linkedAction === 'reissue' || linkedAction === 'void' ? linkedAction : 'refund'
  );
  const [manageStatus, setManageStatus] = useState<ManageStatus>(
    linkedStatus === 'all' ||
      linkedStatus === 'requested' ||
      linkedStatus === 'in-progress' ||
      linkedStatus === 'awaiting-confirmation' ||
      linkedStatus === 'approved' ||
      linkedStatus === 'rejected' ||
      linkedStatus === 'expired'
      ? linkedStatus
      : 'requested'
  );
  const [searchInput, setSearchInput] = useState(query.search);
  const searchEdited = useRef(false);
  const [showAdvancedFilter, setShowAdvancedFilter] = useState(false);
  const [isPending, startTransition] = useTransition();
  const pathname = usePathname();
  const router = useRouter();
  const exactReference = /^(?:STR\d{12}|KTT[A-Z0-9]{1,100})$/i.test(searchInput.trim())
    ? searchInput.trim().toUpperCase()
    : null;

  const updateQuery = useCallback(
    (updates: Partial<BookingListQuery>) => {
      const next = { ...query, search: searchInput.trim().slice(0, 120), ...updates };
      if (!Object.prototype.hasOwnProperty.call(updates, 'page')) next.page = 1;

      const params = new URLSearchParams();
      if (next.page > 1) params.set('page', String(next.page));
      if (next.pageSize !== DEFAULT_BOOKING_PAGE_SIZE) {
        params.set('pageSize', String(next.pageSize));
      }
      if (next.search) params.set('q', next.search);
      if (next.status !== 'all') params.set('status', next.status);
      if (next.createdBy) params.set('createdBy', next.createdBy);
      if (next.createdFrom) params.set('createdFrom', next.createdFrom);
      if (next.createdTo) params.set('createdTo', next.createdTo);
      if (next.flyFrom) params.set('flyFrom', next.flyFrom);
      if (next.flyTo) params.set('flyTo', next.flyTo);
      if (next.amountMin) params.set('amountMin', next.amountMin);
      if (next.amountMax) params.set('amountMax', next.amountMax);
      if (next.sortKey) params.set('sort', next.sortKey);
      if (next.sortDirection === 'asc') params.set('direction', 'asc');

      const destination = params.size ? `${pathname}?${params}` : pathname;
      startTransition(() => router.replace(destination, { scroll: false }));
    },
    [pathname, query, router, searchInput]
  );

  useEffect(() => {
    // Older server results must never replace a newer draft in the input.
    if (searchEdited.current) {
      if (searchInput.trim().slice(0, 120) === query.search) {
        searchEdited.current = false;
      }
      return;
    }
    setSearchInput(query.search);
  }, [query.search]);

  useEffect(() => {
    // Back/forward is an explicit navigation, so restore its search term.
    const restoreSearch = () => {
      searchEdited.current = false;
      setSearchInput(new URLSearchParams(window.location.search).get('q') ?? '');
    };
    window.addEventListener('popstate', restoreSearch);
    return () => window.removeEventListener('popstate', restoreSearch);
  }, []);

  useEffect(() => {
    if (searchParams.get('tab') !== 'manage') return;
    setActiveTab(1);
    if (linkedAction === 'refund' || linkedAction === 'reissue' || linkedAction === 'void') {
      setManageAction(linkedAction);
    }
    if (
      linkedStatus === 'all' ||
      linkedStatus === 'requested' ||
      linkedStatus === 'in-progress' ||
      linkedStatus === 'awaiting-confirmation' ||
      linkedStatus === 'approved' ||
      linkedStatus === 'rejected' ||
      linkedStatus === 'expired'
    ) {
      setManageStatus(linkedStatus);
    }
  }, [linkedAction, linkedStatus, searchParams]);

  useEffect(() => {
    const search = searchInput.trim().slice(0, 120);
    if (search === query.search) return;
    const timer = window.setTimeout(() => updateQuery({ search }), 300);
    return () => window.clearTimeout(timer);
  }, [query.search, searchInput, updateQuery]);

  const refreshBookings = useCallback(() => {
    startTransition(() => router.refresh());
  }, [router]);

  useEffect(() => {
    // A dynamic server page can still be restored from the client router cache.
    // Refresh on entry (including restored routes), without replacing its query.
    if (pathname !== '/dashboard/bookings') return;
    refreshBookings();

    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') refreshBookings();
    };
    const onPageShow = (event: PageTransitionEvent) => {
      if (event.persisted) refreshBookings();
    };

    document.addEventListener('visibilitychange', onVisibilityChange);
    window.addEventListener('pageshow', onPageShow);
    return () => {
      document.removeEventListener('visibilitychange', onVisibilityChange);
      window.removeEventListener('pageshow', onPageShow);
    };
  }, [pathname, refreshBookings]);

  return (
    // Bleeds past the dashboard's own padding so the tab rows span the full
    // content width, the way they do on the reference screen.
    <div className="-mx-4 -mt-6 flex flex-col sm:-mx-6 lg:-mx-8">
      <div className="w-full border-b border-neutral-200 bg-white">
        <BookingsTabBar
          activeTab={activeTab}
          onTabChange={setActiveTab}
          ticketManagementEnabled={ticketManagementEnabled}
        />

        {activeTab === 0 && (
          <>
            <TicketStatusTabs
              activeTab={query.status}
              onTabChange={(status: TicketStatusValue) => updateQuery({ status })}
            />
            <BookingsFilterBar
              searchQuery={searchInput}
              onSearchQueryChange={(value) => {
                searchEdited.current = true;
                setSearchInput(value);
              }}
              showAdvancedFilter={showAdvancedFilter}
              onAdvancedFilterToggle={() =>
                setShowAdvancedFilter((open) => !open)
              }
              onRefresh={refreshBookings}
              isRefreshing={isPending}
            />
          </>
        )}

        {activeTab === 1 && (
          <>
            <ManageActionTabs
              activeTab={manageAction}
              onTabChange={setManageAction}
            />
            <ManageStatusTabs
              activeTab={manageStatus}
              onTabChange={setManageStatus}
            />
          </>
        )}
      </div>

      <main className="w-full bg-navy-50/60 px-4 py-4 sm:px-6 lg:px-8 lg:py-6">
        {activeTab === 0 && (
          <>
            {localTimeLimitRequests && (
              <LocalTimeLimitQueuePanel requests={localTimeLimitRequests} />
            )}
            {allowHistoricalReferenceOpen && exactReference && (
              <div className="mb-3 flex items-center justify-between gap-3 rounded-lg border border-blue-200 bg-blue-50 px-3 py-2 text-xs text-blue-950">
                <span>
                  Open this exact reference directly, including retained historical bookings.
                </span>
                <Link
                  href={`/dashboard/bookings/${encodeURIComponent(exactReference)}`}
                  className="shrink-0 rounded-md bg-brand-orange px-3 py-1.5 font-semibold text-black"
                >
                  Open {exactReference}
                </Link>
              </div>
            )}
            {loadError ? (
              <div
                role="alert"
                className="flex flex-col items-start gap-3 rounded-xl border border-red-200 bg-red-50 px-5 py-5 text-red-950 sm:flex-row sm:items-center sm:justify-between"
              >
                <div className="flex items-start gap-3">
                  <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0" aria-hidden />
                  <div>
                    <p className="text-sm font-semibold">Bookings could not be loaded</p>
                    <p className="mt-1 text-xs text-red-800">
                      This is a temporary read error, not an empty booking result. Refresh and try again.
                    </p>
                  </div>
                </div>
                <button
                  type="button"
                  onClick={refreshBookings}
                  disabled={isPending}
                  className="flex h-8 shrink-0 items-center justify-center gap-1.5 rounded-md bg-red-700 px-3 text-xs font-semibold text-white transition hover:bg-red-800 disabled:cursor-wait disabled:opacity-60"
                >
                  <RefreshCw
                    className={`h-3.5 w-3.5 ${isPending ? 'animate-spin' : ''}`}
                    aria-hidden
                  />
                  Retry
                </button>
              </div>
            ) : (
              <BookingsTable
                bookings={bookings}
                totalItems={totalBookings}
                query={query}
                onQueryChange={updateQuery}
                isLoading={isPending}
                showAdvancedFilter={showAdvancedFilter}
                showActions={showActions}
                canManageUserVisibility={canManageUserVisibility}
                showSupplierPayable={showSupplierPayable}
                showGross={showGross}
                showProfit={showProfit}
                showSupplierReference={showSupplierReference}
              />
            )}
          </>
        )}

        {activeTab === 1 && (
          <TicketManagementWorkspace
            action={manageAction}
            status={manageStatus}
            role={role}
            currentUserId={currentUserId}
            openRequestPublicRef={linkedRequestPublicRef}
          />
        )}

        {activeTab === 2 && (
          <EmptyPanel
            title="No add-ons yet"
            body="Seats, meals and baggage purchased after booking will be listed here."
          />
        )}
      </main>
    </div>
  );
}
