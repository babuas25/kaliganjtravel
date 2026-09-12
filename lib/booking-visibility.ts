import type { Role } from '@/lib/roles';

export const BOOKING_VISIBILITY_MANAGER_ROLES = [
  'superadmin',
  'admin',
  'staff_support',
] as const satisfies readonly Role[];

export function canManageBookingUserVisibility(role: Role): boolean {
  return BOOKING_VISIBILITY_MANAGER_ROLES.includes(
    role as (typeof BOOKING_VISIBILITY_MANAGER_ROLES)[number]
  );
}

export type BookingVisibilityAction = 'hide' | 'unhide';

export type BookingUserVisibilityContext = {
  ok: boolean;
  code: string;
  bookingId?: string;
  bookingReference?: string;
  canManage?: boolean;
  hiddenFromUser: boolean;
  hiddenByUserId: string | null;
  hiddenAt: string | null;
  hiddenReason: string | null;
  effectiveStatus: string;
  eligibleToHide: boolean;
  reservationCount: number;
  ledgerCount: number;
  financialSummaryClean: boolean;
  lastAction: BookingVisibilityAction | null;
  lastActionAt: string | null;
  lastActionByUserId: string | null;
  lastActionReason: string | null;
};

export type BookingUserVisibilityMutationResult = {
  ok: boolean;
  code?: string;
  replay?: boolean;
  bookingId?: string;
  bookingReference?: string;
  action?: BookingVisibilityAction;
  hiddenFromUser?: boolean;
  effectiveStatus?: string;
  context?: Partial<BookingUserVisibilityContext>;
};
