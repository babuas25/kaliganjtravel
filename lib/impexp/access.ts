import type { Role } from "@/lib/roles";

export const IMPEXP_ROLES: readonly Role[] = [
  "superadmin",
  "admin",
  "staff_support",
];

export function canAccessImpExp(role: Role): boolean {
  return IMPEXP_ROLES.includes(role);
}

export const IMPEXP_ASSIGNABLE_ROLES: readonly Role[] = [
  "b2b",
  "b2b_sub",
  "customer",
];
