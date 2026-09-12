'use client';

import { PackagePlus, Settings2, Ticket } from 'lucide-react';
import {
  BOOKING_STATUSES,
  BOOKING_STATUS_LABELS,
  type BookingStatus,
} from '@/lib/flights/booking-status';

export type BookingsTab = 0 | 1 | 2;

export type TicketStatusValue = 'all' | BookingStatus;

const TAB_ITEMS = [
  { label: 'Ticket', icon: Ticket, tab: 0 },
  { label: 'Manage', icon: Settings2, tab: 1 },
  { label: 'Add-ons', icon: PackagePlus, tab: 2 },
] as const;

const STATUS_TABS: { label: string; value: TicketStatusValue }[] = [
  { label: 'All', value: 'all' },
  ...BOOKING_STATUSES.map((value) => ({
    label: BOOKING_STATUS_LABELS[value],
    value,
  })),
];

/** The three top-level sections of the bookings screen. */
export function BookingsTabBar({
  activeTab,
  onTabChange,
  ticketManagementEnabled,
}: {
  activeTab: BookingsTab;
  onTabChange: (tab: BookingsTab) => void;
  ticketManagementEnabled: boolean;
}) {
  const items = ticketManagementEnabled
    ? TAB_ITEMS
    : TAB_ITEMS.filter((item) => item.tab !== 1);

  return (
    <div
      className="w-full border-b border-neutral-200 bg-white"
      role="tablist"
      aria-label="Bookings sections"
    >
      <div className="flex w-full">
        {items.map((item) => {
          const Icon = item.icon;
          const active = activeTab === item.tab;
          return (
            <button
              key={item.label}
              type="button"
              role="tab"
              aria-selected={active}
              onClick={() => onTabChange(item.tab)}
              className={`relative flex flex-1 items-center justify-center gap-1.5 border-b-2 px-1 py-2.5 text-xs font-medium transition-colors md:gap-2 md:px-4 md:py-3 md:text-sm ${
                active
                  ? 'border-brand-orange text-brand-orange-dark'
                  : 'border-transparent text-neutral-500 hover:bg-navy-50 hover:text-navy-950'
              }`}
            >
              <Icon className="h-4 w-4 shrink-0 md:h-5 md:w-5" aria-hidden />
              {item.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}

/** A scrollable row of secondary tabs, shared by every sub-tab row below. */
function SubTabs<Value extends string>({
  items,
  activeTab,
  onTabChange,
  label,
}: {
  items: readonly { label: string; value: Value }[];
  activeTab: Value;
  onTabChange: (value: Value) => void;
  label: string;
}) {
  return (
    <div
      className="w-full border-b border-neutral-200 bg-white"
      role="tablist"
      aria-label={label}
    >
      <div className="flex w-full overflow-x-auto">
        {items.map((item) => {
          const active = activeTab === item.value;
          return (
            <button
              key={item.value}
              type="button"
              role="tab"
              aria-selected={active}
              onClick={() => onTabChange(item.value)}
              className={`flex min-w-max flex-1 items-center justify-center whitespace-nowrap border-b-2 px-3 py-2 text-xs font-medium transition-colors ${
                active
                  ? 'border-brand-orange text-brand-orange-dark'
                  : 'border-transparent text-neutral-500 hover:bg-navy-50 hover:text-navy-950'
              }`}
            >
              {item.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}

/** The status filter row that sits directly under the Ticket tab. */
export function TicketStatusTabs({
  activeTab,
  onTabChange,
}: {
  activeTab: TicketStatusValue;
  onTabChange: (value: TicketStatusValue) => void;
}) {
  return (
    <SubTabs
      items={STATUS_TABS}
      activeTab={activeTab}
      onTabChange={onTabChange}
      label="Filter bookings by status"
    />
  );
}

export type ManageAction = 'refund' | 'reissue' | 'void';
export type ManageStatus =
  | 'all'
  | 'requested'
  | 'in-progress'
  | 'awaiting-confirmation'
  | 'approved'
  | 'rejected'
  | 'expired';

const MANAGE_ACTIONS: { label: string; value: ManageAction }[] = [
  { label: 'Refund', value: 'refund' },
  { label: 'Reissue', value: 'reissue' },
  { label: 'VOID', value: 'void' },
];

const MANAGE_STATUSES: { label: string; value: ManageStatus }[] = [
  { label: 'All', value: 'all' },
  { label: 'Requested', value: 'requested' },
  { label: 'In Progress', value: 'in-progress' },
  { label: 'Quotation', value: 'awaiting-confirmation' },
  { label: 'Approved', value: 'approved' },
  { label: 'Rejected', value: 'rejected' },
  { label: 'Expired', value: 'expired' },
];

/** Which kind of post-ticket request the Manage tab is listing. */
export function ManageActionTabs({
  activeTab,
  onTabChange,
}: {
  activeTab: ManageAction;
  onTabChange: (value: ManageAction) => void;
}) {
  return (
    <SubTabs
      items={MANAGE_ACTIONS}
      activeTab={activeTab}
      onTabChange={onTabChange}
      label="Manage request type"
    />
  );
}

/** Where those requests are in their workflow. */
export function ManageStatusTabs({
  activeTab,
  onTabChange,
}: {
  activeTab: ManageStatus;
  onTabChange: (value: ManageStatus) => void;
}) {
  return (
    <SubTabs
      items={MANAGE_STATUSES}
      activeTab={activeTab}
      onTabChange={onTabChange}
      label="Manage request status"
    />
  );
}
