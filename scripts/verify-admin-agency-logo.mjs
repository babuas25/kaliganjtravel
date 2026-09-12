import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

const [actions, dialog, agencies, bookings] = await Promise.all([
  read('app/(dashboard)/dashboard/users/actions.ts'),
  read('components/dashboard/UserDetailsDialog.tsx'),
  read('lib/db/agencies.ts'),
  read('lib/db/flight-bookings.ts'),
]);

// Authorization is enforced at the action boundary and against Clerk's fresh
// target role, not inferred from the visible manager-only dialog.
assert.match(actions, /const actor = await requireManager\(\)/);
assert.match(actions, /canManageUserProfile\(actorRole, role\)/);
assert.match(actions, /role !== 'b2b' && role !== 'b2b_sub'/);
assert.match(actions, /agencyProfileOwnerFor\(clerkId\)/);

// The server verifies the declared image against its bytes before any upload,
// and stores the private asset on the canonical agency-owner profile.
assert.match(actions, /LOGO_EXTENSIONS\[file\.type\]/);
assert.match(actions, /file\.size > LOGO_MAX_BYTES/);
assert.match(actions, /inspectLogoBytes\(bytes, file\.type\)/);
assert.match(actions, /authenticated: true/);
assert.match(
  actions,
  /setProfileDocument\(target\.ownerUserId, 'logo', next\)/
);
assert.match(
  actions,
  /setProfileDocument\(target\.ownerUserId, 'logo', null\)/
);
const uploadAction = actions.slice(
  actions.indexOf('export async function uploadUserAgencyLogo'),
  actions.indexOf('export async function removeUserAgencyLogo')
);
assert.ok(
  uploadAction.indexOf("outcome: 'attempted'") <
    uploadAction.indexOf('uploadAsset(bytes'),
  'The audit attempt must succeed before uploading a new agency logo'
);
assert.match(
  actions,
  /if \(role === 'b2b'\)[\s\S]*?ownerUserId: clerkId/,
  'A newly promoted B2B partner must be editable before first dashboard visit'
);
assert.match(actions, /if \(replaced\) await discardDocuments\(\[replaced\]\)/);
assert.match(actions, /if \(existing\) await discardDocuments\(\[existing\]\)/);

// A sub-user is resolved through app_users -> agencies.owner_user_id, so its
// dialog cannot accidentally write branding to the sub-user's own profile row.
assert.match(agencies, /export async function agencyProfileOwnerFor/);
assert.match(agencies, /\.from\(APP_USERS\)[\s\S]*?\.select\('agency_code'\)/);
assert.match(agencies, /\.from\(AGENCIES\)[\s\S]*?\.select\('owner_user_id'\)/);

// Only the logo gains mutation controls; all other file fields continue down
// the existing signed-link-only branch.
assert.match(dialog, /spec\.name === 'logo'/);
assert.match(dialog, /detail\.role === 'b2b' \|\| detail\.role === 'b2b_sub'/);
assert.match(dialog, /uploadUserAgencyLogo\(data\)/);
assert.match(dialog, /removeUserAgencyLogo\(clerkId\)/);
assert.match(dialog, /accept=\{LOGO_ACCEPT\}/);
assert.match(dialog, /Other documents[\s\S]*?account holder/);

// Booking branding already consumes the agency owner's logo, which is the row
// the new actions update.
assert.match(bookings, /owner_user_id/);
assert.match(bookings, /coerceDocumentMap\([\s\S]*?\['logo'\]\)/);

console.log(
  'Admin agency-logo permissions, canonical ownership, upload safety, UI scope, and booking consumption verified.'
);
