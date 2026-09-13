# Project Map — Shapon Travels International

A flight-booking site built with **Next.js (App Router)**, **TypeScript**, **Tailwind CSS**, and **shadcn/ui**, with **Clerk** authentication, **Supabase** Postgres for data, **Cloudinary** for files and **Triplover** for live flight inventory. CI runs on **GitHub Actions**; deploys on **Vercel** (auto-deploy from GitHub).

## Folder & File Structure

```
shopontravels/
├── .github/
│   └── workflows/
│       └── ci.yml                # GitHub Actions: lint → typecheck → build (push / PR to main)
│
├── .claude/
│   └── launch.json               # Dev-server config for preview tooling (npm run dev, port 3000)
│
├── app/                          # Next.js App Router
│   ├── (auth)/                   # Auth route group (Clerk)
│   │   ├── layout.tsx            # Branded split-screen auth layout + "Back to home" (responsive)
│   │   ├── sign-in/[[...sign-in]]/page.tsx   # Clerk <SignIn /> page
│   │   └── sign-up/[[...sign-up]]/page.tsx   # Clerk <SignUp /> page
│   ├── (dashboard)/              # Signed-in account area (protected by proxy.ts)
│   │   ├── layout.tsx            # Resolves role server-side, renders the shared shell
│   │   ├── actions.ts            # Server action for the dev-only role switcher
│   │   └── dashboard/
│   │       ├── page.tsx          # Home: welcome banner, role-filtered summary tiles, activity
│   │       ├── flight-search/page.tsx  # The search panel inside the account area (all roles)
│   │       ├── profile/          # Profile form (all roles) + restyled Clerk <UserProfile />
│   │       │   ├── page.tsx      # Loads the saved profile, seeds first visit from Clerk
│   │       │   ├── actions.ts    # saveProfileAction — writes the signed-in user's own row
│   │       │   └── staff-actions.ts # Staff records — the one place a *target* id is
│   │       │                     # accepted, so it has its own ownership check
│   │       ├── appearance/       # Site branding — superadmin only
│   │       │   ├── page.tsx      # Logo upload section
│   │       │   └── actions.ts    # Server actions: upload / remove the logo (role-checked)
│   │       ├── markup/           # Fare pricing rules — superadmin only
│   │       │   ├── page.tsx      # Loads rules/agencies and renders the manager
│   │       │   └── actions.ts    # Create/edit/toggle/delete; role-checked + rate-limited
│   │       ├── users/            # Users & Roles — superadmin + admin only
│   │       │   ├── page.tsx      # Roster from Clerk: search, paging, pending invites
│   │       │   └── actions.ts    # setUserRole / deleteUserAccount / inviteUser / revokeInvite
│   │       ├── agency-users/     # Sub Users — a B2B partner's own staff, that agency only
│   │       │   ├── page.tsx      # Roster from the DB, state from Clerk; pending invites
│   │       │   └── actions.ts    # inviteSubUser / revokeSubUserInvite / setSubUserAccess
│   │       │                     # / renameSubUser / removeSubUser
│   │       ├── upgrade/          # "Upgrade to Business" — customers only, not a nav item
│   │       │   ├── page.tsx      # The application form, or its status once submitted
│   │       │   └── actions.ts    # submitUpgradeRequestAction — own id from the session
│   │       └── [section]/page.tsx # "Coming soon" placeholder for unbuilt nav sections
│   ├── api/
│   │   ├── airports/route.ts     # GET /api/airports?q=&limit= — public airport search (no auth)
│   │   └── flights/
│   │       ├── search/route.ts   # POST — public Triplover search; derives the pricing audience
│   │       │                     # from the session, applies server-side markup, validates with
│   │       │                     # zod and is rate-limited by address
│   │       ├── fare-rules/route.ts # POST — resolves private Search refs and returns the selected
│   │       │                       # fare's supplier-authored policy sections
│   │       ├── reprice/route.ts  # POST — verifies a server-held fare selection and returns
│   │       │                     # only the current role's recalculated selling price, plus
│   │       │                     # the cabin/booking class the airline actually quoted
│   │       └── booking/          # Prepare/read/submit booking drafts. Prepare accepts
│   │                             # instant-purchase fares and flags them; submit still sends
│   │                             # holds only
│   ├── flights/
│   │   ├── page.tsx              # Results shell: resolves airport labels, renders the inline
│   │   │                         # modifier and hands the URL input to the client-side results
│   │   └── booking/resume/page.tsx # Protected post-sign-in handoff from a verified fare to checkout
│   ├── globals.css               # Global styles, CSS variables, custom keyframes (ticker, fade-up)
│   ├── layout.tsx                # Root layout: <ClerkProvider>, metadata (SEO + favicon), fonts
│   └── page.tsx                  # Home page: hero + flight search, stats, offers, partners, routes
│                                 # (hero badge + heading are hidden below `sm`)
│
├── components/
│   ├── flights/                  # Search results (the panel itself lives in layout/)
│   │   ├── AirlineFilterBar.tsx  # Single-carrier post-search filter: logo, count, minimum fare,
│   │   │                         # All reset and horizontally scrolling arrow controls
│   │   ├── AirlineLogo.tsx       # Kiwi code-addressed airline logo with an in-app plane fallback
│   │   ├── FlightFilters.tsx     # Responsive results sidebar: stops, refundable, price/duration
│   │   │                         # ranges and outbound departure windows; no airline section
│   │   ├── FlightSearchModifier.tsx # Two-line compact mobile summary + full desktop summary;
│   │   │                         # expands the shared panel with active URL state pre-filled
│   │   ├── FlightResults.tsx     # Runs the search from the browser: loading with an elapsed
│   │   │                         # counter, error + retry, sorting, date/filter composition/state
│   │   ├── ItineraryCard.tsx     # Compact result card: carrier/schedule/feature metadata,
│   │                             # role-gated fare reveal, responsive no-scroll footer,
│   │                             # expandable detail panels, and Book Now — one press that
│   │                             # runs RePrice silently and opens the traveller form. Only a
│   │                             # changed fare stops it, on the price-change panel
│   │   ├── ItineraryCardDetails.tsx # Tripfeels-structured itinerary/fare/baggage/policy content;
│   │                               # full and penalty-filtered FareRules preserve GDS line breaks
│   │   ├── BookingCheckout.tsx   # The traveller page: stepper, collapsible per-passenger
│   │                             # cards, contact block, Review step, held-PNR or issued-ticket
│   │                             # result. Passport fields appear only when the itinerary
│   │                             # leaves the country. Instant-purchase drafts fill but don't send
│   │   ├── BookingResume.tsx     # After sign-in, prepares the retained verified fare and replaces
│   │                             # the handoff URL with checkout?bookingId=...
│   │   ├── CheckoutItinerary.tsx # Trip summary header, the itinerary card, and the Policy
│   │                             # tabs (baggage from the draft, the rest from FareRules)
│   │   ├── CheckoutSummary.tsx   # Right rail: offer countdown, Fare Summary — the first
│   │                             # screen that shows AIT/VAT — Service Fee and the error list
│   │   ├── ResultsDateNavigator.tsx # Previous/date-picker/next results-date control
│   │   └── ResultsSortBar.tsx    # Departure, price and layover directional sort menus
│   │
│   ├── dashboard/                # Account-area chrome (shared by every role)
│   │   ├── DashboardShell.tsx    # Client shell: collapsible desktop sidebar + mobile drawer
│   │   ├── DashboardSidebar.tsx  # Role-filtered nav (navy rail, collapses to icons)
│   │   │                         # Its logo links to Flight Search, not the home page
│   │   │                         # Foot: the yellow "Upgrade to Business" CTA (customers)
│   │   ├── DashboardTopbar.tsx   # Page title + user name, role badge, UserButton
│   │   │                         # The title block is suppressed on Flight Search
│   │   ├── SummaryCard.tsx       # One summary tile: icon, value, delta, hint
│   │   ├── DevRoleSwitcher.tsx   # Dev-only "View as <role>" preview control
│   │   ├── LogoUploader.tsx      # Appearance page: drag/drop logo upload with light+dark preview
│   │   ├── MarkupManager.tsx     # Four-step pricing-rule builder, shared preview engine + CRUD
│   │   ├── BusinessDocField.tsx  # One business document: upload on pick, view, replace, remove
│   │   ├── UsersTable.tsx        # Roster rows: role select + delete, locked rows carry the reason
│   │   │                         # Picking Sub User opens the agency picker instead of applying
│   │   │                         # Carries the "Waiting for upgrade" badge + View button
│   │   ├── UpgradeRequestForm.tsx # The customer's application: Business Info + Personal Info,
│   │   │                         # every field required, plus up to 5 optional documents
│   │   ├── UpgradeReviewDialog.tsx # Admin popup: the summary, signed document links, a note
│   │   │                         # field, Accept / Reject
│   │   ├── InvitePanel.tsx       # Invite by email with a role, and revoke pending invites
│   │   ├── AgencySelect.tsx      # Agency dropdown — admin-side only; a B2B partner never
│   │   │                         # chooses, their own agency is filled in
│   │   ├── SubUsersTable.tsx     # Sub User rows: inline rename, disable/enable, remove
│   │   ├── SubUserInvitePanel.tsx # Invite by email only — no role or agency to choose
│   │   ├── StaffPanel.tsx        # Staff tab: the agency's roster for an admin, one own
│   │   │                         # record for a sub user. Renders outside the profile form
│   │   ├── WelcomeBanner.tsx     # Dashboard hero; hides 45s after sign-in
│   │   ├── ProfileDetailsForm.tsx # Profile page: tabs + section cards (client state)
│   │   ├── ProfileHeader.tsx     # Profile banner: identity + stat strip + Save
│   │   │                         # Shows the Agency Code pill for b2b / b2b_sub
│   │   └── ProfileOverview.tsx   # Profile sidebar: key values + completion meter
│   │
│   ├── layout/                   # Page-level building blocks
│   │   ├── SiteLogoMark.tsx      # Uploaded logo, or the built-in mark as fallback
│   │   ├── AirportSelection.tsx  # From / To field: searchable airport dropdown (portal, debounced)
│   │   ├── AnnouncementBar.tsx   # Top scrolling announcement ticker
│   │   ├── FlightDatePicker.tsx  # Departure / Return field: month calendar in a portal, min date
│   │   │                         # Also exports the ISO date helpers (today / tomorrow / addDays)
│   │   ├── FlightSearchPanel.tsx # Flight search widget (responsive: desktop row + mobile stacked)
│   │   │                         # Owns From / To, dates, travellers and the preferred-airline
│   │   │                         # chips — all shared by both branches. Also holds the airline
│   │   │                         # list + PreferredAirlines type-ahead. Search collects the
│   │   │                         # panel into /flights?… ; it does not fetch. `initialInput` and
│   │   │                         # the `modify` variant let results reuse the same real form
│   │   ├── Footer.tsx            # Footer: newsletter signup + contact/links
│   │   ├── Header.tsx            # Top nav / home-linked logo; Sign In/Up, Dashboard, or UserButton
│   │   │                         # Nav: Flight, plus disabled Hotel / Holidays
│   │   ├── MulticitySegments.tsx # Multi City legs: a From/To/Departure row per trip, plus the
│   │   │                         # Add City button; reuses the pickers, holds no state itself
│   │   ├── PromoCarousel.tsx     # Promotional image carousel (unused; takes its images as a prop)
│   │   ├── TravelerSelection.tsx # Traveller / class field: counters, child ages, cabin ladder
│   │   │                         # The ladder is the API's five cabins, from lib/flights/cabin.ts
│   │   └── Sidebar.tsx           # Unused marketing sidebar (kept; dashboard has its own)
│   │
│   └── ui/                        # shadcn/ui primitives (Radix-based, reusable)
│       ├── accordion.tsx  ├── alert-dialog.tsx  ├── alert.tsx  ├── aspect-ratio.tsx
│       ├── avatar.tsx     ├── badge.tsx         ├── breadcrumb.tsx ├── button.tsx
│       ├── calendar.tsx   ├── card.tsx          ├── carousel.tsx ├── chart.tsx
│       ├── checkbox.tsx   ├── collapsible.tsx   ├── command.tsx  ├── context-menu.tsx
│       ├── dialog.tsx     ├── drawer.tsx        ├── dropdown-menu.tsx ├── form.tsx
│       ├── hover-card.tsx ├── input-otp.tsx     ├── input.tsx    ├── label.tsx
│       ├── menubar.tsx    ├── navigation-menu.tsx ├── pagination.tsx ├── popover.tsx
│       ├── progress.tsx   ├── radio-group.tsx   ├── resizable.tsx ├── scroll-area.tsx
│       ├── select.tsx     ├── separator.tsx     ├── sheet.tsx    ├── skeleton.tsx
│       ├── slider.tsx     ├── sonner.tsx        ├── switch.tsx   ├── table.tsx
│       ├── tabs.tsx       ├── textarea.tsx      ├── toast.tsx    ├── toaster.tsx
│       ├── toggle-group.tsx ├── toggle.tsx      └── tooltip.tsx
│
├── hooks/
│   └── use-toast.ts              # Toast notification hook
│
├── lib/
│   ├── airports/
│   │   ├── search.ts             # SERVER ONLY — scores/groups airports.json for /api/airports
│   │   ├── city-airport-mapping.ts # Reads the city groups; IATA -> city, city -> airports
│   │   ├── city-airport-groups.json # Curated metro areas (LON, NYC, …) and their airports
│   │   ├── country.ts            # SERVER ONLY — IATA -> ISO-2, and the domestic/international
│   │   │                         # test that decides whether checkout asks for a passport
│   │   ├── history.ts            # Recent picks in localStorage (max 5)
│   │   ├── popular.ts            # Bangladesh shortlist + long-haul hubs for the empty query
│   │   └── types.ts              # AirportOption — the shape the dropdown renders
│   ├── flights/                  # CLIENT-SAFE half of the flight feature: no secrets, no
│   │   │                         # supplier vocabulary. lib/triplover/ imports from here
│   │   ├── countries.ts          # Curated ISO-2 + dialing codes for the traveller form
│   │   ├── cabin.ts              # The API's five cabin classes — the ONE source of truth for
│   │   │                         # both the traveller popup's labels and the request's integer
│   │   ├── types.ts              # Public Search/RePrice/FareRules contracts, plus timezone-safe
│   │   │                         # duration/layover and money formatting helpers
│   │   ├── upsells.ts            # Groups equal flight schedules into lowest fare + upsells
│   │   ├── search-params.ts      # The search as a URL, so results are shareable/refreshable.
│   │   │                         # Decoding is untrusted — the route's schema is the real check
│   │   └── search-cache.ts       # SERVER ONLY — opaque supplier refs + pricing snapshots,
│   │                             # durable in Postgres with a bounded in-memory hot copy
│   ├── triplover/                # SERVER ONLY — everything that knows the supplier exists
│   │   ├── config.ts             # Env reading + the supplier/login timeouts
│   │   ├── client.ts             # Transport: two-host routing, token cache with single-flight
│   │   │                         # login, envelope unwrapping, and the retry policy that makes
│   │   │                         # Book / NewTicket / Cancel structurally non-retryable
│   │   ├── search.ts             # Supplier mapping, markup and public selling-price summaries
│   │   ├── fare-rules.ts         # Resolves private Search refs, calls FareRules and maps only
│   │   │                         # ordered public policy sections
│   │   ├── reprice.ts            # Live fare verification, role-derived repricing and private
│   │   │                         # Booking-reference refresh
│   │   └── book.ts               # Non-retryable hold Booking request/response mapping
│   ├── dashboard/
│   │   ├── mock-data.ts          # Placeholder summary + activity data (the API seam)
│   │   ├── auth-errors.ts        # Tells "this session names nobody" apart from "Clerk is down"
│   │   ├── sub-user-guard.ts     # Who may act on whom inside an agency — ONE copy of the
│   │   │                         # rule, shared by Sub Users and the Staff tab
│   │   ├── session.ts            # Server-side role resolution + signedInAt (Clerk + dev override)
│   │   └── welcome.ts            # Welcome-banner timing, shared by server page and client
│   ├── db/
│   │   ├── users.ts              # app_users registry: recordUserVisit() on every dashboard load
│   │   ├── agencies.ts           # Agency membership + code generation — the authority on
│   │   │                         # who belongs to which agency, and who owns it
│   │   ├── sub-users.ts          # Agency roster + the membership half of the ownership check
│   │   ├── staff.ts              # staff_details read/write; maps fields to columns
│   │   ├── document-uploads.ts   # SERVER ONLY — verify + store + sign, one copy shared by
│   │   │                         # the company profile and the upgrade application
│   │   ├── upgrade-requests.ts   # upgrade_requests read/write; the decision write is
│   │   │                         # guarded on the row still being pending
│   │   ├── profiles.ts           # user_profiles read/write; maps form fields to columns
│   │   └── markup-rules.ts       # SERVER ONLY — active lookups + Super Admin CRUD
│   ├── supabase/
│   │   └── server.ts             # Service-role Supabase client — SERVER ONLY, null when unconfigured
│   ├── agency.ts                 # Agency code format + generator (ST-B2B######). Pure:
│   │                             # no database, no auth provider, no request
│   ├── markup.ts                 # Pure matching, gross caps, margin share and LCC pricing
│   ├── appearance.ts             # SERVER ONLY — the site logo's fixed Cloudinary id + getSiteLogo()
│   ├── cloudinary.ts             # SERVER ONLY — the SDK wrapper: folders, upload, destroy,
│   │                             # public URLs, and expiring signed URLs for private assets
│   ├── upload-verify.ts          # Pure + client-safe: formats, size limits, byte signatures,
│   │                             # the SVG threat scan
│   ├── documents.ts              # Pure: StoredDoc — the handle a table records for a file
│   ├── marketing.ts              # SERVER ONLY — public-page artwork and its Cloudinary ids
│   ├── profile.ts                # Profile field/section/tab specs per role — the form's contract
│   ├── staff.ts                  # Staff record fields — a separate contract from profile.ts,
│   │                             # because staff_details is a separate table
│   ├── upgrade.ts                # Upgrade application fields, sections, business types and
│   │                             # the required-field rule. Pure; safe on the client
│   ├── rate-limit.ts             # Per-actor limits for mutating actions (including markup), plus
│   │                             # flight search — the one entry keyed on an address, not a
│   │                             # person, because the search panel is public (best-effort)
│   ├── roles.ts                  # Role union, labels, NAV_ITEMS, TILE_ACCESS — all permissions
│   ├── colors.ts                 # Color tokens / palette helpers
│   └── utils.ts                  # Utility helpers (e.g. cn() class merge)
│
├── supabase/
│   └── migrations/
│       ├── 0001_users_and_profiles.sql  # app_users + user_profiles schema (supabase db push)
│       ├── 0002_agencies_and_sub_users.sql # agencies + app_users.agency_code
│       ├── 0003_staff_details.sql       # staff_details — employment info per sub user
│       ├── 0004_upgrade_requests.sql    # upgrade_requests — customer → B2B applications
│       ├── 0005_document_uploads.sql    # `documents` jsonb on user_profiles + upgrade_requests
│       ├── 0006_markup_rules.sql        # Private fare markup rules + constraints/indexes
│       ├── 0007_capped_and_lcc_markup.sql # Gross cap, margin-share slider + LCC exception
│       ├── 0008_flight_search_quotes.sql # Private, expiring Search/RePrice reference chain
│       ├── 0009_flight_bookings.sql # Hold drafts, idempotency and supplier outcomes
│       ├── 0010_all_airlines_markup.sql # All-airlines fallback coverage
│       ├── 0011_all_airlines_route_markup.sql # All airlines on one route
│       ├── 0012_all_b2b_markup_audience.sql # Shared B2B audience
│       ├── 0013_negative_markup_discounts.sql # Negative fixed/percentage discounts
│       ├── 0014_prevent_overlapping_markup_routes.sql # Reject overlapping route scopes
│       └── 0015_booking_itinerary_snapshot.sql # Itinerary, per-pax fares and the passport
│                                     # flag on a draft, so checkout needs no live search
│
├── scripts/
│   └── seed-marketing.mjs        # One-time: push the public pages' artwork into Cloudinary
│
├── proxy.ts                      # Clerk context on dynamic/API routes; protects only /dashboard
│                                 # Also emits the CSP: strict on /dashboard, relaxed on static pages
│
├── airports.json                 # ~6.7k world airports (IATA, name, city, country) — read by
│                                 # lib/airports/search.ts on the server, never sent to the browser.
│                                 # Committed on purpose: search.ts imports it, so a build without
│                                 # it fails rather than degrading
├── MARKUP.md                     # Developer guide for rule targeting, precedence and pricing
├── DATABASE.md                   # Migrations, backup/restore, troubleshooting — the DB handbook
├── Triploaver_API_Documentation.md # The supplier's own API reference. Read it alongside the
│                                 # "documented vs observed" table below — it is wrong in places
├── .env.local                    # Clerk + Supabase + Cloudinary + Triplover keys — GITIGNORED
│                                 # (see Environment below)
├── .gitignore
├── audit.json                    # Dependency/security audit output
├── components.json               # shadcn/ui configuration
├── eslint.config.mjs             # ESLint configuration
├── next-env.d.ts                 # Next.js TypeScript ambient types (generated)
├── next.config.js                # Next.js config + the site-wide security response headers
├── package.json                  # Scripts & dependencies
├── package-lock.json             # Locked dependency tree
├── postcss.config.js             # PostCSS (Tailwind) configuration
├── projectmap.md                 # This file
├── tailwind.config.ts            # Tailwind theme: navy palette, brand-red, spacing, animations
└── tsconfig.json                 # TypeScript configuration
```

