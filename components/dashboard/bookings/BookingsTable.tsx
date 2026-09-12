'use client';

import {
  AlertTriangle,
  ChevronDown,
  Clock3,
  Edit,
  Eye,
  EyeOff,
  Filter,
  Loader2,
  RefreshCw,
  Search,
  Trash2,
} from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';

import type {
  BookingLifecycleIndicator,
  BookingListRow,
} from '@/lib/dashboard/bookings';
import {
  ticketManagementRequestHref,
  ticketManagementRequestLabel,
} from '@/lib/ticket-management/request-link';
import {
  BOOKING_PAGE_SIZE_OPTIONS,
  type BookingListQuery,
  type BookingListSortDirection,
  type BookingListSortKey,
} from '@/lib/dashboard/booking-list-query';
import {
  BOOKING_STATUSES,
  BOOKING_STATUS_LABELS,
  type BookingStatus,
} from '@/lib/flights/booking-status';
import { bookingReviewResponsibility } from '@/lib/dashboard/booking-review-responsibility';

/** Labels come from the status module; only the colour is decided here. */
const STATUS_COLOURS: Record<BookingStatus, string> = {
  'on-hold': 'bg-amber-500 text-white',
  // Yellow is too light to carry white text; this one keeps the dark ink.
  pending: 'bg-yellow-400 text-navy-950',
  'in-progress': 'bg-blue-500 text-white',
  confirmed: 'bg-emerald-600 text-white',
  expired: 'bg-neutral-500 text-white',
  unconfirmed: 'bg-orange-500 text-white',
  cancelled: 'bg-red-600 text-white',
};

const ARROW = '→';

/**
 * A booking timestamp as a stable instant.
 *
 * The rows carry `"2026-07-30T18:08:00"` with no zone. Handing that to `new
 * Date()` reads it as *local* time, so a UTC server and a Dhaka browser would
 * format two different clocks from one string and React would flag the
 * mismatch. Parsed as a stable instant and formatted in Bangladesh time, every
 * renderer agrees with the business timezone.
 */
function parseStamp(value: string | null | undefined): Date | null {
  if (!value) return null;

  if (/(?:z|[+-]\d{2}:?\d{2})$/i.test(value)) {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
  }

  const match =
    /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?/.exec(value);
  if (!match) return null;
  return new Date(
    Date.UTC(
      Number(match[1]),
      Number(match[2]) - 1,
      Number(match[3]),
      Number(match[4] ?? '0'),
      Number(match[5] ?? '0'),
      Number(match[6] ?? '0')
    )
  );
}

const weekdayLong = new Intl.DateTimeFormat('en-GB', {
  weekday: 'long',
  timeZone: 'Asia/Dhaka',
});
const weekdayShort = new Intl.DateTimeFormat('en-GB', {
  weekday: 'short',
  timeZone: 'Asia/Dhaka',
});
const dayMonthYear = new Intl.DateTimeFormat('en-GB', {
  day: '2-digit',
  month: 'short',
  year: '2-digit',
  timeZone: 'Asia/Dhaka',
});
const hourMinute = new Intl.DateTimeFormat('en-GB', {
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
  timeZone: 'Asia/Dhaka',
});

/** The three-line date cell: weekday, date, then the time or a dash. */
function DateCell({
  value,
  withTime,
}: {
  value: string | null | undefined;
  withTime: boolean;
}) {
  const date = parseStamp(value);
  if (!date) return <span className="text-neutral-400">—</span>;
  return (
    <span className="block text-[10px] leading-tight xl:text-[11px]">
      <span className="block font-medium text-navy-950">
        {weekdayLong.format(date)}
      </span>
      <span className="block text-navy-950">{dayMonthYear.format(date)}</span>
      <span className="block text-neutral-500">
        {withTime ? `at ${hourMinute.format(date)}` : '—'}
      </span>
    </span>
  );
}

function StatusBadge({ status }: { status: BookingStatus }) {
  return (
    <span
      className={`inline-block whitespace-nowrap rounded px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-[0.06em] ${STATUS_COLOURS[status]}`}
    >
      {BOOKING_STATUS_LABELS[status]}
    </span>
  );
}

function TicketManagementReferences({ booking }: { booking: BookingListRow }) {
  if (booking.ticketManagementReferences.length === 0) return null;
  return (
    <span className="mt-1 flex flex-col items-start gap-0.5 text-[9px] font-semibold leading-tight text-navy-700">
      {booking.ticketManagementReferences.map((reference) => (
        <span key={reference.publicRef}>
          {ticketManagementRequestLabel(reference)}{' '}
          <Link
            href={ticketManagementRequestHref(reference)}
            className="underline decoration-navy-300 underline-offset-2 transition hover:text-brand-orange-dark hover:decoration-brand-orange"
          >
            {reference.publicRef}
          </Link>
        </span>
      ))}
    </span>
  );
}

