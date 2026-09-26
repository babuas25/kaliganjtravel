import 'server-only';

import {
  SupplierWriteBoundaryError,
  type SupplierWriteBoundarySnapshot,
} from '@/lib/booking-lifecycle/supplier-write-hooks';
import { TriploverError } from '@/lib/triplover/client';
import { ShapontravelsWriteError } from '@/lib/shapontravels/client';

export type SupplierWriteFailureClass =
  | 'not-sent'
  | 'definitive-failure'
  | 'uncertain';

export type SupplierWriteFailureReason =
  | 'local_start_boundary_failed'
  | 'local_response_boundary_failed'
  | 'prewrite_configuration_failure'
  | 'prewrite_authentication_failure'
  | 'prewrite_network_failure'
  | 'prewrite_local_failure'
  | 'network_after_write'
  | 'incomplete_response'
  | 'protocol_response'
  | 'supplier_upstream_failure'
  | 'supplier_http_200_failure'
  | 'supplier_duplicate_booking'
  | 'supplier_rejected'
  | 'supplier_auth_rejected'
  | 'unexpected_after_write';

export type SupplierWriteFailureClassification = {
  failureClass: SupplierWriteFailureClass;
  reasonCode: SupplierWriteFailureReason;
  supplierCallStarted: boolean;
  supplierResponseObserved: boolean;
  supplierResponseRecorded: boolean;
  httpStatus: number | null;
  fundsMustRemainProtected: boolean;
  automaticReplayAllowed: false;
};

function result(
  boundary: SupplierWriteBoundarySnapshot,
  failureClass: SupplierWriteFailureClass,
  reasonCode: SupplierWriteFailureReason,
  error: unknown
): SupplierWriteFailureClassification {
  return {
    failureClass,
    reasonCode,
    supplierCallStarted: boundary.supplierCallStarted,
    supplierResponseObserved: boundary.supplierResponseObserved,
    supplierResponseRecorded: boundary.supplierResponseRecorded,
    httpStatus:
      boundary.httpStatus ??
      (error instanceof TriploverError || error instanceof ShapontravelsWriteError
        ? error.status : null),
    fundsMustRemainProtected: failureClass === 'uncertain',
    automaticReplayAllowed: false,
  };
}

function isDuplicateBookingRejection(error: TriploverError): boolean {
  return (
    error.kind === 'supplier' &&
    error.status === 200 &&
    /^duplicate booking for passenger(?:\s*:|\b)/i.test(error.message.trim())
  );
}

/**
 * One conservative decision table for supplier Book, NewTicket, and Cancel.
 *
 * The recorded boundary, not only the thrown error type, decides whether the
 * destructive request could have reached the supplier. A complete supplier
 * rejection is definitive except for 5xx and HTTP-200 business errors, whose
 * real-world side effect may disagree with the envelope. Protocol/incomplete
 * responses after a write are always uncertain.
 */
export function classifySupplierWriteFailure(
  error: unknown,
  boundary: SupplierWriteBoundarySnapshot
): SupplierWriteFailureClassification {
  if (error instanceof SupplierWriteBoundaryError) {
    return error.phase === 'before-request'
      ? result(boundary, 'not-sent', 'local_start_boundary_failed', error)
      : result(boundary, 'uncertain', 'local_response_boundary_failed', error);
  }

  if (!boundary.supplierCallStarted) {
    if (error instanceof ShapontravelsWriteError) {
      return result(boundary, 'not-sent',
        error.kind === 'auth' ? 'prewrite_authentication_failure'
          : error.kind === 'unconfigured' ? 'prewrite_configuration_failure'
            : 'prewrite_local_failure', error);
    }
    if (error instanceof TriploverError) {
      if (error.kind === 'unconfigured') {
        return result(
          boundary,
          'not-sent',
          'prewrite_configuration_failure',
          error
        );
      }
      if (error.kind === 'auth') {
        return result(
          boundary,
          'not-sent',
          'prewrite_authentication_failure',
          error
        );
      }
      if (error.kind === 'network') {
        return result(
          boundary,
          'not-sent',
          'prewrite_network_failure',
          error
        );
      }
    }
    return result(boundary, 'not-sent', 'prewrite_local_failure', error);
  }

  if (error instanceof ShapontravelsWriteError) {
    if (error.kind === 'network') {
      return result(boundary, 'uncertain', 'network_after_write', error);
    }
    if (error.kind === 'protocol' || error.kind === 'pending') {
      return result(boundary, 'uncertain', 'incomplete_response', error);
    }
    if (error.status === 409 || error.status === null || error.status >= 500) {
      return result(boundary, 'uncertain', 'supplier_upstream_failure', error);
    }
    return result(boundary, 'definitive-failure',
      error.kind === 'auth' ? 'supplier_auth_rejected' : 'supplier_rejected', error);
  }

  if (error instanceof TriploverError) {
    if (error.kind === 'network') {
      return result(boundary, 'uncertain', 'network_after_write', error);
    }
    if (error.kind === 'protocol') {
      const incomplete =
        /\b(?:incomplete|no\s+(?:booking|pnr|ticket|result)|without\s+ticket|bookingcoderef|ticketcoderef)\b/i.test(
          error.message
        );
      return result(
        boundary,
        'uncertain',
        incomplete ? 'incomplete_response' : 'protocol_response',
        error
      );
    }
    if (error.kind === 'supplier') {
      if (isDuplicateBookingRejection(error)) {
        return result(
          boundary,
          'definitive-failure',
          'supplier_duplicate_booking',
          error
        );
      }
      if (error.status === 200) {
        return result(
          boundary,
          'uncertain',
          'supplier_http_200_failure',
          error
        );
      }
      if (error.status !== null && error.status >= 500) {
        return result(
          boundary,
          'uncertain',
          'supplier_upstream_failure',
          error
        );
      }
      return result(boundary, 'definitive-failure', 'supplier_rejected', error);
    }
    if (error.kind === 'auth') {
      return result(
        boundary,
        'definitive-failure',
        'supplier_auth_rejected',
        error
      );
    }
  }

  return result(boundary, 'uncertain', 'unexpected_after_write', error);
}
