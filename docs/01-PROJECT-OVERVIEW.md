# Project Overview

ShoponTravels International is a comprehensive flight booking platform serving both retail customers (B2C) and travel agencies (B2B). The platform provides flight search, booking, payment processing, and lifecycle management through a web-based dashboard interface.

## Purpose

ShoponTravels International enables:

- **Flight Search**: Real-time flight availability and pricing search through supplier integration
- **Booking Management**: Complete booking lifecycle from hold to ticket issuance to cancellation
- **Payment Processing**: Wallet-based payment system with deposit workflows and payment options
- **Agency Management**: B2B partner onboarding, sub-user management, and agency-specific pricing
- **Role-Based Access**: Multi-tiered permission system for different user types
- **Automated Communications**: Email notifications for booking confirmations and status updates

## Business Model

### B2C (Business-to-Consumer)
- Retail customers book flights directly through the platform
- Personal wallet accounts for deposits and payments
- Standard pricing with configurable markup rules

### B2B (Business-to-Business)
- Travel agencies partner with ShoponTravels to book flights for their clients
- Agency-level wallet accounts with centralized payment management
- Agency-specific pricing and markup rules
- Sub-user accounts for agency staff with role-based permissions

## Technology Stack

### Frontend Framework
- **Next.js 16.2.11** - React framework with App Router
- **React 18.2.0** - UI library
- **TypeScript 5.2.2** - Type-safe JavaScript

### Authentication & Authorization
- **Clerk** - Authentication provider (user management, sessions, roles)
- **Custom Role System** - Role-based access control (see [04-ROLES-AND-PERMISSIONS.md](04-ROLES-AND-PERMISSIONS.md))

### Database
- **Supabase** - PostgreSQL 17 hosting and management
- **PostgREST** - RESTful API layer
- **Service Role Access** - Server-only database access with bypassed RLS

### UI Components & Styling
- **Tailwind CSS 3.3.3** - Utility-first CSS framework
- **Radix UI** - Unstyled, accessible component primitives
- **Lucide React** - Icon library
- **shadcn/ui** - Component library built on Radix UI

### Supplier Integration
- **Triplover API** - Primary flight supplier for search, booking, and ticketing
- **Custom Client** - Triplover API client with authentication, retry logic, and error handling

### Payment & Financial
- **Custom Wallet System** - Built-in wallet with ledger and reservation system
- **Deposit Workflows** - Multi-method deposit requests (bank transfer, mobile banking, cash, cheque)
- **Payment Options** - Bank accounts and mobile financial service (MFS) integration

### Email & Notifications
- **Nodemailer** - SMTP email sending
- **Custom Templates** - Booking confirmation, on-hold notifications, and ticket PDFs
- **PDF Generation** - Ticket PDF generation with PDFKit

### File Storage
- **Cloudinary** - Cloud-based file storage for documents and assets

### Deployment
- **Vercel** - Hosting platform with environment variable management
- **Node.js Runtime** - Server-side execution environment

## System Architecture

### Client-Side
- **Dashboard Application** - Single-page application built with Next.js App Router
- **Server Components** - React components that render on the server
- **Server Actions** - Mutations that run on the server with direct database access
- **Client Components** - Interactive components with `'use client'` directive

### Server-Side
- **API Routes** - RESTful endpoints for flight operations, wallet operations, and webhooks
- **Business Logic Layer** - Domain-specific logic in `lib/` directory
- **Database Access Layer** - Supabase client with service role key
- **Supplier Client** - Triplover API integration with authentication and retry logic

### Database Layer
- **PostgreSQL Schema** - Tables, views, functions, and triggers
- **Row-Level Security** - Enabled on all tables with no policies (server-only access)
- **Migration System** - Supabase CLI for schema versioning
- **Views and RPCs** - Computed lifecycle views and transactional functions

## Key Features

### Flight Search & Booking
- Real-time flight search with multi-leg itinerary support
- Fare rules and baggage information
- Repricing and fare verification
- Booking draft creation with access tokens
- Traveller information collection
- Booking submission and confirmation
- Instant-purchase fares that issue tickets during the supplier Book call when holding is unavailable
- Operations-only IMP/EXP import of existing airline bookings with mandatory B2B/B2C assignment
- Manual imported-ticket workflow with customer payment capture and non-financial supplier Sync

