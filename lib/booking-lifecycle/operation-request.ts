import 'server-only';

import { createHash } from 'node:crypto';

export type SupplierWriteAction = 'booking' | 'ticketing' | 'cancellation';

type OperationRequestInput = {
  /** Untrusted retry nonce. The server never stores or uses it directly. */
  clientRequestNonce: string;
  action: SupplierWriteAction;
  subjectType: 'booking' | 'attempt';
  subjectId: string;
  payload: unknown;
};

export type OperationRequestIdentity = {
  /** Server-derived opaque key used for replay identity. */
  requestKey: string;
  /** Canonical action/subject/payload binding checked on every replay. */
  requestPayloadHash: string;
};

function canonical(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'string' || typeof value === 'boolean') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new Error('Operation payload contains a non-finite number.');
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonical(item)).join(',')}]`;
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right));
    return `{${entries
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(',')}}`;
  }
  throw new Error('Operation payload contains an unsupported value.');
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/**
 * Converts a client retry nonce into an internal key and independently binds
 * that key to the exact canonical supplier-write intent. A reused nonce keeps
 * the same request key, so the database can reject any changed payload.
 */
export function createOperationRequestIdentity(
  input: OperationRequestInput
): OperationRequestIdentity {
  if (!input.clientRequestNonce.trim()) {
    throw new Error('Operation request nonce is required.');
  }
  const requestKey = `operation:v1:${sha256(
    canonical({ namespace: 'booking-lifecycle', nonce: input.clientRequestNonce })
  )}`;
  const requestPayloadHash = sha256(
    canonical({
      version: 1,
      action: input.action,
      subjectType: input.subjectType,
      subjectId: input.subjectId,
      payload: input.payload,
    })
  );
  return { requestKey, requestPayloadHash };
}