function CustomerStatusMessage({ message }: { message: string | null }) {
  return message ? (
    <span className="mt-1 block min-w-[9rem] max-w-[14rem] text-[9px] leading-tight text-neutral-600">
      {message}
    </span>
  ) : null;
}

function humanize(value: string): string {
  return value
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function elapsedLabel(seconds: number | null): string | null {
  if (seconds === null || !Number.isFinite(seconds)) return null;
  if (seconds < 60) return `${Math.max(0, Math.floor(seconds))}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
  return `${Math.floor(seconds / 86400)}d`;
}

function dueLabel(value: string | null): string | null {
  const date = parseStamp(value);
  if (!date) return null;
  return `${dayMonthYear.format(date)} ${hourMinute.format(date)}`;
}

const PAYMENT_CONFLICT_LABELS: Record<string, string> = {
  confirmed_unpaid: 'Confirmed without captured payment',
  cancelled_outstanding_capture: 'Cancelled with captured funds',
  held_without_active_reservation: 'Hold has no active reservation',
  reservation_reconciliation: 'Wallet reservation needs reconciliation',
};

/** Staff-only explanation of what an In Progress or conflicted row means. */
function LifecycleIndicator({
  indicator,
}: {
  indicator: BookingLifecycleIndicator | undefined;
}) {
  if (!indicator) return null;
  const elapsed = elapsedLabel(indicator.operationElapsedSeconds);
  const due = dueLabel(indicator.dueAt);
  return (
    <span className="mt-1 flex min-w-[9rem] max-w-[14rem] flex-col items-start gap-0.5 text-[9px] leading-tight text-neutral-600">
      {indicator.operationKind && (
        <span className="rounded bg-blue-50 px-1 py-0.5 font-semibold text-blue-800">
          {humanize(indicator.operationKind)}
          {indicator.operationState
            ? ` · ${humanize(indicator.operationState)}`
            : ''}
          {elapsed ? ` · ${elapsed}` : ''}
        </span>
      )}
      {indicator.reconciliationType && (
        <span className="rounded bg-amber-50 px-1 py-0.5 font-semibold text-amber-800">
          Review: {humanize(indicator.reconciliationType)}
        </span>
      )}
      {(indicator.attentionRequired || indicator.terminalConflict) && (
        <span className="inline-flex items-center gap-0.5 font-semibold text-red-700">
          <AlertTriangle className="h-2.5 w-2.5" aria-hidden />
          {indicator.terminalConflict ? 'Terminal conflict' : 'Needs attention'}
        </span>
      )}
      {(indicator.assignedTeam || indicator.reconciliationType) && (
        <span>{bookingReviewResponsibility(indicator.assignedTeam)}</span>
      )}
      {due && (
        <span
          className={`inline-flex items-center gap-0.5 ${
            indicator.slaBreached ? 'font-semibold text-red-700' : ''
          }`}
        >
          <Clock3 className="h-2.5 w-2.5" aria-hidden />
          {indicator.slaBreached ? 'Overdue' : 'Due'} {due}
        </span>
      )}
      {indicator.reconciliationType && !indicator.evidenceIsFresh && (
        <span className="font-medium text-amber-700">Evidence needs refresh</span>
      )}
      {indicator.paymentConflictCode && (
        <span className="font-semibold text-red-700">
          Payment: {PAYMENT_CONFLICT_LABELS[indicator.paymentConflictCode] ??
            humanize(indicator.paymentConflictCode)}
        </span>
      )}
    </span>
  );
}

/** First name on one line, everything else on the next. */
function formatName(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return '—';
  if (words.length === 1) return words[0];
  return `${words[0]}\n${words.slice(1).join(' ')}`;
}

/** `"Adult 2, Child 1"` → one type per line, adults first. */
function formatPassengerType(value: string): string {
  const order = ['Adult', 'Child', 'Infant'];
  const parts = value
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);
  if (parts.length === 0) return '—';
  return parts
    .map((part) => {
      const type = order.find((candidate) =>
        part.toLowerCase().startsWith(candidate.toLowerCase())
      );
      return { part, sort: type ? order.indexOf(type) : 99 };
    })
    .sort((a, b) => a.sort - b.sort)
    .map(({ part }) => part)
    .join('\n');
}

/**
 * `"DAC-CXB"` → `"DAC → CXB"`; a there-and-back pair collapses onto one line,
 * and anything longer keeps a line per leg.
 */
function formatRoute(route: string): string {
  const legs = route
    .split(',')
    .map((leg) => leg.trim())
    .filter(Boolean);
  if (legs.length === 0) return '—';

  const arrowed = legs.map((leg) => leg.split('-').join(` ${ARROW} `));
  if (legs.length === 2) {
    const [first, second] = legs.map((leg) => leg.split('-'));
    if (first[1] === second[0] && second[1] === first[0]) {
      return `${first[0]} ${ARROW} ${first[1]} ${ARROW} ${second[1]}`;
    }
  }
  return arrowed.join('\n');
}

function truncate(value: string, max = 12): string {
  if (!value.trim()) return '—';
  return value.length <= max ? value : `${value.slice(0, max)}…`;
}

type PageToken = number | 'gap-left' | 'gap-right';

function pageTokensFor(current: number, total: number): PageToken[] {
  if (total <= 7) {
    return Array.from({ length: total }, (_, index) => index + 1);
  }
  if (current <= 3) return [1, 2, 3, 'gap-right', total];
  if (current >= total - 2) {
    return [1, 'gap-left', total - 2, total - 1, total];
  }
  return [1, 'gap-left', current - 1, current, current + 1, 'gap-right', total];
}

const inputClass =
  'h-8 w-full rounded-md border border-neutral-300 bg-white px-2 text-xs text-navy-950 focus:border-brand-orange focus:outline-none focus:ring-2 focus:ring-brand-orange/30';

function bookingHref(referenceNo: string): string {
  return `/dashboard/bookings/${encodeURIComponent(referenceNo)}`;
}

function BookingReferences({
  booking,
  showSupplierReference,
}: {
  booking: BookingListRow;
  showSupplierReference: boolean;
}) {
  return (
    <span className="flex min-w-[8rem] flex-col items-start gap-0.5 leading-tight">
      <span>
        <span className="text-neutral-500">Airline PNR: </span>
        <span className="font-semibold text-navy-950">{booking.airlinePnr || '—'}</span>
      </span>
      <span>
        <span className="text-neutral-500">
          {showSupplierReference ? 'Our REF: ' : 'REF: '}
        </span>
        <Link
          href={bookingHref(booking.referenceNo)}
          className="font-semibold tracking-wide text-brand-orange-dark underline decoration-brand-orange/50 underline-offset-2 transition hover:text-brand-orange"
        >
          {booking.referenceNo}
        </Link>
      </span>
      {showSupplierReference && (
        <span>
          <span className="text-neutral-500">Supplier REF: </span>
          <span className="font-semibold text-navy-950">
            {booking.supplierReference || '—'}
          </span>
        </span>
      )}
    </span>
  );
}

export default function BookingsTable({
  bookings,
  totalItems,
  query,
  onQueryChange,
  isLoading,
  showAdvancedFilter,
  showActions,
  canManageUserVisibility,
  showSupplierPayable,
  showGross,
  showProfit,
  showSupplierReference,
}: {
  bookings: BookingListRow[];
  totalItems: number;
  query: BookingListQuery;
  onQueryChange: (updates: Partial<BookingListQuery>) => void;
  isLoading: boolean;
  showAdvancedFilter: boolean;
  showActions: boolean;
  canManageUserVisibility: boolean;
  showSupplierPayable: boolean;
  showGross: boolean;
  showProfit: boolean;
  showSupplierReference: boolean;
}) {
  const totalPages = Math.max(1, Math.ceil(totalItems / query.pageSize));
  const safePage = Math.min(query.page, totalPages);
  const pageStart = totalItems === 0 ? 0 : (safePage - 1) * query.pageSize;
  const pageEnd = Math.min(pageStart + bookings.length, totalItems);
  const pageRows = bookings;

  const activeFilterCount = [
    query.status !== 'all',
    query.createdBy,
    query.createdFrom,
    query.createdTo,
    query.flyFrom,
    query.flyTo,
    query.amountMin,
    query.amountMax,
  ].filter(Boolean).length;

  const handleSort = (key: BookingListSortKey) => {
    if (query.sortKey === key) {
      onQueryChange({
        sortDirection: query.sortDirection === 'asc' ? 'desc' : 'asc',
      });
      return;
    }
    const sortDirection: BookingListSortDirection =
      key === 'createDate' ||
        key === 'flyDate' ||
        key === 'lifecycleAt' ||
        key === 'fare' ||
        key === 'gross' ||
        key === 'supplierPayable' ||
        key === 'profit'
        ? 'desc'
        : 'asc';
    onQueryChange({ sortKey: key, sortDirection });
  };

  const clearFilters = () => {
    onQueryChange({
      status: 'all',
      createdBy: '',
      createdFrom: '',
      createdTo: '',
      flyFrom: '',
      flyTo: '',
      amountMin: '',
      amountMax: '',
    });
  };

  const columns: [string, BookingListSortKey][] = [
    ['Create Date', 'createDate'],
    ['Status', 'status'],
    ['Name', 'name'],
    ['Fly Date', 'flyDate'],
    ['Airline', 'airline'],
    ['User Payable', 'fare'],
    ...(showGross
      ? ([['Gross', 'gross']] as [string, BookingListSortKey][])
      : []),
    ['Issued At', 'lifecycleAt'],
    showSupplierPayable
      ? ['Supplier Payable', 'supplierPayable']
      : ['Passenger Type', 'passengerType'],
    ...(showProfit
      ? ([['Profit', 'profit']] as [string, BookingListSortKey][])
      : []),
    ['Route', 'route'],
    ['Created By', 'createdBy'],
    ['Ref No', 'referenceNo'],
  ];

  return (
    <div className="w-full" aria-busy={isLoading}>
      {isLoading && (
        <p className="mb-2 text-xs font-medium text-neutral-500" role="status">
          Updating bookings…
        </p>
      )}
      {showAdvancedFilter && (
        <div className="mb-4 overflow-hidden rounded-xl border border-brand-orange/30 bg-white shadow-sm">
          <div className="flex flex-col gap-2 border-b border-brand-orange/20 bg-brand-orange-light/50 px-4 py-3 md:flex-row md:items-center md:justify-between">
            <div className="flex items-center gap-2">
              <Filter className="h-4 w-4 text-brand-orange" aria-hidden />
              <h3 className="text-sm font-semibold text-navy-950">Filters By</h3>
              <span className="rounded-full bg-brand-orange-light px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide text-brand-orange-dark">
                {activeFilterCount} applied
              </span>
            </div>
            <button
              type="button"
              onClick={clearFilters}
              className="h-8 rounded-md border border-brand-orange/40 px-3 text-xs font-semibold text-brand-orange-dark transition hover:bg-brand-orange-light"
            >
              Clear Filters
            </button>
          </div>

          <div className="grid gap-3 p-4 md:grid-cols-2 xl:grid-cols-4">
            <label className="space-y-1">
              <span className="text-xs font-medium text-neutral-500">Status</span>
              <select
                value={query.status}
                onChange={(event) =>
                  onQueryChange({
                    status: event.target.value as BookingStatus | 'all',
                  })
                }
                className={inputClass}
              >
                <option value="all">All Statuses</option>
                {BOOKING_STATUSES.map((status) => (
                  <option key={status} value={status}>
                    {BOOKING_STATUS_LABELS[status]}
                  </option>
                ))}
              </select>
            </label>

            <label className="space-y-1">
              <span className="text-xs font-medium text-neutral-500">
                Created By / Agency
              </span>
              <input
                key={`created-by-${query.createdBy}`}
                type="search"
                placeholder="Name, email, or agency"
                defaultValue={query.createdBy}
                onBlur={(event) => onQueryChange({ createdBy: event.target.value })}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') event.currentTarget.blur();
                }}
                className={inputClass}
              />
            </label>

            <div className="space-y-1">
              <span className="text-xs font-medium text-neutral-500">
                Create Date
              </span>
              <div className="flex gap-2">
                <input
                  type="date"
                  aria-label="Created from"
                  value={query.createdFrom}
                  onChange={(event) => onQueryChange({ createdFrom: event.target.value })}
                  className={inputClass}
                />
                <input
                  type="date"
                  aria-label="Created to"
                  value={query.createdTo}
                  onChange={(event) => onQueryChange({ createdTo: event.target.value })}
                  className={inputClass}
                />
              </div>
            </div>

            <div className="space-y-1">
              <span className="text-xs font-medium text-neutral-500">Fly Date</span>
              <div className="flex gap-2">
                <input
                  type="date"
                  aria-label="Fly date from"
                  value={query.flyFrom}
                  onChange={(event) => onQueryChange({ flyFrom: event.target.value })}
                  className={inputClass}
                />
                <input
                  type="date"
                  aria-label="Fly date to"
                  value={query.flyTo}
                  onChange={(event) => onQueryChange({ flyTo: event.target.value })}
                  className={inputClass}
                />
              </div>
            </div>

            <div className="space-y-1 md:col-span-2">
              <span className="text-xs font-medium text-neutral-500">Amount</span>
              <div className="flex gap-2">
                <input
                  key={`amount-min-${query.amountMin}`}
                  type="number"
                  min={0}
                  placeholder="Min"
                  aria-label="Minimum fare"
                  defaultValue={query.amountMin}
                  onBlur={(event) => onQueryChange({ amountMin: event.target.value })}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') event.currentTarget.blur();
                  }}
                  className={inputClass}
                />
                <input
                  key={`amount-max-${query.amountMax}`}
                  type="number"
                  min={0}
                  placeholder="Max"
                  aria-label="Maximum fare"
                  defaultValue={query.amountMax}
                  onBlur={(event) => onQueryChange({ amountMax: event.target.value })}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') event.currentTarget.blur();
                  }}
                  className={inputClass}
                />
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Desktop table, from lg up. */}
      <div className="hidden w-full overflow-hidden rounded-xl border border-neutral-200 bg-white shadow-sm lg:block">
        {/* No reserved scrollbar gutter: on a wide screen the table needs no
            horizontal scroll, and the reservation showed as a blank strip
            inside the card's right border. */}
        <div className="overflow-x-auto">
          <table className="w-full min-w-[900px] text-[10px] xl:text-[11px]">
            <thead className="bg-navy-50">
              <tr>
                {columns.map(([label, key]) => (
                  <th
                    key={key}
                    className="border-b border-neutral-200 px-1 py-1.5 text-left align-top text-[10px] font-semibold uppercase tracking-[0.04em] text-neutral-500 xl:px-1.5 xl:text-[11px]"
                  >
                    <button
                      type="button"
                      onClick={() => handleSort(key)}
                      // The visible label is split across lines, which leaves
                      // the button without a usable name of its own.
                      aria-label={`Sort by ${label}`}
                      className="rounded text-left leading-tight transition hover:text-brand-orange-dark focus:outline-none focus:ring-2 focus:ring-brand-orange/30"
                    >
                      {/* Header words stack, so twelve columns fit without a
                          horizontal scroll on a normal laptop. */}
                      <span className="whitespace-pre-line">
                        {label.replace(/ /g, '\n')}
                      </span>
                    </button>
                  </th>
                ))}
                {showActions && (
                  <th className="border-b border-neutral-200 px-1 py-1.5 text-left align-top text-[10px] font-semibold uppercase tracking-[0.04em] text-neutral-500 xl:px-1.5 xl:text-[11px]">
                    Actions
                  </th>
                )}
              </tr>
            </thead>
            <tbody>
              {pageRows.length === 0 ? (
                <tr>
                  <td
                    colSpan={columns.length + Number(showActions)}
                    className="px-2 py-8 text-center text-[11px] text-neutral-500"
                  >
                    No bookings found
                  </td>
                </tr>
              ) : (
                pageRows.map((booking) => (
                  <tr
                    key={booking.referenceNo}
                    className="border-b border-neutral-200 transition-colors hover:bg-navy-50/60"
                  >
                    <td className="px-1 py-1.5 align-top xl:px-1.5">
                      <DateCell value={booking.createDate} withTime />
                    </td>
                    <td className="px-1 py-1.5 align-top xl:px-1.5">
                      <StatusBadge status={booking.status} />
                      <TicketManagementReferences booking={booking} />
                      {booking.hiddenFromUser && (
                        <span className="mt-1 inline-flex rounded bg-sky-100 px-1.5 py-0.5 text-[10px] font-semibold text-sky-800">
                          Hidden from B2B
                        </span>
                      )}
                      <CustomerStatusMessage message={booking.statusMessage} />
                      <LifecycleIndicator
                        indicator={booking.lifecycleIndicator}
                      />
                    </td>
                    <td className="max-w-[7rem] whitespace-pre-line px-1 py-1.5 align-top font-medium leading-tight text-navy-950 xl:max-w-[8rem] xl:px-1.5">
                      {formatName(booking.name)}
                    </td>
                    <td className="px-1 py-1.5 align-top xl:px-1.5">
                      <DateCell value={booking.flyDate} withTime={false} />
                    </td>
                    <td className="px-1 py-1.5 align-top text-navy-950 xl:px-1.5">
                      {booking.airline}
                    </td>
                    <td className="whitespace-nowrap px-1 py-1.5 align-top font-semibold tabular-nums text-navy-950 xl:px-1.5">
                      {booking.fare.toLocaleString('en-US')}
                    </td>
                    {showGross && (
                      <td className="whitespace-nowrap px-1 py-1.5 align-top font-semibold tabular-nums text-navy-950 xl:px-1.5">
                        {booking.gross === null
                          ? '—'
                          : booking.gross.toLocaleString('en-US', {
                              minimumFractionDigits: 2,
                              maximumFractionDigits: 2,
                            })}
                      </td>
                    )}
                    <td className="px-1 py-1.5 align-top xl:px-1.5">
                      <DateCell value={booking.lifecycleAt} withTime />
                    </td>
                    <td className="max-w-[7rem] whitespace-pre-line px-1 py-1.5 align-top leading-tight text-navy-950 xl:max-w-[8rem] xl:px-1.5">
                      {showSupplierPayable
                        ? booking.supplierPayable === null
                          ? '—'
                          : booking.supplierPayable.toLocaleString('en-US', {
                              minimumFractionDigits: 2,
                              maximumFractionDigits: 2,
                            })
                        : formatPassengerType(booking.passengerType)}
                    </td>
                    {showProfit && (
                      <td className="whitespace-nowrap px-1 py-1.5 align-top font-semibold tabular-nums text-navy-950 xl:px-1.5">
                        {booking.supplierPayable === null
                          ? '—'
                          : (booking.fare - booking.supplierPayable).toLocaleString(
                              'en-US',
                              {
                                minimumFractionDigits: 2,
                                maximumFractionDigits: 2,
                              }
                            )}
                      </td>
                    )}
                    <td className="max-w-[6rem] whitespace-pre-line px-1 py-1.5 align-top leading-tight text-navy-950 xl:max-w-[7rem] xl:px-1.5">
                      {formatRoute(booking.route)}
                    </td>
                    <td
                      className="max-w-[8rem] whitespace-pre-line px-1 py-1.5 align-top leading-tight text-navy-950 xl:max-w-[10rem] xl:px-1.5"
                      title={booking.createdBy.replace(/\n/g, ' · ')}
                    >
                      {booking.createdBy}
                    </td>
                    <td className="px-1 py-1.5 align-top xl:px-1.5">
                      <BookingReferences
                        booking={booking}
                        showSupplierReference={showSupplierReference}
                      />
                    </td>
                    {showActions && (
                      <td className="px-1 py-1.5 align-top xl:px-1.5">
                        <RowActions
                          booking={booking}
                          canManageUserVisibility={canManageUserVisibility}
                        />
                      </td>
                    )}
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Below lg: one label/value card per booking. */}
      <div className="w-full space-y-3 lg:hidden">
        {pageRows.length === 0 ? (
          <div className="rounded-xl border border-neutral-200 bg-white p-8 text-center text-sm text-neutral-500 shadow-sm">
            No bookings found
          </div>
        ) : (
          pageRows.map((booking) => (
            <div
              key={booking.referenceNo}
              className="overflow-hidden rounded-lg border border-neutral-200 bg-white"
            >
              <table className="w-full table-fixed text-xs">
                <tbody>
                  {(
                    [
                      ['Create Date', <DateCell key="c" value={booking.createDate} withTime />],
                      [
                        'Status',
                        <span key="s" className="flex flex-col items-start">
                          <StatusBadge status={booking.status} />
                          <TicketManagementReferences booking={booking} />
                          {booking.hiddenFromUser && (
                            <span className="mt-1 inline-flex rounded bg-sky-100 px-1.5 py-0.5 text-[10px] font-semibold text-sky-800">
                              Hidden from B2B
                            </span>
                          )}
                          <CustomerStatusMessage
                            message={booking.statusMessage}
                          />
                          <LifecycleIndicator
                            indicator={booking.lifecycleIndicator}
                          />
                        </span>,
                      ],
                      [
                        'Name',
                        <span key="n" className="whitespace-pre-line">
                          {formatName(booking.name)}
                        </span>,
                      ],
                      ['Fly Date', <DateCell key="f" value={booking.flyDate} withTime={false} />],
                      ['Airline', booking.airline],
                      [
                        'User Payable',
                        <span key="fa" className="font-semibold tabular-nums">
                          {booking.fare.toLocaleString('en-US')}
                        </span>,
                      ],
                      ...(showGross
                        ? ([
                            [
                              'Gross',
                              <span key="gross" className="font-semibold tabular-nums">
                                {booking.gross === null
                                  ? '—'
                                  : booking.gross.toLocaleString('en-US', {
                                      minimumFractionDigits: 2,
                                      maximumFractionDigits: 2,
                                    })}
                              </span>,
                            ],
                          ] as [string, React.ReactNode][])
                        : []),
                      ['Issued At', <DateCell key="i" value={booking.lifecycleAt} withTime />],
                      [
                        showSupplierPayable ? 'Supplier Payable' : 'Passenger Type',
                        <span key="p" className="whitespace-pre-line">
                          {showSupplierPayable
                            ? booking.supplierPayable === null
                              ? '—'
                              : booking.supplierPayable.toLocaleString('en-US', {
                                  minimumFractionDigits: 2,
                                  maximumFractionDigits: 2,
                                })
                            : formatPassengerType(booking.passengerType)}
                        </span>,
                      ],
                      ...(showProfit
                        ? ([
                            [
                              'Profit',
                              <span key="profit" className="font-semibold tabular-nums">
                                {booking.supplierPayable === null
                                  ? '—'
                                  : (
                                      booking.fare - booking.supplierPayable
                                    ).toLocaleString('en-US', {
                                      minimumFractionDigits: 2,
                                      maximumFractionDigits: 2,
                                    })}
                              </span>,
                            ],
                          ] as [string, React.ReactNode][])
                        : []),
                      [
                        'Route',
                        <span key="r" className="whitespace-pre-line">
                          {formatRoute(booking.route)}
                        </span>,
                      ],
                      [
                        'Created By',
                        <span key="created-by" className="whitespace-pre-line">
                          {booking.createdBy}
                        </span>,
                      ],
                      [
                        'Ref No',
                        <BookingReferences
                          key="ref"
                          booking={booking}
                          showSupplierReference={showSupplierReference}
                        />,
                      ],
                    ] as [string, React.ReactNode][]
                  ).map(([label, value]) => (
                    <tr key={label} className="border-b border-neutral-200">
                      <td className="w-[42%] bg-navy-50 px-3 py-2 align-middle font-medium text-neutral-500">
                        {label}
                      </td>
                      <td className="break-words px-3 py-2 align-middle text-navy-950">
                        {value}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {showActions && (
                <div className="flex items-center justify-between gap-2 bg-navy-50 px-3 py-2">
                  <span className="text-xs font-medium text-neutral-500">Actions</span>
                  <RowActions
                    booking={booking}
                    canManageUserVisibility={canManageUserVisibility}
                  />
                </div>
              )}
            </div>
          ))
        )}
      </div>

      {totalItems > 0 && (
        <div className="mt-4 rounded-lg border border-neutral-200 bg-white p-3">
          <div className="flex flex-col gap-3 xl:flex-row xl:items-center xl:justify-between">
            <div className="flex flex-wrap items-center gap-2 text-sm text-neutral-600">
              <span>Show Per Page</span>
              <select
                value={query.pageSize}
                onChange={(event) =>
                  onQueryChange({
                    pageSize: Number(event.target.value) as BookingListQuery['pageSize'],
                  })
                }
                aria-label="Rows per page"
                className="h-8 rounded-md border border-neutral-300 bg-white px-2 text-sm text-navy-950 focus:outline-none focus:ring-2 focus:ring-brand-orange/30"
              >
                {BOOKING_PAGE_SIZE_OPTIONS.map((size) => (
                  <option key={size} value={size}>
                    {size}
                  </option>
                ))}
              </select>
              <span>
                {pageStart + 1}-{pageEnd} of {totalItems} items
              </span>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={() => onQueryChange({ page: Math.max(1, safePage - 1) })}
                disabled={safePage <= 1}
                className="h-8 rounded-md border border-neutral-300 bg-white px-3 text-sm text-neutral-600 transition hover:bg-navy-50 disabled:cursor-not-allowed disabled:opacity-50"
              >
                Prev
              </button>
              {pageTokensFor(safePage, totalPages).map((token, index) =>
                typeof token === 'number' ? (
                  <button
                    key={`page-${token}`}
                    type="button"
                    onClick={() => onQueryChange({ page: token })}
                    aria-current={token === safePage ? 'page' : undefined}
                    className={`h-8 min-w-8 rounded-md border px-2 text-sm transition ${
                      token === safePage
                        ? 'border-brand-orange bg-brand-orange text-navy-950'
                        : 'border-neutral-300 bg-white text-neutral-600 hover:bg-navy-50'
                    }`}
                  >
                    {token}
                  </button>
                ) : (
                  <span
                    key={`${token}-${index}`}
                    className="inline-flex h-8 min-w-8 items-center justify-center rounded-md border border-neutral-300 bg-white px-2 text-sm text-neutral-500"
                  >
                    …
                  </span>
                )
              )}
              <button
                type="button"
                onClick={() => onQueryChange({ page: Math.min(totalPages, safePage + 1) })}
                disabled={safePage >= totalPages}
                className="h-8 rounded-md border border-neutral-300 bg-white px-3 text-sm text-neutral-600 transition hover:bg-navy-50 disabled:cursor-not-allowed disabled:opacity-50"
              >
                Next
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * Viewing is a read-only dashboard action. Supplier mutations remain disabled
 * until their reconciliation and lifecycle phases are implemented.
 */
type VisibilityApiBody = {
  success?: boolean;
  error?: { errorMessage?: string };
};

const HIDEABLE_BOOKING_STATUSES = new Set<BookingStatus>([
  'on-hold',
  'cancelled',
  'expired',
]);

function BookingVisibilityListAction({ booking }: { booking: BookingListRow }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const hidden = booking.hiddenFromUser;
  const actionLabel = hidden ? 'Restore to User' : 'Hide from User';

  async function changeVisibility() {
    if (busy) return;
    const reason = window.prompt(
      hidden
        ? 'Why should this booking be restored to the B2B user?'
        : 'Why should this booking be hidden from the B2B user?'
    );
    if (reason === null) return;
    if (reason.trim().length < 3) {
      window.alert('Please enter a reason of at least 3 characters.');
      return;
    }

    const confirmed = window.confirm(
      hidden
        ? 'Restore this booking to the B2B user? Future user-facing booking emails will resume.'
        : 'Hide this booking from the B2B agency? Status, wallet, supplier data, and internal processing will not change.'
    );
    if (!confirmed) return;

    setBusy(true);
    try {
      const response = await fetch(
        `/api/admin/bookings/${encodeURIComponent(booking.referenceNo)}/visibility`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            action: hidden ? 'unhide' : 'hide',
            requestId: crypto.randomUUID(),
            reason: reason.trim(),
          }),
        }
      );
      const body = (await response.json()) as VisibilityApiBody;
      if (!response.ok || !body.success) {
        throw new Error(
          body.error?.errorMessage ??
            'The visibility change was not accepted. Refresh and try again.'
        );
      }
      router.refresh();
    } catch (error) {
      window.alert(
        error instanceof Error ? error.message : 'The visibility change failed.'
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <button
      type="button"
      onClick={() => void changeVisibility()}
      disabled={busy}
      aria-label={`${actionLabel} ${booking.referenceNo}`}
      title={
        hidden
          ? actionLabel
          : `${actionLabel} (wallet and lifecycle eligibility is rechecked on submit)`
      }
      className="ml-1 inline-flex h-6 items-center gap-1 rounded border border-sky-200 bg-sky-50 px-1.5 text-[10px] font-semibold text-sky-800 transition hover:bg-sky-100 focus:outline-none focus:ring-2 focus:ring-sky-300 disabled:cursor-wait disabled:opacity-60"
    >
      {busy ? (
        <Loader2 className="h-3 w-3 animate-spin" aria-hidden />
      ) : hidden ? (
        <Eye className="h-3 w-3" aria-hidden />
      ) : (
        <EyeOff className="h-3 w-3" aria-hidden />
      )}
      {hidden ? 'Restore' : 'Hide'}
    </button>
  );
}

function RowActions({
  booking,
  canManageUserVisibility,
}: {
  booking: BookingListRow;
  canManageUserVisibility: boolean;
}) {
  const disabledActions = [
    { icon: RefreshCw, label: 'Refresh booking' },
    { icon: Edit, label: 'Edit booking' },
    { icon: Trash2, label: 'Delete booking' },
  ];

  return (
    <div className="flex items-center gap-0.5">
      <Link
        href={bookingHref(booking.referenceNo)}
        aria-label={`View booking ${booking.referenceNo}`}
        title="View booking"
        className="flex h-6 w-6 items-center justify-center rounded text-neutral-500 transition hover:bg-brand-orange-light hover:text-brand-orange-dark focus:outline-none focus:ring-2 focus:ring-brand-orange/30"
      >
        <Eye className="h-3 w-3" aria-hidden />
      </Link>
      {disabledActions.map(({ icon: Icon, label }) => (
        <button
          key={label}
          type="button"
          disabled
          aria-label={label}
          title={`${label} — not available yet`}
          className="flex h-6 w-6 cursor-not-allowed items-center justify-center rounded text-neutral-400 opacity-60"
        >
          <Icon className="h-3 w-3" aria-hidden />
        </button>
      ))}
      {canManageUserVisibility &&
        booking.isAgencyBooking &&
        (booking.hiddenFromUser || HIDEABLE_BOOKING_STATUSES.has(booking.status)) && (
          <BookingVisibilityListAction booking={booking} />
        )}
    </div>
  );
}

/** The search field and filter toggle that sit above the list. */
export function BookingsFilterBar({
  searchQuery,
  onSearchQueryChange,
  showAdvancedFilter,
  onAdvancedFilterToggle,
  onRefresh,
  isRefreshing,
}: {
  searchQuery: string;
  onSearchQueryChange: (value: string) => void;
  showAdvancedFilter: boolean;
  onAdvancedFilterToggle: () => void;
  onRefresh: () => void;
  isRefreshing: boolean;
}) {
  return (
    <div className="flex flex-col gap-2 border-t border-neutral-200 bg-navy-50 px-3 py-2.5 sm:flex-row sm:items-center sm:justify-end sm:px-4 lg:px-6 lg:py-3">
      <div className="relative w-full sm:max-w-[280px] lg:max-w-sm">
        <Search
          className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-neutral-400"
          aria-hidden
        />
        <input
          type="search"
          placeholder="Ref No, PNR, Name, Email"
          aria-label="Search bookings"
          value={searchQuery}
          onChange={(event) => onSearchQueryChange(event.target.value)}
          className="h-8 w-full rounded-md border border-neutral-300 bg-white pl-8 pr-3 text-xs text-navy-950 shadow-sm focus:border-brand-orange focus:outline-none focus:ring-2 focus:ring-brand-orange/30"
        />
      </div>
      <button
        type="button"
        onClick={onRefresh}
        disabled={isRefreshing}
        className="flex h-8 w-full shrink-0 items-center justify-center gap-1.5 rounded-md border border-neutral-300 bg-white px-3 text-xs font-medium text-navy-950 transition hover:bg-white/70 disabled:cursor-wait disabled:opacity-60 sm:w-auto"
      >
        <RefreshCw
          className={`h-3.5 w-3.5 ${isRefreshing ? 'animate-spin' : ''}`}
          aria-hidden
        />
        Refresh
      </button>
      <button
        type="button"
        onClick={onAdvancedFilterToggle}
        aria-expanded={showAdvancedFilter}
        className={`flex h-8 w-full shrink-0 items-center justify-center gap-1.5 rounded-md border px-3 text-xs font-medium transition sm:w-auto ${
          showAdvancedFilter
            ? 'border-brand-orange/40 bg-brand-orange-light text-brand-orange-dark'
            : 'border-neutral-300 bg-white text-navy-950 hover:bg-white/70'
        }`}
      >
        <Filter className="h-3.5 w-3.5" aria-hidden />
        Advanced Filter
        <ChevronDown
          className={`h-3.5 w-3.5 transition-transform ${
            showAdvancedFilter ? 'rotate-180' : ''
          }`}
          aria-hidden
        />
      </button>
    </div>
  );
}
