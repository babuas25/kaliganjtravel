# Authentication System

ShoponTravels uses Clerk as the authentication provider, handling user identity, sessions, and role management. The authentication system is integrated with a custom role-based access control system and a server-only database access model.

## Authentication Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                         User Browser                              │
│                    Clerk.js Authentication                        │
│                    (Sign In / Sign Up)                            │
└─────────────────────────────────────────────────────────────────┘
                              │
                              │ OAuth/Email
                              │
┌─────────────────────────────────────────────────────────────────┐
│                        Clerk Service                              │
│  ┌────────────────────────────────────────────────────────────┐  │
│  │                 User Management                             │  │
│  │  - User accounts and credentials                           │  │
│  │  - Email verification                                       │  │
│  │  - Password management                                      │  │
│  │  - Session management                                       │  │
│  │  - Role metadata (publicMetadata.role)                      │  │
│  │  - Agency code metadata (publicMetadata.agencyCode)         │  │
│  └────────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
                              │
                              │ JWT Session Token
                              │
┌─────────────────────────────────────────────────────────────────┐
│                    Next.js Application                            │
│  ┌────────────────────────────────────────────────────────────┐  │
│  │              Session Resolution (lib/dashboard/session.ts)  │  │
│  │  - currentUser() from Clerk                                 │  │
│  │  - Role resolution from metadata                            │  │
│  │  - Agency lookup from database                              │  │
│  │  - User visit recording to app_users                        │  │
│  └────────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
                              │
                              │ DashboardSession
                              │
┌─────────────────────────────────────────────────────────────────┐
│                   Application Components                          │
│  ┌────────────────────────────────────────────────────────────┐  │
│  │              Authorization Checks                             │  │
│  │  - Role-based access control                                 │  │
│  │  - Agency ownership verification                             │  │
│  │  - Wallet permission checks                                  │  │
│  └────────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
```

## Clerk Integration

### Authentication Methods

Clerk supports multiple authentication methods:

- **Email/Password**: Traditional email and password authentication
- **OAuth**: Social login providers (Google, etc.)
- **Phone/SMS**: Phone number-based authentication
- **Magic Links**: Passwordless email authentication

### User Metadata

Clerk stores user metadata in `publicMetadata`:

```typescript
// Clerk user metadata structure
{
  role: 'customer' | 'b2b' | 'b2b_sub' | 'admin' | 'superadmin' | 'staff_*',
  agencyCode: 'ST-B2B######' | null
}
```

- **role**: User's role in the system (see [04-ROLES-AND-PERMISSIONS.md](04-ROLES-AND-PERMISSIONS.md))
- **agencyCode**: Agency code for B2B users (format: `ST-B2B######`)

## Session Management

### Session Resolution

Session resolution is handled by `lib/dashboard/session.ts`:

```typescript
export const getDashboardSession = cache(
  async (): Promise<DashboardSession | null> => {
    const user = await signedInUser();
    if (!user) return null;

    const clerkRole = resolveRole(user.publicMetadata?.role);
    let role = clerkRole;

    // Dev role switcher (development only)
    if (IS_DEV) {
      const [ownerId, previewed] = (await cookies())
        .get(DEV_ROLE_COOKIE)?.value ?? ''
        .split(':');
      if (previewed && ownerId === user.id) {
        role = resolveRole(previewed);
      }
    }

    // Record user visit in database
    await recordUserVisit({
      clerkId: user.id,
      email: user.primaryEmailAddress?.emailAddress ?? '',
      firstName: user.firstName,
      lastName: user.lastName,
      role: clerkRole,
    });

    // Resolve agency from database
    const agency = await resolveAgency(
      user.id,
      clerkRole,
      user.publicMetadata?.agencyCode
    );

    return {
      clerkId: user.id,
      role: role ?? DEFAULT_ROLE,
      name: [user.firstName, user.lastName].filter(Boolean).join(' ') || 'there',
      email: user.primaryEmailAddress?.emailAddress ?? '',
      signedInAt: user.lastSignInAt ?? null,
      agencyCode: agency.ok ? agency.agencyCode : null,
      isAgencyOwner: agency.ok && agency.isOwner,
    };
  }
);
```

### DashboardSession Structure

```typescript
export type DashboardSession = {
  clerkId: string;              // Clerk user id (primary key)
  role: Role;                   // User's role
  name: string;                 // Display name
  email: string;                // Email address
  signedInAt: number | null;    // Last sign-in timestamp
  agencyCode: string | null;    // Agency code (B2B only)
  isAgencyOwner: boolean;       // Whether user owns their agency
};
```

### Error Handling

Session resolution handles errors gracefully:

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

If a user is deleted while their session is active, the system detects this and signs them out rather than crashing.

## User Registry

### app_users Table

The `app_users` table mirrors Clerk user data:

```sql
create table public.app_users (
  clerk_id     text primary key,
  email        text,
  first_name   text,
  last_name    text,
  role         text not null default 'customer',
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  last_seen_at timestamptz not null default now()
);
```

**Purpose**: 
- Provides a local copy of user data for dashboard operations
- Enables efficient user listing and filtering without paging Clerk API
- Records user visits and activity

**Important**:
- `role` is mirrored from Clerk but never written from the dev role switcher
- This prevents previewing as another role from rewriting the real one
- Clerk remains the authority on identity and role

