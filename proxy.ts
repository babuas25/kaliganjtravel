import { clerkMiddleware, createRouteMatcher } from '@clerk/nextjs/server';

/**
 * Searching is public; booking is not.
 *
 * Everything up to and including the fare panels stays open to anyone, so a
 * visitor can price a trip without an account. The traveller form is where a
 * booking starts belonging to someone, so that is where identity begins.
 *
 * The booking API routes are deliberately absent: `protect()` answers an API
 * route with a bare 404, which the checkout form cannot tell apart from a real
 * failure. They check the session themselves and return the usual JSON error.
 */
const isProtectedRoute = createRouteMatcher([
  '/dashboard(.*)',
  '/flights/booking/resume(.*)',
  '/flights/checkout(.*)',
]);

/**
 * Where the strict, nonce-based script policy applies.
 *
 * These routes are server-rendered on demand already, so a per-request nonce
 * costs nothing. The public marketing pages are prerendered at build time —
 * their script tags carry no nonce, and `strict-dynamic` ignores `'self'`, so
 * a strict policy there would block every script and stop the page hydrating.
 */
const isStrictCspRoute = createRouteMatcher([
  '/dashboard(.*)',
  '/flights/booking/resume(.*)',
  '/flights/checkout(.*)',
  '/sign-in(.*)',
  '/sign-up(.*)',
]);

/**
 * Directives layered on top of Clerk's defaults, which cover its own hosts but
 * leave these unset.
 */
function directives() {
  return {
    // Clerk defaults to 'self' + img.clerk.com for avatars. Everything this
    // application stores — the site logo, marketing artwork, business documents
    // — is delivered by Cloudinary, and the uploaders preview the chosen file
    // from an object URL before it goes anywhere. Flight-result airline logos
    // use Kiwi's fixed, code-addressed asset host, and the checkout country
    // pickers use jsDelivr's — both are code-addressed static SVG hosts that
    // receive no request data beyond the country or airline code itself.
    //
    // `res.cloudinary.com` is a fixed host rather than an env var: unlike the
    // Supabase project URL it replaced, it is the same for every account, so
    // deriving it from configuration would only add a way for it to be absent.
    'img-src': [
      'self',
      'https://img.clerk.com',
      'https://res.cloudinary.com',
      'https://images.kiwi.com',
      'https://cdn.jsdelivr.net',
      'blob:',
      'data:',
    ],
    // Nothing here is meant to be embedded. Mirrors the X-Frame-Options header
    // in next.config.js for browsers that prefer CSP.
    'frame-ancestors': ['none'],
    // Stop an injected <base> tag from re-pointing every relative script URL.
    'base-uri': ['none'],
    // No plugins, ever.
    'object-src': ['none'],
  };
}

// Runs Clerk on every matched request so auth state is available everywhere,
// and bounces signed-out visitors from protected pages to /sign-in.
export default clerkMiddleware(
  async (auth, req) => {
    if (isProtectedRoute(req)) await auth.protect();
  },
  (req) => ({
    // Without this, protect() sends people to Clerk's hosted portal instead of
    // the branded sign-in page in app/(auth)/.
    signInUrl: '/sign-in',
    contentSecurityPolicy: {
      strict: isStrictCspRoute(req),
      directives: directives(),
    },
  })
);

export const config = {
  matcher: [
    // Skip Next.js internals and static files. Public routes still pass through
    // Clerk without `protect()` so optional identity (for agency pricing) is
    // available while signed-out visitors remain allowed.
    '/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)',
    // Always run for API and tRPC routes, including the public flight search.
    '/(api|trpc)(.*)',
  ],
};
