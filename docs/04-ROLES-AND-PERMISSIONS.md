# Roles and Permissions

This document describes the role-based access control (RBAC) system for ShoponTravels, including role definitions, permission boundaries, navigation access, and security considerations.

## Role System Overview

The role system is defined in `lib/roles.ts` and uses a flat role slug architecture rather than hierarchical role+department combinations. This design keeps permission lookups to a single map read, simplifying authorization logic and reducing potential errors.

### Design Principles

- **Flat Role Slugs**: Each role is a single string (e.g., `staff_account`) rather than a combination of role and department
- **Single Source of Truth**: All role definitions and access patterns are centralized in `lib/roles.ts`
- **Fail-Safe Defaults**: Unknown role values resolve to `customer` via `resolveRole()`
- **Database Authority**: Agency ownership and membership are database facts, not derived from role metadata

### Role Resolution

Roles are resolved from Clerk's `publicMetadata.role` field:

```typescript
export function resolveRole(value: unknown): Role {
  return ROLES.includes(value as Role) ? (value as Role) : DEFAULT_ROLE;
}
```

The default role is `customer`, ensuring that new sign-ups without role metadata have safe, limited access.

## Available Roles

| Role Slug | Label | Purpose | Key Capabilities |
|-----------|-------|---------|------------------|
| `superadmin` | Super Admin | Platform-wide management and configuration | Full system access, can grant any role including other superadmins, deletion rights |
| `admin` | Admin | User and operational management | User management, role assignment (except superadmin), profile editing, operational oversight |
| `staff_support` | Support Staff | Customer support and B2B onboarding | B2B user review, booking support, passenger management |
| `staff_account` | Accounts Staff | Financial operations | Deposit approval, account ledger access, financial reporting |
| `staff_media` | Media Staff | Content management | Media and banner management |
| `b2b` | B2B Partner | Travel agency partner | Agency dashboard, sub-user management, agency wallet, booking for clients |
| `b2b_sub` | Sub User | Agency staff account | Agency dashboard access (same as owner), booking for clients, no sub-user management |
| `customer` | Customer | Retail customer | Personal wallet, personal bookings, co-traveler management |

### Role Groups

Several role groups are defined for convenience in access control:

```typescript
const ADMINS = ['superadmin', 'admin'] as const;
const STAFF = ['staff_support', 'staff_account', 'staff_media'] as const;
const AGENCY = ['b2b', 'b2b_sub'] as const;
```

### Sub-User Role

The `b2b_sub` role is specifically for staff accounts created by a B2B partner within their agency. This role:

