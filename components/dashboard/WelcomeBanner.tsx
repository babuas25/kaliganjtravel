'use client';

import { useEffect, useState } from 'react';

import { cn } from '@/lib/utils';
import {
  WELCOME_FADE_MS,
  WELCOME_VISIBLE_MS,
} from '@/lib/dashboard/welcome';

interface Props {
  name: string;
  roleLabel: string;
  /** Epoch ms of the sign-in; null falls back to 45s from page load. */
  signedInAt: number | null;
  /** The server's verdict, so the first client render matches the HTML. */
  initialVisible: boolean;
}

export default function WelcomeBanner({
  name,
  roleLabel,
  signedInAt,
  initialVisible,
}: Props) {
  const [visible, setVisible] = useState(initialVisible);
  const [fading, setFading] = useState(false);

  useEffect(() => {
    if (!visible) return;

    const elapsed = signedInAt === null ? 0 : Date.now() - signedInAt;
    const remaining = Math.max(WELCOME_VISIBLE_MS - elapsed, 0);

    const fade = setTimeout(() => setFading(true), remaining);
    const hide = setTimeout(
      () => setVisible(false),
      remaining + WELCOME_FADE_MS
    );

    return () => {
      clearTimeout(fade);
      clearTimeout(hide);
    };
  }, [signedInAt, visible]);

  if (!visible) return null;

  return (
    <section
      className={cn(
        'rounded-lg bg-hero-gradient p-6 text-white transition-opacity duration-300 sm:p-8',
        fading ? 'opacity-0' : 'opacity-100'
      )}
    >
      <p className="text-sm text-navy-100">Welcome back</p>
      <h2 className="mt-1 text-2xl font-bold sm:text-3xl">{name}</h2>
      <p className="mt-2 max-w-xl text-sm text-navy-100">
        You&apos;re signed in as {roleLabel}. Here&apos;s a summary of everything
        you can see.
      </p>
    </section>
  );
}
