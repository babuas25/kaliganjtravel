# Kaliganj Travels rebranding

Completed locally and in the new Supabase company settings on 11 September 2026. The application has not been deployed by this change.

## Reference and identity

Source: https://kaliganjtravel.com/ (visually inspected with its rendered styles and contact section).

- App display name: **Kaliganj Travels**, retaining the owner's previously confirmed spelling.
- Reference logo: https://kaliganjtravel.com/wp-content/uploads/2024/01/Kaliganj-1-1024x625.png — saved unchanged to `public/brand/kaliganj-logo.png`.
- Primary accent: `#f68712`; lighter orange: `#ffa240`; deep blue: `#042551`; white surfaces; Inter typography. Darker orange is used where small text needs more contrast.
- Phone / WhatsApp: **+880 1795-271171**.
- Public and supplier booking email: **support@kaliganjtravel.com**.
- Address: **1st Floor, Janata Super Market, Kaligonj, Jhenaidah, Bangladesh**.
- Facebook: https://www.facebook.com/KaligonjTourTravel.
- No licence number was found on the reference site. The app renders `--` where needed; the database licence remains NULL.

The public email does not replace the separately nominated owner login (`kaliganjtravels@gmail.com`) or configure SMTP, hidden BCC, administrative SMS recipients or payment accounts. No bank/payment account information was imported from the reference site.

## Changes

- Shared palette, CSS semantic tokens, Clerk appearance, homepage, responsive header, login, dashboard/sidebar, search controls and wallet/ticket-management labels use the new brand.
- Company identity, public contacts, SEO titles, footer/help content, notifications, email Message-ID domains, booking headers and PDF/Excel report identity are updated.
- Site logo falls back to the bundled reference logo; appearance uploads still take precedence. Email uses a CID attachment, and ticket PDF generation reads the bundled logo locally. Serverless tracing includes the logo and email icons.
- Email/PDF icons use the existing Lucide family, rendered in orange by `scripts/generate-brand-email-icons.mjs`.
- Supplier booking contact uses the customer's submitted email, phone, and calling code. Bangladesh phone numbers omit the national trunk zero after `+880`.
- Session storage, backup/remediation format names and package identity now use the new brand. Both producers and consumers were changed together. No previous company's browser data or backup was imported.
- Removed unsupported marketing claims inherited from the template (traveller totals, fare matching and office hours).
- Removed 15 inactive legacy configuration/commented credential lines from `.env.local`; active service credentials were left intact.
- Customer-facing runtime source contains no previous company name, contact, address or licence. Immutable historical migration sources and historical audit notes remain development references; they are not rendered or used as the new project's migration chain.

Business logic, role gates, routes, pricing calculations, wallet/accounting rules, supplier integrations and booking/ticket-management workflows remain in place. Technical booking/agency reference formats remain unchanged for validation compatibility.

## Database

Applied only `supabase/fresh-install/supabase/migrations/20260911010000_kaliganj_company_contact.sql` to new project `ljzoizsogbirlvlsrwzi`, after checking the linked target and dry run. It updates only phone, email and address in `company_settings`. The baseline SHA-256 still matches `installation.json`.

The new settings populate future immutable notification snapshots. Existing snapshots are not rewritten. Booking/ticketing gates remain disabled and no real booking, payment, email or SMS was made.

Hosted verification at 2026-09-11T08:53:42Z: 82 tables, 303 public functions, RLS on every table, eight REST checks and the read-only lifecycle RPC passed. All business-data tables remain empty. The security verification script created one `system:verification` security audit event and one temporary rate-limit bucket; those are reported and retained, not erased to make the initial-empty assertion pass. Use `npm run verify:hosted-database -- --post-setup` for this documented state; the default strict initial-empty check intentionally rejects these operational records.

## Verification

Passed:

- `npm run lint` and `npm run build` (including TypeScript validation).
- `npm run verify:kaliganj-branding`: 489 runtime files, consistent palette/contact, matching CID attachments and unchanged baseline checksum.
- `npm run verify:fresh-database`: baseline plus exact forward migration, RLS, new contact snapshots and immutable historical snapshots in disposable PGlite.
- `verify:booking-email`, `verify:booking-notification-hidden-bcc`, `verify:admin-agency-logo`, `verify:booking-confirmation-share`, `verify:wallet`, `verify:impexp-trip-scope`, and `scripts/verify-ticket-management-ui.mjs`.
- `verify:security-hardening` against the new database, including anonymous denial, rate limiting and locking.
- Desktop homepage/login and 390px mobile homepage visual inspection; round-trip selection and mobile navigation interaction; email HTML and ticket PDF render inspection.

Limits:

- The existing `verify:canonical-pricing-regression` requires `git show HEAD:lib/markup.ts`; it cannot run because Git history was previously removed. `lib/markup.ts` was not edited by rebranding.
- The protected dashboard correctly redirects unauthenticated requests to login. Full role-by-role authenticated workflows and supplier transactions were not exercised. No owner password/account or role was created.
- SMTP/SMS delivery, new marketing media uploads and deployment remain separate setup work.


## Email design refresh — September 12, 2026

Notification templates now use a charcoal masthead, orange actions, warm neutral backgrounds and revised account, invitation, deposit and ticket-request copy. Flight offer emails use the same orange accent. The ticket page itself is unchanged: booking and issued emails and the attached ticket PDF follow its white masthead, orange rule, square reference panel, light summary/table surfaces and warm fare total. Issued email passenger columns now include gender and date of birth alongside ticket numbers, matching the ticket page/PDF. Email HTML and PDF remain separate renderers, so browser/email-client typography can differ; these are not browser-print exports of the ticket page.

Run `node scripts/preview-kaliganj-emails.mjs` for notification previews and `node scripts/verify-booking-email-template.mjs --output=output/email-preview/booking.html --pdf-output=output/pdf/kaliganj-ticket-preview.pdf` for held/issued email and PDF samples. `node scripts/verify-itinerary-offer-email.mjs` produces the flight-offer sample. Open `output/email-preview/index.html` after all three commands. Samples use fixture data and never send email.

Validation: TypeScript, all booking status rendering checks, immutable snapshot rendering, identity audit, HTML escaping, desktop/mobile preview rendering and ticket PDF visual inspection. These checks do not validate delivery in Gmail/Outlook or publish changes. Clerk authentication email bodies remain supplied by Clerk; that external template configuration has not been changed by this refresh.
