# Deployment

Current company setup and verification: [Kaliganj rebranding](24-KALIGANJ-REBRANDING.md). The applied fresh-install baseline is frozen. Use only the `supabase/fresh-install` workdir for forward migrations; never import previous-company backups or use the root historical migration chain. Commands below are operational reference, not evidence of a completed deployment.

Kaliganj Travels uses the new Supabase project below. A new Vercel deployment has not yet been verified. This document covers deployment architecture, procedures, environment configuration, and operational considerations.

## Deployment Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                    Vercel Platform                               │
│  ┌────────────────────────────────────────────────────────────┐  │
│  │              Next.js Application                             │  │
│  │  - Server-side rendering                                    │  │
│  │  - API routes                                               │  │
│  │  - Static assets                                            │  │
│  │  - Edge functions (if used)                                 │  │
│  └────────────────────────────────────────────────────────────┘  │
│  ┌────────────────────────────────────────────────────────────┐  │
│  │              Environment Variables                           │  │
│  │  - Supabase credentials                                     │  │
│  │  - Clerk credentials                                         │  │
│  │  - Supplier API credentials                                │  │
│  │  - SMTP credentials                                         │  │
│  │  - Feature flags                                            │  │
│  └────────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
                              │
                              │ HTTPS
                              │
┌─────────────────────────────────────────────────────────────────┐
│                    Supabase (PostgreSQL 17)                      │
│  ┌────────────────────────────────────────────────────────────┐  │
│  │              Database                                        │  │
│  │  - Tables and views                                         │  │
│  │  - Functions and RPCs                                       │  │
│  │  - Triggers and constraints                                 │  │
│  └────────────────────────────────────────────────────────────┘  │
│  ┌────────────────────────────────────────────────────────────┐  │
│  │              Storage                                         │  │
│  │  - File storage (if used)                                   │  │
│  └────────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
                              │
                              │ HTTPS
                              │
┌─────────────────────────────────────────────────────────────────┐
│                    External Services                              │
│  ┌────────────┐ ┌────────────┐ ┌────────────┐ ┌────────────┐  │
│  │ Clerk      │ │ Triplover  │ │ Cloudinary │ │ SMTP (Zoho) │  │
│  │ Auth       │ │ API        │ │ Storage    │ │ Email       │  │
│  └────────────┘ └────────────┘ └────────────┘ └────────────┘  │
└─────────────────────────────────────────────────────────────────┘
```

## Deployment Platforms

### Vercel

**Role**: Application hosting and deployment platform

**Features**:
- Automatic deployments from Git
- Preview deployments for pull requests
- Edge network for global performance
- Environment variable management
- Built-in HTTPS and SSL
- Automatic scaling

**Configuration**:
- `vercel.json` is not present; configure the new Vercel project explicitly
- `next.config.js` for Next.js configuration
- Environment variables in Vercel dashboard

### Supabase

**Role**: Database and backend services

**Features**:
- PostgreSQL 17 database
- PostgREST API
- Real-time subscriptions
- Storage buckets
- Authentication (not used - Clerk instead)
- Edge functions

**Project**: `ljzoizsogbirlvlsrwzi`
**Region**: `ap-southeast-1` (Singapore)

## Environment Configuration

### Required Environment Variables

#### Supabase
```bash
NEXT_PUBLIC_SUPABASE_URL=https://ljzoizsogbirlvlsrwzi.supabase.co
SUPABASE_SERVICE_ROLE_KEY=YOUR_SUPABASE_SERVICE_ROLE_KEY
```

#### Clerk
```bash
NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=pk_test_...
CLERK_SECRET_KEY=sk_test_...
NEXT_PUBLIC_CLERK_SIGN_IN_URL=/sign-in
NEXT_PUBLIC_CLERK_SIGN_UP_URL=/sign-up
NEXT_PUBLIC_CLERK_AFTER_SIGN_IN_URL=/dashboard
NEXT_PUBLIC_CLERK_AFTER_SIGN_UP_URL=/dashboard
```

#### Triplover Supplier
```bash
FIRSTTRIP_SEARCH_BASE_URL=https://firsttrip-search.example.com
FIRSTTRIP_BASE_URL=https://firsttrip-api.example.com
FIRSTTRIP_EMAIL=firsttrip@example.com
FIRSTTRIP_PASSWORD=base64_encoded_firsttrip_password

