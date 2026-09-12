import {
  BOOKING_STATUSES,
  type BookingStatus,
} from '@/lib/flights/booking-status';

export const BOOKING_PAGE_SIZE_OPTIONS = [10, 25, 50, 100] as const;
export const DEFAULT_BOOKING_PAGE_SIZE = 50;

export type BookingListSortKey =
  | 'createDate'
  | 'status'
  | 'name'
  | 'flyDate'
  | 'airline'
  | 'fare'
  | 'gross'
  | 'lifecycleAt'
  | 'passengerType'
  | 'supplierPayable'
  | 'profit'
  | 'route'
  | 'createdBy'
  | 'referenceNo';

export type BookingListSortDirection = 'asc' | 'desc';

export type BookingListQuery = {
  page: number;
  pageSize: (typeof BOOKING_PAGE_SIZE_OPTIONS)[number];
  search: string;
  status: BookingStatus | 'all';
  createdBy: string;
  createdFrom: string;
  createdTo: string;
  flyFrom: string;
  flyTo: string;
  amountMin: string;
  amountMax: string;
  sortKey: BookingListSortKey | null;
  sortDirection: BookingListSortDirection;
};

const SORT_KEYS = new Set<BookingListSortKey>([
  'createDate',
  'status',
  'name',
  'flyDate',
  'airline',
  'fare',
  'gross',
  'lifecycleAt',
  'passengerType',
  'supplierPayable',
  'profit',
  'route',
  'createdBy',
  'referenceNo',
]);

const BOOKING_STATUS_SET = new Set<string>(BOOKING_STATUSES);
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export const DEFAULT_BOOKING_LIST_QUERY: BookingListQuery = {
  page: 1,
  pageSize: DEFAULT_BOOKING_PAGE_SIZE,
  search: '',
  status: 'all',
  createdBy: '',
  createdFrom: '',
  createdTo: '',
  flyFrom: '',
  flyTo: '',
  amountMin: '',
  amountMax: '',
  sortKey: null,
  sortDirection: 'desc',
};

type SearchParamValue = string | string[] | undefined;

function first(value: SearchParamValue): string {
  return Array.isArray(value) ? value[0] ?? '' : value ?? '';
}

function cappedText(value: SearchParamValue, maxLength = 120): string {
  return first(value).trim().slice(0, maxLength);
}

function positiveInteger(value: SearchParamValue, fallback: number): number {
  const parsed = Number(first(value));
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function validDate(value: SearchParamValue): string {
  const date = first(value);
  return DATE_RE.test(date) ? date : '';
}

function validAmount(value: SearchParamValue): string {
  const amount = first(value).trim();
  if (!amount) return '';
  const parsed = Number(amount);
  return Number.isFinite(parsed) && parsed >= 0 ? String(parsed) : '';
}

/** Parse and bound a URL query before it reaches a database query. */
export function bookingListQueryFromSearchParams(
  searchParams: Record<string, SearchParamValue>
): BookingListQuery {
  const requestedSize = positiveInteger(
    searchParams.pageSize,
    DEFAULT_BOOKING_PAGE_SIZE
  );
  const pageSize = BOOKING_PAGE_SIZE_OPTIONS.includes(
    requestedSize as (typeof BOOKING_PAGE_SIZE_OPTIONS)[number]
  )
    ? (requestedSize as (typeof BOOKING_PAGE_SIZE_OPTIONS)[number])
    : DEFAULT_BOOKING_PAGE_SIZE;
  const requestedStatus = first(searchParams.status);
  const requestedSort = first(searchParams.sort);

  return {
    page: positiveInteger(searchParams.page, 1),
    pageSize,
    search: cappedText(searchParams.q),
    status: BOOKING_STATUS_SET.has(requestedStatus)
      ? (requestedStatus as BookingStatus)
      : 'all',
    createdBy: cappedText(searchParams.createdBy),
    createdFrom: validDate(searchParams.createdFrom),
    createdTo: validDate(searchParams.createdTo),
    flyFrom: validDate(searchParams.flyFrom),
    flyTo: validDate(searchParams.flyTo),
    amountMin: validAmount(searchParams.amountMin),
    amountMax: validAmount(searchParams.amountMax),
    sortKey: SORT_KEYS.has(requestedSort as BookingListSortKey)
      ? (requestedSort as BookingListSortKey)
      : null,
    sortDirection: first(searchParams.direction) === 'asc' ? 'asc' : 'desc',
  };
}
