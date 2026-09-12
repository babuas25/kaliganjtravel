# System Architecture — Shapon Travels International

This document describes the overall system architecture, component organization, and key architectural decisions for the Shapon Travels International flight booking platform.

**Related Documentation:**
- [Database Guide](../DATABASE.md) — Database schema, migrations, and access patterns
- [Booking Architecture](../BOOKING_ARCHITECTURE.md) — Booking lifecycle and data flow
- [Wallet Architecture](../WALLET_ARCHITECTURE.md) — Financial system and payment flows
- [Markup Configuration](../MARKUP.md) — Pricing rules and markup logic

---

## 1. Overall System Architecture

### High-Level Overview

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              Browser / Client                               │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐  │
│  │   B2C Site   │  │  Dashboard   │  │   Sign In    │  │   Sign Up    │  │
│  │   (Public)   │  │  (Protected) │  │   (Auth)     │  │   (Auth)     │  │
│  └──────┬───────┘  └──────┬───────┘  └──────┬───────┘  └──────┬───────┘  │
└─────────┼──────────────────┼──────────────────┼──────────────────┼──────────┘
          │                  │                  │                  │
          └──────────────────┴──────────────────┴──────────────────┘
                                   │
                                   ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                         Next.js Application Layer                            │
│  ┌──────────────────────────────────────────────────────────────────────┐  │
│  │                        Server Components                              │  │
│  │  • app/layout.tsx (Root)                                             │  │
│  │  • app/(auth)/layout.tsx, page.tsx                                   │  │
│  │  • app/(dashboard)/layout.tsx                                        │  │
│  │  • app/flights/page.tsx                                              │  │
│  │  • app/(dashboard)/dashboard/*/page.tsx                              │  │
│  └──────────────────────────────────────────────────────────────────────┘  │
│  ┌──────────────────────────────────────────────────────────────────────┐  │
│  │                        Client Components                              │  │
│  │  • components/dashboard/* (DashboardShell, Sidebar, etc.)           │  │
│  │  • components/flights/* (FlightResults, ItineraryCard, etc.)         │  │
│  │  • components/auth/* (Auth panels)                                   │  │
│  └──────────────────────────────────────────────────────────────────────┘  │
│  ┌──────────────────────────────────────────────────────────────────────┐  │
│  │                        Server Actions                                 │  │
│  │  • app/(dashboard)/actions.ts (Dev role switcher)                     │  │
│  │  • app/(dashboard)/dashboard/*/actions.ts (Page-specific actions)    │  │
│  └──────────────────────────────────────────────────────────────────────┘  │
│  ┌──────────────────────────────────────────────────────────────────────┐  │
│  │                        API Routes                                     │  │
│  │  • app/api/flights/search/route.ts                                   │  │
│  │  • app/api/flights/booking/*/route.ts                                │  │
│  │  • app/api/wallet/*/route.ts                                         │  │
│  │  • app/api/reports/*/route.ts                                        │  │
│  └──────────────────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────────────┘
                                   │
                                   ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                         Business Logic Layer (lib/)                         │
│  ┌──────────────────────────────────────────────────────────────────────┐  │
│  │  Database Access (lib/db/)                                           │  │
│  │  • agencies.ts, users.ts, profiles.ts                                │  │
│  │  • flight-bookings.ts, booking-attempts.ts                           │  │
│  │  • wallet.ts, markup-rules.ts                                        │  │
│  └──────────────────────────────────────────────────────────────────────┘  │
│  ┌──────────────────────────────────────────────────────────────────────┐  │
│  │  Domain Logic (lib/flights/, lib/wallet/)                            │  │
│  │  • booking.ts, booking-status.ts                                     │  │
│  │  • search-params.ts, search-cache.ts                                  │  │
│  │  • pricing-principal.ts, markup.ts                                   │  │
│  └──────────────────────────────────────────────────────────────────────┘  │
│  ┌──────────────────────────────────────────────────────────────────────┐  │
│  │  Supplier Integration (lib/triplover/)                              │  │
│  │  • client.ts (HTTP transport, auth, retry policy)                    │  │
│  │  • search.ts, book.ts, cancel.ts, ticket.ts                          │  │
│  │  • reprice.ts, fare-rules.ts, pnr.ts                                 │  │
│  └──────────────────────────────────────────────────────────────────────┘  │
│  ┌──────────────────────────────────────────────────────────────────────┐  │
│  │  Authentication & Session (lib/dashboard/)                          │  │
│  │  • session.ts (DashboardSession, getDashboardSession)                │  │
│  │  • sub-user-guard.ts, user-roster.ts                                 │  │
│  └──────────────────────────────────────────────────────────────────────┘  │
│  ┌──────────────────────────────────────────────────────────────────────┐  │
│  │  Cross-Cutting Concerns                                              │  │
│  │  • lib/supabase/server.ts (Service-role client)                      │  │
│  │  • lib/rate-limit.ts (Action limits)                                 │  │
│  │  • lib/email/* (Notification templates)                              │  │
│  └──────────────────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────────────┘
                                   │
          ┌────────────────────────┼────────────────────────┐
          │                        │                        │
          ▼                        ▼                        ▼
┌──────────────────┐   ┌──────────────────┐   ┌──────────────────┐
│   Supabase       │   │   Triplover      │   │   Cloudinary     │
│   (PostgreSQL)   │   │   API            │   │   (File Storage) │
│                  │   │   (Flight        │   │                  │
│   • app_users    │   │    Supplier)     │   │   • Logos        │
│   • agencies     │   │                  │   │   • Documents    │
│   • flight_      │   │   • Search       │   │                  │
│     bookings     │   │   • Book         │   └──────────────────┘
│   • wallet_*     │   │   • Cancel       │
│   • markup_rules │   │   • Ticket       │
│                  │   │   • PNR          │
└──────────────────┘   └──────────────────┘
```

### Technology Stack

| Layer | Technology | Purpose |
|-------|-----------|---------|
| **Frontend Framework** | Next.js 16.2.11 | React framework with App Router |
| **UI Components** | React 18.2.0, Radix UI, Tailwind CSS | Component library and styling |
| **Authentication** | Clerk 7.6.1 | User authentication and session management |
| **Database** | Supabase (PostgreSQL 17) | Primary data storage |
| **Supplier API** | Triplover API | Flight search and booking |
| **File Storage** | Cloudinary | Logo and document storage |
| **Email** | Nodemailer | Transactional email delivery |
| **Form Validation** | Zod 3.23.8, React Hook Form | Client and server validation |
| **PDF Generation** | PDFKit 0.19.1 | Ticket and receipt generation |

---

## 2. Component Organization and Relationships

### Directory Structure

```
app/
├── (auth)/                    # Authentication route group
│   ├── layout.tsx            # Auth layout (public)
│   ├── sign-in/[[...sign-in]]/page.tsx
│   └── sign-up/[[...sign-up]]/page.tsx
├── (dashboard)/               # Protected dashboard route group
│   ├── layout.tsx            # Dashboard layout (requires auth)
│   ├── actions.ts            # Shared server actions
│   └── dashboard/            # Dashboard pages
│       ├── page.tsx          # Dashboard home
│       ├── [section]/page.tsx # Section-based routing
│       ├── bookings/         # Booking management
│       ├── markup/           # Markup configuration
│       ├── profile/          # User profile
│       ├── users/            # User management
│       └── wallet/           # Wallet and deposits
├── api/                       # API routes
│   ├── flights/              # Flight booking APIs
│   │   ├── search/route.ts
│   │   ├── booking/*/route.ts
│   │   ├── fare-rules/route.ts
│   │   └── reprice/route.ts
│   ├── wallet/               # Wallet management APIs
│   │   ├── route.ts
│   │   ├── deposits/route.ts
│   │   ├── adjustments/route.ts
│   │   └── reports/route.ts
│   ├── reports/              # Reporting APIs
│   └── webhooks/             # Webhook handlers
├── flights/                   # Flight booking pages
│   ├── page.tsx              # Search results
│   ├── checkout/page.tsx     # Booking checkout
│   └── booking/resume/page.tsx
├── invite/[invitationId]/    # Invitation acceptance
└── layout.tsx                # Root layout with ClerkProvider

