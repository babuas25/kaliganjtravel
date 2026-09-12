import { BOOKING_CONTACT_DEFAULTS } from "@/lib/flights/booking";
import { passportRequiredForItinerary } from "@/lib/airports/country";
import type {
  BookedItinerary,
  BookingGender,
  BookingPassengerType,
  BookingTitle,
  BookingTraveller,
} from "@/lib/flights/booking";
import type { ItineraryLeg, ItinerarySegment } from "@/lib/flights/types";
import type {
  BookingStatus,
  StoredBookingStatus,
} from "@/lib/flights/booking-status";
import type {
  ImportPassengerSupplement,
  ImportProvider,
  NormalizedBookingImport,
} from "@/lib/impexp/types";

type UnknownRecord = Record<string, unknown>;

type NormalizeImportOptions = {
  originalReference?: string | null;
  passengerInfo?: ImportPassengerSupplement[];
};

function record(value: unknown): UnknownRecord {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as UnknownRecord)
    : {};
}

function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function firstText(...values: unknown[]): string {
  for (const value of values) {
    const candidate = text(value);
    if (candidate) return candidate;
  }
  return "";
}

function uniqueStrings(...values: unknown[]): string[] {
  return Array.from(
    new Set(
      values
        .flatMap((value) => (Array.isArray(value) ? value : [value]))
        .map(text)
        .filter(Boolean),
    ),
  );
}

function amount(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? Math.max(0, parsed) : 0;
}

function passengerType(value: unknown): BookingPassengerType {
  const type = text(value).toUpperCase();
  if (type === "CHD" || type === "CNN") return type;
  if (type === "INF" || type === "INS") return type;
  return "ADT";
}

function passengerGender(value: unknown): BookingGender {
  return /^f/i.test(text(value)) ? "Female" : "Male";
}

function passengerTitle(value: unknown, gender: BookingGender): BookingTitle {
  const title = text(value).replace(/\.$/, "").toLowerCase();
  if (title === "mrs") return "Mrs";
  if (title === "miss") return "Miss";
  if (title === "ms") return "Ms";
  if (title === "mstr" || title === "master") return "Mstr";
  return gender === "Female" ? "Ms" : "Mr";
}

function statusFor(
  value: string,
  ticketNumbers: string[],
): { lifecycleStatus: BookingStatus; storedStatus: StoredBookingStatus } {
  const status = value.toLowerCase().replace(/[\s_-]+/g, "");
  // Terminal negative states take precedence over ticket presence. Refunded
  // bookings commonly retain their original ticket/document numbers.
  if (
    status.includes("cancel") ||
    status.includes("refund") ||
    status === "void" ||
    status === "voided"
  ) {
    return { lifecycleStatus: "cancelled", storedStatus: "cancelled" };
  }
  if (status.includes("expire")) {
    return { lifecycleStatus: "expired", storedStatus: "on-hold" };
  }
  // This must precede the positive "confirmed" match.
  if (
    status.includes("unconfirm") ||
    status.includes("notconfirm") ||
    status.includes("reject") ||
    status === "failed"
  ) {
    return { lifecycleStatus: "unconfirmed", storedStatus: "on-hold" };
  }
  if (
    status.includes("inprogress") ||
    status.includes("processing") ||
    status.includes("ticketing")
  ) {
    return { lifecycleStatus: "in-progress", storedStatus: "in-progress" };
  }
  if (
    ticketNumbers.length > 0 ||
    status.includes("confirm") ||
    status === "ticketed" ||
    status === "issued" ||
    status === "completed"
  ) {
    return { lifecycleStatus: "confirmed", storedStatus: "confirmed" };
  }
  if (
    status.includes("hold") ||
    status === "held" ||
    status.includes("book") ||
    status === "created"
  ) {
    return { lifecycleStatus: "on-hold", storedStatus: "on-hold" };
  }
  return { lifecycleStatus: "pending", storedStatus: "pending" };
}

