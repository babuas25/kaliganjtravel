import { z } from 'zod';

import { isValidTitleForPassenger } from '@/lib/flights/booking';
import type { BookingGender, BookingPassengerType, BookingTitle } from '@/lib/flights/booking';

export type PassengerSsrRequest = {
  code: string;
  remark: string;
};

export type PassengerProfile = {
  id: string;
  publicRef: string;
  passengerType: BookingPassengerType;
  title: BookingTitle;
  firstName: string;
  lastName: string;
  gender: BookingGender;
  nationality: string;
  phoneCountryCode: string;
  phone: string;
  email: string;
  dateOfBirth: string;
  passportNumber: string;
  passportExpiry: string;
  issuingCountry: string;
  loyaltyAirlineCode: string;
  loyaltyAccountNumber: string;
  ssrRequests: PassengerSsrRequest[];
  organization: string;
  createdAt: string;
  updatedAt: string;
};

export type PassengerProfileCategory = 'adult' | 'child' | 'infant';

/**
 * Saved profiles use the three passenger categories shown to users. Booking
 * suppliers retain their more detailed child/infant types, so legacy profiles
 * using those values are grouped into the same visible category.
 */
export function passengerProfileCategory(
  passengerType: BookingPassengerType
): PassengerProfileCategory {
  if (passengerType === 'ADT') return 'adult';
  if (passengerType === 'CHD' || passengerType === 'CNN') return 'child';
  return 'infant';
}

export function canonicalPassengerProfileType(
  passengerType: BookingPassengerType
): BookingPassengerType {
  const category = passengerProfileCategory(passengerType);
  if (category === 'adult') return 'ADT';
  if (category === 'child') return 'CHD';
  return 'INF';
}

export function passengerProfileTypeLabel(passengerType: BookingPassengerType): string {
  const category = passengerProfileCategory(passengerType);
  return category[0].toUpperCase() + category.slice(1);
}

export function passengerProfileTypesAreCompatible(
  profilePassengerType: BookingPassengerType,
  bookingPassengerType: BookingPassengerType
): boolean {
  return passengerProfileCategory(profilePassengerType) === passengerProfileCategory(bookingPassengerType);
}

function shiftDate(iso: string, years: number, days = 0): string {
  const parsed = new Date(`${iso}T00:00:00Z`);
  parsed.setUTCFullYear(parsed.getUTCFullYear() + years);
  parsed.setUTCDate(parsed.getUTCDate() + days);
  return parsed.toISOString().slice(0, 10);
}

