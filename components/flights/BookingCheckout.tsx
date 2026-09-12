'use client';

import {
  AlertCircle,
  ArrowLeft,
  ArrowRight,
  CalendarDays,
  ChevronDown,
  Loader2,
  Mail,
  ShieldCheck,
  Users,
} from 'lucide-react';
import {
  FormEvent,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';

import BookingDetails from '@/components/flights/BookingDetails';
import CheckoutStepper from '@/components/flights/CheckoutStepper';
import CheckoutSummary, {
  useOfferExpiry,
} from '@/components/flights/CheckoutSummary';
import {
  ItineraryPanel,
  TripSummaryHeader,
} from '@/components/flights/CheckoutItinerary';
import {
  isValidTitleForPassenger,
  titleOptionsForPassenger,
  type BookingContact,
  type BookingPassengerType,
  type BookingTitle,
  type BookingTraveller,
  type PublicBooking,
  type PublicBookingAttempt,
} from '@/lib/flights/booking';
import { CountrySelector } from '@/components/flights/CountrySelector';
import { DatePickerField } from '@/components/flights/DatePickerField';
import { COUNTRIES, PHONE_COUNTRIES } from '@/lib/flights/countries';
import {
  canonicalPassengerProfileType,
  passengerProfileTypesAreCompatible,
} from '@/lib/passengers';
import type { PassengerProfile } from '@/lib/passengers';

type Failure = {
  success: false;
  error: { errorCode: string; errorMessage: string };
};
type AttemptEnvelope = { success: true; data: PublicBookingAttempt } | Failure;
type BookingEnvelope = { success: true; data: PublicBooking } | Failure;
type BookingStatusEnvelope =
  | { success: true; phase: 'booking-created'; data: PublicBooking }
  | { success: true; phase: 'processing' | 'ready' }
  | Failure;

type Step = 'details' | 'review';
type CheckoutTraveller = BookingTraveller;
type TouchedTravellerFields = Partial<Record<keyof BookingTraveller, true>>;

const TYPES: BookingPassengerType[] = ['ADT', 'CHD', 'CNN', 'INF', 'INS'];
const LABELS: Record<BookingPassengerType, string> = {
  ADT: 'Adult',
  CHD: 'Child',
  CNN: 'Child',
  INF: 'Infant',
  INS: 'Infant with seat',
};

/** Mirrors the age windows `app/api/flights/booking/route.ts` enforces. */
const AGE_HINTS: Record<BookingPassengerType, string> = {
  ADT: '12+ years at travel date',
  CHD: '5 years up to 11 years at travel date',
  CNN: '2 years up to 4 years at travel date',
  INF: 'Under 2 years at travel date',
  INS: 'Under 2 years at travel date',
};

/** `"2026-08-15"` shifted by whole years and days, staying in UTC. */
function shiftDate(iso: string, years: number, days = 0): string {
  const parsed = new Date(`${iso}T00:00:00Z`);
  if (!Number.isFinite(parsed.getTime())) return '';
  parsed.setUTCFullYear(parsed.getUTCFullYear() + years);
  parsed.setUTCDate(parsed.getUTCDate() + days);
  return parsed.toISOString().slice(0, 10);
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * The date range a picker may offer for each passenger type.
 *
 * Ages are measured at the travel date because that is what the booking route
 * checks; a form that used a different reference would accept dates the server
 * then rejects.
 */
function dobBounds(
  passengerType: BookingPassengerType,
  travelDate: string
): { min: string; max: string } {
  if (passengerType === 'ADT') {
    return { min: '1900-01-01', max: shiftDate(travelDate, -12) };
  }
  if (passengerType === 'CHD') {
    return {
      min: shiftDate(travelDate, -12, 1),
      max: shiftDate(travelDate, -5),
    };
  }
  if (passengerType === 'CNN') {
    return {
      min: shiftDate(travelDate, -5, 1),
      max: shiftDate(travelDate, -2),
    };
  }
  const latest = travelDate < today() ? travelDate : today();
  return { min: shiftDate(travelDate, -2, 1), max: latest };
}

/** Tripfeels' rule: valid at least three months past travel, at most twelve years. */
function passportBounds(travelDate: string): { min: string; max: string } {
  const min = new Date(`${travelDate}T00:00:00Z`);
  min.setUTCMonth(min.getUTCMonth() + 3);
  return {
    min: min.toISOString().slice(0, 10),
    max: shiftDate(travelDate, 12),
  };
}

function defaultTitle(passengerType: BookingPassengerType): BookingTitle {
  return passengerType === 'ADT' ? 'Mr' : 'Mstr';
}

function initialTravellers(
  counts: PublicBookingAttempt['passengerCounts']
): CheckoutTraveller[] {
  return TYPES.flatMap((passengerType) =>
    Array.from({ length: counts[passengerType] ?? 0 }, () => ({
      passengerType,
      title: defaultTitle(passengerType),
      firstName: '',
      lastName: '',
      gender: 'Male' as const,
      dateOfBirth: '',
      passportNumber: '',
      passportExpiry: '',
      issuingCountry: 'BD',
      nationality: 'BD',
    }))
  );
}

const initialContact: BookingContact = {
  phone: '',
  phoneCountryCode: '+880',
  customerEmail: '',
};

// Width is deliberately not part of the base: appending `w-28` to a class
// string that already carries `w-full` does not override it, because Tailwind
// resolves the conflict by CSS order rather than by the order written here.
const fieldBase =
  'rounded-lg border border-neutral-300 bg-white px-3 py-2 text-sm text-navy-950 transition focus:border-transparent focus:outline-none focus:ring-2 focus:ring-brand-orange';
const fieldClass = `w-full ${fieldBase}`;
const labelClass = 'mb-1 block text-xs font-medium text-neutral-600 sm:text-sm';

function Required() {
  return <span className="text-brand-orange">*</span>;
}

/** `"1971-01-01"` → `"1 Jan 1971"`, or a dash when nothing was entered. */
function formatReviewDate(value: string | undefined): string {
  if (!value) return '--';
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return value;
  return new Intl.DateTimeFormat('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(
    new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])))
  );
}

