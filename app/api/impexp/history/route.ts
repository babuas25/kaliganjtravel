import { NextResponse } from "next/server";

import { getDashboardSession } from "@/lib/dashboard/session";
import { listImpExpHistory } from "@/lib/db/impexp";
import { canAccessImpExp } from "@/lib/impexp/access";

export const dynamic = "force-dynamic";

export async function GET() {
  const session = await getDashboardSession();
  if (!session) {
    return NextResponse.json(
      { error: "Authentication required." },
      { status: 401 },
    );
  }
  if (!canAccessImpExp(session.role)) {
    return NextResponse.json(
      { error: "IMP/EXP access is forbidden." },
      { status: 403 },
    );
  }
  try {
    return NextResponse.json({ history: await listImpExpHistory() });
  } catch (error) {
    console.error("[impexp] history lookup failed:", error);
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Import history could not be loaded.",
      },
      { status: 503 },
    );
  }
}