components/
├── dashboard/                # Dashboard UI components
│   ├── DashboardShell.tsx    # Main dashboard layout
│   ├── DashboardSidebar.tsx  # Navigation sidebar
│   ├── DashboardTopbar.tsx   # Top navigation bar
│   └── ...                   # Feature-specific components
├── flights/                  # Flight booking UI components
│   ├── FlightResults.tsx     # Search results container
│   ├── ItineraryCard.tsx     # Flight offer card
│   ├── BookingCheckout.tsx   # Checkout form
│   └── ...                   # Flight-specific components
├── auth/                     # Authentication UI components
└── layout/                   # Shared layout components

lib/
├── db/                       # Database access layer
│   ├── users.ts              # User queries
│   ├── agencies.ts           # Agency queries
│   ├── flight-bookings.ts    # Booking queries
│   ├── wallet.ts             # Wallet queries
│   └── ...                   # Other table access
├── flights/                  # Flight domain logic
│   ├── booking.ts            # Booking types and helpers
│   ├── booking-status.ts     # Status computation
│   ├── search-params.ts     # Search parameter handling
│   ├── search-cache.ts       # Search result caching
│   └── types.ts              # Flight domain types
├── triplover/                # Triplover API integration
│   ├── client.ts             # HTTP client and auth
│   ├── search.ts             # Search endpoint
│   ├── book.ts               # Booking endpoint
│   ├── cancel.ts             # Cancellation endpoint
│   └── ...                   # Other endpoints
├── wallet/                   # Wallet domain logic
│   ├── permissions.ts        # Wallet access control
│   ├── payment-options.ts    # Payment method handling
│   └── money.ts              # Currency utilities
├── dashboard/                # Dashboard utilities
│   ├── session.ts            # Session management
│   ├── sub-user-guard.ts     # Sub-user authorization
│   └── user-roster.ts        # User listing
├── email/                    # Email templates
├── airports/                 # Airport data and search
├── supabase/                 # Supabase client configuration
└── ...                       # Other utilities

supabase/
└── migrations/               # Database schema migrations
    ├── 0001_users_and_profiles.sql
    ├── 0002_agencies_and_sub_users.sql
    ├── 0016_booking_attempts.sql
    ├── 0017_booking_lifecycle.sql
    └── ...                   # Additional migrations
