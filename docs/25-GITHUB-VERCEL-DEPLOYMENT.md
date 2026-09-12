# GitHub and Vercel deployment

Repository: https://github.com/babuas25/kaliganjtravel

## Validation

Use Node.js 24 and run:

```sh
npm ci
npm run lint
npm run typecheck
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
