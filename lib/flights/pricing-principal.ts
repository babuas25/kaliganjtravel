import 'server-only';

import type { DashboardSession } from '@/lib/dashboard/session';
import {
  pricingAudienceForRole,
  type PricingAudience,
} from '@/lib/markup';

/** The authenticated commercial identity a live price belongs to. */
export type PricingPrincipal = {
  userId: string | null;
  audience: PricingAudience['kind'];
  agencyCode: string | null;
};

export function pricingPrincipalForSession(
  session: DashboardSession | null
): PricingPrincipal {
  const audience = pricingAudienceForRole(
    session?.role ?? null,
    session?.agencyCode ?? null
  );

  return {
    userId: session?.clerkId ?? null,
    audience: audience.kind,
    agencyCode: audience.kind === 'agency' ? audience.agencyCode : null,
  };
}

export function pricingAudienceForPrincipal(
  principal: PricingPrincipal
): PricingAudience {
  return principal.audience === 'agency' && principal.agencyCode
    ? { kind: 'agency', agencyCode: principal.agencyCode }
    : principal.audience === 'superadmin'
      ? { kind: 'superadmin' }
      : { kind: 'b2c' };
}

export function samePricingPrincipal(
  left: PricingPrincipal,
  right: PricingPrincipal
): boolean {
  return (
    left.userId === right.userId &&
    left.audience === right.audience &&
    left.agencyCode === right.agencyCode
  );
}