/** One boxed label/value pair in a passenger's review row. */
function ReviewFact({
  label,
  value,
  icon: Icon,
}: {
  label: string;
  value: string;
  icon?: typeof CalendarDays;
}) {
  return (
    <div className="rounded-lg border border-neutral-200 bg-navy-50/40 px-3 py-2">
      <p className="text-[10px] font-semibold uppercase tracking-wide text-neutral-500">
        {label}
      </p>
      <p className="mt-1 flex items-center gap-1.5 text-sm font-semibold text-navy-950">
        {Icon && (
          <Icon className="h-3.5 w-3.5 shrink-0 text-brand-orange" aria-hidden />
        )}
        <span className="truncate" title={value}>
          {value}
        </span>
      </p>
    </div>
  );
}

/** Collapsible section shell shared by the review step's cards. */
function ReviewCard({
  title,
  icon: Icon,
  open,
  onToggle,
  action,
  children,
}: {
  title: string;
  icon: typeof Users;
  open: boolean;
  onToggle: () => void;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="overflow-hidden rounded-lg bg-white ring-1 ring-neutral-200">
      <div className="flex items-center justify-between gap-3 border-b border-neutral-200 p-4 sm:p-5">
        <div className="flex min-w-0 items-center gap-2">
          <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-brand-orange-light text-brand-orange-dark">
            <Icon className="h-4 w-4" aria-hidden />
          </span>
          <h2 className="truncate text-sm font-bold text-navy-950">{title}</h2>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {action}
          <button
            type="button"
            onClick={onToggle}
            aria-expanded={open}
            aria-label={open ? `Collapse ${title}` : `Expand ${title}`}
            className="rounded p-1 text-brand-orange transition hover:bg-brand-orange-light"
          >
            <ChevronDown
              className={`h-5 w-5 transition-transform ${
                open ? 'rotate-180' : ''
              }`}
              aria-hidden
            />
          </button>
        </div>
      </div>
      {open && children}
    </section>
  );
}

