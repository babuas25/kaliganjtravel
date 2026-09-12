import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

const [profileModel, ownActions, ownForm, managerActions] = await Promise.all([
  read('lib/profile.ts'),
  read('app/(dashboard)/dashboard/profile/actions.ts'),
  read('components/dashboard/ProfileDetailsForm.tsx'),
  read('app/(dashboard)/dashboard/users/actions.ts'),
]);

assert.match(
  profileModel,
  /AGENCY_IDENTITY_FIELDS = \['agencyName', 'agencyEmail'\]/
);
assert.match(profileModel, /name: 'agencyEmail', label: 'Agency Email'/);

// The self-service action must base the decision on a fresh database read and
// preserve stored identity values; hiding or disabling an input is not enough.
assert.match(ownActions, /const current = await getProfile\(session\.clerkId\)/);
assert.match(ownActions, /sectionsFor\(session\.role\)/);
assert.match(
  ownActions,
  /session\.role === 'b2b' \|\| session\.role === 'b2b_sub'/
);
assert.match(ownActions, /for \(const field of AGENCY_IDENTITY_FIELDS\)/);
assert.match(ownActions, /if \(!stored \|\| requested === stored\) continue/);
assert.match(ownActions, /clean\[field\] = current\.values\[field\]/);
assert.ok(
  ownActions.indexOf('const current = await getProfile') <
    ownActions.indexOf('const result = await saveProfile'),
  'The lock decision must happen before the profile write'
);

// Stored identity fields are visibly read-only in the B2B profile, but blank
// fields remain enabled for their one initial submission.
assert.match(ownForm, /const agencyIdentityLocked =/);
assert.match(ownForm, /Boolean\(defaults\?\.\[name\]\?\.trim\(\)\)/);
assert.match(ownForm, /disabled: agencyIdentityLocked/);
assert.match(ownForm, /locked after first submission/);

// The manager action intentionally remains separate and unrestricted for the
// two fields after its own fresh permission and target-role checks.
const managerSave = managerActions.slice(
  managerActions.indexOf('export async function saveUserProfile'),
  managerActions.indexOf('export type AgencyLogoActionResult')
);
assert.match(managerSave, /canManageUserProfile\(actor\.role, role\)/);
assert.match(managerSave, /for \(const field of PERSISTED_FIELDS\)/);
assert.doesNotMatch(managerSave, /AGENCY_IDENTITY_FIELDS/);

console.log(
  'B2B first-submit agency identity lock, backend preservation, UI state, and manager override verified.'
);
