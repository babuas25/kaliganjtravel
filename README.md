# Kaliganj Travels

Flight booking and agency management application, rebranded using the logo, orange/neutral-ink style and public contacts at [kaliganjtravel.com](https://kaliganjtravel.com/).

Existing booking, supplier, wallet, ticket management, agency and staff workflows are retained.

Booking prices, fixed markups and wallet accounts support BDT only. Search,
RePrice and supplier imports reject explicitly reported foreign currencies,
including conflicting currency aliases or passenger fares. Omitted supplier
currency retains the existing BDT contract; manual imports and stored checkout
quotes require BDT. Currency conversion is not supported. Regression coverage
runs with `npm run verify:booking-currency` and the Search/import checks in CI.

## Local development

```bash
npm ci
npm run dev
```

Configure this company's service credentials in `.env.local`. Public contacts are in `lib/site.ts`; the shared palette is in `lib/colors.ts`, `tailwind.config.ts` and `app/globals.css`. `.env.example` includes SMTP, Cloudinary, supplier and messaging placeholders. It is not a complete production secret inventory.

```bash
npm run lint
npm run build
npm run verify:kaliganj-branding
npm run verify:fresh-database
```

## Database and release

The new project's migration workdir is **`supabase/fresh-install`**. Do not push the root historical migrations. The installed baseline is frozen; changes must be forward migrations. Read `supabase/fresh-install/README.md` before database work.

Current implementation and verification: [Rebranding notes](docs/24-KALIGANJ-REBRANDING.md).

The public support address, owner login and SMTP/BCC recipients are separate settings. Live booking/ticketing and notification service activation still require the operational setup checks.

## GitHub Actions and deployment

Use Node.js 24 (`nvm use`). The `CI` workflow runs on pushes and pull requests to
`main`, and can be started manually. It installs from the lockfile, runs lint,
TypeScript checks and `npm run verify:ci`, then builds with a synthetic Clerk
publishable key. No live service credentials are needed for CI.

Production deployment is prepared for a **new** Vercel project. Setup and required
GitHub configuration are in [Deployment setup](docs/25-GITHUB-VERCEL-DEPLOYMENT.md).
Deployment stays disabled until that project and its credentials are configured.