TAKEOFF_SEARCH_BASE_URL=https://takeoff-search.example.com
TAKEOFF_BASE_URL=https://takeoff-api.example.com
TAKEOFF_EMAIL=takeoff@example.com
TAKEOFF_PASSWORD=base64_encoded_takeoff_password
```

Choose the active supplier and the booking/ticketing gates from **Dashboard →
Supplier Control** after the database migration is applied. Each supplier needs
its own pair of URLs; do not share or infer them. The selected supplier is bound
to the search and booking workflow that started with it.

#### IMP/EXP Direct Airline Retrieval

```bash
# Optional when executable auto-discovery is insufficient
CHROME_EXECUTABLE_PATH=/path/to/chrome-or-edge

# Optional override for the serverless Chromium release pack. Vercel uses the
# matching official GitHub release by default, so this is normally not needed.
CHROMIUM_PACK_URL=https://cdn.example.com/chromium-v143.0.4-pack.x64.tar

# Optional stable Manage Booking entry overrides
US_BANGLA_FIND_BOOKING_URL=https://...
AIR_ASTRA_FIND_BOOKING_URL=https://...
NOVOAIR_RETRIEVE_BOOKING_URL=https://...
```

Vercel uses `@sparticuz/chromium-min` and downloads the matching compressed
Chromium pack into `/tmp` on the first cold invocation. The default pack is the
official Sparticuz v143.0.4 GitHub release; set `CHROMIUM_PACK_URL` only when a
faster private CDN or mirror is required. The browser binary is not shipped in
the Hobby function bundle. Normal hosts use an installed Chrome, Chromium, or
Microsoft Edge executable. No Tripfeels/import-proxy environment variable is
used.

This packaging solves browser availability only. A Vercel Function still runs
in a separate cloud browser and network and cannot inherit an operator's Chrome
cookies, device verification, browser profile, or IP. A temporary airline
`(S(...))` URL therefore does not guarantee production retrieval. If the
airline returns Device Check/CAPTCHA, the supported remedies are an official API
or a supplier-approved integration host/network—not additional browser spoofing
or challenge bypass code.

#### Email (SMTP)
```bash
SMTP_HOST=smtp.zoho.com
SMTP_PORT=587
SMTP_USER=your-new-smtp-account
SMTP_PASSWORD=********
EMAIL_FROM_ADDRESS=your-authorized-sender-address
EMAIL_FROM_NAME=Kaliganj Travels
EMAIL_REPLY_TO=support@kaliganjtravel.com
SMTP_SECURE=false
SMTP_REQUIRE_TLS=true
```

#### Cloudinary
```bash
CLOUDINARY_CLOUD_NAME=your-cloud-name
CLOUDINARY_API_KEY=********
CLOUDINARY_API_SECRET=********
```

### Feature Flags

```bash
# Booking lifecycle staged rollout (all are server-only and fail closed)
BOOKING_LIFECYCLE_OPERATION_WORKERS_ENABLED=false
BOOKING_LIFECYCLE_IMPORTED_WORKERS_ENABLED=false
BOOKING_RECONCILIATION_ACTIONS_ENABLED=false
BOOKING_IMPORTED_MANUAL_ACTIONS_ENABLED=false
BOOKING_NOTIFICATION_OUTBOX_ENABLED=false
BOOKING_LIFECYCLE_SCALABLE_SWEEP_ENABLED=false

# Development
NODE_ENV=production
```

Set a lifecycle switch to the exact string `true` only for its recorded rollout
stage. Change and redeploy one behavior family at a time. When the scalable
sweep is false, the protected scheduler uses the retained bounded compatibility
observer; the other false switches skip their new work or reject the guarded
staff action with `503` before external or financial effects.

## Deployment Process

### Initial Setup

1. **Vercel Project Setup**:
   ```bash
   vercel link
   vercel env add NEXT_PUBLIC_SUPABASE_URL
   vercel env add SUPABASE_SERVICE_ROLE_KEY
   # Add all other environment variables
   ```

2. **Supabase Setup**:
   ```bash
   supabase login
   supabase link --workdir supabase/fresh-install --project-ref ljzoizsogbirlvlsrwzi
   supabase db push --workdir supabase/fresh-install
   ```

3. **Clerk Setup**:
   - Create Clerk application
   - Configure JWT templates
   - Set up redirect URLs
   - Add environment variables to Vercel

### Deployment Workflow

#### Automatic Deployment

**Trigger**: Push to `main` branch

**Process**:
1. Vercel detects push
2. Builds Next.js application
3. Runs build-time scripts
4. Deploys to production
5. Updates DNS (if needed)

**Build Command**:
```bash
npm run build
```

#### Manual Deployment

```bash
# Deploy to production
vercel --prod

