import { z } from 'zod';

export const promotionSlideSchema = z.object({
  id: z.string().uuid(),
  title: z.string().trim().min(1).max(120),
  imageUrl: z.string().url().refine((value) => {
    const url = new URL(value);
    return url.protocol === 'https:' && url.hostname === 'res.cloudinary.com';
  }, 'Upload a promotional image first.'),
  link: z.string().trim().max(2000).refine((value) => {
    if (!value) return true;
    if (value.startsWith('/') && !value.startsWith('//') && !value.includes('\\')) return true;
    try { const url = new URL(value); return url.protocol === 'https:'; } catch { return false; }
  }, 'Use a site path or an HTTPS link.'),
  details: z.string().trim().max(12000).optional(),
  terms: z.string().trim().max(6000).optional(),
  active: z.boolean(),
});
export const PROMOTION_AUTO_CLOSE_OPTIONS = [10, 15, 20, 25, 30] as const;
export const PROMOTION_PAGES = [
  { path: '/dashboard', label: 'Dashboard' },
  { path: '/dashboard/flight-search', label: 'Flight search' },
  { path: '/dashboard/announcements', label: 'Announcements' },
] as const;
export const PROMOTION_REPEAT_OPTIONS = [
  { minutes: 0, label: 'Do not repeat automatically' },
  { minutes: 15, label: 'Every 15 minutes' },
  { minutes: 30, label: 'Every 30 minutes' },
  { minutes: 60, label: 'Every hour' },
  { minutes: 180, label: 'Every 3 hours' },
  { minutes: 360, label: 'Every 6 hours' },
  { minutes: 720, label: 'Every 12 hours' },
  { minutes: 1440, label: 'Every 24 hours' },
  { minutes: 10080, label: 'Every 7 days' },
] as const;
export const promotionDisplaySchema = z.object({
  audience: z.enum(['b2b', 'all']).default('b2b'),
  frequencyScope: z.enum(['browser', 'tab']).default('tab'),
  pages: z.array(z.enum(['/dashboard', '/dashboard/flight-search', '/dashboard/announcements'])).min(1).max(3).default(['/dashboard', '/dashboard/flight-search']),
  showOnLogin: z.boolean().default(true),
  delaySeconds: z.number().int().min(0).max(300).default(0),
  repeatMinutes: z.number().int().refine((value) => PROMOTION_REPEAT_OPTIONS.some((option) => option.minutes === value), 'Choose a supported repeat interval.').default(60),
}).refine((value) => value.showOnLogin || value.repeatMinutes > 0, 'Enable show after login or choose a repeat interval.');
export type PromotionDisplay = z.infer<typeof promotionDisplaySchema>;
export const DEFAULT_PROMOTION_DISPLAY = promotionDisplaySchema.parse({});
export const promotionSchema = z.object({
  enabled: z.boolean(),
  display: promotionDisplaySchema.default({}),
  autoCloseSeconds: z.union([z.literal(10), z.literal(15), z.literal(20), z.literal(25), z.literal(30)]).default(10),
  slides: z.array(promotionSlideSchema).max(6),
}).refine((value) => !value.enabled || value.slides.some((slide) => slide.active), 'Add at least one active promotion before enabling the popup.');
export type PromotionSlide = z.infer<typeof promotionSlideSchema>;
export type PromotionState = z.infer<typeof promotionSchema> & { version: number; available: boolean };
export const PROMOTION_INTERVAL = 60 * 60 * 1000;
export function promotionDue(last: { shownAt: number; signedInAt: number | null } | null, signedInAt: number | null, now: number, display: PromotionDisplay = DEFAULT_PROMOTION_DISPLAY) {
  if (!last) return true;
  if (display.showOnLogin && signedInAt !== null && last.signedInAt !== signedInAt) return true;
  return display.repeatMinutes > 0 && now - last.shownAt >= display.repeatMinutes * 60 * 1000;
}
