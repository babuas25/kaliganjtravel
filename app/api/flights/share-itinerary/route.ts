import { z } from 'zod';
import { itineraryOfferSchema } from '@/lib/flights/share-offer';
import { itineraryOfferEmail } from '@/lib/email/itinerary-offer';
import { getDashboardSession } from '@/lib/dashboard/session';
import { sendEmail } from '@/lib/email/mailer';
import { sendBulkSmsBdText } from '@/lib/sms/bulksmsbd';
import { checkActionLimit, checkB2bItinerarySmsDailyLimit, rateLimitMessage } from '@/lib/rate-limit';
import { walletFail, walletOk } from '@/lib/wallet/http';

export const runtime = 'nodejs';
export const maxDuration = 60;

const schema = z.object({
  offer: itineraryOfferSchema.optional(),
  channel: z.enum(['email', 'sms']),
  recipient: z.string().trim().min(1).max(254),
  subject: z.string().trim().min(1).max(200).regex(/^[^\r\n]+$/),
  message: z.string().trim().min(1).max(2000),
}).strict();

export async function POST(request: Request) {
  const session = await getDashboardSession();
  if (!session) return walletFail(401, 'SIGN_IN_REQUIRED', 'Please sign in to send an itinerary.');
  if (session.role === 'staff_media') return walletFail(403, 'SHARE_FORBIDDEN', 'Itinerary sending is unavailable for this role.');
  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return walletFail(400, 'INVALID_REQUEST', 'Enter a valid recipient and itinerary.');
  const { channel, subject, message } = parsed.data;
  let recipient = parsed.data.recipient;
  if (channel === 'email') {
    if (!z.string().email().safeParse(recipient).success) return walletFail(400, 'INVALID_EMAIL', 'Enter a valid email address.');
  } else {
    if (!/^[+\d\s()-]+$/.test(recipient)) return walletFail(400, 'INVALID_PHONE', 'Enter a valid mobile number.');
    recipient = recipient.replace(/[\s()-]/g, '').replace(/^\+/, '').replace(/^00/, '');
    if (/^01[3-9]\d{8}$/.test(recipient)) recipient = `88${recipient}`;
    if (!/^[1-9]\d{7,14}$/.test(recipient)) return walletFail(400, 'INVALID_PHONE', 'Enter a mobile number with its country code, such as +8801712345678.');
  }
  const limit = await checkActionLimit('itineraryShare', `user:${session.clerkId}`);
  if (!limit.ok) return walletFail(429, 'RATE_LIMITED', rateLimitMessage(limit.retryAfterSeconds));
  if (channel === 'sms' && (session.role === 'b2b' || session.role === 'b2b_sub')) {
    const dailyLimit = await checkB2bItinerarySmsDailyLimit(session.clerkId);
    if (!dailyLimit.ok) {
      return walletFail(429, 'DAILY_SMS_LIMIT', 'B2B users can send up to 5 itinerary SMS per day. Please try again after midnight (Bangladesh time).');
    }
  }
  try {
    if (channel === 'sms') {
      await sendBulkSmsBdText({ to: recipient, message });
    } else {
      await sendEmail({ to: recipient, subject, text: message, html: itineraryOfferEmail(parsed.data.offer, message) });
    }
    return walletOk({ sent: true });
  } catch {
    return walletFail(503, 'SEND_UNCONFIRMED', `We could not confirm the ${channel === 'sms' ? 'SMS' : 'email'} was sent. Check before trying again.`);
  }
}
