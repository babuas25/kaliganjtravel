import 'server-only';

/** Validated canonical origin for links sent outside the current request. */
export function canonicalAppOrigin(): string | null {
  const configured =
    process.env.APP_URL ||
    process.env.NEXT_PUBLIC_APP_URL ||
    (process.env.VERCEL_PROJECT_PRODUCTION_URL
      ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`
      : null);
  const candidate =
    configured ??
    (process.env.NODE_ENV === 'production' ? null : 'http://localhost:3000');
  if (!candidate) return null;

  try {
    const url = new URL(candidate);
    const localHttp =
      process.env.NODE_ENV !== 'production' &&
      url.protocol === 'http:' &&
      (url.hostname === 'localhost' || url.hostname === '127.0.0.1');
    if (url.protocol !== 'https:' && !localHttp) return null;
    if (url.username || url.password) return null;
    return url.origin;
  } catch {
    return null;
  }
}

export function invitationRedirectUrl(): string | undefined {
  const origin = canonicalAppOrigin();
  return origin ? `${origin}/sign-up` : undefined;
}
