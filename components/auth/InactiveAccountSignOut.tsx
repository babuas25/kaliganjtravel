'use client';

import { useEffect } from 'react';
import { useClerk } from '@clerk/nextjs';

/** Ends a just-created Clerk session when the application has disabled it. */
export default function InactiveAccountSignOut() {
  const { signOut } = useClerk();

  useEffect(() => {
    void signOut({ redirectUrl: '/' });
  }, [signOut]);

  return (
    <main className="flex min-h-screen items-center justify-center bg-navy-50 px-4 text-navy-950">
      <section className="w-full max-w-md rounded-xl border border-navy-100 bg-white p-6 text-center shadow-sm">
        <h1 className="text-lg font-semibold">Account inactive</h1>
        <p className="mt-2 text-sm text-navy-700/75">
          This account has been deactivated. You are being signed out.
        </p>
      </section>
    </main>
  );
}
