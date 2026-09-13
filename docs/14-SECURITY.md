# Security

ShoponTravels implements a comprehensive security model with server-only database access, session-based authorization, financial transaction integrity, and security audit logging. This document covers security practices, operational safety, and critical invariants.

## Security Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                    Client Browser                                │
│              (No Direct Database Access)                         │
└─────────────────────────────────────────────────────────────────┘
                              │
                              │ HTTPS Only
                              │
┌─────────────────────────────────────────────────────────────────┐
│                    Next.js Application                            │
│  ┌────────────────────────────────────────────────────────────┐  │
│  │              Session Management (Clerk)                      │  │
│  │  - JWT session tokens                                       │  │
│  │  - Secure cookie storage                                    │  │
│  │  - Automatic token refresh                                  │  │
│  └────────────────────────────────────────────────────────────┘  │
│  ┌────────────────────────────────────────────────────────────┐  │
│  │              Authorization Layer                              │  │
│  │  - Role-based access control                                │  │
│  │  - Resource ownership checks                                │  │
│  │  - Session-based user identity                              │  │
│  └────────────────────────────────────────────────────────────┘  │
│  ┌────────────────────────────────────────────────────────────┐  │
│  │              Rate Limiting                                  │  │
│  │  - Per-endpoint limits                                     │  │
│  │  - User and IP-based keys                                  │  │
│  │  - Fixed-window algorithm                                  │  │
│  └────────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
                              │
                              │ Service Role Key Only
                              │