```

---

## 3. Frontend Architecture

### Next.js App Router Structure

The application uses Next.js 16 with the App Router, organized into route groups for logical separation:

#### Route Groups

| Route Group | Purpose | Authentication | Layout |
|-------------|---------|----------------|--------|
| `(auth)` | Sign-in/sign-up pages | Public | Auth-specific layout |
| `(dashboard)` | Dashboard pages | Protected (Clerk) | Dashboard layout with sidebar |
| `flights` | Flight search and booking | Mixed (public/search, protected/checkout) | Inherits root or dashboard layout |
| `api` | API endpoints | Mixed (varies by endpoint) | No layout |

#### Server vs Client Components

**Server Components (Default):**
- All pages in `app/` are server components by default
- Direct database access via `lib/db/` modules
- Session resolution via `getDashboardSession()`
- Metadata generation (SEO, OpenGraph)
- Server-only imports (marked with `'server-only'`)

**Client Components:**
- Interactive UI components in `components/`
- All components in `components/dashboard/` (client components)
- All components in `components/flights/` (client components)
- Explicitly marked with `'use client'` directive

**Key Server Components:**
- `app/layout.tsx` — Root layout with ClerkProvider
- `app/(dashboard)/layout.tsx` — Dashboard layout with session guard
- `app/flights/page.tsx` — Flight search results shell
- `app/(dashboard)/dashboard/*/page.tsx` — Dashboard pages

**Key Client Components:**
- `components/dashboard/DashboardShell.tsx` — Dashboard chrome
- `components/flights/FlightResults.tsx` — Search results (calls API from browser)
- `components/flights/ItineraryCard.tsx` — Flight offer card
- `components/flights/BookingCheckout.tsx` — Booking form

### Component Hierarchy

```
RootLayout (app/layout.tsx)
├── ClerkProvider
└── html/body
    ├── AuthLayout (app/(auth)/layout.tsx)
    │   └── SignIn/SignUp pages
    │
    └── DashboardLayout (app/(dashboard)/layout.tsx)
        ├── DashboardShell (client)
        │   ├── DashboardSidebar (client)
        │   ├── DashboardTopbar (client)
        │   └── main content
        │       ├── DashboardHome
        │       ├── BookingsPage
        │       ├── MarkupPage
        │       ├── ProfilePage
        │       └── ...
        │
        └── FlightsPage (app/flights/page.tsx)
            ├── FlightSearchModifier (client)
            └── FlightResults (client)
                ├── ItineraryCard (client)
                ├── FlightFilters (client)
                └── ...
```

### State Management

**Server State:**
- Database queries in server components
- Session state via `getDashboardSession()` (cached with React `cache`)
- No server-side state mutation from client components

**Client State:**
- React `useState` for UI state (modals, drawers, form fields)
- React Hook Form for form state
- No global state management library (Redux, Zustand) — uses component composition

**Data Fetching:**
- Server components: Direct database queries
- Client components: API routes (`app/api/`)
- Server actions for mutations (form submissions, updates)

---

## 4. Backend Architecture

### API Routes Organization

API routes are organized by domain under `app/api/`:

#### Flight Booking APIs (`app/api/flights/`)

| Route | Method | Purpose | Authentication |
|-------|--------|---------|----------------|
| `/api/flights/search` | POST | Search flights from Triplover | Public (rate-limited) |
| `/api/flights/reprice` | POST | Verify fare and apply markup | Protected |
| `/api/flights/booking/prepare` | POST | Create booking attempt | Protected |
| `/api/flights/booking/draft` | GET/POST | Read/update booking draft | Protected (token-based) |
| `/api/flights/booking` | POST | Submit booking to supplier | Protected (token-based) |
| `/api/flights/booking/status` | GET | Get booking status | Protected |
| `/api/flights/booking/cancel` | POST | Cancel booking | Protected |
| `/api/flights/booking/issue` | POST | Issue ticket (wallet) | Protected |
| `/api/flights/booking/refresh-details` | POST | Refresh booking from PNR | Protected |
| `/api/flights/fare-rules` | POST | Get fare rules | Protected |

#### IMP/EXP APIs (`app/api/impexp/`)

| Route | Method | Purpose | Authentication |
|-------|--------|---------|----------------|
| `/api/impexp/preview-booking` | POST | Retrieve normalized supplier booking and Supplier Gross | Superadmin/Admin/Support |
| `/api/impexp/authorize-charge` | POST | Non-financial prior Import & Charge authorization | Superadmin/Admin/Support |
| `/api/impexp/import-booking` | POST | Explicit Import Only or authorized Import & Charge | Superadmin/Admin/Support |
| `/api/impexp/confirm-booking` | GET/POST | Preview wallet and capture held import | Exact assigned customer/agency owner |
| `/api/impexp/sync-booking` | POST | Record supplier evidence/route case without charging | Superadmin/Admin/Support |
| `/api/impexp/complete-booking` | POST | Complete from fresh tickets without another debit | Superadmin/Admin/Support |
| `/api/impexp/financial-disposition` | POST | Maker-checker failure disposition | Accounts/Admin/Superadmin |
| `/api/impexp/history` | GET | List imported records | Superadmin/Admin/Support |
| `/api/impexp/users` | GET | List valid assignment targets | Superadmin/Admin/Support |

The API routes retrieve/normalize external evidence; database RPCs remain the
authority for owner resolution, pricing persistence, lifecycle mutation,
wallet capture, immutable ledger attribution, and idempotency.

#### Staff Lifecycle APIs (`app/api/admin/booking-lifecycle/`)

Read routes expose masked booking operation/case rows, aged attempt cases,
timelines, and PII-free metrics. Case-bound write routes acquire normalized
supplier evidence, record a non-issuance attestation, submit a domain-scoped
proposal, and approve/reject with a different Admin/Super Admin. There is no
generic Set Status or Move Money API; exact database contracts execute only the
approved named consequence.

#### Wallet APIs (`app/api/wallet/`)

| Route | Method | Purpose | Authentication |
|-------|--------|---------|----------------|
| `/api/wallet` | GET | Get wallet summary | Protected |
| `/api/wallet/ledger` | GET | Get wallet ledger | Protected |
| `/api/wallet/deposits` | GET/POST | List/create deposit requests | Protected |
| `/api/wallet/deposits/[id]` | PATCH | Approve/reject deposit | Protected (admin) |
| `/api/wallet/adjustments` | GET/POST | List/create adjustment requests | Protected |
| `/api/wallet/adjustments/[id]` | PATCH | Approve/reject adjustment | Protected (admin) |
| `/api/wallet/refunds` | POST | Process refund | Protected |
| `/api/wallet/reports` | GET | Wallet reports | Protected (admin) |
| `/api/wallet/company-bank-accounts` | GET/POST | Manage bank accounts | Protected (admin) |
| `/api/wallet/company-mfs-accounts` | GET/POST | Manage MFS accounts | Protected (admin) |

#### Reporting APIs (`app/api/reports/`)

| Route | Method | Purpose | Authentication |
|-------|--------|---------|----------------|
| `/api/reports/issued-tickets` | GET | Export issued tickets | Protected (admin) |

### Business Logic Layer

The business logic layer is organized in `lib/` by domain:

#### Database Access (`lib/db/`)

Each module in `lib/db/` provides typed access to a specific table or domain:

- **`users.ts`** — User record management (`app_users` table)
- **`agencies.ts`** — Agency record management (`agencies` table)
- **`profiles.ts`** — User profile management (`user_profiles` table)
- **`staff.ts`** — Staff details management (`staff_details` table)
- **`sub-users.ts`** — Sub-user management
- **`upgrade-requests.ts`** — B2B upgrade request workflow
- **`flight-bookings.ts`** — Booking queries and lifecycle view
- **`booking-attempts.ts`** — Booking attempt management
- **`booking-operations.ts`** — Durable operation claims/finalization
- **`booking-reconciliation-evidence.ts`** — Case-bound immutable observations
- **`booking-reconciliation-actions.ts`** — Proposal/decision/attestation wrappers
- **`booking-lifecycle.ts`**, **`booking-lifecycle-timeline.ts`**, and
  **`booking-lifecycle-metrics.ts`** — staff read models
- **`booking-notifications.ts`** — outbox/per-recipient delivery claims
- **`wallet.ts`** — Wallet account and ledger queries
- **`markup-rules.ts`** — Markup rule queries
- **`document-uploads.ts`** — Document reference management

**Pattern:**
- All functions are marked with `'server-only'`
- Use `supabaseAdmin()` for service-role access
- Return typed domain objects (not raw database rows)
- Include error handling and logging

Imported-booking database access is centralized in `lib/db/impexp.ts`, which
wraps the atomic create/re-import and non-financial Sync RPCs. Imported payment
confirmation uses the controlled wallet wrapper in `lib/db/wallet.ts`.

#### Domain Logic (`lib/flights/`, `lib/wallet/`)

**Flight Domain (`lib/flights/`):**
- **`booking.ts`** — Booking types (`BookingTraveller`, `BookingContact`, `PublicBooking`)
- **`booking-status.ts`** — Status computation (`deriveBookingStatus`, seven business statuses)
- **`search-params.ts`** — Search parameter encoding/decoding
- **`search-cache.ts`** — Shared Redis authority for short-lived Search/RePrice references
- **`pricing-principal.ts`** — Pricing audience resolution (B2C vs B2B)
- **`types.ts`** — Flight domain types (`FlightItinerary`, `FareBreakdown`, etc.)
- **`cabin.ts`** — Cabin class definitions
- **`upsells.ts`** — Upsell option grouping

**Wallet Domain (`lib/wallet/`):**
- **`permissions.ts`** — Wallet access control (`walletOwnerForSession`)
- **`payment-options.ts`** — Payment method resolution
- **`money.ts`** — Currency and amount utilities
- **`http.ts`** — Wallet API HTTP helpers

**IMP/EXP Domain (`lib/impexp/`):**
- **`providers.server.ts`** — Approved provider routing and direct airline retrieval
- **`normalize.ts`** — Supplier page data to canonical booking shape
- **`validation.ts`** — Lookup, assignment, User Payable, and passenger validation
- **Provider adapters** — Server-side Chromium workflows for TTInteractive and NOVOAIR

#### Supplier Integration (`lib/triplover/`)

The Triplover API integration is encapsulated in `lib/triplover/`:

- **`client.ts`** — HTTP transport layer
  - Authentication (token caching, single-flight login)
  - Request/response handling with timeout
  - Retry policy (operations marked as retry-safe)
  - Error classification (`TriploverError` with `kind`)

- **`search.ts`** — Search endpoint integration
  - Request building from `FlightSearchInput`
  - Response mapping to domain types
  - Markup application
  - Confirmed Redis quote persistence before public Search results

- **`book.ts`** — Booking endpoint integration
- **`cancel.ts`** — Cancellation endpoint integration
- **`ticket.ts`** — Ticket issuance endpoint integration
- **`reprice.ts`** — Reprice endpoint integration
- **`fare-rules.ts`** — Fare rules endpoint integration
- **`pnr.ts`** — PNR lookup endpoint integration
- **`air-ticketing-details.ts`** — Air ticketing details endpoint
- **`config.ts`** — Configuration and environment validation

**Pattern:**
- All modules marked with `'server-only'`
- Domain types (not supplier types) in function signatures
- Defensive parsing of supplier responses
- Error handling with `TriploverError`

#### Session Management (`lib/dashboard/`)

- **`session.ts`** — Session resolution
  - `getDashboardSession()` — Returns `DashboardSession` with role, agency, etc.
  - Cached with React `cache` to avoid duplicate queries
  - Handles Clerk session deletion gracefully
  - Dev role switcher support (production-safe)

- **`sub-user-guard.ts`** — Sub-user authorization guards
- **`user-roster.ts`** — User listing and filtering
- **`auth-errors.ts`** — Authentication error classification

### Server Actions

Server actions are used for form submissions and mutations:

**Location:** `app/(dashboard)/actions.ts` and `app/(dashboard)/dashboard/*/actions.ts`

**Pattern:**
- Marked with `'use server'`
- Extract user ID from session (never from request body)
- Perform validation with Zod
- Update database via `lib/db/` modules
- Revalidate paths with `revalidatePath()`
- Return success/error responses

**Example:** Dev role switcher (`app/(dashboard)/actions.ts`)
```typescript
export async function setDevRole(role: string) {
  if (!IS_DEV) return;
  const { userId } = await auth();
  if (!userId) return;
  const store = await cookies();
  store.set(DEV_ROLE_COOKIE, `${userId}:${resolveRole(role)}`, { path: '/' });
  revalidatePath('/dashboard', 'layout');
}
```

---

## 5. Database Architecture

### Supabase Configuration

**Provider:** Supabase (PostgreSQL 17 + PostgREST)
**Project Ref:** `gvbovgdjqmskcjgowppa`
**Region:** `ap-southeast-1` (Singapore)

### Access Model

**Critical Security Principle:**
- **RLS is enabled on every table, with no policies.** This denies `anon` and `authenticated` outright.
- **Only the server touches Postgres**, using `SUPABASE_SERVICE_ROLE_KEY`, which bypasses RLS.
- **No browser ever queries the database.** All database access goes through server components or API routes.
- **Server actions take the user id from the session, never from the payload.**

**Implementation:** `lib/supabase/server.ts`
```typescript
export function supabaseAdmin(): SupabaseClient | null {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceKey) return null;
  cached ??= createClient(url, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return cached;
}
```

### Schema Organization

#### Core Tables

| Table | Purpose | Primary Key | Key Relationships |
|-------|---------|-------------|------------------|
| `app_users` | User registry (mirrors Clerk) | `clerk_id` | → `user_profiles`, `staff_details` |
| `user_profiles` | User profile form data | `clerk_id` | FK → `app_users` (cascade) |
| `agencies` | B2B agency records | `agency_code` | `ST-B2B######` format |
| `staff_details` | Sub-user employment details | `user_id` | FK → `app_users` (cascade) |
| `upgrade_requests` | B2B upgrade applications | `id` (UUID) | FK → `app_users` (cascade) |
| `markup_rules` | Pricing markup rules | `id` (UUID) | — |
| `flight_search_quotes` | Search result cache | `id` (UUID) | 20-minute TTL |
| `booking_attempts` | Booking operational data | `id` (UUID) | FK → `flight_bookings` |
| `flight_bookings` | Booking business records | `id` (UUID) | FK → `booking_attempts` |
| `booking_operations` | Durable irreversible/manual work | `id` (UUID) | FK → `flight_bookings` |
| `booking_reconciliation_cases` | Owned booking/attempt uncertainty | `id` (UUID) | FK → booking or attempt, optional operation |
| `booking_reconciliation_observations` | Immutable normalized evidence | `id` (UUID) | FK → case/booking/operation |
| `booking_status_events` | Occurrence-aware immutable history | `id` (bigint) | FK → booking/operation/case |
| `booking_notification_outbox` | Transactional event delivery intent | `id` (UUID) | FK → event/booking |
| `booking_notification_deliveries` | Per-recipient independent delivery | `id` (UUID) | FK → outbox |
| `booking_lifecycle_worker_runs` | PII-free bounded sweep evidence | `id` (UUID) | — |

