import {
  MessageCircle,
  ShieldCheck,
  Tag,
  UsersRound,
  type LucideIcon,
} from 'lucide-react';

type TrustItem = {
  title: string;
  description: string;
  icon: LucideIcon;
};

const trustItems: TrustItem[] = [
  {
    title: 'Specialist Support',
    description: 'Kaliganj Travels experts help with every request.',
    icon: ShieldCheck,
  },
  {
    title: 'Best Fare Research',
    description: 'We compare leading airlines before you book.',
    icon: Tag,
  },
  {
    title: 'WhatsApp support',
    description: 'Reach us anytime for fast booking support.',
    icon: MessageCircle,
  },
  {
    title: '100K+ Travellers',
    description: 'Trusted by travellers across Bangladesh.',
    icon: UsersRound,
  },
];

export default function FlightSearchTrustStrip() {
  return (
    <section aria-label="Why book with Kaliganj Travels">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {trustItems.map(({ title, description, icon: Icon }) => (
          <article
            key={title}
            className="flex min-h-24 items-center gap-4 rounded-2xl border border-navy-100 bg-white px-4 py-4 shadow-sm transition duration-200 hover:-translate-y-0.5 hover:border-navy-200 hover:shadow-md"
          >
            <span className="grid h-12 w-12 shrink-0 place-items-center rounded-xl bg-brand-orange-light text-brand-orange ring-1 ring-brand-orange/10">
              <Icon aria-hidden="true" className="h-6 w-6" strokeWidth={2} />
            </span>
            <span className="min-w-0">
              <h2 className="text-sm font-bold text-navy-950">{title}</h2>
              <p className="mt-1 text-xs leading-5 text-neutral-600">
                {description}
              </p>
            </span>
          </article>
        ))}
      </div>
    </section>
  );
}
