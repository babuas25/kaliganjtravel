import { publicUrl } from '@/lib/cloudinary';

/** Public payment instructions, never receipt or identity document assets. */
export const BANGLA_QR_UPLOAD_FOLDER =
  'kaliganj-travels/wallet/bangla-qr';

export const BANGLA_QR_BUNDLED_IMAGE =
  '/images/payments/bangla-qr.png';

export type BanglaQrPaymentAsset = {
  publicId: string;
  version: number;
  format: string;
  uploadedAt: string;
};

/** Only handles created by this upload endpoint may be displayed or deleted. */
export function banglaQrPaymentAsset(value: unknown): BanglaQrPaymentAsset | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const asset = value as Partial<BanglaQrPaymentAsset>;
  if (
    typeof asset.publicId !== 'string' ||
    !asset.publicId.startsWith(`${BANGLA_QR_UPLOAD_FOLDER}/`) ||
    !/^[a-zA-Z0-9/_-]+$/.test(asset.publicId) ||
    typeof asset.version !== 'number' ||
    !Number.isSafeInteger(asset.version) ||
    asset.version < 1 ||
    typeof asset.format !== 'string' ||
    !['svg', 'png', 'webp', 'jpg', 'jpeg'].includes(asset.format)
  ) {
    return null;
  }
  return {
    publicId: asset.publicId,
    version: asset.version,
    format: asset.format,
    uploadedAt: typeof asset.uploadedAt === 'string' ? asset.uploadedAt : '',
  };
}

/** The sole bundled image is trusted; arbitrary local paths and URLs are not. */
export function banglaQrAssetUrl(value: unknown): string | null {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const localPath = (value as { localPath?: unknown }).localPath;
    if (localPath === BANGLA_QR_BUNDLED_IMAGE) return BANGLA_QR_BUNDLED_IMAGE;
  }
  const asset = banglaQrPaymentAsset(value);
  return asset ? publicUrl(asset.publicId, asset.version) : null;
}
