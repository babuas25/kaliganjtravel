import AuthJourneyMotion from '@/components/auth/AuthJourneyMotion';
import { Headphones, RefreshCw, Tickets } from 'lucide-react';

const perks = [
  { icon: Tickets, title: 'Your bookings, together', text: 'Keep your flight details in one place.' },
  { icon: RefreshCw, title: 'Plans can change', text: 'Get help with reissues and refunds.' },
  { icon: Headphones, title: 'A team you can reach', text: 'Travel support from Kaliganj Travels.' },
];

export default function AuthPromoPanel() {
  return (
    <aside className="relative hidden overflow-hidden bg-[#fff3e5] lg:flex lg:flex-col lg:justify-between lg:px-8 lg:py-6">
      <div aria-hidden className="pointer-events-none absolute -right-28 -top-28 h-80 w-80 rounded-full border-[50px] border-white/40" />
      <div className="relative">
        <span className="inline-flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.18em] text-brand-orange-dark"><span className="h-1.5 w-1.5 rounded-full bg-brand-orange" /> Your next journey</span>
        <h2 className="mt-3 max-w-sm text-[32px] font-semibold leading-[1.15] tracking-tight text-neutral-900">A familiar place.<br />A world to explore.</h2>
        <p className="mt-3 max-w-sm text-sm leading-5 text-neutral-600">From a quick trip home to somewhere new, your journey starts here.</p>
      </div>

      <AuthJourneyMotion />

      <ul className="relative space-y-3 border-t border-orange-200/60 pt-4">
        {perks.map(({ icon: Icon, title, text }) => <li key={title} className="flex items-start gap-3"><Icon className="mt-0.5 h-5 w-5 shrink-0 text-brand-orange-dark" strokeWidth={1.5} aria-hidden /><div><p className="text-sm font-semibold text-neutral-800">{title}</p><p className="mt-0.5 text-xs leading-4 text-neutral-600">{text}</p></div></li>)}
      </ul>
    </aside>
  );
}
