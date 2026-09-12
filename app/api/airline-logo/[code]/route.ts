/** Serve the fixed airline asset through our origin so canvas exports can read it. */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ code: string }> }
) {
  const { code } = await params;
  if (!/^[A-Z0-9]{2,3}$/.test(code)) {
    return new Response('Invalid airline code', { status: 400 });
  }

  try {
    const response = await fetch(`https://images.kiwi.com/airlines/64x64/${code}.png`, {
      next: { revalidate: 604800 },
      signal: AbortSignal.timeout(5000),
      redirect: 'error',
    });
    if (!response.ok || !response.headers.get('content-type')?.startsWith('image/png')) {
      return new Response('Logo unavailable', { status: 404 });
    }
    const bytes = await response.arrayBuffer();
    if (bytes.byteLength > 100_000) {
      return new Response('Logo unavailable', { status: 502 });
    }
    return new Response(bytes, {
      headers: {
        'Content-Type': 'image/png',
        'Cache-Control': 'public, max-age=604800, stale-while-revalidate=86400',
        'X-Content-Type-Options': 'nosniff',
      },
    });
  } catch {
    return new Response('Logo unavailable', { status: 502 });
  }
}
