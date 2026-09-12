/** Immediate route feedback while the server loads the next 50-booking page. */
export default function BookingsLoading() {
  return (
    <div
      className="-mx-4 -mt-6 flex min-h-[34rem] flex-col bg-navy-50/60 sm:-mx-6 lg:-mx-8"
      aria-busy="true"
      aria-live="polite"
    >
      <span className="sr-only">Loading bookings</span>
      <div className="h-12 animate-pulse border-b border-neutral-200 bg-white" />
      <div className="h-10 animate-pulse border-b border-neutral-200 bg-white/90" />
      <div className="flex justify-end border-b border-neutral-200 bg-white px-4 py-3 sm:px-6 lg:px-8">
        <div className="h-8 w-72 max-w-full animate-pulse rounded-md bg-neutral-200" />
      </div>
      <div className="p-4 sm:p-6 lg:p-8">
        <div className="overflow-hidden rounded-xl border border-neutral-200 bg-white shadow-sm">
          <div className="h-10 animate-pulse border-b border-neutral-200 bg-navy-50" />
          {Array.from({ length: 8 }, (_, index) => (
            <div
              key={index}
              className="grid h-14 grid-cols-6 items-center gap-4 border-b border-neutral-100 px-4"
            >
              {Array.from({ length: 6 }, (_, column) => (
                <span
                  key={column}
                  className="h-3 animate-pulse rounded bg-neutral-200"
                />
              ))}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
