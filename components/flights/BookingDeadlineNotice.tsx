'use client';

import { Clock3, Loader2 } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useEffect, useId, useRef, useState } from 'react';
import { Switch } from '@/components/ui/switch';

const deadlineFormatter = new Intl.DateTimeFormat('en-GB', {
  day: 'numeric', month: 'short', year: 'numeric',
  hour: '2-digit', minute: '2-digit', hour12: false,
  timeZone: 'Asia/Dhaka',
});

export function BookingDeadlineNotice({
  deadline,
  bookingReference,
  allowRefresh = false,
  disabled = false,
  onRefreshingChange,
}: {
  deadline: string | null;
  bookingReference: string;
  allowRefresh?: boolean;
  disabled?: boolean;
  onRefreshingChange?: (refreshing: boolean) => void;
}) {
  const router = useRouter();
  const switchId = useId();
  const [expanded, setExpanded] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [displayedDeadline, setDisplayedDeadline] = useState(deadline);
  const [message, setMessage] = useState<string | null>(null);
  const pendingRequest = useRef<AbortController | null>(null);
  const mounted = useRef(true);
  const instant = displayedDeadline ? Date.parse(displayedDeadline) : Number.NaN;
  const hasDeadline = Number.isFinite(instant);

  useEffect(() => { setDisplayedDeadline(deadline); }, [deadline]);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      pendingRequest.current?.abort();
      onRefreshingChange?.(false);
    };
  }, [onRefreshingChange]);

  // This function is called only by a user's OFF -> ON interaction. Mounting,
  // prop changes and router.refresh() must never trigger a supplier request.
  async function refreshTicketingTime() {
    if (!allowRefresh || disabled || pendingRequest.current) return;
    const controller = new AbortController();
    pendingRequest.current = controller;
    setRefreshing(true);
    onRefreshingChange?.(true);
    setMessage(null);
    const timeout = window.setTimeout(() => controller.abort(), 60_000);
    try {
      const response = await fetch('/api/flights/booking/refresh-ticketing-time', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ bookingReference }),
        signal: controller.signal,
      });
      const body = await response.json() as {
        success?: boolean;
        data?: { updated?: boolean; ticketingDeadlineAt?: string | null };
        error?: { errorMessage?: string };
      };
      if (!response.ok || !body.success) {
        throw new Error(body.error?.errorMessage || 'The ticketing time could not be refreshed.');
      }
      if (!mounted.current) return;
      const refreshedDeadline = body.data?.ticketingDeadlineAt;
      if (refreshedDeadline && Number.isFinite(Date.parse(refreshedDeadline))) {
        setDisplayedDeadline(refreshedDeadline);
      }
      setMessage(body.data?.updated
        ? null
        : 'The supplier did not return a new ticketing time.');
      if (body.data?.updated) router.refresh();
    } catch (error) {
      if (mounted.current) {
        const reason = error instanceof Error && error.name !== 'AbortError'
          ? error.message
          : 'The refresh timed out.';
        setMessage(`${reason} Turn off and on to retry.`);
      }
    } finally {
      window.clearTimeout(timeout);
      pendingRequest.current = null;
      if (mounted.current) {
        setRefreshing(false);
        onRefreshingChange?.(false);
      }
    }
  }

  if (!allowRefresh) return (
    <p className="print-hide-expiration mt-2 text-[11px] font-medium leading-4 text-inherit">
      {hasDeadline
        ? `Issue before: ${deadlineFormatter.format(new Date(instant))} (Bangladesh time).`
        : 'Ticketing deadline unavailable. Availability is checked when you issue.'}
    </p>
  );

  return (
    <div className="print-hide-expiration mt-3 border-t border-current/10 pt-2 text-left">
      <div className="flex items-center justify-between gap-3">
        <label htmlFor={switchId} className="flex cursor-pointer items-center gap-1.5 text-[11px] font-semibold">
          <Clock3 className="h-3.5 w-3.5 shrink-0" aria-hidden />
          Booking time limit
        </label>
        <Switch
          id={switchId}
          checked={expanded}
          disabled={disabled}
          onCheckedChange={(checked) => {
            setExpanded(checked);
            if (checked) void refreshTicketingTime();
          }}
          aria-label="Show booking time limit"
          aria-controls={`${switchId}-time`}
          className="data-[state=checked]:bg-brand-orange data-[state=unchecked]:bg-neutral-300"
        />
      </div>
      {expanded && (
        <div id={`${switchId}-time`} role="status" aria-live="polite" aria-busy={refreshing}
          className="mt-2 rounded-md border border-current/10 bg-white/40 px-2.5 py-2 text-[11px] leading-4">
          {refreshing && (
            <p className="flex items-center gap-1.5 font-medium">
              <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" aria-hidden />
              Checking ticketing time…
            </p>
          )}
          {hasDeadline ? (
            <p className={refreshing ? 'mt-1' : ''}>
              Issue before: <span className="font-semibold">{deadlineFormatter.format(new Date(instant))}</span>
              <span className="block text-[10px] opacity-70">Bangladesh time</span>
            </p>
          ) : !refreshing && (
            <p className="font-medium">Ticketing time unavailable.</p>
          )}
          {!refreshing && message && <p className="mt-1 opacity-80">{message}</p>}
        </div>
      )}
    </div>
  );
}
