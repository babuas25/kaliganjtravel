'use server';

import { revalidatePath, updateTag } from 'next/cache';
import sharp from 'sharp';
import { z } from 'zod';

import {
  ANNOUNCEMENT_MESSAGE_LIMIT,
  ANNOUNCEMENT_MESSAGE_MAX_LENGTH,
  ANNOUNCEMENT_SCROLL_DURATION_MAX,
  ANNOUNCEMENT_SCROLL_DURATION_MIN,
  type AnnouncementMessage,
} from '@/lib/announcements';
import {
  ANNOUNCEMENT_SLIDER_CACHE_TAG,
  saveAnnouncementSlider,
} from '@/lib/db/announcements';
import {
  getHomepageOfferImage,
  HOMEPAGE_OFFERS_CACHE_TAG,
  saveHomepageOfferImage,
  saveHomepageOfferText,
} from '@/lib/db/homepage-offers';
import { recordSecurityAuditEvent } from '@/lib/db/security';
import { getDashboardSession } from '@/lib/dashboard/session';
import {
  destroyAsset,
  FOLDERS,
  isCloudinaryConfigured,
  uploadAsset,
} from '@/lib/cloudinary';
import {
  FLIGHT_SEARCH_BACKGROUND_CACHE_TAG,
  FLIGHT_SEARCH_BACKGROUND_PUBLIC_ID,
} from '@/lib/flight-search-background';
import {
  HOMEPAGE_OFFER_COUNT,
  HOMEPAGE_OFFER_DESCRIPTION_MAX_LENGTH,
  HOMEPAGE_OFFER_EYEBROW_MAX_LENGTH,
  HOMEPAGE_OFFER_HEADING_MAX_LENGTH,
  HOMEPAGE_OFFER_SUBHEADING_MAX_LENGTH,
  HOMEPAGE_OFFER_TITLE_MAX_LENGTH,
  type HomepageOffer,
  type HomepageOfferImage,
} from '@/lib/homepage-offers';
import { checkActionLimit, rateLimitMessage } from '@/lib/rate-limit';
import { canManageMedia } from '@/lib/roles';
import {
  FLIGHT_SEARCH_BACKGROUND_EXTENSIONS,
  FLIGHT_SEARCH_BACKGROUND_MAX_BYTES,
  flightSearchBackgroundDimensionError,
  HOMEPAGE_OFFER_IMAGE_EXTENSIONS,
  HOMEPAGE_OFFER_IMAGE_MAX_BYTES,
  homepageOfferImageDimensionError,
  inspectFlightSearchBackgroundBytes,
  inspectHomepageOfferImageBytes,
} from '@/lib/upload-verify';

const messageSchema = z.object({
  id: z.string().uuid(),
  text: z.string().trim().min(1).max(ANNOUNCEMENT_MESSAGE_MAX_LENGTH),
  active: z.boolean(),
});

const inputSchema = z.object({
  expectedVersion: z.number().int().positive(),
  scrollDurationSeconds: z
    .number()
    .int()
    .min(ANNOUNCEMENT_SCROLL_DURATION_MIN)
    .max(ANNOUNCEMENT_SCROLL_DURATION_MAX),
  messages: z.array(messageSchema).max(ANNOUNCEMENT_MESSAGE_LIMIT),
});

const homepageOfferTextSchema = z.object({
  expectedVersion: z.number().int().positive(),
  heading: z.string().trim().min(1).max(HOMEPAGE_OFFER_HEADING_MAX_LENGTH),
  subheading: z
    .string()
    .trim()
    .min(1)
    .max(HOMEPAGE_OFFER_SUBHEADING_MAX_LENGTH),
  offers: z
    .array(
      z.object({
        id: z.string().uuid(),
        eyebrow: z
          .string()
          .trim()
          .min(1)
          .max(HOMEPAGE_OFFER_EYEBROW_MAX_LENGTH),
        title: z.string().trim().min(1).max(HOMEPAGE_OFFER_TITLE_MAX_LENGTH),
        description: z
          .string()
          .trim()
          .min(1)
          .max(HOMEPAGE_OFFER_DESCRIPTION_MAX_LENGTH),
        active: z.boolean(),
      })
    )
    .length(HOMEPAGE_OFFER_COUNT),
});

