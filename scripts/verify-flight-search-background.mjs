import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

function source(...parts) {
  return fs.readFileSync(path.join(process.cwd(), ...parts), 'utf8');
}

const uploadVerify = source('lib', 'upload-verify.ts');
const nextConfig = source('next.config.js');
const cloudinary = source('lib', 'cloudinary.ts');
const asset = source('lib', 'flight-search-background.ts');
const actions = source('app', '(dashboard)', 'dashboard', 'media', 'actions.ts');
const mediaPage = source('app', '(dashboard)', 'dashboard', 'media', 'page.tsx');
const manager = source(
  'components',
  'dashboard',
  'FlightSearchBackgroundManager.tsx'
);
const flightSearchPage = source(
  'app',
  '(dashboard)',
  'dashboard',
  'flight-search',
  'page.tsx'
);

assert.match(uploadVerify, /FLIGHT_SEARCH_BACKGROUND_MAX_BYTES = 2 \* 1024 \* 1024/);
assert.match(uploadVerify, /FLIGHT_SEARCH_BACKGROUND_RECOMMENDED_WIDTH = 1920/);
assert.match(uploadVerify, /FLIGHT_SEARCH_BACKGROUND_RECOMMENDED_HEIGHT = 360/);
assert.match(uploadVerify, /FLIGHT_SEARCH_BACKGROUND_MIN_WIDTH = 1360/);
assert.match(uploadVerify, /FLIGHT_SEARCH_BACKGROUND_MIN_HEIGHT = 255/);
assert.match(uploadVerify, /FLIGHT_SEARCH_BACKGROUND_MIN_ASPECT_RATIO = 2/);
assert.match(uploadVerify, /FLIGHT_SEARCH_BACKGROUND_MAX_ASPECT_RATIO = 8/);
assert.match(uploadVerify, /2:1–8:1 landscape/);
assert.match(
  nextConfig,
  /serverActions:\s*\{\s*bodySizeLimit:\s*'3mb'\s*\}/,
  'Server Actions must accept the 2 MB image plus multipart request overhead'
);
assert.match(
  uploadVerify,
  /FLIGHT_SEARCH_BACKGROUND_EXTENSIONS[\s\S]*'image\/png'[\s\S]*'image\/webp'[\s\S]*'image\/jpeg'/
);
assert.doesNotMatch(
  uploadVerify.match(
    /FLIGHT_SEARCH_BACKGROUND_EXTENSIONS:[\s\S]*?\n};/
  )?.[0] ?? '',
  /svg/i,
  'the decorative background must remain raster-only'
);
assert.match(
  uploadVerify,
  /flightSearchBackgroundDimensionError[\s\S]*MIN_ASPECT_RATIO[\s\S]*MAX_ASPECT_RATIO/
);

assert.match(asset, /dashboard-flight-search/);
assert.match(asset, /unstable_cache[\s\S]*FLIGHT_SEARCH_BACKGROUND_CACHE_TAG/);
assert.match(
  cloudinary,
  /optimizedPublicImageUrl[\s\S]*crop: 'fill'[\s\S]*gravity: 'center'[\s\S]*fetch_format: 'auto'[\s\S]*quality: 'auto'/
);
assert.match(
  asset,
  /optimizedPublicImageUrl\(asset\.publicId[\s\S]*FLIGHT_SEARCH_BACKGROUND_RECOMMENDED_WIDTH[\s\S]*FLIGHT_SEARCH_BACKGROUND_RECOMMENDED_HEIGHT[\s\S]*version: asset\.version[\s\S]*optimizedUrl \?\? asset\.url/
);
assert.match(
  actions,
  /uploadFlightSearchBackgroundAction[\s\S]*!canManageMedia\(session\.role\)[\s\S]*manageMediaBackground[\s\S]*FLIGHT_SEARCH_BACKGROUND_MAX_BYTES[\s\S]*inspectFlightSearchBackgroundBytes[\s\S]*sharp\(bytes\)\.metadata\(\)[\s\S]*flightSearchBackgroundDimensionError[\s\S]*uploadAsset/
);
assert.match(
  actions,
  /removeFlightSearchBackgroundAction[\s\S]*!canManageMedia\(session\.role\)[\s\S]*destroyAsset\(FLIGHT_SEARCH_BACKGROUND_PUBLIC_ID\)/
);
assert.match(actions, /media\.flight_search_background_uploaded/);
assert.match(actions, /media\.flight_search_background_removed/);

assert.match(mediaPage, /getFlightSearchBackground\(\)/);
assert.match(mediaPage, /<FlightSearchBackgroundManager/);
assert.match(manager, /Image requirements[\s\S]*FLIGHT_SEARCH_BACKGROUND_HINT/);
assert.match(manager, /Cloudinary automatically delivers an optimized 1920 × 360 crop/);
assert.match(manager, /createImageBitmap[\s\S]*flightSearchBackgroundDimensionError/);
assert.match(manager, /Replace image/);
assert.match(manager, /Confirm removal/);

assert.match(
  flightSearchPage,
  /getFlightSearchBackground\(\)[\s\S]*h-\[255px\] w-full bg-cover bg-center[\s\S]*backgroundImage[\s\S]*background\.url/
);
assert.match(
  flightSearchPage,
  /!background && 'bg-search-gradient'/,
  'the gradient may appear only as the no-image fallback'
);

console.log('flight-search background verification passed');
