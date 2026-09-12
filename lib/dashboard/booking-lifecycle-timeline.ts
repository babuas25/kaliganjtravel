export type BookingLifecycleTimelineKind = 'status' | 'operation' | 'case';

/** Visual treatment for a staff-facing, plain-language booking update. */
export type BookingLifecycleTimelineTone =
  | 'neutral'
  | 'progress'
  | 'success'
  | 'attention';

export type BookingLifecycleTimelineItem = {
  id: string;
  kind: BookingLifecycleTimelineKind;
  occurredAt: string | null;
  observedAt: string | null;
  /** A short operational outcome, written for booking users rather than developers. */
  title: string;
  /** Explains the outcome or the next step in plain language. */
  description: string;
  state: string | null;
  tone: BookingLifecycleTimelineTone;
  warning: boolean;
  facts: Array<{ label: string; value: string }>;
};