export type AnnouncementActionResult = {
  ok: boolean;
  message: string;
  version?: number;
};

export type MediaBackgroundActionResult = {
  ok: boolean;
  message: string;
};

export type HomepageOfferActionResult = {
  ok: boolean;
  message: string;
  version?: number;
  image?: HomepageOfferImage | null;
};

const MEDIA_BACKGROUND_ONLY: MediaBackgroundActionResult = {
  ok: false,
  message: 'Only a Super Admin, Admin, or Media Staff member can manage this image.',
};

const MEDIA_BACKGROUND_UNCONFIGURED: MediaBackgroundActionResult = {
  ok: false,
  message: 'Cloudinary is not configured on this environment.',
};

const HOMEPAGE_OFFERS_ONLY: HomepageOfferActionResult = {
  ok: false,
  message: 'Only a Super Admin, Admin, or Media Staff member can manage travel offers.',
};

function revalidateHomepageOffers() {
  updateTag(HOMEPAGE_OFFERS_CACHE_TAG);
  revalidatePath('/');
  revalidatePath('/dashboard/media');
}

async function auditHomepageOffer(
  session: NonNullable<Awaited<ReturnType<typeof getDashboardSession>>>,
  action: string,
  targetId: string,
  outcome: 'attempted' | 'succeeded' | 'failed',
  metadata?: Record<string, unknown>
) {
  return recordSecurityAuditEvent({
    actorUserId: session.clerkId,
    actorRole: session.role,
    action,
    targetType: 'homepage_travel_offer',
    targetId,
    outcome,
    metadata,
  });
}

function revalidateMediaBackground() {
  updateTag(FLIGHT_SEARCH_BACKGROUND_CACHE_TAG);
  revalidatePath('/dashboard/flight-search');
  revalidatePath('/dashboard/media');
}

async function auditMediaBackground(
  session: NonNullable<Awaited<ReturnType<typeof getDashboardSession>>>,
  action: string,
  outcome: 'attempted' | 'succeeded' | 'failed',
  metadata?: Record<string, unknown>
) {
  return recordSecurityAuditEvent({
    actorUserId: session.clerkId,
    actorRole: session.role,
    action,
    targetType: 'dashboard_flight_search_background',
    targetId: FLIGHT_SEARCH_BACKGROUND_PUBLIC_ID,
    outcome,
    metadata,
  });
}

export async function uploadFlightSearchBackgroundAction(
  formData: FormData
): Promise<MediaBackgroundActionResult> {
  const session = await getDashboardSession();
  if (!session || !canManageMedia(session.role)) return MEDIA_BACKGROUND_ONLY;

  const limit = await checkActionLimit('manageMediaBackground', session.clerkId);
  if (!limit.ok) {
    return { ok: false, message: rateLimitMessage(limit.retryAfterSeconds) };
  }
  if (!isCloudinaryConfigured()) return MEDIA_BACKGROUND_UNCONFIGURED;

  const file = formData.get('background');
  if (!(file instanceof File) || file.size === 0) {
    return { ok: false, message: 'Choose an image file first.' };
  }
  if (!FLIGHT_SEARCH_BACKGROUND_EXTENSIONS[file.type]) {
    return { ok: false, message: 'Use a JPEG, PNG or WebP image.' };
  }
  if (file.size > FLIGHT_SEARCH_BACKGROUND_MAX_BYTES) {
    return { ok: false, message: 'That image is over the 2 MB limit.' };
  }

  const bytes = new Uint8Array(await file.arrayBuffer());
  const inspection = inspectFlightSearchBackgroundBytes(bytes, file.type);
  if (!inspection.ok) return { ok: false, message: inspection.reason };

  let width: number;
  let height: number;
  try {
    const metadata = await sharp(bytes).metadata();
    width = metadata.width ?? 0;
    height = metadata.height ?? 0;
  } catch {
    return { ok: false, message: 'That image could not be read.' };
  }
  const dimensionError = flightSearchBackgroundDimensionError(width, height);
  if (dimensionError) return { ok: false, message: dimensionError };

  const auditMetadata = { width, height, bytes: file.size, mime: inspection.mime };
  if (
    !(await auditMediaBackground(
      session,
      'media.flight_search_background_uploaded',
      'attempted',
      auditMetadata
    ))
  ) {
    return {
      ok: false,
      message: 'The security audit trail is unavailable, so nothing was changed.',
    };
  }

  const stored = await uploadAsset(bytes, inspection.mime, {
    folder: FOLDERS.marketing,
    publicId: 'dashboard-flight-search',
  });
  if (!stored.ok) {
    await auditMediaBackground(
      session,
      'media.flight_search_background_uploaded',
      'failed',
      auditMetadata
    );
    return stored;
  }
  await auditMediaBackground(
    session,
    'media.flight_search_background_uploaded',
    'succeeded',
    auditMetadata
  );

  revalidateMediaBackground();
  return { ok: true, message: 'Flight-search background updated.' };
}

