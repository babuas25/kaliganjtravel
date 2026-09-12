/** Client-safe announcement-slider limits and view types. */

export const ANNOUNCEMENT_MESSAGE_MAX_LENGTH = 180;
export const ANNOUNCEMENT_MESSAGE_LIMIT = 12;
export const ANNOUNCEMENT_SCROLL_DURATION_MIN = 12;
export const ANNOUNCEMENT_SCROLL_DURATION_MAX = 90;
export const DEFAULT_ANNOUNCEMENT_SCROLL_DURATION = 28;

export type AnnouncementMessage = {
  id: string;
  text: string;
  active: boolean;
};

export const DEFAULT_ANNOUNCEMENT_MESSAGES: readonly AnnouncementMessage[] = [
  {
    id: 'c32b714b-78c4-4e06-a6e6-1448f78fb629',
    text: 'Summer Sale — up to 40% off select flights to Europe',
    active: true,
  },
  {
    id: 'ee4ace2c-f824-4f9a-9c18-153a90350666',
    text: 'New route: London → Tokyo now available daily',
    active: true,
  },
  {
    id: '834c5ffd-b94f-4382-a397-434994e29bed',
    text: 'Members earn 2x miles on weekend bookings',
    active: true,
  },
  {
    id: '435fbed5-14c5-4530-a84d-e23af430bb29',
    text: 'Free cancellation on Premium fares through August',
    active: true,
  },
];

export type AnnouncementSliderState = {
  messages: AnnouncementMessage[];
  scrollDurationSeconds: number;
  version: number;
  updatedAt: string | null;
  updatedBy: string | null;
  source: 'database' | 'fallback' | 'unavailable';
};
