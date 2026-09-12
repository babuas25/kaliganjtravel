/**
 * One-time: pull the marketing artwork from its recorded source and upload it
 * to Cloudinary under the public ids the site renders.
 *
 *   node scripts/seed-marketing.mjs
 *
 * Reads CLOUDINARY_CLOUD_NAME / CLOUDINARY_API_KEY / CLOUDINARY_API_SECRET from
 * the environment (or .env.local, which it parses itself — this runs outside
 * Next, so nothing loads that file for it).
 *
 * Safe to re-run: each image has a fixed public id and overwrites in place.
 *
 * The sources and ids are duplicated from `lib/marketing.ts` rather than
 * imported: that file is TypeScript and pulls in the app's module aliases, and
 * a seed script is not worth a build step. Keep the two in step — there are
 * four lines of it.
 */

import { readFileSync } from 'node:fs';
import { v2 as cloudinary } from 'cloudinary';

const FOLDER = 'kaliganj-travels/marketing';

const IMAGES = [
  {
    publicId: 'hero',
    source:
      'https://images.pexels.com/photos/3769138/pexels-photo-3769138.jpeg?auto=compress&cs=tinysrgb&w=1600',
  },
  {
    publicId: 'promo-maldives',
    source:
      'https://images.pexels.com/photos/1287460/pexels-photo-1287460.jpeg?auto=compress&cs=tinysrgb&w=1200',
  },
  {
    publicId: 'promo-tokyo',
    source:
      'https://images.pexels.com/photos/2506923/pexels-photo-2506923.jpeg?auto=compress&cs=tinysrgb&w=1200',
  },
  {
    publicId: 'promo-patagonia',
    source:
      'https://images.pexels.com/photos/235621/pexels-photo-235621.jpeg?auto=compress&cs=tinysrgb&w=1200',
  },
];

/** Minimal .env.local reader — enough for KEY=value, ignoring comments. */
function loadEnvLocal() {
  let text;
  try {
    text = readFileSync(new URL('../.env.local', import.meta.url), 'utf8');
  } catch {
    return;
  }

  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (!match) continue;
    const [, key, raw] = match;
    if (process.env[key]) continue;
    process.env[key] = raw.replace(/^["']|["']$/g, '');
  }
}

loadEnvLocal();

const cloud_name = process.env.CLOUDINARY_CLOUD_NAME;
const api_key = process.env.CLOUDINARY_API_KEY;
const api_secret = process.env.CLOUDINARY_API_SECRET;

if (!cloud_name || !api_key || !api_secret) {
  console.error(
    'Missing Cloudinary credentials. Set CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY and CLOUDINARY_API_SECRET in .env.local.'
  );
  process.exit(1);
}

cloudinary.config({ cloud_name, api_key, api_secret, secure: true });

let failed = 0;

for (const image of IMAGES) {
  try {
    // Cloudinary fetches the URL itself, so nothing is buffered here.
    const result = await cloudinary.uploader.upload(image.source, {
      folder: FOLDER,
      public_id: image.publicId,
      resource_type: 'image',
      overwrite: true,
      invalidate: true,
    });
    console.log(`✓ ${result.public_id}  (v${result.version})`);
  } catch (error) {
    failed += 1;
    console.error(
      `✗ ${FOLDER}/${image.publicId}: ${error?.message ?? error?.error?.message ?? error}`
    );
  }
}

process.exit(failed ? 1 : 0);
