/**
 * Timing rules for the dashboard welcome banner. Kept out of the client
 * component so the server page can call them too — exports from a 'use client'
 * module can only be rendered or passed as props, never invoked server-side.
 */

/** How long the banner stays up, measured from the sign-in itself. */
export const WELCOME_VISIBLE_MS = 45_000;

/** Length of the fade-out before the banner unmounts. */
export const WELCOME_FADE_MS = 300;

/**
 * True while the banner still has time left on the clock. Shared by the server
 * (for the initial HTML) and the client (after the timer fires), so both agree.
 */
export function isWelcomeVisible(signedInAt: number | null, now = Date.now()) {
  if (signedInAt === null) return true;
  return now - signedInAt < WELCOME_VISIBLE_MS;
}
