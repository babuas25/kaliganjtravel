'use client';
import { useEffect, useRef, useState } from 'react';
import { usePathname } from 'next/navigation';
import { initializePromotionalTabSession } from '@/lib/promotional-tab-session.client';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { promotionDue, promotionSchema, PROMOTION_PAGES, type PromotionSlide } from '@/lib/promotional-popup';

export function PromotionDialog({ slides, open, onOpenChange, autoCloseSeconds = 10 }: { autoCloseSeconds?: number; slides: PromotionSlide[]; open: boolean; onOpenChange: (open: boolean) => void }) {
  const [index, setIndex] = useState(0);
  const [remaining, setRemaining] = useState(autoCloseSeconds);
  useEffect(() => {
    if (!open) return;
    setRemaining(autoCloseSeconds);
    const deadline = Date.now() + autoCloseSeconds * 1000;
    const countdown = window.setInterval(() => setRemaining(Math.max(0, Math.ceil((deadline - Date.now()) / 1000))), 250);
    const close = window.setTimeout(() => onOpenChange(false), autoCloseSeconds * 1000);
    return () => { window.clearInterval(countdown); window.clearTimeout(close); };
  }, [open, autoCloseSeconds, onOpenChange]);
  const slide = slides[index % Math.max(1, slides.length)];
  return <Dialog open={open && Boolean(slide)} onOpenChange={onOpenChange}>
    <DialogContent className="w-[calc(100%-2rem)] max-w-[720px] overflow-hidden rounded-2xl border-0 bg-white p-0 shadow-2xl sm:rounded-2xl [&>button]:z-10 [&>button]:rounded-full [&>button]:bg-white [&>button]:p-2 [&>button]:opacity-100">
      <DialogTitle className="sr-only">{slide?.title ?? 'Promotional offers'}</DialogTitle>
      <DialogDescription className="sr-only">Latest offers and notices. Close this popup to continue.</DialogDescription>
      <p className="px-5 pt-3 text-xs text-neutral-500">Closes automatically in {remaining}s</p>
      {slide && <>
        {/* Artwork is uploaded and normalized by the media server action. */}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={slide.imageUrl} alt={slide.title} className="max-h-[70dvh] w-full object-contain" />
        <div className="flex items-center justify-between gap-3 px-5 pb-4">
          <div className="min-w-0"><a href={`/dashboard/announcements/${slide.id}`} onClick={() => onOpenChange(false)} className="mt-1 inline-block text-sm font-semibold text-brand-orange hover:underline">View offer →</a></div>
          {slides.length > 1 && <div className="flex shrink-0 items-center gap-3">
            <button type="button" aria-label="Previous promotion" onClick={() => setIndex((index + slides.length - 1) % slides.length)} className="rounded-full border p-2 text-navy-950 hover:bg-navy-50"><ChevronLeft className="h-4 w-4" /></button>
            <span aria-live="polite" className="text-xs text-neutral-500">{index % slides.length + 1} / {slides.length}</span>
            <button type="button" aria-label="Next promotion" onClick={() => setIndex((index + 1) % slides.length)} className="rounded-full border p-2 text-navy-950 hover:bg-navy-50"><ChevronRight className="h-4 w-4" /></button>
          </div>}
        </div>
      </>}
    </DialogContent>
  </Dialog>;
}

export default function PromotionalPopup({ userId, signedInAt }: { userId: string; signedInAt: number | null }) {
  const pathname = usePathname();
  const [slides, setSlides] = useState<PromotionSlide[]>([]);
  const [autoCloseSeconds, setAutoCloseSeconds] = useState(10);
  const [open, setOpen] = useState(false);
  const memory = useRef<Record<string, { shownAt: number; signedInAt: number | null }>>({});
  useEffect(() => {
    if (!PROMOTION_PAGES.some((page) => page.path === pathname)) return;
    let disposed = false;
    let fetching = false;
    let settings: ReturnType<typeof promotionSchema.parse> | null = null;
    let eligibleSince: number | null = null;
    const storageKey = () => settings?.display.frequencyScope === 'tab'
      ? `promotion:tab-last-shown:${userId}`
      : `promotion:last-shown:${userId}`;
    const storage = () => settings?.display.frequencyScope === 'tab' ? sessionStorage : localStorage;
    const lastShown = () => {
      try {
        const value = JSON.parse(storage().getItem(storageKey()) ?? 'null');
        if (value && typeof value.shownAt === 'number' && Number.isFinite(value.shownAt)) return value;
      } catch { /* Private browsing can disable storage; use this mount's memory. */ }
      return memory.current[storageKey()] ?? null;
    };
    const check = () => {
      if (disposed || !settings || !settings.enabled || !settings.slides.length ||
          !settings.display.pages.some((page) => page === pathname) ||
          document.visibilityState !== 'visible' ||
          document.querySelector('[role="dialog"][data-state="open"], [role="alertdialog"][data-state="open"]') ||
          !promotionDue(lastShown(), signedInAt, Date.now(), settings.display)) {
        eligibleSince = null;
        return;
      }
      const now = Date.now();
      if (eligibleSince === null) eligibleSince = now;
      if (now - eligibleSince < settings.display.delaySeconds * 1000) return;
      const stamp = { shownAt: now, signedInAt };
      memory.current[storageKey()] = stamp;
      try { storage().setItem(storageKey(), JSON.stringify(stamp)); } catch { /* In-memory fallback. */ }
      eligibleSince = null;
      setSlides(settings.slides);
      setAutoCloseSeconds(settings.autoCloseSeconds);
      setOpen(true);
    };
    const refresh = async () => {
      if (disposed || fetching || document.visibilityState !== 'visible') return;
      fetching = true;
      try {
        const response = await fetch('/api/promotional-popup', { cache: 'no-store' });
        if (!response.ok || disposed) return;
        const result = promotionSchema.safeParse(await response.json());
        if (disposed || !result.success) return;
        if (result.data.display.frequencyScope === 'tab') await initializePromotionalTabSession();
        if (disposed) return;
        settings = result.data;
        check();
      } catch { /* Promotions must not block the dashboard if unavailable. */ }
      finally { fetching = false; }
    };
    const visibilityChanged = () => { check(); void refresh(); };
    void refresh();
    const timer = window.setInterval(check, 1000);
    const refreshTimer = window.setInterval(() => void refresh(), 60000);
    window.addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', visibilityChanged);
    return () => {
      disposed = true;
      window.clearInterval(timer);
      window.clearInterval(refreshTimer);
      window.removeEventListener('focus', refresh);
      document.removeEventListener('visibilitychange', visibilityChanged);
      setOpen(false);
    };
  }, [pathname, userId, signedInAt]);
  return <PromotionDialog autoCloseSeconds={autoCloseSeconds} slides={slides} open={open} onOpenChange={setOpen} />;
}
