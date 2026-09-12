'use client';


const deadlineFormatter = new Intl.DateTimeFormat('en-GB', {
  day: 'numeric', month: 'short', year: 'numeric',
  hour: '2-digit', minute: '2-digit', hour12: false,
  timeZone: 'Asia/Dhaka',
});

export function BookingDeadlineNotice({
  deadline,
}: { deadline: string | null; bookingReference: string }) {
  const instant = deadline ? Date.parse(deadline) : Number.NaN;
  const hasDeadline = Number.isFinite(instant);


  return (
    <p className="print-hide-expiration mt-2 text-[11px] font-medium leading-4 text-inherit">
      {hasDeadline
        ? `Issue before: ${deadlineFormatter.format(new Date(instant))} (Bangladesh time).`
        : 'Awaiting the supplier’s ticketing time limit.'}
    </p>
  );
}
