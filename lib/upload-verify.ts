/**
 * What an upload is allowed to be, and whether its bytes agree.
 *
 * Pure: no SDK, no database, no request. That matters — the pickers that use
 * these limits are client components, and this file is what lets them share the
 * rules without dragging a Node-only SDK into the browser bundle.
 *
 * **What arrives from the browser is a claim.** `File.type` is set by the
 * client and can say anything, so every function here checks the claim against
 * the content and reports the type that was *verified*. Callers store under
 * that, never under what was asserted.
 */

/* ── Signatures ────────────────────────────────────────────────── */

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const JPEG_SIGNATURE = [0xff, 0xd8, 0xff];
const RIFF_SIGNATURE = [0x52, 0x49, 0x46, 0x46]; // "RIFF"
const WEBP_SIGNATURE = [0x57, 0x45, 0x42, 0x50]; // "WEBP", at offset 8
const PDF_SIGNATURE = [0x25, 0x50, 0x44, 0x46, 0x2d]; // "%PDF-"

function hasSignature(
  bytes: Uint8Array,
  signature: readonly number[],
  offset = 0
): boolean {
  return signature.every((byte, index) => bytes[offset + index] === byte);
}

/**
 * The raster format the bytes actually are, or null for anything else.
 *
 * SVG is deliberately absent: it is XML text with no magic number, so it cannot
 * be identified this way. `findSvgThreat` covers that case instead.
 */
export function sniffRasterMime(bytes: Uint8Array): string | null {
  if (hasSignature(bytes, PNG_SIGNATURE)) return 'image/png';
  if (hasSignature(bytes, JPEG_SIGNATURE)) return 'image/jpeg';
  if (
    hasSignature(bytes, RIFF_SIGNATURE) &&
    hasSignature(bytes, WEBP_SIGNATURE, 8)
  ) {
    return 'image/webp';
  }
  return null;
}

export function isPdf(bytes: Uint8Array): boolean {
  return hasSignature(bytes, PDF_SIGNATURE);
}

/* ── SVG ───────────────────────────────────────────────────────── */

/**
 * Whether the source's first element is `<svg`, once the things a real exporter
 * puts in front of it are stripped. Illustrator, for one, emits an XML
 * declaration, a generator comment and a DOCTYPE before the root element.
 */