function lifecycleWithEvidence(
  mapped: ReturnType<typeof statusFor>,
  airlinesPnr: string[],
  ticketingDeadlineAt: string | null,
): BookingStatus {
  if (mapped.storedStatus !== "on-hold") return mapped.lifecycleStatus;
  if (airlinesPnr.length === 0) return "unconfirmed";
  const deadline = ticketingDeadlineAt
    ? Date.parse(ticketingDeadlineAt)
    : Number.NaN;
  if (Number.isFinite(deadline) && deadline <= Date.now()) return "expired";
  return "on-hold";
}

function isoDate(value: string): string | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

function ticketNumbersOf(individual: UnknownRecord): string[] {
  const documents = Array.isArray(individual.ticketDocument)
    ? individual.ticketDocument
    : individual.ticketDocument
      ? [individual.ticketDocument]
      : [];
  return documents
    .map((item) => {
      const document = record(item);
      return text(document.ticketDocNbr) || text(document.ticketNumber);
    })
    .filter(Boolean);
}

function mapSegment(value: unknown): ItinerarySegment | null {
  const segment = record(record(value).paxSegment || value);
  const departure = record(segment.departure);
  const arrival = record(segment.arrival);
  const marketing = record(segment.marketingCarrierInfo);
  const aircraft = record(segment.iatA_AircraftType);
  const from = text(departure.iatA_LocationCode).toUpperCase();
  const to = text(arrival.iatA_LocationCode).toUpperCase();
  if (!from || !to) return null;

  return {
    from,
    fromAirport: from,
    to,
    toAirport: to,
    departure: text(departure.aircraftScheduledDateTime),
    arrival: text(arrival.aircraftScheduledDateTime),
    airline: text(marketing.carrierName) || text(marketing.carrierDesigCode),
    airlineCode: text(marketing.carrierDesigCode).toUpperCase(),
    flightNumber:
      text(marketing.marketingCarrierFlightNumber) ||
      text(segment.flightNumber),
    cabinClass: text(segment.cabinType),
    bookingClass: text(segment.rbd),
    duration: text(segment.duration) || null,
    aircraft: text(aircraft.iatA_AircraftTypeCode) || null,
    baggage: null,
    handBaggage: null,
    seatsLeft: null,
  };
}

function itineraryOf(orderItems: UnknownRecord[]): BookedItinerary {
  const grouped: Array<{ key: string; segments: ItinerarySegment[] }> = [];
  const allSegments: UnknownRecord[] = [];

  orderItems.forEach((item) => {
    list(item.paxSegmentList).forEach((entry) =>
      allSegments.push(record(entry)),
    );
  });

  allSegments.forEach((entry) => {
    const raw = record(entry.paxSegment || entry);
    const groupValue = raw.segmentGroup;
    const key =
      typeof groupValue === "number" || typeof groupValue === "string"
        ? String(groupValue)
        : raw.returnJourney === true
          ? "return"
          : "outbound";
    let group = grouped.find((candidate) => candidate.key === key);
    if (!group) {
      group = { key, segments: [] };
      grouped.push(group);
    }
    const mapped = mapSegment(entry);
    if (mapped) group.segments.push(mapped);
  });

  const legs: ItineraryLeg[] = grouped
    .filter((group) => group.segments.length > 0)
    .map((group) => {
      const first = group.segments[0]!;
      const last = group.segments[group.segments.length - 1]!;
      return {
        from: first.from,
        to: last.to,
        stops: Math.max(0, group.segments.length - 1),
        segments: group.segments,
        duration: null,
        departure: first.departure,
        arrival: last.arrival,
      };
    });

  const firstItem = orderItems[0] ?? {};
  const firstSegment = legs[0]?.segments[0];
  return {
    carrierCode:
      text(firstItem.validatingCarrier).toUpperCase() ||
      firstSegment?.airlineCode ||
      "",
    carrierName: firstSegment?.airline || text(firstItem.validatingCarrier),
    refundable: firstItem.refundable === true,
    legs,
  };
}

