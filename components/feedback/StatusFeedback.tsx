'use client';

import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from 'react';
import { ArrowRight, Check, Clock3, RefreshCw, Ticket, Wallet, X } from 'lucide-react';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';

const styles = {
  success: { icon: Check, color: 'text-emerald-600', background: 'bg-emerald-50', ring: 'ring-emerald-100', label: 'Completed' },
  progress: { icon: Clock3, color: 'text-amber-600', background: 'bg-amber-50', ring: 'ring-amber-100', label: 'Request received' },
  refund: { icon: Wallet, color: 'text-emerald-600', background: 'bg-emerald-50', ring: 'ring-emerald-100', label: 'Completed' },
  reissue: { icon: RefreshCw, color: 'text-blue-600', background: 'bg-blue-50', ring: 'ring-blue-100', label: 'Completed' },
  neutral: { icon: Ticket, color: 'text-slate-600', background: 'bg-slate-50', ring: 'ring-slate-100', label: 'Status updated' },
  error: { icon: X, color: 'text-red-600', background: 'bg-red-50', ring: 'ring-red-100', label: 'Needs attention' },
};

export type StatusFeedback = {
  title: string;
  description: string;
  reference?: string;
  tone?: keyof typeof styles;
  /** Suppress replay when a newly created booking is restored from history. */
  onceKey?: string;
};

const FeedbackContext = createContext<(feedback: StatusFeedback) => void>(() => {});
export const useStatusFeedback = () => useContext(FeedbackContext);

export default function StatusFeedbackProvider({ children }: { children: ReactNode }) {
  const [feedback, setFeedback] = useState<StatusFeedback | null>(null);
  const shown = useRef(new Set<string>());
  const show = useCallback((next: StatusFeedback) => {
    if (next.onceKey && shown.current.has(next.onceKey)) return;
    if (next.onceKey) shown.current.add(next.onceKey);
    setFeedback(next);
  }, []);
  const style = styles[feedback?.tone ?? 'success'];
  const Icon = style.icon;

  return (
    <FeedbackContext.Provider value={show}>
      {children}
      <Dialog open={feedback !== null} onOpenChange={(open) => { if (!open) setFeedback(null); }}>
        <DialogContent className="max-h-[calc(100dvh-2rem)] w-[calc(100%-2rem)] max-w-[420px] gap-0 overflow-y-auto rounded-2xl border-0 bg-white p-0 text-navy-950 shadow-2xl motion-reduce:animate-none sm:rounded-2xl">
          <div className={`h-1.5 ${style.background}`} />
          <div className="px-7 pb-7 pt-9 text-center">
            <div className={`mx-auto flex h-20 w-20 items-center justify-center rounded-full ring-8 ${style.background} ${style.ring} ${style.color}`}>
              <Icon className="h-9 w-9" strokeWidth={1.8} aria-hidden />
            </div>
            <p className={`mb-2 mt-7 text-[10px] font-bold uppercase tracking-[0.2em] ${style.color}`}>{style.label}</p>
            <DialogTitle className="text-2xl font-bold tracking-tight">{feedback?.title}</DialogTitle>
            <DialogDescription className="mt-3 text-sm leading-6 text-slate-500">{feedback?.description}</DialogDescription>
            {feedback?.reference && (
              <div className="mt-6 flex items-center justify-between gap-3 rounded-xl border border-dashed border-slate-200 bg-slate-50/80 px-4 py-3">
                <span className="text-xs text-slate-500">Reference</span>
                <span className="break-all font-mono text-xs font-semibold tracking-wide text-navy-950">{feedback.reference}</span>
              </div>
            )}
            <button autoFocus type="button" onClick={() => setFeedback(null)} className="mt-6 flex w-full items-center justify-center gap-2 rounded-xl bg-brand-orange px-4 py-3 text-sm font-semibold text-black transition hover:bg-brand-orange/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-navy-500 focus-visible:ring-offset-2">
              Continue <ArrowRight className="h-4 w-4" aria-hidden />
            </button>
            <p className="mt-3 text-[11px] text-slate-400">{feedback?.tone === 'progress' ? 'You can follow the latest status in your booking.' : 'You can safely close this message.'}</p>
          </div>
        </DialogContent>
      </Dialog>
    </FeedbackContext.Provider>
  );
}
