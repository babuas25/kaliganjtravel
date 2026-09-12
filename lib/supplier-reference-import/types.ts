import type {
  BookedItinerary,
  BookingPassengerType,
  BookingTraveller,
  PrivateBookingRefs,
} from '@/lib/flights/booking';
import type { FareBreakdown } from '@/lib/flights/types';
import type {
  PricingSnapshot,
  SupplierFarePricing,
} from '@/lib/markup';
import type { TriploverReferenceImportSupplier } from '@/lib/triplover/config';

export type SupplierReferenceLifecycle = 'on-hold' | 'confirmed' | 'cancelled';

/** Strict, unpriced supplier evidence. It never crosses the browser boundary. */
export type SupplierReferenceEvidence = {
  supplierAccount: TriploverReferenceImportSupplier;
  supplierReference: string;
  supplierStatus: string;
  lifecycleStatus: SupplierReferenceLifecycle;
  storedStatus: SupplierReferenceLifecycle;
  currency: string;
  supplierPayable: number;
  supplierGross: number;
  supplierDiscount: number;
  passengerCounts: Partial<Record<BookingPassengerType, number>>;
  travelDate: string;
  itinerary: BookedItinerary;
  supplierFares: SupplierFarePricing[];
  passengers: {
    travellers: BookingTraveller[];
    contact: {
      phone: string;
      phoneCountryCode: string;
      customerEmail: string;
      email: string;
      countryCode: string;
      cityName: string;
    };
  };
  passportRequired: boolean;
  supplierRefs: PrivateBookingRefs;
  bookingCodeRef: string;
  ticketCodeRef: string | null;
  pnr: string;
  bookingRefNumber: string;
  airlinesPnr: string[];
  ticketNumbers: string[];
  ticketingTimeLimit: string | null;
  ticketingDeadlineAt: string | null;
  bookedAt: string | null;
  issuedAt: string | null;
  cancelledAt: string | null;
  directTicketing: boolean;
  supplierBookingId: number | null;
  supplierMessage: string | null;
  retrievedAt: string;
};

/** Canonically-priced snapshot used by the atomic supplier-reference writer. */
export type SupplierReferenceBooking = SupplierReferenceEvidence & {
  fares: FareBreakdown[];
  pricingSnapshot: PricingSnapshot;
  pricingMode: 'import_time_current_markup';
  pricingCalculatedAt: string;
  supplierEvidenceTimestamp: string;
  pricingCarrierCode: string;
  pricingRoutes: Array<{
    origin: string;
    destination: string;
    departureDate: string;
  }>;
};

export type SupplierReferenceBookingPreview = {
  supplierAccount: TriploverReferenceImportSupplier;
  supplierReference: string;
  supplierStatus: string;
  status: SupplierReferenceLifecycle;
  currency: string;
  supplierPayable: number;
  supplierGross: number;
  userPayable: number;
  pricingMode: 'import_time_current_markup';
  pricingCalculatedAt: string;
  pricingConfirmation: string;
  passengerCount: number;
  route: string;
  airline: string;
  pnr: string;
  airlinesPnr: string[];
  ticketCount: number;
  travelDate: string;
  ticketingDeadlineAt: string | null;
  walletChargeAllowed: boolean;
};

export type SupplierReferenceImportDecision =
  | 'import_only'
  | 'import_and_charge';

export type SupplierReferenceImportResult = {
  ok: boolean;
  code?: string;
  booking?: import('@/lib/db/flight-bookings').BookingRow;
  replay?: boolean;
  walletCharged?: boolean;
  amount?: number;
  currency?: string;
  accountId?: string | null;
  importDecision?: SupplierReferenceImportDecision;
  available?: number;
  required?: number;
};