### Booking Lifecycle Management
- Seven business statuses: On Hold, Pending, In Progress, Confirmed, Expired, Unconfirmed, Cancelled
- Automatic status transitions based on deadlines and supplier responses
- Ticket issuance with payment capture
- Booking cancellation with explicit hold-release or captured-funds disposition
- Reconciliation for ambiguous supplier outcomes

### Pricing & Markup
- Two-stage pricing: base rule + adjustment rule
- Audience-specific pricing (B2C, B2B, agency-specific)
- Airline and route-based markup rules
- LCC service margin mode
- Negative markup for discounts
- Gross price caps and floor protections

### Wallet & Payments
- User and agency wallet accounts
- Multi-currency support
- Available and hold balance tracking
- Immutable ledger for all transactions
- Deposit request workflows with approval
- Payment reservation for booking operations
- Refund processing

### User Management
- Clerk-based authentication
- Role-based access control (Super Admin, Admin, Staff, B2B, Customer)
- Agency management with owner and sub-user relationships
- Profile management with personal and business information
- Document upload and verification

### Email System
- Automated booking confirmation emails
- On-hold booking notifications
- Ticket PDF generation and attachment
- Retry logic for failed deliveries
- Customizable email templates

## Project Structure

```
shopontravels/
├── app/                          # Next.js App Router
│   ├── (dashboard)/             # Dashboard layout and pages
│   │   ├── dashboard/           # Dashboard sections
│   │   └── actions.ts           # Dashboard server actions
│   ├── api/                     # API routes
│   │   ├── flights/             # Flight booking endpoints
│   │   ├── wallet/              # Wallet operations
│   │   ├── reports/             # Reporting endpoints
│   │   └── webhooks/            # Webhook handlers
│   └── invite/                  # Invitation handling
├── components/                  # React components
│   └── dashboard/               # Dashboard-specific components
├── lib/                         # Business logic and utilities
│   ├── db/                      # Database access layer
│   ├── dashboard/               # Dashboard-specific logic
│   ├── email/                   # Email system
│   ├── flights/                 # Flight booking logic
│   ├── triplover/               # Supplier integration
│   ├── wallet/                  # Wallet logic
│   └── [other utilities]        # Various utilities
├── supabase/                    # Database migrations
│   └── migrations/              # SQL migration files
├── public/                      # Static assets
├── docs/                        # Documentation (this directory)
└── [config files]               # Project configuration
```

## Data Flow Overview

IMP/EXP-specific code lives under `app/api/impexp/`,
`components/dashboard/impexp/`, `lib/impexp/`, and `lib/db/impexp.ts`. It shares
the normal booking, lifecycle, wallet, ledger, and reporting layers.

### Flight Search Flow
1. User searches for flights via dashboard
2. Search request sent to Triplover API
3. Markup rules applied to supplier fares
4. Results cached in database with TTL
5. User selects fare and creates booking draft
6. Draft prepared with access token

### Booking Flow
1. User completes traveller information
2. Booking submitted via API route
3. Booking attempt claimed (optimistic lock)
4. For instant purchase, the full wallet amount is reserved before any supplier call
5. Supplier Book API creates either a held PNR or, for `bookable: false`, immediately issues tickets
6. A held booking is persisted without wallet capture; an issued instant-purchase booking captures its existing reservation
7. Definite instant-purchase rejection releases the reservation; ambiguous results keep funds held for reconciliation
8. Email notifications are sent after the durable booking outcome is stored

### Imported Booking Flow

1. An authorized operator selects an assigned B2C customer, B2B partner, or B2B sub-user; the explicit User Payable field is available before retrieval and may be completed before or after preview.
2. Retrieve & Review launches the approved airline adapter and returns Supplier Gross and supplier evidence when the upstream website accepts the server-side browser.
3. A Held import is stored On Hold/Unpaid with no wallet movement.
4. The authorized owner later confirms it; the database captures User Payable and moves the booking to In Progress for manual ticketing.
5. An already Ticketed/Confirmed import uses explicit Import Only (no debit plus Accounts case) or prior-authorized Import & Charge (one User Payable debit).
6. Operations staff issue or verify externally, use non-financial Sync to record evidence, and use the separate Complete action for matching ticket evidence without another debit.
7. Imported e-tickets display the supplier-authored fare breakdown and Supplier Gross, while User Payable remains the separate wallet/payment amount.

