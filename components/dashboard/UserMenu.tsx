'use client';

import { useState } from 'react';
import { UserButton } from '@clerk/nextjs';
import { Building2, Check } from 'lucide-react';

interface Props {
  /**
   * The agency this user belongs to (`ST-B2B######`), or null for everyone
   * outside one — staff, admins, retail customers, and any agency user whose
   * lookup failed. Only a real code adds the row.
   */
  agencyCode: string | null;
}

/**
 * The account button in the topbar, with the agency code carried in the menu
 * for a B2B partner and their sub users. Support asks for that code on every
 * call, and without this it can only be read off the Company page.
 *
 * Clerk's menu has no inert row — every item is a button — so the code is a
 * copy action, which is what it is wanted for anyway.
 *
 * The two built-in actions are re-declared rather than left implicit because
 * Clerk forces "Manage account" to the top of the menu unless it is named,
 * which would otherwise bury the code between the two of them.
 */
export default function UserMenu({ agencyCode }: Props) {
  const [copied, setCopied] = useState(false);

  if (!agencyCode) return <UserButton />;

  const copyAgencyCode = async () => {
    try {
      await navigator.clipboard.writeText(agencyCode);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      // A browser that refuses the clipboard is no loss: the code is on screen.
    }
  };

  return (
    <UserButton>
      <UserButton.MenuItems>
        <UserButton.Action
          label={`Agency ID · ${agencyCode}`}
          labelIcon={
            copied ? (
              <Check className="h-4 w-4 text-emerald-600" />
            ) : (
              <Building2 className="h-4 w-4" />
            )
          }
          onClick={copyAgencyCode}
        />
        <UserButton.Action label="manageAccount" />
        <UserButton.Action label="signOut" />
      </UserButton.MenuItems>
    </UserButton>
  );
}
