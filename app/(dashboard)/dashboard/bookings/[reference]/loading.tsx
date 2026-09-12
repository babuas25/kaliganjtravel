import { cn } from '@/lib/utils';

function Pulse({ className }: { className: string }) {
  return <span aria-hidden className={cn("block animate-pulse rounded bg-neutral-200 motion-reduce:animate-none", className)} />;
}

function SectionHeading({ width = 'w-44' }: { width?: string }) {
  return (
    <div className="flex items-center gap-2">
      <Pulse className="h-4 w-4 rounded-sm bg-brand-orange-light" />
      <Pulse className={`h-3 ${width}`} />
    </div>
  );
}

/**
 * Route-level streaming fallback for an individual booking.
 *
 * The dashboard shell remains interactive while the server authorizes and
 * loads the booking. These blocks mirror BookingDetails closely enough that
 * the final ticket replaces them without a large layout jump.
 */
export default function BookingDetailsLoading() {
  return (
    <div
      className="mx-auto w-full max-w-[1116px] space-y-4"
      aria-busy="true"
      aria-live="polite"
    >
      <span className="sr-only">Loading booking details</span>

      <div className="flex h-5 items-center gap-2">
        <Pulse className="h-4 w-4 rounded-full" />
        <Pulse className="h-3.5 w-36" />
      </div>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_260px] lg:items-start lg:gap-6">
        <article className="min-w-0 overflow-hidden rounded-md bg-white ring-1 ring-navy-950/10">
          <header>
            <div className="border-t-4 border-brand-orange bg-brand-orange px-4 py-4 text-black sm:px-5">
              <div className="flex items-start justify-between gap-4">
                <div className="flex min-w-0 items-center gap-3">
                  <Pulse className="h-11 w-11 shrink-0 bg-white/80" />
                  <div className="space-y-2">
                    <Pulse className="h-4 w-32 bg-black/30" />
                    <Pulse className="h-2.5 w-48 max-w-[42vw] bg-black/15" />
                  </div>
                </div>
                <div className="flex shrink-0 flex-col items-end gap-2">
                  <Pulse className="h-2.5 w-24 bg-black/15" />
                  <Pulse className="h-4 w-36 bg-black/30" />
                  <Pulse className="h-6 w-24 rounded-full bg-black/10" />
                </div>
              </div>
              <div className="mt-4 grid max-w-md grid-cols-2 gap-3 rounded-md bg-white/15 p-3">
                <Pulse className="h-2.5 w-28 bg-black/20" />
                <Pulse className="h-2.5 w-36 bg-black/20" />
                <Pulse className="h-2.5 w-32 bg-black/15" />
                <Pulse className="h-2.5 w-28 bg-black/15" />
              </div>
            </div>

            <div className="grid border-t border-orange-200 bg-brand-orange-light sm:grid-cols-2 lg:grid-cols-4">
              {Array.from({ length: 4 }, (_, index) => (
                <div
                  key={index}
                  className="space-y-2 border-b border-orange-200 px-4 py-3 last:border-b-0 sm:px-5 sm:[&:nth-child(odd)]:border-r lg:border-b-0 lg:border-r lg:last:border-r-0"
                >
                  <Pulse className="h-2.5 w-20 bg-navy-950/15" />
                  <Pulse className="h-3.5 w-24 bg-navy-950/25" />
                </div>
              ))}
            </div>
          </header>

          <section className="border-b border-navy-950/10 px-4 py-4 sm:px-5">
            <SectionHeading width="w-48" />
            <div className="mt-3 overflow-hidden rounded-md ring-1 ring-navy-950/10">
              <div className="grid grid-cols-[1.7fr_.7fr_.7fr_1fr] gap-4 bg-neutral-50 px-3 py-2.5">
                {["w-24", "w-12", "w-14", "w-20"].map((width, index) => (
                  <Pulse key={index} className={`h-2.5 ${width} max-w-full`} />
                ))}
              </div>
              <div className="grid grid-cols-[1.7fr_.7fr_.7fr_1fr] items-center gap-4 border-t border-navy-950/10 px-3 py-3.5">
                <div className="space-y-2"><Pulse className="h-3 w-40 max-w-full" /><Pulse className="h-2.5 w-28 max-w-full" /></div>
                <Pulse className="h-3 w-12" />
                <Pulse className="h-3 w-14" />
                <Pulse className="h-3 w-20 max-w-full" />
              </div>
            </div>
          </section>

          <section className="border-b border-navy-950/10 px-4 py-4 sm:px-5">
            <div className="flex items-center justify-between gap-4">
              <SectionHeading width="w-32" />
              <Pulse className="h-2.5 w-44 max-w-[38%]" />
            </div>
            <div className="mt-3 overflow-hidden rounded-md ring-1 ring-navy-950/10">
              <div className="flex items-center gap-3 bg-neutral-50 px-3 py-2.5">
                <Pulse className="h-7 w-7 shrink-0 rounded-full" />
                <div className="space-y-1.5"><Pulse className="h-3 w-28" /><Pulse className="h-2.5 w-20" /></div>
              </div>
              <div className="grid grid-cols-[1fr_5rem_1fr] items-center gap-4 px-3 py-5">
                <div className="space-y-2"><Pulse className="h-6 w-16" /><Pulse className="h-3 w-10" /><Pulse className="h-2.5 w-28 max-w-full" /></div>
                <div className="space-y-2"><Pulse className="mx-auto h-2.5 w-10" /><Pulse className="h-px w-full rounded-none" /></div>
                <div className="flex flex-col items-end space-y-2"><Pulse className="h-6 w-16" /><Pulse className="h-3 w-10" /><Pulse className="h-2.5 w-28 max-w-full" /></div>
              </div>
              <div className="grid grid-cols-4 gap-3 border-t border-navy-950/10 bg-neutral-50/70 px-3 py-2.5">
                {Array.from({ length: 4 }, (_, index) => <Pulse key={index} className="h-2.5 w-full" />)}
              </div>
            </div>
          </section>

          <section className="px-4 py-4 sm:px-5">
            <SectionHeading width="w-32" />
            <div className="mt-3 overflow-hidden rounded-md ring-1 ring-navy-950/10">
              <div className="grid grid-cols-5 gap-4 bg-neutral-50 px-3 py-2.5">
                {Array.from({ length: 5 }, (_, index) => <Pulse key={index} className="h-2.5 w-full" />)}
              </div>
              <div className="grid grid-cols-5 gap-4 border-t border-navy-950/10 px-3 py-3">
                {Array.from({ length: 5 }, (_, index) => <Pulse key={index} className="h-3 w-full" />)}
              </div>
              <div className="flex items-center justify-between bg-brand-orange px-3 py-3">
                <Pulse className="h-3 w-20 bg-black/25" />
                <Pulse className="h-4 w-24 bg-white/80" />
              </div>
            </div>
            <div className="mt-3 flex gap-4"><Pulse className="h-2.5 w-24" /><Pulse className="h-2.5 w-24" /><Pulse className="h-2.5 w-32" /></div>
          </section>

          <footer className="flex items-center justify-between gap-4 border-t border-navy-950/10 bg-neutral-50 px-4 py-3 sm:px-5">
            <Pulse className="h-2.5 w-72 max-w-[60%]" />
            <Pulse className="h-2.5 w-36" />
          </footer>
        </article>

        <aside className="w-full shrink-0 lg:sticky lg:top-4 lg:w-[260px]">
          <div className="overflow-hidden rounded-lg border-t-4 border-brand-orange bg-brand-orange p-4">
            <div className="flex items-center gap-2 pb-3">
              <Pulse className="h-6 w-6 bg-white/15" />
              <Pulse className="h-3 w-28 bg-black/20" />
            </div>
            <div className="space-y-2">
              {Array.from({ length: 5 }, (_, index) => (
                <Pulse key={index} className="h-10 w-full bg-white/90" />
              ))}
            </div>
            <div className="mt-3 rounded-md border border-black/10 bg-white/10 p-3">
              <Pulse className="h-3 w-28 bg-black/20" />
              <Pulse className="mt-2 h-2.5 w-full bg-black/10" />
              <Pulse className="mt-1.5 h-2.5 w-4/5 bg-black/10" />
            </div>
          </div>
        </aside>
      </div>
    </div>
  );
}
