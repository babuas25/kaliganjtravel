import { NextRequest, NextResponse } from "next/server";

import { getDashboardSession } from "@/lib/dashboard/session";
import { listImpExpAssignableUsers } from "@/lib/db/impexp";
import { canAccessImpExp, IMPEXP_ASSIGNABLE_ROLES } from "@/lib/impexp/access";
import type { Role } from "@/lib/roles";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
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

  const role = request.nextUrl.searchParams.get("role") as Role | null;
  if (!role || !IMPEXP_ASSIGNABLE_ROLES.includes(role)) {
    return NextResponse.json(
      { error: "Choose B2B, Sub User, or Customer." },
      { status: 400 },
    );
  }
  try {
    return NextResponse.json({ users: await listImpExpAssignableUsers(role) });
  } catch (error) {
    console.error("[impexp] assignable user lookup failed:", error);
    return NextResponse.json(
      {
        error:
          error instanceof Error ? error.message : "Users could not be loaded.",
      },
      { status: 503 },
    );
  }
}
