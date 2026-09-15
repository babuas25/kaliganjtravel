import { z } from "zod";
import { BOOKING_CURRENCY, UNSUPPORTED_CURRENCY_MESSAGE } from '@/lib/currency';

const money = z
  .string()
  .trim()
  .regex(/^(?:\d{1,12}|\d{1,3}(?:,\d{3}){1,3})(?:\.\d{1,2})?$/, "Use an amount with up to two decimals.")
  .transform((value) => value.replaceAll(",", ""));

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use a valid date.");
const dateTime = z.string().datetime({ offset: true });
const code = z.string().trim().min(2).max(12).transform((value) => value.toUpperCase());
const flightDuration = z
  .string()
  .trim()
  .regex(/^(?:\d{1,3}:[0-5]\d|\d+\s*h(?:\s*\d+\s*m)?|\d+\s*m)$/i, "Use a duration such as 4h 5m or 04:05.");
const baggageAllowance = z.string().trim().min(1).max(120);
const terminal = z.string().trim().max(80).optional().or(z.literal(""));

const travellerSchema = z.object({
  passengerType: z.enum(["ADT", "CHD", "CNN", "INF", "INS"]),
  title: z.enum(["Mr", "Mrs", "Ms", "Mstr", "Miss"]),
  firstName: z.string().trim().min(1).max(100),
  lastName: z.string().trim().min(1).max(100),
  gender: z.enum(["Male", "Female"]),
  dateOfBirth: date,
  nationality: z.string().trim().regex(/^[A-Za-z]{2,3}$/),
  passportNumber: z.string().trim().max(100).optional().or(z.literal("")),
  passportExpiry: z.string().trim().max(20).optional().or(z.literal("")),
});

const segmentSchema = z.object({
  leg: z.number().int().min(1).max(20),
  carrierCode: code,
  carrierName: z.string().trim().min(1).max(100),
  flightNumber: z.string().trim().min(1).max(20),
  from: z.object({ code, city: z.string().trim().min(1).max(100), airport: z.string().trim().max(150).optional().or(z.literal("")), terminal }),
  to: z.object({ code, city: z.string().trim().min(1).max(100), airport: z.string().trim().max(150).optional().or(z.literal("")), terminal }),
  departureAt: dateTime,
  arrivalAt: dateTime,
  duration: flightDuration,
  cabin: z.string().trim().min(1).max(50),
  bookingClass: z.string().trim().min(1).max(20),
  baggage: baggageAllowance,
  handBaggage: baggageAllowance,
  aircraft: z.string().trim().min(1).max(100),
});

const fareSchema = z.object({
  passengerType: z.enum(["ADT", "CHD", "CNN", "INF", "INS"]),
  basePrice: money,
  taxes: money,
  ait: money,
  serviceMargin: money,
  totalPrice: money,
});

const commonSchema = z.object({
  assignedToUserId: z.string().trim().min(1).max(255),
  externalReference: z.string().trim().min(2).max(120),
  pnr: z.string().trim().min(2).max(120),
  airlinePnr: z.string().trim().min(2).max(120),
  currency: z.string().trim().toUpperCase()
    .refine((value) => value === BOOKING_CURRENCY, UNSUPPORTED_CURRENCY_MESSAGE)
    .transform(() => BOOKING_CURRENCY),
  userPayableAmount: money,
  supplierGrossAmount: money,
  supplierPayableAmount: money,
  ticketingDeadlineAt: z.string().datetime({ offset: true }).nullable().optional(),
  travelDate: date,
  refundable: z.boolean(),
  // Accepted for compatibility with older clients, but normalization derives
  // trip scope from the submitted airport codes.
  passportRequired: z.boolean().optional(),
  passengers: z.object({
    travellers: z.array(travellerSchema).min(1).max(20),
    contact: z.object({
      phone: z.string().trim().min(4).max(50),
      phoneCountryCode: z.string().trim().max(8).default("+880"),
      customerEmail: z.string().trim().email().max(255),
      email: z.string().trim().email().max(255),
      countryCode: z.string().trim().max(3).default("BD"),
      cityName: z.string().trim().min(1).max(100),
    }),
  }),
  segments: z.array(segmentSchema).min(1).max(40),
  fares: z.array(fareSchema).min(1).max(20),
  supplierMessage: z.string().trim().max(1_000).optional().or(z.literal("")),
});

const confirmedEvidence = z.object({
  ticketNumbers: z.array(z.string().trim().min(3).max(100)).min(1).max(20),
  issuedAt: dateTime,
});

export const manualBookingImportSchema = commonSchema
  .extend({
    requestId: z.string().uuid(),
    initialStatus: z.enum(["on-hold", "confirmed"]),
    ticketing: confirmedEvidence.optional(),
  })
  .superRefine((value, context) => {
    const ticketNumbers = value.ticketing?.ticketNumbers ?? [];
    if (value.initialStatus === "confirmed") {
      if (!value.ticketing?.issuedAt || ticketNumbers.length !== value.passengers.travellers.length) {
        context.addIssue({ code: z.ZodIssueCode.custom, path: ["ticketing"], message: "Confirmed bookings require one ticket number and an issued date/time for every passenger." });
      }
      if (new Set(ticketNumbers.map((number) => number.toUpperCase())).size !== ticketNumbers.length) {
        context.addIssue({ code: z.ZodIssueCode.custom, path: ["ticketing", "ticketNumbers"], message: "Ticket numbers must be unique." });
      }
    } else if (value.ticketing) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["ticketing"], message: "Ticket details are only entered when importing as Confirmed." });
    }
    const passengerCounts = new Map<string, number>();
    for (const traveller of value.passengers.travellers) passengerCounts.set(traveller.passengerType, (passengerCounts.get(traveller.passengerType) ?? 0) + 1);
    const fareCounts = new Map<string, number>();
    for (const fare of value.fares) fareCounts.set(fare.passengerType, (fareCounts.get(fare.passengerType) ?? 0) + 1);
    if (Array.from(passengerCounts.keys()).some((type) => fareCounts.get(type) !== passengerCounts.get(type))) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["fares"], message: "Enter one fare row for each passenger." });
    }
  });

export const manualBookingStatusSchema = z.object({
  requestId: z.string().uuid(),
  targetStatus: z.enum(["on-hold", "pending", "confirmed", "expired", "unconfirmed", "cancelled"]),
  pnr: z.string().trim().min(2).max(120).optional(),
  airlinePnr: z.string().trim().min(2).max(120).optional(),
  ticketingDeadlineAt: z.string().datetime({ offset: true }).nullable().optional(),
  cancellationReason: z.string().trim().min(2).max(1_000).optional(),
  ticketing: confirmedEvidence.optional(),
});

export type ManualBookingImportInput = z.infer<typeof manualBookingImportSchema>;
export type ManualBookingStatusInput = z.infer<typeof manualBookingStatusSchema>;
