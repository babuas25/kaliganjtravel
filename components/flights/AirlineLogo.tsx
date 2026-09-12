'use client';

import { Plane } from 'lucide-react';
import { useEffect, useState } from 'react';

export default function AirlineLogo({
  airlineCode,
  className = '',
  size = 24,
}: {
  airlineCode: string;
  className?: string;
  size?: number;
}) {
  const [imageFailed, setImageFailed] = useState(false);

  useEffect(() => {
    setImageFailed(false);
  }, [airlineCode]);

  const wrapperClassName = `inline-flex shrink-0 items-center justify-center overflow-hidden rounded ${className}`;
  const wrapperStyle = { width: size, height: size };

  if (imageFailed) {
    return (
      <span
        aria-hidden
        className={`${wrapperClassName} bg-neutral-100 text-neutral-400`}
        style={wrapperStyle}
      >
        <Plane className="h-1/2 w-1/2" />
      </span>
    );
  }

  return (
    <span className={wrapperClassName} style={wrapperStyle}>
      {/* Same-origin assets remain readable when the flight card is exported to PNG. */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={`/api/airline-logo/${encodeURIComponent(airlineCode)}`}
        alt=""
        width={size}
        height={size}
        className="h-full w-full object-contain"
        onError={() => setImageFailed(true)}
      />
    </span>
  );
}
