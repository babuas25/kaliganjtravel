import 'server-only';

import { unstable_cache } from 'next/cache';

import {
  DEFAULT_HOMEPAGE_OFFER_HEADING,
  DEFAULT_HOMEPAGE_OFFERS,
  DEFAULT_HOMEPAGE_OFFER_SUBHEADING,
  HOMEPAGE_OFFER_COUNT,
  type HomepageOffer,
  type HomepageOfferImage,
  type HomepageOffersState,
} from '@/lib/homepage-offers';
import { supabaseAdmin } from '@/lib/supabase/server';

const SETTINGS_TABLE = 'homepage_offer_settings';
const OFFERS_TABLE = 'homepage_travel_offers';
const SETTINGS_ID = 'primary';

export const HOMEPAGE_OFFERS_CACHE_TAG = 'homepage-travel-offers';

type SettingsRow = {
  heading: string;
  subheading: string;
  version: number;
  updated_at: string;
  updated_by: string;
};

type OfferRow = {
  id: string;
  eyebrow: string;
  title: string;
  description: string;
  is_active: boolean;
  image_public_id: string | null;
  image_url: string | null;
  image_format: string | null;
  image_width: number | null;
  image_height: number | null;
  image_updated_at: string | null;
};

function fallbackState(source: 'fallback' | 'unavailable'): HomepageOffersState {
  return {
    heading: DEFAULT_HOMEPAGE_OFFER_HEADING,
    subheading: DEFAULT_HOMEPAGE_OFFER_SUBHEADING,
    offers: DEFAULT_HOMEPAGE_OFFERS.map((offer) => ({ ...offer })),
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
    (/homepage_(?:offer_settings|travel_offers)/i.test(error.message ?? '') &&
      /could not find|does not exist/i.test(error.message ?? ''))
  );
}

function validSettings(value: unknown): value is SettingsRow {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const row = value as Partial<SettingsRow>;
  return (
    typeof row.heading === 'string' &&
    row.heading.trim().length > 0 &&
    typeof row.subheading === 'string' &&
    row.subheading.trim().length > 0 &&
    typeof row.version === 'number' &&
    Number.isInteger(row.version) &&
    row.version > 0 &&
    typeof row.updated_at === 'string' &&
    typeof row.updated_by === 'string'
  );
}

function imageFromRow(row: OfferRow): HomepageOfferImage | null {
  const values = [
    row.image_public_id,
    row.image_url,
    row.image_format,
    row.image_width,
    row.image_height,
    row.image_updated_at,
  ];
  if (values.every((value) => value === null)) return null;
  if (
    typeof row.image_public_id !== 'string' ||
    typeof row.image_url !== 'string' ||
    !row.image_url.startsWith('https://') ||
    typeof row.image_format !== 'string' ||
    typeof row.image_width !== 'number' ||
    typeof row.image_height !== 'number' ||
    typeof row.image_updated_at !== 'string'
  ) {
    return null;
  }
  return {
    publicId: row.image_public_id,
    url: row.image_url,
    format: row.image_format,
    width: row.image_width,
    height: row.image_height,
    updatedAt: row.image_updated_at,
  };
}

function validOffer(value: unknown): value is OfferRow {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const row = value as Partial<OfferRow>;
  return (
    typeof row.id === 'string' &&
    typeof row.eyebrow === 'string' &&
    row.eyebrow.trim().length > 0 &&
    typeof row.title === 'string' &&
    row.title.trim().length > 0 &&
    typeof row.description === 'string' &&
    row.description.trim().length > 0 &&
    typeof row.is_active === 'boolean'
  );
}