function supplierResponseOf(payload: unknown): {
  envelope: UnknownRecord;
  response: UnknownRecord;
} {
  const root = record(payload);
  const apiResponse = record(root.apiResponse);
  const envelope = Object.keys(apiResponse).length > 0 ? apiResponse : root;
  const ndcResponse = record(envelope.response || envelope.Response);
  if (
    Array.isArray(ndcResponse.orderItem) ||
    Array.isArray(ndcResponse.paxList)
  ) {
    return { envelope, response: ndcResponse };
  }

  const result = record(envelope.result || envelope.Result);
  const data = record(envelope.data);
  const candidates = [
    record(result.item1 || result.Item1),
    record(data.item1 || data.Item1),
    data,
    ndcResponse,
    result,
    envelope,
  ];
  return {
    envelope,
    response:
      candidates.find((candidate) => Object.keys(candidate).length > 0) ?? {},
  };
}

function storedItinerary(value: unknown): BookedItinerary | null {
  const raw = record(value);
  const legs = list(raw.legs)
    .map((legValue): ItineraryLeg | null => {
      const leg = record(legValue);
      const segments = list(leg.segments)
        .map((segmentValue): ItinerarySegment | null => {
          const segment = record(segmentValue);
          const from = firstText(
            segment.from,
            segment.origin,
            segment.departureCode,
          ).toUpperCase();
          const to = firstText(
            segment.to,
            segment.destination,
            segment.arrivalCode,
          ).toUpperCase();
          if (!from || !to) return null;
          return {
            from,
            fromAirport: firstText(segment.fromAirport, from),
            to,
            toAirport: firstText(segment.toAirport, to),
            departure: firstText(segment.departure, segment.departureDateTime),
            arrival: firstText(segment.arrival, segment.arrivalDateTime),
            airline: firstText(segment.airline, segment.carrierName),
            airlineCode: firstText(
              segment.airlineCode,
              segment.carrierCode,
            ).toUpperCase(),
            flightNumber: firstText(segment.flightNumber),
            cabinClass: firstText(segment.cabinClass, segment.cabin),
            bookingClass: firstText(segment.bookingClass, segment.rbd),
            duration: firstText(segment.duration) || null,
            aircraft: firstText(segment.aircraft) || null,
            baggage: firstText(segment.baggage) || null,
            handBaggage: firstText(segment.handBaggage) || null,
            seatsLeft: Number.isFinite(Number(segment.seatsLeft))
              ? Number(segment.seatsLeft)
              : null,
          };
        })
        .filter((segment): segment is ItinerarySegment => Boolean(segment));
      if (segments.length === 0) return null;
      return {
        from: firstText(leg.from, segments[0]!.from).toUpperCase(),
        to: firstText(leg.to, segments[segments.length - 1]!.to).toUpperCase(),
        stops: Number.isFinite(Number(leg.stops))
          ? Math.max(0, Number(leg.stops))
          : Math.max(0, segments.length - 1),
        segments,
        duration: firstText(leg.duration) || null,
        departure: firstText(leg.departure, segments[0]!.departure),
        arrival: firstText(leg.arrival, segments[segments.length - 1]!.arrival),
      };
    })
    .filter((leg): leg is ItineraryLeg => Boolean(leg));
  if (legs.length === 0) return null;
  const firstSegment = legs[0]!.segments[0]!;
  return {
    carrierCode: firstText(
      raw.carrierCode,
      firstSegment.airlineCode,
    ).toUpperCase(),
    carrierName: firstText(raw.carrierName, firstSegment.airline),
    refundable: raw.refundable === true,
    legs,
  };
}

