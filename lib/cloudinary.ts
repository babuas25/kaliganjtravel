import { v2 as cloudinary } from 'cloudinary';

/**
 * Cloudinary — the one place files live in this application.
 *
 * **Server-only.** It holds the API secret, so this module must never be
 * imported from a `'use client'` file. The limits and byte checks a picker
 * needs are in `lib/upload-verify.ts`, which is pure and safe on the client.
 *
 * Configured per call rather than at module scope, so a value set at runtime
 * (Vercel) is picked up without a rebuild — the same reason `supabaseAdmin()`
 * reads its env per call. Returns null when the environment is not configured,
 * which lets every caller degrade instead of crashing a page.
 */

export type CloudinaryClient = typeof cloudinary;

export function cloudinaryClient(): CloudinaryClient | null {
  const cloud_name = process.env.CLOUDINARY_CLOUD_NAME;
  const api_key = process.env.CLOUDINARY_API_KEY;
  const api_secret = process.env.CLOUDINARY_API_SECRET;
  if (!cloud_name || !api_key || !api_secret) return null;

  cloudinary.config({ cloud_name, api_key, api_secret, secure: true });
  return cloudinary;
}

/** Whether file-backed features can work at all. Drives the setup notices. */
export function isCloudinaryConfigured(): boolean {
  return Boolean(
    process.env.CLOUDINARY_CLOUD_NAME &&
      process.env.CLOUDINARY_API_KEY &&
      process.env.CLOUDINARY_API_SECRET
  );
}

/**
 * Every folder in the account, named in one place.
 *
 * Folders are structural, not a security boundary — what keeps a trade licence
 * unreadable is `type: 'authenticated'` below, never where it sits.
 */
export const FOLDERS = {
  /** Site branding: exactly one object, the logo. Public. */
  site: 'kaliganj-travels/site',
  /** Marketing artwork for the public pages. Public. */
  marketing: 'kaliganj-travels/marketing',
  /** A B2B partner's business documents, one sub-folder per user. Private. */
  businessDocs: 'kaliganj-travels/business-docs',
  /** Attachments on a customer's upgrade application. Private. */
  upgradeDocs: 'kaliganj-travels/upgrade-docs',
  /** Receipts, cheques and transfer evidence on wallet deposit requests. */
  walletDeposits: 'kaliganj-travels/wallet-deposits',
  /** Public logos for company bank accounts shown to paying customers. */
  bankLogos: 'kaliganj-travels/bank-logos',
  /** Public MFS provider marks shown beside mobile-payment instructions. */
  mfsLogos: 'kaliganj-travels/mfs-logos',
  /** Public QR codes intentionally shown to customers making MFS payments. */
  mfsQrCodes: 'kaliganj-travels/mfs-qr-codes',
} as const;

/**
 * How long an admin's link to a private document stays valid.
 *
 * Long enough to open it and read it, short enough that a URL copied out of the
 * page — into a chat, a bookmark, a log — is worthless by the time anyone else
 * follows it.
 */
export const PRIVATE_LINK_TTL_SECONDS = 5 * 60;

/**
 * Everything here is uploaded as `image`, PDFs included.
 *
 * Cloudinary handles PDF under the image resource type, and pinning it means
 * the resource type never has to be stored alongside a public id or guessed at
 * signing time. `raw` would accept a wider range of files, which is the
 * opposite of what is wanted: `lib/upload-verify.ts` admits four formats and
 * every one of them is an image to Cloudinary.
 */
const RESOURCE_TYPE = 'image';

// Cloudinary's Admin API has a small hourly lookup allowance. A site logo is
// optional presentation data, so once that allowance is exhausted the server
// should use the built-in mark instead of repeating a doomed request on every
// layout render.
let assetLookupBlockedUntil = 0;

export type StoredAsset = {
  /** Cloudinary public id — the durable handle. This is what gets stored. */
  publicId: string;
  /** Bumped on every overwrite, which is what busts the CDN cache. */
  version: number;
  /**
   * Delivery URL. Only meaningful for public assets; a private one needs a
   * signed link minted per view (`privateUrl`).
   */
  url: string;
  format: string;
  width: number | null;
  height: number | null;
  /** ISO timestamp Cloudinary recorded, or null when it reports none. */
  createdAt: string | null;
};

export type UploadOutcome =
  | { ok: true; asset: StoredAsset }
  | { ok: false; message: string };