## Key Entry Points

| Area                | File                                             |
| ------------------- | ------------------------------------------------ |
| Home page           | `app/page.tsx`                                   |
| Root layout / Clerk | `app/layout.tsx` (`<ClerkProvider>`)             |
| Auth proxy          | `proxy.ts`                                       |
| Sign in / Sign up   | `app/(auth)/sign-in/…`, `app/(auth)/sign-up/…`   |
| Dashboard home      | `app/(dashboard)/dashboard/page.tsx`             |
| Roles & permissions | `lib/roles.ts`                                   |
| Agency code         | `lib/agency.ts`, `lib/db/agencies.ts`            |
| Sub User management | `app/(dashboard)/dashboard/agency-users/`        |
| Upgrade application | `lib/upgrade.ts`, `app/(dashboard)/dashboard/upgrade/` |
| Upgrade review      | `components/dashboard/UpgradeReviewDialog.tsx`   |
| Agency permissions  | `lib/dashboard/sub-user-guard.ts`                |
| Staff records       | `lib/staff.ts`, `lib/db/staff.ts`                |
| Profile form spec   | `lib/profile.ts`                                 |
| Dashboard mock data | `lib/dashboard/mock-data.ts`                     |
| Flight search UI    | `components/layout/FlightSearchPanel.tsx`        |
| Results modifier    | `components/flights/FlightSearchModifier.tsx`    |
| Results filters     | `components/flights/FlightFilters.tsx`           |
| Airline result filter | `components/flights/AirlineFilterBar.tsx`       |
| Results sorting     | `components/flights/ResultsSortBar.tsx`          |
| Results date nav    | `components/flights/ResultsDateNavigator.tsx`    |
| Result orchestration | `components/flights/FlightResults.tsx`          |
| Itinerary card      | `components/flights/ItineraryCard.tsx`           |
| Flight detail panels | `components/flights/ItineraryCardDetails.tsx`   |
| Airport picker      | `components/layout/AirportSelection.tsx`         |
| Date picker         | `components/layout/FlightDatePicker.tsx`         |
| Traveller picker    | `components/layout/TravelerSelection.tsx`        |
| Multi City legs     | `components/layout/MulticitySegments.tsx`        |
| Flight search API   | `app/api/flights/search/route.ts`                |
| Flight FareRules API | `app/api/flights/fare-rules/route.ts`           |
| Flight RePrice API  | `app/api/flights/reprice/route.ts`               |
| Supplier transport  | `lib/triplover/client.ts`                        |
| Search mapping      | `lib/triplover/search.ts`                        |
| FareRules mapping   | `lib/triplover/fare-rules.ts`                    |
| RePrice mapping     | `lib/triplover/reprice.ts`                       |
| Fare pricing page   | `app/(dashboard)/dashboard/markup/`              |
| Pricing engine      | `lib/markup.ts`                                  |
| Pricing-rule persistence | `lib/db/markup-rules.ts`                    |
| Search results page | `app/flights/page.tsx`, `components/flights/`    |
| Cabin classes       | `lib/flights/cabin.ts`                           |
| Supplier refs store | `lib/flights/search-cache.ts`                    |
| Airport search      | `lib/airports/search.ts`, `app/api/airports/`    |
| File storage        | `lib/cloudinary.ts`, `lib/db/document-uploads.ts` |
| Upload limits/checks| `lib/upload-verify.ts`                           |
| Theme / colors      | `tailwind.config.ts`, `lib/colors.ts`            |
| Security headers    | `next.config.js`, `proxy.ts` (CSP)               |
| Action rate limits  | `lib/rate-limit.ts`                              |
| CI pipeline         | `.github/workflows/ci.yml`                       |

## Authentication (Clerk)

- `proxy.ts` (the Next 16 rename of `middleware.ts`) runs `clerkMiddleware()` on every request and
  calls `auth.protect()` for `/dashboard(.*)`, `/flights/booking/resume(.*)` and
  `/flights/checkout(.*)`. It passes `signInUrl: '/sign-in'` so signed-out visitors land on our
  branded page rather than Clerk's hosted portal.
- `app/layout.tsx` wraps the app in `<ClerkProvider>`. `/dashboard` is the fallback after sign-in
  or sign-up; an explicit Clerk return URL (such as booking resume) takes precedence.
- `app/(auth)/` holds the branded, responsive sign-in and sign-up pages.
- **A deleted account does not stop being "signed in" straight away.** The middleware verifies the
  session token *locally*, so a token minted before the deletion keeps passing `auth.protect()`
  until it expires, while `currentUser()` asks the Backend API for a user id that is gone and
  **throws** — which, uncaught in a Server Component, replaces the dashboard with an error page.
  `signedInUser()` in `lib/dashboard/session.ts` catches it and returns null, putting the request on
  the `if (!session) redirect('/sign-in')` path the layout already had. `isSessionGoneError()`
  (`lib/dashboard/auth-errors.ts`) decides which failures qualify: 401/403/404 from Clerk's own
  error class. **A 5xx, a rate limit, or any non-Clerk error keeps propagating** — signing everybody
  out during an outage would turn a visible incident into a mystery, and the sign-in page they
  landed on would not work either.
- `Header.tsx` shows **Sign In / Sign Up** when logged out, and a **Dashboard** link plus
  **UserButton** when logged in, via Clerk's `useAuth()` hook. Its brand logo/name is a Next
  `Link` to `/`, so it always returns to the public home page instead of changing only the hash.

## Security

**Response headers.** `next.config.js` sets HSTS, `X-Frame-Options: DENY`, `nosniff`,
`Referrer-Policy` and a `Permissions-Policy` that denies every browser capability the app does not
use, on every route. `poweredByHeader: false` stops Next naming itself. `Cross-Origin-Opener-Policy`
is deliberately absent: Clerk's social sign-in popup talks back through `window.opener`, and
`same-origin` would sever it. HSTS omits `preload`, which is effectively irreversible.

**Content-Security-Policy** comes from `clerkMiddleware()` in `proxy.ts`, which knows Clerk's own
hosts and sets the `x-nonce` Next reads when rendering script tags. It is **strict**
(`strict-dynamic` + a per-request nonce) on `/dashboard`, `/sign-in` and `/sign-up`, all of which
are server-rendered on demand, and **relaxed** on the prerendered public pages — their script tags
are baked at build time with no nonce, and `strict-dynamic` ignores `'self'`, so a strict policy
there would block every script and stop the page hydrating. Four directives Clerk leaves unset are
added to both: `frame-ancestors`/`object-src` `'none'`, `base-uri 'none'`, and `img-src` widened to
`res.cloudinary.com` (everything the app stores), `images.kiwi.com` (airline logos), `blob:` (the
upload preview) and `img.clerk.com` (avatars).

> Adding a **statically prerendered** route under `/dashboard`, `/sign-in` or `/sign-up` would break
> it. They are all dynamic today.

> **`img-src` is the whole allow-list, on public pages too.** The home hero used to be a hardcoded
> `images.pexels.com` URL that this policy never permitted — it had been silently blocked. Anything
> added to a page has to be on this line or it will not render, and a blocked image logs nothing the
> casual reader will see.

**Uploads are checked against their contents.** `file.type` is a claim the browser makes, so
`lib/upload-verify.ts` identifies PNG, JPEG, WebP and PDF by file signature and scans SVG for
scripts, event handlers, `javascript:` and non-image `data:` URLs, `foreignObject`, embedded
documents, entity declarations and remote `<use>` references. The file is stored under the type that
was *verified*, never the one asserted. The SVG scan is a blocklist and is documented as one — SVG is
accepted only for the site logo, and no document field admits it.