#### Wallet Tables

| Table | Purpose | Primary Key | Key Relationships |
|-------|---------|-------------|------------------|
| `wallets` | Wallet identity and status | `id` (UUID) | — |
| `wallet_accounts` | Per-currency accounts | `id` (UUID) | FK → `wallets` |
| `wallet_ledger_entries` | Immutable transaction ledger | `id` (UUID) | FK → `wallet_accounts` |
| `wallet_reservations` | Hold reservations | `id` (UUID) | FK → `wallet_accounts`, `flight_bookings` |
| `deposit_requests` | Deposit workflow | `id` (UUID) | FK → `wallet_accounts` |
| `adjustment_requests` | Adjustment workflow | `id` (UUID) | FK → `wallet_accounts` |
| `wallet_payment_branches` | Bank branches for deposits | `id` (UUID) | — |
| `wallet_company_bank_accounts` | Company bank accounts | `id` (UUID) | — |
| `wallet_company_mfs_accounts` | Company MFS accounts | `id` (UUID) | — |

#### Important Views

| View | Purpose | Notes |
|------|---------|-------|
| `booking_lifecycle_v` | Booking status with computed fields | Computes `Expired` and `Unconfirmed` statuses |
| `booking_lifecycle_staff_v` | Staff operation/case/SLA truth | Excludes passenger/raw evidence |
| `booking_lifecycle_timestamps_v` | Exact timestamp provenance | Unknown facts remain NULL |
| `booking_lifecycle_metrics_v` | Aggregate case/operation health | Service role only |
| `booking_notification_metrics_v` | Aggregate outbox/delivery health | No addresses |
| `booking_derived_lifecycle_metrics_v` | Expiry/backlog/worker health | No booking identities |
| `wallet_report_v` | Wallet summary for reporting | Aggregates balances across accounts |