function fareSnapshots(value: unknown) {
  return list(value)
    .map((entry) => {
      const fare = record(entry);
      const basePrice = amount(fare.basePrice ?? fare.baseFare);
      const taxes = amount(fare.taxes ?? fare.tax);
      const ait = amount(fare.ait);
      const serviceMargin = amount(fare.serviceMargin ?? fare.markup);
      return {
        passengerType: passengerType(fare.passengerType ?? fare.paxType),
        count: Math.max(
          1,
          Math.round(amount(fare.count ?? fare.paxCount) || 1),
        ),
        basePrice,
        taxes,
        ait,
        serviceMargin,
        totalPrice:
          amount(fare.totalPrice ?? fare.subTotal) ||
          basePrice + taxes + ait + serviceMargin,
      };
    })
    .filter((fare) => fare.totalPrice > 0 || fare.basePrice > 0);
}

function applyPassengerSupplements(
  travellers: BookingTraveller[],
  supplements: ImportPassengerSupplement[],
): BookingTraveller[] {
  if (supplements.length > travellers.length) {
    throw new Error(
      `Passenger details contain ${supplements.length} rows, but the airline returned ${travellers.length} passengers.`,
    );
  }

  return travellers.map((traveller, index) => {
    const supplement = supplements[index];
    if (!supplement) return traveller;

    return {
      ...traveller,
      passengerType: supplement.paxType,
      ...(supplement.gender ? { gender: supplement.gender } : {}),
      ...(supplement.birthdate ? { dateOfBirth: supplement.birthdate } : {}),
      ...(supplement.nationality.trim()
        ? { nationality: supplement.nationality.trim().toUpperCase() }
        : {}),
      ...(supplement.identityDocID.trim()
        ? { passportNumber: supplement.identityDocID.trim().toUpperCase() }
        : {}),
      ...(supplement.identityDocExpiry
        ? { passportExpiry: supplement.identityDocExpiry }
        : {}),
    };
  });
}

function passengerCountsOf(
  travellers: BookingTraveller[],
): Partial<Record<BookingPassengerType, number>> {
  const counts: Partial<Record<BookingPassengerType, number>> = {};
  travellers.forEach((traveller) => {
    counts[traveller.passengerType] =
      (counts[traveller.passengerType] ?? 0) + 1;
  });
  return counts;
}

function currentSupplierTravellers(response: UnknownRecord) {
  const passengerSnapshot = record(
    response.passengers || response.passengerSnapshot,
  );
  const rows = list(
    passengerSnapshot.travellers ||
      response.travellers ||
      response.passengerInfoes ||
      response.passengerInfos,
  );
  const travellers = rows.map((entry) => {
    const outer = record(entry);
    const row = record(outer.passengerInfo || outer);
    const name = record(row.nameElement || row.name);
    const document = record(row.documentInfo || row.identityDoc);
    const gender = passengerGender(row.gender);
    return {
      passengerType: passengerType(row.passengerType ?? row.paxType),
      title: passengerTitle(name.title ?? row.title, gender),
      firstName: firstText(name.firstName, row.firstName, row.givenName),
      lastName: firstText(name.lastName, row.lastName, row.surname),
      gender,
      dateOfBirth: firstText(row.dateOfBirth, row.birthdate),
      ...(firstText(document.documentNumber, document.identityDocID)
        ? {
            passportNumber: firstText(
              document.documentNumber,
              document.identityDocID,
            ),
          }
        : {}),
      ...(firstText(document.expireDate, document.expiryDate)
        ? {
            passportExpiry: firstText(
              document.expireDate,
              document.expiryDate,
            ).slice(0, 10),
          }
        : {}),
      ...(firstText(document.issuingCountry, document.issuingCountryCode)
        ? {
            issuingCountry: firstText(
              document.issuingCountry,
              document.issuingCountryCode,
            ).toUpperCase(),
          }
        : {}),
      nationality:
        firstText(row.nationality, document.issuingCountry).toUpperCase() ||
        "BD",
    };
  });
  const firstContact = record(
    passengerSnapshot.contact ||
      record(record(rows[0]).passengerInfo || rows[0]).contactInfo,
  );
  return {
    travellers,
    contact: {
      phone: firstText(firstContact.phone, firstContact.phoneNumber),
      phoneCountryCode: firstText(firstContact.phoneCountryCode) || "+880",
      customerEmail: firstText(firstContact.customerEmail, firstContact.email),
      email: BOOKING_CONTACT_DEFAULTS.email,
      countryCode:
        firstText(firstContact.countryCode) ||
        BOOKING_CONTACT_DEFAULTS.countryCode,
      cityName:
        firstText(firstContact.cityName) || BOOKING_CONTACT_DEFAULTS.cityName,
    },
  };
}

