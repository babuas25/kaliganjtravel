import { notFound, redirect } from "next/navigation";

import ImpExpPage from "@/components/dashboard/impexp/ImpExpPage";
import { getDashboardSession } from "@/lib/dashboard/session";
import { canAccessImpExp } from "@/lib/impexp/access";

export const dynamic = "force-dynamic";

export default async function DashboardImpExpPage() {
  const session = await getDashboardSession();
  if (!session) redirect("/sign-in");
  if (!canAccessImpExp(session.role)) notFound();

  return <ImpExpPage />;
}
