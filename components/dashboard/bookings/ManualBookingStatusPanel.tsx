'use client';

import { useStatusFeedback } from '@/components/feedback/StatusFeedback';
import { Loader2, ShieldCheck } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState } from 'react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { BOOKING_STATUS_LABELS, type BookingStatus } from '@/lib/flights/booking-status';

const STAFF_TARGETS: BookingStatus[] = ['on-hold', 'pending', 'expired', 'unconfirmed', 'cancelled'];

function toIso(value: string): string | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

export default function ManualBookingStatusPanel({
  bookingReference,
  currentStatus,
  pnr,
  airlinePnr,
  ticketingDeadlineAt,
}: {
  bookingReference: string;
  currentStatus: BookingStatus;
  pnr: string | null;
  airlinePnr: string | null;
  ticketingDeadlineAt: string | null;
}) {
  const router = useRouter();
  const [targetStatus, setTargetStatus] = useState<BookingStatus>('on-hold');
  const [formPnr, setFormPnr] = useState(pnr ?? '');
  const [formAirlinePnr, setFormAirlinePnr] = useState(airlinePnr ?? '');
  const [deadline, setDeadline] = useState(() => ticketingDeadlineAt ? ticketingDeadlineAt.slice(0, 16) : '');
  const [cancellationReason, setCancellationReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const showFeedback = useStatusFeedback();

  async function submit() {
    setBusy(true); setMessage(null);
    try {
      const response = await fetch(`/api/impexp/manual-booking/${encodeURIComponent(bookingReference)}/status`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          requestId: crypto.randomUUID(), targetStatus,
          pnr: formPnr || undefined, airlinePnr: formAirlinePnr || undefined,
          ticketingDeadlineAt: toIso(deadline), cancellationReason: cancellationReason || undefined,
        }),
      });
      const body = await response.json() as { success?: boolean; error?: string; walletCharged?: boolean; chargedAmount?: number };
      if (!response.ok || !body.success) throw new Error(body.error || 'Manual status update failed.');
      setMessage(`${BOOKING_STATUS_LABELS[targetStatus]} saved.${body.walletCharged ? ` User Payable was charged once (${(Number(body.chargedAmount) / 100).toLocaleString()}).` : ''}`);
      showFeedback({ title: `Booking ${BOOKING_STATUS_LABELS[targetStatus]}`, description: 'The booking status has been updated successfully.', tone: targetStatus === 'pending' || targetStatus === 'in-progress' ? 'progress' : 'neutral', reference: bookingReference });
      router.refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Manual status update failed.');
    } finally { setBusy(false); }
  }

  if (currentStatus === 'confirmed' || currentStatus === 'cancelled') return null;
  return (
    <section className="overflow-hidden rounded-xl border border-violet-200 bg-white shadow-sm">
      <header className="flex items-start gap-3 border-b border-violet-200 bg-violet-50 px-5 py-4">
        <span className="rounded-full bg-white p-2 text-violet-700 ring-1 ring-violet-200"><ShieldCheck className="h-5 w-5" /></span>
        <div><h2 className="font-bold text-navy-950">Manual booking status</h2><p className="mt-1 text-sm text-neutral-600">Staff-only source command. Supplier API and Sync actions are never used for this booking.</p></div>
      </header>
      <div className="space-y-4 p-5">
        <label className="block max-w-sm"><span className="mb-1 block text-sm font-semibold text-navy-950">Change status</span><Select value={targetStatus} onValueChange={(value) => setTargetStatus(value as BookingStatus)}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent>{STAFF_TARGETS.map((status) => <SelectItem key={status} value={status}>{BOOKING_STATUS_LABELS[status]}</SelectItem>)}</SelectContent></Select></label>
        {(targetStatus === 'on-hold' || targetStatus === 'expired' || targetStatus === 'unconfirmed') && <div className="grid gap-3 sm:grid-cols-3"><label><span className="mb-1 block text-xs font-semibold">PNR</span><Input value={formPnr} onChange={(event) => setFormPnr(event.target.value)} /></label><label><span className="mb-1 block text-xs font-semibold">Airline PNR</span><Input value={formAirlinePnr} onChange={(event) => setFormAirlinePnr(event.target.value)} /></label>{targetStatus === 'on-hold' && <label><span className="mb-1 block text-xs font-semibold">Deadline (optional)</span><Input type="datetime-local" value={deadline} onChange={(event) => setDeadline(event.target.value)} /></label>}</div>}
        {targetStatus === 'cancelled' && <label className="block"><span className="mb-1 block text-sm font-semibold">Cancellation reason</span><textarea className="min-h-20 w-full rounded-md border border-input px-3 py-2 text-sm" value={cancellationReason} onChange={(event) => setCancellationReason(event.target.value)} /></label>}
        {message && <p role="status" className="rounded-md border border-neutral-200 bg-neutral-50 px-3 py-2 text-sm text-neutral-700">{message}</p>}
        <Button type="button" onClick={() => void submit()} disabled={busy}>{busy && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}Save manual status</Button>
      </div>
    </section>
  );
}