### Migration Strategy

**Location:** `supabase/migrations/`

**Naming:** `<timestamp>_<description>.sql`

**Rules:**
1. **Idempotent** — Use `CREATE OR REPLACE`, `DROP IF EXISTS`
2. **Forward-only** — Never edit applied migrations; fix with new migration
3. **Enable RLS** on every new table with no policies
4. **Column naming** — Snake_case matches app field names
5. **Nullable fields** — Store blanks as `NULL`, not `''`
6. **Updated trigger** — Add `touch_updated_at()` trigger to tables with `updated_at`

**Application:** `supabase db push --linked`

### Data Flow Pattern

**Read Path:**
```
Server Component → lib/db/<table>.ts → supabaseAdmin() → PostgreSQL
```

**Write Path:**
```
Server Action / API Route → typed lib/db adapter → narrow SECURITY DEFINER RPC
  → locked PostgreSQL transaction → event/outbox
```

**Pattern:** All database access goes through typed `lib/db/` modules; no direct Supabase calls in components.

---

## 6. Data Flow Between Components

### Flight Search Flow

```
User (Browser)
    │
    ├─ Enters search criteria in FlightSearchForm (client component)
    │
    ▼
POST /api/flights/search
    │
    ├─ Validates request (Zod schema)
    ├─ Checks rate limit (per-actor)
    ├─ Resolves pricing principal (B2C vs B2B)
    ├─ Calls lib/triplover/search.ts
    │   ├─ Builds Triplover request
    │   ├─ Calls Triplover API (via lib/triplover/client.ts)
    │   ├─ Maps response to domain types
    │   ├─ Applies markup rules (lib/markup.ts)
    │   └─ Stores in flight_search_quotes (lib/flights/search-cache.ts)
    │
    ▼
Returns FlightSearchResult
    │
    ▼
FlightResults (client component)
    │
    ├─ Renders ItineraryCard for each offer
    ├─ User clicks "Verify" on an offer
    │
    ▼
POST /api/flights/reprice
    │
    ├─ Retrieves stored quote
    ├─ Calls Triplover RePrice endpoint
    ├─ Updates quote with reprice data
    │
    ▼
Returns reprice data with updated pricing
    │
    ▼
User clicks "Select" → POST /api/flights/booking/prepare
    │
    ├─ Creates booking_attempts row (draft state)
    ├─ Returns attempt ID and access token
    │
    ▼
Redirects to /flights/checkout?attemptId=...
```

### Booking Flow

```
/flights/checkout (server component)
    │
    ├─ Loads booking attempt by ID + token
    ├─ Renders BookingCheckout (client component)
    │
    ▼
User enters traveller details → POST /api/flights/booking/draft
    │
    ├─ Validates data (Zod)
    ├─ Updates booking_attempts with passenger snapshot
    │
    ▼
User clicks "Confirm" → POST /api/flights/booking
    │
    ├─ Claims draft (optimistic lock: draft → submitting)
    ├─ Calls Triplover Book endpoint (lib/triplover/book.ts)
    │   ├─ success: Call Postgres function to:
    │   │   ├─ Allocate public_ref (STRYYMMDD######)
    │   │   ├─ Insert flight_bookings row
    │   │   └─ Update booking_attempts (succeeded)
    │   └─ definitive failure: Update booking_attempts (failed)
    │       ambiguous/lost response: attempt unknown + owned attempt case
    │
    ▼
Redirects to /dashboard/bookings/[reference]
```

### Wallet Deposit Flow

```
User submits deposit request → POST /api/wallet/deposits
    │
    ├─ Validates request (Zod)
    ├─ Creates deposit_requests row (status: pending)
    ├─ If cash/bank/cheque: Requires document upload
    │
    ▼
Admin reviews request → PATCH /api/wallet/deposits/[id]
    │
    ├─ Validates approval permissions
    ├─ Calls Postgres function to:
    │   ├─ Lock request and wallet account
    │   ├─ Settle balance (available += amount)
    │   ├─ Append ledger entry (transaction_type: deposit)
    │   └─ Mark request approved
    │
    ▼
Returns updated deposit request
```

### Ticket Issuance Flow

```
Admin clicks "Issue Ticket" → POST /api/flights/booking/issue
    │
    ├─ Validates actor permissions
    ├─ Calls Postgres function to:
    │   ├─ Lock booking and claim durable ticketing operation
    │   ├─ Lock reservation/wallet/account in global order
    │   ├─ Validate airline PNR, deadline, wallet status, funds
    │   ├─ Move available → hold balance
    │   ├─ Append ledger entry (transaction_type: booking_hold)
    │   └─ Claim booking status (on-hold → in-progress)
    │
    ├─ Calls Triplover NewTicket endpoint (outside transaction)
    │   ├─ success: Call Postgres function to:
    │   │   ├─ Reduce hold balance
    │   │   ├─ Append ledger entry (transaction_type: booking_confirm)
    │   │   └─ Update booking (confirmed, issued_at)
    │   ├─ definitive non-issuance: atomic release/failure event
    │   └─ ambiguous outcome: keep hold + operation/case reconciliation;
    │       never replay NewTicket blindly
    │
    ▼
Returns booking with updated status
```

### Imported Booking Flow

```text
Operations Retrieve & Review -> direct airline Manage Booking adapter
    -> normalize supplier evidence and Supplier Gross
    -> require assigned B2C/B2B user plus explicit User Payable
    -> create_impexp_booking_v2 transaction
       -> Held: On Hold + Unpaid, no wallet movement
       -> Ticketed Import Only: Confirmed/Unpaid + Accounts case, no debit
       -> Ticketed Import & Charge: consume prior authorization + one debit

Assigned owner Confirm & Pay on Held import
    -> wallet_confirm_impexp_booking transaction
    -> debit User Payable once + ledger + In Progress/Captured
    -> create Support operation/case with due time and escalation

Operations Sync
    -> retrieve supplier again
    -> sync_impexp_booking_v2 stores evidence and routes the case
    -> never calls wallet/ledger mutation

Operations Complete
    -> fresh identity-matching ticket observation required
    -> Confirmed + completed operation/case/event/outbox
    -> no additional debit/reservation/ledger mutation
```

