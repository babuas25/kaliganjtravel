import { NextResponse } from 'next/server';
import { getDashboardSession } from '@/lib/dashboard/session';
import { getPromotionalPopup } from '@/lib/db/promotional-popup';
export const dynamic = 'force-dynamic';
export async function GET() {
  const session = await getDashboardSession();
  if (!session) return new NextResponse(null, { status: 401 });
  const state = await getPromotionalPopup();
  return NextResponse.json({ enabled: state.enabled && (state.display.audience === 'all' || session.role === 'b2b' || session.role === 'b2b_sub'), display: state.display, autoCloseSeconds: state.autoCloseSeconds, slides: state.slides.filter((slide) => slide.active) }, { headers: { 'Cache-Control': 'private, no-store' } });
}
