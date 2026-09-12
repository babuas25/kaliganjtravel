'use client';

import { CheckCircle2 } from 'lucide-react';
import { Fragment } from 'react';

const STEPS = ['Traveller details', 'Review', 'Confirm'] as const;

/**
 * The three-step rail above checkout.
 *
 * Takes an index rather than a form step name because the last step is not a
 * form at all: the booking details screen is driven by the booking's status,
 * and it still needs to light the rail the same way the first two steps do.
 */
export default function CheckoutStepper({
  activeIndex,
  complete = false,
}: {
  activeIndex: number;
  /** Ticks the active step too, for a step that has already finished. */
  complete?: boolean;
}) {
  return (
    <div className="rounded-lg bg-white p-4 ring-1 ring-neutral-200">
      <div className="flex w-full items-center justify-between">
        {STEPS.map((label, index) => {
          const reached = index <= activeIndex;
          const ticked = index < activeIndex || (complete && index === activeIndex);

          return (
            <Fragment key={label}>
              {index > 0 && (
                <div className="mx-1 mt-[-18px] h-0.5 flex-1 bg-neutral-200 sm:mx-4 sm:mt-[-24px]" />
              )}
              <div className="flex min-w-0 flex-1 flex-col items-center">
                <div
                  className={`mb-1 flex h-8 w-8 items-center justify-center rounded-lg text-xs font-semibold sm:mb-2 sm:h-10 sm:w-10 sm:text-base ${
                    reached
                      ? 'bg-brand-orange text-navy-950'
                      : 'bg-navy-50 text-neutral-500'
                  }`}
                >
                  {ticked ? (
                    <CheckCircle2 className="h-5 w-5" aria-hidden />
                  ) : (
                    index + 1
                  )}
                </div>
                <span
                  className={`truncate text-[10px] font-medium sm:text-xs ${
                    reached ? 'text-brand-orange-dark' : 'text-neutral-500'
                  }`}
                >
                  {label}
                </span>
              </div>
            </Fragment>
          );
        })}
      </div>
    </div>
  );
}