The operator/actor and booking/financial owner stay separate across every
layer. Provider/reference identity, database locks, and a stable payment key
make import and payment replay-safe.

The browser adapter is also a hard external boundary. A supplied Manage Booking
URL is validated and forwarded as a URL only; the server-side context does not
inherit the operator's cookies, browser profile, device verification, or IP.
Airline Device Check/CAPTCHA evidence therefore terminates preview with a
controlled upstream error instead of attempting to bypass the supplier's
security control.

Booking presentation has a separate projection rule: imported web tickets,
downloadable tickets, and confirmation emails use the stored Supplier Gross and
supplier fare rows as the ticket face value. Wallet/payment reporting continues
to use protected User Payable.

---

## 7. Key Architectural Patterns

### 1. Server-First Data Access

**Pattern:** All database access is server-side only.

**Rationale:**
- Security: Service-role key never exposed to browser
- Performance: Server components can query database directly
- Simplicity: No client-side Supabase configuration needed

**Implementation:**
- `'server-only'` marker on all `lib/db/` and `lib/triplover/` modules
- `supabaseAdmin()` returns null if env vars missing (graceful degradation)
- No `'use client'` files import database modules

### 2. Route Groups for Logical Separation

**Pattern:** Use Next.js route groups `(auth)`, `(dashboard)` for logical organization without affecting URL structure.

**Rationale:**
- Clear separation of concerns (auth vs dashboard vs public)
- Shared layouts within groups
- No URL path changes (parentheses are not part of the URL)

**Implementation:**
- `app/(auth)/` — Public authentication pages
- `app/(dashboard)/` — Protected dashboard pages
- `app/flights/` — Flight booking (mixed auth)

### 3. Session-Based Authorization

**Pattern:** User identity resolved from Clerk session, stored in `DashboardSession`, passed to business logic.

**Rationale:**
- Single source of truth for user identity
- Cached with React `cache` to avoid duplicate queries
- Handles session deletion gracefully

**Implementation:**
- `getDashboardSession()` in `lib/dashboard/session.ts`
- Returns `clerkId`, `role`, `agencyCode`, `isAgencyOwner`
- Used in all protected pages and API routes

### 4. Optimistic Locking for Bookings

**Pattern:** Booking status transitions use optimistic locking (`WHERE status='draft' AND expires_at > now()`).

**Rationale:**
- Prevents duplicate booking submissions
- Handles concurrent updates safely
- No need for distributed locks

**Implementation:**
- `claimBookingDraft()` in booking flow
- `WHERE status='draft' AND expires_at > now()` ensures only one claim succeeds
- See [BOOKING_ARCHITECTURE.md](../BOOKING_ARCHITECTURE.md) for details

### 5. Immutable Ledger for Wallet

**Pattern:** Wallet ledger entries are immutable; corrections are new entries, not updates.

**Rationale:**
- Audit trail is preserved
- Postgres triggers prevent updates/deletes
- Financial accuracy guaranteed

**Implementation:**
- `wallet_ledger_entries` table with update/delete triggers
- Corrections via new approved adjustments or reversals
- See [WALLET_ARCHITECTURE.md](../WALLET_ARCHITECTURE.md) for details

### 6. Supplier Abstraction Layer

**Pattern:** Triplover API integration is encapsulated in `lib/triplover/` with domain types.

**Rationale:**
- Supplier-specific code isolated
- Easy to add new suppliers in future
- Defensive parsing of supplier responses

**Implementation:**
- `lib/triplover/client.ts` — HTTP transport and auth
- Domain types in function signatures (not supplier types)
- Error classification with `TriploverError`

### 7. Computed Business Statuses

**Pattern:** Some booking statuses are computed (Expired, Unconfirmed) rather than stored.

**Rationale:**
- Expired status depends on deadline (can be extended by supplier)
- Unconfirmed status depends on airline PNR (can appear later)
- Computed status self-corrects over time

**Implementation:**
- SQL view `booking_lifecycle_v` computes statuses
- Only five statuses stored: `on-hold`, `pending`, `in-progress`, `confirmed`, `cancelled`
- History tracked in `booking_status_events`
- Operation progress and uncertainty are tracked in `booking_operations` and
  `booking_reconciliation_cases`, not encoded as additional public statuses

### 8. Search Result Caching

**Pattern:** Search results cached in `flight_search_quotes` with 20-minute TTL.

**Rationale:**
- Supplier API is slow (up to 57 seconds)
- Caching reduces load on supplier
- Enables reprice without re-searching

**Implementation:**
- `lib/flights/search-cache.ts` manages cache
- Stored with supplier references and pricing snapshot
- Expires after 20 minutes; reprice required after expiry

### 9. Markup Rule Engine

**Pattern:** Markup rules stored in database, applied at search time based on audience, airline, and route.

**Rationale:**
- Flexible pricing without code changes
- Different markups for B2C vs B2B
- Route-specific and airline-specific rules

**Implementation:**
- `lib/markup.ts` applies markup rules
- `lib/db/markup-rules.ts` queries active rules
- See [MARKUP.md](../MARKUP.md) for details

### 10. Rate Limiting

**Pattern:** Per-actor rate limiting for expensive operations (search, booking).

**Rationale:**
- Prevents abuse of slow supplier API
- Protects against automated attacks
- Fair resource allocation

**Implementation:**
- `lib/rate-limit.ts` implements in-memory counters
- `checkActionLimit()` checks limits before operation
- Actor key derived from IP address or user ID

---

## 8. Component Responsibilities

### Frontend Components

| Component | Responsibility | Server/Client |
|-----------|----------------|---------------|
| `DashboardShell` | Dashboard chrome (sidebar, topbar, mobile drawer) | Client |
| `DashboardSidebar` | Navigation menu, role-specific links | Client |
| `DashboardTopbar` | User menu, wallet balance, sidebar toggle | Client |
| `FlightResults` | Flight search results container, calls search API | Client |
| `ItineraryCard` | Individual flight offer display, verify/select actions | Client |
| `BookingCheckout` | Traveller form, contact form, submit booking | Client |
| `BookingDetails` | Booking confirmation display, ticket download | Client |
| `ImpExpPage` | Retrieve/review/import UI with mandatory assignment and separate prices | Client |
| `AuthPanelHeading` | Authentication page headings | Client |
| `UserMenu` | User dropdown menu (sign out, profile) | Client |

### Backend Modules