export async function removeFlightSearchBackgroundAction(): Promise<MediaBackgroundActionResult> {
  const session = await getDashboardSession();
  if (!session || !canManageMedia(session.role)) return MEDIA_BACKGROUND_ONLY;

  const limit = await checkActionLimit('manageMediaBackground', session.clerkId);
  if (!limit.ok) {
    return { ok: false, message: rateLimitMessage(limit.retryAfterSeconds) };
  }
  if (!isCloudinaryConfigured()) return MEDIA_BACKGROUND_UNCONFIGURED;
  if (
    !(await auditMediaBackground(
      session,
      'media.flight_search_background_removed',
      'attempted'
    ))
  ) {
    return {
      ok: false,
      message: 'The security audit trail is unavailable, so nothing was changed.',
    };
  }

  await destroyAsset(FLIGHT_SEARCH_BACKGROUND_PUBLIC_ID);
  await auditMediaBackground(
    session,
    'media.flight_search_background_removed',
    'succeeded'
  );
  revalidateMediaBackground();
  return { ok: true, message: 'Background removed. The gradient fallback is active.' };
}

export async function saveAnnouncementsAction(input: {
  expectedVersion: number;
  scrollDurationSeconds: number;
  messages: AnnouncementMessage[];
}): Promise<AnnouncementActionResult> {
  const session = await getDashboardSession();
  if (!session || !canManageMedia(session.role)) {
    return {
      ok: false,
      message: 'Only a Super Admin, Admin, or Media Staff member can manage announcements.',
    };
  }

  const parsed = inputSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      message: `Use up to ${ANNOUNCEMENT_MESSAGE_LIMIT} messages of 1–${ANNOUNCEMENT_MESSAGE_MAX_LENGTH} characters and a valid slider speed.`,
    };
  }
  const uniqueIds = new Set(parsed.data.messages.map((message) => message.id));
  if (uniqueIds.size !== parsed.data.messages.length) {
    return { ok: false, message: 'The announcement list contains a duplicate item.' };
  }

  const limit = await checkActionLimit('manageAnnouncements', session.clerkId);
  if (!limit.ok) {
    return { ok: false, message: rateLimitMessage(limit.retryAfterSeconds) };
  }

  const metadata = {
    expectedVersion: parsed.data.expectedVersion,
    messageCount: parsed.data.messages.length,
    activeCount: parsed.data.messages.filter((message) => message.active).length,
    scrollDurationSeconds: parsed.data.scrollDurationSeconds,
  };
  const audited = await recordSecurityAuditEvent({
    actorUserId: session.clerkId,
    actorRole: session.role,
    action: 'announcement_slider.saved',
    targetType: 'announcement_slider',
    targetId: 'primary',
    outcome: 'attempted',
    metadata,
  });
  if (!audited) {
    return {
      ok: false,
      message: 'The security audit trail is unavailable, so nothing was changed.',
    };
  }

  const result = await saveAnnouncementSlider({
    actorUserId: session.clerkId,
    expectedVersion: parsed.data.expectedVersion,
    scrollDurationSeconds: parsed.data.scrollDurationSeconds,
    messages: parsed.data.messages,
  });
  await recordSecurityAuditEvent({
    actorUserId: session.clerkId,
    actorRole: session.role,
    action: 'announcement_slider.saved',
    targetType: 'announcement_slider',
    targetId: 'primary',
    outcome: result.ok ? 'succeeded' : 'failed',
    metadata: result.ok
      ? { ...metadata, version: result.version }
      : { ...metadata, reason: result.message },
  });
  if (!result.ok) return result;

  updateTag(ANNOUNCEMENT_SLIDER_CACHE_TAG);
  revalidatePath('/');
  revalidatePath('/dashboard/media');
  return {
    ok: true,
    message: 'Announcement slider updated.',
    version: result.version,
  };
}

