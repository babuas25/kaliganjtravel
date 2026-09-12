import 'server-only';

type BulkSmsBdConfig = {
  apiKey: string;
  senderId: string;
  endpoint: string;
};

export type SmsSendResult = { providerMessageId: string | null };

function config(): BulkSmsBdConfig {
  const apiKey = process.env.BULKSMSBD_API_KEY?.trim();
  const senderId = process.env.BULKSMSBD_SENDER_ID?.trim();
  const endpointValue = process.env.BULKSMSBD_API_URL?.trim()
    || 'https://bulksmsbd.net/api/smsapi';
  if (!apiKey || !senderId) {
    throw new Error(
      'SMS is not configured. Set BULKSMSBD_API_KEY and BULKSMSBD_SENDER_ID.'
    );
  }
  let endpoint: URL;
  try {
    endpoint = new URL(endpointValue);
  } catch {
    throw new Error('BULKSMSBD_API_URL must be a valid HTTPS URL.');
  }
  if (endpoint.protocol !== 'https:') {
    throw new Error('BULKSMSBD_API_URL must use HTTPS.');
  }
  return { apiKey, senderId, endpoint: endpoint.toString() };
}
function responseRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function responseCode(value: unknown): string | null {
  if (typeof value === 'number' || typeof value === 'string') {
    const match = /(?:^|\D)(\d{3,4})(?:\D|$)/.exec(String(value));
    return match?.[1] ?? null;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const code = responseCode(item);
      if (code) return code;
    }
    return null;
  }
  const object = responseRecord(value);
  if (!object) return null;
  for (const key of ['response_code', 'responseCode', 'code', 'status']) {
    if (key in object) {
      const code = responseCode(object[key]);
      if (code) return code;
    }
  }
  return null;
}

function providerMessageId(value: unknown): string | null {
  const object = Array.isArray(value) ? responseRecord(value[0]) : responseRecord(value);
  if (!object) return null;
  for (const key of ['message_id', 'messageId', 'request_id', 'requestId', 'id']) {
    const result = object[key];
    if (typeof result === 'string' || typeof result === 'number') {
      return String(result).slice(0, 500);
    }
  }
  return null;
}

/** Sends one text SMS. Durable retries and de-duplication live in the DB worker. */
export async function sendBulkSmsBdText(input: {
  to: string;
  message: string;
}): Promise<SmsSendResult> {
  if (!/^[1-9][0-9]{7,14}$/.test(input.to)) {
    throw new Error('Refusing to send SMS to an invalid number.');
  }
  if (!input.message.trim()) throw new Error('Refusing to send an empty SMS.');
  const settings = config();
  const body = new URLSearchParams({
    api_key: settings.apiKey,
    type: 'text',
    number: input.to,
    senderid: settings.senderId,
    message: input.message,
  });
  const response = await fetch(settings.endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
    body,
    cache: 'no-store',
    signal: AbortSignal.timeout(20_000),
  });
  const responseText = (await response.text()).slice(0, 2_000);
  let payload: unknown = responseText;
  try {
    payload = JSON.parse(responseText);
  } catch {
    // BulkSMSBD installations also return a plain numeric response code.
  }
  const code = responseCode(payload);
  if (!response.ok || code !== '202') {
    throw new Error(
      `BulkSMSBD rejected the SMS${code ? ` (code ${code})` : ''}.`
    );
  }
  return { providerMessageId: providerMessageId(payload) };
}