| Module | Responsibility | Key Functions |
|--------|----------------|---------------|
| `lib/db/users.ts` | User record CRUD | `recordUserVisit()`, `listUsers()` |
| `lib/db/agencies.ts` | Agency record CRUD | `resolveAgency()`, `listAgencies()` |
| `lib/db/flight-bookings.ts` | Booking queries | `listBookings()`, `getBookingByRef()` |
| `lib/db/wallet.ts` | Wallet operations | `ensureSessionWallet()`, `listAccountLedger()` |
| `lib/db/impexp.ts` | Imported booking operations | `saveImportedBooking()`, `syncImportedBooking()` |
| `lib/impexp/*` | Direct airline retrieval and normalization | `retrieveImportBooking()`, `normalizeSupplierBooking()` |
| `lib/triplover/client.ts` | HTTP transport, auth | `triploverCall()`, `getToken()` |
| `lib/triplover/search.ts` | Search integration | `searchFlights()`, `buildSearchRequest()` |
| `lib/triplover/book.ts` | Booking integration | `bookFlight()` |
| `lib/flights/booking-status.ts` | Status computation | `deriveBookingStatus()` |
| `lib/dashboard/session.ts` | Session management | `getDashboardSession()` |
| `lib/markup.ts` | Markup application | `priceOffer()`, `selectMarkupRules()` |
| `lib/wallet/permissions.ts` | Wallet access control | `walletOwnerForSession()` |

### API Routes

| Route | Responsibility | Key Operations |
|-------|----------------|----------------|
| `/api/flights/search` | Flight search | Validate, rate limit, call Triplover, cache results |
| `/api/flights/booking/prepare` | Create booking attempt | Validate, create booking_attempts row |
| `/api/flights/booking` | Submit booking | Claim draft, call Triplover Book, create booking |
| `/api/wallet/deposits` | Deposit requests | Create, list, approve/reject deposits |
| `/api/wallet/adjustments` | Adjustment requests | Create, list, approve/reject adjustments |
| `/api/flights/booking/issue` | Ticket issuance | Reserve funds, call Triplover NewTicket, settle |
| `/api/impexp/import-booking` | Imported booking creation | Re-retrieve, validate owner/prices, call atomic import RPC |
| `/api/impexp/confirm-booking` | Imported held payment | Owner authorization, atomic User Payable capture |
| `/api/impexp/sync-booking` | Imported supplier refresh | Non-financial authoritative field update |

---

## 9. Communication Patterns

### Server Component → Database

**Pattern:** Direct synchronous calls via `lib/db/` modules.

```typescript
// In a server component
import { listBookings } from '@/lib/db/flight-bookings';

const bookings = await listBookings(scope);
```

**Characteristics:**
- Synchronous (await)
- No client exposure
- Type-safe (returns domain types)

### Client Component → API Route

**Pattern:** `fetch()` calls to API routes.

```typescript
// In a client component
const response = await fetch('/api/flights/search', {
  method: 'POST',
  body: JSON.stringify(searchInput),
});
const data = await response.json();
```

**Characteristics:**
- Asynchronous
- JSON request/response
- Error handling required

### Server Action → Database

**Pattern:** Server actions call `lib/db/` modules directly.

```typescript
'use server';

import { updateProfile } from '@/lib/db/profiles';
import { auth } from '@clerk/nextjs/server';

export async function updateMyProfile(data: ProfileData) {
  const { userId } = await auth();
  await updateProfile(userId, data);
  revalidatePath('/dashboard/profile');
}
```

**Characteristics:**
- Server-only (marked with `'use server'`)
- User ID from session, not request body
- Path revalidation after mutation

### API Route → Supplier API

**Pattern:** API routes call `lib/triplover/` modules.

```typescript
// In an API route
import { searchFlights } from '@/lib/triplover/search';

const result = await searchFlights(searchInput, pricingPrincipal);
```

**Characteristics:**
- Synchronous (await)
- Error handling with `TriploverError`
- Timeout handling (long-running operations)

### Server Component → Supplier API

**Pattern:** Rare; typically done via API route for consistency.

**Exception:** Some server components may call supplier directly for pre-fetching.

### Email Sending

**Pattern:** Server actions or API routes call `lib/email/` modules.

```typescript
import { sendBookingConfirmation } from '@/lib/email/booking-confirmation';

await sendBookingConfirmation(recipients, bookingData);
```

**Characteristics:**
- Asynchronous (fire-and-forget)
- Template-based (lib/email/templates.ts)
- Error logging

---

## 10. Important Architectural Decisions and Rationale

### 1. No Direct Database Access from Browser

**Decision:** RLS enabled with no policies; only server touches database via service-role key.

**Rationale:**
- **Security:** Service-role key never exposed to client
- **Simplicity:** No need to manage RLS policies for every table
- **Performance:** Server components can query directly without round-trips
- **Auditability:** All database access goes through typed modules

**Trade-off:** Cannot use Supabase real-time features (not needed for this application).

### 2. Booking Status Computation vs Storage

**Decision:** Computed statuses (Expired, Unconfirmed) vs stored statuses (On Hold, Pending, In Progress, Confirmed, Cancelled).

**Rationale:**
- **Expired:** Supplier can extend deadlines; stored status would be wrong
- **Unconfirmed:** Airline PNR can appear later; stored status would be wrong
- **Single source of truth:** SQL view ensures consistent computation

**Trade-off:** Slightly more complex status queries (use view, not table).

### 3. Separate Booking Attempts and Bookings Tables

**Decision:** `booking_attempts` (operational) vs `flight_bookings` (business).

**Rationale:**
- **Clean separation:** Operational draft/submitting states never shown as bookings
- **Durability:** Attempt rows persist even if supplier call fails
- **Recoverability:** Orphaned PNRs can be recovered from attempt rows
- **Prunability:** Old attempts can be deleted without affecting business records
- **Owned uncertainty:** An aged `submitting`/`unknown` attempt receives an
  attempt-level case and is never fabricated into a public booking

**Trade-off:** More complex booking flow (two tables instead of one).

**Reference:** [BOOKING_ARCHITECTURE.md](../BOOKING_ARCHITECTURE.md)

### 4. Immutable Wallet Ledger

**Decision:** Ledger entries cannot be updated or deleted; corrections are new entries.

**Rationale:**
- **Audit trail:** Complete history preserved
- **Financial accuracy:** No risk of tampering
- **Regulatory compliance:** Clear audit trail for accounting

**Trade-off:** Slightly more complex correction logic (new entry instead of update).

**Reference:** [WALLET_ARCHITECTURE.md](../WALLET_ARCHITECTURE.md)

### 5. Sequential Public Booking References

