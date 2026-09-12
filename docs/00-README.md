# ShoponTravels Documentation

This directory contains the complete documentation system for the ShoponTravels flight booking platform. Each document is numbered for logical reading order and cross-referenced to create a connected documentation system.

> Update note: repository deployment identity has been corrected and the project is ready for a clean GitHub verification pass.

## Documentation Index

| #   | Document              | Purpose                                                             |
| --- | --------------------- | ------------------------------------------------------------------- |
| 00  | README                | Documentation overview and navigation (this file)                   |
| 01  | PROJECT-OVERVIEW      | High-level project overview, purpose, and technology stack          |
| 02  | ARCHITECTURE          | System architecture and component organization                      |
| 03  | AUTHENTICATION        | Authentication system with Clerk integration                        |
| 04  | ROLES-AND-PERMISSIONS | User roles, permissions, and authorization system                   |
| 05  | FLIGHT-SEARCH         | Flight search architecture and supplier flow                        |
| 06  | PRICING-AND-MARKUP    | Pricing, markup, fare calculation, and commercial rules             |
| 07  | BOOKING-SYSTEM        | Booking creation, processing, and data flow                         |
| 08  | BOOKING-LIFECYCLE     | Booking statuses, lifecycle transitions, and state management       |
| 09  | SUPPLIER-INTEGRATION  | Triplover API and direct airline import supplier architecture       |
| 10  | WALLET-SYSTEM         | Wallet architecture, ledger, and payment handling                   |
| 11  | EMAIL-NOTIFICATIONS   | Automated email system and notification workflows                   |
| 12  | DATABASE              | Database architecture, tables, views, and relationships             |
| 13  | API-ROUTES            | Internal/backend API routes and endpoints                           |
| 14  | SECURITY              | Security practices, audit logging, and operational safety           |
| 15  | DEPLOYMENT            | Deployment architecture and procedures                              |
| 16  | INSTANT-PURCHASE      | Direct-ticket booking, wallet protection, gates, and reconciliation |
| 17  | IMP-EXP-IMPORTS       | Imported pricing, wallet/lifecycle, Sync, ticket display, and runtime limits |
| 18  | BOOKING-RECONCILIATION-RUNBOOK | Staff case procedures, evidence, SLA, maker-checker, and emergency response |
| 19  | SUPERADMIN-BOOKING-DECISION-PLAN | Implementation plan, corrected wallet matrix, progress, and verification log |

## Recommended Reading Order

### For New Developers

1. **PROJECT-OVERVIEW** → Understand what the system does
2. **ARCHITECTURE** → Learn how components are organized
3. **AUTHENTICATION** → Understand user identity and sessions
4. **ROLES-AND-PERMISSIONS** → Learn about access control
5. **DATABASE** → Understand the data model
6. **FLIGHT-SEARCH** → Learn the primary user flow
7. **PRICING-AND-MARKUP** → Understand commercial logic
8. **BOOKING-SYSTEM** → Learn booking creation
9. **BOOKING-LIFECYCLE** → Understand booking state management
10. **WALLET-SYSTEM** → Learn payment processing
11. **SUPPLIER-INTEGRATION** → Understand external API integration
12. **IMP-EXP-IMPORTS** → Learn direct airline booking import and synchronization
13. **BOOKING-RECONCILIATION-RUNBOOK** → Learn owned uncertainty and safe staff actions

### For AI Coding Agents

AI agents should read documents in this order to understand the system before making changes:

1. **PROJECT-OVERVIEW** → System purpose and constraints
2. **ARCHITECTURE** → Component relationships
3. **CRITICAL INVARIANTS** (in relevant docs) → Rules that must never be broken
4. **DATABASE** → Data model and relationships
5. **SECURITY** → Safety-critical operations
6. Domain-specific documentation based on the task

### For Security Audits

1. **SECURITY** → Security overview
2. **AUTHENTICATION** → Identity verification
3. **ROLES-AND-PERMISSIONS** → Access control
4. **WALLET-SYSTEM** → Financial operations
5. **API-ROUTES** → Endpoint security
6. **DATABASE** → Data access patterns

### For Operations/DevOps

