import 'server-only';
import { supabaseAdmin } from '@/lib/supabase/server';
import { promotionSchema, DEFAULT_PROMOTION_DISPLAY, type PromotionState } from '@/lib/promotional-popup';

export async function getPromotionalPopup(): Promise<PromotionState> {
  const fallback: PromotionState = { enabled: false, display: DEFAULT_PROMOTION_DISPLAY, autoCloseSeconds: 10, slides: [], version: 0, available: false };
  const db = supabaseAdmin();
  if (!db) return fallback;
  const { data, error } = await db.from('promotional_popup_settings').select('enabled, slides, version, auto_close_seconds, display_settings').eq('id', 'primary').maybeSingle();
  if (error || !data) return fallback;
  const parsed = promotionSchema.safeParse({ ...data, autoCloseSeconds: data.auto_close_seconds, display: data.display_settings });
  return parsed.success ? { ...parsed.data, version: data.version, available: true } : fallback;
}
