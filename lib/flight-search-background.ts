import 'server-only';

import { cache } from 'react';
import { unstable_cache } from 'next/cache';

import {
  findAsset,
  FOLDERS,
  optimizedPublicImageUrl,
} from '@/lib/cloudinary';
import {
  FLIGHT_SEARCH_BACKGROUND_RECOMMENDED_HEIGHT,
  FLIGHT_SEARCH_BACKGROUND_RECOMMENDED_WIDTH,
} from '@/lib/upload-verify';

export const FLIGHT_SEARCH_BACKGROUND_PUBLIC_ID =
  `${FOLDERS.marketing}/dashboard-flight-search`;
export const FLIGHT_SEARCH_BACKGROUND_CACHE_TAG =
  'dashboard-flight-search-background';

export type FlightSearchBackground = {
  url: string;
  filename: string;
  width: number | null;
  height: number | null;
  updatedAt: string | null;
};

const readFlightSearchBackgroundAsset = unstable_cache(
  () => findAsset(FLIGHT_SEARCH_BACKGROUND_PUBLIC_ID),
  ['dashboard-flight-search-background-asset'],
  {
    revalidate: 60 * 60,
    tags: [FLIGHT_SEARCH_BACKGROUND_CACHE_TAG],
  }
);

/** Fixed-id Cloudinary image used behind the dashboard flight-search panel. */
export const getFlightSearchBackground = cache(
  async (): Promise<FlightSearchBackground | null> => {
    const asset = await readFlightSearchBackgroundAsset();
    if (!asset) return null;

    const optimizedUrl = optimizedPublicImageUrl(asset.publicId, {
      width: FLIGHT_SEARCH_BACKGROUND_RECOMMENDED_WIDTH,
      height: FLIGHT_SEARCH_BACKGROUND_RECOMMENDED_HEIGHT,
      version: asset.version,
    });

    return {
      url: optimizedUrl ?? asset.url,
      filename: `dashboard-flight-search.${asset.format}`,
      width: asset.width,
      height: asset.height,
      updatedAt: asset.createdAt,
    };
  }
);
