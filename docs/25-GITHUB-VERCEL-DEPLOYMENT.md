# GitHub and Vercel deployment

Repository: https://github.com/babuas25/kaliganjtravel

## Validation

Use Node.js 24 and run:

```sh
npm ci
npm audit
npm run lint
npm run typecheck
npm run verify:promotion-upload
npm run verify:next-eslint-root-dirs
npm run verify:tailwind-compatibility
npm run verify:ci
npm run build
```

The regression suite uses synthetic fixtures and disposable PGlite databases.
The installed baseline is checked against installation.json, never regenerated.
Live supplier/database tests are deliberately separate from CI.

## Local pre-upload checks (2026-09-12)

The pre-upload audit found four vulnerable dependency packages. Updated Next.js and
its matching tools to 16.3.5, Sharp to 0.35.4, Nodemailer within version 9, and the
transitive selector parser; the updated lockfile reports zero npm vulnerabilities.
Removed a supplier password from API examples and replaced token examples with
explicit placeholders. Environment files, build output and local review artifacts
are excluded from Git. Secret scanning left only the deliberately synthetic CI
Clerk key and an execution-key string in an isolated database test.

The branding check now reflects the existing neutral ink palette. The database
check verifies the frozen baseline checksum against its installation receipt;
it does not overwrite the baseline or connect to Supabase.

## Dependency security remediation (2026-10-08)

The dependency audit was reduced from 24 findings to zero, including after a
clean `npm ci --ignore-scripts`. Next.js and its matching lint/SWC packages are
16.3.6, Sharp is 0.35.5, Nodemailer is 10.0.16, brace-expansion is 5.0.12, and
source-map-js is 1.2.2. Sharp overrides reference the direct dependency, avoiding
separate stale pins. Nodemailer now supplies its own TypeScript declarations.

Tailwind CSS and its PostCSS plugin are 4.3.3, with tailwind-merge 3.7.0. The
migration preserves the existing theme colors and control defaults, changes
hidden-outline and gradient utilities to their v4 equivalents, and retains
sRGB gradient interpolation. All 1,837 actual baseline classes were accounted
for. Nineteen isolated browser samples matched the previous CSS in normal and
forced-color modes. The browser minimums are Safari 16.4, Chrome 111, and Firefox
128, following the [Tailwind upgrade guide](https://tailwindcss.com/docs/upgrade-guide).

The official Next.js lint plugin still depends on an unpatched `braces` chain.
A scoped override replaces only its `fast-glob` dependency with the private
`vendor/next-eslint-glob` adapter, using patched brace-expansion and released
tinyglobby/picomatch packages. All upstream lint rules remain installed. The
adapter's 33 directory cases, bounded-pattern checks, and actual internal-link
lint rule are verified. Review this narrow Node 24/POSIX adapter when updating
the Next plugin, and remove it once the upstream dependency is fixed.

Promotion-image uploads verify raster signatures and declared MIME before
calling Sharp. Local tests cover valid JPEG/PNG/WebP processing and SVG rejection
before decoding, plus authorization, size/rate limits, and audit/storage ordering.

GitHub Actions now fails its quality job on any npm audit finding and runs the
three new verification commands above. Lint, typecheck, the existing CI/pricing
regression checks, local email and Excel export checks, and production build
passed. Build verification uses a synthetic Clerk key with real service
configuration disabled. The audit gate controls the Actions deployment job;
native Vercel Git deployments remain independent as described below.

## Next.js security patch (2026-10-11)

The release audit found newly published Next.js advisories affecting 16.3.6.
Updated Next.js, its lint plugin and the WASM compiler to the patched 16.3.8
release. React/Node compatibility and the scoped lint glob override remain
unchanged. The release checks include a fresh dependency audit, lint,
TypeScript, the complete CI regression suite and an optimized production build.

## New Vercel project

1. Sign in at https://vercel.com/new and import `babuas25/kaliganjtravel` as a new
   project named `kaliganjtravel` (or an available name). Select Next.js, repository
   root, Node.js 24, and `npm ci` as the install command.
2. Configure the application's environment variables in the new project's Vercel
   settings. Use `.env.example` and the actual service configuration as the inventory;
   keep secrets out of Git. Set `NEXT_PUBLIC_APP_URL` to the new HTTPS deployment URL.
   Configure Clerk allowed origins/redirects for that URL and its webhook separately.
3. The initial import creates the new deployment URL. Confirm login, dashboard,
   database reads and PDF generation before considering operational launch complete.
The user will perform the Vercel import. Native Vercel Git integration can handle
automatic deployments without enabling the optional GitHub deployment job. Native
Git deployments run independently of the Actions checks.

4. For deployments gated by GitHub CI, create a Vercel token and store it as the
   GitHub Actions secret `VERCEL_TOKEN`. Store `VERCEL_ORG_ID` and
   `VERCEL_PROJECT_ID` as GitHub Actions variables for this new project.
   These IDs are available in Vercel project/team settings or `.vercel/project.json`
   after linking with Vercel CLI. Never commit `.vercel` files.
5. Disable duplicate native Vercel Git deployments when using the Actions deployment
   job, then set the GitHub Actions variable `VERCEL_DEPLOY_ENABLED` to `true`.
   Run the CI workflow manually on main for the first gated deployment.

The deployment job runs only on main after all checks pass. It pulls production
configuration, builds with Vercel CLI, and deploys the prebuilt output. Pull requests
never receive Vercel credentials. The GitHub `production` environment may be configured
with required reviewers if manual release approval is desired.

No domain, database migrations, cron schedules, webhooks or live booking operations
are modified by this workflow. Use only `supabase/fresh-install` for future database
migration work; never push the historical root migrations.

Reference: https://vercel.com/kb/guide/how-can-i-use-github-actions-with-vercel
