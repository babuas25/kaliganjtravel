import 'server-only';

import type { OperationRequestIdentity } from '@/lib/booking-lifecycle/operation-request';
import {
  markBookingAttemptSupplierCallStarted,
  markBookingAttemptSupplierResponseReceived,
  markBookingOperationSupplierCallStarted,
  markBookingOperationSupplierResponseReceived,
} from '@/lib/db/booking-operations';
import type { SupplierWriteLifecycleHooks } from '@/lib/triplover/client';

export type SupplierWriteBoundarySnapshot = {
  supplierCallStarted: boolean;
  supplierResponseObserved: boolean;
  supplierResponseRecorded: boolean;
  httpStatus: number | null;
};

export type SupplierWriteLifecycleTracker = SupplierWriteLifecycleHooks & {
  boundarySnapshot: () => SupplierWriteBoundarySnapshot;
};

export class SupplierWriteBoundaryError extends Error {
  readonly phase: 'before-request' | 'response-received';
  readonly code: string;

  constructor(
    phase: 'before-request' | 'response-received',
    code: string
  ) {
    super(`Supplier lifecycle ${phase} boundary failed: ${code}`);
    this.name = 'SupplierWriteBoundaryError';
    this.phase = phase;
    this.code = code;
  }
}

export function bookingOperationSupplierWriteHooks(
  operationId: string,
  request: OperationRequestIdentity
): SupplierWriteLifecycleTracker {
  let supplierCallStarted = false;
  let supplierResponseObserved = false;
  let supplierResponseRecorded = false;
  let observedHttpStatus: number | null = null;
  return {
    boundarySnapshot: () => ({
      supplierCallStarted,
      supplierResponseObserved,
      supplierResponseRecorded,
      httpStatus: observedHttpStatus,
    }),
    async beforeRequest() {
      const result = await markBookingOperationSupplierCallStarted(
        operationId,
        request
      );
      if (!result.ok || !result.started) {
        throw new SupplierWriteBoundaryError(
          'before-request',
          result.code ?? 'SUPPLIER_CALL_BOUNDARY_FAILED'
        );
      }
      supplierCallStarted = true;
    },
    async onResponse({ httpStatus }) {
      supplierResponseObserved = true;
      observedHttpStatus = httpStatus;
      const result = await markBookingOperationSupplierResponseReceived(
        operationId,
        request,
        httpStatus
      );
      if (!result.ok) {
        throw new SupplierWriteBoundaryError(
          'response-received',
          result.code ?? 'SUPPLIER_RESPONSE_BOUNDARY_FAILED'
        );
      }
      supplierResponseRecorded = true;
    },
  };
}

export function bookingAttemptSupplierWriteHooks(
  attemptId: string,
  request: OperationRequestIdentity
): SupplierWriteLifecycleTracker {
  let supplierCallStarted = false;
  let supplierResponseObserved = false;
  let supplierResponseRecorded = false;
  let observedHttpStatus: number | null = null;
  return {
    boundarySnapshot: () => ({
      supplierCallStarted,
      supplierResponseObserved,
      supplierResponseRecorded,
      httpStatus: observedHttpStatus,
    }),
    async beforeRequest() {
      const result = await markBookingAttemptSupplierCallStarted(
        attemptId,
        request
      );
      if (!result.ok || !result.started) {
        throw new SupplierWriteBoundaryError(
          'before-request',
          result.code ?? 'SUPPLIER_CALL_BOUNDARY_FAILED'
        );
      }
      supplierCallStarted = true;
    },
    async onResponse({ httpStatus }) {
      supplierResponseObserved = true;
      observedHttpStatus = httpStatus;
      const result = await markBookingAttemptSupplierResponseReceived(
        attemptId,
        request,
        httpStatus
      );
      if (!result.ok) {
        throw new SupplierWriteBoundaryError(
          'response-received',
          result.code ?? 'SUPPLIER_RESPONSE_BOUNDARY_FAILED'
        );
      }
      supplierResponseRecorded = true;
    },
  };
}
