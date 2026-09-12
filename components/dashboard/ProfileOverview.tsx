import { format, isValid, parseISO } from 'date-fns';
import {
  CalendarDays,
  Home,
  Mail,
  Phone,
  ShieldCheck,
  type LucideIcon,
} from 'lucide-react';

import { cn } from '@/lib/utils';
import type { ProfileValues } from '@/lib/profile';

const ROWS: { field: keyof ProfileValues; label: string; icon: LucideIcon }[] = [
  { field: 'email', label: 'Email', icon: Mail },
  { field: 'mobile', label: 'Mobile', icon: Phone },
  { field: 'dateOfBirth', label: 'Date of birth', icon: CalendarDays },
  { field: 'address', label: 'Address', icon: Home },
];

function readable(field: keyof ProfileValues, value: string) {
  const trimmed = value.trim();
  if (!trimmed) return null;

  if (field === 'dateOfBirth') {
    const parsed = parseISO(trimmed);
    return isValid(parsed) ? format(parsed, 'd MMM yyyy') : trimmed;
  }

  return trimmed;
}

interface Props {
  values: ProfileValues;
  filled: number;
  total: number;
  percent: number;
}

/** Sidebar card: the essentials at a glance plus a completion meter. */
export default function ProfileOverview({
  values,
  filled,
  total,
  percent,
}: Props) {
  const complete = filled === total;

  return (
    <div className="overflow-hidden rounded-lg border border-navy-100 bg-white">
      <header className="flex items-start gap-3 border-b border-navy-100 px-5 py-4">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-brand-orange-light text-brand-orange-dark">
          <ShieldCheck className="h-4 w-4" />
        </span>
        <div className="min-w-0">
          <h3 className="text-sm font-semibold text-navy-950">
            Account overview
          </h3>
          <p className="mt-0.5 text-xs text-navy-700/70">
            Current profile summary
          </p>
        </div>
      </header>

      <dl className="divide-y divide-navy-100">
        {ROWS.map(({ field, label, icon: Icon }) => {
          const value = readable(field, values[field]);

          return (
            <div key={field} className="px-5 py-3.5">
              <dt className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wide text-navy-700/60">
                <Icon className="h-3.5 w-3.5" />
                {label}
              </dt>
              <dd
                className={cn(
                  'mt-1 break-words text-sm',
                  value
                    ? 'font-semibold text-navy-950'
                    : 'font-medium text-navy-700/50'
                )}
              >
                {value ?? 'Not set'}
              </dd>
            </div>
          );
        })}
      </dl>

      <div className="border-t border-navy-100 px-5 py-4">
        <div className="flex items-baseline justify-between">
          <p className="text-sm font-medium text-navy-950">Profile complete</p>
          <p className="text-sm font-bold text-navy-950">{percent}%</p>
        </div>

        <div
          className="mt-2 h-1.5 overflow-hidden rounded-full bg-navy-100"
          role="progressbar"
          aria-valuenow={filled}
          aria-valuemin={0}
          aria-valuemax={total}
          aria-label="Profile completion"
        >
          <div
            className={cn(
              'h-full rounded-full transition-all duration-300',
              complete ? 'bg-emerald-500' : 'bg-brand-orange'
            )}
            style={{ width: `${percent}%` }}
          />
        </div>

        <p className="mt-2 text-xs text-navy-700/60">
          {complete
            ? 'Every detail is filled in.'
            : `${total - filled} of ${total} still blank — none are required.`}
        </p>
      </div>
    </div>
  );
}