1. **DEPLOYMENT** → Deployment procedures
2. **DATABASE** → Database operations
3. **SECURITY** → Operational security
4. **SUPPLIER-INTEGRATION** → External dependencies
5. **BOOKING-RECONCILIATION-RUNBOOK** → Case response, escalation, and containment

## Cross-Reference System

Documentation files reference each other to avoid duplication. When reading a document, follow the cross-references to understand related systems:

- **BOOKING-SYSTEM** references **BOOKING-LIFECYCLE**, **WALLET-SYSTEM**, **SUPPLIER-INTEGRATION**
- **PRICING-AND-MARKUP** references **FLIGHT-SEARCH**, **DATABASE**
- **WALLET-SYSTEM** references **BOOKING-LIFECYCLE**, **SECURITY**, **IMP-EXP-IMPORTS**
- **SUPPLIER-INTEGRATION** references **FLIGHT-SEARCH**, **BOOKING-SYSTEM**, **IMP-EXP-IMPORTS**
- **INSTANT-PURCHASE** references **BOOKING-SYSTEM**, **BOOKING-LIFECYCLE**, **WALLET-SYSTEM**, **SUPPLIER-INTEGRATION**, **SECURITY**, and **DEPLOYMENT**
- **IMP-EXP-IMPORTS** references **ROLES-AND-PERMISSIONS**, **BOOKING-SYSTEM**, **BOOKING-LIFECYCLE**, **SUPPLIER-INTEGRATION**, **DATABASE**, **API-ROUTES**, and **DEPLOYMENT**
- **BOOKING-RECONCILIATION-RUNBOOK** references lifecycle, wallet, database,
  API, security, deployment, and imported manual-ticket controls

## Critical Invariants

Each major system document includes a "Critical Invariants" section that documents rules future developers and AI agents must never accidentally break. These are the most important sections to understand before making changes.

For IMP/EXP, keep three different facts separate: User Payable is the wallet and
payment amount, Supplier Gross is the e-ticket face value, and server-side
airline retrieval is an external security boundary that may reject cloud browser
automation even when Chromium launches correctly.

## Modification Checklists

Major documentation files include "Before Modifying This System" checklists that list what should be inspected or verified before changing that part of the project.

## Existing Documentation

The project root contains several existing markdown documents that predate this documentation system:

- `BOOKING_ARCHITECTURE.md` - Detailed booking architecture migration plan
- `BOOKING_STATUS_LIFECYCLE_REVIEW_PROPOSAL.md` - Booking lifecycle implementation baseline
- `DATABASE.md` - Database guide (superseded by docs/12-DATABASE.md)
- `MARKUP.md` - Pricing rules guide (superseded by docs/06-PRICING-AND-MARKUP.md)
- `WALLET_ARCHITECTURE.md` - Wallet architecture (superseded by docs/10-WALLET-SYSTEM.md)
- `Triploaver_API_Documentation.md` - Triplover API documentation

These existing documents contain valuable implementation details and have been incorporated into the new documentation system. The new docs consolidate and organize this information in a structured, cross-referenced format.

## Document Maintenance

When adding new features or making significant changes:

1. Update the relevant documentation file
2. Add cross-references to related systems
3. Update this index if new documentation files are created
4. Review "Critical Invariants" sections to ensure no rules are violated
5. Update "Modification Checklists" if new dependencies are introduced

## AI-Friendly Design

These documents are designed to be easily consumed by AI coding agents (Codex, Claude, etc.):

- File paths use repository-relative notation (e.g., `app/api/...`, `lib/...`)
- Critical invariants are explicitly stated
- Business rules and constraints are clearly documented
- Dependencies between systems are mapped
- Dangerous or sensitive operations are highlighted
- Implementation details reference actual source files

## Project Context

**ShoponTravels International** is a B2B/B2C flight booking platform built with:

- **Frontend**: Next.js 16, React 18, TypeScript
- **Authentication**: Clerk
- **Database**: Supabase (PostgreSQL 17)
- **Styling**: Tailwind CSS, Radix UI
- **Supplier**: Triplover API (primary search/booking supplier) plus direct airline Manage Booking adapters for IMP/EXP
- **Email**: Nodemailer with SMTP
- **File Storage**: Cloudinary
- **Deployment**: Vercel

The platform serves both retail customers (B2C) and travel agencies (B2B) with role-based access control, wallet-based payments, and automated booking lifecycle management.
