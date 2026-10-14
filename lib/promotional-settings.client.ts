import { promotionSchema } from '@/lib/promotional-popup';

type PromotionSettings = ReturnType<typeof promotionSchema.parse>;

const SETTINGS_TTL_MS = 5 * 60 * 1000;
const DISABLED_SETTINGS_TTL_MS = 10 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 10 * 1000;

type SessionSettings = {
  userId: string;
  signedInAt: number | null;
  settings: PromotionSettings | null;
  expiresAt: number;
  wallExpiresAt: number;
  pending: Promise<PromotionSettings | null> | null;
};

// Keep settings across dashboard route effects, without sharing an audience
// snapshot between accounts or sign-ins. Display frequency stays in the popup's
// existing tab/browser storage; only the settings request is cached here.
let sessionSettings: SessionSettings | null = null;

export function loadPromotionalSettings(
  userId: string,
  signedInAt: number | null
): Promise<PromotionSettings | null> {
  if (!sessionSettings || sessionSettings.userId !== userId ||
      sessionSettings.signedInAt !== signedInAt) {
    sessionSettings = { userId, signedInAt, settings: null, expiresAt: 0, wallExpiresAt: 0, pending: null };
  }
  const entry = sessionSettings;
  // Monotonic time handles a clock adjustment; wall time handles platforms
  // whose monotonic clock pauses while the computer sleeps.
  if (entry.settings && performance.now() < entry.expiresAt && Date.now() < entry.wallExpiresAt) {
    return Promise.resolve(entry.settings);
  }
  if (entry.pending) return entry.pending;

  entry.pending = (async () => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await fetch('/api/promotional-popup', { cache: 'no-store', signal: controller.signal });
      if (!response.ok) return null;
      const result = promotionSchema.safeParse(await response.json());
      if (!result.success) return null;
      const ttl = result.data.enabled ? SETTINGS_TTL_MS : DISABLED_SETTINGS_TTL_MS;
      entry.settings = result.data;
      entry.expiresAt = performance.now() + ttl;
      entry.wallExpiresAt = Date.now() + ttl;
      return result.data;
    } finally {
      clearTimeout(timeout);
    }
  })().finally(() => { entry.pending = null; });
  return entry.pending;
}
