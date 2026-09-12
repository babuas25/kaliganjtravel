/**
 * Response headers applied to every route.
 *
 * Content-Security-Policy is deliberately absent here: Clerk generates its own
 * (it knows its Frontend API host, and a strict policy needs a per-request
 * nonce), so it belongs in `proxy.ts` rather than in a static list.
 *
 * Cross-Origin-Opener-Policy is also left off on purpose — Clerk's social
 * sign-in opens a popup that talks back through `window.opener`, and
 * `same-origin` would sever that.
 */
const securityHeaders = [
  // Force HTTPS for two years. No `preload`: joining the browser preload list
  // is effectively irreversible, so that stays an explicit decision.
  // `includeSubDomains` assumes every subdomain is HTTPS — the one line to
  // revisit if a plain-HTTP subdomain is ever added.
  {
    key: 'Strict-Transport-Security',
    value: 'max-age=63072000; includeSubDomains',
  },
  // Nothing here is meant to be embedded, and /dashboard/users can grant roles
  // and delete accounts — exactly the clicks a framing attack wants to steal.
  { key: 'X-Frame-Options', value: 'DENY' },
  // Trust the declared Content-Type; never let the browser sniff past it.
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  // Full URL to our own origin, bare origin to third parties. Dashboard paths
  // carry user ids and search terms that have no business leaving the site.
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  // The app calls none of these APIs, so deny them outright rather than leave
  // them available to injected script.
  {
    key: 'Permissions-Policy',
    value:
      'accelerometer=(), autoplay=(), camera=(), display-capture=(), encrypted-media=(), fullscreen=(self), geolocation=(), gyroscope=(), magnetometer=(), microphone=(), midi=(), payment=(), usb=(), xr-spatial-tracking=()',
  },
];

const playwrightRuntimeAssets = [
  './node_modules/playwright-core/browsers.json',
];

/** @type {import('next').NextConfig} */
const nextConfig = {
  // Keep framework-generated agent instruction files out of the application
  // workspace; project instructions are maintained outside Next's dev server.
  agentRules: false,
  images: { unoptimized: true },
  experimental: {
    // Server Actions default to 1 MB. Allow multipart overhead above the
    // flight-search background's stricter, application-enforced 2 MB limit.
    serverActions: { bodySizeLimit: '3mb' },
  },
  // PDFKit and ExcelJS read package-relative runtime files. Bundling rewrites
  // those paths (and eagerly resolves ExcelJS's optional ZIP adapters), so keep
  // both Node packages external for server-side report generation.
  // Keep the lightweight serverless Chromium loader external so its relative
  // runtime helpers remain intact. The browser pack itself is downloaded to
  // /tmp and is intentionally not included in the Vercel function bundle.
  serverExternalPackages: [
    'pdfkit',
    'exceljs',
    '@sparticuz/chromium-min',
    'playwright-core',
  ],
  // Playwright reads browsers.json through a package-relative filesystem lookup
  // even when an explicit Chromium executable is supplied. Next's automatic
  // tracer misses this small runtime file, so include it only in browser-backed
  // IMP/EXP functions instead of expanding every serverless function bundle.
  outputFileTracingIncludes: {
    '/api/**': ['./public/brand/kaliganj-logo.png', './public/email-icons/*.png'],
    '/api/impexp/preview-booking': playwrightRuntimeAssets,
    '/api/impexp/import-booking': playwrightRuntimeAssets,
    '/api/impexp/sync-booking': playwrightRuntimeAssets,
  },
  // Next advertises itself in an X-Powered-By header by default. It tells an
  // attacker which framework — and so which advisories — to try first, and
  // tells a legitimate visitor nothing.
  poweredByHeader: false,
  async headers() {
    return [{ source: '/:path*', headers: securityHeaders }];
  },
};

module.exports = nextConfig;
