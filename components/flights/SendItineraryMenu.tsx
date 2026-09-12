'use client';

import type { ItineraryOffer } from '@/lib/flights/share-offer';
import { useState, useRef, useId, type RefObject } from 'react';
import { Camera, Check, ChevronDown, Copy, Loader2, Mail, MessageSquare, Send } from 'lucide-react';
import { screenshotFonts } from '@/lib/flights/screenshot-fonts.client';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';

type Props = {
  cardRef: RefObject<HTMLElement>;
  text: string;
  subject: string;
  mobile?: boolean;
  offer?: ItineraryOffer;
};

export default function SendItineraryMenu({ cardRef, text, subject, offer, mobile = false }: Props) {
  const [channel, setChannel] = useState<'email' | 'sms' | null>(null);
  const [recipient, setRecipient] = useState('');
  const sending = useRef(false);
  const recipientId = useId();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState('');
  const [error, setError] = useState(false);

  async function perform(action: 'copy' | 'screenshot') {
    setFeedback('');
    setError(false);
    setBusy(true);
    try {
      if (action === 'copy') {
        await navigator.clipboard.writeText(text);
        setFeedback('Itinerary copied to clipboard.');
      } else {
        if (!cardRef.current) throw new Error('Card unavailable');
        const { toPng } = await import('html-to-image');
        await document.fonts.ready;
        const url = await toPng(cardRef.current, {
          pixelRatio: 2,
          backgroundColor: '#ffffff',
          fontEmbedCSS: await screenshotFonts(),
          filter: (node) => !(node instanceof HTMLElement && node.dataset.itineraryShare === 'true'),
        });
        const link = document.createElement('a');
        link.download = 'flight-itinerary.png';
        link.href = url;
        document.body.appendChild(link);
        link.click();
        link.remove();
        setFeedback('Screenshot downloaded.');
      }
    } catch {
      setError(true);
      setFeedback(action === 'copy'
        ? 'Could not copy. Please allow clipboard access and try again.'
        : 'Could not create the screenshot. Please try again.');
    } finally {
      setBusy(false);
    }
  }

  const rowClass = 'flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left transition hover:bg-navy-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-orange/40 disabled:opacity-50';
  const iconClass = 'flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-navy-50 text-navy-950';
  function chooseChannel(next: 'email' | 'sms' | null) {
    setChannel(next);
    setRecipient('');
    setFeedback('');
    setError(false);
  }

  async function sendItinerary(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (sending.current || !channel) return;
    sending.current = true;
    setBusy(true);
    setFeedback('');
    setError(false);
    try {
      const response = await fetch('/api/flights/share-itinerary', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ channel, recipient, message: text, subject, ...(channel === 'email' ? { offer } : {}) }),
      });
      const result = await response.json();
      if (!response.ok || !result.success) {
        throw new Error(result.error?.message || result.error?.errorMessage || 'Could not send the itinerary.');
      }
      setFeedback(`${channel === 'sms' ? 'SMS' : 'Email'} sent successfully.`);
    } catch (cause) {
      setError(true);
      setFeedback(cause instanceof Error ? cause.message : 'Could not confirm sending. Check before retrying.');
    } finally {
      sending.current = false;
      setBusy(false);
    }
  }

  return (
    <Popover open={open} onOpenChange={(next) => { if (sending.current) return; setOpen(next); chooseChannel(null); }}>
      <PopoverTrigger asChild>
        <button
          type="button"
          data-itinerary-share="true"
          className={mobile
            ? 'flex min-h-11 w-full items-center gap-2.5 border-t border-neutral-200 bg-white px-3 py-2 text-left text-sm font-semibold text-neutral-700 transition hover:bg-navy-50'
            : 'inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md px-2.5 py-1.5 text-[11px] font-semibold text-neutral-600 transition hover:bg-white hover:text-navy-950 data-[state=open]:bg-white data-[state=open]:text-brand-orange-dark'}
        >
          <Send className={mobile ? 'h-4 w-4' : 'h-3.5 w-3.5'} aria-hidden />
          Send itinerary
          <ChevronDown className={`h-3 w-3 transition-transform ${open ? 'rotate-180' : ''} ${mobile ? 'ml-auto' : ''}`} aria-hidden />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" side="top" sideOffset={8} className="w-72 max-w-[calc(100vw-24px)] rounded-xl border-neutral-200 bg-white p-2 shadow-xl">
        <div className="mb-1 border-b border-neutral-100 px-3 pb-3 pt-2">
          <h3 className="text-sm font-bold text-navy-950">Send itinerary</h3>
          <p className="mt-1 text-xs text-neutral-500">Choose how you’d like to share this flight.</p>
        </div>
        {channel ? (
          <form onSubmit={sendItinerary} className="space-y-3 px-3 py-2">
            <button type="button" disabled={busy} onClick={() => chooseChannel(null)} className="text-xs font-semibold text-neutral-500 hover:text-navy-950">← All sharing options</button>
            <div>
              <label htmlFor={recipientId} className="mb-1.5 block text-sm font-semibold text-navy-950">{channel === 'sms' ? 'Mobile number' : 'Email address'}</label>
              <input id={recipientId} autoFocus required disabled={busy} type={channel === 'sms' ? 'tel' : 'email'} autoComplete={channel === 'sms' ? 'tel' : 'email'} maxLength={channel === 'sms' ? 30 : 254} value={recipient} onChange={(event) => { setRecipient(event.target.value); setFeedback(''); }} placeholder={channel === 'sms' ? '01XXXXXXXXX or +8801XXXXXXXXX' : 'name@example.com'} className="w-full rounded-lg border border-neutral-300 px-3 py-2 text-sm outline-none focus:border-brand-orange focus:ring-2 focus:ring-brand-orange/10" />
            </div>
            <div className="max-h-48 overflow-y-auto whitespace-pre-wrap rounded-lg bg-navy-50 p-3 text-xs leading-relaxed text-navy-950" aria-label="Message preview">{text}</div>
            <button type="submit" disabled={busy || (!error && Boolean(feedback))} className="flex min-h-10 w-full items-center justify-center gap-2 rounded-lg bg-brand-orange px-3 py-2 text-sm font-bold text-navy-950 hover:bg-brand-orange-dark hover:text-white disabled:opacity-50">
              {busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Send className="h-4 w-4" aria-hidden />}
              {busy ? 'Sending…' : `Send ${channel === 'sms' ? 'SMS' : 'email'}`}
            </button>
          </form>
        ) : <>
        <button type="button" className={rowClass} disabled={busy} onClick={() => chooseChannel('email')}>
          <span className={iconClass}><Mail className="h-4 w-4" aria-hidden /></span>
          <span><span className="block text-sm font-semibold text-navy-950">Email</span><span className="block text-xs text-neutral-500">Send to an email address</span></span>
        </button>
        <button type="button" className={rowClass} disabled={busy} onClick={() => chooseChannel('sms')}>
          <span className={iconClass}><MessageSquare className="h-4 w-4" aria-hidden /></span>
          <span><span className="block text-sm font-semibold text-navy-950">SMS</span><span className="block text-xs text-neutral-500">Send to a mobile number</span></span>
        </button>
        <button type="button" className={rowClass} disabled={busy} onClick={() => void perform('screenshot')}>
          <span className={iconClass}><Camera className="h-4 w-4" aria-hidden /></span>
          <span><span className="block text-sm font-semibold text-navy-950">Screenshot</span><span className="block text-xs text-neutral-500">Download flight card as PNG</span></span>
        </button>
        <div className="my-1 border-t border-neutral-100" />
        <button type="button" className={rowClass} disabled={busy} onClick={() => void perform('copy')}>
          <span className={iconClass}><Copy className="h-4 w-4" aria-hidden /></span>
          <span><span className="block text-sm font-semibold text-navy-950">Copy itinerary</span><span className="block text-xs text-neutral-500">Paste the details anywhere</span></span>
        </button>
        </>}
        {(busy || feedback) && <p role={error ? 'alert' : 'status'} className={`mx-3 mb-2 mt-2 flex items-start gap-1.5 text-xs ${error ? 'text-brand-orange-dark' : 'text-neutral-600'}`}>
          {busy ? <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" aria-hidden /> : !error ? <Check className="h-3.5 w-3.5 shrink-0 text-emerald-600" aria-hidden /> : null}
          {busy ? (channel ? 'Sending itinerary…' : 'Preparing itinerary…') : feedback}
        </p>}
      </PopoverContent>
    </Popover>
  );
}
