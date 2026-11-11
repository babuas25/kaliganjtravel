import 'server-only';

import { createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { isCanonicalDeadlineTime } from './deadline-time';

const MAX_BODY_BYTES = 4096;
const MAX_SIGNATURE_HEADER_BYTES = 2048;
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const REFERENCE = /^STR(?:[A-Z0-9]{12}|[0-9]{12}(?:0[1-9]|[1-9][0-9]{1,18}))$/;

const eventSchema = z.object({
  type: z.literal('booking.ticketing_deadline.changed'),
  id: z.string().regex(UUID),
  bookingId: z.string().regex(UUID),
  reference: z.string().regex(REFERENCE),
  revision: z.number().refine(value => Number.isSafeInteger(value) && value > 0),
  occurredAt: z.string().refine(value => isCanonicalDeadlineTime(value, 'Z')),
  deadline: z.string().refine(value => isCanonicalDeadlineTime(value, '+06:00')).nullable(),
}).strict();

function decodeBase64(value: string): Buffer | null {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value)) return null;
  const decoded = Buffer.from(value, 'base64');
  return decoded.toString('base64') === value ? decoded : null;
}

function signingKey(secret: string | undefined): Buffer | null {
  if (!secret?.startsWith('whsec_') || secret.length > 94) return null;
  const decoded = decodeBase64(secret.slice(6));
  return decoded && decoded.length >= 32 && decoded.length <= 64 ? decoded : null;
}

export function deadlineWebhookKeys(env: NodeJS.ProcessEnv): Buffer[] | null {
  if (env.SHAPONTRAVELS_DEADLINE_WEBHOOK_ENABLED !== 'true') return null;
  const current = signingKey(env.SHAPONTRAVELS_DEADLINE_WEBHOOK_SECRET);
  if (!current) return null;
  const previousSecret = env.SHAPONTRAVELS_DEADLINE_WEBHOOK_PREVIOUS_SECRET;
  if (!previousSecret) return [current];
  const previous = signingKey(previousSecret);
  return previous ? [current, previous] : null;
}

async function readBody(request: Request): Promise<Buffer | 400 | 413> {
  const contentLength = request.headers.get('content-length');
  if (contentLength !== null && !/^\d+$/.test(contentLength)) return 400;
  if (contentLength !== null && Number(contentLength) > MAX_BODY_BYTES) return 413;
  if (!request.body) return 400;
  const reader = request.body.getReader();
  const raw = Buffer.alloc(MAX_BODY_BYTES);
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (size + value.byteLength > MAX_BODY_BYTES) {
        void reader.cancel().catch(() => {});
        return 413;
      }
      raw.set(value, size);
      size += value.byteLength;
    }
  } catch {
    return 400;
  } finally {
    reader.releaseLock();
  }
  if (contentLength !== null && Number(contentLength) !== size) return 400;
  return raw.subarray(0, size);
}

type VerifiedWebhook = { event: z.infer<typeof eventSchema> } | { status: 400 | 401 | 413 | 415 };

export async function verifyDeadlineWebhook(
  request: Request, keys: readonly Buffer[], nowSeconds = Date.now() / 1000,
): Promise<VerifiedWebhook> {
  const contentType = request.headers.get('content-type');
  if (!contentType || !/^application\/json(?:;\s*charset\s*=\s*utf-8)?$/i.test(contentType)) return { status: 415 };
  const eventId = request.headers.get('webhook-id');
  const timestamp = request.headers.get('webhook-timestamp');
  const signatureHeader = request.headers.get('webhook-signature');
  if (!eventId || !UUID.test(eventId) || !timestamp || !/^\d{1,12}$/.test(timestamp) || !signatureHeader) {
    return { status: 400 };
  }
  if (signatureHeader.length > MAX_SIGNATURE_HEADER_BYTES) return { status: 413 };
  // Fetch folds repeated headers with commas. Only the comma inside an
  // individual versioned signature is valid.
  if (!/^v1,[A-Za-z0-9+/]{43}=(?: +v1,[A-Za-z0-9+/]{43}=)*$/.test(signatureHeader)) return { status: 400 };
  if (Math.abs(nowSeconds - Number(timestamp)) > 300) return { status: 401 };

  const raw = await readBody(request);
  if (typeof raw === 'number') return { status: raw };
  const signatures = signatureHeader.split(/ +/).map(value => decodeBase64(value.slice(3)));
  const matches = keys.some(key => {
    const expected = createHmac('sha256', key).update(`${eventId}.${timestamp}.`, 'ascii').update(raw).digest();
    return signatures.some(signature => signature !== null && timingSafeEqual(signature, expected));
  });
  if (!matches) return { status: 401 };

  try {
    const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(raw);
    const parsed = eventSchema.safeParse(JSON.parse(text));
    if (parsed.success && parsed.data.id === eventId) return { event: parsed.data };
  } catch {
    return { status: 400 };
  }
  return { status: 400 };
}