export async function saveHomepageOfferTextAction(input: {
  expectedVersion: number;
  heading: string;
  subheading: string;
  offers: Pick<HomepageOffer, 'id' | 'eyebrow' | 'title' | 'description' | 'active'>[];
}): Promise<HomepageOfferActionResult> {
  const session = await getDashboardSession();
  if (!session || !canManageMedia(session.role)) return HOMEPAGE_OFFERS_ONLY;

  const parsed = homepageOfferTextSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      message: 'Complete every travel-offer field within its character limit.',
    };
  }
  if (new Set(parsed.data.offers.map((offer) => offer.id)).size !== HOMEPAGE_OFFER_COUNT) {
    return { ok: false, message: 'The travel-offer list contains a duplicate item.' };
  }

  const limit = await checkActionLimit('manageHomepageOffers', session.clerkId);
  if (!limit.ok) {
    return { ok: false, message: rateLimitMessage(limit.retryAfterSeconds) };
  }

  const metadata = {
    expectedVersion: parsed.data.expectedVersion,
    activeCount: parsed.data.offers.filter((offer) => offer.active).length,
  };
  if (
    !(await auditHomepageOffer(
      session,
      'media.homepage_travel_offers_text_saved',
      'primary',
      'attempted',
      metadata
    ))
  ) {
    return {
      ok: false,
      message: 'The security audit trail is unavailable, so nothing was changed.',
    };
  }

  const result = await saveHomepageOfferText({
    actorUserId: session.clerkId,
    ...parsed.data,
  });
  await auditHomepageOffer(
    session,
    'media.homepage_travel_offers_text_saved',
    'primary',
    result.ok ? 'succeeded' : 'failed',
    result.ok
      ? { ...metadata, version: result.version }
      : { ...metadata, reason: result.message }
  );
  if (!result.ok) return result;

  revalidateHomepageOffers();
  return {
    ok: true,
    message: 'Homepage travel offers updated.',
    version: result.version,
  };
}