**Decision:** Human-readable sequential references (STRYYMMDD######) allocated after supplier confirmation.

**Rationale:**
- **Customer-friendly:** Easy to communicate and remember
- **Audit-friendly:** Gaps indicate failed bookings
- **Recoverability:** UUID used internally; reference for display only

**Trade-off:** Requires counter table and row locking (but lock held for microseconds, not during supplier call).

**Reference:** [BOOKING_ARCHITECTURE.md](../BOOKING_ARCHITECTURE.md) §2.4

### 6. Search Result Caching with 20-Minute TTL

**Decision:** Cache search results in `flight_search_quotes` with 20-minute expiry.

**Rationale:**
- **Performance:** Supplier API is slow (up to 57 seconds)
- **Cost:** Reduces supplier API calls
- **User experience:** Reprice faster than re-search

**Trade-off:** Stale data if supplier prices change rapidly (mitigated by reprice requirement).

### 7. Markup Rules in Database

**Decision:** Markup rules stored in database, not hardcoded.

**Rationale:**
- **Flexibility:** Pricing can change without deployment
- **Segmentation:** Different markups for B2C vs B2B
- **Granularity:** Route-specific and airline-specific rules

**Trade-off:** Slightly more complex pricing logic (rule resolution and application).

**Reference:** [MARKUP.md](../MARKUP.md)

### 8. Client-Side Flight Search

**Decision:** Flight search called from browser (client component), not server component.

**Rationale:**
- **User experience:** Server-rendered wait would leave user on previous page with no feedback
- **Timeout handling:** Supplier API can take up to 57 seconds; Vercel function timeout is 300s
- **Rate limiting:** Per-IP rate limiting possible for public endpoint

**Trade-off:** Exposes search API endpoint (mitigated by rate limiting and validation).

### 9. Clerk for Authentication

**Decision:** Use Clerk for authentication instead of custom implementation.

**Rationale:**
- **Security:** Battle-tested authentication provider
- **Features:** Built-in sign-in/sign-up, password reset, MFA
- **Simplicity:** No need to build auth infrastructure
- **Compliance:** SOC 2 compliant

**Trade-off:** Vendor dependency (mitigated by using standard OAuth flows).

### 10. Cloudinary for File Storage

**Decision:** Use Cloudinary for logo and document storage instead of Supabase Storage.

**Rationale:**
- **Image optimization:** Automatic resizing and optimization
- **CDN:** Global edge delivery
- **Authentication:** Signed URLs for secure access
- **Upload verification:** Server-side verification before storage

**Trade-off:** Additional service dependency (mitigated by storing only handles in database).

### 11. Server Actions for Mutations

**Decision:** Use Next.js server actions for form submissions instead of API routes where possible.

**Rationale:**
- **Simplicity:** No need to define API routes for simple mutations
- **Type safety:** Direct function calls with TypeScript
- **Performance:** No HTTP round-trip overhead
- **Form integration:** Works seamlessly with React Hook Form

**Trade-off:** Less explicit API surface (mitigated by keeping complex operations as API routes).

### 12. Dev Role Switcher

**Decision:** Dev-only role switcher for dashboard previewing.

**Rationale:**
- **Development efficiency:** Preview dashboard as different roles without multiple accounts
- **Testing:** Easy to test role-based UI differences
- **Production safety:** Disabled in production (checked at runtime)

**Trade-off:** Potential confusion if cookie persists (mitigated by scoping to user ID).

**Reference:** `lib/dashboard/session.ts`

### 13. Long Function Timeout for Search

**Decision:** Set `maxDuration = 300` for flight search API route.

**Rationale:**
- **Supplier latency:** Triplover search can take up to 57 seconds
- **Vercel limits:** Default function timeout is lower than supplier latency
- **User experience:** Better to wait than to fail with timeout

**Trade-off:** Higher Vercel costs (longer function execution time).

### 14. Single-Flight Token Cache

**Decision:** Module-scope token cache for Triplover authentication.

**Rationale:**
- **Performance:** Avoid login on every request
- **Concurrency:** Single-flight guard prevents multiple logins
- **Simplicity:** No need for shared cache (Redis, etc.)

**Trade-off:** Token not shared across instances (mitigated by low cost of extra login per cold start).

**Reference:** `lib/triplover/client.ts`

### 15. Defensive Supplier Response Parsing

**Decision:** Parse supplier responses defensively; drop malformed offers rather than guess.

**Rationale:**
- **Data integrity:** Wrong itinerary worse than shorter list
- **Safety:** Supplier responses are unevenly populated
- **Debugging:** Dropped offers are logged for investigation

**Trade-off:** Fewer results if supplier format changes (mitigated by logging and monitoring).

---

## Cross-References

### Related Documentation

- **[Database Guide](../DATABASE.md)** — Schema, migrations, and database access patterns
- **[Booking Architecture](../BOOKING_ARCHITECTURE.md)** — Booking lifecycle, status computation, and data flow
- **[Wallet Architecture](../WALLET_ARCHITECTURE.md)** — Financial system, ledger immutability, and payment flows
- **[Markup Configuration](../MARKUP.md)** — Pricing rules, markup resolution, and B2B vs B2C pricing
- **[Triplover API Documentation](../Triploaver_API_Documentation.md)** — Supplier API integration details

- **[IMP/EXP Booking Imports](17-IMP-EXP-IMPORTS.md)** — Direct airline imports, wallet capture, and Sync

### Key File Locations

| Concern | Location |
|---------|----------|
| Root layout | `app/layout.tsx` |
| Dashboard layout | `app/(dashboard)/layout.tsx` |
| Session management | `lib/dashboard/session.ts` |
| Database access | `lib/db/*.ts` |
| Supplier integration | `lib/triplover/*.ts` |
| Imported supplier integration | `lib/impexp/*.ts`, `lib/db/impexp.ts` |
| Flight domain logic | `lib/flights/*.ts` |
| Wallet domain logic | `lib/wallet/*.ts` |
| API routes | `app/api/**/*.ts` |
| Server actions | `app/(dashboard)/actions.ts`, `app/(dashboard)/dashboard/*/actions.ts` |
| Database migrations | `supabase/migrations/*.sql` |
| Dashboard components | `components/dashboard/*.tsx` |
| Flight components | `components/flights/*.tsx` |

---

## Summary

The Shapon Travels International platform is built on a modern Next.js architecture with clear separation of concerns:

- **Frontend:** Server components for data fetching, client components for interactivity
- **Backend:** API routes for external access, server actions for mutations
- **Database:** Supabase PostgreSQL with service-role access only (no browser access)
- **Business Logic:** Encapsulated in `lib/` modules by domain
- **Supplier Integration:** Triplover API abstracted behind domain types
- **Authentication:** Clerk for user management
- **File Storage:** Cloudinary for logos and documents

Key architectural principles:
1. Server-first data access for security and performance
2. Immutable financial records for auditability
3. Computed business statuses for accuracy
4. Defensive supplier response parsing for reliability
5. Database-driven configuration for flexibility

The architecture is designed to be maintainable, secure, and extensible as the platform grows.
