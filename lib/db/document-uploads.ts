import {
  destroyAsset,
  privateUrl,
  uploadAsset,
  type StoredAsset,
} from '@/lib/cloudinary';
import type { StoredDoc } from '@/lib/documents';
import { DOC_EXTENSIONS, DOC_MAX_BYTES, inspectDocumentBytes } from '@/lib/upload-verify';

/**
 * Taking a document from a form and turning it into something storable, and
 * back into a link for whoever is allowed to see it.
 *
 * **Server-only.** One copy of this, shared by the company profile's business
 * documents and the upgrade application's attachments — the two upload paths in
 * the product. They differ in where the handle is stored, not in how a file is
 * checked, and a second copy of these checks is the kind of thing that drifts.
 *
 * Everything here uploads as **authenticated**: trade licences, TIN
 * certificates, NID cards and whatever an applicant attaches are identity
 * documents. Cloudinary's default type is readable by anyone holding the URL,
 * which is not a default these can have.
 */

export type DocUploadResult =
  | { ok: true; docs: StoredDoc[] }
  | { ok: false; message: string };

function toStoredDoc(asset: StoredAsset): StoredDoc {
  return {
    publicId: asset.publicId,
    format: asset.format,
    uploadedAt: asset.createdAt ?? new Date().toISOString(),
  };
}

/**
 * Verifies and stores files, returning the handles to record.
 *
 * Every limit is checked again here even though the form checked them first: a
 * server action is a public endpoint, so the browser's limits are a courtesy to
 * the user rather than a control.
 *
 * **All or nothing.** The first rejection stops the batch and takes whatever
 * already went up with it, so a half-stored set never reaches a row. That
 * matters most on the profile, where a partial write would leave the form
 * showing four documents saved and one silently missing.
 */
export async function storeDocuments(
  files: File[],
  folder: string
): Promise<DocUploadResult> {
  if (!files.length) return { ok: true, docs: [] };

  const docs: StoredDoc[] = [];

  // Indexed rather than `for...of` over entries: the project compiles to ES5.
  for (let index = 0; index < files.length; index += 1) {
    const file = files[index];

    if (!DOC_EXTENSIONS[file.type]) {
      await discardDocuments(docs);
      return { ok: false, message: `“${file.name}”: use a PDF, PNG, JPEG or WebP file.` };
    }
    // Checked before the file is read into memory, so an oversized upload is
    // rejected rather than buffered.
    if (file.size > DOC_MAX_BYTES) {
      await discardDocuments(docs);
      return { ok: false, message: `“${file.name}” is over the 5 MB limit.` };
    }

    const bytes = new Uint8Array(await file.arrayBuffer());
    const inspection = inspectDocumentBytes(bytes, file.type);
    if (!inspection.ok) {
      await discardDocuments(docs);
      return { ok: false, message: `“${file.name}”: ${inspection.reason}` };
    }

    // No part of the uploaded filename reaches the public id: it is
    // attacker-controlled text, and nothing needs it — a reviewer reads the
    // document, not what it was called on someone's laptop.
    const stored = await uploadAsset(bytes, inspection.mime, {
      folder,
      authenticated: true,
    });
    if (!stored.ok) {
      await discardDocuments(docs);
      return { ok: false, message: stored.message };
    }

    docs.push(toStoredDoc(stored.asset));
  }

  return { ok: true, docs };
}

/**
 * Removes stored documents — a superseded set, or a batch abandoned partway.
 *
 * Best-effort and never throws: a failed delete costs storage, and failing the
 * surrounding action over it would be a worse trade for the person using it.
 */
export async function discardDocuments(docs: StoredDoc[]): Promise<void> {
  for (const doc of docs) {
    await destroyAsset(doc.publicId, true);
  }
}

export type SignedDoc = { url: string; label: string };

/**
 * Short-lived links, for someone already authorised to see these.
 *
 * Minted per view rather than stored. Anything that fails to sign is left out
 * rather than rendered as a link that dies when clicked.
 */
export function signDocuments(
  docs: StoredDoc[],
  label: (index: number, doc: StoredDoc) => string = (index) =>
    `Document ${index + 1}`
): SignedDoc[] {
  return docs.flatMap((doc, index) => {
    const url = privateUrl(doc.publicId, doc.format);
    return url ? [{ url, label: label(index, doc) }] : [];
  });
}