function looksLikeSvg(source: string): boolean {
  const head = source
    .replace(/^﻿/, '')
    .replace(/<\?xml[\s\S]*?\?>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    // The optional [...] is a DOCTYPE internal subset. Matching it means a
    // declaration does not swallow the check below, so an entity gets reported
    // as an entity rather than as a malformed root element.
    .replace(/<!DOCTYPE[^[>]*(?:\[[\s\S]*?\])?[^>]*>/gi, '')
    .trimStart();

  return /^<\s*svg[\s>]/i.test(head);
}

/**
 * Constructs that have no place in a logo, with the wording shown to the
 * uploader.
 *
 * This is a blocklist, and a blocklist can be evaded — entity encoding, CDATA
 * and namespace tricks all exist. It is here to catch the obvious cases loudly
 * rather than to be a complete parser, and it is not the only thing standing
 * between a hostile SVG and a visitor: see `lib/cloudinary.ts` for how these
 * are delivered.
 */
const SVG_THREATS: readonly { pattern: RegExp; reason: string }[] = [
  { pattern: /<\s*script[\s>]/i, reason: 'a <script> element' },
  { pattern: /\son[a-z]+\s*=/i, reason: 'an inline event handler' },
  { pattern: /javascript\s*:/i, reason: 'a javascript: URL' },
  { pattern: /<\s*foreignObject[\s>]/i, reason: 'a <foreignObject> element' },
  { pattern: /<!ENTITY/i, reason: 'an XML entity declaration' },
  {
    pattern: /<\s*(iframe|embed|object)[\s>]/i,
    reason: 'an embedded document',
  },
  { pattern: /data:(?!image\/)/i, reason: 'a non-image data: URL' },
  {
    pattern: /<\s*use[^>]*href\s*=\s*["']?\s*(?:https?:)?\/\//i,
    reason: 'a <use> element pointing at a remote document',
  },
];

/** The first threatening construct found in an SVG, or null when it is clean. */
export function findSvgThreat(source: string): string | null {
  return SVG_THREATS.find(({ pattern }) => pattern.test(source))?.reason ?? null;
}

/* ── The site logo ─────────────────────────────────────────────── */

/** 512 KB. A header logo has no business being larger. */
export const LOGO_MAX_BYTES = 512 * 1024;

/** Extension per accepted MIME type; the keys double as the allow-list. */
export const LOGO_EXTENSIONS: Record<string, string> = {
  'image/svg+xml': 'svg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/jpeg': 'jpg',
};

export const LOGO_MIME_TYPES = Object.keys(LOGO_EXTENSIONS);

/** `accept` attribute for the file input. */
export const LOGO_ACCEPT = LOGO_MIME_TYPES.join(',');

/* ── Dashboard flight-search background ───────────────────────── */

/** 2 MB: large enough for a crisp 1920px-wide WebP/JPEG hero. */
export const FLIGHT_SEARCH_BACKGROUND_MAX_BYTES = 2 * 1024 * 1024;
export const FLIGHT_SEARCH_BACKGROUND_RECOMMENDED_WIDTH = 1920;
export const FLIGHT_SEARCH_BACKGROUND_RECOMMENDED_HEIGHT = 360;
export const FLIGHT_SEARCH_BACKGROUND_MIN_WIDTH = 1360;
export const FLIGHT_SEARCH_BACKGROUND_MIN_HEIGHT = 255;
export const FLIGHT_SEARCH_BACKGROUND_MIN_ASPECT_RATIO = 2;
export const FLIGHT_SEARCH_BACKGROUND_MAX_ASPECT_RATIO = 8;

/** Raster only: a decorative photographic background never needs SVG. */
export const FLIGHT_SEARCH_BACKGROUND_EXTENSIONS: Record<string, string> = {
  'image/png': 'png',
  'image/webp': 'webp',
  'image/jpeg': 'jpg',
};

export const FLIGHT_SEARCH_BACKGROUND_ACCEPT = Object.keys(
  FLIGHT_SEARCH_BACKGROUND_EXTENSIONS
).join(',');

export const FLIGHT_SEARCH_BACKGROUND_HINT =
  'Recommended 1920 × 360 px; minimum 1360 × 255 px; 2:1–8:1 landscape; JPEG, PNG or WebP; maximum 2 MB.';

export function flightSearchBackgroundDimensionError(
  width: number,
  height: number
): string | null {
  if (
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width < FLIGHT_SEARCH_BACKGROUND_MIN_WIDTH ||
    height < FLIGHT_SEARCH_BACKGROUND_MIN_HEIGHT
  ) {
    return `The image must be at least ${FLIGHT_SEARCH_BACKGROUND_MIN_WIDTH} × ${FLIGHT_SEARCH_BACKGROUND_MIN_HEIGHT} px.`;
  }

  const ratio = width / height;
  if (
    ratio < FLIGHT_SEARCH_BACKGROUND_MIN_ASPECT_RATIO ||
    ratio > FLIGHT_SEARCH_BACKGROUND_MAX_ASPECT_RATIO
  ) {
    return 'Use a wide landscape image with an aspect ratio between 2:1 and 8:1.';
  }
  return null;
}

/* ── Documents ─────────────────────────────────────────────────── */

/** 5 MB each. A scanned trade licence fits with room to spare. */
export const DOC_MAX_BYTES = 5 * 1024 * 1024;

/**
 * SVG is deliberately absent here, unlike the logo. A licence scan is never an
 * SVG, and admitting one would mean carrying the script-scanning blocklist for
 * a format nobody needs.
 */
export const DOC_EXTENSIONS: Record<string, string> = {
  'application/pdf': 'pdf',
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
};

export const DOC_MIME_TYPES = Object.keys(DOC_EXTENSIONS);

export const DOC_ACCEPT = DOC_MIME_TYPES.join(',');

export const DOC_HINT = 'PDF, PNG, JPEG or WebP, up to 5 MB.';

/* ── Inspection ────────────────────────────────────────────────── */

export type Inspection =
  | { ok: true; mime: string; extension: string }
  | { ok: false; reason: string };

/**
 * Checks a logo upload's bytes against the type the browser declared.
 *
 * Fails closed: anything that cannot be positively identified is rejected.
 */
export function inspectLogoBytes(
  bytes: Uint8Array,
  declaredType: string
): Inspection {
  if (!LOGO_EXTENSIONS[declaredType]) {
    return { ok: false, reason: 'Use an SVG, PNG, WebP or JPEG file.' };
  }

  if (declaredType === 'image/svg+xml') {
    // Decoded as UTF-8. A UTF-16 file decodes to nonsense and fails the root
    // element check below, which is the outcome we want anyway.
    const source = new TextDecoder('utf-8').decode(bytes);

    // Threats first, so a file carrying one is reported for what it carries
    // rather than for whatever else may also be wrong with it.
    const threat = findSvgThreat(source);
    if (threat) {
      return {
        ok: false,
        reason: `That SVG contains ${threat}, which a logo does not need. Export it again without scripting, or upload a PNG.`,
      };
    }
    if (!looksLikeSvg(source)) {
      return { ok: false, reason: 'That file is not a valid SVG image.' };
    }

    return { ok: true, mime: 'image/svg+xml', extension: 'svg' };
  }

  const actual = sniffRasterMime(bytes);
  if (!actual) {
    return { ok: false, reason: 'That file is not a PNG, WebP or JPEG image.' };
  }
  if (actual !== declaredType) {
    return {
      ok: false,
      reason:
        'That file’s contents do not match its type. Re-save it and try again.',
    };
  }

  return { ok: true, mime: actual, extension: LOGO_EXTENSIONS[actual] };
}

/** Raster-only byte/type validation for the dashboard flight-search hero. */
export function inspectFlightSearchBackgroundBytes(
  bytes: Uint8Array,
  declaredType: string
): Inspection {
  if (!FLIGHT_SEARCH_BACKGROUND_EXTENSIONS[declaredType]) {
    return { ok: false, reason: 'Use a JPEG, PNG or WebP image.' };
  }

  const actual = sniffRasterMime(bytes);
  if (!actual) {
    return { ok: false, reason: 'That file is not a JPEG, PNG or WebP image.' };
  }
  if (actual !== declaredType) {
    return {
      ok: false,
      reason:
        'That file’s contents do not match its type. Re-save it and try again.',
    };
  }

  return {
    ok: true,
    mime: actual,
    extension: FLIGHT_SEARCH_BACKGROUND_EXTENSIONS[actual],
  };
}

/* ── Homepage travel-offer cards ──────────────────────────────── */

export const HOMEPAGE_OFFER_IMAGE_MAX_BYTES = 2 * 1024 * 1024;
export const HOMEPAGE_OFFER_IMAGE_RECOMMENDED_WIDTH = 1200;
export const HOMEPAGE_OFFER_IMAGE_RECOMMENDED_HEIGHT = 720;
export const HOMEPAGE_OFFER_IMAGE_MIN_WIDTH = 600;
export const HOMEPAGE_OFFER_IMAGE_MIN_HEIGHT = 360;
export const HOMEPAGE_OFFER_IMAGE_MIN_ASPECT_RATIO = 1.2;
export const HOMEPAGE_OFFER_IMAGE_MAX_ASPECT_RATIO = 2.2;
export const HOMEPAGE_OFFER_IMAGE_EXTENSIONS =
  FLIGHT_SEARCH_BACKGROUND_EXTENSIONS;
export const HOMEPAGE_OFFER_IMAGE_ACCEPT = Object.keys(
  HOMEPAGE_OFFER_IMAGE_EXTENSIONS
).join(',');
export const HOMEPAGE_OFFER_IMAGE_HINT =
  'Recommended 1200 × 720 px; minimum 600 × 360 px; JPEG, PNG or WebP; maximum 2 MB.';

export function homepageOfferImageDimensionError(
  width: number,
  height: number
): string | null {
  if (
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width < HOMEPAGE_OFFER_IMAGE_MIN_WIDTH ||
    height < HOMEPAGE_OFFER_IMAGE_MIN_HEIGHT
  ) {
    return `The image must be at least ${HOMEPAGE_OFFER_IMAGE_MIN_WIDTH} × ${HOMEPAGE_OFFER_IMAGE_MIN_HEIGHT} px.`;
  }
  const ratio = width / height;
  if (
    ratio < HOMEPAGE_OFFER_IMAGE_MIN_ASPECT_RATIO ||
    ratio > HOMEPAGE_OFFER_IMAGE_MAX_ASPECT_RATIO
  ) {
    return 'Use a landscape image with an aspect ratio between 1.2:1 and 2.2:1.';
  }
  return null;
}

export function inspectHomepageOfferImageBytes(
  bytes: Uint8Array,
  declaredType: string
): Inspection {
  return inspectFlightSearchBackgroundBytes(bytes, declaredType);
}

/** The same check for a supporting document, where PDF is allowed and SVG is not. */
export function inspectDocumentBytes(
  bytes: Uint8Array,
  declaredType: string
): Inspection {
  if (!DOC_EXTENSIONS[declaredType]) {
    return { ok: false, reason: 'Use a PDF, PNG, JPEG or WebP file.' };
  }

  const actual = isPdf(bytes) ? 'application/pdf' : sniffRasterMime(bytes);

  if (!actual) {
    return {
      ok: false,
      reason: 'That file is not a PDF, PNG, JPEG or WebP document.',
    };
  }
  if (actual !== declaredType) {
    return {
      ok: false,
      reason:
        'That file’s contents do not match its type. Re-save it and try again.',
    };
  }

  return { ok: true, mime: actual, extension: DOC_EXTENSIONS[actual] };
}