function currentDate(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Date-of-birth choices for the simple Adult / Child / Infant profile form. */
export function passengerProfileDobBounds(
  passengerType: BookingPassengerType
): { min: string; max: string } {
  const date = currentDate();
  const category = passengerProfileCategory(passengerType);
  if (category === 'adult') return { min: '1900-01-01', max: shiftDate(date, -12) };
  if (category === 'child') {
    return { min: shiftDate(date, -12, 1), max: shiftDate(date, -2) };
  }
  return { min: shiftDate(date, -2, 1), max: date };
}

export function isPassengerProfileDateOfBirthValid(
  passengerType: BookingPassengerType,
  dateOfBirth: string
): boolean {
  if (!dateOfBirth) return true;
  const { min, max } = passengerProfileDobBounds(passengerType);
  return dateOfBirth >= min && dateOfBirth <= max;
}

const name = z
  .string()
  .trim()
  .min(1)
  .max(60)
  .regex(/^[\p{L}][\p{L} .'-]*$/u, 'Use letters, spaces, apostrophes, periods, or hyphens only.');
const country = z.string().trim().toUpperCase().regex(/^[A-Z]{2}$/);
const phone = z.union([z.literal(''), z.string().trim().regex(/^[0-9]{6,15}$/)]);
const phoneCountryCode = z
  .string()
  .trim()
  .regex(/^(?:|\+?[0-9]{1,4})$/, 'Enter a country code such as +880 or 880.')
  .transform((value) => value && !value.startsWith('+') ? `+${value}` : value);
const email = z.union([z.literal(''), z.string().trim().toLowerCase().email().max(254)]);
const date = z.union([z.literal(''), z.string().regex(/^\d{4}-\d{2}-\d{2}$/)]);
const passportNumber = z.union([z.literal(''), z.string().trim().toUpperCase().regex(/^[A-Z0-9]{5,20}$/)]);
const loyaltyAirlineCode = z.union([z.literal(''), z.string().trim().toUpperCase().regex(/^[A-Z0-9]{2,10}$/)]);
const loyaltyAccountNumber = z.union([z.literal(''), z.string().trim().max(50).regex(/^[A-Z0-9 .-]+$/i)]);
const organization = z.union([z.literal(''), z.string().trim().max(120)]);
const ssrRequest = z.object({
  code: z.string().trim().toUpperCase().regex(/^[A-Z0-9]{2,10}$/),
  remark: z.string().trim().max(250),
});
const ssrRequests = z.array(ssrRequest).max(8).superRefine((requests, ctx) => {
  const seen = new Set<string>();
  requests.forEach((request, index) => {
    if (seen.has(request.code)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [index, 'code'],
        message: 'Each SSR code can be added only once.',
      });
    }
    seen.add(request.code);
  });
});

const passengerFieldsBase = z.object({
  passengerType: z.enum(['ADT', 'CHD', 'CNN', 'INF', 'INS']),
  title: z.enum(['Mr', 'Mrs', 'Ms', 'Mstr', 'Miss']),
  firstName: name,
  lastName: name,
  gender: z.enum(['Male', 'Female']),
  nationality: country,
  phoneCountryCode,
  phone,
  email,
  dateOfBirth: date,
  passportNumber,
  passportExpiry: date,
  issuingCountry: z.union([z.literal(''), country]),
  loyaltyAirlineCode,
  loyaltyAccountNumber,
  ssrRequests,
  organization,
});

function validatePhonePair(
  value: { phone?: string; phoneCountryCode?: string },
  ctx: z.RefinementCtx
) {
  if (
    value.phone !== undefined &&
    value.phoneCountryCode !== undefined &&
    Boolean(value.phone) !== Boolean(value.phoneCountryCode)
  ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: value.phone ? ['phoneCountryCode'] : ['phone'],
        message: 'Enter both a phone number and country code, or leave both blank.',
      });
    }
}

const passengerFields = passengerFieldsBase.superRefine((value, ctx) => {
  validatePhonePair(value, ctx);
  if (!isValidTitleForPassenger(value.passengerType, value.gender, value.title)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['title'],
      message: 'Choose a title that matches the passenger type and gender.',
    });
  }
});

export const PassengerProfileCheckoutCreateSchema = passengerFields;
export const PassengerProfileCreateSchema = passengerFields.superRefine((value, ctx) => {
  if (!isPassengerProfileDateOfBirthValid(value.passengerType, value.dateOfBirth)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['dateOfBirth'],
      message: 'Choose a date of birth that matches the passenger type.',
    });
  }
});
export const PassengerProfileUpdateSchema = passengerFieldsBase
  .partial()
  .extend({ id: z.string().uuid() })
  .superRefine((value, ctx) => {
    validatePhonePair(value, ctx);
    const editableFields = Object.keys(passengerFieldsBase.shape) as Array<keyof typeof passengerFieldsBase.shape>;
    if (!editableFields.some((field) => value[field] !== undefined)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Change at least one passenger detail before saving.',
      });
    }
  });
export const PassengerProfileDeleteSchema = z.object({ id: z.string().uuid() });

export type PassengerProfileInput = z.infer<typeof PassengerProfileCreateSchema>;
export type PassengerProfileUpdateInput = z.infer<typeof PassengerProfileUpdateSchema>;