┌─────────────────────────────────────────────────────────────────┐
│                    Supabase Database                             │
│  ┌────────────────────────────────────────────────────────────┐  │
│  │              Row Level Security (RLS)                         │  │
│  │  - Enabled on all tables                                    │  │
│  │  - No policies (deny all)                                   │  │
│  │  - Bypassed by service role only                            │  │
│  └────────────────────────────────────────────────────────────┘  │
│  ┌────────────────────────────────────────────────────────────┐  │
│  │              Security Audit Logging                          │  │
│  │  - Privileged operation events                              │  │
│  │  - Actor identity and role                                  │  │
│  │  - Target and outcome                                       │  │
│  └────────────────────────────────────────────────────────────┘  │
│  ┌────────────────────────────────────────────────────────────┐  │
│  │              Operation Locks                                 │  │
│  │  - Cross-instance leases                                   │  │
│  │  - Destructive operation guards                             │  │
│  │  - Timeout-based expiration                                 │  │
│  └────────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
```

## Authentication Security

### Clerk Integration

**Provider**: Clerk handles authentication, session management, and user data.

**Security Features**:
- Industry-standard authentication practices
- Secure session token storage (httpOnly cookies)
- Automatic token refresh
- Multi-factor authentication support (configurable)
- Session expiration and revocation

**Session Security**:
- JWT-based session tokens
- Secure cookie flags (httpOnly, secure, sameSite)
- Automatic token refresh before expiry
- Session validation on every request

### Session Management

**Session Resolution** (`lib/dashboard/session.ts`):
- User identity derived from verified Clerk session
- Role resolved from Clerk metadata (never from request payload)
- Agency membership resolved from database (not Clerk metadata)
- Dev role switcher scoped to user and development only

**Session Error Handling**:
- Session-gone errors handled gracefully
- User signed out when session invalid
- No crashes on deleted user sessions

## Authorization Security

### Role-Based Access Control

**Role System** (`lib/roles.ts`):
- Flat role slugs for simple lookup
- Role hierarchy enforced in authorization checks
- No role escalation through request payload
- Database as authority for agency relationships

**Financial Access** (`lib/wallet/permissions.ts`):
- Financial roles explicitly defined
- Wallet ownership resolved from session
- Booking operations require ownership or financial role
- Admin/staff never resolve to personal wallets

### Resource Ownership

**Agency Ownership**:
- Agency membership stored in database
- Owner relationship enforced at database level
- Sub-user management limited to agency owners
- Agency code validation enforced

**Booking Ownership**:
- Booking owner tracked separately from creator
- Operations authorized based on ownership
- Financial roles can override ownership for operations
- Cancellation requires ownership or financial role

## Database Security

### Server-Only Access Model

**Access Pattern**:
- Only server-side code accesses database
- Service role key bypasses RLS
- Client components never import Supabase client
- All database access through `lib/db/` layer

**RLS Configuration**:
- RLS enabled on all tables
- No RLS policies (deny all)
- Only service role can bypass RLS
- No anonymous or authenticated access

**Key Security**:
- `SUPABASE_SERVICE_ROLE_KEY` never exposed to client
- No `NEXT_PUBLIC_` prefix on service role key
- Key stored in environment variables only
- Never committed to repository

### Database Constraints

**Check Constraints**:
- Role values limited to defined set
- Status values limited to defined set
- Agency code format enforced with regex
- Currency codes enforced (3-letter ISO)
- Balance non-negativity enforced

**Foreign Key Constraints**:
- Cascade deletes for user-owned data
- Restrict deletes for financial data
- On delete set null for agency relationships

**Triggers**:
- Immutable ledger enforcement
- Wallet ownership auto-assignment
- Updated_at timestamp maintenance
- Status event recording

## Financial Security

### Wallet Ledger Immutability

**Immutable Ledger**:
- Ledger entries cannot be modified or deleted
- PostgreSQL delete/update restrictions enforced
- Corrections done through new entries (reversals)
- Complete audit trail maintained

**Balance Constraints**:
- Available balance cannot be negative
- Hold balance cannot be negative
- Currency enforced at transaction level
- Balance updates atomic with ledger entries

**Transaction Safety**:
- Wallet operations use database functions
- Functions lock accounts during updates
- Currency guards prevent cross-currency operations
- Idempotency keys prevent duplicate transactions

### Payment Reservations

**Reservation States**:
- Active funds held for booking operations
- Captured when booking confirmed
- Released on cancellation or failure
- Reconciliation for ambiguous outcomes

**Reservation Locking**:
- One reservation per booking
- Atomic hold/capture/release operations
- Timeout-based expiration
- Audit trail for all state changes

### Imported Booking Financial Boundary

IMP/EXP uses separate actor and financial-owner identities. Only
`superadmin`, `admin`, and `staff_support` can import or Sync, but the assigned
B2C customer or assigned agency owns the wallet obligation. B2B sub-users share
the parent agency wallet. No admin/support wallet fallback is permitted.

The held-import Confirm & Pay endpoint requires exact owner/agency membership
at the application layer and repeats assignment/owner/wallet validation inside
the transactional database function. Direct confirmed import performs the same
owner and wallet checks in its creation transaction.

Financial replay protection is database-enforced through stable supplier
identity, advisory and row locks, a per-booking ledger key, immutable ledger,
and unique reservation/ledger constraints. Sync is structurally non-financial
and cannot update User Payable, payment ownership, balance, reservation, or
ledger data.

### External Airline Device-Verification Boundary

Manage Booking URLs are restricted to the configured provider host, but host
validation does not establish a trusted browser session. The application does
not and must not copy an operator's cookies, local storage, CAPTCHA result,
device fingerprint, or browser history into the server-side Chromium context.

If an airline returns Device Check, CAPTCHA, or other bot-protection evidence,
preview fails before database or wallet mutation. Do not weaken the detector,
automatically solve a challenge, add stealth/bypass services, or treat a manual
Chrome success as authorization to evade the supplier control. Use an official
supplier API or a supplier-approved integration host/network.

## API Security

### Rate Limiting

**Implementation** (`lib/rate-limit.ts`):
- Fixed-window rate limiting
- Per-endpoint limits configured
- User and IP-based actor keys
- In-memory storage (instance-scoped)

**Rate Limits**:
- Flight search: 10 requests per minute
- Booking submission: 30 requests per hour per user
- Wallet operations: 20 requests per minute
- Deposit requests: 10 requests per hour

**Response Headers**:
- `Retry-After` header on rate limit
- `X-RateLimit-Remaining` header
- `X-RateLimit-Reset` header

### Input Validation

**Validation Strategy**:
- Zod schemas for all API inputs
- Type-safe parsing
- Explicit error messages
- Fail-closed on validation errors

**Sanitization**:
- Email addresses validated with regex
- Phone numbers validated with regex
- Airport codes normalized (uppercase, length check)
- Dates validated and parsed

### Output Sanitization

**Data Exposure Prevention**:
- Supplier tokens never exposed to client
- Internal IDs never shown to users
- Financial data scoped to owner
- Audit data minimization (PII hashing)

**Contact Information Security**:
- Booking contact email fixed server-side
- Country and city fixed server-side
- Cannot be overridden by client input
- Prevents correspondence redirection

## Security Audit Logging

### Audit Events

**Event Recording** (`lib/db/security.ts`):
- All privileged operations logged
- Actor identity and role recorded
- Target type and ID recorded
- Outcome recorded (attempted, succeeded, failed, denied)
- Metadata stored for context

**Event Types**:
- User management (create, update, delete)
- Role assignments
- Agency management
- Wallet operations
- Booking operations
- Markup rule changes

### PII Minimization

**Email Hashing**:
```typescript
export function securitySubjectHash(value: string): string {
  return `sha256:${createHash('sha256')
    .update(value.trim().toLowerCase(), 'utf8')
    .digest('hex')}`;
}
```

Email addresses are hashed before logging to prevent PII exposure.

## Operation Locks

### Cross-Instance Leases

**Purpose**: Prevent concurrent destructive operations across multiple instances.

**Implementation**:
```typescript
export async function acquireSecurityLock(
  name: string,
  leaseSeconds = 60
): Promise<SecurityLock | null> {
  const holder = randomUUID();
  const { data } = await supabaseAdmin().rpc('try_acquire_security_lock', {
    p_name: name,
    p_holder: holder,
    p_lease_seconds: leaseSeconds,
  });
  return data === true ? { name, holder } : null;
}
```

**Use Cases**:
- Database migrations
- Bulk data operations
- Financial reconciliation
- Supplier synchronization

**Timeout**: Locks expire after configured duration to prevent deadlocks.

## Supplier API Security

### Authentication

**Token Management**:
- Token cached with 30-minute expiry
- Automatic renewal before expiry
- Single-flight guard for concurrent logins
- Token never exposed to client

**Credential Security**:
- Supplier credentials in environment variables
- Never committed to repository
- Rotated if compromised
- Limited to necessary permissions

### Operation Safety

**Retry Safety**:
- Safe operations (Search, RePrice, Pnr) can be retried
- Unsafe operations (Book, Cancel, NewTicket) never retried
- Ambiguous failures marked for reconciliation
- No blind replay of write operations

**Timeout Handling**:
- All supplier calls have timeouts
- Timeout prevents hanging requests
- Ambiguous timeout marked for reconciliation
- Network errors classified appropriately

## File Security

### Cloudinary Integration

**Storage**:
- All files stored in Cloudinary
- No files stored in database
- URLs stored as handles, not full paths
- Private buckets for sensitive documents

**Upload Security**:
- File type validation
- File size limits
- Malware scanning (Cloudinary feature)
- Access controls on buckets

**Document Handling**:
- Business documents (license, TIN) stored as Cloudinary assets
- Database stores only asset handles
- Signed URLs for secure access
- Access control based on ownership

## Error Handling Security

### Error Messages

**Principle**: Error messages do not expose sensitive information.

**Implementation**:
- Generic error messages for users
- Detailed errors logged server-side
- No stack traces exposed to client
- No database errors propagated to client

### Fail-Closed Design

**Pattern**: System fails closed on security-related errors.

**Examples**:
- Database unavailable → deny access
- Session invalid → sign out
- Role unknown → default to customer
- Agency lookup failed → deny agency access

## Deployment Security

### Environment Variables

**Required Variables**:
- All secrets in environment variables
- Never committed to repository
- Different values per environment
- Rotated regularly

**Variable Validation**:
- Required variables checked at startup
- Invalid configuration fails fast
- Type validation where applicable
- No default values for secrets

### HTTPS Only

**Enforcement**:
- All API endpoints require HTTPS
- HTTP requests redirected to HTTPS
- Secure cookies enforced
- HSTS headers configured

## Ticket Management Security Boundary

- Customers and agency users can create/read only requests belonging to the
  durable booking owner. Staff media has no Ticket Management access.
- Support can review, quote, requote, assign, and perform operational work, but
  cannot invoke final wallet credit, Hold capture, or Hold release.
- Only the active assigned Accounts, Admin, or Superadmin actor can finalize a
  financial effect. API checks improve usability; canonical role, assignment,
  version, quote, entitlement, and wallet checks remain inside the database RPC.
- Final settlement schemas accept neither a wallet account nor an editable
  settlement amount. The original `charged_wallet_account_id` and immutable
  approved quotation are authoritative.
- Privileged mutations require a successful pre-action security audit and log
  their failed/successful result. Mutations are actor-rate-limited and use UUID
  request keys plus expected versions.
- Customer DTOs and notification snapshots exclude wallet ledger/reservation
  identifiers, supplier economics, and internal staff audit identities.
- Ticket Management tables and functions remain browser-inaccessible; server
  adapters use the service role. No service credential is exposed to clients.
- The application generic Refund endpoint cannot process issued/ticketed
  bookings. The pre-existing broad generic wallet authorization and underlying
  generic Refund RPC remain separate recorded hardening concerns.

## Critical Invariants

### Database Access
- Database access must remain server-only using service role key
- Client components must never import Supabase client
- Service role key must never be exposed to client
- RLS must remain enabled on all tables with no policies

### Session Security
- User identity must always be derived from verified session
- Role must come from Clerk metadata, never from request payload
- Agency membership must be resolved from database, not Clerk metadata
- Dev role switcher must never work in production

### Financial Integrity
- Wallet ledger entries must remain immutable
- Available and hold balances can never become negative
- Currency mismatches must be rejected
- Financial operations must be atomic and idempotent
- Imported bookings must charge stored User Payable, never Supplier Gross
- Held import and every Sync/re-import must remain non-financial unless the exact owner invokes Confirm & Pay

### Authorization
- Resource ownership must be checked before operations
- Financial roles must be explicitly defined
- Admin/staff must never resolve to personal wallets
- Agency ownership must be enforced at database level
- Imported operations staff must remain actors only; their wallet cannot replace the assigned owner wallet

### Supplier Operations
- Book, Cancel, and NewTicket must never be retried on ambiguous failure
- Supplier credentials must never be exposed to client
- Token must be cached and renewed before expiry
- Supplier responses must be parsed defensively
- Airline Device Check/CAPTCHA must fail closed; a session URL must never be treated as transferred browser trust
- Supplier anti-bot controls must not be bypassed from IMP/EXP adapters

### Audit Logging
- All privileged operations must be logged
- PII must be minimized in audit logs
- Email addresses must be hashed before logging
- Audit events must be tamper-evident

## Before Modifying Security

1. **Understand Threat Model**: Review security implications of changes
2. **Test Authentication**: Verify session handling works correctly
3. **Test Authorization**: Ensure access control is not bypassed
4. **Audit Database Access**: Check for new client-side database access
5. **Review Environment Variables**: Ensure no secrets exposed
6. **Test Rate Limiting**: Verify limits are enforced
7. **Audit Logging**: Ensure privileged operations are logged
8. **Security Review**: Have security changes reviewed
9. **Penetration Testing**: Test for common vulnerabilities
10. **Update Documentation**: Document security changes

## Related Documentation

- [03-AUTHENTICATION.md](03-AUTHENTICATION.md) - Authentication system
- [04-ROLES-AND-PERMISSIONS.md](04-ROLES-AND-PERMISSIONS.md) - Role and permission system
- [10-WALLET-SYSTEM.md](10-WALLET-SYSTEM.md) - Wallet security
- [12-DATABASE.md](12-DATABASE.md) - Database security
- [17-IMP-EXP-IMPORTS.md](17-IMP-EXP-IMPORTS.md) - Imported booking authorization and financial invariants
- [15-DEPLOYMENT.md](15-DEPLOYMENT.md) - Deployment security
