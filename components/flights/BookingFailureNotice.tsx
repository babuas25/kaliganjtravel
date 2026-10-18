import Link from 'next/link';
import type { DuplicateBookingWarning } from '@/lib/flights/booking-failure-message';

export default function BookingFailureNotice({
  message,
  warning,
}: {
  message: string;
  warning?: DuplicateBookingWarning | null;
}) {
  if (!warning) {
    return <p role="alert" className="rounded-lg bg-red-50 p-3 text-sm text-red-800 ring-1 ring-red-200">{message}</p>;
  }
  return (
    <div role="alert" className="rounded-lg bg-amber-50 p-4 text-sm text-amber-950 ring-1 ring-amber-200">
      <p className="font-semibold">{warning.title}</p>
      <p className="mt-2">{warning.message}</p>
      {warning.currentRequestReference && (
        <p className="mt-2 break-words">Current request reference: <strong>{warning.currentRequestReference}</strong></p>
      )}
      <Link href="/contact-us" className="mt-3 inline-flex rounded-lg border border-amber-400 px-3 py-2 font-semibold hover:bg-amber-100">
        Contact Support
      </Link>
    </div>
  );
}
