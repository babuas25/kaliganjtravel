/** One row in the From / To suggestion list. */
export type AirportOption = {
  id: string;
  name: string;
  city: string;
  country: string;
  iata: string;
  /** True for a "All Airports" row that stands for a whole metro area. */
  isCity?: boolean;
  /** Metro-area code (LON, NYC…) shared by a city row and its airports. */
  cityCode?: string;
  /** True when the row came from the visitor's own recent picks. */
  isRecent?: boolean;
  /** True for the curated Bangladesh shortlist shown on an empty query. */
  isPopular?: boolean;
};
