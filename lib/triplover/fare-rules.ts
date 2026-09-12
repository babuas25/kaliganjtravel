import 'server-only';

import {
  readSearch,
  SearchReferenceStoreError,
} from '@/lib/flights/search-cache';
import type {
  FareRuleSection,
  FlightFareRulesResult,
} from '@/lib/flights/types';
import { triploverCall } from '@/lib/triplover/client';

type RawFareRuleDetail = {
  type?: unknown;
  fareRuleDetail?: unknown;
};

type RawFareRules = {
  fareRuleDetails?: unknown;
};

export type FlightFareRulesErrorCode =
  | 'SEARCH_EXPIRED'
  | 'FARE_NOT_FOUND'
  | 'SEARCH_REFERENCE_UNAVAILABLE'
  | 'SEARCH_REFERENCE_INVALID';

export class FlightFareRulesError extends Error {
  readonly code: FlightFareRulesErrorCode;
  readonly status: number;

  constructor(
    code: FlightFareRulesErrorCode,
    status: number,
    message: string
  ) {
    super(message);
    this.name = 'FlightFareRulesError';
    this.code = code;
    this.status = status;
  }
}

function mapFareRules(value: unknown): FareRuleSection[] {
  const response = (value ?? {}) as RawFareRules;
  if (!Array.isArray(response.fareRuleDetails)) return [];

  return response.fareRuleDetails.flatMap((entry) => {
    if (!entry || typeof entry !== 'object') return [];

    const rule = entry as RawFareRuleDetail;
    if (
      typeof rule.fareRuleDetail !== 'string' ||
      rule.fareRuleDetail.trim().length === 0
    ) {
      return [];
    }

    const type =
      typeof rule.type === 'string' && rule.type.trim().length > 0
        ? rule.type.trim()
        : 'General fare rule';

    return [
      {
        type,
        // Preserve meaningful GDS line breaks while making Windows and Unix
        // responses render consistently in the browser.
        detail: rule.fareRuleDetail.replace(/\r\n?/g, '\n').trim(),
      },
    ];
  });
}

/**
 * Resolves the browser-safe search/itinerary pair to private Triplover
 * references and returns only the supplier-authored rule narrative.
 */
export async function getFlightFareRules({
  searchId,
  itineraryId,
}: {
  searchId: string;
  itineraryId: string;
}): Promise<FlightFareRulesResult> {
  let search: Awaited<ReturnType<typeof readSearch>>;
  try {
    // FareRules also consumes supplier capabilities. Resolve them from the
    // shared Redis authority, not a process-local cache, before any supplier
    // request is made.
    search = await readSearch(searchId, { consistency: 'durable' });
  } catch (error) {
    if (error instanceof SearchReferenceStoreError) {
      if (error.kind === 'unavailable') {
        throw new FlightFareRulesError(
          'SEARCH_REFERENCE_UNAVAILABLE',
          503,
          'We could not securely retrieve this fare reference. Please search again.'
        );
      }
      throw new FlightFareRulesError(
        'SEARCH_REFERENCE_INVALID',
        502,
        'This fare reference could not be verified safely. Please search again.'
      );
    }
    throw error;
  }
  if (!search) {
    throw new FlightFareRulesError(
      'SEARCH_EXPIRED',
      410,
      'This fare search has expired. Run the search again.'
    );
  }

  const refs = search.refsByItineraryId.get(itineraryId);
  if (!refs) {
    throw new FlightFareRulesError(
      'FARE_NOT_FOUND',
      404,
      'That fare option is no longer available.'
    );
  }

  const call = await triploverCall('FareRules', '/api/FareRules', {
    itemCodeRef: refs.itemCodeRef,
    uniqueTransID: search.uniqueTransId,
    segmentCodeRefs: refs.segmentCodeRefs,
    brandedFareRefs: '',
  }, { supplier: search.supplierAccount });

  return {
    itineraryId,
    rules: mapFareRules(call.data),
  };
}
