import { NextResponse } from 'next/server';
import { z } from 'zod';
import { ShapontravelsReadError, shapontravelsRead } from '@/lib/shapontravels/client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const directorySchema = z.object({
  items: z.array(z.object({
    code: z.string().regex(/^[A-Z0-9]{2}$/),
    name: z.string().min(1).max(120),
  }).strict()).max(500),
  total: z.number().int().nonnegative(),
}).strict().refine((value) => value.total === value.items.length);

type Directory = z.infer<typeof directorySchema>;
let cached: { value: Directory; expiresAt: number } | null = null;
let pending: Promise<Directory> | null = null;

function loadDirectory(): Promise<Directory> {
  if (cached && cached.expiresAt > Date.now()) return Promise.resolve(cached.value);
  if (!pending) {
    pending = shapontravelsRead('Airlines')
      .then((value) => directorySchema.parse(value))
      .then((value) => {
        cached = { value, expiresAt: Date.now() + 15 * 60_000 };
        return value;
      })
      .finally(() => { pending = null; });
  }
  return pending;
}

/** Public airline names and codes only. The machine credentials remain server-side. */
export async function GET() {
  try {
    return NextResponse.json(await loadDirectory(), {
      headers: { 'Cache-Control': 'public, max-age=900', 'X-Content-Type-Options': 'nosniff' },
    });
  } catch (error) {
    console.error('[airline-directory] lookup failed', error instanceof ShapontravelsReadError
      ? { code: error.code, status: error.status }
      : { code: 'INVALID_DIRECTORY_RESPONSE' });
    return NextResponse.json({ error: 'Airline directory unavailable.' }, {
      status: 503,
      headers: { 'Cache-Control': 'no-store' },
    });
  }
}