type UploadOptions = {
  folder: string;
  /**
   * Fixed id, for assets that replace rather than accumulate — site-wide
   * branding and managed marketing backgrounds. Omit for a generated id.
   */
  publicId?: string;
  /**
   * True for anything that must not be readable by URL alone: trade licences,
   * TIN certificates, NID cards, upgrade attachments.
   *
   * This is the control, and it is worth being clear about why. Cloudinary's
   * default `upload` type is **publicly readable by anyone with the URL** — no
   * session, no expiry, forever. For identity documents that is not an
   * acceptable default, so they go up as `authenticated`, which makes the plain
   * URL 401 and requires a signature to fetch.
   */
  authenticated?: boolean;
};

/**
 * Stores verified bytes and returns the handle to keep.
 *
 * Takes bytes rather than a `File` on purpose: the caller has already inspected
 * them (`lib/upload-verify.ts`) and what gets stored must be what was checked,
 * under the MIME type that was *verified* rather than the one the browser
 * claimed.
 */
export async function uploadAsset(
  bytes: Uint8Array,
  mime: string,
  options: UploadOptions
): Promise<UploadOutcome> {
  const client = cloudinaryClient();
  if (!client) {
    return {
      ok: false,
      message: 'Cloudinary is not configured on this environment.',
    };
  }

  // A data URI rather than an upload stream: the SDK accepts it directly, and
  // every limit in this application is 5 MB, far inside what it handles.
  const payload = `data:${mime};base64,${Buffer.from(bytes).toString('base64')}`;

  try {
    const result = await client.uploader.upload(payload, {
      folder: options.folder,
      public_id: options.publicId,
      resource_type: RESOURCE_TYPE,
      type: options.authenticated ? 'authenticated' : 'upload',
      // A fixed public id is a replacement, so the old bytes go. Without
      // `invalidate` the CDN would keep serving them.
      overwrite: Boolean(options.publicId),
      invalidate: true,
      // Nothing here is a media library: the account should not be inferring
      // tags or categories from a customer's NID card.
      use_filename: false,
      unique_filename: true,
    });

    return {
      ok: true,
      asset: {
        publicId: result.public_id,
        version: result.version,
        url: result.secure_url,
        format: result.format,
        width: typeof result.width === 'number' ? result.width : null,
        height: typeof result.height === 'number' ? result.height : null,
        createdAt: result.created_at ?? null,
      },
    };
  } catch (error) {
    // Cloudinary errors name the account, the folder and sometimes the preset.
    // That belongs in the log, not on someone's screen.
    console.error('[cloudinary] upload failed:', describe(error));
    return {
      ok: false,
      message:
        'The upload did not complete. Try again, and contact support if it keeps happening.',
    };
  }
}

/**
 * A time-limited link to a private asset, for someone who has already been
 * authorised to see it.
 *
 * `private_download_url` rather than a signed delivery URL: it is the form that
 * carries a real expiry on every Cloudinary plan. Signed delivery URLs do not
 * expire unless token-based authentication is enabled, which is a paid feature —
 * and a link that never expires is the thing this is meant to avoid.
 *
 * Returns null rather than throwing: a document that cannot be linked is left
 * out of the page, not rendered as a URL that fails when clicked.
 */
export function privateUrl(
  publicId: string,
  format: string,
  ttlSeconds: number = PRIVATE_LINK_TTL_SECONDS
): string | null {
  const client = cloudinaryClient();
  if (!client) return null;

  try {
    return client.utils.private_download_url(publicId, format, {
      resource_type: RESOURCE_TYPE,
      type: 'authenticated',
      expires_at: Math.floor(Date.now() / 1000) + ttlSeconds,
    });
  } catch (error) {
    console.error('[cloudinary] signing failed:', describe(error));
    return null;
  }
}

/**
 * Browser-displayable delivery URL for an authenticated image.
 *
 * Business logos currently share the protected document upload path. Unlike
 * `private_download_url`, this signed delivery URL can be used directly by an
 * `<img>`. Logos are public-facing branding, so a non-expiring signed delivery
 * URL is appropriate even though the underlying upload is authenticated.
 */
export function authenticatedImageUrl(
  publicId: string,
  format: string
): string | null {
  const client = cloudinaryClient();
  if (!client) return null;

  try {
    return client.url(publicId, {
      resource_type: RESOURCE_TYPE,
      type: 'authenticated',
      secure: true,
      sign_url: true,
      format,
    });
  } catch (error) {
    console.error('[cloudinary] authenticated image URL failed:', describe(error));
    return null;
  }
}

