import type { TriploverReferenceImportSupplier } from "@/lib/triplover/config";

export const SUPPLIER_REFERENCE_IDENTITIES: Record<
  TriploverReferenceImportSupplier,
  { label: string; prefix: "FST" | "TOT" | "TLL" }
> = {
  firsttrip: { label: "FirstTrip", prefix: "FST" },
  takeoff: { label: "TakeOff", prefix: "TOT" },
  triplover: { label: "Triplover", prefix: "TLL" },
};

export function supplierReferenceMatchesAccount(
  supplier: TriploverReferenceImportSupplier,
  supplierReference: string,
): boolean {
  const { prefix } = SUPPLIER_REFERENCE_IDENTITIES[supplier];
  return new RegExp(`^${prefix}\\d{18}$`).test(supplierReference);
}
