import 'server-only';

import { createHash } from 'crypto';

/** A bounded pseudonymous key for a public request's edge-reported address. */
export function requestActorKey(
  request: Request,
  authenticatedUserId?: string | null
): string {
  if (authenticatedUserId) return `user:${authenticatedUserId}`;

  const forwarded = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim();
  const address = forwarded || request.headers.get('x-real-ip')?.trim() || 'unknown';
  const digest = createHash('sha256').update(address.slice(0, 256), 'utf8').digest('hex');
  return `ip-sha256:${digest}`;
}