export async function uploadHomepageOfferImageAction(
  formData: FormData
): Promise<HomepageOfferActionResult> {
  const session = await getDashboardSession();
  if (!session || !canManageMedia(session.role)) return HOMEPAGE_OFFERS_ONLY;

  const offerId = z.string().uuid().safeParse(formData.get('offerId'));
  if (!offerId.success) return { ok: false, message: 'Choose a valid offer card.' };
  const file = formData.get('image');
  if (!(file instanceof File) || file.size === 0) {
    return { ok: false, message: 'Choose an image file first.' };
  }

  const limit = await checkActionLimit('manageHomepageOffers', session.clerkId);
  if (!limit.ok) {
    return { ok: false, message: rateLimitMessage(limit.retryAfterSeconds) };
  }
  if (!isCloudinaryConfigured()) {
    return { ok: false, message: 'Cloudinary is not configured on this environment.' };
  }
  if (!HOMEPAGE_OFFER_IMAGE_EXTENSIONS[file.type]) {
    return { ok: false, message: 'Use a JPEG, PNG or WebP image.' };
  }
  if (file.size > HOMEPAGE_OFFER_IMAGE_MAX_BYTES) {
    return { ok: false, message: 'That image is over the 2 MB limit.' };
  }

  const bytes = new Uint8Array(await file.arrayBuffer());
  const inspection = inspectHomepageOfferImageBytes(bytes, file.type);
  if (!inspection.ok) return { ok: false, message: inspection.reason };

  let width: number;
  let height: number;
  try {
    const metadata = await sharp(bytes).metadata();
    width = metadata.width ?? 0;
    height = metadata.height ?? 0;
  } catch {
    return { ok: false, message: 'That image could not be read.' };
  }
  const dimensionError = homepageOfferImageDimensionError(width, height);
  if (dimensionError) return { ok: false, message: dimensionError };

  const auditMetadata = { width, height, bytes: file.size, mime: inspection.mime };
  if (
    !(await auditHomepageOffer(
      session,
      'media.homepage_travel_offer_image_uploaded',
      offerId.data,
      'attempted',
      auditMetadata
    ))
  ) {
    return {
      ok: false,
      message: 'The security audit trail is unavailable, so nothing was changed.',
    };
  }

  const stored = await uploadAsset(bytes, inspection.mime, {
    folder: `${FOLDERS.marketing}/homepage-offers`,
  });
  if (!stored.ok) {
    await auditHomepageOffer(
      session,
      'media.homepage_travel_offer_image_uploaded',
      offerId.data,
      'failed',
      auditMetadata
    );
    return stored;
  }

  const previousImage = await getHomepageOfferImage(offerId.data);
  const image: HomepageOfferImage = {
    publicId: stored.asset.publicId,
    url: stored.asset.url,
    format: stored.asset.format,
    width: stored.asset.width ?? width,
    height: stored.asset.height ?? height,
    updatedAt: stored.asset.createdAt ?? new Date().toISOString(),
  };
  const saved = await saveHomepageOfferImage({
    actorUserId: session.clerkId,
    offerId: offerId.data,
    image,
  });
  if (!saved.ok) {
    await destroyAsset(image.publicId);
    await auditHomepageOffer(
      session,
      'media.homepage_travel_offer_image_uploaded',
      offerId.data,
      'failed',
      { ...auditMetadata, reason: saved.message }
    );
    return saved;
  }

  if (previousImage && previousImage.publicId !== image.publicId) {
    await destroyAsset(previousImage.publicId);
  }

  await auditHomepageOffer(
    session,
    'media.homepage_travel_offer_image_uploaded',
    offerId.data,
    'succeeded',
    { ...auditMetadata, version: saved.version }
  );
  revalidateHomepageOffers();
  return {
    ok: true,
    message: 'Offer image updated.',
    version: saved.version,
    image,
  };
}

export async function removeHomepageOfferImageAction(input: {
  offerId: string;
}): Promise<HomepageOfferActionResult> {
  const session = await getDashboardSession();
  if (!session || !canManageMedia(session.role)) return HOMEPAGE_OFFERS_ONLY;

  const parsed = z.object({ offerId: z.string().uuid() }).safeParse(input);
  if (!parsed.success) return { ok: false, message: 'Choose a valid offer image.' };

  const limit = await checkActionLimit('manageHomepageOffers', session.clerkId);
  if (!limit.ok) {
    return { ok: false, message: rateLimitMessage(limit.retryAfterSeconds) };
  }
  if (
    !(await auditHomepageOffer(
      session,
      'media.homepage_travel_offer_image_removed',
      parsed.data.offerId,
      'attempted'
    ))
  ) {
    return {
      ok: false,
      message: 'The security audit trail is unavailable, so nothing was changed.',
    };
  }


  const previousImage = await getHomepageOfferImage(parsed.data.offerId);
  if (!previousImage) {
    return { ok: false, message: 'This offer card does not have a stored image.' };
  }

  const saved = await saveHomepageOfferImage({
    actorUserId: session.clerkId,
    offerId: parsed.data.offerId,
    image: null,
  });
  if (!saved.ok) {
    await auditHomepageOffer(
      session,
      'media.homepage_travel_offer_image_removed',
      parsed.data.offerId,
      'failed',
      { reason: saved.message }
    );
    return saved;
  }

  await destroyAsset(previousImage.publicId);
  await auditHomepageOffer(
    session,
    'media.homepage_travel_offer_image_removed',
    parsed.data.offerId,
    'succeeded',
    { version: saved.version }
  );
  revalidateHomepageOffers();
  return {
    ok: true,
    message: 'Offer image removed. The gradient fallback is active.',
    version: saved.version,
    image: null,
  };
}