**Actions that touch someone else's record never trust the payload for authorization.** The Sub
Users page and the Staff tab both take a target id from the browser — they have to — and nothing
else: the agency link is re-read from Postgres and the role from Clerk before any write. One copy of
the rule, in `lib/dashboard/sub-user-guard.ts`. See
[Every write re-derives ownership](#every-write-re-derives-ownership).

**Server actions are rate limited** per actor, after the permission check, via `lib/rate-limit.ts`.
The counter lives in module memory, so on Vercel it is one bucket per warm instance rather than one
per user: it divides a flood rather than stopping one outright. Making it exact means moving the
counter to Postgres or a KV store, and that file is the only place that would change.

**The flight search is the one public endpoint that costs money to serve.** It cannot require a
session — the panel is on the marketing home page — so it is limited by address when there is no
user, and carries a global concurrency cap as well as a rate limit, because each call occupies the
supplier for the better part of a minute. Supplier credentials live behind `import 'server-only'`
in `lib/triplover/`, and the opaque booking references a search issues are held server-side in
`lib/flights/search-cache.ts` rather than handed to the browser: a client that could choose them
could price one itinerary and book another. See
[Flight search (Triplover)](#flight-search-triplover).

**Commercial pricing is server-owned.** The search route derives B2C, agency or Super Admin pricing
from the signed-in session; the browser cannot choose its audience. Only a verified
`b2b`/`b2b_sub` user with an agency code receives agency pricing. A verified Super Admin receives
the supplier-payable audit price and bypasses pricing-rule lookup; every other role remains in the
B2C or agency pricing flow. Active rules are fetched through the service-role database client.
The complete `PricingSnapshot`, applied rule and available-margin calculation stay inside the
server-only search cache. Search exposes only the role-authorized card pair: display gross plus
agent selling fare for an agency, display gross plus supplier payable for a Super Admin, and one
selling fare for everyone else. If the rules table cannot be read, customer-facing pricing fails
safe to the greater of calculated gross and supplier payable rather than exposing supplier net.
Every pricing-rule mutation rechecks the Super Admin
role and passes the `manageMarkup` rate-limit bucket.

**Internal error text never reaches the browser.** Postgres messages name tables, columns and
constraints, and Cloudinary's name the account, the folder and sometimes the preset; they go to the
server log and the user gets wording they can act on. Clerk's `errors[0].message` is the exception and is passed through deliberately — it is the
short user-facing string Clerk's own components render.

## Flight search panel

The search widget (`components/layout/FlightSearchPanel.tsx`) is used in three places: the home page
hero, `/dashboard/flight-search` for signed-in users, and the expandable modifier above the results.
The hero/dashboard instances start from the normal DAC → CXB defaults; the modifier receives the
active URL search as `initialInput` and preserves its airports, dates, passenger counts and ages,
cabin, preferred carriers and multicity legs. It renders **two layouts** — a horizontal row from
`md` up, a stacked one below — and both are in the DOM at once, hidden by breakpoint. So **anything
added to the panel has to be added twice**, once per
branch, and any field carrying state has to have that state lifted into the panel, or the two copies
disagree.

### What the panel owns

| State                           | Starts as                        | Notes                                          |
| ------------------------------- | -------------------------------- | ---------------------------------------------- |
| `tripType`                      | Round Trip                       | the landing state; the `×` on Return drops it to One Way |
| `from` / `to`                   | Dhaka (DAC) → Cox's Bazar (CXB)  | swapped by the button straddling the divider   |
| `departureDate` / `returnDate`  | tomorrow / empty                 | ISO `YYYY-MM-DD`, `''` when unset              |
| `travelers`                     | 1 adult, Economy                 | counts, per-child ages, cabin class            |
| `segments`                      | empty until Multi City is opened | the legs of a multi-city trip                  |
| `preferredAirlines`             | empty                            | IATA chips; sent as `preferredCarriers`        |
| Fare preference                | Regular                          | Student unavailable pending supplier mapping  |
| `error`                         | none                             | the one validation line, under both branches   |

**All three Search buttons are wired** — the desktop icon button, the Multi City button and the
mobile one all call the same `submit()`. It collects the panel into legs (Round Trip becomes two
routes, Multi City one per leg; the supplier has no journey-type field, the route list *is* the
journey), validates, and pushes `/flights?…`. It does **not** fetch: the request is described
entirely by the URL so a result page can be refreshed, shared or reopened, and the fetch happens
there. The whole flow past that point is **[Flight search (Triplover)](#flight-search-triplover)**.

### Results-page modify search

`components/flights/FlightSearchModifier.tsx` replaces the old “go back home” edit link with an
in-place interaction. From `sm` up, its collapsed row keeps the icon-led route/date/traveller
summary. Below `sm`, it uses a compact ShopOnTravels-specific two-line summary: route + date first,
then a trip-type badge + travellers/cabin, followed by a 40px full-width action. That mobile card is
about half the height of the former three stacked summary blocks without copying Tripfeels' color
system. **Modify search** expands the shared panel; **Hide search** collapses it. The expanded panel
is the real search implementation, not a second form, and submitting it validates through the same
`submit()` before pushing a new `/flights?…` URL and collapsing.

`app/flights/page.tsx` resolves each active IATA code through the server-only airport index and
passes the small matching `AirportOption` map into the modifier. That keeps the 1.8 MB airport
dataset out of the browser while allowing the expanded fields to show city and airport names
immediately. The modifier is keyed by the serialized active search, so client navigation to a new
query resets every control to the new URL instead of retaining stale draft state.

### Results-page filters

`components/flights/FlightFilters.tsx` is the ShopOnTravels-styled filter sidebar beside the
itinerary list. It supports non-stop/one-stop/two-plus-stop journeys, refundable-only fares,
two-handle price and total-journey-duration ranges, and four outbound departure windows. Counts and
slider bounds come from the itineraries that were actually returned, not guessed values or a
second API. There is deliberately **no airline section inside this sidebar**: the separate
`AirlineFilterBar` owns post-search carrier selection, while preferred carriers in
`FlightSearchPanel` still constrain the supplier request before it runs.

Filtering is performed in `components/flights/FlightResults.tsx` after the supplier response is
mapped, so changing a filter is immediate and never starts another slow Triplover search. Desktop
keeps the card sticky beside the results. Below `lg`, the former full-width Filters trigger is not
rendered; a compact **Filter** button beside the visible-flight count controls the same accessible
expandable panel. `FlightResults` owns that mobile open state and passes it into `FlightFilters`;
the filter wrapper uses `display: contents` on mobile so a closed panel consumes no empty grid row.
Starting a new URL-driven search closes the mobile panel and resets every filter; **Clear** restores
the full returned result set.

### Results-page controls and responsive order

`AirlineFilterBar.tsx` consumes the mapped `FlightSearchResult.airlines` summary, sorts carriers by
minimum fare, and renders **All** plus one chip per carrier. Each chip shows the IATA code, supplier
count, minimum BDT fare and a 64px Kiwi asset displayed at 24px; a failed image becomes a neutral
plane icon. Selection is intentionally single-carrier, clicking the active chip returns to All, and
the fixed arrow buttons move the hidden-scrollbar strip by 260px. The selected code joins the same
`FlightFilterState` as the sidebar controls, so sidebar **Clear** clears it too.

`ResultsSortBar.tsx` replaces the former Cheapest/Earliest/Shortest segmented buttons with three
menus. Only one directional sort is active at a time:

| Menu | Directions | Comparison |
| ---- | ---------- | ---------- |
| Departure | Early to Late / Late to Early | first leg's departure timestamp |
| Price | Low to High / High to Low | itinerary `totalPrice` |
| Layover | Short to Long / Long to Short | summed positive time between connected segments |

Choosing a menu's Default option returns to the supplier/mapping order (which is already
price-ascending initially). Escape or the backdrop closes an open menu.

`ResultsDateNavigator.tsx` renders three joined items: **‹ Previous Day**, the calendar-backed active
date, and **Next Day ›**, in chronological visual order. Past calendar dates are disabled.
Changing the active date pushes a new encoded `/flights?…` URL and therefore runs a fresh search;
for Round Trip and Multi City, every later route shifts by the same number of calendar days so the
journey spacing remains valid. Route, traveller, cabin and preferred-carrier inputs are preserved.

The mobile control sequence is deliberate and uses CSS order rather than duplicated state:

1. airline filter strip;
2. date navigator;
3. Departure / Price / Layover sort row;
4. visible-flight count + compact Filter button.

From `sm` up, the airline and sort rows remain full width, followed by the count on the left and
date navigator on the right. At `lg`, the sticky filter sidebar occupies its own left column and the
compact Filter button disappears. Mobile-only gaps are reduced; desktop spacing is unchanged.

The API/result contract still records `partial` when one of Triplover's upstream sources fails, but
the former amber “Some airlines did not respond…” banner is intentionally not rendered.

### Results-page file ownership

| File | Owns |
| ---- | ---- |
| `app/flights/page.tsx` | Server-rendered page shell, decoded URL input and the small IATA-to-airport map |
| `components/flights/FlightSearchModifier.tsx` | Collapsed route/date/traveller summary and expand/collapse state |
| `components/layout/FlightSearchPanel.tsx` | The actual editable form, validation and the next `/flights?…` navigation |
| `components/flights/FlightResults.tsx` | Browser search request, loading/error states, responsive control order, sort/filter/date coordination |
| `components/flights/AirlineFilterBar.tsx` | Price-ordered, single-carrier post-search selector and horizontal scrolling |
| `components/flights/AirlineLogo.tsx` | Airline asset URL, sizing and failure fallback |
| `components/flights/FlightFilters.tsx` | Controlled responsive sidebar/panel, counts, ranges and clear/reset behavior |
| `components/flights/ResultsSortBar.tsx` | Three sort menus, active direction and menu interaction |
| `components/flights/ResultsDateNavigator.tsx` | Adjacent-date buttons and past-disabled calendar picker |
| `components/flights/ItineraryCard.tsx` | Compact carrier/schedule/feature card, confidential role-price reveal, responsive footer, expandable detail panels, and the one-press Book Now → silent RePrice → traveller form flow |
| `lib/flights/search-params.ts` | Shareable URL encoding and defensive decoding |
| `lib/flights/types.ts` | Client-safe search/result contract, segment features, authorized role-price pairs and formatting helpers |

The results route has its own restrained shape scale: primary cards and panels use `rounded-lg`
(8px); buttons, dropdown triggers, icon chips and smaller controls use `rounded-md` (6px); menu
items use `rounded` (4px). Only controls that are semantically circular—slider handles and count
badges—remain `rounded-full`. This scale is scoped to the results experience; it does not flatten
the larger marketing search panel.

### Flight-card anatomy

`ItineraryCard.tsx` keeps one physical schedule compact while still exposing the supplier data that
matters before selection:

- the Kiwi airline asset is flush to the top-left corner; `AirlineLogo.tsx` falls back to a Lucide
  plane when the CDN asset fails;
- the airline name may wrap to two lines, followed by every unique segment flight number
  (`BG-603, BG-401`);
- cabin and booking class appear together (`Economy G`);
- a short divider precedes aircraft equipment and refundable status. `lib/triplover/search.ts`
  maps supplier `plane[0]` / `details[0].equipment` into `segment.aircraft`; one model stays
  inline, while multiple unique models are arranged two per row and refundability moves to its
  own row. The main card reserves height only for the additional equipment rows, preventing them
  from crossing into the footer. Refundable is green and non-refundable is red;
- each schedule endpoint shows city, local time, `Thursday, Aug 13`-style local date and IATA code.
  `app/flights/page.tsx` resolves the small IATA-to-city map server-side so the 1.8 MB airport
  dataset never enters the client bundle. Arrival uses its own timestamp, so overnight flights show
  the next date correctly;
- the centre stack shows supplier-authoritative total duration, the unchanged line/plane graphic,
  stop count, and total layover when there is a connection. Search maps
  `directions[].travelTime` to the leg and `segments[].duration` / `details[].flightTime` to each
  flight. It never derives a cross-border duration by subtracting local airport clocks (for
  example, DAC 08:25 → SIN 14:40 is the supplied 4h 15m, not 6h 15m). Layovers are summed between
  consecutive segments at the same connection airport, with total-minus-flight-time as a fallback.
  The same helpers drive the card, duration filtering and layover sorting;
- the fare column shows the lowest reported `bookingCount` across the itinerary as remaining seats.
  The next line puts checked and cabin baggage side by side with their icons and a divider. Missing
  values are omitted; meals are not shown because Search provides no meal-detail field.

The right fare column and footer action share the same fixed desktop width. A schedule with fare
upsells says **Select** and opens those options; one without upsells says **Book Now** and proceeds
to RePrice directly. At `lg`
(including a 1024px viewport with the filter sidebar visible), footer labels are 9px, icons are
10px, horizontal padding is 3px, and the footer height/gaps are tightened so every action remains
on one line without a horizontal
scrollbar. `xl` restores 11px labels, 12px icons and the roomier spacing. Mobile keeps the single
View Details control and a full-width primary action.

Role-specific fare display is deliberately discreet and server-authorized:

| Viewer | Default amount | Arrow reveal | Visible labels |
| --- | --- | --- | --- |
| Customer / B2C / other staff | selling fare | none | none |
| B2B owner or sub user | display gross (`supplier basePrice + taxes`) | agent selling fare after the agency rule | none |
| Super Admin | display gross (`supplier basePrice + taxes`) | supplier payable / net fare | none |

Only a verified agency response contains `agencyPricing`; only a verified Super Admin response
contains `auditPricing`. The card also checks the loaded Clerk role before rendering either reveal.
Gross is always shown first with a small chevron. Clicking it shows the authorized alternate amount
underneath in red; clicking again hides it. The UI intentionally does not print “Gross”,
“Agent Fare” or “Net Fare”, because those commercial labels and comparisons are confidential.
This display-gross definition is the card presentation requested by the business; the markup
engine's internal gross ceiling remains the broader
`basePrice + taxes + ait + serviceCharge` described in
[Selling-price markup](#selling-price-markup).

> **Student Fare is unavailable.** Its control is disabled with an explanatory notice.
> Non-regular API preferences and search URLs are rejected instead of silently becoming regular searches.
> The supplied 39-page PDF does not define `fareType`; a later multicity fixture contains `1`
> without defining its meaning. Student support requires a supplier-confirmed enum and eligibility rules.

> **The cabin ladder lost three rungs.** It used to offer combined entries ("Economy/Premium
> Economy" and friends). The API takes one cabin integer with no value for "either of these", so
> those rungs could only ever have been sent as one of their halves — a visitor picking one would
> have searched something they did not ask for. `lib/flights/cabin.ts` now defines all five.

### The three pickers

There are three field components — airport, date, traveller — and Multi City reuses the first two,
once per leg. All three open a floating panel, and all three are built the same way. Follow it for
the next one:

- rendered with `createPortal` into `document.body`, so the panel's rounded overflow and stacking
  context cannot clip them;
- positioned `fixed` from the trigger's `getBoundingClientRect()` — measured when opened, and again
  on `scroll` (**capture phase**, so an ancestor scrolling counts) and `resize`. Scroll offsets are
  deliberately *not* added: `fixed` is already viewport-relative, and adding them makes the panel
  drift as the page scrolls;
- clamped to stay on screen, since the fields sit near the right edge on desktop;
- closed by an outside `mousedown`/`touchstart` or `Escape`.

**None of them own their padding** — the caller's `className` supplies it. That is what lets the
same component sit inside a shared bordered box (One Way / Round Trip, where From and To split one
border) and inside a box of its own (Multi City), without a variant prop.

The two that are panels rather than lists — the calendar and the traveller popup — additionally
centre themselves over a `bg-black/20` backdrop below `md`. The airport dropdown stays anchored
under its field, but takes a **320px minimum width**, because a From/To cell is far too narrow to
read a list of airports in.

#### From / To — `AirportSelection.tsx`

Focus opens a dropdown listing the visitor's recent picks first (localStorage, max 5), then the
popular Bangladesh airports; typing searches every airport in `airports.json` by IATA code, city,
airport name or country. Cities with several airports show an "All Airports" row (`LON`, `NYC`, …)
with their airports indented under it.

The dataset is ~1.8 MB, so it stays on the server: the field fetches `/api/airports?q=` (debounced
150 ms, answers cached per page load and shared between the two fields) rather than importing the
JSON. Ranking and city grouping live in `lib/airports/search.ts`.

#### Departure / Return — `FlightDatePicker.tsx`

Dates are ISO `YYYY-MM-DD` strings. Departure is seeded to **tomorrow after mount**, never during
render, because the server's "tomorrow" can be a different day than the visitor's. Return cannot
precede departure (`minDate`), same-day returns are allowed, and moving departure past an existing
return clears it.

Return is disabled and cleared unless the trip type is Round Trip, and the `×` on the Return field
means *no return flight*: it switches the trip to **One Way**, which is what clears the date. That
is why it shows whenever Return is live, picked date or not.

#### Traveller, Class — `TravelerSelection.tsx`

A counter per passenger type, an age dropdown per child, and the cabin ladder as radios. Seats are
what is capped: **adults + children ≤ 9**, while infants ride on a lap and so are capped at the
number of adults instead — dropping adults drops infants with them. Every child needs an age before
**Done** will apply, which is what the "Please add child Age." line warns about. Edits live in a
draft until Done, so closing the popup any other way leaves the search untouched.

The cabin ladder comes from `lib/flights/cabin.ts` rather than being declared here, so the labels
and the integer the request carries cannot drift apart. **The child ages are not decoration**: the
supplier splits children into two priced buckets (5–11 and 2–4) using the ages it is given, so a
wrong age is a wrong price — which is why the popup refuses to apply without them.

> The booking-class radios are visually hidden inputs, and each row is `relative` on purpose.
> Without it the input positions against the scrolling popup instead of its own row, and focusing it
> on click scrolls the popup to the top mid-click — the click then lands somewhere else entirely.

### Multi City

Picking **Multi City** swaps the single route for a list of legs
(`components/layout/MulticitySegments.tsx`). **2 to 6 legs**: the second is what separates a
multi-city trip from a one-way, so a leg can only be removed above two.

On `md+` each leg is a **four-column row** — From, To, Departure, then a shared fourth column that
carries the **traveller field on the first row** and **Add City on the last**, empty in between so
the rows line up. From and To are separate boxes with the swap button straddling the gap, unlike the
one-way layout where they share a border. Removable legs get a `×` past the fourth column, and
Search moves to its own line underneath, since the fourth column is spoken for.

Below `md` a leg is a stacked card instead, with a `Trip N` badge and a Remove link — vertical legs
have no left-to-right order to make the sequence obvious. One component serves both through a
`layout` prop (`row` / `stacked`); the fourth-column actions apply to `row` only.

**The legs run forward in time.** Trip N cannot depart before trip N-1, its calendar opens on that
date and refuses anything earlier, and moving an early date forward pushes every later leg that
would land in the past to the day after its predecessor (`chainDates`).

**Legs chain by place, too.** Adding one starts it where the last leg lands, a day later, so the
usual case is filling in one airport per leg.

**Switching tabs carries the route both ways.** Entering Multi City pulls the panel's From/To/date
into trip 1 — seeding trip 2 alongside it the first time — and leaving pushes trip 1 back out into
From/To/Departure. The later legs survive the round trip, so flipping tabs to compare never costs
the itinerary.

## Flight search (Triplover)

Live flight inventory comes from **Triplover**, a B2B consolidator, called **directly from this
application**. There is no intermediate service, and it must stay that way: the sibling
`tripfeels` product has its own Rust backend with its own Triplover adapter, and routing through it
would couple two independent businesses' deploys together.

**Search, ShoponTravels selling-price markup, FareRules, RePrice and the hold-only
traveller/Booking foundation** are built. Ticketing is not. The irreversible Triplover Book call
remains disabled until a Super Admin enables booking in Supplier Control.

### The shape of it

```
FlightSearchPanel  ──push──▶ /flights?… ──fetch──▶ POST /api/flights/search
                                                     │
                                                     ├─ session → pricing audience
                                                     ├─ Search + markup
                                                     └─ private quote → Postgres

Select fare/upsell ───────────────────────────────▶ POST /api/flights/reprice
                                                     │
                                                     ├─ read private supplier refs
                                                     ├─ Triplover RePrice
                                                     ├─ re-run current role's markup
                                                     └─ changed? require acceptance

Airline policies ─────────────────────────────────▶ POST /api/flights/fare-rules
                                                     │
                                                     ├─ read private supplier refs
                                                     ├─ Triplover FareRules
                                                     └─ return rule type + GDS narrative only
```

Three rules hold the layout together:

- **`lib/triplover/` is the only place that knows the supplier exists.** Every file there starts
  with `import 'server-only'`, so importing one from a `'use client'` file is a build error rather
  than a partner password in the JS bundle. Everything above it deals in our own types.
- **`lib/flights/` is the client-safe half** — the request/response contract, the cabin ladder,
  URL encoding, formatting. `lib/triplover/` imports *from* it, never the reverse.
- **`lib/markup.ts` is pure and client-safe, but commercial data access is not.** Rule matching,
  validation and exact money arithmetic live in the pure module; `lib/db/markup-rules.ts`, supplier
  prices and applied pricing snapshots stay server-only.

The results page server-renders only its shell; the search runs from the browser
(`components/flights/FlightResults.tsx`). That is not a preference — the supplier takes the better
part of a minute, and a server-rendered wait would leave the visitor on the previous screen with
nothing happening. The browser gets a loading state with an elapsed counter instead.

An empty supplier result uses the Tripfeels-style **No flights available** card. It repeats the
route, date, passenger count, and cabin, then offers **Previous day**, **Next day**, and **Search
again** actions. The previous-day action is disabled when it would enter the past. A transport or
supplier failure uses the same recovery layout with **Flight search unavailable** and the safe
public error message; it is not misrepresented as an empty inventory result.

### Documented vs observed

Every row below was found by calling UAT and contradicts, or is absent from, the supplier's own
document. **Trust this table over `Triploaver_API_Documentation.md`**, and re-probe before assuming
any of it has changed.

| What | The document says | What actually happens |
| --- | --- | --- |
| Search latency | nothing | **37–57 seconds.** The supplier fans out to its own sources and waits for the slowest |
| `item2` | an object (§3.2) | an **array on Search** — one entry per upstream source — and an object everywhere else |
| A failed `item2` entry | implies failure | is **normal**. A healthy search carries `isSuccess: false` with *"Invalid access token for Sabre"* — that is Triplover's credential for *its* upstream, not ours |
| Token expiry | 401 (§5.2) *and* 200 + message (§5.1) | **401**, on both hosts. The 200 form was never observed but is still handled |
| A 200 response | JSON | **not always.** `/api/FareRules` returned a plain-text .NET error; `JSON.parse` on that throws |
| `directions[0]` | one entry per requested route | can hold **several alternative flights**. Live Biman returned BG433 and BG437, both non-stop DAC→CXB, under one `itemCodeRef` at one price |
| `refreshToken` | "use to mint a new token" | **no endpoint redeems it.** Re-login is the only path |
| `tokenExpieryTime` | — | spelled exactly like that. Match the typo or renewal silently never fires |
| `item1.currency` | currency per call (§3.1) | **null.** Fixed BDT, hardcoded |
| Money | "base + taxes + fees" | Gross is `basePrice + taxes + ait + serviceCharge`. A discounted offer can have `totalPrice = gross + discountPrice`: 4,524 + 1,225 + 0 + 0 − 398.11 = 5,350.89. `discountPrice` is a supplier discount/commission, not ShoponTravels markup |
| `passengerFares.<type>` | — | **per passenger**, not per booking. Multiply by `passengerCounts.<type>` |
| Prices | — | can include minor units. Preserve two decimals (for example, 5,350.89); do not round business math to whole taka |

The "Invalid access token for Sabre" row cost a full debugging cycle: a token-expiry check loose
enough to match that string threw away a perfectly good token, logged in again, saw the same
message and failed the search. `isTokenExpiry` is now narrowed to *overall* failure plus the
documented wording, and the comment there says why — do not loosen it.

### Selling-price markup

The focused developer guide is [`MARKUP.md`](./MARKUP.md). It is the source of
truth for the current audiences, coverage combinations, precedence, formulas,
discount floor, LCC exception, and verification checklist.

`/dashboard/markup` is the Super Admin control surface. `MarkupManager.tsx` creates and edits rules,
pauses/resumes them and deletes them; the route actions recheck the role and rate limit every
mutation. `lib/db/markup-rules.ts` is the only database layer, backed by
the markup migrations `0006`, `0007`, and `0010` through `0014`.

The control surface is a four-step builder: audience, airline/route coverage, calculation and
advanced settings, then preview/save. Only fields required by the chosen coverage are shown. An
incomplete draft disables save and explains the missing value; switching calculation modes
normalizes an incompatible value; margin share accepts decimal input; and non-positive values
cannot retain LCC mode. The illustrative preview calls the same `priceOffer()` engine as Search and
RePrice, so its caps, floors, safe-gross baseline, and rounding cannot drift from production
arithmetic.

Each rule has:

- an audience: all B2C customers, all B2B users, or one specific agency code;
- an optional airline code (`NULL` means all airlines);
- an optional origin/destination route, optionally bidirectional;
- positive markup or negative discount using fixed BDT **per passenger** or a
  percentage of total base fare, or a 0–100%
  supplier-to-gross margin share;
- an explicit LCC service-margin switch (fixed or base-percentage only); and
- an active flag.

Exactly one rule wins; markups never stack:

| Viewer | First choice | Fallback | No matching rule |
| --- | --- | --- | --- |
| B2C / signed out | B2C route-specific rule | B2C airline/global rule | gross |
| Agency owner or sub user | specific-agency rule | all-B2B rule | supplier payable |
| Super Admin | no rule lookup | no markup | supplier payable |

All roles except Super Admin pass through markup selection. Specific-agency rules beat all-B2B
rules. Within the same audience specificity, route-specific beats all-routes, then a named airline
beats all airlines. A bidirectional rule also matches the reverse route. If several requested
multicity legs match, the earliest leg wins, then the most recently updated rule is the
deterministic tie-breaker. Rules never stack.

All arithmetic is performed in poisha (integer minor units); percentages are converted to basis
points. Normal rules start at supplier payable. Positive adjustments are capped by available
margin, while discounts are floored so taxes and AIT remain payable:

```text
gross                   = basePrice + taxes + ait + serviceCharge
available margin        = max(0, gross − supplier totalPrice)
fixed request           = rule.value × passengerCount
percentage request      = basePrice × rule.value / 100
margin-share request    = available margin × rule.value / 100
minimum selling         = max(offer taxes + AIT, passenger taxes + AIT)
minimum adjustment      = minimum selling − supplier totalPrice
normal applied adjustment
                        = max(minimum adjustment, min(requested adjustment, available margin))
normal selling price    = supplier totalPrice + normal applied adjustment
LCC service margin      = fixed request or percentage request
LCC selling price       = max(gross, supplier payable) + LCC service margin
```

A discount may go below supplier payable but cannot remove taxes or AIT. See
[`MARKUP.md`](./MARKUP.md#8-pricing-formulas) for the exact formula and rounding rules.

For the observed adult fare, gross is `4,524 + 1,225 = 5,749` and supplier payable is `5,350.89`.
A normal BDT 300 rule sells it at BDT 5,650.89; BDT 500 is capped to the available BDT 398.11 and
sells at gross, BDT 5,749. A 50% margin-share rule sells at BDT 5,549.95. With no rule, B2C remains
at gross and an agency remains at supplier payable. Super Admin always sees the supplier payable
BDT 5,350.89, regardless of matching B2C/agency rules. If the rules table is unavailable,
customer-facing audiences safely fall back to gross so an operational failure cannot expose
supplier net.

An LCC commonly has no supplier discount: supplier payable and gross are both BDT 5,749, leaving
zero normal margin. Only a rule whose **LCC service margin** switch is explicitly enabled may add
above safe gross. A BDT 200 LCC rule therefore sells at BDT 5,949. The pricing-rule form warns about the
exception and names common LCC examples; merely matching an airline code never enables it.

The API derives the audience with `getDashboardSession()`; it is never accepted from the request
body. The active-rule lookup starts beside the slow Triplover request. `selectMarkupRule()` chooses
the rule, then `priceOffer()` recomputes the public itinerary total, fare table, sort price, min/max
range and airline-filter minimums from the selling price. The UI's **Fare** column is the commercial
fare after supplier discount and ShoponTravels markup; taxes and AIT remain their actual public
components. An LCC exception is shown separately as **LCC service margin** on the card and in each
passenger fare row.

The compact card has an additional role-authorized presentation pair. For B2B owners/sub users,
`agencyPricing` contains display gross (`supplier basePrice + taxes`) and the calculated agency
selling fare. For Super Admins, `auditPricing` contains that same display gross and supplier
payable/net. These pairs are attached only after the server derives the audience; the request body
cannot ask for them. The card shows display gross by default and reveals the alternate amount with
an unlabeled chevron so commercial comparisons are not advertised on screen. No other role receives
either pair. This card-only display gross must not replace the pricing engine's internal gross
ceiling, which includes AIT and service charge.

For each result, the server keeps a private `PricingSnapshot` beside the supplier reference:
audience, pricing basis, supplier/gross/available-margin totals, requested and applied markup,
whether the gross cap or discount floor fired, explicit LCC service margin, selling price and
selected rule id/type/value. `flight_search_quotes` holds that reference chain for 20 minutes in Postgres; a
bounded memory copy is only a hot cache. RePrice reconciles the snapshot and stores the refreshed
`priceCodeRef`, `itemCodeRef`, transaction id and selling-price snapshot for the future Booking call.

### Fare upsell grouping

Triplover commonly returns the exact same physical flights several times at different prices,
booking classes, baggage allowances and refund conditions. Those are separate
`airSearchResponses`, each with its own `itemCodeRef`; its documented `brandedFares` field was
`null` on the live routes checked. Rendering every response as a top-level result created duplicate
cards and made the supplier's upsells invisible.

`lib/flights/upsells.ts` groups only offers whose carrier and complete segment schedule match:
airline, flight number, airports, departure and arrival for every segment. The cheapest option
becomes the visible card and every remaining response appears in its **Upsell options** panel with
price difference, refundability, booking class, baggage and direct-ticketing status. Equal-price
supplier references are retained and labelled “same price available”; no reference is discarded
merely because its customer-visible attributes match. Different flights or departure/arrival times
are never grouped, even when the airline reused the same flight number.

This changes result counts from priced offers to actual flight schedules. A live DAC→JFK check on
2026-07-29 returned 249 priced offers covering 138 schedules; 69 schedules had two to five fare
options. No option is discarded: every nested fare retains its own public itinerary id, and that id
still resolves to the matching private item/segment references and `PricingSnapshot` in the
server-side search cache.

### Fare selection and RePrice

The card footer has one primary action. With one fare it says **Book Now** and immediately verifies
that fare; with upsells it says **Select** and expands the fare choices first. Every choice then has
its own **Select fare** action, so the itinerary id sent to RePrice always belongs to the exact
option the customer picked. The browser sends only
`searchId` and our itinerary id to `POST /api/flights/reprice`; it never receives or supplies
Triplover's `uniqueTransID`, `itemCodeRef`, `segmentCodeRefs` or `priceCodeRef`.

The route re-derives the pricing audience from the current Clerk session, reads the supplier
references from `flight_search_quotes`, calls Triplover `/api/Reprice`, fetches the current active
markup rules and runs the same `selectMarkupRule()` + `priceOffer()` path used by Search. Therefore
RePrice preserves the pricing contract:

- a matching normal rule starts at supplier payable and is capped at gross;
- a matching, explicitly enabled LCC rule starts at safe gross
  (`max(gross, supplier payable)`) and adds its service margin;
- Super Admin still sees supplier payable; and
- no caller can choose their own role, rule, supplier price or reference token.

The public response contains only the recalculated selling total and fare components. An unchanged
fare is confirmed immediately. If Triplover reports `isPriceChanged`, the supplier payable changed,
or the recalculated selling price differs by at least one poisha, the card shows the old and new
selling totals and requires **Accept updated fare**. The refreshed Booking references remain private.
Expired searches return HTTP 410 and instruct the customer to search again.

For a signed-out customer, Book Now sends the exact `searchId` and itinerary id through Clerk using
the protected `/flights/booking/resume` URL as its return target. After sign-in,
`BookingResume.tsx` reprices that retained selection with the signed-in account's pricing audience.
An unchanged fare creates the attempt immediately; a changed fare requires **Accept updated fare**
first. The handoff then stores the checkout capability in session storage and replaces itself with
`/flights/checkout?bookingId=...`. It never runs a second Search or guesses the selection from a new
result order.

### Airline policies and FareRules

The flight-card footer exposes one **Airline policies** tab for fare conditions; the separate
**Cancellation** and **Date change** footer items have been removed. Opening Airline policies makes
one lazy, per-itinerary FareRules request rather than calling FareRules for every search result, and
keeps the supplier's complete ordered response, including any cancellation, refund, no-show,
exchange, change, or reissue sections it supplies. The browser posts only `searchId` and the
selected public itinerary id to
`POST /api/flights/fare-rules`. `lib/triplover/fare-rules.ts` resolves the private
`uniqueTransID`, `itemCodeRef` and every route-ordered `segmentCodeRef` from
`flight_search_quotes`, sends `brandedFareRefs: ""`, and calls Triplover `/api/FareRules`.

The public response contains only ordered `{ type, detail }` sections. The card preserves the GDS
line breaks and renders each narrative inside a wrapping monospace block. Loading, empty, expired,
timeout and supplier-error states are explicit, with an in-panel retry; a successful response is
cached per itinerary id in that card for the rest of the page session. The endpoint is public
because signed-out customers can view flight results, but it is rate-limited by caller address,
validates both ids, sends `Cache-Control: no-store`, and never accepts supplier references from the
browser.

Live probes confirmed that the section vocabulary varies by upstream source: one Biman result
returned `RU.RULE APPLICATION`, `CO.COMBINABILITY` and `VR.VOLUNTARY REFUNDS`; other sources return
`Exchange Penalties` / `Refund Penalties`, or passenger-specific `Cancellation for ADT`,
`Changes for ADT` and `No Show for ADT`. The unified policy panel preserves every returned heading
and narrative rather than guessing or splitting supplier rules into footer categories. An empty
response gets an explicit no-policies-returned state. The shared supplier
transport also handles the separately observed FareRules failure where
Triplover answered HTTP 200 with a plain-text .NET exception: that becomes a controlled
`FARE_RULES_FAILED` response rather than a JSON parse crash.

### Alternative flights under one reference

When a route lists several directions, each becomes its own results card flagged
`ambiguousSelection`, and the Itinerary footer panel says so. Flattening them would render a nonsense
"DAC→CXB then DAC→CXB" journey; dropping them would silently lose a fifth of the results on a
domestic route.

This is a display decision only, and it does not survive into booking — see below.

### Authentication and the token cache

A module-scope token cache with a **single-flight** guard: the first caller to find no usable token
starts the login and everyone else awaits the same promise, so a burst of searches on a cold
instance costs one login, not one each. Renewal happens two minutes before the server's stated
expiry.

Like the counters in `lib/rate-limit.ts`, this is **one cache per warm instance** on Vercel, not one
per deployment. That costs at most an extra login per cold instance per 30 minutes, which is why
the token is not kept in Postgres — a live credential in a second place buys nothing here.

### Rate limiting and timeouts

- **Per actor**, via the existing `checkActionLimit`: 20 searches and 30 RePrice checks per 5
  minutes. Both public actions use an address key (`ip:…`) because signed-out visitors can select
  flights too. They guard outbound supplier calls rather than only our own database.
- **Global concurrency cap** of 8 in-flight searches. With each call holding a connection open for
  most of a minute, concurrency — not request rate — is what a slow supplier actually feels.
  Triplover documents a 429 without publishing any budget for either.
- `maxDuration = 300` on the route, and a supplier timeout below it so we return a clean error
  instead of the platform killing the function mid-response.

> **`maxDuration` is clamped to the hosting plan.** On a plan capped at 60 seconds a slow route will
> still time out in production. That is a hosting decision, not something the code can fix.

### Search timing and observability

`POST /api/flights/search` measures the complete request path instead of inferring performance from
the browser's single "waiting for server response" number. Every JSON response carries a
`Server-Timing` header; successful searches expose:

| Metric | What it measures |
| --- | --- |
| `validation` | Request body read plus Zod validation |
| `token` | Triplover token acquisition; its description says `cache-hit`, `login` or `shared-login` |
| `triplover` | Search request start through the complete supplier body arriving |
| `triplover-ttfb` | Search request start through supplier response headers |
| `response-read` | Supplier response headers through the complete body arriving |
| `response-parse` | `JSON.parse` of the supplier response |
| `mapping` | Offer normalization, alternative expansion, markup selection, pricing and public summary rebuild |
| `cache-write` | Writing opaque supplier references and private pricing snapshots to Postgres plus the memory hot cache |
| `serialize` | `JSON.stringify` of the response sent to the browser |
| `total` | Complete route execution through construction of the response |

The route also writes one structured `[flight-search-timing]` JSON log per response with the same
durations, token source, supplier attempt count, status, result count and partial-result flag. It
deliberately logs no token, credentials, user id, IP address, search payload or supplier body.
`triplover` includes `response-read`; the more detailed fields are a breakdown, not extra time to
add to it. Chrome displays these metrics in Network → Timing under **Server Timing**.

The public search route does not require sign-in, but it does pass through Clerk middleware so an
optional signed-in agency can be priced correctly; `protect()` is not called for it. Its rate limit
still uses the caller address. The route emits both the standard `Server-Timing` header and an
identical `X-Flight-Search-Timing` diagnostic fallback. Production
verification on 2026-07-28 found that Vercel consumes the standard header from both Node functions
and Edge Middleware, while preserving the custom header. On Vercel, inspect
`X-Flight-Search-Timing` under Network → Headers; local and other runtimes that preserve the
standard header show the same fields under Network → Timing.

#### Measured production baseline (2026-07-28)

This measurement predates selling-price markup. It remains useful as a supplier-latency baseline,
but the current mapping step now also selects rules and rebuilds all public price summaries.

The exact one-way `DAC → JFK`, 1-adult, economy search for `2026-08-10` was run twice in sequence
against `shopontravels.vercel.app` after deployment:

| Stage | Cold token/login | Warm token/cache hit |
| --- | ---: | ---: |
| Client-observed total | 20,724.81 ms | 17,313.05 ms |
| Route `total` | 19,492.68 ms | 16,356.49 ms |
| Token acquisition | 768.14 ms (`login`) | 0.01 ms (`cache-hit`) |
| Triplover request/body | 18,696.44 ms | 16,335.34 ms |
| Triplover TTFB | 17,621.09 ms | 16,119.44 ms |
| Supplier body read | 1,075.35 ms | 215.90 ms |
| Supplier JSON parse | 12.56 ms | 8.91 ms |
| Mapping/normalization | 7.12 ms | 6.50 ms |
| Cache write | 0.11 ms | 0.15 ms |
| Browser JSON serialization | 2.59 ms | 3.34 ms |

On the warm run the Triplover call was **99.87% of route time**, and waiting for Triplover's
response headers was **98.68% of that supplier call**. Parsing, mapping, cache write and
serialization together took only **18.90 ms**. The measured client-minus-route gap was 0.96–1.23
seconds and includes Vercel/CDN transit plus delivery of the roughly 383 KB response.

The data supports reuse of the existing single-flight Triplover token cache (saving 768 ms in this
cold sample). The public endpoint now passes through Clerk middleware because optional identity is
required for agency pricing; its previously measured 2–12 ms cost is negligible beside the
supplier. Result caching was deliberately not added because prices and the opaque
`searchId`/offer references are live. Moving regions was also rejected:
the warm Vercel request from `iad1` completed faster than the 17.79-second direct Postman sample, so
there is no evidence that a region change would help. The remaining 16–19 seconds is supplier wait
time and requires Triplover to return earlier, provide a faster/streaming endpoint, or expose
per-provider partial results.

### What blocks live Booking

Traveller details, private drafts and the hold-only Booking adapter are built. Live supplier
submission remains deliberately disabled until operational approval:

1. **Alternative flights have no selector.** One `itemCodeRef` covers every alternative under a
   route, and nothing in the Search payload says which flight a customer chose. Those cards are
   displayed but RePrice rejects them until Triplover explains the selection shape. **Ask them.**
2. **Only held PNRs are allowed.** A RePrice result with `bookable: false` is blocked before
   checkout because Triplover would issue tickets during Book.
3. **Credentials are the supplier's public test account** and the hosts are UAT. Shapon needs its
   own partner credentials and production hosts before real traffic.
4. **Branded fares are unmapped.** `brandedFareRefs` feeds both RePrice and FareRules, and the
   document names the field without ever showing the shape of the object.

## Dashboard & roles

Everyone lands on `/dashboard` after login. **The layout and visual design are identical for every
role** — what differs is which nav items and summary tiles appear, what some nav items are called,
and which profile sections a role must fill.

Roles (flat slugs, defined in `lib/roles.ts`):

```
superadmin | admin | staff_support | staff_account | staff_media | b2b | b2b_sub | customer
```

`b2b` is an agency's owner; `b2b_sub` is a member of staff that owner created. **A sub user's
dashboard is the partner's dashboard** — same sections, same tiles, same figures, same profile form
— with exactly one exception, the `agency-users` section. See
**[Agencies and sub users](#agencies-and-sub-users)**.

The role comes from Clerk's `user.publicMetadata.role`; anything missing or unrecognised falls back
to `customer`. To assign one: Clerk Dashboard → Users → *user* → Metadata → Public →
`{ "role": "admin" }`.

> **`b2b_sub` is the one role you cannot fully grant that way.** Setting it by hand in Clerk gives
> someone the role with no agency, and `agency_code` lives in Postgres, not in metadata — so they
> would land on an agency dashboard belonging to nobody. Grant it in **Users & Roles**, which asks
> for the agency and writes both, or let a B2B partner invite them. Editing metadata by hand stays
> fine for every other role.

`lib/roles.ts` is the single source of truth for permissions:

| Export        | Purpose                                            |
| ------------- | -------------------------------------------------- |
| `ROLE_LABELS` | Display names for the topbar badge                 |
| `NAV_ITEMS`   | Every nav entry + the roles allowed to see it      |
| `TILE_ACCESS` | Which summary tiles each role sees                 |
| `canManageUsers` | Whether a role may open Users & Roles at all    |
| `canManageSubUsers` | Whether a role may open Sub Users — presentation only; the actor must also *own* the agency, which is a database fact |
| `assignableRoles` | The roles an actor may hand out                |
| `roleRequiresAgency` | Roles that cannot be granted without an agency — `b2b_sub` alone |
| `userActionBlockedReason` | Why an actor may not touch an account  |
| `SUB_USER_ROLE` | The `b2b_sub` slug, so callers do not spell it   |

`navItemsFor(role)` filters `NAV_ITEMS`; `findNavItem(role, segment)` is the gate the placeholder
page uses, so an unlisted segment 404s rather than rendering.

Summary tiles on the dashboard home:

| Tile              | SuperAdmin | Admin | Support | Account | Media | B2B | Sub User | Customer |
| ----------------- | :--------: | :---: | :-----: | :-----: | :---: | :-: | :------: | :------: |
| Total On Hold     |     ✓      |   ✓   |    ✓    |    ✓    |   –   |  ✓  |    ✓     |    ✓     |
| Pending Deposit   |     ✓      |   ✓   |    –    |    ✓    |   –   |  ✓  |    ✓     |    –     |
| Pending B2B Users |     ✓      |   ✓   |    ✓    |    –    |   –   |  –  |    –     |    –     |
| Total Co-Traveler |     ✓      |   ✓   |    ✓    |    –    |   –   |  ✓  |    ✓     |    ✓     |
| Total Tickets     |     ✓      |   ✓   |    ✓    |    ✓    |   ✓   |  ✓  |    ✓     |    ✓     |

Admin/staff figures are org-wide; B2B and customer figures are scoped to their own records. A sub
user's figures are the **agency's**, identical to the partner's — they work the same book of
business.

### The sidebar

The whole nav, in the order it renders. A cell holds the label that role sees; `–` means the item is
hidden for them. Sections marked ✔ are built — the rest render the shared "coming soon" placeholder.

| Segment           | Built | SuperAdmin      | Admin           | Support         | Accounts      | Media            | B2B             | Sub User        | Customer      |
| ----------------- | :---: | --------------- | --------------- | --------------- | ------------- | ---------------- | --------------- | --------------- | ------------- |
| *(home)*          |   ✔   | Dashboard       | Dashboard       | Dashboard       | Dashboard     | Dashboard        | Dashboard       | Dashboard       | Dashboard     |
| `flight-search`   |   ✔   | Flight Search   | Flight Search   | Flight Search   | Flight Search | Flight Search    | Flight Search   | Flight Search   | Flight Search |
| `bookings`        |       | My Bookings     | My Bookings     | My Bookings     | My Bookings   | My Bookings      | My Bookings     | My Bookings     | My Bookings   |
| `co-travelers`    |       | Passengers      | Passengers      | –               | –             | –                | My Passengers   | My Passengers   | Co-Travelers  |
| `deposits`        |       | Accounts        | Accounts        | –               | –             | –                | Payment Request | Payment Request | Wallet        |
| `partial-payment` |       | –               | –               | –               | –             | –                | Partial Payment | Partial Payment | –             |
| `statement`       |       | Account Ledger  | Account Ledger  | Statement       | Statement     | Statement        | Account Ledger  | Account Ledger  | Statement     |
| `report`          |       | Report          | Report          | –               | –             | –                | Report          | Report          | –             |
| `markup`          |   ✔   | Markup          | –               | –               | –             | –                | –               | –               | –             |
| `b2b-users`       |       | B2B Users       | B2B Users       | B2B Users       | –             | –                | –               | –               | –             |
| `support`         |       | Support Tickets | Support Tickets | Support Tickets | –             | –                | –               | –               | –             |
| `media`           |       | Media & Banners | Media & Banners | –               | –             | Media & Banners  | –               | –               | –             |
| `users`           |   ✔   | Users & Roles   | Users & Roles   | –               | –             | –                | –               | –               | –             |
| `agency-users`    |   ✔   | –               | –               | –               | –             | –                | Sub User        | **–**           | –             |
| `appearance`      |   ✔   | Appearance      | –               | –               | –             | –                | –               | –               | –             |
| `profile`         |   ✔   | Profile         | Profile         | Staff Profile   | Staff Profile | Staff Profile    | Company         | Company         | Profile       |

**A section with several names is several entries sharing one `segment`**, with **disjoint** `roles`
sets — so `navItemsFor()` never yields two for one segment, and the sidebar, topbar title and
placeholder heading all agree. `statement`, `co-travelers`, `deposits` and `profile` work that way.

**`agency-users` is deliberately a different segment from `users`**, not another label for it: the
roster with role control is admin-only, while a B2B partner's "Sub User" section covers its own
agency logins and never shows anyone else's account.

**It is also the one row where B2B and Sub User differ.** Every other agency row above is identical
for the two, by construction — `lib/roles.ts` gives them a shared `AGENCY` role set and
`agency-users` is the single entry that keeps `['b2b']`.

That omission hides the link. What makes the URL **404 for a sub user** is the page's own
`canManageSubUsers()` check — `agency-users` is a real route now, so it is not covered by the
`findNavItem()` gate that protects the unbuilt sections. Every server action behind it re-checks as
well, and against the database rather than the role alone.

**Flight Search is a real section, not a link out.** `/dashboard/flight-search` renders the same
`FlightSearchPanel` the public home page uses, so a signed-in user never leaves the account area to
start a search. It is the one section with **no heading of its own and no topbar title** — the panel
fills the page and names itself, so both would only repeat it. `UNTITLED_SEGMENTS` in
`DashboardTopbar.tsx` is what suppresses the topbar block (title *and* user name). The sidebar logo
points here too, so the usual "click the logo to go home" instinct lands on the booking engine
rather than the marketing site. The panel sits on a red-to-navy band (`bg-search-gradient`, defined
in `tailwind.config.ts`) so it reads as the hero it is on the home page — the band carries **no**
`overflow-hidden`, deliberately, because the date and traveller menus open downwards out of it.

**Pricing rules are a real Super Admin section.** `/dashboard/markup` loads agencies and persisted
rules server-side, then renders the four-step builder and list. Incomplete rules cannot be saved.
Its page and every mutation return 404 or reject the action for any other role. The search consumer
is described in
[Selling-price markup](#selling-price-markup).

**A hidden entry is also unreachable.** `findNavItem()` gates the placeholder page, so every `–` in
the table above is a 404 by direct URL, not just a missing link — `/dashboard/report` for staff and
customers, `/dashboard/partial-payment` for everyone but B2B, and so on. `appearance` is the one
branding section a plain admin cannot reach; `markup` is likewise Super Admin-only.

**The foot of the sidebar is not the nav.** A customer sees one thing there that no other role does:
a yellow **Upgrade to Business** button, black text, sitting above the "Signed in as" line. It is
deliberately *not* a `NAV_ITEMS` entry — it is an offer to change what the account is, and among the
nav items it would read as a section they were being denied. It is also the only non-navy element in
the sidebar, which is the point. See **[Upgrading a customer to B2B](#upgrading-a-customer-to-b2b)**.

`/dashboard/upgrade` is a real route, so it is not covered by the `findNavItem()` gate;
`canRequestUpgrade()` is what 404s it for everyone but a customer — the same shape as
`agency-users`. `DashboardTopbar` carries an `EXTRA_TITLES` map for exactly this case, since a page
with no nav item has no label to borrow.

> **Known gap:** `TILE_ACCESS` has not been realigned with these nav changes. Support Staff still
> sees the Co-Traveler tile and Accounts Staff the Pending Deposit tile with no matching nav item,
> and Customers have a Wallet item with no tile.

### Dev role switcher

Because the data layer is still mocked, the topbar has a **View as** dropdown for previewing the
dashboard as any role. It writes a `dev_role` cookie that `lib/dashboard/session.ts` prefers over
Clerk metadata.

**The cookie is scoped to whoever set it** — the value is `<userId>:<role>`, and a value written for
anyone else is ignored. It has no expiry and survives a sign-out, so an unscoped value would follow
the browser into the next account signed in on it. That failure is nasty because it is invisible:
the dashboard renders perfectly, just for the wrong role, and a genuine role problem underneath
looks identical. Cookies predating this format have no `:` and are ignored.

It is never rendered in production, and `setDevRole()` in `app/(dashboard)/actions.ts` no-ops there
while the session helper ignores the cookie — so it cannot be used to escalate privileges on the
deployed site.

> **It does not preview agency-scoped behaviour, and cannot.** `resolveAgency()` keys off Clerk's
> real role, so viewing as **B2B Partner** does not mint an agency and viewing as **Sub User** does
> not join one. Both previews come back with no agency code: the sidebar and tiles are right, but
> the Sub Users page reports that the agency could not be confirmed, and the profile banner shows no
> code. That is the switcher working as intended — a preview must not create real records. Testing
> the agency features needs accounts genuinely holding the roles.

### Profile page

`/dashboard/profile` renders the same required-details form for every role, plus a restyled Clerk
`<UserProfile />` for sign-in email, connected accounts and password.

`lib/profile.ts` is the single source of truth: field specs, section grouping, and which tabs a role
sees. The form, the completion meter and the overview sidebar all read it, so they cannot drift.

| Section        | Fields                                                                              | Roles         |
| -------------- | ----------------------------------------------------------------------------------- | ------------- |
| Personal Details | Given Name, Surname, Gender, Date of Birth, Address                              | all           |
| Passport       | Nationality, Passport No., Date of Expiry                                            | all           |
| Contact        | Mobile, Email                                                                        | all           |
| Business Info  | Agency Name, Agency Address, Email, Mobile, Website, Facebook Page                    | b2b, b2b_sub  |
| Business Docs  | Trade License, TIN Certificate, Travel Agency License, NID Card, Logo (file uploads)  | b2b, b2b_sub  |
| Bank Account   | Bank Name, Account Name, Account Number, Routing Number, Swift Code, Branch Code      | b2b, b2b_sub, customer |

Tabs group those sections: **Basic** (Personal + Contact), **Passport**, then **Business Info**,
**Business Docs** and **Bank** where the role has them. Agency roles get one more —
**[Staff List / My Staff Details](#the-staff-tab)** — which is the odd one out: it holds no section
from the table above, because it edits a different table.

`AGENCY_ROLES` in `lib/profile.ts` is what pairs `b2b_sub` with `b2b` here — a sub user fills the
same form as their partner, the agency's details included, because either of them may be the one to
keep those current.

> **Note this puts the agency's bank account within reach of its staff**, which follows from "a sub
> user's dashboard is the partner's dashboard". It is a deliberate choice, not an oversight.
> Narrowing it means a read-only mode in `ProfileDetailsForm` keyed on `b2b_sub` — not a change to
> the table above, since the sub user still needs to *see* the section.

**A partner and their sub users have separate profiles.** `user_profiles` is keyed by user, so the
agency name and bank details each of them types are their own copy, not a shared agency record. The
agency's canonical business details are still the owner's row — which is why `listAgencies()` reads
`agency_name` from there to label the admin's picker.

**Status — saving to Postgres.** Every text field persists to `user_profiles` and reloads on the
next visit.

**Nothing on this form is mandatory.** A save carrying a single value is as valid as a complete one;
blanks are stored as NULL rather than rejected, because a profile is filled in over time. The
percentage in the banner is progress, not a gate.

**Submit always sends the whole form, not the open tab.** `values` holds every field, seeded from
the saved row, so saving while Bank is open cannot blank the passport fields that are currently
unmounted. That is also why a failed read has to withhold the form entirely — see below.

**A failed read withholds the form.** `getProfile()` distinguishes an empty profile from a read that
*failed*, and the page renders a notice instead of the form in the second case. The form submits
every field at once, so showing it blank after a failed read would, on the next save, write NULL
over a passport number and bank account that were stored all along.

The five **Business Docs** uploads are the exception: they are files, stored in Cloudinary by their
own per-field actions rather than by this form's Save, and left out of the required check and the
completion meter. See **[Files: Cloudinary](#files-cloudinary)**.

#### The Staff tab

The Company profile carries one more tab for agency roles, and it is unlike every other tab here.

| Role | What the tab is | Label |
| ---- | --------------- | ----- |
| B2B partner (owns the agency) | their sub users' employment records — create, edit, delete | **Staff List** |
| Sub user | their own record, same actions | **My Staff Details** |

Fields: Designation, Email, Phone, Alternative Phone, Address, Qualification — `lib/staff.ts` is the
contract, and adding one is a field there plus a column of the matching name.

**It writes `staff_details`, a separate table from `user_profiles`.** That separation was the
requirement — staff data does not merge into the company profile — and it buys three things:

- staff fields never enter the **profile completion meter**, which counts `sectionsFor(role)`. For
  an admin they are somebody else's fields, so counting them would hold their own profile
  permanently short of 100%.
- a staff record can be **deleted** without touching that person's passport, bank account or login.
  Removing the *person* is still the Sub Users page; this clears details only.
- `saveProfileAction` stays exactly as strict as it was.

That last point is the reason for the whole shape. `saveProfileAction` takes the user id **from the
session and never from the payload**, which is what makes it safe. An admin editing someone else's
record needs a target id in the payload, so it gets `staff-actions.ts` — its own action with its own
check — rather than a loosening of that rule.

`requireStaffAccess()` (`lib/dashboard/sub-user-guard.ts`) admits exactly two callers and no third:
the **sub user on their own record** (the id must equal their own, which is what keeps "a sub user
cannot touch another sub user" true), and the **B2B admin on a sub user of their own agency**, via
the same `ownedSubUser()` the Sub Users page uses. An admin has no staff record of their own — they
are not staff — so their own id lands in neither branch and is refused.

**The panel renders outside the profile `<form>`.** It submits other people's records through its
own action, and a nested form is invalid HTML. The header's Save is hidden while the tab is open,
since it would claim to save what is on screen and would not.

Both writes share the `saveProfile` rate limit, keyed to **the actor** rather than the target, so an
admin editing several records cannot spend a sub user's allowance or vice versa. A failed read
withholds the panel for the same reason it withholds the profile form: the panel submits every field
at once, so a blank one would overwrite stored details on the next save.

### Users & Roles (superadmin + admin)

`/dashboard/users` is the whole-application roster and the only way to assign a role in the product
— no more editing `publicMetadata` by hand in the Clerk Dashboard.

| Actor | Sees the roster | Can grant | Can edit / delete |
| ----- | :-------------: | --------- | ----------------- |
| Super Admin | ✓ | any role, Super Admin included | anyone but themselves |
| Admin | ✓ | everything **except** Super Admin | anyone but a Super Admin, and not themselves |
| Support / Accounts / Media Staff | – | – | – |
| B2B Partner | – | – | – |
| Customer | – | – | – |

Nobody can change or delete **their own** account here — it is the one path that could demote or
delete the account you are signed in with and lock you out.

> **Deleting a B2B partner leaves their agency standing but unowned.** `forgetUser()` drops the
> `app_users` row, and `agencies.owner_user_id` is `on delete set null`, so the agency and its sub
> users survive — deliberately, since bookings and staff still point at it. But `isAgencyOwner` is
> then false for everyone, so **nobody can manage those sub users**: they keep signing in and
> working, and the Sub Users page is reachable by no one. Recovering means giving the agency a new
> owner, and there is no screen for that yet — it is a manual `agencies.owner_user_id` update today.
> Worth knowing before deleting a partner who has staff.

**The install must always keep one Super Admin.** Before any demotion or deletion, if the target
holds `superadmin` the action scans Clerk for another account that does; finding none, it refuses:

> The last Super Admin cannot be removed. The system must always have at least one Super Admin.

This outranks the permission table and does not care who is asking, so it holds for a direct POST to
the server action as much as for a click in the table. Without it, one demotion could leave nobody
able to grant the role back and the admin surface unreachable for good. The scan stops at the first
other Super Admin it finds — the full walk only happens when the answer is "none", which is exactly
the case worth paying for.

**The list comes from Clerk, not `app_users`.** Someone who signed up but never opened the dashboard
has no mirror row yet; sourcing the roster from the mirror would make them invisible and therefore
unmanageable. A role change writes to Clerk first, then calls `mirrorUserRole()` so the registry
does not go stale.

**Adding a user means inviting one.** `inviteUser()` creates a Clerk invitation carrying the role in
its metadata, so the role is attached the moment the person accepts. No admin ever sets or sees
another person's password, and the pending list can be revoked before acceptance.

**Granting Sub User asks for an agency.** Picking it in the role dropdown opens an agency picker on
that row rather than applying straight away, and the invite form grows a required Agency field —
because the grant is incomplete until an agency is named. The same picker is how an existing sub
user is moved between agencies, via the **Change** link beside their agency: re-selecting the same
option in a `<select>` fires no change event, so the role dropdown cannot serve that. With no
agencies on file yet the control explains itself and the submit is disabled, rather than letting the
server refuse for a reason the form could see for itself. See
[A Sub User is always granted *at* an agency](#a-sub-user-is-always-granted-at-an-agency).

**Every rule is enforced twice.** `lib/roles.ts` holds the single copy of the logic; the table uses
it to disable a row (with the reason as the tooltip) and each server action re-derives the actor
from the session and re-checks before writing. Actions also re-read the *target's* role from Clerk
rather than trusting the payload — otherwise a forged request could claim a Super Admin is a
customer and slip past the admin restriction.

> **Bootstrap:** roles are granted from inside the app, so the *first* Super Admin has to be set by
> hand — Clerk Dashboard → Users → *user* → Metadata → Public → `{ "role": "superadmin" }`. Until
> someone holds that role, the section is unreachable for everyone.

### Sub Users (B2B partner only)

`/dashboard/agency-users` is a partner's own staff, and **only** their own. It is the counterpart to
Users & Roles, not a filtered copy of it.

| Actor | Sees the roster | Can invite | Can rename / disable / remove |
| ----- | :-------------: | :--------: | :---------------------------: |
| B2B Partner (owns the agency) | ✓ their agency | ✓ into their agency | ✓ their own sub users |
| Sub User | – | – | – |
| Super Admin / Admin | – (they use Users & Roles) | via Users & Roles | via Users & Roles |
| Everyone else | – | – | – |

**The roster comes from the database, not from Clerk** — the reverse of Users & Roles, and for a
concrete reason. Clerk cannot filter a user list by public metadata, which is why the last-Super-Admin
scan has to page the whole roster; asking Clerk "who works for this agency" would walk every account
in the installation on every page load. So the split is: **`app_users` says who belongs to the
agency, Clerk says what state those accounts are in** (name, avatar, last sign-in, banned), fetched
in one batched `getUserList({ userId })`. Neither is asked a question the other owns.

Members are looked up by `agency_code` alone and filtered by Clerk's role afterwards, rather than
filtering on `app_users.role` in SQL. That mirror can lag, and filtering on it would silently hide a
real sub user. The same pass drops the owner, who belongs to the agency but is not their own staff.

#### Every write re-derives ownership

The rule lives in **`lib/dashboard/sub-user-guard.ts`**, in one copy, because it is now enforced from
two places — these actions and the [Staff tab](#the-staff-tab) on the Company profile. Two copies of
a permission check is one copy too many.

`requireAgencyOwner()` takes two answers from two authorities: the **role** from Clerk (only `b2b`
gets in) and the **ownership** from Postgres (`isAgencyOwner`, set by comparing
`agencies.owner_user_id` to this user). Holding the B2B role is not permission — the agency has to
be theirs, and an unreadable database leaves the flag false.

Then `ownedSubUser()` gates each target. **The browser sends an id and nothing else**: membership is
re-read from the database, the role is re-read from Clerk. Without it a partner could POST any user
id at these actions and disable or delete a Super Admin.

`requireStaffAccess()` is the third export, and it is what the Staff tab uses — it wraps the two
above and additionally lets a sub user through on their own record only.

`inviteSubUser()` **takes only an email** — the role is fixed at `b2b_sub` and the agency comes from
the session, so there is no role to escalate and no agency to redirect. `revokeSubUserInvite()`
re-checks the invitation's own metadata before revoking, because pending invitations are listed
application-wide and an id alone would otherwise reach another agency's, or an admin's.

**Disable is Clerk's ban, not its lock.** A lock expires on its own after the instance's lockout
window, quietly re-admitting someone the agency meant to shut out; a ban revokes sessions
immediately and holds until lifted. It is reversible, which is what separates it from removal.

**Edit is rename only.** The email is a sign-in identity and belongs to Clerk's own flows, and the
role is fixed — so there is exactly one thing on this page a partner can change about a person.

Every action here is rate limited per partner — `inviteSubUser` for the one that sends mail,
`manageSubUser` shared by rename, disable, enable and remove (`lib/rate-limit.ts`). The limit is
applied **after** the permission checks, so being turned away never spends anyone's allowance.

### Upgrading a customer to B2B

A retail customer asks to trade as an agency; an admin decides. The button is at the foot of the
sidebar, the form is `/dashboard/upgrade`, and the verdict is given in **Users & Roles** — the
section that already owns every role change in the product.

| Actor | Sees the button | Can apply | Can decide |
| ----- | :-------------: | :-------: | :--------: |
| Customer | ✓ | ✓ their own account | – |
| Super Admin / Admin | – | – | ✓ any pending application |
| Staff / B2B / Sub User | – | – | – |

**What is asked for.** Business Info — Agency Name, Mobile, Email, Address — then Personal Info —
Full Name, Business Type (**Proprietor** or **Partner**, a radio pair), Mobile, Address.
`lib/upgrade.ts` is the contract; the form, the validation and the reviewer's summary all read it, so
they cannot drift.

**Every text field is required, which is the opposite of the profile form** — and deliberately so. A
profile is filled in over time by the person it describes; an application is read once by somebody
deciding on it, and a half-filled one wastes their time and the applicant's. `upgradeBlockedReason()`
holds the single copy of that rule: the form disables Submit with it, the server action refuses the
write with it.

**Up to five supporting documents may be attached**, and they are genuinely optional: an application
with none is submitted, reviewed and accepted exactly like one carrying five. They go to Cloudinary
as **private** assets and the reviewer opens them through five-minute signed links — see
**[Files: Cloudinary](#files-cloudinary)**. A resubmission's superseded attachments are deleted, but
only *after* the new row is safely stored, so a failed submission never destroys the evidence behind
the last one.

**Fetched on demand, not shipped with the roster.** The users page learns only *who* has something
waiting (`pendingUpgradesFor`, one query); the application itself is loaded by
`loadUpgradeRequest()` when the dialog opens. An admin opens Users & Roles to do all sorts of things,
and putting every pending applicant's home address and phone number into that page's HTML is not one
of them.

#### The states an application moves through

| Status | The customer sees | The roster shows |
| ------ | ----------------- | ---------------- |
| never applied | the form | nothing |
| `pending` | "With our team for review", no form | **Waiting for upgrade** + **View** |
| `rejected` | the reviewer's note, and the form again, pre-filled with their own answers | nothing |
| `accepted` | nothing — they are a B2B partner now, and the button is gone with the role | nothing |

**One row per user, not one per attempt.** Resubmitting after a rejection writes over the top, which
is what makes "does this person have something waiting?" a primary-key lookup rather than a
max-by-date over a history.

**A failed read withholds the form**, the same rule as the profile page and for the same reason: a
blank form submitted over an application that was there all along would replace it.

#### Accepting is a role change and nothing more exotic

`decideUpgradeRequest()` grants `b2b` through the same `mirrorUserRole()` + Clerk pair that
`setUserRole()` uses. It does **not** touch the `agencies` table: the agency is minted by
`resolveAgency()` on the new partner's next dashboard load, exactly as it is for a role set by hand —
which is the whole point of that chokepoint. See
**[Agencies and sub users](#agencies-and-sub-users)**.

Four checks stand in front of it, and each is re-derived rather than trusted:

- the **actor** is an admin, from the session — never the payload;
- the **target's role** is re-read from Clerk and must still be `customer`. Anything else means the
  application has been overtaken, and upgrading a sub user or a staff account is not what this
  button means;
- `userActionBlockedReason()` applies unchanged, so nobody reviews their own application;
- the **row must still be `pending`**. The verdict write is conditional on it, so two admins with
  the dialog open cannot both grant the role — the second write matches no row and stops there.

**The verdict is written before the role, and reverted if the role does not follow.** The other
order looks safer and is not: a role granted against a row still marked pending leaves the applicant
a B2B partner with an application apparently still under review, and an admin staring at a badge for
a decision that has already taken effect. Note this is the opposite reasoning from `setUserRole()`,
where the database write goes first because the *agency link* is the invariant; here the invariant is
that the badge and the role agree.

**A stale pending row never advertises itself.** The roster only flags a row whose Clerk role is
still `customer`, so an application overtaken by a manual role change quietly stops showing rather
than inviting a click that would be refused.

### Files: Cloudinary

**Every file in the product lives in Cloudinary**, and there is exactly one way in and one way out.
Supabase holds rows; Cloudinary holds bytes.

| Piece | Role |
| ----- | ---- |
| `lib/upload-verify.ts` | Pure. Formats, size limits, and the byte checks. **Client-safe** — the pickers import their limits from here |
| `lib/cloudinary.ts` | SERVER ONLY. The SDK, the folder names, upload / destroy / sign / lookup |
| `lib/documents.ts` | Pure. `StoredDoc` — what a table records for a file |
| `lib/db/document-uploads.ts` | SERVER ONLY. Verify-and-store, discard, sign. One copy, shared by the profile and the upgrade application |
| `lib/appearance.ts` | The site logo, at a fixed public id |
| `lib/marketing.ts` | The public pages' artwork |

**What is stored is a handle, never a URL.** A public URL to an NID card is a permanent leak; a
signed one expires, and an expiring URL in a database is a value that is false for most of its life.
Columns hold a Cloudinary `public_id` plus the `format` needed to sign a link, and links are minted
at the moment somebody authorised looks.

**Private means `type: 'authenticated'`.** Cloudinary's default upload type is readable by anyone
holding the URL, with no session and no expiry — which is *weaker* than a private bucket, not
stronger, and not a default that identity documents can have. Everything in
`lib/db/document-uploads.ts` uploads authenticated, and is read back through
`private_download_url` with a five-minute expiry.

> That function rather than a signed delivery URL, deliberately: it is the form that carries a real
> expiry on **every** Cloudinary plan. Signed delivery URLs do not expire unless token-based
> authentication is enabled, which is a paid feature — and a link that never expires is the thing
> this is here to avoid.

**Uploads are server-side, always.** A `File` reaches a server action, its bytes are checked against
the type the browser claimed, and the *verified* bytes go up under the *verified* MIME type. This is
why no `NEXT_PUBLIC_` cloud name exists — see **[Environment variables](#environment-variables)**.

| Surface | Folder | Private? |
| ------- | ------ | :------: |
| Site logo | `shapon/site/logo` — fixed id, overwritten in place | – |
| Marketing artwork | `shapon/marketing/*` | – |
| B2B business documents | `shapon/business-docs/<userId>/*` | ✓ |
| Upgrade attachments | `shapon/upgrade-docs/<userId>/*` | ✓ |

**The site logo needs no settings table.** Its public id is fixed, so "is there a logo?" is a lookup
rather than a listing, and a replacement overwrites in place. Cloudinary bumps the version on every
overwrite and the delivery URL carries it, so a replaced logo is never served stale — which is what
the old timestamped-filename scheme in Supabase Storage existed to solve.

**Business documents are written one at a time, on pick, not on Save.** They have their own actions
(`uploadBusinessDocument` / `removeBusinessDocument`) for the same reason the Staff tab does: files
cannot ride in `saveProfileAction`'s payload, and that action stays exactly as strict as it is —
user id from the session, never the payload. The only thing the browser supplies is *which* of their
own documents it is, checked against `FILE_FIELDS` rather than trusted.

**Documents stay out of the completion meter.** They are stored now, but they are evidence rather
than profile fields, and counting five uploads towards a form about names and passports would
misreport how complete a profile is.

> **Seeding the marketing images.** They are not in the account until somebody puts them there:
> `node scripts/seed-marketing.mjs` uploads each one from the source URL recorded in
> `lib/marketing.ts`. Until then both call sites render without a photograph — the hero is already
> navy under an 80% overlay, so its absence reads as a plain band rather than a hole.

> **Known gap:** Cloudinary blocks **PDF delivery** by default on some accounts (Settings →
> Security → "PDF and ZIP files delivery"). Uploads succeed either way; if a reviewer's link to a
> PDF 401s while an image works, that setting is why.

### Appearance (superadmin only)

`/dashboard/appearance` sets the **site logo**, which is used in four places at once: the public
header, the dashboard sidebar, the sign-in / sign-up pages, and the browser tab (favicon, set in the
root layout's `generateMetadata`). Every one of them renders `SiteLogoMark`, which falls back to the
built-in mark when no logo is uploaded — so the site looks the same as before until one is.

| Piece                     | Role                                                              |
| ------------------------- | ----------------------------------------------------------------- |
| `lib/appearance.ts`       | The fixed public id and `getSiteLogo()`                            |
| `lib/cloudinary.ts`       | The SDK wrapper. Server-only; returns null when env is missing     |
| `lib/upload-verify.ts`    | Size + MIME limits and the byte checks. Shared with the picker     |
| `appearance/actions.ts`   | `uploadSiteLogo` / `removeSiteLogo`, both re-check the role        |
| `LogoUploader.tsx`        | Drag-and-drop picker, light + dark preview, remove-with-confirm    |

**Storage layout.** One Cloudinary asset at the fixed public id `shapon/site/logo`, overwritten in
place — there is no folder to list and no choice to make between two files. Limits: SVG, PNG, WebP
or JPEG, up to 512 KB, enforced in the browser *and* again in the action, since a server action is a
public endpoint. The action verifies the bytes against the declared type and uploads the verified
buffer under the verified MIME type. See **[Files: Cloudinary](#files-cloudinary)**.

After a change, `revalidatePath('/', 'layout')` refreshes the whole tree, including the statically
prerendered home page.

**Setup.** Nothing to create — Cloudinary makes the folder on first upload. Without the env vars the
page still renders, with uploads disabled and a notice naming what is missing.

> **Migrating from Supabase Storage:** the logo used to live in a public `site-assets` bucket. Any
> logo uploaded before this change is still in that bucket and is no longer read — **re-upload it
> once** from this page. The bucket can then be deleted.

### Agencies and sub users

A **B2B partner** (`b2b`) owns an agency. A **Sub User** (`b2b_sub`) is a member of staff that
partner created. The two share a dashboard; only `agency-users` separates them.

#### The agency code

Every agency has one: `ST-B2B` followed by six digits, e.g. `ST-B2B513548`. It is the identifier
that ties a partner to their sub users, and it is deliberately human-readable — it can be read out
to support, printed on a report, and searched for. It is shown on the Company profile banner.

| Piece | Role |
| ----- | ---- |
| `lib/agency.ts` | The format and the generator. Pure — no database, no auth provider, no request |
| `lib/db/agencies.ts` | `resolveAgency()`: reads membership, creates the agency on first sight |
| `agencies` table | `agency_code` primary key, `owner_user_id`, and a `check` pinning the format |
| `app_users.agency_code` | Which agency a person belongs to. Set for the owner too |

**Uniqueness is Postgres's job, not the generator's.** `generateAgencyCode()` returns a *candidate*;
`createAgency()` inserts it against the primary key and asks for another on a unique violation, up
to 8 times. Checking whether a code is free and then inserting it would let two concurrent
first-loads agree that the same code was free. Codes are random rather than sequential so one does
not reveal another, and so the count of agencies does not leak.

A unique violation has two causes needing opposite responses — the code was taken, or this owner
already has an agency because a concurrent request created it. Rather than parse the constraint name
out of the error, `createAgency()` re-reads: if the owner now has an agency it takes that one,
otherwise it tries a fresh code.

**The agency is created on first sight of a B2B partner**, inside `getDashboardSession()`. That is
the one chokepoint every route into the role passes through — promoted in Users & Roles, accepted
from an invitation, or set by hand in the Clerk dashboard — so "generated automatically when a new
agency is created" holds however it happened. It keys off Clerk's *real* role, never the previewed
one, so the dev role switcher cannot mint an agency.

#### The database is the authority

`agencyCode` and `isAgencyOwner` on the session come from Postgres. Clerk's
`publicMetadata.agencyCode` is a **mirror**, and is used in exactly one place: as a seed for a sub
user who has no stored link yet, because an invitation has to carry the code before any row exists.
`resolveAgency()` checks that seed against the `agencies` table before storing it, and ignores it
entirely once a link exists — so the mirror can drift, or be wrong, without moving anybody between
agencies. Nothing else reads it, and no permission decision does.

This is also why the schema names nothing after the auth provider: `owner_user_id` and
`agency_code` mean the same thing whoever is issuing user ids. (`app_users.clerk_id` predates this
and is unchanged — renaming it is a data migration, not a find-and-replace.)

**Failures fail closed.** `AgencyMembership` distinguishes "belongs to no agency" from "the lookup
failed", and the session maps a failure to `agencyCode: null, isAgencyOwner: false`. An unreachable
or unconfigured database therefore grants nothing: the dashboard still renders, and sub-user
management refuses. A database that could not answer is not a database that said yes.

#### A Sub User is always granted *at* an agency

`b2b_sub` is grantable like any other role — an admin can assign it in Users & Roles or invite
someone straight into it — but it never travels alone. `roleRequiresAgency()` marks it, and both
`setUserRole()` and `inviteUser()` refuse without a valid agency code. **A sub user with no parent
agency is not a state the application can reach.**

Where the agency comes from depends on who is granting:

| Actor | Agency | Editable |
| ----- | ------ | -------- |
| Super Admin / Admin, in Users & Roles | picked from a dropdown of every agency | yes — it is a real choice |
| B2B partner, in Sub User | their own, filled in from the session | no — there is only one answer and it is not theirs to change |

`agencyExists()` is the gate, and it answers **false for a database it could not reach** as well as
for a malformed or unknown code. None of the three is evidence the agency is real, and all three
have to block the grant.

**The database write goes before the Clerk write**, which is the opposite of every other action
here and is deliberate. Clerk decides the role, so writing it first would mean a failed database
write left someone holding `b2b_sub` with no agency — the exact state being prevented. Failing the
other way is inert: the role never changes, and a stray agency link on someone who is not a sub user
is read by nothing. `recordUserVisit()` corrects the mirrored role on their next visit either way.

`mirrorUserRole()` **upserts**. The roster comes from Clerk, so someone who signed up but never
opened the dashboard has no `app_users` row — an update would match nothing and the agency
assignment would be silently lost. Granting any other role clears `agency_code`, so nobody carries a
stale agency around from a spell as a sub user.

An invitation is the one place an agency code legitimately lives outside the database: the invitee
has no row yet, so the code rides in the invitation metadata, lands on their `publicMetadata` at
sign-up, and `resolveAgency()` turns it into the stored link on their first dashboard load — after
re-checking it against the `agencies` table, because by then it has been outside our control.

### Data

Supabase (project `gvbovgdjqmskcjgowppa`) is the Postgres store, and **only** that: every uploaded
file lives in Cloudinary, and these tables hold handles to them rather than bytes or URLs. See
**[Files: Cloudinary](#files-cloudinary)**. Supabase Storage was used for the site logo and is no
longer used at all.

Schema lives in `supabase/migrations/` and is applied with the **Supabase CLI**, which is already
authenticated and linked (`supabase/.temp/project-ref`):

```bash
supabase migration list --linked
supabase db push --linked
```

Full workflow — writing migrations, backups, restores, troubleshooting — is in
**[`DATABASE.md`](./DATABASE.md)**.

> **Former gotcha:** the CLI auto-loads `.env.local`, and used to fail from the project root with
> `LegacyDbConfigLoadError: failed to parse environment file: .env.local` — the file held an
> unquoted multi-line PEM (`JWKS_PUBLIC_KEY`) that strict dotenv parsers reject. That variable was
> unused and has been removed, so the parse error should be gone. If a multi-line value is ever
> added back, quote it, or run the CLI with `--workdir` pointed at a directory holding a copy of
> `supabase/` but no `.env.local`.

| Table           | Holds                                                              |
| --------------- | ------------------------------------------------------------------ |
| `app_users`     | One row per person who has opened the dashboard, mirroring Clerk    |
| `user_profiles` | The dashboard profile form, keyed by `clerk_id`, plus a `documents` map |
| `agencies`      | One row per B2B agency: its code and its owner                      |
| `staff_details` | Employment details for a sub user — separate from their travel profile |
| `upgrade_requests` | A customer's application to become a B2B partner, its attachments, and the verdict on it |
| `markup_rules`  | Private audience/agency, airline/route, calculation, active and audit data for selling-price rules |
| `flight_search_quotes` | Expiring private Triplover Search/RePrice references and pricing snapshots |

**Access model.** RLS is enabled on **every** table with **no policies**, which denies anon and
authenticated outright. Every read and write goes through the server's service-role key, which
bypasses RLS — no browser ever talks to Postgres.

`markup_rules` is commercial configuration and follows that same server-only access model. Database
constraints require B2C/all-B2B rules to have no agency and agency rules to reference one; route
fields must be both empty or both valid and different. Percentage markup/discount is limited to
-100 through 100 and fixed BDT markup/discount to -1,000,000 through 1,000,000, both excluding zero.
Margin share is constrained to 0–100%; the LCC exception accepts only positive fixed or
base-percentage values for one named airline. A normalized unique scope index prevents two rules for
the same audience/agency/airline/route/direction from competing silently. The pricing migrations are
`0006`, `0007`, and `0010` through `0014`; the final migration installs
`prevent_overlapping_markup_routes()`. Within one audience/agency/airline scope it rejects the same
directed route and any overlap involving a bidirectional route, while permitting opposite one-way
rules.

`flight_search_quotes` is also server-only and contains opaque supplier capabilities. Its random
UUID is safe to expose as `searchId`, but `unique_trans_id` and `itinerary_refs` never leave the
server. Rows expire after 20 minutes; Search opportunistically removes expired rows. Migration
`0008_flight_search_quotes.sql` has been applied to the linked project.

**A server action writing your *own* records takes the user id from the session, never from the
payload.** That is the rule, and `saveProfileAction` is the model for it.

Two places necessarily break it, because they act on *someone else's* record — Users & Roles, and
the staff/sub-user actions. Neither relaxes the rule so much as replaces it: the payload supplies an
id and nothing else, and every fact used to decide the request is re-read from the authority that
owns it (the role from Clerk, the agency link from Postgres). See
[Every write re-derives ownership](#every-write-re-derives-ownership).

**Clerk stays authoritative** for identity and role. `app_users.role` is a mirror kept for listing
and filtering, and is written from Clerk's `publicMetadata` — deliberately *not* from the session's
effective role, so previewing as another role in dev cannot rewrite the real one.

**The agency relationship is the other way round**: Postgres is authoritative and Clerk mirrors it.
See [Agencies and sub users](#agencies-and-sub-users) for why, and for the one case where the mirror
is read.

`recordUserVisit()` runs inside `getDashboardSession()`, which is wrapped in React's `cache` so it
fires once per request rather than once per component that asks for the session. It swallows its own
errors: a registry write failing should not take the dashboard down.

`resolveAgency()` runs there too, immediately after — the ordering matters, because the registry
write is what guarantees the `app_users` row the agency links to. **That `cache` wrapper is doing
real work here**: without it, several components asking for the session during one render could each
race to create an agency for the same partner. The unique constraint on `owner_user_id` would still
hold the line (see [Agencies and sub users](#agencies-and-sub-users)), but the cache is why it
almost never has to.

It fails softly in the same spirit — a session with `agencyCode: null` rather than an exception — but
**not permissively**: `isAgencyOwner` comes back false, and everything gated on it refuses.

Dashboard tiles and activity are still mocked in `lib/dashboard/mock-data.ts`. `getSummary(role)`
and `getRecentActivity(role)` remain the seam a real query replaces.

> **Note:** `.env.local` used to carry a `DATABASE_URL` for a *different* Supabase project
> (`olepyalcftivchcoztdi`), plus `JWKS_URL`, `JWKS_PUBLIC_KEY`, `FRONTEND_API_URL` and
> `BACKEND_API_URL`. Nothing read any of them and all five have been removed. If you hold an older
> copy of the file, delete those lines — `DATABASE_URL` held a live database password — and see
> [`DATABASE.md`](./DATABASE.md).

## Environment variables

Stored in `.env.local` (gitignored — never committed). Required:

```
NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY   # public, shipped to the browser
CLERK_SECRET_KEY                    # secret, server-side only
```

Supabase — all user data. Without them the profile form reports that the database is unconfigured:

```
NEXT_PUBLIC_SUPABASE_URL            # project URL, e.g. https://xxxx.supabase.co
SUPABASE_SERVICE_ROLE_KEY           # secret, server-side only — bypasses RLS, never expose it
```

Cloudinary — every file the application stores: the site logo, the marketing artwork, the B2B
business documents and the upgrade attachments. Without them the site falls back to its built-in
mark, the marketing sections render without photography, and every upload control disables itself
with a notice naming these:

```
CLOUDINARY_CLOUD_NAME               # not secret — it appears in every delivery URL
CLOUDINARY_API_KEY                  # secret, server-side only
CLOUDINARY_API_SECRET               # secret, server-side only
```

**There is deliberately no `NEXT_PUBLIC_CLOUDINARY_CLOUD_NAME`.** Every upload goes through a server
action and every URL — public or signed — is built on the server and passed down as a prop. The
browser never constructs one, so it never needs the account name. Keep it that way: a public copy of
it is the first step towards an unsigned browser-direct upload, which would bypass the byte checks in
`lib/upload-verify.ts` and put an open upload endpoint in the JS bundle.

There is no env var for the delivery host either. `res.cloudinary.com` is the same for every account,
so `proxy.ts` hardcodes it in `img-src` rather than deriving it from configuration and gaining a way
for it to be absent.

Triplover — live flight inventory. All twelve are **server-only**; none may ever gain a
`NEXT_PUBLIC_` prefix, and `lib/triplover/config.ts` is the only reader. Without them
`/api/flights/search` answers 503 and the results page says search is unavailable, rather than
crashing:

```
FIRSTTRIP_SEARCH_BASE_URL           # FirstTrip host for POST /api/Search only
FIRSTTRIP_BASE_URL                  # FirstTrip host for login, reprice, book, …
FIRSTTRIP_EMAIL                     # FirstTrip partner account, secret
FIRSTTRIP_PASSWORD                  # FirstTrip password — already base64 from the provider
TAKEOFF_SEARCH_BASE_URL             # TakeOff host for POST /api/Search only
TAKEOFF_BASE_URL                    # TakeOff host for login, reprice, book, …
TAKEOFF_EMAIL                       # TakeOff partner account, secret
TAKEOFF_PASSWORD                    # TakeOff password — already base64 from the provider
TRIPLOVER_SEARCH_BASE_URL           # Direct Triplover host for POST /api/Search only
TRIPLOVER_BASE_URL                  # Direct Triplover host for login, reprice, book, …
TRIPLOVER_EMAIL                     # Direct Triplover partner account, secret
TRIPLOVER_PASSWORD                  # Direct Triplover password — already base64 from the provider
```

**The password is not "encrypted", it is encoded**, and the two hosts really are different — Search
lives on its own. The values currently in `.env.local` are the **supplier's public test account**
against **UAT**, taken from their own documentation. Replace all four before any real traffic.

These supplier variables are read only by the server integration. The two Clerk keys appear nowhere in our
source — the SDK reads them itself in `@clerk/nextjs/.../server/constants.js` — so a text search
will report them unused. They are not.

For deploys, set these as environment variables on the host (Vercel → Project Settings → Environment Variables).

## CI / CD

- **CI** — `.github/workflows/ci.yml` runs on push / PR to `main`:
  `quality` (lint + typecheck) → `build` (`next build`).
- **CD** — Vercel auto-deploys every push to `main` (GitHub integration). Vercel is the *only*
  deploy target: there is no Netlify config or adapter, and none should be added back.

## Available Scripts

```bash
npm run dev        # Start the dev server (http://localhost:3000)
npm run build      # Production build
npm run start      # Serve the production build
npm run lint       # ESLint
npm run typecheck  # tsc --noEmit
```

One-off, not a package script — it is run once per environment rather than as part of any workflow:

```bash
node scripts/seed-marketing.mjs   # push the public pages' artwork into Cloudinary
```

## Notes

- **The brand is "Shapon Travels International"; the identifiers are `shopontravels`.** The repo,
  the GitHub remote, the Supabase project and the local dev-server config all carry the older
  spelling, and they name real resources — renaming them is a migration, not a find-and-replace. The
  mismatch is intentional: only user-facing text was corrected.
- The home page is **flight-only in function**: eSIM and mobile-app sections were removed, and
  **Hotel** and **Holidays** appear only as disabled placeholders — greyed out in the header nav and
  as `disabled` tabs on the search panel, both tooltipped "Coming soon".
- The search panel — its two layouts, the state it owns, and how the three pickers are built — has
  its own section: **[Flight search panel](#flight-search-panel)**. What happens after the Search
  button is **[Flight search (Triplover)](#flight-search-triplover)**.
- **Preferred Airlines** is a type-ahead over the `airlines` list in `FlightSearchPanel.tsx`: typing
  matches an IATA code by prefix or an airline name anywhere, and a pick becomes a code chip (`BS`,
  `BG`). One `PreferredAirlines` component serves both branches — `inline` puts the label beside a
  fixed 260px box (desktop, right-aligned with the Traveller field), otherwise it stacks above a
  full-width box (mobile). Its chips are held **in the panel** and sent as `preferredCarriers`, so
  the two copies agree.
- **The "All Airports" rows send a metro code, not an airport code.** Picking one (`LON`, `NYC`)
  passes that city code straight through to the supplier as `origin` / `destination`. GDSs
  generally accept it, but this has **not** been verified against Triplover — worth a probe before
  anyone reports it as a bug.
- The hero badge and heading are hidden below `sm`, so on phones the search panel sits directly
  under the header.
- Most files under `components/ui/` are generated shadcn/ui primitives; only a subset is used so far.
- Unbuilt dashboard sections render a shared "Coming soon" placeholder
  (`app/(dashboard)/dashboard/[section]/page.tsx`) so no nav link 404s; which ones are built is the
  ✔ column in **[The sidebar](#the-sidebar)**.
- **The agency code is meant to be shared.** It is shown on the Company profile banner and the Sub
  Users page precisely so it can be quoted to support or put on a report. It identifies an agency; it
  authorises nothing. Every permission decision reads the database link, never a code someone typed
  — see [The database is the authority](#the-database-is-the-authority).
- **Nothing deletes an agency**, and that should stay true. `agency_code` is a primary key, so
  deleting a row frees the code for a future draw — and any report or ticket still quoting it would
  then point at a different company. Removing a partner clears `owner_user_id` (`on delete set
  null`) and leaves the agency standing, which is the behaviour to keep.
- The site logo is loaded with a plain `<img>`, not `next/image`. That began as a constraint — the
  host came from an env var and so could not be listed in `images.remotePatterns` — and is now
  simply a choice: images are `unoptimized` project-wide, so `next/image` would buy nothing here.
  The marketing artwork does use `next/image`, for the `fill` layout rather than the optimiser.
- The dashboard welcome banner hides **45 seconds after sign-in**, not 45s after page load — the
  clock is anchored to Clerk's `lastSignInAt`, carried through `getDashboardSession()`. The server
  computes the initial visibility so the first client render matches the HTML. Note this means it
  does not reappear on later visits until the user signs in again.
- Corner radii are deliberately scoped. Dashboard cards use `rounded-lg` (8px), with most icon chips
  and form controls at `rounded-md` (6px). The flight-results route now follows a similarly restrained
  scale documented in **[Results-page file ownership](#results-page-file-ownership)**. The home-page
  marketing/search treatment keeps its larger `rounded-2xl`/`rounded-xl` look.
- Clerk's `<UserProfile />` is restyled via an `appearance` prop in the profile page so it matches
  the navy/red system. Its "Secured by Clerk" footer is left visible — hiding it is a paid feature.
- **MFA is not available on Clerk's free plan** (Hobby). Two-step verification would need Pro, or
  an app-level implementation.
- `CLERK_SECRET_KEY` must be set on Vercel for the dashboard to render — the layout reads the user
  server-side via `currentUser()`.