### Payment Flow
1. User requests deposit via dashboard
2. Deposit request created with method-specific fields
3. Admin reviews and approves request
4. Wallet account credited via ledger entry
5. Booking operations reserve funds from available balance
6. Ticket issuance captures reserved funds
7. Proven unticketed cancellations release an exact hold; captured cancellations
   require an approved full/partial/no-refund, external-settlement, or manual-
   adjustment disposition. Cancelled alone never proves refund completion.

## Important Constraints

### Security
- **Server-Only Database Access**: Browser never queries database directly
- **Service Role Key Only**: Only server-side code uses Supabase service role key
- **RLS Enabled**: All tables have RLS enabled with no policies
- **Session-Based Authorization**: User identity derived from verified session
- **Security Audit Logging**: Privileged operations logged to audit table
- **External Supplier Boundary**: A pasted airline session URL does not transfer the operator's cookies, browser fingerprint, device verification, or network identity to a server-side function

### Financial
- **Immutable Ledger**: Wallet ledger entries cannot be modified or deleted
- **Balance Constraints**: Available and hold balances cannot go negative
- **Currency Guards**: Transactions must match account currency
- **Idempotency**: Payment operations protected by idempotency keys
- **Approval Workflows**: Financial changes require approval workflow
- **Imported Pricing Boundary**: Imported customer debits use stored User Payable, never Supplier Gross
- **Operator Separation**: Admin/support actors never become fallback wallet owners for assigned imports

### Booking
- **Optimistic Locking**: Booking attempts use optimistic locking to prevent double-submission
- **Supplier References**: Critical supplier reference tokens cannot be re-derived
- **Status Authority**: Booking lifecycle resolved through single database view
- **Operation Locking**: Ticketing and cancellation acquire database locks
- **Terminal States**: Confirmed and Cancelled states are protected outcomes
- **Instant Purchase Gate**: Direct-ticket Book calls require both booking and ticketing feature gates
- **Reservation Before Issuance**: Instant-purchase funds must be held before the supplier can issue tickets

### Supplier
- **No Blind Retries**: Book, Cancel, and NewTicket operations never retried on ambiguous failure
- **Token Caching**: Authentication tokens cached with 30-minute expiry
- **Timeout Handling**: All supplier calls have timeouts and proper error handling
- **Defensive Parsing**: Supplier responses parsed defensively to handle malformed data

## Related Documentation

- [02-ARCHITECTURE.md](02-ARCHITECTURE.md) - Detailed system architecture
- [03-AUTHENTICATION.md](03-AUTHENTICATION.md) - Authentication system details
- [04-ROLES-AND-PERMISSIONS.md](04-ROLES-AND-PERMISSIONS.md) - Role and permission system
- [12-DATABASE.md](12-DATABASE.md) - Database schema and architecture
- [15-DEPLOYMENT.md](15-DEPLOYMENT.md) - Deployment procedures and configuration
- [16-INSTANT-PURCHASE.md](16-INSTANT-PURCHASE.md) - Direct-ticket flow, wallet handling, feature gates, and reconciliation
- [17-IMP-EXP-IMPORTS.md](17-IMP-EXP-IMPORTS.md) - Imported booking pricing, wallet, lifecycle, and Sync

## Critical Invariants

### Financial Integrity
- Wallet ledger entries must remain consistent with wallet balances
- Available and hold balances can never become negative
- Currency mismatches between transactions and accounts must be rejected
- Financial operations must be atomic and idempotent
- Imported booking Sync and re-import must never create a second debit
- Imported booking charges must use User Payable and the assigned B2C/agency wallet

### Booking Consistency
- Booking attempts must never be replayed after ambiguous failure
- Supplier reference tokens must be preserved and never re-derived
- Terminal booking states (Confirmed, Cancelled) must not be silently overwritten
- Booking lifecycle must be resolved through a single authoritative source

### Security
- Database access must remain server-only using service role key
- User identity must always be derived from verified session, never from request payload
- Security audit events must be recorded for all privileged operations
- Rate limiting must be enforced on all public endpoints

### Supplier Operations
- Book, Cancel, and NewTicket operations must never be retried on ambiguous failure
- Authentication tokens must be cached and renewed before expiry
- Supplier responses must be parsed defensively
- Network timeouts must be handled gracefully with proper error states
- Instant-purchase Book must reserve wallet funds first and must not run while ticketing is disabled
- Ambiguous instant-purchase results must retain the wallet hold for reconciliation