function currentSupplierTicketNumbers(response: UnknownRecord): string[] {
  return uniqueStrings(
    response.ticketNumbers,
    ...list(response.ticketInfoes).flatMap((entry) => {
      const ticket = record(entry);
      return [
        ticket.ticketNumbers,
        ticket.ticketNumber,
        record(ticket.ticketInfo).ticketNumbers,
      ];
    }),
  );
}

function normalizeCurrentSupplierBooking(
  envelope: UnknownRecord,
  response: UnknownRecord,
  provider: ImportProvider,
  requestedReference: string,
  options: NormalizeImportOptions,
): NormalizedBookingImport {
  const offer = record(response.offerSnapshot || response.offer);
  const pricing = record(response.pricingSnapshot || offer.pricing);
  const itinerary = storedItinerary(response.itinerary || offer.itinerary);
  if (!itinerary) {
    throw new Error(
      "The supplier booking response has no Kaliganj Travels itinerary snapshot.",
    );
  }
  const fares = fareSnapshots(response.fares || offer.fares);
  const passengerSnapshot = currentSupplierTravellers(response);
  const passengers = {
    ...passengerSnapshot,
    travellers: applyPassengerSupplements(
      passengerSnapshot.travellers,
      options.passengerInfo ?? [],
    ),
  };
  const passengerCounts = passengerCountsOf(passengers.travellers);
  const suppliedCounts = record(
    response.passengerCounts || offer.passengerCounts,
  );
  for (const type of ["ADT", "CHD", "CNN", "INF", "INS"] as const) {
    const count = Math.max(0, Math.round(amount(suppliedCounts[type])));
    if (count > 0) passengerCounts[type] = count;
  }

  const ticketNumbers = currentSupplierTicketNumbers(response);
  const rawStatus = firstText(
    response.lifecycleStatus,
    response.status,
    response.bookingStatus,
    response.orderStatus,
  );
  const statuses = statusFor(rawStatus, ticketNumbers);
  const supplierReference = firstText(
    response.bookingRefNumber,
    response.orderReference,
    response.pnr,
    requestedReference,
  ).toUpperCase();
  if (!supplierReference) {
    throw new Error("The supplier returned no booking reference.");
  }
  const pnr = firstText(response.pnr, supplierReference).toUpperCase();
  let airlinesPnr = uniqueStrings(
    response.airlinesPnr,
    response.airlinesPNR,
    response.airlinePNRs,
  ).map((value) => value.toUpperCase());
  if (statuses.lifecycleStatus === "unconfirmed") {
    airlinesPnr = [];
  } else if (airlinesPnr.length === 0 && pnr) {
    // Direct airline imports use their PNR as the airline locator.
    airlinesPnr = [pnr];
  }

  const importedAt =
    isoDate(
      firstText(
        envelope.respondedOn,
        response.respondedOn,
        response.bookedAt,
        response.createdAt,
      ),
    ) || new Date().toISOString();
  const ticketingTimeLimit =
    firstText(
      response.ticketingTimeLimit,
      response.lastTicketTime,
      response.ticketingDeadlineAt,
    ) || null;
  let ticketingDeadlineAt = ticketingTimeLimit
    ? isoDate(ticketingTimeLimit)
    : null;
  if (statuses.lifecycleStatus === "expired" && !ticketingDeadlineAt) {
    ticketingDeadlineAt = new Date(Date.now() - 1_000).toISOString();
  }
  const lifecycleStatus = lifecycleWithEvidence(
    statuses,
    airlinesPnr,
    ticketingDeadlineAt,
  );

  const totalPrice =
    amount(response.totalPrice) ||
    amount(pricing.sellingPrice) ||
    fares.reduce((sum, fare) => sum + fare.totalPrice, 0);
  const firstDeparture = itinerary.legs[0]!.departure;
  const travelDate =
    firstText(response.travelDate, offer.travelDate) ||
    firstDeparture.slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(travelDate)) {
    throw new Error("The supplier booking response has no valid travel date.");
  }

  return {
    provider,
    supplierReference,
    originalReference: options.originalReference?.trim().toUpperCase() || null,
    orderStatus: rawStatus || "Pending",
    lifecycleStatus,
    storedStatus: statuses.storedStatus,
    currency: firstText(response.currency, offer.currency, "BDT").toUpperCase(),
    totalPrice,
    passengerCounts,
    travelDate,
    itinerary,
    fares,
    passengers,
    // A passport on the passenger record does not make the flight
    // international. Imported bookings use the same airport-country rule as
    // ordinary bookings, including every connection in the itinerary.
    passportRequired: passportRequiredForItinerary(itinerary),
    pnr,
    airlinesPnr,
    ticketNumbers,
    ticketingTimeLimit,
    ticketingDeadlineAt,
    importedAt,
    supplierMessage: firstText(response.message, envelope.message) || null,
  };
}

