/**
 * A stored file, as every table that holds one records it.
 *
 * Pure: no SDK, no database. The reading and writing is in `lib/db/*`, the
 * upload and signing in `lib/cloudinary.ts`.
 *
 * **A handle, not a URL.** A public URL to a NID card is a permanent leak and a
 * signed one expires, so neither belongs in a column — what is stored is what
 * Cloudinary needs to produce a link on demand.
 */

export type StoredDoc = {
  /** Cloudinary public id. */
  publicId: string;
  /** Needed to sign a download link; not derivable from the public id. */
  format: string;
  /** ISO timestamp, for showing the owner when they last replaced it. */
  uploadedAt: string;
};

/** Named slots — the company profile's five business documents. */
export type DocumentMap = Record<string, StoredDoc>;

function isStoredDoc(value: unknown): value is StoredDoc {
  if (!value || typeof value !== 'object') return false;

  const doc = value as Partial<StoredDoc>;
  return (
    typeof doc.publicId === 'string' &&
    doc.publicId.length > 0 &&
    typeof doc.format === 'string'
  );
}

/**
 * Narrows a `jsonb` column to the named-slot shape.
 *
 * Postgres will hand back whatever was written, and an older row may predate a
 * field or carry one that has since been removed. Anything that is not a
 * well-formed entry is dropped rather than trusted — a malformed handle would
 * otherwise reach `private_download_url` and throw at render time.
 */
export function coerceDocumentMap(
  value: unknown,
  allowedKeys: readonly string[]
): DocumentMap {
  const source = (value ?? {}) as Record<string, unknown>;
  const map: DocumentMap = {};

  for (const key of allowedKeys) {
    const entry = source[key];
    if (isStoredDoc(entry)) {
      map[key] = {
        publicId: entry.publicId,
        format: entry.format,
        uploadedAt: entry.uploadedAt ?? '',
      };
    }
  }
  return map;
}

/** Narrows a `jsonb` column to the list shape — the upgrade attachments. */
export function coerceDocumentList(value: unknown): StoredDoc[] {
  if (!Array.isArray(value)) return [];

  return value.filter(isStoredDoc).map((entry) => ({
    publicId: entry.publicId,
    format: entry.format,
    uploadedAt: entry.uploadedAt ?? '',
  }));
}
