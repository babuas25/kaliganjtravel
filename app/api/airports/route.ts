import { NextRequest, NextResponse } from 'next/server';

import { searchAirports } from '@/lib/airports/search';

// The dataset is static, so the answer for a given query never changes —
// let the CDN keep it and serve stale copies while it revalidates.
const AIRPORT_CACHE_CONTROL =
  'public, max-age=300, s-maxage=86400, stale-while-revalidate=604800';

export async function GET(request: NextRequest) {
  const query = request.nextUrl.searchParams.get('q')?.trim() ?? '';
  const requestedLimit = Number(request.nextUrl.searchParams.get('limit') ?? '80');
  const limit = Number.isFinite(requestedLimit)
    ? Math.min(100, Math.max(1, Math.trunc(requestedLimit)))
    : 80;

  if (query.length > 100) {
    return NextResponse.json(
      {
        success: false,
        error: {
          errorCode: 'INVALID_QUERY',
          errorMessage: 'Airport search cannot exceed 100 characters.',
        },
      },
      { status: 400 }
    );
  }

  try {
    const items = searchAirports(query, limit);
    return NextResponse.json(
      { success: true, data: { items } },
      { headers: { 'Cache-Control': AIRPORT_CACHE_CONTROL } }
    );
  } catch (error) {
    console.error('Airport search error:', error);
    return NextResponse.json(
      {
        success: false,
        error: {
          errorCode: 'AIRPORT_SEARCH_FAILED',
          errorMessage: 'Airport search is unavailable.',
        },
      },
      { status: 500 }
    );
  }
}
