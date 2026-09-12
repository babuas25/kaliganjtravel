import { cache } from 'react';
import { SITE_LOGO_PATH } from '@/lib/site';
import { unstable_cache } from 'next/cache';

import { findAsset, FOLDERS } from '@/lib/cloudinary';

/**
 * Site branding that a superadmin controls from Dashboard → Appearance.
 *
 * **Server-only** — it reaches Cloudinary. The type below is safe to import
 * from a client component with `import type`, which is what the header, the
 * sidebar and the logo mark all do; the upload limits live in
 * `lib/upload-verify.ts`.
 *
 * There is still no settings table, and there does not need to be: the logo has
 * a **fixed public id**, so "is there a logo?" is a lookup rather than a listing
 * and a replacement overwrites in place. Cloudinary bumps the version on every
 * overwrite and the delivery URL carries it, so nobody is ever served a stale
 * mark — the thing the old timestamped-filename scheme existed to solve.
 */

/** The one object. Fixed, because there is only ever one site logo. */
export const LOGO_PUBLIC_ID = `${FOLDERS.site}/logo`;
export const SITE_LOGO_CACHE_TAG = 'site-logo';

export type SiteLogo = {
  /** Delivery URL, versioned — never served stale. */
  url: string;
  /** For the Appearance page's "current file" line. */
  filename: string;
  /** ISO timestamp, or null when Cloudinary reports none. */
  updatedAt: string | null;
};

/**
 * The current site logo, or null when none is set or Cloudinary is
 * unconfigured.
 *
 * The Cloudinary result is retained for one hour across requests, while
 * React's `cache` deduplicates callers within one render. Upload and removal
 * actions invalidate the shared entry immediately. Failures resolve to null rather
 * than throwing — a broken account should cost the site its logo, not its home
 * page.
 */
const readSiteLogoAsset = unstable_cache(
  () => findAsset(LOGO_PUBLIC_ID),
  ['kaliganj-site-logo-asset'],
  { revalidate: 60 * 60, tags: [SITE_LOGO_CACHE_TAG] }
);

export const getSiteLogo = cache(async (): Promise<SiteLogo | null> => {
  const asset = await readSiteLogoAsset();
  if (!asset) return { url: SITE_LOGO_PATH, filename: 'kaliganj-logo.png', updatedAt: null };

  return {
    url: asset.url,
    filename: `logo.${asset.format}`,
    updatedAt: asset.createdAt,
  };
});
