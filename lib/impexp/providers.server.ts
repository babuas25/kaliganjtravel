import "server-only";

import { importNovoairManageBooking } from "@/lib/impexp/novoair-manage-booking.server";
import {
  importAirAstraManageBooking,
  importUsBanglaManageBooking,
} from "@/lib/impexp/ttinteractive-manage-booking.server";
import type { ImportProvider } from "@/lib/impexp/types";

type ImportInput = {
  provider: ImportProvider;
  orderReference: string;
  lastName?: string;
  sourceUrl?: string;
};

/**
 * Reads the airline's Manage Booking site directly in a server-side Chromium
 * session. No Tripfeels proxy or supplier-import API is involved.
 */
export async function retrieveImportBooking(
  input: ImportInput,
): Promise<unknown> {
  const reference = input.orderReference.trim().toUpperCase();
  const lastName = input.lastName?.trim().toUpperCase() ?? "";
  const sourceUrl = input.sourceUrl?.trim();
  if (!lastName) {
    throw new Error(
      "Passenger last name is required for airline Manage Booking imports.",
    );
  }
  const params = {
    reference,
    lastName,
    ...(sourceUrl ? { sourceUrl } : {}),
  };

  if (input.provider === "US_BANGLA") {
    return (await importUsBanglaManageBooking(params)).apiResponse;
  }
  if (input.provider === "AIR_ASTRA") {
    return (await importAirAstraManageBooking(params)).apiResponse;
  }
  return (await importNovoairManageBooking(params)).apiResponse;
}
