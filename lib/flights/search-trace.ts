import 'server-only';

/**
 * A deliberately small, request-scoped telemetry contract for live flight
 * searches. The values are safe to emit to operational logs: callers must not
 * put supplier references, bearer tokens, raw request bodies, prices, or any
 * traveller data in `details`.
 */
export type FlightSearchTraceDetails = Readonly<
  Record<string, string | number | boolean | null>
>;

export type FlightSearchTraceEvent = {
  name: string;
  details?: FlightSearchTraceDetails;
};

export type FlightSearchTraceObserver = (event: FlightSearchTraceEvent) => void;
