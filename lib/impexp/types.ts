import type {
  BookedItinerary,
  BookingPassengerType,
  BookingTraveller,
} from "@/lib/flights/booking";
import type { FareBreakdown } from "@/lib/flights/types";
import type {
  BookingStatus,
  StoredBookingStatus,
} from "@/lib/flights/booking-status";

export const IMPORT_PROVIDERS = ["US_BANGLA", "AIR_ASTRA", "NOVOAIR"] as const;

export type ImportProvider = (typeof IMPORT_PROVIDERS)[number];

export type ImportPassengerSupplement = {
  paxType: "ADT" | "CHD" | "INF";
  gender: "" | "Male" | "Female";
  birthdate: string;
  nationality: string;
  identityDocID: string;
  identityDocExpiry: string;
};

export type ImportedPassengerSnapshot = {
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

export type NormalizedBookingImport = {
  provider: ImportProvider;
  supplierReference: string;
  originalReference: string | null;
  orderStatus: string;
  /** The public seven-value Kaliganj Travels lifecycle resolved from the supplier. */
  lifecycleStatus: BookingStatus;
  /** The five-value physical database state used to represent that lifecycle. */
  storedStatus: StoredBookingStatus;
  currency: string;
  /** Supplier/reference gross. This is never the imported wallet debit. */
  totalPrice: number;
  passengerCounts: Partial<Record<BookingPassengerType, number>>;
  travelDate: string;
  itinerary: BookedItinerary;
  fares: FareBreakdown[];
  passengers: ImportedPassengerSnapshot;
  passportRequired: boolean;
  pnr: string;
  airlinesPnr: string[];
  ticketNumbers: string[];
  ticketingTimeLimit: string | null;
  ticketingDeadlineAt: string | null;
  importedAt: string;
  supplierMessage: string | null;
  /** Server-supplied Manage Booking lookup key retained for later Sync. */
  lookupLastName?: string;
};

export type ImpExpHistoryItem = {
  id: string;
  importedOn: string;
  referenceNo: string;
  supplierReference: string;
  provider: string;
  source?: "IMP_EXP" | "MANUAL" | "SUPPLIER_API";
  status: BookingStatus;
  paxName: string;
  assigned: string;
  supplierGross: number;
  userPayable: number;
  paymentState: string;
  currency: string;
};

export type ImpExpBookingPreview = {
  provider: ImportProvider;
  supplierReference: string;
  originalReference: string | null;
  status: BookingStatus;
  orderStatus: string;
  currency: string;
  supplierGross: number;
  passengerCount: number;
  route: string;
};

export type ImpExpAssignableUser = {
  id: string;
  role: "b2b" | "b2b_sub" | "customer";
  name: string;
  email: string;
  /** Agency code is the public B2B agency ID shown to staff. */
  agencyId: string | null;
  agencyName: string | null;
};
