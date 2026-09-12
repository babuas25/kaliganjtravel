import { Mail, Phone } from 'lucide-react';

import { SITE_EMAIL, SITE_PHONE, SITE_PHONE_HREF } from '@/lib/site';

/**
 * The slim strip above the sign-in card. Someone who cannot get into their
 * account needs a way to reach a human, and that should not be a scroll away.
 */
export default function AuthContactBar() {
  return (
    <div className="border-b border-brand-orange/20 bg-brand-orange">
      <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-center gap-x-8 gap-y-1 px-4 py-2.5 text-sm text-navy-950 sm:px-6 lg:px-8">
        <a
          href={SITE_PHONE_HREF}
          className="inline-flex items-center gap-2 transition-colors hover:text-navy-800"
        >
          <Phone className="h-4 w-4 text-navy-950" />
          {SITE_PHONE}
        </a>
        <a
          href={`mailto:${SITE_EMAIL}`}
          className="inline-flex items-center gap-2 transition-colors hover:text-navy-800"
        >
          <Mail className="h-4 w-4 text-navy-950" />
          {SITE_EMAIL}
        </a>
      </div>
    </div>
  );
}