export function normalizeSupplierBooking(
  payload: unknown,
  provider: ImportProvider,
  requestedReference: string,
  options: NormalizeImportOptions = {},
): NormalizedBookingImport {
  const { envelope, response } = supplierResponseOf(payload);
  const supplierReference =
    firstText(
      response.orderReference,
      response.bookingRefNumber,
      response.pnr,
    ).toUpperCase() || requestedReference.trim().toUpperCase();
  const orderItems = list(response.orderItem).map(record);
  if (orderItems.length === 0) {
    return normalizeCurrentSupplierBooking(
      envelope,
      response,
      provider,
      requestedReference,
      options,
    );
  }
  if (!supplierReference) {
    throw new Error("The supplier returned an incomplete booking record.");
  }

  const paxRows = list(response.paxList).map(record);
  const ticketNumbers: string[] = [];
  const airlineTravellers = paxRows.map((row) => {
    const individual = record(row.individual);
    const identity = record(individual.identityDoc);
    const gender = passengerGender(individual.gender);
    const type = passengerType(row.ptc);
    ticketNumbers.push(...ticketNumbersOf(individual));
    return {
      passengerType: type,
      title: passengerTitle(individual.title, gender),
      firstName: text(individual.givenName),
      lastName: text(individual.surname),
      gender,
      dateOfBirth: text(individual.birthdate),
      ...(text(identity.identityDocID)
        ? { passportNumber: text(identity.identityDocID) }
        : {}),
      ...(text(identity.expiryDate)
        ? { passportExpiry: text(identity.expiryDate).slice(0, 10) }
        : {}),
      ...(text(identity.issuingCountryCode)
        ? { issuingCountry: text(identity.issuingCountryCode).toUpperCase() }
        : {}),
      nationality:
        text(individual.nationality).toUpperCase() ||
        text(identity.issuingCountryCode).toUpperCase() ||
        "BD",
    };
  });
  const travellers = applyPassengerSupplements(
    airlineTravellers,
    options.passengerInfo ?? [],
  );
  const passengerCounts = passengerCountsOf(travellers);
  const itinerary = itineraryOf(orderItems);
  if (itinerary.legs.length === 0) {
    throw new Error("The supplier booking has no usable flight segments.");
  }

  const firstItem = orderItems[0] ?? {};
  const fareDetails = list(firstItem.fareDetailList).map((entry) =>
    record(record(entry).fareDetail || entry),
  );
  const fares = fareDetails.map((fare) => {
    const basePrice = amount(fare.baseFare);
    const taxes = amount(fare.tax) + amount(fare.otherFee) + amount(fare.vat);
    const total =
      amount(fare.subTotal) ||
      Math.max(0, basePrice + taxes - amount(fare.discount));
    return {
      passengerType: passengerType(fare.paxType),
      count: Math.max(1, Math.round(amount(fare.paxCount) || 1)),
      basePrice,
      taxes,
      ait: 0,
      serviceMargin: amount(fare.markup),
      totalPrice: total,
    };
  });
  const price = record(firstItem.price);
  const payable = record(price.totalPayable);
  const fareTotal = fares.reduce((sum, fare) => sum + fare.totalPrice, 0);
  const totalPrice = amount(payable.total) || fareTotal;
  const currency =
    text(payable.currency) ||
    text(payable.curreny) ||
    text(fareDetails[0]?.currency) ||
    "BDT";
  let airlinePnrs = Array.from(
    new Set(
      orderItems
        .flatMap((item) => list(item.paxSegmentList))
        .map((entry) =>
          text(record(record(entry).paxSegment || entry).airlinePNR),
        )
        .filter(Boolean),
    ),
  );
  const pnr =
    airlinePnrs[0] ||
    firstText(response.pnr, response.bookingRefNumber) ||
    supplierReference;
  const orderStatus =
    firstText(
      response.lifecycleStatus,
      response.status,
      response.bookingStatus,
      response.orderStatus,
    ) || "Pending";
  const statuses = statusFor(orderStatus, ticketNumbers);
  if (statuses.lifecycleStatus === "unconfirmed") {
    airlinePnrs = [];
  } else if (airlinePnrs.length === 0 && pnr) {
    airlinePnrs = [pnr];
  }
  const importedAt =
    isoDate(text(envelope.respondedOn)) || new Date().toISOString();
  const ticketingTimeLimit =
    firstText(
      response.paymentTimeLimit,
      response.ticketingTimeLimit,
      response.lastTicketTime,
    ) || null;
  let ticketingDeadlineAt = ticketingTimeLimit
    ? isoDate(ticketingTimeLimit)
    : null;
  if (statuses.lifecycleStatus === "expired" && !ticketingDeadlineAt) {
    ticketingDeadlineAt = new Date(Date.now() - 1_000).toISOString();
  }
  const lifecycleStatus = lifecycleWithEvidence(
    statuses,
    airlinePnrs,
    ticketingDeadlineAt,
  );
  const contact = record(response.contactDetail);

  return {
    provider,
    supplierReference,
    originalReference: options.originalReference?.trim().toUpperCase() || null,
    orderStatus,
    lifecycleStatus,
    storedStatus: statuses.storedStatus,
    currency: currency.toUpperCase(),
    totalPrice,
    passengerCounts,
    travelDate: itinerary.legs[0]!.departure.slice(0, 10),
    itinerary,
    fares,
    passengers: {
      travellers,
      contact: {
        phone: text(contact.phoneNumber),
        phoneCountryCode: "+880",
        customerEmail: text(contact.emailAddress),
        email: BOOKING_CONTACT_DEFAULTS.email,
        countryCode: BOOKING_CONTACT_DEFAULTS.countryCode,
        cityName: BOOKING_CONTACT_DEFAULTS.cityName,
      },
    },
    passportRequired: passportRequiredForItinerary(itinerary),
    pnr,
    airlinesPnr: airlinePnrs,
    ticketNumbers: Array.from(new Set(ticketNumbers.filter(Boolean))),
    ticketingTimeLimit,
    ticketingDeadlineAt,
    importedAt,
    supplierMessage: text(envelope.message) || null,
  };
}