# Deploy to preview
vercel
```

### Database Migrations

**Apply Migrations**:
```bash
supabase db push --workdir supabase/fresh-install
```

**Migration Workflow**:
1. Create new migration: `supabase migration new description --workdir supabase/fresh-install`
2. Write SQL in migration file
3. Test locally: `supabase db reset --local --workdir supabase/fresh-install`
4. Apply to remote: `supabase db push --workdir supabase/fresh-install`
5. Verify in Supabase dashboard

**Important**:
- Migrations are forward-only
- Never edit applied migrations
- Fix issues with new migrations
- Test migrations on staging first

### IMP/EXP Deployment Gate

IMP/EXP database migration approval is separate from application deployment.
Pushing the database does not authorize an application deployment or any
historical wallet-balance/backfill operation.

Required migration order:

1. `0037_impexp_booking_imports.sql`
2. `0038_impexp_passenger_details.sql`
3. `0039_fix_us_bangla_pnr_month_day_deadlines.sql`
4. `0040_impexp_wallet_and_sync.sql`

Before applying remotely:

1. Run the migration chain against a disposable/local PostgreSQL database.
2. Verify `create_impexp_booking`, `wallet_confirm_impexp_booking`, and
   `sync_impexp_booking` with held, confirmed, insufficient, frozen, retry, and
   concurrent scenarios.
3. Run `npm run verify:impexp-wallet`, `npm run typecheck`, `npm run lint`, and
   `npm run build`.
4. Confirm `booking_lifecycle_v` exposes the new pricing columns and
   `booking_payment_report_v` is successfully recreated with its established
   payment projection.
5. Validate the server-side browser in the target preview environment for all
   three approved airlines. Confirm both runtime launch and actual supplier
   acceptance; a successful localhost/manual Chrome lookup is not production
   validation.
6. Verify imported booking details and generated email/PDF tickets show Supplier
   Gross while wallet/payment/ledger records retain User Payable.

The migration deliberately does not derive historical User Payable from
Supplier Gross and does not repair existing balances. Historical imports that
lack protected owner/User Payable data require explicit reconciliation.

## Build Configuration

### Next.js Configuration

```javascript
// next.config.js
module.exports = {
  reactStrictMode: true,
  swcMinify: true,
  images: {
    domains: ['res.cloudinary.com'],
  },
  experimental: {
    serverActions: true,
  },
};
```

### TypeScript Configuration

```json
{
  "compilerOptions": {
    "target": "ES2020",
    "lib": ["ES2020", "DOM", "DOM.Iterable"],
    "jsx": "preserve",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "resolveJsonModule": true,
    "allowJs": true,
    "strict": true,
    "noEmit": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "incremental": true
  }
}
```

## Deployment Verification

### Pre-Deployment Checklist

- [ ] All environment variables set
- [ ] Database migrations applied
- [ ] Build succeeds locally
- [ ] Tests pass
- [ ] No uncommitted secrets
- [ ] Feature flags configured correctly
- [ ] `npm run verify:booking-rollout-controls` passes
- [ ] Lifecycle rollout switch state and rollback deployment ID are recorded
- [ ] IMP/EXP migrations tested locally and approved for this environment
- [ ] `npm run verify:impexp-wallet` passes
- [ ] Chromium/Edge runtime is available for direct airline retrieval
- [ ] Target airline permits the deployed browser/network or an approved API/host is configured
- [ ] SSL certificates valid
- [ ] DNS configured correctly

### Post-Deployment Verification

- [ ] Application loads correctly
- [ ] Authentication works
- [ ] Database connectivity verified
- [ ] Supplier API connectivity verified
- [ ] IMP/EXP Retrieve & Review works from the deployed environment without an airline Device Check/CAPTCHA
- [ ] Held import creates On Hold/Unpaid without a debit
- [ ] Direct confirmed import and owner confirmation debit User Payable exactly once
- [ ] Repeated Sync creates no wallet or ledger movement
- [ ] Imported web/email/PDF e-ticket shows Supplier Gross, not User Payable
- [ ] Email sending verified
- [ ] File uploads work
- [ ] Rate limiting active
- [ ] Security audit logging works

### Health Checks

**Database Connectivity**:
```bash
# Via verification script
node scripts/verify-database.mjs
```

**Email Connectivity**:
```bash
# Via verification script
node scripts/verify-email.mjs
```

**Supplier API**:
```bash
# Test supplier connection
node scripts/verify-supplier.mjs
```

## Monitoring and Logging

### Vercel Analytics

- Application performance monitoring
- Real user monitoring (RUM)
- Build time tracking
- Error tracking

### Supabase Monitoring

- Database performance metrics
- Query performance
- Connection pool usage
- Storage usage

### Application Logging

**Error Logging**:
- Server errors logged to console
- Security audit events to database
- Supplier errors logged with context

**Monitoring Tools**:
- Vercel logs
- Supabase logs
- Application console logs

## Scaling Considerations

### Database Scaling

**Current Capacity**:
- Supabase Pro tier
- Appropriate for current load
- Monitor connection pool usage

**Scaling Indicators**:
- High connection pool usage
- Slow query performance
- High storage usage

**Scaling Actions**:
- Upgrade Supabase tier
- Optimize queries
- Add read replicas
- Implement caching

### Application Scaling

**Vercel Scaling**:
- Automatic horizontal scaling
- Edge functions for global performance
- Serverless functions for API routes

**Scaling Indicators**:
- High response times
- Memory limits exceeded
- Function timeouts

**Scaling Actions**:
- Optimize code performance
- Implement caching
- Use edge functions
- Upgrade Vercel plan

## Backup and Recovery

### Database Backups

**Supabase Backups**:
- Automatic daily backups
- Point-in-time recovery (PITR)
- 7-day retention (configurable)

**Manual Backups**:
```bash
# Dump database
supabase db dump -f backup.sql

