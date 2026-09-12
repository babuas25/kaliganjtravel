'use client';

import { CalendarDays, Clock } from 'lucide-react';
import { useState } from 'react';

import { Button } from '@/components/ui/button';
import { Calendar } from '@/components/ui/calendar';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';

type ParsedDateTime = {
  date: Date;
  hour: string;
  minute: string;
};

const HOURS = Array.from({ length: 24 }, (_, hour) =>
  String(hour).padStart(2, '0'),
);
const MINUTES = Array.from({ length: 60 }, (_, minute) =>
  String(minute).padStart(2, '0'),
);

function parseDateTime(value: string): ParsedDateTime | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(value);
  if (!match) return null;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const date = new Date(year, month - 1, day);
  if (
    date.getFullYear() !== year ||
    date.getMonth() !== month - 1 ||
    date.getDate() !== day ||
    hour > 23 ||
    minute > 59
  ) {
    return null;
  }

  return {
    date,
    hour: String(hour).padStart(2, '0'),
    minute: String(minute).padStart(2, '0'),
  };
}

function datePart(date: Date): string {
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
}

function displayValue(value: string): string {
  const parsed = parseDateTime(value);
  if (!parsed) return '';
  const date = new Intl.DateTimeFormat('en-GB', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  }).format(parsed.date);
  return `${date}, ${parsed.hour}:${parsed.minute}`;
}

export default function ManualDateTimeField({
  value,
  onChange,
  ariaLabel,
}: {
  value: string;
  onChange: (value: string) => void;
  ariaLabel: string;
}) {
  const [open, setOpen] = useState(false);
  const [draftDate, setDraftDate] = useState<Date>();
  const [draftHour, setDraftHour] = useState('');
  const [draftMinute, setDraftMinute] = useState('');
  const displayed = displayValue(value);

  function handleOpenChange(nextOpen: boolean) {
    if (nextOpen) {
      const parsed = parseDateTime(value);
      setDraftDate(parsed?.date ?? new Date());
      setDraftHour(parsed?.hour ?? '');
      setDraftMinute(parsed?.minute ?? '');
    }
    setOpen(nextOpen);
  }

  function commit(date: Date | undefined, hour: string, minute: string) {
    if (!date || !hour || !minute) return;
    onChange(`${datePart(date)}T${hour}:${minute}`);
  }

  const selectClassName =
    'h-10 min-w-0 flex-1 rounded-md border border-input bg-white px-3 text-sm text-navy-950 focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2';

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={ariaLabel}
          aria-expanded={open}
          className="flex h-10 w-full min-w-0 items-center gap-2 rounded-md border border-input bg-background px-3 py-2 text-left text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
        >
          <CalendarDays className="h-4 w-4 shrink-0 text-neutral-500" aria-hidden />
          <span className={`min-w-0 flex-1 truncate ${displayed ? 'text-navy-950' : 'text-muted-foreground'}`}>
            {displayed || 'Select date and time'}
          </span>
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        collisionPadding={8}
        className="max-h-[calc(100vh-1rem)] w-[calc(100vw-1rem)] max-w-[20rem] overflow-y-auto border-neutral-200 p-0 sm:w-auto"
      >
        <Calendar
          mode="single"
          selected={draftDate}
          onSelect={(date) => {
            setDraftDate(date);
            commit(date, draftHour, draftMinute);
          }}
          initialFocus
        />
        <div className="sticky bottom-0 border-t border-neutral-200 bg-white p-3">
          <div className="mb-2 flex items-center gap-2 text-xs font-semibold text-neutral-700">
            <Clock className="h-4 w-4 text-brand-orange" aria-hidden />
            Time (24-hour)
          </div>
          <div className="flex items-center gap-2">
            <select
              aria-label={`${ariaLabel} hour`}
              value={draftHour}
              onChange={(event) => {
                const hour = event.target.value;
                setDraftHour(hour);
                commit(draftDate, hour, draftMinute);
              }}
              className={selectClassName}
            >
              <option value="">Hour</option>
              {HOURS.map((hour) => <option key={hour} value={hour}>{hour}</option>)}
            </select>
            <span className="font-bold text-neutral-500">:</span>
            <select
              aria-label={`${ariaLabel} minute`}
              value={draftMinute}
              onChange={(event) => {
                const minute = event.target.value;
                setDraftMinute(minute);
                commit(draftDate, draftHour, minute);
              }}
              className={selectClassName}
            >
              <option value="">Minute</option>
              {MINUTES.map((minute) => <option key={minute} value={minute}>{minute}</option>)}
            </select>
          </div>
          <div className="mt-3 flex justify-end">
            <Button
              type="button"
              size="sm"
              disabled={!draftDate || !draftHour || !draftMinute}
              onClick={() => setOpen(false)}
              className="bg-brand-orange text-navy-950 hover:bg-brand-orange-dark hover:text-white"
            >
              Done
            </Button>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}
