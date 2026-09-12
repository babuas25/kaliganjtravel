import { FOLDERS, publicUrl } from '@/lib/cloudinary';

/**
 * Artwork on the public marketing pages — the home hero and the promo carousel.
 *
 * **Server-only** (it reaches `lib/cloudinary.ts`). The carousel is a client
 * component, so the page resolves these and passes the URLs down as props
 * rather than the browser building them. That is the whole reason no
 * `NEXT_PUBLIC_CLOUDINARY_CLOUD_NAME` is needed anywhere in this application.
 *
 * These were hardcoded `images.pexels.com` URLs, which the site's own
 * `img-src` never allowed — they had been silently blocked. Moving them here
 * fixes that and removes a third-party host from the critical path of the
 * landing page.
 */

export const MARKETING_KEYS = [
  'hero',
  'promoMaldives',
  'promoTokyo',
  'promoPatagonia',
] as const;

export type MarketingKey = (typeof MARKETING_KEYS)[number];

/**
 * `source` is kept deliberately: it records where each image came from, and it
 * is what `scripts/seed-marketing.mjs` re-uploads from. Without it, replacing a
 * lost asset would mean hunting for the original.
 */
export const MARKETING_IMAGES: Record<
  MarketingKey,
  { publicId: string; source: string }
> = {
  hero: {
    publicId: `${FOLDERS.marketing}/hero`,
    source:
      'https://images.pexels.com/photos/3769138/pexels-photo-3769138.jpeg?auto=compress&cs=tinysrgb&w=1600',
  },
  promoMaldives: {
    publicId: `${FOLDERS.marketing}/promo-maldives`,
    source:
      'https://images.pexels.com/photos/1287460/pexels-photo-1287460.jpeg?auto=compress&cs=tinysrgb&w=1200',
  },
  promoTokyo: {
    publicId: `${FOLDERS.marketing}/promo-tokyo`,
    source:
      'https://images.pexels.com/photos/2506923/pexels-photo-2506923.jpeg?auto=compress&cs=tinysrgb&w=1200',
  },
  promoPatagonia: {
    publicId: `${FOLDERS.marketing}/promo-patagonia`,
    source:
      'https://images.pexels.com/photos/235621/pexels-photo-235621.jpeg?auto=compress&cs=tinysrgb&w=1200',
  },
};

export type MarketingUrls = Partial<Record<MarketingKey, string>>;

/**
 * Delivery URLs for every marketing image, or an empty map when Cloudinary is
 * unconfigured.
 *
 * **No network call and no existence check.** These are decorative images with
 * a navy overlay on top of them, so a missing one costs a photograph and
 * nothing else — asking Cloudinary to confirm four assets on every render of
 * the landing page would be a poor trade for that. Both call sites already
 * render without an image, because they had to: they were being blocked.
 */
export function marketingUrls(): MarketingUrls {
  const urls: MarketingUrls = {};

  for (const key of MARKETING_KEYS) {
    const url = publicUrl(MARKETING_IMAGES[key].publicId);
    if (url) urls[key] = url;
  }

  return urls;
}