/** Delivery URL for a public asset, pinned to a version so it is never stale. */
export function publicUrl(publicId: string, version?: number): string | null {
  const client = cloudinaryClient();
  if (!client) return null;

  return client.url(publicId, {
    resource_type: RESOURCE_TYPE,
    type: 'upload',
    secure: true,
    version,
  });
}

type OptimizedPublicImageOptions = {
  width: number;
  height: number;
  version?: number;
};

/**
 * Optimized delivery URL for a public decorative image.
 *
 * The original upload remains untouched. Cloudinary crops a derived asset to
 * the requested canvas and negotiates both quality and format at delivery
 * time, so supporting browsers receive WebP or AVIF instead of the source PNG.
 */
export function optimizedPublicImageUrl(
  publicId: string,
  { width, height, version }: OptimizedPublicImageOptions
): string | null {
  const client = cloudinaryClient();
  if (!client) return null;

  return client.url(publicId, {
    resource_type: RESOURCE_TYPE,
    type: 'upload',
    secure: true,
    version,
    transformation: [
      { crop: 'fill', gravity: 'center', width, height },
      { fetch_format: 'auto', quality: 'auto' },
    ],
  });
}

/**
 * Removes an asset. Best-effort and never throws: a failed delete costs storage,
 * and failing the surrounding action over it would be a worse trade.
 */
export async function destroyAsset(
  publicId: string,
  authenticated = false
): Promise<void> {
  const client = cloudinaryClient();
  if (!client) return;

  try {
    await client.uploader.destroy(publicId, {
      resource_type: RESOURCE_TYPE,
      type: authenticated ? 'authenticated' : 'upload',
      invalidate: true,
    });
  } catch (error) {
    console.error('[cloudinary] destroy failed:', describe(error));
  }
}

/**
 * One stored asset, or null when it does not exist.
 *
 * Used where the account itself is the record rather than a database row — the
 * site logo, which has a fixed public id and so needs no table to find it.
 */
export async function findAsset(
  publicId: string
): Promise<StoredAsset | null> {
  if (Date.now() < assetLookupBlockedUntil) return null;
  const client = cloudinaryClient();
  if (!client) return null;

  try {
    const result = await client.api.resource(publicId, {
      resource_type: RESOURCE_TYPE,
      type: 'upload',
    });

    return {
      publicId: result.public_id,
      version: result.version,
      url: result.secure_url,
      format: result.format,
      width: typeof result.width === 'number' ? result.width : null,
      height: typeof result.height === 'number' ? result.height : null,
      createdAt: result.created_at ?? null,
    };
  } catch (error) {
    // 404 is the ordinary "no logo has been uploaded" answer, not a fault.
    if (isNotFound(error)) return null;
    if (isRateLimited(error)) {
      assetLookupBlockedUntil = rateLimitResetAt(error) ?? Date.now() + 5 * 60_000;
      return null;
    }
    // A logo lookup must never take down a page. Keep an unexpected diagnostic
    // without promoting this optional branding failure to Next's error overlay.
    console.warn('[cloudinary] logo lookup unavailable:', describe(error));
    return null;
  }
}

/* ── Error shapes ──────────────────────────────────────────────── */

function isNotFound(error: unknown): boolean {
  const status = (error as { http_code?: number; error?: { http_code?: number } })
    ?.http_code;
  const nested = (error as { error?: { http_code?: number } })?.error?.http_code;
  return status === 404 || nested === 404;
}

function isRateLimited(error: unknown): boolean {
  const status = (error as { http_code?: number; error?: { http_code?: number } })
    ?.http_code;
  const nested = (error as { error?: { http_code?: number } })?.error?.http_code;
  return (
    status === 420 ||
    status === 429 ||
    nested === 420 ||
    nested === 429 ||
    /rate\s*limit\s*exceeded/i.test(describe(error))
  );
}

function rateLimitResetAt(error: unknown): number | null {
  const match = /try again on (.+? UTC)/i.exec(describe(error));
  if (!match) return null;
  const parsed = Date.parse(match[1]);
  return Number.isFinite(parsed) ? parsed : null;
}

/** Cloudinary nests its message; `String(error)` on the wrapper says nothing. */
function describe(error: unknown): string {
  const message =
    (error as { message?: string })?.message ??
    (error as { error?: { message?: string } })?.error?.message;
  return message ?? String(error);
}
