/** Client-safe homepage travel-offer content and validation limits. */

export const HOMEPAGE_OFFER_COUNT = 3;
export const HOMEPAGE_OFFER_HEADING_MAX_LENGTH = 100;
export const HOMEPAGE_OFFER_SUBHEADING_MAX_LENGTH = 180;
export const HOMEPAGE_OFFER_EYEBROW_MAX_LENGTH = 80;
export const HOMEPAGE_OFFER_TITLE_MAX_LENGTH = 100;
export const HOMEPAGE_OFFER_DESCRIPTION_MAX_LENGTH = 240;

export type HomepageOfferImage = {
  publicId: string;
  url: string;
  format: string;
  width: number;
  height: number;
  updatedAt: string;
};

export type HomepageOffer = {
  id: string;
  eyebrow: string;
  title: string;
  description: string;
  active: boolean;
  image: HomepageOfferImage | null;
};

export type HomepageOffersState = {
  heading: string;
  subheading: string;
  offers: HomepageOffer[];
  version: number;
  updatedAt: string | null;
  updatedBy: string | null;
  source: 'database' | 'fallback' | 'unavailable';
};

export const DEFAULT_HOMEPAGE_OFFER_HEADING =
  'Save Big with Limited-Time Travel Offers';
export const DEFAULT_HOMEPAGE_OFFER_SUBHEADING =
  'Exclusive flight deals, all in one place.';

export const DEFAULT_HOMEPAGE_OFFERS: readonly HomepageOffer[] = [
  {
    id: 'bc665cb7-e276-42b9-a63f-cd931b2c3ea7',
    eyebrow: 'Upgrade your airport experience',
    title: 'BALAKA Executive Lounge',
    description:
      'Relax in style before your flight with premium amenities and fast-track service.',
    active: true,
    image: null,
  },
  {
    id: '460b0fb1-dc51-45d0-8473-8c233b9dfb73',
    eyebrow: 'New offer',
    title: 'EBL SkyLounge access',
    description:
      'Enjoy lounge access, refreshments and rest zones for your next journey.',
    active: true,
    image: null,
  },
  {
    id: '523f37e1-50d1-4094-8bfe-719af47ff077',
    eyebrow: 'Best deals',
    title: 'Exclusive loyalty rewards',
    description:
      'Earn points faster and redeem more rewards on every flight booking.',
    active: true,
    image: null,
  },
] as const;