async function readHomepageOffers(): Promise<HomepageOffersState> {
  const supabase = supabaseAdmin();
  if (!supabase) return fallbackState('fallback');

  const [settingsResult, offersResult] = await Promise.all([
    supabase
      .from(SETTINGS_TABLE)
      .select('heading, subheading, version, updated_at, updated_by')
      .eq('id', SETTINGS_ID)
      .maybeSingle(),
    supabase
      .from(OFFERS_TABLE)
      .select(
        'id, eyebrow, title, description, is_active, image_public_id, image_url, image_format, image_width, image_height, image_updated_at'
      )
      .order('sort_order', { ascending: true }),
  ]);

  if (settingsResult.error || offersResult.error) {
    const error = settingsResult.error ?? offersResult.error;
    if (error && tableIsMissing(error)) return fallbackState('fallback');
    console.error('[homepage-offers] read failed:', error?.message ?? 'unknown error');
    return fallbackState('unavailable');
  }
  if (!validSettings(settingsResult.data)) {
    console.error('[homepage-offers] invalid settings row.');
    return fallbackState('unavailable');
  }
  if (
    !Array.isArray(offersResult.data) ||
    offersResult.data.length !== HOMEPAGE_OFFER_COUNT ||
    !offersResult.data.every(validOffer)
  ) {
    console.error('[homepage-offers] invalid offer rows.');
    return fallbackState('unavailable');
  }

  return {
    heading: settingsResult.data.heading,
    subheading: settingsResult.data.subheading,
    offers: (offersResult.data as OfferRow[]).map(
      (row): HomepageOffer => ({
        id: row.id,
        eyebrow: row.eyebrow,
        title: row.title,
        description: row.description,
        active: row.is_active,
        image: imageFromRow(row),
      })
    ),
    version: settingsResult.data.version,
    updatedAt: settingsResult.data.updated_at,
    updatedBy: settingsResult.data.updated_by,
    source: 'database',
  };
}

const readCachedHomepageOffers = unstable_cache(
  readHomepageOffers,
  ['homepage-travel-offers-state'],
  { revalidate: 60 * 60, tags: [HOMEPAGE_OFFERS_CACHE_TAG] }
);

export async function getHomepageOffers(): Promise<HomepageOffersState> {
  return readCachedHomepageOffers();
}

/** Current stored image for one managed card, read without the public cache. */
export async function getHomepageOfferImage(
  offerId: string
): Promise<HomepageOfferImage | null> {
  const supabase = supabaseAdmin();
  if (!supabase) return null;
  const { data, error } = await supabase
    .from(OFFERS_TABLE)
    .select(
      'image_public_id, image_url, image_format, image_width, image_height, image_updated_at'
    )
    .eq('id', offerId)
    .maybeSingle();
  if (error || !data) {
    if (error) console.error('[homepage-offers] image lookup failed:', error.message);
    return null;
  }
  return imageFromRow(data as OfferRow);
}

export type SaveHomepageOffersResult =
  | { ok: true; version: number }
  | { ok: false; message: string };

export async function saveHomepageOfferText(input: {
  actorUserId: string;
  expectedVersion: number;
  heading: string;
  subheading: string;
  offers: Pick<HomepageOffer, 'id' | 'eyebrow' | 'title' | 'description' | 'active'>[];
}): Promise<SaveHomepageOffersResult> {
  const supabase = supabaseAdmin();
  if (!supabase) return { ok: false, message: 'Database configuration is unavailable.' };

  const { data, error } = await supabase.rpc('replace_homepage_travel_offer_text_v1', {
    p_actor_user_id: input.actorUserId,
    p_expected_version: input.expectedVersion,
    p_heading: input.heading,
    p_subheading: input.subheading,
    p_offers: input.offers,
  });
  if (error) {
    if (error.code === '40001' || /changed in another session/i.test(error.message)) {
      return {
        ok: false,
        message: 'Travel offers changed in another session. Reload and try again.',
      };
    }
    console.error('[homepage-offers] save failed:', error.message);
    return { ok: false, message: 'Travel offers could not be saved.' };
  }

  const version = typeof data === 'number' ? data : Number(data);
  return Number.isInteger(version) && version > 0
    ? { ok: true, version }
    : { ok: false, message: 'Travel offers returned an invalid version.' };
}

export async function saveHomepageOfferImage(input: {
  actorUserId: string;
  offerId: string;
  image: HomepageOfferImage | null;
}): Promise<SaveHomepageOffersResult> {
  const supabase = supabaseAdmin();
  if (!supabase) return { ok: false, message: 'Database configuration is unavailable.' };

  const { data, error } = await supabase.rpc('set_homepage_travel_offer_image_v1', {
    p_actor_user_id: input.actorUserId,
    p_offer_id: input.offerId,
    p_image_public_id: input.image?.publicId ?? null,
    p_image_url: input.image?.url ?? null,
    p_image_format: input.image?.format ?? null,
    p_image_width: input.image?.width ?? null,
    p_image_height: input.image?.height ?? null,
    p_image_updated_at: input.image?.updatedAt ?? null,
  });
  if (error) {
    console.error('[homepage-offers] image save failed:', error.message);
    return { ok: false, message: 'The offer image could not be saved.' };
  }

  const version = typeof data === 'number' ? data : Number(data);
  return Number.isInteger(version) && version > 0
    ? { ok: true, version }
    : { ok: false, message: 'The offer image returned an invalid version.' };
}