### User Visit Recording

Every dashboard visit updates the user registry:

```typescript
await recordUserVisit({
  clerkId: user.id,
  email: user.primaryEmailAddress?.emailAddress ?? '',
  firstName: user.firstName,
  lastName: user.lastName,
  role: clerkRole,
});
```

This tracks:
- Last sign-in time
- User activity patterns
- Role changes over time

## Dev Role Switcher

### Purpose

The dev role switcher allows developers to preview the dashboard as different roles during development without changing their actual Clerk role.

### Implementation

- **Cookie-based**: Uses a scoped cookie `dev_role`
- **User-scoped**: Cookie is scoped to the user who set it
- **Production-disabled**: Only active in development environment
- **Safe**: Cannot escalate privileges on production

### Cookie Format

```
{ownerId}:{previewedRole}
```

Example: `user_123:admin`

### Security

- Cookie outlives sign-out to prevent following to next account
- Unscoped cookies are ignored for safety
- Only affects role preview, not actual Clerk role
- Database operations use the real Clerk role, not the previewed one

## Agency Resolution

### Agency Lookup

Agency membership is resolved from the database, not from Clerk metadata:

```typescript
const agency = await resolveAgency(
  user.id,
  clerkRole,
  user.publicMetadata?.agencyCode
);
```

**Why database-first?**
- Database is the source of truth for agency relationships
- Clerk metadata is a convenience mirror for invitations
- Prevents metadata manipulation from granting unauthorized access

### Agency Ownership

The `isAgencyOwner` flag is set based on database ownership:

```typescript
isAgencyOwner: agency.ok && agency.isOwner
```

This flag controls:
- Ability to manage sub-users
- Agency administration permissions
- Staff management within the agency

## Authentication Security

### Session Security

- **JWT-based**: Clerk uses JWT tokens for sessions
- **Secure Cookies**: Session tokens stored in httpOnly cookies
- **Automatic Refresh**: Tokens refresh automatically
- **Session Expiry**: Sessions expire after inactivity

### Role Security

- **Clerk Authority**: Clerk is the source of truth for roles
- **Server Validation**: Roles validated on every request
- **No Client Override**: Client cannot override role through request payload
- **Audit Trail**: Role changes tracked in Clerk audit logs

### Database Security

- **Server-Only Access**: Database access only through service role key
- **No Direct Client Access**: Client components never query database
- **Session-Based Auth**: User identity derived from verified session
- **No API Key Exposure**: Service role key never exposed to client

## Integration with Authorization

### Role-Based Access Control

Authentication feeds into the authorization system:

```typescript
// From lib/roles.ts
export function hasFinancialAccess(role: Role): boolean {
  return FINANCIAL_ROLES.has(role);
}
```

### Agency-Based Access

Agency membership determines access to agency resources:

```typescript
// From lib/wallet/permissions.ts
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

## Authentication Flow

### Sign-In Flow

```
1. User enters credentials
2. Clerk validates credentials
3. Clerk creates session
4. User redirected to dashboard
5. Dashboard resolves session via getDashboardSession()
6. User visit recorded in app_users
7. Agency resolved from database
8. DashboardSession returned to components
```

### Sign-Out Flow

```
1. User clicks sign out
2. Clerk.signOut() called
3. Session destroyed
4. User redirected to sign-in page
5. Dev role switcher cookie cleared (if present)
```

### Session Validation Flow

```
1. Component calls getDashboardSession()
2. currentUser() called via Clerk
3. Clerk validates session token
4. Role resolved from metadata
5. Agency resolved from database
6. DashboardSession returned
7. Components use session for authorization
```

## Related Documentation

- [04-ROLES-AND-PERMISSIONS.md](04-ROLES-AND-PERMISSIONS.md) - Role and permission system
- [02-ARCHITECTURE.md](02-ARCHITECTURE.md) - System architecture
- [14-SECURITY.md](14-SECURITY.md) - Security practices
- [12-DATABASE.md](12-DATABASE.md) - Database schema

## Critical Invariants

### Session Integrity
- User identity must always be derived from verified Clerk session
- Role must come from Clerk metadata, never from request payload
- Agency membership must be resolved from database, not Clerk metadata
- Dev role switcher must never work in production

### Database Consistency
- app_users.role must mirror Clerk's publicMetadata.role
- app_users must never be written from dev role switcher
- Agency relationships must be stored in database, not relied upon from Clerk
- User visits must be recorded on every dashboard load

### Security Boundaries
- Service role key must never be exposed to client
- Client components must never access database directly
- Session validation must happen on every request
- Authentication errors must be handled gracefully

## Before Modifying This System

1. **Review Clerk Documentation**: Understand Clerk's authentication flow and security model
2. **Check Session Dependencies**: Identify all components using getDashboardSession()
3. **Verify Agency Logic**: Ensure agency resolution remains database-first
4. **Test Role Switcher**: Verify dev role switcher remains development-only
5. **Audit Error Handling**: Ensure session errors are handled gracefully
6. **Update Related Systems**: Update authorization checks if session structure changes
7. **Test Sign-In/Sign-Out**: Verify complete authentication flow
8. **Security Review**: Have security changes reviewed before deployment
