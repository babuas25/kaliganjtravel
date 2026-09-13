'use client';

export default function BookingDetailsError({ reset }: { reset: () => void }) {
  return (
    <section role="alert" className="rounded-lg border bg-white p-6">
      <h1 className="text-xl font-semibold">Booking details could not be loaded</h1>
      <p className="mt-2 text-sm text-neutral-600">
        Please try loading this page again shortly. Do not create another booking.
      </p>
      <button type="button" onClick={reset} className="mt-4 rounded-md bg-brand-orange px-4 py-2 font-semibold text-black">
        Retry loading details
      </button>
    </section>
  );
}
