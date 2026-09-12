'use client';

import { addDays, format, isBefore, isValid, parseISO, startOfDay } from 'date-fns';
import { CalendarDays, ChevronLeft, ChevronRight } from 'lucide-react';
import { useMemo, useState } from 'react';

import { Calendar } from '@/components/ui/calendar';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';

function parseDate(value: string): Date | undefined {
  const parsed = parseISO(value);
  return isValid(parsed) ? parsed : undefined;
}

function toIsoDate(value: Date): string {
  return format(value, 'yyyy-MM-dd');
}

export default function ResultsDateNavigator({
  value,
  onChange,
  disabled = false,
}: {
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
}) {
  const [calendarOpen, setCalendarOpen] = useState(false);
  const selectedDate = useMemo(() => parseDate(value), [value]);
  const today = startOfDay(new Date());
  const previousDisabled =
    disabled || !selectedDate || !isBefore(today, startOfDay(selectedDate));

  const shiftDate = (days: number) => {
    if (!selectedDate || disabled) return;
    onChange(toIsoDate(addDays(selectedDate, days)));
  };

  return (
    <div className="grid h-11 grid-cols-[1fr_auto_1fr] items-stretch overflow-hidden rounded-lg bg-white shadow-sm ring-1 ring-neutral-200">
      <button
        type="button"
        disabled={previousDisabled}
        onClick={() => shiftDate(-1)}
        className="flex min-w-0 items-center justify-start gap-1.5 border-r border-neutral-200 px-3 text-xs font-semibold text-navy-950 transition hover:bg-neutral-50 disabled:cursor-not-allowed disabled:text-neutral-300"
      >
        <ChevronLeft className="h-4 w-4 shrink-0" aria-hidden />
        <span className="truncate">Previous Day</span>
      </button>

      <Popover open={calendarOpen} onOpenChange={setCalendarOpen}>
        <PopoverTrigger asChild>
          <button
            type="button"
            disabled={disabled || !selectedDate}
            aria-label="Choose flight date"
            className="flex min-w-[150px] items-center justify-center gap-2 px-4 text-sm font-bold text-navy-950 transition hover:bg-brand-orange-light hover:text-brand-orange-dark disabled:cursor-not-allowed disabled:opacity-50"
          >
            <CalendarDays className="h-4 w-4 shrink-0 text-brand-orange" aria-hidden />
            <span>{selectedDate ? format(selectedDate, 'dd MMM yyyy') : 'Choose date'}</span>
          </button>
        </PopoverTrigger>
        <PopoverContent
          align="center"
          sideOffset={8}
          className="w-auto border-neutral-200 bg-white p-0"
        >
          <Calendar
            mode="single"
            selected={selectedDate}
            defaultMonth={selectedDate}
            disabled={(date) => isBefore(startOfDay(date), today)}
            onSelect={(date) => {
              if (!date) return;
              onChange(toIsoDate(date));
              setCalendarOpen(false);
            }}
            classNames={{
              day_selected:
                'bg-brand-orange text-navy-950 hover:bg-brand-orange hover:text-navy-950 focus:bg-brand-orange focus:text-navy-950',
              day_today: 'bg-brand-orange-light font-bold text-brand-orange-dark',
            }}
          />
        </PopoverContent>
      </Popover>

      <button
        type="button"
        disabled={disabled || !selectedDate}
        onClick={() => shiftDate(1)}
        className="flex min-w-0 items-center justify-end gap-1.5 border-l border-neutral-200 px-3 text-xs font-semibold text-navy-950 transition hover:bg-neutral-50 disabled:cursor-not-allowed disabled:text-neutral-300"
      >
        <span className="truncate">Next Day</span>
        <ChevronRight className="h-4 w-4 shrink-0" aria-hidden />
      </button>
    </div>
  );
}
