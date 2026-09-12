import { Pause, Plane, Play } from 'lucide-react';

/** Decorative vector artwork: no network requests or animation timers. */
export default function AuthJourneyMotion() {
  return (
    <div className="auth-journey relative my-4 overflow-hidden rounded-2xl border border-white bg-white/65 shadow-[0_8px_24px_-16px_rgba(173,79,8,0.25)]">
      <div className="flex items-center justify-between px-4 pt-2">
        <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-neutral-500">Every journey begins here</p>
        <label className="relative grid h-7 w-7 cursor-pointer place-items-center rounded-full text-brand-orange-dark transition hover:bg-orange-100 motion-reduce:hidden">
          <input type="checkbox" aria-label="Pause travel animation" className="peer sr-only" />
          <span className="absolute inset-0 rounded-full peer-focus-visible:ring-2 peer-focus-visible:ring-brand-orange" />
          <Pause className="h-3 w-3 peer-checked:hidden" aria-hidden />
          <Play className="hidden h-3 w-3 peer-checked:block" aria-hidden />
        </label>
      </div>
      <svg viewBox="0 0 400 178" className="block h-[136px] w-full" aria-hidden="true">
        <circle cx="309" cy="52" r="32" fill="#ffedd5" />
        <circle cx="309" cy="52" r="22" fill="#fed7aa" opacity=".65" />
        <g className="auth-journey-cloud" fill="white" stroke="#f5e8d8" strokeWidth="1">
          <path d="M55 47h53a10 10 0 0 0-3-20 17 17 0 0 0-32-1 11 11 0 0 0-18 21Z" />
        </g>
        <g className="auth-journey-cloud auth-journey-cloud-late" fill="white" stroke="#f5e8d8" strokeWidth="1">
          <path d="M269 88h64a10 10 0 0 0-5-20 19 19 0 0 0-35-4 13 13 0 0 0-24 24Z" />
        </g>
        <path d="M42 138 Q200 -12 358 138" fill="none" stroke="#f4d6b4" strokeWidth="1.5" strokeDasharray="3 6" />
        <path className="auth-journey-trail" d="M42 138 Q200 -12 358 138" fill="none" stroke="#f68712" strokeWidth="2" pathLength="100" strokeDasharray="100" />
        <circle cx="42" cy="138" r="5" fill="#fff" stroke="#ad4f08" strokeWidth="1.5" />
        <circle className="auth-journey-pulse" cx="358" cy="138" r="12" fill="none" stroke="#f68712" />
        <circle cx="358" cy="138" r="5" fill="#f68712" />
        <g className="auth-journey-plane">
          <circle r="20" fill="white" stroke="#fed7aa" strokeWidth="1" />
          <g transform="rotate(45)">
            <Plane x="-13" y="-13" width="26" height="26" fill="#fff1e2" stroke="#ad4f08" strokeWidth="1.8" />
          </g>
        </g>
      </svg>
      <div className="-mt-1 flex items-end justify-between px-4 pb-3">
        <div><p className="text-xl font-semibold tracking-tight text-neutral-900">DAC</p><p className="mt-0.5 text-xs text-neutral-500">Dhaka</p></div>
        <div className="text-right"><p className="text-base font-semibold text-neutral-900">Your next stop</p><p className="mt-0.5 text-xs text-neutral-500">A new possibility</p></div>
      </div>
    </div>
  );
}