export default function BookingCheckout({
  bookingId,
  customerEmail = '',
}: {
  bookingId: string;
  customerEmail?: string;
}) {
  const router = useRouter();
  const [attempt, setAttempt] = useState<PublicBookingAttempt | null>(null);
  // Set once the supplier has answered. Its presence is what ends the form —
  // the attempt's own state stays on the server where it belongs.
  const [booking, setBooking] = useState<PublicBooking | null>(null);
  const [travellers, setTravellers] = useState<CheckoutTraveller[]>([]);
  const [contact, setContact] = useState({ ...initialContact, customerEmail });
  const [savedPassengers, setSavedPassengers] = useState<PassengerProfile[]>([]);
  const [savedPassengersLoading, setSavedPassengersLoading] = useState(true);
  const [savedPassengersAvailable, setSavedPassengersAvailable] = useState(false);
  const [selectedPassengerByIndex, setSelectedPassengerByIndex] = useState<Record<number, string>>({});
  const [savePassengerByIndex, setSavePassengerByIndex] = useState<Record<number, boolean>>({});
  const [touchedTravellerFieldsByIndex, setTouchedTravellerFieldsByIndex] = useState<Record<number, TouchedTravellerFields>>({});
  const [step, setStep] = useState<Step>('details');
  const [expanded, setExpanded] = useState(0);
  const [detailsOpen, setDetailsOpen] = useState(true);
  const [passengersOpen, setPassengersOpen] = useState(true);
  const [contactOpen, setContactOpen] = useState(true);
  const [errors, setErrors] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [savingPassengers, setSavingPassengers] = useState(false);

  const accessToken =
    typeof window === 'undefined'
      ? ''
      : (sessionStorage.getItem(`kaliganj-booking-${bookingId}`) ?? '');

  const recoverBooking = async (): Promise<BookingStatusEnvelope> => {
    const response = await fetch('/api/flights/booking/status', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ bookingId, accessToken }),
    });
    return (await response.json()) as BookingStatusEnvelope;
  };

  useEffect(() => {
    if (!accessToken) {
      setError('This private booking draft is unavailable. Select the fare again.');
      setLoading(false);
      return;
    }
    void fetch('/api/flights/booking/draft', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ bookingId, accessToken }),
    })
      .then(async (response) => (await response.json()) as AttemptEnvelope)
      .then(async (envelope) => {
        if (!envelope.success) {
          if (envelope.error.errorCode === 'DRAFT_CLOSED') {
            const recovered = await recoverBooking();
            if (
              recovered.success &&
              recovered.phase === 'booking-created'
            ) {
              sessionStorage.removeItem(`kaliganj-booking-${bookingId}`);
              setBooking(recovered.data);
              router.replace(
                `/dashboard/bookings/${encodeURIComponent(recovered.data.publicRef)}?created=1`
              );
              return;
            }
            if (recovered.success && recovered.phase === 'processing') {
              setError(
                'Your booking is still being confirmed. Do not submit again; refresh this page shortly.'
              );
              return;
            }
            if (!recovered.success) {
              setError(recovered.error.errorMessage);
              return;
            }
          }
          setError(envelope.error.errorMessage);
          return;
        }
        setAttempt(envelope.data);
        setTravellers(initialTravellers(envelope.data.passengerCounts));
        if (envelope.data.suggestedContact) {
          setContact((current) =>
            current.phone
              ? current
              : { ...current, ...envelope.data.suggestedContact }
          );
        }
      })
      .catch(() => setError('The booking draft could not be loaded.'))
      .finally(() => setLoading(false));
  }, [accessToken, bookingId, router]);

  useEffect(() => {
    let mounted = true;
    void fetch('/api/passengers?limit=100', { cache: 'no-store' })
      .then(async (response) => {
        const body = (await response.json()) as {
          success?: boolean;
          data?: { passengers?: PassengerProfile[] };
        };
        if (!response.ok || !body.success) return null;
        return body.data?.passengers ?? [];
      })
      .then((passengers) => {
        if (!mounted || passengers === null) return;
        setSavedPassengers(passengers);
        setSavedPassengersAvailable(true);
      })
      .catch(() => {
        // A saved-profile outage must never block a new booking. The user can
        // still enter all traveller details manually.
      })
      .finally(() => {
        if (mounted) setSavedPassengersLoading(false);
      });
    return () => {
      mounted = false;
    };
  }, []);

  const passportRequired = attempt?.passportRequired !== false;
  // The booking route refuses a draft past this moment, so the buttons stop
  // offering a booking that could only fail.
  const { expired } = useOfferExpiry(attempt?.expiresAt ?? '');

  const changeTraveller = (
    index: number,
    field: keyof BookingTraveller,
    value: string
  ) => {
    setTouchedTravellerFieldsByIndex((current) => ({
      ...current,
      [index]: { ...current[index], [field]: true },
    }));
    setTravellers((current) =>
      current.map((traveller, position) =>
        position === index ? { ...traveller, [field]: value } : traveller
      )
    );
  };

  const changeGender = (index: number, gender: BookingTraveller['gender']) => {
    setTouchedTravellerFieldsByIndex((current) => ({
      ...current,
      [index]: { ...current[index], gender: true, title: true },
    }));
    setTravellers((current) =>
      current.map((traveller, position) => {
        if (position !== index) return traveller;
        const title = isValidTitleForPassenger(traveller.passengerType, gender, traveller.title)
          ? traveller.title
          : titleOptionsForPassenger(traveller.passengerType, gender)[0];
        return {
          ...traveller,
          gender,
          title,
        };
      })
    );
  };

  const changeContact = <Field extends keyof BookingContact>(
    field: Field,
    value: BookingContact[Field]
  ) => {
    setContact((current) => ({ ...current, [field]: value }));
  };

  const applySavedPassenger = (index: number, passengerId: string) => {
    setSelectedPassengerByIndex((current) => ({ ...current, [index]: passengerId }));
    setSavePassengerByIndex((current) => ({ ...current, [index]: false }));
    setTouchedTravellerFieldsByIndex((current) => ({ ...current, [index]: {} }));
    if (!passengerId) return;
    const saved = savedPassengers.find((passenger) => passenger.id === passengerId);
    if (!saved) return;

    setTravellers((current) =>
      current.map((traveller, position) => {
        if (
          position !== index ||
          !passengerProfileTypesAreCompatible(saved.passengerType, traveller.passengerType)
        ) return traveller;
        return {
          ...traveller,
          title: saved.title,
          firstName: saved.firstName,
          lastName: saved.lastName,
          gender: saved.gender,
          nationality: saved.nationality,
          dateOfBirth: saved.dateOfBirth,
          passportNumber: saved.passportNumber,
          passportExpiry: saved.passportExpiry,
          issuingCountry: saved.issuingCountry,
        };
      })
    );

    if (index === 0) {
      setContact((current) => ({
        ...current,
        phone: current.phone || saved.phone,
        phoneCountryCode: current.phone ? current.phoneCountryCode : saved.phoneCountryCode || current.phoneCountryCode,
        customerEmail: current.customerEmail || saved.email,
      }));
    }
  };

  const storeReturnedPassenger = (index: number, passenger: PassengerProfile) => {
    setSavedPassengers((current) => [
      passenger,
      ...current.filter((item) => item.id !== passenger.id),
    ]);
    setSelectedPassengerByIndex((current) => ({
      ...current,
      [index]: passenger.id,
    }));
    setSavePassengerByIndex((current) => ({ ...current, [index]: false }));
    setTouchedTravellerFieldsByIndex((current) => ({ ...current, [index]: {} }));
  };

  const saveCheckedPassengers = async () => {
    for (let index = 0; index < travellers.length; index += 1) {
      if (!savePassengerByIndex[index]) continue;

      const traveller = travellers[index];
      const selectedPassengerId = selectedPassengerByIndex[index];
      const touched = touchedTravellerFieldsByIndex[index] ?? {};
      let method = 'POST';
      let body: Record<string, unknown>;

      if (selectedPassengerId) {
        method = 'PATCH';
        body = { id: selectedPassengerId };
        const editableFields: Array<keyof BookingTraveller> = [
          'title',
          'firstName',
          'lastName',
          'gender',
          'nationality',
          'dateOfBirth',
          'passportNumber',
          'passportExpiry',
          'issuingCountry',
        ];
        editableFields.forEach((field) => {
          if (touched[field]) body[field] = traveller[field] ?? '';
        });
      } else {
        body = {
          source: 'checkout',
          passengerType: canonicalPassengerProfileType(traveller.passengerType),
          title: traveller.title,
          firstName: traveller.firstName,
          lastName: traveller.lastName,
          gender: traveller.gender,
          nationality: traveller.nationality,
          phoneCountryCode: '',
          phone: '',
          email: '',
          dateOfBirth: touched.dateOfBirth ? traveller.dateOfBirth : '',
          passportNumber: touched.passportNumber ? traveller.passportNumber ?? '' : '',
          passportExpiry: touched.passportExpiry ? traveller.passportExpiry ?? '' : '',
          issuingCountry: touched.issuingCountry ? traveller.issuingCountry ?? '' : '',
          loyaltyAirlineCode: '',
          loyaltyAccountNumber: '',
          ssrRequests: [],
          organization: '',
        };
      }

      const response = await fetch('/api/passengers', {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const envelope = (await response.json()) as {
        success?: boolean;
        data?: { passenger?: PassengerProfile };
        error?: { errorMessage?: string };
      };
      if (!response.ok || !envelope.success || !envelope.data?.passenger) {
        throw new Error(
          `Passenger ${index + 1}: ${envelope.error?.errorMessage || 'Passenger could not be saved.'}`
        );
      }
      storeReturnedPassenger(index, envelope.data.passenger);
    }
  };

  /** Collected rather than thrown, so the rail can list every gap at once. */
  const validate = (): string[] => {
    if (!attempt) return [];
    const found: string[] = [];

    travellers.forEach((traveller, index) => {
      const who = `Passenger ${index + 1} (${LABELS[traveller.passengerType]})`;
      if (!traveller.firstName.trim() && !traveller.lastName.trim()) {
        found.push(`${who}: Name is required`);
      } else if (!traveller.lastName.trim()) {
        found.push(`${who}: Last name is required`);
      }
      if (!traveller.dateOfBirth) {
        found.push(`${who}: Date of birth is required`);
      } else {
        const bounds = dobBounds(traveller.passengerType, attempt.travelDate);
        if (
          traveller.dateOfBirth < bounds.min ||
          traveller.dateOfBirth > bounds.max
        ) {
          found.push(`${who}: Must be ${AGE_HINTS[traveller.passengerType]}`);
        }
      }
      if (!traveller.gender) found.push(`${who}: Gender is required`);
      if (!traveller.nationality) found.push(`${who}: Nationality is required`);
      if (savePassengerByIndex[index] && !selectedPassengerByIndex[index] && !traveller.firstName.trim()) {
        found.push(`${who}: First name is required to save this passenger`);
      }

      if (passportRequired) {
        if (!traveller.passportNumber?.trim()) {
          found.push(`${who}: Passport number is required`);
        } else if (!/^[A-Z0-9]{5,20}$/.test(traveller.passportNumber.trim())) {
          found.push(`${who}: Passport number must be 5–20 letters or digits`);
        }
        if (!traveller.passportExpiry) {
          found.push(`${who}: Passport expiry date is required`);
        } else if (traveller.passportExpiry < attempt.travelDate) {
          found.push(`${who}: Passport must be valid on the travel date`);
        }
        if (!traveller.issuingCountry) {
          found.push(`${who}: Passport issuing country is required`);
        }
      }
    });

    // These details are saved with the booking and sent to the airline supplier.
    if (!/^\S+@\S+\.\S+$/.test(contact.customerEmail.trim())) {
      found.push('Contact: Enter a valid email address');
    }
    if (!contact.phone.trim()) {
      found.push('Contact: Phone number is required');
    } else if (contact.phone.trim().length < 10) {
      found.push('Contact: Phone number must be at least 10 digits');
    }

    return found;
  };

  const continueToReview = async (event: FormEvent) => {
    event.preventDefault();
    if (expired || savingPassengers) return;
    const found = validate();
    setErrors(found);
    if (found.length > 0) {
      window.scrollTo({ top: 0, behavior: 'smooth' });
      return;
    }
    if (Object.values(savePassengerByIndex).some(Boolean)) {
      setSavingPassengers(true);
      try {
        await saveCheckedPassengers();
      } catch (saveError) {
        setErrors([
          saveError instanceof Error
            ? saveError.message
            : 'The selected passenger could not be saved.',
        ]);
        window.scrollTo({ top: 0, behavior: 'smooth' });
        return;
      } finally {
        setSavingPassengers(false);
      }
    }
    setStep('review');
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const submit = async () => {
    if (
      !attempt?.submissionEnabled ||
      (attempt.directTicketing && !attempt.ticketingEnabled) ||
      submitting
    ) return;
    if (expired) return;
    setSubmitting(true);
    setError(null);
    try {
      const bookingTravellers: BookingTraveller[] = travellers;
      const response = await fetch('/api/flights/booking', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ bookingId, accessToken, travellers: bookingTravellers, contact }),
      });
      const envelope = (await response.json()) as BookingEnvelope;
      if (!envelope.success) {
        // A prior click may already own the attempt. Read the durable result
        // instead of leaving the traveller with a misleading retry prompt.
        if (envelope.error.errorCode === 'BOOKING_ALREADY_STARTED') {
          try {
            const recovered = await recoverBooking();
            if (
              recovered.success &&
              recovered.phase === 'booking-created'
            ) {
              sessionStorage.removeItem(`kaliganj-booking-${bookingId}`);
              setBooking(recovered.data);
              router.replace(
                `/dashboard/bookings/${encodeURIComponent(recovered.data.publicRef)}?created=1`
              );
              return;
            }
            if (recovered.success && recovered.phase === 'processing') {
              setError(
                'Your booking is still being confirmed. Do not submit again; refresh this page shortly.'
              );
              return;
            }
            if (!recovered.success) {
              setError(recovered.error.errorMessage);
              return;
            }
          } catch {
            setError(
              'The booking is already being processed, but its outcome could not be checked. Do not submit again; refresh this page shortly.'
            );
            return;
          }
        }
        setError(envelope.error.errorMessage);
      } else {
        sessionStorage.removeItem(`kaliganj-booking-${bookingId}`);
        setBooking(envelope.data);
        router.replace(
          `/dashboard/bookings/${encodeURIComponent(envelope.data.publicRef)}?created=1`
        );
      }
    } catch {
      // A serverless/gateway timeout can hide a successful supplier response.
      // Read our durable attempt instead of asking the supplier a second time.
      try {
        const recovered = await recoverBooking();
        if (
          recovered.success &&
          recovered.phase === 'booking-created'
        ) {
          sessionStorage.removeItem(`kaliganj-booking-${bookingId}`);
          setBooking(recovered.data);
          router.replace(
            `/dashboard/bookings/${encodeURIComponent(recovered.data.publicRef)}?created=1`
          );
        } else if (!recovered.success) {
          setError(recovered.error.errorMessage);
        } else {
          setError(
            'Your booking is still being confirmed. Do not submit again; refresh this page shortly.'
          );
        }
      } catch {
        setError(
          'The booking outcome could not be confirmed. Do not submit again; contact support.'
        );
      }
    } finally {
      setSubmitting(false);
    }
  };

  const travellerSummary = useMemo(
    () =>
      travellers.map((traveller, index) => ({
        key: `${traveller.passengerType}-${index}`,
        name: [traveller.firstName, traveller.lastName]
          .filter(Boolean)
          .join(' '),
        traveller,
      })),
    [travellers]
  );

  // The booking exists from here on: the form is finished, and the third step
  // takes over. `travellers` is handed down because nothing is re-fetched —
  // this component's state is the only record of the names.
  if (booking) {
    return <BookingDetails booking={booking} travellers={travellers} />;
  }
  if (loading) {
    return (
      <div className="rounded-lg bg-white p-10 text-center ring-1 ring-neutral-200">
        <Loader2 className="mx-auto h-7 w-7 animate-spin text-brand-orange" />
        <p className="mt-3 font-semibold">Loading your fare…</p>
      </div>
    );
  }
  if (!attempt) {
    return (
      <div className="rounded-lg bg-white p-10 text-center ring-1 ring-neutral-200">
        <AlertCircle className="mx-auto h-7 w-7 text-brand-orange" />
        <p className="mt-3 font-semibold">{error}</p>
      </div>
    );
  }
  const passport = passportBounds(attempt.travelDate);
  const review = step === 'review';
  const bookingBlocked =
    !attempt.submissionEnabled ||
    (attempt.directTicketing && !attempt.ticketingEnabled) ||
    expired;

  return (
    <div className="space-y-4">
      <TripSummaryHeader
        offer={attempt}
        detailsOpen={detailsOpen}
        onToggleDetails={() => setDetailsOpen((open) => !open)}
        eyebrow={review ? 'Review & Book' : 'Trip Summary'}
        {...(review && { subtitle: 'Ready for booking confirmation' })}
      />
      <CheckoutStepper activeIndex={review ? 1 : 0} />

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_320px] lg:items-start lg:gap-6">
        <div className="min-w-0 space-y-4">
          <ItineraryPanel
            offer={attempt}
            open={detailsOpen}
            onToggle={() => setDetailsOpen((open) => !open)}
            title={review ? 'Flight Details' : 'Itinerary'}
          />

          {step === 'details' ? (
            // `noValidate`: the browser's own tooltips would pre-empt the
            // collected list in the rail, which is the one place a customer can
            // see every remaining gap at once.
            <form onSubmit={continueToReview} noValidate className="space-y-4">
              <section className="overflow-hidden rounded-lg bg-white ring-1 ring-neutral-200">
                <div className="border-b border-neutral-200 p-4 sm:p-5">
                  <div className="flex items-center gap-2">
                    <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-brand-orange-light text-brand-orange-dark">
                      <Users className="h-4 w-4" aria-hidden />
                    </span>
                    <h2 className="text-sm font-bold text-navy-950">
                      Traveller Details
                    </h2>
                  </div>
                  <p className="mt-1 text-xs text-neutral-500">
                    Enter passenger details exactly as shown on travel documents.
                  </p>
                </div>

                <div className="divide-y divide-neutral-200">
                  {travellers.map((traveller, index) => {
                    const isOpen = expanded === index;
                    const bounds = dobBounds(
                      traveller.passengerType,
                      attempt.travelDate
                    );
                    const eligibleSavedPassengers = savedPassengers.filter(
                      (passenger) =>
                        passengerProfileTypesAreCompatible(
                          passenger.passengerType,
                          traveller.passengerType
                        ) &&
                        (!passenger.dateOfBirth ||
                          (passenger.dateOfBirth >= bounds.min &&
                            passenger.dateOfBirth <= bounds.max))
                    );
                    const complete =
                      traveller.lastName.trim() !== '' &&
                      traveller.dateOfBirth !== '';

                    return (
                      <div key={`${traveller.passengerType}-${index}`}>
                        <div className="flex items-center justify-between gap-3 px-3 py-3 transition hover:bg-navy-50/60 sm:px-4">
                          <div className="min-w-0">
                            <p className="text-sm font-semibold text-navy-950 sm:text-base">
                              Passenger {index + 1}
                            </p>
                            <div className="mt-0.5 flex flex-wrap items-center gap-2">
                              <span className="rounded-full bg-brand-orange-light px-2 py-0.5 text-[11px] font-semibold text-brand-orange-dark">
                                {LABELS[traveller.passengerType]}
                              </span>
                              {complete && (
                                <span className="text-[11px] font-medium text-emerald-600">
                                  Completed
                                </span>
                              )}
                            </div>
                          </div>

                          <div className="w-40 shrink-0 sm:w-56">
                            <select
                              value={selectedPassengerByIndex[index] ?? ''}
                              aria-label="Select traveller from list"
                              disabled={savedPassengersLoading || !savedPassengersAvailable}
                              onChange={(event) =>
                                applySavedPassenger(index, event.target.value)
                              }
                              className="w-full rounded-lg border border-neutral-300 bg-white px-3 py-2 text-xs text-navy-950 transition focus:border-transparent focus:outline-none focus:ring-2 focus:ring-brand-orange disabled:cursor-wait disabled:bg-neutral-100 disabled:text-neutral-500"
                            >
                              <option value="">
                                {savedPassengersLoading
                                  ? 'Loading saved passengers…'
                                  : !savedPassengersAvailable
                                    ? 'Saved passengers unavailable'
                                  : eligibleSavedPassengers.length
                                    ? 'Select saved passenger'
                                    : 'No matching passenger found'}
                              </option>
                              {eligibleSavedPassengers.map((passenger) => (
                                <option key={passenger.id} value={passenger.id}>
                                  {passenger.title} {passenger.firstName} {passenger.lastName} · {passenger.publicRef}
                                </option>
                              ))}
                            </select>
                          </div>

                          <button
                            type="button"
                            onClick={() => setExpanded(isOpen ? -1 : index)}
                            aria-expanded={isOpen}
                            aria-label={
                              isOpen
                                ? 'Collapse passenger form'
                                : 'Expand passenger form'
                            }
                            className="rounded p-1 text-brand-orange transition hover:bg-brand-orange-light"
                          >
                            <ChevronDown
                              className={`h-5 w-5 transition-transform ${
                                isOpen ? 'rotate-180' : ''
                              }`}
                              aria-hidden
                            />
                          </button>
                        </div>

                        {isOpen && (
                          <div className="space-y-3 px-3 pb-4 pt-1 sm:px-4 sm:space-y-4">
                            <div className="space-y-3 rounded-lg border border-neutral-200 bg-navy-50/40 p-3 sm:p-4">
                              <div className="grid gap-3 sm:grid-cols-[7rem_minmax(0,1fr)] sm:gap-4">
                                <div>
                                  <label className={labelClass}>
                                    Title <Required />
                                  </label>
                                  <select
                                    value={traveller.title}
                                    onChange={(event) =>
                                      changeTraveller(
                                        index,
                                        'title',
                                        event.target.value
                                      )
                                    }
                                    className={fieldClass}
                                  >
                                    {titleOptionsForPassenger(traveller.passengerType, traveller.gender).map((title) => (
                                      <option key={title} value={title}>{title.toUpperCase()}</option>
                                    ))}
                                  </select>
                                </div>
                                <div>
                                  <label className={labelClass}>
                                    Given Name/First Name
                                  </label>
                                  <input
                                    type="text"
                                    placeholder="FIRST NAME"
                                    value={traveller.firstName}
                                    onChange={(event) =>
                                      changeTraveller(
                                        index,
                                        'firstName',
                                        event.target.value
                                          .replace(/[^a-zA-Z\s]/g, '')
                                          .toUpperCase()
                                      )
                                    }
                                    className={`${fieldClass} uppercase`}
                                  />
                                  <p className="mt-1 text-xs text-neutral-500">
                                    If your passport contains only a last name,
                                    please leave the &ldquo;First Name&rdquo;
                                    input box empty.
                                  </p>
                                </div>
                              </div>

                              <div>
                                <label className={labelClass}>
                                  Surname/Last Name <Required />
                                </label>
                                <input
                                  type="text"
                                  placeholder="LAST NAME"
                                  required
                                  value={traveller.lastName}
                                  onChange={(event) =>
                                    changeTraveller(
                                      index,
                                      'lastName',
                                      event.target.value
                                        .replace(/[^a-zA-Z\s]/g, '')
                                        .toUpperCase()
                                    )
                                  }
                                  className={`${fieldClass} uppercase`}
                                />
                              </div>

                              <div className="grid gap-3 sm:grid-cols-3 sm:gap-4">
                                <div>
                                  <label className={labelClass}>
                                    Date of Birth <Required />
                                  </label>
                                  <DatePickerField
                                    value={traveller.dateOfBirth}
                                    min={bounds.min}
                                    max={bounds.max}
                                    ariaLabel={`Date of birth, passenger ${index + 1}`}
                                    onChange={(date) =>
                                      changeTraveller(
                                        index,
                                        'dateOfBirth',
                                        date
                                      )
                                    }
                                  />
                                  <p className="mt-1 text-xs text-neutral-500">
                                    {AGE_HINTS[traveller.passengerType]}
                                  </p>
                                </div>

                                <div>
                                  <label className={labelClass}>
                                    Gender <Required />
                                  </label>
                                  {/* A two-way choice reads better as a
                                      segmented control than as radios: one
                                      tap target per option, and the selected
                                      state is legible at a glance. */}
                                  <div
                                    role="group"
                                    aria-label={`Gender, passenger ${index + 1}`}
                                    className="flex h-[42px] overflow-hidden rounded-lg border border-neutral-300"
                                  >
                                    {(['Male', 'Female'] as const).map(
                                      (gender, position) => {
                                        const active =
                                          traveller.gender === gender;
                                        return (
                                          <button
                                            key={gender}
                                            type="button"
                                            aria-pressed={active}
                                            onClick={() =>
                                              changeGender(index, gender)
                                            }
                                            className={`flex-1 text-sm font-medium transition focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-navy-900 ${
                                              position > 0
                                                ? 'border-l border-neutral-300'
                                                : ''
                                            } ${
                                              active
                                                ? 'bg-brand-orange text-black'
                                                : 'bg-white text-neutral-700 hover:bg-navy-50'
                                            }`}
                                          >
                                            {gender}
                                          </button>
                                        );
                                      }
                                    )}
                                  </div>
                                </div>

                                <div>
                                  <label className={labelClass}>
                                    Nationality <Required />
                                  </label>
                                  <CountrySelector
                                    value={traveller.nationality}
                                    countries={COUNTRIES}
                                    placeholder="Select nationality"
                                    ariaLabel={`Nationality, passenger ${index + 1}`}
                                    triggerClassName="h-[42px]"
                                    onChange={(code) =>
                                      changeTraveller(
                                        index,
                                        'nationality',
                                        code
                                      )
                                    }
                                  />
                                </div>
                              </div>

                              {passportRequired && (
                                <div className="grid gap-3 sm:grid-cols-3 sm:gap-4">
                                  <div>
                                    <label className={labelClass}>
                                      Passport number <Required />
                                    </label>
                                    <input
                                      type="text"
                                      required
                                      value={traveller.passportNumber ?? ''}
                                      onChange={(event) =>
                                        changeTraveller(
                                          index,
                                          'passportNumber',
                                          event.target.value
                                            .replace(/[^a-zA-Z0-9]/g, '')
                                            .toUpperCase()
                                        )
                                      }
                                      className={`${fieldClass} uppercase`}
                                    />
                                  </div>
                                  <div>
                                    <label className={labelClass}>
                                      Passport expiry <Required />
                                    </label>
                                    <DatePickerField
                                      value={traveller.passportExpiry ?? ''}
                                      min={passport.min}
                                      max={passport.max}
                                      ariaLabel={`Passport expiry, passenger ${index + 1}`}
                                      onChange={(date) =>
                                        changeTraveller(
                                          index,
                                          'passportExpiry',
                                          date
                                        )
                                      }
                                    />
                                    <p className="mt-1 text-xs text-neutral-500">
                                      Valid at least 3 months after travel.
                                    </p>
                                  </div>
                                  <div>
                                    <label className={labelClass}>
                                      Issuing country <Required />
                                    </label>
                                    <CountrySelector
                                      value={traveller.issuingCountry ?? 'BD'}
                                      countries={COUNTRIES}
                                      placeholder="Select issuing country"
                                      ariaLabel={`Passport issuing country, passenger ${index + 1}`}
                                      triggerClassName="h-[42px]"
                                      onChange={(code) =>
                                        changeTraveller(
                                          index,
                                          'issuingCountry',
                                          code
                                        )
                                      }
                                    />
                                    <p className="mt-1 text-xs text-neutral-500">
                                      Select the country that issued this
                                      passport.
                                    </p>
                                  </div>
                                </div>
                              )}

                            </div>

                            <div className="rounded-lg border border-neutral-200 bg-white p-3 sm:p-4">
                              <label className="inline-flex items-center gap-3 text-sm font-semibold text-navy-950">
                                <input
                                  type="checkbox"
                                  checked={savePassengerByIndex[index] ?? false}
                                  disabled={
                                    savedPassengersLoading ||
                                    !savedPassengersAvailable ||
                                    Boolean(selectedPassengerByIndex[index]) &&
                                      !Object.keys(touchedTravellerFieldsByIndex[index] ?? {}).length
                                  }
                                  onChange={(event) =>
                                    setSavePassengerByIndex((current) => ({
                                      ...current,
                                      [index]: event.target.checked,
                                    }))
                                  }
                                  className="h-4 w-4 rounded border-neutral-300 text-brand-orange focus:ring-brand-orange"
                                />
                                <span>
                                  {selectedPassengerByIndex[index]
                                    ? 'Update this saved passenger'
                                    : 'Save this passenger for future bookings'}
                                </span>
                              </label>
                            </div>

                            {index === 0 && (
                              <div className="space-y-3 rounded-lg border border-neutral-200 bg-navy-50/40 p-3 sm:p-4">
                                <div className="border-b border-neutral-200 pb-2.5">
                                  <h3 className="flex items-center gap-2 text-sm font-semibold text-navy-950 sm:text-base">
                                    <Mail
                                      className="h-4 w-4 text-brand-orange"
                                      aria-hidden
                                    />
                                    Contact Information
                                  </h3>
                                  <p className="mt-1 text-xs text-neutral-500">
                                    Shared with the airline for booking updates
                                    and confirmations.
                                  </p>
                                </div>

                                <div className="grid gap-3 sm:grid-cols-2">
                                  <div>
                                    <label className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-neutral-600">
                                      Email address <Required />
                                    </label>
                                    <input
                                      type="email"
                                      required
                                      autoComplete="email"
                                      placeholder="customer@example.com"
                                      value={contact.customerEmail}
                                      onChange={(event) =>
                                        changeContact('customerEmail', event.target.value)
                                      }
                                      className={fieldClass}
                                    />
                                  </div>
                                  <div>
                                    <label className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-neutral-600">
                                      Phone number <Required />
                                    </label>
                                    <div className="flex gap-2">
                                      <CountrySelector
                                        type="phone"
                                        value={contact.phoneCountryCode}
                                        countries={PHONE_COUNTRIES}
                                        placeholder="Code"
                                        ariaLabel="Country calling code"
                                        className="w-32 shrink-0"
                                        triggerClassName="h-[42px]"
                                        onChange={(dialCode) =>
                                          changeContact('phoneCountryCode', dialCode)
                                        }
                                      />
                                      <div className="min-w-0 flex-1">
                                        <input
                                          type="tel"
                                          required
                                          placeholder="01XXXXXXXXX"
                                          value={contact.phone}
                                          onChange={(event) =>
                                            changeContact(
                                              'phone',
                                              event.target.value.replace(/\D/g, '')
                                            )
                                          }
                                          className={fieldClass}
                                        />
                                        {contact.phone &&
                                          contact.phone.length < 10 && (
                                            <p className="mt-1 text-xs text-brand-orange">
                                              Phone number must be at least 10
                                              digits
                                            </p>
                                          )}
                                      </div>
                                    </div>
                                  </div>

                                </div>
                              </div>
                            )}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </section>

              {expired && (
                <p
                  role="alert"
                  className="rounded-lg bg-amber-50 p-3 text-sm text-amber-900 ring-1 ring-amber-200"
                >
                  This fare quote has expired. Search again to price this trip.
                </p>
              )}
              <button
                type="submit"
                disabled={expired || savingPassengers}
                className="flex w-full items-center justify-center gap-2 rounded-lg bg-brand-orange px-4 py-3 text-sm font-semibold text-navy-950 transition hover:bg-brand-orange-dark hover:text-white disabled:cursor-not-allowed disabled:opacity-50"
              >
                {expired
                  ? 'Quote expired'
                  : savingPassengers
                    ? 'Saving passenger…'
                    : 'Continue'}
                {!expired && !savingPassengers && <ArrowRight className="h-5 w-5" aria-hidden />}
              </button>
            </form>
          ) : (
            <div className="space-y-4">
              <ReviewCard
                title={`Passengers (${travellers.length})`}
                icon={Users}
                open={passengersOpen}
                onToggle={() => setPassengersOpen((value) => !value)}
                action={
                  <button
                    type="button"
                    onClick={() => setStep('details')}
                    className="inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-sm font-semibold text-brand-orange-dark transition hover:bg-brand-orange-light"
                  >
                    <ArrowLeft className="h-4 w-4" aria-hidden />
                    Edit
                  </button>
                }
              >
                <div className="space-y-3 p-4 sm:p-5">
                  {travellerSummary.map(({ key, name, traveller }, index) => (
                    <div
                      key={key}
                      className="rounded-lg border border-neutral-200 p-4"
                    >
                      <div className="flex flex-wrap items-start justify-between gap-2">
                        <div className="min-w-0">
                          <p className="text-base font-bold text-navy-950">
                            {[traveller.title, name].filter(Boolean).join(' ') ||
                              `Passenger ${index + 1}`}
                          </p>
                          <p className="mt-0.5 text-xs text-neutral-500">
                            Passenger {index + 1}
                          </p>
                        </div>
                        <div className="flex shrink-0 flex-wrap gap-2">
                          <span className="rounded-full bg-brand-orange-light px-2.5 py-0.5 text-[11px] font-semibold text-brand-orange-dark">
                            {LABELS[traveller.passengerType]}
                          </span>
                          <span className="rounded-full border border-neutral-300 px-2.5 py-0.5 text-[11px] font-semibold text-neutral-600">
                            {traveller.gender}
                          </span>
                        </div>
                      </div>

                      <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                        <ReviewFact
                          label="Date of birth"
                          value={formatReviewDate(traveller.dateOfBirth)}
                          icon={CalendarDays}
                        />
                        <ReviewFact
                          label="Nationality"
                          value={traveller.nationality}
                        />
                        {passportRequired && (
                          <>
                            <ReviewFact
                              label="Passport number"
                              value={traveller.passportNumber || '--'}
                            />
                            <ReviewFact
                              label="Passport expiry"
                              value={formatReviewDate(traveller.passportExpiry)}
                              icon={CalendarDays}
                            />
                          </>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </ReviewCard>

              <ReviewCard
                title="Contact Information"
                icon={Mail}
                open={contactOpen}
                onToggle={() => setContactOpen((value) => !value)}
              >
                <div className="p-4 sm:p-5">
                  <div className="rounded-lg border border-neutral-200 p-4">
                    <p className="text-sm font-bold text-navy-950">
                      Primary Booking Contact
                    </p>
                    <p className="mt-0.5 text-xs text-neutral-500">
                      These details will be shared with the airline for booking updates
                      and confirmations.
                    </p>

                    <div className="mt-4 grid gap-3 sm:grid-cols-2">
                      <div>
                        <label className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-neutral-600">
                          Email address <Required />
                        </label>
                        <input
                          type="email"
                          value={contact.customerEmail}
                          onChange={(event) =>
                            changeContact('customerEmail', event.target.value)
                          }
                          className={fieldClass}
                        />
                      </div>
                      <div>
                        <label className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-neutral-600">
                          Phone number <Required />
                        </label>
                        <div className="flex gap-2">
                          <CountrySelector
                            type="phone"
                            value={contact.phoneCountryCode}
                            countries={PHONE_COUNTRIES}
                            placeholder="Code"
                            ariaLabel="Country calling code"
                            className="w-32 shrink-0"
                            triggerClassName="h-[42px]"
                            onChange={(dialCode) =>
                              changeContact('phoneCountryCode', dialCode)
                            }
                          />
                          <input
                            type="tel"
                            value={contact.phone}
                            placeholder="01XXXXXXXXX"
                            onChange={(event) =>
                              changeContact('phone', event.target.value.replace(/\D/g, ''))
                            }
                            className={`${fieldClass} min-w-0 flex-1`}
                          />
                        </div>
                        {contact.phone && contact.phone.length < 10 && (
                          <p className="mt-1 text-xs text-brand-orange">
                            Phone number must be at least 10 digits
                          </p>
                        )}
                      </div>
                    </div>
                  </div>
                </div>
              </ReviewCard>

              {error && (
                <p
                  role="alert"
                  className="rounded-lg bg-red-50 p-3 text-sm text-red-800 ring-1 ring-red-200"
                >
                  {error}
                </p>
              )}
            </div>
          )}
        </div>

        <CheckoutSummary
          attempt={attempt}
          errors={errors}
          {...(review && {
            actions: (
              <div className="space-y-2 pt-1">
                {attempt.directTicketing && !attempt.ticketingEnabled ? (
                  <p className="rounded-md bg-blue-50 p-2.5 text-xs text-blue-900 ring-1 ring-blue-200">
                    This fare is issued and charged the moment it is booked and
                    cannot be cancelled. Instant ticket issuing is not switched
                    on yet, so it cannot be completed online.
                  </p>
                ) : attempt.directTicketing ? (
                  <p className="rounded-md bg-red-50 p-2.5 text-xs font-medium text-red-900 ring-1 ring-red-200">
                    Instant purchase: confirming will reserve the full amount
                    from your wallet and immediately ask the airline to issue
                    the ticket. There is no hold or online cancellation step.
                  </p>
                ) : (
                  !attempt.submissionEnabled && (
                    <p className="rounded-md bg-amber-50 p-2.5 text-xs text-amber-900 ring-1 ring-amber-200">
                      Supplier hold submission remains disabled until
                      operational approval.
                    </p>
                  )
                )}
                {expired && (
                  <p
                    role="alert"
                    className="rounded-md bg-amber-50 p-2.5 text-xs text-amber-900 ring-1 ring-amber-200"
                  >
                    This fare quote has expired. Search again to price this
                    trip.
                  </p>
                )}

                <button
                  type="button"
                  onClick={() => void submit()}
                  disabled={bookingBlocked || submitting}
                  className="flex w-full items-center justify-center gap-2 rounded-lg bg-brand-orange px-4 py-3 text-sm font-semibold text-navy-950 transition hover:bg-brand-orange-dark hover:text-white disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {submitting ? (
                    <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
                  ) : (
                    <ShieldCheck className="h-4 w-4" aria-hidden />
                  )}
                  {attempt.directTicketing
                    ? 'Book and issue ticket'
                    : 'Confirm Booking'}
                </button>

                <button
                  type="button"
                  onClick={() => {
                    setStep('details');
                    window.scrollTo({ top: 0, behavior: 'smooth' });
                  }}
                  className="flex w-full items-center justify-center gap-2 rounded-lg border border-neutral-300 bg-white px-4 py-2.5 text-sm font-semibold text-navy-950 transition hover:bg-navy-50"
                >
                  <ArrowLeft className="h-4 w-4" aria-hidden />
                  Back to traveller details
                </button>

                <p className="text-center text-[11px] leading-relaxed text-neutral-500">
                  By confirming, you agree to our{' '}
                  <Link
                    href="/terms"
                    className="font-semibold text-brand-orange-dark hover:underline"
                  >
                    Terms &amp; Conditions
                  </Link>
                  .
                </p>
              </div>
            ),
          })}
        />
      </div>

    </div>
  );
}
