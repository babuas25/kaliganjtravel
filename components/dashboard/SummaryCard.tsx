import { ArrowDownRight, ArrowUpRight } from 'lucide-react';

import { cn } from '@/lib/utils';
import { TILE_META, type TileKey } from '@/lib/roles';

interface Props {
  tileKey: TileKey;
  value: number;
  delta?: number;
}

export default function SummaryCard({ tileKey, value, delta }: Props) {
  const { label, icon: Icon, hint } = TILE_META[tileKey];
  const up = (delta ?? 0) >= 0;
  const DeltaIcon = up ? ArrowUpRight : ArrowDownRight;

  return (
    <div className="rounded-lg border border-navy-100 bg-white p-5 shadow-sm transition hover:border-navy-200 hover:shadow-md">
      <div className="flex items-start justify-between gap-3">
        <p className="text-sm font-medium text-navy-700">{label}</p>
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-navy-50 text-navy-700">
          <Icon className="h-4 w-4" />
        </span>
      </div>

      <p className="mt-4 text-3xl font-bold tracking-tight text-navy-950">
        {value.toLocaleString('en-US')}
      </p>

      <div className="mt-2 flex items-center gap-2">
        {delta !== undefined && (
          <span
            className={cn(
              'inline-flex items-center gap-0.5 rounded-full px-1.5 py-0.5 text-xs font-semibold',
              up
                ? 'bg-emerald-50 text-emerald-700'
                : 'bg-brand-orange-light text-brand-orange-dark'
            )}
          >
            <DeltaIcon className="h-3 w-3" />
            {Math.abs(delta)}%
          </span>
        )}
        <span className="truncate text-xs text-navy-700/60">{hint}</span>
      </div>
    </div>
  );
}
