import 'server-only';

import { unstable_cache } from 'next/cache';

import {
  ANNOUNCEMENT_SCROLL_DURATION_MAX,
  ANNOUNCEMENT_SCROLL_DURATION_MIN,
  DEFAULT_ANNOUNCEMENT_MESSAGES,
  DEFAULT_ANNOUNCEMENT_SCROLL_DURATION,
  type AnnouncementMessage,
  type AnnouncementSliderState,
} from '@/lib/announcements';
import { supabaseAdmin } from '@/lib/supabase/server';

const SETTINGS_TABLE = 'announcement_slider_settings';
const MESSAGES_TABLE = 'announcement_slider_messages';
const SETTINGS_ID = 'primary';

export const ANNOUNCEMENT_SLIDER_CACHE_TAG = 'announcement-slider';

type SettingsRow = {
  version: number;
  scroll_duration_seconds: number;
  updated_at: string;
  updated_by: string;
};

type MessageRow = {
  id: string;
  message: string;
  is_active: boolean;
};

function fallbackState(source: 'fallback' | 'unavailable'): AnnouncementSliderState {
  return {
    messages: DEFAULT_ANNOUNCEMENT_MESSAGES.map((message) => ({ ...message })),
    scrollDurationSeconds: DEFAULT_ANNOUNCEMENT_SCROLL_DURATION,
    version: 0,
    updatedAt: null,
    updatedBy: null,
    source,
  };
}

function tableIsMissing(error: { code?: string | null; message?: string | null }) {
  return (
    error.code === '42P01' ||
    error.code === 'PGRST205' ||
    /announcement_slider_(?:settings|messages)/i.test(error.message ?? '') &&
      /could not find|does not exist/i.test(error.message ?? '')
  );
}

function validSettings(value: unknown): value is SettingsRow {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const row = value as Partial<SettingsRow>;
  return (
    typeof row.version === 'number' &&
    Number.isInteger(row.version) &&
    row.version > 0 &&
    typeof row.scroll_duration_seconds === 'number' &&
    Number.isInteger(row.scroll_duration_seconds) &&
    row.scroll_duration_seconds >= ANNOUNCEMENT_SCROLL_DURATION_MIN &&
    row.scroll_duration_seconds <= ANNOUNCEMENT_SCROLL_DURATION_MAX &&
    typeof row.updated_at === 'string' &&
    typeof row.updated_by === 'string'
  );
}

function validMessage(value: unknown): value is MessageRow {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const row = value as Partial<MessageRow>;
  return (
    typeof row.id === 'string' &&
    typeof row.message === 'string' &&
    row.message.trim().length > 0 &&
    typeof row.is_active === 'boolean'
  );
}

async function readAnnouncementSlider(): Promise<AnnouncementSliderState> {
  const supabase = supabaseAdmin();
  if (!supabase) return fallbackState('fallback');

  const [settingsResult, messagesResult] = await Promise.all([
    supabase
      .from(SETTINGS_TABLE)
      .select('version, scroll_duration_seconds, updated_at, updated_by')
      .eq('id', SETTINGS_ID)
      .maybeSingle(),
    supabase
      .from(MESSAGES_TABLE)
      .select('id, message, is_active')
      .order('sort_order', { ascending: true })
      .order('created_at', { ascending: true }),
  ]);

  if (settingsResult.error || messagesResult.error) {
    const error = settingsResult.error ?? messagesResult.error;
    if (error && tableIsMissing(error)) return fallbackState('fallback');
    console.error('[announcement-slider] read failed:', error?.message ?? 'unknown error');
    return fallbackState('unavailable');
  }
  if (!validSettings(settingsResult.data)) {
    console.error('[announcement-slider] invalid settings row.');
    return fallbackState('unavailable');
  }
  if (!Array.isArray(messagesResult.data) || !messagesResult.data.every(validMessage)) {
    console.error('[announcement-slider] invalid message rows.');
    return fallbackState('unavailable');
  }

  return {
    messages: (messagesResult.data as MessageRow[]).map((row) => ({
      id: row.id,
      text: row.message,
      active: row.is_active,
    })),
    scrollDurationSeconds: settingsResult.data.scroll_duration_seconds,
    version: settingsResult.data.version,
    updatedAt: settingsResult.data.updated_at,
    updatedBy: settingsResult.data.updated_by,
    source: 'database',
  };
}

const readCachedAnnouncementSlider = unstable_cache(
  readAnnouncementSlider,
  ['announcement-slider-state'],
  { revalidate: 60 * 60, tags: [ANNOUNCEMENT_SLIDER_CACHE_TAG] }
);

/** Current ordered message set. Failures retain the existing public design/content. */
export async function getAnnouncementSlider(): Promise<AnnouncementSliderState> {
  return readCachedAnnouncementSlider();
}

export type SaveAnnouncementSliderResult =
  | { ok: true; version: number }
  | { ok: false; message: string };

/** Replaces the complete set atomically through the migration's service-only RPC. */
export async function saveAnnouncementSlider(input: {
  actorUserId: string;
  expectedVersion: number;
  scrollDurationSeconds: number;
  messages: AnnouncementMessage[];
}): Promise<SaveAnnouncementSliderResult> {
  const supabase = supabaseAdmin();
  if (!supabase) return { ok: false, message: 'Database configuration is unavailable.' };

  const { data, error } = await supabase.rpc(
    'replace_announcement_slider_messages_v2',
    {
      p_actor_user_id: input.actorUserId,
      p_expected_version: input.expectedVersion,
      p_scroll_duration_seconds: input.scrollDurationSeconds,
      p_messages: input.messages,
    }
  );
  if (error) {
    if (error.code === '40001' || /changed in another session/i.test(error.message)) {
      return {
        ok: false,
        message: 'Announcements changed in another session. Reload and try again.',
      };
    }
    console.error('[announcement-slider] save failed:', error.message);
    return { ok: false, message: 'Announcements could not be saved.' };
  }

  const version = typeof data === 'number' ? data : Number(data);
  if (!Number.isInteger(version) || version < 1) {
    return { ok: false, message: 'Announcements returned an invalid version.' };
  }
  return { ok: true, version };
}
