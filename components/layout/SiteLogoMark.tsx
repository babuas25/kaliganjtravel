import { SITE_LOGO_PATH, SITE_NAME } from '@/lib/site';
import { cn } from '@/lib/utils';
import type { SiteLogo } from '@/lib/appearance';

interface Props {
  logo: SiteLogo | null;
  /** Box classes — size and corner radius. Applied to image and fallback alike. */
  className?: string;
  /** Shown when no logo is uploaded: the site's built-in mark. */
  children: React.ReactNode;
}

/**
 * The site logo wherever it appears, with each call site keeping its own box
 * size and radius. No hooks, so client components can render it too.
 *
 * A plain <img> rather than next/image: the host comes from an env var, so it
 * cannot be listed in `images.remotePatterns`, and images are unoptimized in
 * this project anyway.
 */
export default function SiteLogoMark({ logo, className }: Props) {

  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={logo?.url ?? SITE_LOGO_PATH}
      alt={SITE_NAME}
      className={cn('shrink-0 bg-white object-contain p-1', className)}
    />
  );
}
