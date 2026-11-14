import 'server-only';

import { airlinePnrs } from '@/lib/flights/airline-pnr';
import { supabaseAdmin } from '@/lib/supabase/server';

const SHAPON_DISPLAY_PNR_COLUMN = 'shapon_display_pnr';
export const SHAPON_DISPLAY_PNR_SELECT = `reservation_pnr:${SHAPON_DISPLAY_PNR_COLUMN}`;

export function shaponDisplayColumnMissing(error: { code: string; message: string }): boolean {
  return ['42703', 'PGRST204'].includes(error.code) &&
    error.message.includes(SHAPON_DISPLAY_PNR_COLUMN);
}

type DisplayLocators = { pnr: string; airlinePnrs: string[] };

export function supportsShaponDisplayLocators(row: {
  supplier: string;
  supplier_account: string | null;
  import_source: string | null;
  legacy_operational: boolean;
  direct_ticketing: boolean;
}): boolean {
  return row.supplier === 'shapontravels' && row.supplier_account === 'shapontravels' &&
    !row.import_source && !row.legacy_operational && !row.direct_ticketing;
}

/** Booking IDs come from an already authorized detail or report read. */
export async function readShaponDisplayLocators(bookingIds: string[]): Promise<Map<string, DisplayLocators>> {
  const locators = new Map<string, DisplayLocators>();
  if (!bookingIds.length) return locators;
  const supabase = supabaseAdmin();
  if (!supabase) throw new Error('Booking locator storage is unavailable.');
  const chunkSize = 100;
  for (let start = 0; start < bookingIds.length; start += chunkSize) {
    const { data, error } = await supabase
      .from('booking_dashboard_creator_v')
      .select(`id, ${SHAPON_DISPLAY_PNR_SELECT}, airline_pnr`)
      .in('id', bookingIds.slice(start, start + chunkSize))
      .not(SHAPON_DISPLAY_PNR_COLUMN, 'is', null);
    if (error) {
      if (start === 0 && shaponDisplayColumnMissing(error)) return locators;
      throw new Error('Booking locators could not be loaded.');
    }
    for (const row of data ?? []) {
      if (typeof row.reservation_pnr === 'string' && typeof row.airline_pnr === 'string') {
        locators.set(row.id, {
          pnr: row.reservation_pnr,
          airlinePnrs: airlinePnrs(row.airline_pnr.split(',')),
        });
      }
    }
  }
  return locators;
}

/** Keep real ticket numbers and aliases supported by the current airline locator. */
export function shaponTicketIdentifiersForDisplay(numbers: string[], airlineLocators: string[]): string[] {
  return numbers.filter(number => {
    if (/^[0-9]{10,16}$/.test(number)) return true;
    const locator = number.split('/')[0];
    return airlineLocators.includes(locator);
  });
}