- Requires an agency assignment (cannot exist without one)
- Shares the same dashboard navigation and tiles as the agency owner
- Cannot manage other sub-users (that's owner-only)
- Resolves to the agency wallet for financial operations

## Role-Based Access Control Implementation

### Navigation Access

Navigation items are defined in `lib/roles.ts` with role-specific visibility. Each navigation item has:

- A URL segment under `/dashboard`
- A display label
- An icon
- A list of roles that can see it
- A `built` flag indicating whether the section is implemented

#### Navigation Item Structure

```typescript
export type NavItem = {
  segment: string;           // URL segment under /dashboard
  label: string;             // Display label
  icon: LucideIcon;          // Icon component
  roles: readonly Role[];    // Roles that can see this item
  built?: boolean;           // False if section is a placeholder
};
```

#### Navigation Access by Role

**All Roles** (`superadmin`, `admin`, `staff_support`, `staff_account`, `staff_media`, `b2b`, `b2b_sub`, `customer`):
- Dashboard (`/dashboard`)
- Flight Search (`/dashboard/flight-search`)
- My Bookings (`/dashboard/bookings`)

**Admins Only** (`superadmin`, `admin`):
- Passengers (`/dashboard/co-travelers` - label: "Passengers")
- Accounts (`/dashboard/deposits` - label: "Accounts")
- Account Ledger (`/dashboard/statement` - label: "Account Ledger")
- Report (`/dashboard/report`)
- Users & Roles (`/dashboard/users`)
- Support Tickets (`/dashboard/support`)
- Media & Banners (`/dashboard/media`)
- Profile (`/dashboard/profile` - label: "Profile")

**Super Admin Only**:
- Markup (`/dashboard/markup`)
- Appearance (`/dashboard/appearance`)

**Staff Support**:
- B2B Users (`/dashboard/b2b-users`)

**Accounts Staff** (`staff_account`):
- Accounts (`/dashboard/deposits` - label: "Accounts")
- Account Ledger (`/dashboard/statement` - label: "Account Ledger")
- Report (`/dashboard/report`)

**Media Staff** (`staff_media`):
- Media & Banners (`/dashboard/media`)
- Staff Profile (`/dashboard/profile` - label: "Staff Profile")

**B2B Agency** (`b2b`, `b2b_sub`):
- My Passengers (`/dashboard/co-travelers` - label: "My Passengers")
- Payment Request (`/dashboard/deposits` - label: "Payment Request")
- Partial Payment (`/dashboard/partial-payment`)
- Account Ledger (`/dashboard/statement` - label: "Account Ledger")
- Report (`/dashboard/report`)
- Company (`/dashboard/profile` - label: "Company")

**B2B Owner Only** (`b2b` - not `b2b_sub`):
- Sub User (`/dashboard/agency-users`)

**Customer Only**:
- Co-Travelers (`/dashboard/co-travelers` - label: "Co-Travelers")
- Wallet (`/dashboard/deposits` - label: "Wallet")
- Statement (`/dashboard/statement` - label: "Statement")
- Profile (`/dashboard/profile` - label: "Profile")

#### Navigation Filtering

Navigation items are filtered by role using:

```typescript
export function navItemsFor(role: Role): NavItem[] {
  return NAV_ITEMS.filter((item) => item.roles.includes(role));
}

export function findNavItem(role: Role, segment: string): NavItem | undefined {
  return navItemsFor(role).find((item) => item.segment === segment);
}
```

The `findNavItem()` function is used to gate page access — if a role cannot see a navigation item, the corresponding page returns 404 rather than being merely hidden.

### Dashboard Tile Access

Summary tiles on the dashboard home show key metrics and are role-scoped:

#### Available Tiles

| Tile Key | Label | Icon | Hint |
|----------|-------|------|------|
| `onHold` | Total On Hold | CalendarClock | Booked but not yet ticketed |
| `pendingDeposit` | Total Pending Deposit | Wallet | Deposit requests awaiting approval |
| `pendingB2bUsers` | Pending B2B Users | UserPlus | Agency signups awaiting review |
| `coTravelers` | Total Co-Traveler | Users | Passengers across bookings |
| `tickets` | Total Tickets | Ticket | Issued tickets |

#### Tile Access by Role

| Role | Visible Tiles |
|------|---------------|
| `superadmin` | All tiles (org-wide figures) |
| `admin` | All tiles (org-wide figures) |
| `staff_support` | `onHold`, `pendingB2bUsers`, `coTravelers`, `tickets` |
| `staff_account` | `onHold`, `pendingDeposit`, `tickets` |
| `staff_media` | `tickets` |
| `b2b` | `onHold`, `pendingDeposit`, `coTravelers`, `tickets` (agency-scoped) |
| `b2b_sub` | `onHold`, `pendingDeposit`, `coTravelers`, `tickets` (agency-scoped) |
| `customer` | `onHold`, `coTravelers`, `tickets` (personal-scoped) |

Admin and staff figures are organization-wide. B2B and customer figures are scoped to their own records.

## Financial Access Permissions

Financial access is controlled by `lib/wallet/permissions.ts` and defines who can perform wallet operations and booking financial actions.

### Financial Roles

The following roles have financial access:

```typescript
const FINANCIAL_ROLES = new Set<Role>([
  'superadmin',
  'admin',
  'staff_support',
  'staff_account',
]);
```

### Financial Access Check

```typescript
export function hasFinancialAccess(role: Role): boolean {
  return FINANCIAL_ROLES.has(role);
}
```

### Wallet Ownership Resolution

Wallet ownership determines which wallet a user can access and book against:

```typescript
export type WalletOwner = {
  ownerType: 'user' | 'agency';
  ownerKey: string;
};

export function walletOwnerForSession(
  session: DashboardSession
): WalletOwner | null {
  if (session.role === 'customer') {
    return { ownerType: 'user', ownerKey: session.clerkId };
  }
  if (
    (session.role === 'b2b' || session.role === 'b2b_sub') &&
    session.agencyCode
  ) {
    return { ownerType: 'agency', ownerKey: session.agencyCode };
  }
  return null;
}
```

**Key Points**:
- Admin and staff identities never resolve to personal wallets (returns `null`)
- Customers resolve to their personal user wallet
- B2B partners and sub-users resolve to their agency wallet
- A user without an agency code cannot resolve to any wallet

### Booking Issue Permissions

Determines who can issue (ticket) a booking:

```typescript
export function canIssueBooking(
  session: DashboardSession,
  booking: Pick<BookingRow, 'booking_owner_type' | 'booking_owner_key' | 'status' | 'lifecycle_status'>
): boolean {
  // Must be in on-hold or pending state
  if (booking.status !== 'on-hold' && booking.status !== 'pending') return false;
  if (booking.status === 'on-hold' && booking.lifecycle_status !== 'on-hold') return false;
  if (!booking.booking_owner_type || !booking.booking_owner_key) return false;

  // Financial operators can issue any owner-backed booking
  if (hasFinancialAccess(session.role)) return true;

  // Rare Pending prerequisite/compatibility bookings require operational access
  if (booking.status === 'pending') return false;

  // Non-financial users can only issue their own wallet's bookings
  const owner = walletOwnerForSession(session);
  return (
    owner?.ownerType === booking.booking_owner_type &&
    owner.ownerKey === booking.booking_owner_key
  );
}
```

### Booking Cancel Permissions

Determines who can cancel a booking:

```typescript
export function canCancelBooking(
  session: DashboardSession,
  booking: Pick<BookingRow, 'booking_owner_type' | 'booking_owner_key' | 'status' | 'lifecycle_status' | 'direct_ticketing' | 'issued_at'>
): boolean {
  // Only live on-hold bookings can be cancelled
  if (booking.direct_ticketing || booking.issued_at ||
      booking.status !== 'on-hold' || booking.lifecycle_status !== 'on-hold') {
    return false;
  }
  if (!booking.booking_owner_type || !booking.booking_owner_key) return false;

  // Financial operators can cancel any booking
  if (hasFinancialAccess(session.role)) return true;

  // Non-financial users can only cancel their own wallet's bookings
  const owner = walletOwnerForSession(session);
  return owner?.ownerType === booking.booking_owner_type
    && owner.ownerKey === booking.booking_owner_key;
}
```

### Booking Creation Permissions

Determines who can create bookings:

```typescript
export function canCreateOwnBooking(role: Role): boolean {
  return role === 'customer' || role === 'b2b' || role === 'b2b_sub';
}
```

Admin and staff cannot create bookings directly — they manage bookings created by customers and agencies.

### Imported Booking Permissions

IMP/EXP separates privileged operations from customer financial authorization:

| Action | Authorized roles/owner | Financial effect |
| ------ | ---------------------- | ---------------- |
| Retrieve/import | `superadmin`, `admin`, `staff_support` | Held: none; direct confirmed: assigned owner charged |
| View import history/assignment targets | `superadmin`, `admin`, `staff_support` | None |
| Confirm & Pay a held import | Exact assigned B2C owner or B2B/B2B sub-user in the assigned agency | Assigned personal/shared agency wallet charged |
| Sync supplier details | `superadmin`, `admin`, `staff_support` | None |

Assignment is mandatory. B2B sub-users resolve to their parent agency wallet.
Operations users are actors only: their wallet is never substituted for the
assigned customer's or agency's wallet, and they cannot use the imported
Confirm & Pay endpoint on the customer's behalf.

The normal Triplover Issue/Cancel/Refresh routes reject imported external-
supplier bookings. Operations staff perform manual supplier work externally and
use the dedicated IMP/EXP Sync route.

An authorized booking viewer sees the airline-authored Supplier Gross on the
imported e-ticket. This presentation rule does not grant financial authority and
does not change the assigned owner's User Payable, wallet debit, or ledger.

## Agency Ownership and Sub-User Permissions

Agency ownership is resolved from the database in `lib/db/agencies.ts` and is the authority for sub-user management permissions.

### Agency Membership Resolution

The `resolveAgency()` function is called during session creation to determine a user's agency membership:

```typescript
export async function resolveAgency(
  userId: string,
  role: Role,
  seedCode: unknown
): Promise<AgencyMembership>
```

**Return Type**:
```typescript
export type AgencyMembership =
  | { ok: true; agencyCode: string | null; isOwner: boolean }
  | { ok: false };
```

**Behavior**:
- Returns `{ ok: false }` on database errors (fail-closed)
- Returns `agencyCode: null, isOwner: false` for non-B2B roles
- For `b2b` role: creates agency on first sight if none exists
- For `b2b_sub` role: links to agency from seed code exactly once, then uses stored link
- Seed code is validated against the `agencies` table before linking

### Database Authority

The database is the single source of truth for agency relationships:

- Clerk's `publicMetadata.agencyCode` is only a seed for new users
- Once stored in `app_users.agency_code`, the database value is authoritative
- Ownership is derived from `agencies.owner_user_id`, not inferred from role
- This prevents mirrored metadata drift from granting incorrect permissions

### Sub-User Management

Sub-user management is gated by both role and ownership:

```typescript
export function canManageSubUsers(role: Role): boolean {
  return role === 'b2b';
}
```

**Important**: This is presentation and routing only. The actual permission check uses `session.isAgencyOwner` from the database:

```typescript
// In session:
isAgencyOwner: agency.ok && agency.isOwner
```

Server actions re-read ownership from the database before allowing any sub-user operation, ensuring that:
- A role change (e.g., demotion) immediately revokes sub-user management
- Database failures fail closed (no sub-user operations)
- A mirrored role that has drifted cannot grant ownership

### Agency Code Generation

Agency codes are generated automatically using `generateAgencyCode()` from `lib/agency.ts`:

- Format: `ST-B2B######` (6 random digits)
- ~900,000 possible codes
- Retry logic handles collisions (up to 8 attempts)
- Uniqueness enforced by database primary key

## Permission Checking Patterns

### User Management Permissions

#### Can Manage Users

```typescript
export function canManageUsers(role: Role): boolean {
  return role === 'superadmin' || role === 'admin';
}
```

Only superadmins and admins can access the Users & Roles section at all.

#### Assignable Roles

```typescript
export function assignableRoles(actor: Role): readonly Role[] {
  if (actor === 'superadmin') return ROLES;
  if (actor === 'admin') return ROLES.filter((r) => r !== 'superadmin');
  return [];
}
```

- Super admins can grant any role, including other super admins
- Admins can grant all roles except super admin
- No other role can grant roles

#### Can Manage User Profile

```typescript
export function canManageUserProfile(actor: Role, target: Role): boolean {
  return canManageUsers(actor) && assignableRoles(actor).includes(target);
}
```

An actor can edit another user's profile if:
1. They can manage users (admin or superadmin)
2. They can assign the target's role

This prevents a plain admin from accessing a super admin's identity documents.

#### Role Assignment Blocking

```typescript
export function userActionBlockedReason(
  actor: { role: Role; clerkId: string },
  target: { role: Role; clerkId: string }
): string | null {
  if (!canManageUsers(actor.role)) {
    return 'You do not have permission to manage users.';
  }
  if (actor.clerkId === target.clerkId) {
    return 'You cannot change your own account here.';
  }
  if (actor.role === 'admin' && target.role === 'superadmin') {
    return 'Only a Super Admin can manage a Super Admin.';
  }
  return null;
}
```

Prevents:
- Non-admins from changing roles
- Self-service role changes (prevents lockout)
- Admins from managing super admins

#### User Deletion Blocking

```typescript
export function userDeleteBlockedReason(
  actor: { role: Role; clerkId: string },
  target: { role: Role; clerkId: string }
): string | null {
  const blocked = userActionBlockedReason(actor, target);
  if (blocked) return blocked;

  if (actor.role !== 'superadmin') {
    return 'Only a Super Admin can delete an account.';
  }
  return null;
}
```

All role assignment blocking rules apply, plus:
- Only super admins can delete accounts
- Admins cannot delete, even their own

### Upgrade Request Permissions

```typescript
export function canRequestUpgrade(role: Role): boolean {
  return role === 'customer';
}
```

Only retail customers can request B2B upgrade. This gates both the UI button and the `/dashboard/upgrade` route (404s for other roles).

### Role Agency Requirement

```typescript
export function roleRequiresAgency(role: Role): boolean {
  return role === SUB_USER_ROLE;
}
```

The `b2b_sub` role cannot be granted without an agency assignment. The grantor supplies the agency code:
- Admins in Users & Roles pick from existing agencies
- B2B partners inviting staff use their own agency (no choice)

## Session and Role Resolution

The dashboard session is created in `lib/dashboard/session.ts` and includes role resolution with development mode support.

### Session Structure

```typescript
export type DashboardSession = {
  clerkId: string;              // Clerk user id (primary key)
  role: Role;                   // Resolved role
  name: string;                 // Display name
  email: string;                // Email address
  signedInAt: number | null;    // Last sign-in timestamp
  agencyCode: string | null;    // Agency code (ST-B2B######)
  isAgencyOwner: boolean;       // Database-derived ownership flag
};
```

### Role Resolution Flow

1. Fetch current user from Clerk
2. Resolve role from `publicMetadata.role` using `resolveRole()`
3. In development mode, check for dev role override cookie
4. Override role if cookie matches current user (prevents privilege escalation)
5. Record user visit in `app_users` table with Clerk's real role
6. Resolve agency membership using `resolveAgency()` with real role
7. Return session with resolved role and agency data

### Development Role Switcher

In development mode, a role switcher allows previewing the dashboard as different roles:

```typescript
const DEV_ROLE_COOKIE = 'dev_role';
```

**Cookie Format**: `{userId}:{role}`

**Security Measures**:
- Cookie is scoped to the user who set it
- Outlives sign-out, so user ID validation prevents following to next account
- Only used in development (`NODE_ENV !== 'production'`)
- Agency resolution uses real role, not previewed role (prevents agency creation)
- User visit records use real role

### Session Error Handling

The session resolver handles Clerk session errors gracefully:

```typescript
async function signedInUser() {
  try {
    return await currentUser();
  } catch (error) {
    if (isSessionGoneError(error)) {
      console.warn('[auth] session no longer names a user; signing out');
      return null;
    }
    throw error;
  }
}
```

When an admin deletes an account while its owner has the dashboard open, the next reload asks Clerk for a user ID that no longer exists. Returning null redirects to sign-in rather than crashing with an error page.

## Security Considerations

### Fail-Closed Design

All permission checks fail closed on errors:

- Database failures return `{ ok: false }` for agency membership
- Unknown role values resolve to `customer` (least privilege)
- Wallet ownership returns `null` for unresolved sessions
- Navigation items that don't match return 404

### Database as Authority

The database is the single source of truth for sensitive data:

- Agency ownership is derived from `agencies.owner_user_id`, not role metadata
- Clerk metadata is only a seed for new users
- Stored links override metadata after first write
- Server actions re-read ownership before every write

### Defense in Depth

Multiple layers enforce permissions:

1. **Navigation hiding**: Users don't see links they can't access
2. **Route gating**: Pages return 404 for unauthorized roles
3. **Server action checks**: Every mutation re-checks permissions
4. **Database constraints**: Foreign keys and unique constraints prevent invalid states

### Privilege Escalation Prevention

Several mechanisms prevent privilege escalation:

- Dev role switcher is scoped to current user and development only
- Agency resolution uses real role, not previewed role
- Role assignment checks `assignableRoles()` hierarchy
- Self-service role changes are blocked
- Admins cannot manage super admins

### Session Safety

Session management includes safety measures:

- Clerk session errors are caught and handled gracefully
- Deleted accounts redirect to sign-in instead of error pages
- Role cookies are user-scoped to prevent cross-account leakage
- Session is cached per request to avoid repeated database writes

### Financial Safety

Financial operations have additional safeguards:

- Admin and staff never resolve to personal wallets
- Financial operators can issue any booking, but this is intentional
- Non-financial users can only operate on their own wallet
- Rare Pending prerequisite/compatibility bookings require an authorized
  operational user; Pending does not imply supplier-wallet failure or prior debit
- Booking status and lifecycle are checked before allowing operations

### Agency Ownership Safety

Agency ownership checks are database-derived and re-read:

- `isAgencyOwner` comes from `agencies.owner_user_id`, not role
- Server actions re-read ownership before sub-user operations
- A role change immediately revokes sub-user management
- Database failures fail closed (no operations allowed)

### Super Admin Booking Decisions

Only `superadmin` may use the one-step decision panel on a booking detail page.
This authority is separate from the ordinary supplier/reconciliation capability
matrix: it does not require supplier evidence, a proposal, maker/checker, or a
second execution action.

The authority is not an arbitrary wallet editor. The database derives the only
permitted charge, capture, release, refund, or no-movement result from the
booking owner's matching wallet reservation and immutable ledger. The actor
cannot substitute an operator wallet or enter a debit amount. An unresolved
accounting conflict rejects the complete decision.

## Cross-References

### Related Documentation

- **[00-README.md](00-README.md)** - Documentation overview and navigation
- **[01-PROJECT-OVERVIEW.md](01-PROJECT-OVERVIEW.md)** - High-level system overview
- **[10-WALLET-SYSTEM.md](10-WALLET-SYSTEM.md)** - Wallet architecture and financial operations
- **[12-DATABASE.md](12-DATABASE.md)** - Database schema and relationships
- **[14-SECURITY.md](14-SECURITY.md)** - Security practices and audit logging
- **[17-IMP-EXP-IMPORTS.md](17-IMP-EXP-IMPORTS.md)** - Imported booking authorization and ownership

### Related Source Files

- `lib/roles.ts` - Role definitions, navigation items, tile access, user management permissions
- `lib/wallet/permissions.ts` - Financial access checks, wallet ownership, booking permissions
- `lib/dashboard/session.ts` - Session creation, role resolution, agency membership
- `lib/db/agencies.ts` - Agency ownership resolution, sub-user linking, code generation
- `lib/dashboard/auth-errors.ts` - Session error detection and handling

## Critical Invariants

1. **Database Authority**: Agency ownership and membership are database facts. Clerk metadata is only a seed for new users and never overrides stored values.

2. **Fail-Closed**: All permission checks must fail closed on errors. Database failures, unknown roles, and missing data must deny access, not grant it.

3. **Role Hierarchy**: Only super admins can manage super admins. Admins cannot assign or manage super admin accounts. This is enforced at every layer.

4. **No Self-Service Role Changes**: Users cannot change their own role through the Users & Roles interface. This prevents lockout and privilege escalation.

5. **Wallet Ownership**: Admin and staff identities never resolve to personal wallets. They only have financial access to issue/cancel bookings, not wallet ownership.

6. **Agency Ownership Check**: Sub-user management requires both `role === 'b2b'` and `isAgencyOwner === true` from the database. One without the other grants nothing.

7. **Dev Mode Isolation**: The development role switcher must not affect production deployments, must not create real agencies, and must not allow privilege escalation.

8. **Session Consistency**: The session cache must not cause permission drift. Role changes and agency ownership changes must take effect on the next request.

9. **Navigation Gating**: If a role cannot see a navigation item, the corresponding page must return 404. This prevents direct URL access from bypassing UI controls.

10. **Financial Operator Scope**: Financial operators (superadmin, admin, staff_support, staff_account) can issue eligible Triplover bookings, but this does not make them the financial owner. Non-financial users are strictly limited to their own wallet.

11. **Imported Booking Boundary**: Only superadmin/admin/support may import or Sync, while only the exact assigned customer/agency owner may Confirm & Pay a held import. No operator-wallet fallback is permitted.

12. **Super Admin Issue Now Resolution Boundary**: Only Super Admin may bypass evidence and maker/checker for an explicit stuck ordinary B2B/B2C Issue Now resolution. Complete local accounting uses automatic Capture/Release/No Movement. Incomplete local accounting may use only the separate supplier-verified manual lane, whose booking-owner wallet, independent customer amount, exact Available/Hold preview, immutable ledger, atomic locking, and idempotency are mandatory. Instant Purchase, imports, deposits, and generic wallet adjustments are outside this authority.

## Before Modifying This System

1. **Understand the Permission Flow**: Trace how a permission check flows from navigation → route → server action → database. Changes at one layer may require updates at others.

2. **Test Fail-Closed Behavior**: Ensure any new permission check handles errors by denying access. Test with database failures, missing data, and invalid inputs.

3. **Verify Database Authority**: Any new agency or ownership relationship must be stored in the database and derived from there, not from Clerk metadata or session state.

4. **Check Cross-References**: Update related documentation files (WALLET-SYSTEM, DATABASE, SECURITY) if the change affects those systems.

5. **Test Role Hierarchy**: Verify that role assignment and management rules still enforce the super-admin/admin boundary after changes.

6. **Validate Dev Mode Safety**: Ensure any changes to role resolution or agency creation do not break development mode isolation or allow privilege escalation.

7. **Review Financial Safety**: If modifying financial permissions, ensure the distinction between financial access and wallet ownership is preserved.

8. **Update Test Cases**: Add or update test cases for the new permission logic, including edge cases and error conditions.

9. **Audit Navigation Items**: If adding or removing navigation items, verify the role sets are disjoint where appropriate (e.g., multiple labels for one segment).

10. **Check Session Caching**: Ensure session cache invalidation is handled correctly if the change affects session resolution or agency membership.