# Restore database
supabase db reset --local --workdir supabase/fresh-install
```

### Recovery Procedures

**Database Recovery**:
1. Identify failure point
2. Select appropriate backup
3. Restore to Supabase
4. Verify data integrity
5. Test application connectivity

**Application Recovery**:
1. Rollback to previous deployment
2. Verify environment variables
3. Test critical functionality
4. Monitor for issues

## Security in Production

### SSL/TLS

- HTTPS enforced on all endpoints
- SSL certificates managed by Vercel
- TLS 1.2+ required for SMTP
- HSTS headers configured

### Environment Variable Security

- Secrets stored in Vercel environment variables
- Never committed to repository
- Rotated regularly
- Access limited to authorized personnel

### Dependency Updates

- Regular dependency updates
- Security vulnerability scanning
- Automated dependency updates (Dependabot)
- Manual review of security updates

## Troubleshooting

### Common Issues

**Build Failures**:
- Check build logs in Vercel
- Verify environment variables
- Check for TypeScript errors
- Verify dependency versions

**Runtime Errors**:
- Check Vercel function logs
- Verify database connectivity
- Check environment variables
- Verify supplier API status

**Performance Issues**:
- Check Vercel analytics
- Verify database query performance
- Check for memory leaks
- Implement caching

### Debug Mode

Enable debug logging:
```bash
NODE_ENV=development vercel --prod
```

### Rollback Procedure

```bash
# Rollback to previous deployment
vercel rollback
```

## Related Documentation

- [01-PROJECT-OVERVIEW.md](01-PROJECT-OVERVIEW.md) - Technology stack
- [02-ARCHITECTURE.md](02-ARCHITECTURE.md) - System architecture
- [12-DATABASE.md](12-DATABASE.md) - Database deployment
- [14-SECURITY.md](14-SECURITY.md) - Security practices
- [17-IMP-EXP-IMPORTS.md](17-IMP-EXP-IMPORTS.md) - IMP/EXP runtime, migration, and verification requirements

## Critical Invariants

### Environment Security
- All secrets must be in environment variables
- Secrets must never be committed to repository
- Production secrets must differ from development
- Secrets must be rotated regularly

### Deployment Safety
- Database migrations must be tested before production
- Rollback plan must exist for each deployment
- Feature flags must control new features
- Build must succeed before deployment
- Imported pricing must never be backfilled from Supplier Gross without an approved reconciliation plan
- Production wallet balances and historical imported bookings must not be modified by deployment scripts
- Chromium packaging success must not be reported as supplier acceptance; Device Check/CAPTCHA remains an upstream integration failure

### Monitoring
- Critical systems must have monitoring
- Alerts must be configured for failures
- Logs must be retained for debugging
- Performance must be tracked

### Backup and Recovery
- Regular database backups must be maintained
- Recovery procedures must be tested
- Backup restoration must be documented
- Critical data must be backed up

## Before Modifying Deployment

1. **Test Locally**: Verify changes work in development
2. **Check Environment Variables**: Ensure all required variables are set
3. **Test Migrations**: Verify database migrations work
4. **Plan Rollback**: Have rollback plan ready
5. **Schedule Maintenance**: Coordinate with stakeholders
6. **Monitor Deployment**: Watch for issues after deployment
7. **Verify Functionality**: Test critical features
8. **Check Logs**: Review for errors
9. **Update Documentation**: Document deployment changes
10. **Communicate**: Notify team of deployment
