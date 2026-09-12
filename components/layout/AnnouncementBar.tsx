'use client';

import { Sparkles, X } from 'lucide-react';
import { useState } from 'react';

type Props = {
  messages: readonly string[];
  durationSeconds: number;
};

export default function AnnouncementBar({ messages, durationSeconds }: Props) {
  const [closed, setClosed] = useState(false);
  if (closed || messages.length === 0) return null;

  return (
    <div className="relative flex items-center gap-3 overflow-hidden bg-brand-orange px-4 py-2 text-black">
      <div className="flex shrink-0 items-center gap-2 rounded-md bg-white/60 px-2.5 py-1 text-xs font-bold uppercase tracking-wide">
        <Sparkles className="h-3.5 w-3.5" />
        Hot
      </div>
      <div className="relative flex-1 overflow-hidden">
        <div
          className="ticker-track text-sm text-black/75"
          style={{ animationDuration: `${durationSeconds}s` }}
        >
          {[...messages, ...messages].map((m, i) => (
            <span key={i} className="mx-8 inline-flex items-center gap-2">
              <span className="h-1 w-1 rounded-full bg-brand-orange" />
              {m}
            </span>
          ))}
        </div>
      </div>
      <button
        onClick={() => setClosed(true)}
        aria-label="Dismiss"
        className="shrink-0 rounded p-1 text-black/75 hover:text-black"
      >
        <X className="h-4 w-4" />
      </button>
    </div>
  );
}
