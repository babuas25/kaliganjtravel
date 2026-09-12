import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import ts from "typescript";

const read = (...parts) =>
  fs.readFileSync(path.join(process.cwd(), ...parts), "utf8");

function loadTypeScript(source, requireModule) {
  const output = ts.transpileModule(source, {
    compilerOptions: {
      esModuleInterop: true,
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText;
  const loaded = { exports: {} };
  Function("require", "module", "exports", output)(
    requireModule,
    loaded,
    loaded.exports,
  );
  return loaded.exports;
}

const airports = JSON.parse(read("airports.json"));
const country = loadTypeScript(read("lib", "airports", "country.ts"), (id) => {
  if (id === "server-only") return {};
  if (id === "@/airports.json") return airports;
  throw new Error(`Unexpected country module dependency: ${id}`);
});

const normalizer = loadTypeScript(
  read("lib", "impexp", "normalize.ts"),
  (id) => {
    if (id === "@/lib/airports/country") return country;
    if (id === "@/lib/flights/booking") {
      return {
        BOOKING_CONTACT_DEFAULTS: {
          cityName: "Dhaka",
          countryCode: "BD",
          email: "sales@example.com",
        },
      };
    }
    throw new Error(`Unexpected normalizer dependency: ${id}`);
  },
);

const manualNormalizer = loadTypeScript(
  read("lib", "impexp", "manual-normalize.ts"),
  (id) => {
    if (id === "@/lib/airports/country") return country;
    throw new Error(`Unexpected manual normalizer dependency: ${id}`);
  },
);

function currentSupplierPayload(to) {
  return {
    response: {
      airlinesPnr: ["ABC123"],
      bookingRefNumber: "ABC123",
      currency: "BDT",
      itinerary: {
        carrierCode: "BS",
        carrierName: "US-Bangla Airlines",
        legs: [
          {
            from: "DAC",
            to,
            segments: [
              {
                airline: "US-Bangla Airlines",
                airlineCode: "BS",
                arrival: "2026-08-28T08:20:00",
                departure: "2026-08-28T07:15:00",
                flightNumber: "141",
                from: "DAC",
                to,
              },
            ],
          },
        ],
      },
      lifecycleStatus: "On Hold",
      passengerCounts: { ADT: 1 },
      passengers: {
        travellers: [
          {
            dateOfBirth: "1990-10-26",
            documentInfo: { documentNumber: "A01234567" },
            firstName: "SAMPLE",
            gender: "Male",
            lastName: "AHMED",
            passengerType: "ADT",
          },
        ],
      },
      pnr: "ABC123",
      totalPrice: 5000,
      travelDate: "2026-08-28",
    },
  };
}

const domestic = normalizer.normalizeSupplierBooking(
  currentSupplierPayload("CXB"),
  "US_BANGLA",
  "ABC123",
);
assert.equal(
  domestic.passportRequired,
  false,
  "DAC to CXB must be domestic even when the passenger has a passport",
);

const international = normalizer.normalizeSupplierBooking(
  currentSupplierPayload("DXB"),
  "US_BANGLA",
  "ABC123",
);
assert.equal(
  international.passportRequired,
  true,
  "DAC to DXB must be international",
);

const ndcDomestic = normalizer.normalizeSupplierBooking(
  {
    response: {
      bookingRefNumber: "NDC123",
      contactDetail: {},
      orderItem: [
        {
          fareDetailList: [],
          paxSegmentList: [
            {
              paxSegment: {
                arrival: {
                  aircraftScheduledDateTime: "2026-08-28T08:20:00",
                  iatA_LocationCode: "CXB",
                },
                departure: {
                  aircraftScheduledDateTime: "2026-08-28T07:15:00",
                  iatA_LocationCode: "DAC",
                },
                marketingCarrierInfo: {
                  carrierDesigCode: "BS",
                  carrierName: "US-Bangla Airlines",
                  marketingCarrierFlightNumber: "141",
                },
              },
            },
          ],
          price: { totalPayable: { currency: "BDT", total: 5000 } },
        },
      ],
      orderStatus: "On Hold",
      paxList: [
        {
          individual: {
            birthdate: "1990-10-26",
            gender: "Male",
            givenName: "SAMPLE",
            identityDoc: { identityDocID: "A01234567" },
            surname: "AHMED",
          },
          ptc: "ADT",
        },
      ],
    },
  },
  "US_BANGLA",
  "NDC123",
);
assert.equal(
  ndcDomestic.passportRequired,
  false,
  "NDC imports must also classify DAC to CXB as domestic",
);

function manualPayload(to, passportRequired) {
  return {
    initialStatus: "on-hold",
    externalReference: "MANUAL-123",
    currency: "BDT",
    supplierPayableAmount: "5000",
    travelDate: "2026-08-28",
    refundable: false,
    passportRequired,
    pnr: "ABC123",
    airlinePnr: "ABC123",
    supplierMessage: "",
    passengers: {
      travellers: [
        {
          passengerType: "ADT",
          title: "Mr",
          firstName: "SAMPLE",
          lastName: "AHMED",
          gender: "Male",
          dateOfBirth: "1990-10-26",
          nationality: "BD",
          passportNumber: "A01234567",
        },
      ],
      contact: {},
    },
    fares: [
      {
        passengerType: "ADT",
        basePrice: "4000",
        taxes: "1000",
        ait: "0",
        serviceMargin: "0",
        totalPrice: "5000",
      },
    ],
    segments: [
      {
        leg: 1,
        carrierCode: "BS",
        carrierName: "US-Bangla Airlines",
        flightNumber: "141",
        from: { code: "DAC", city: "Dhaka", airport: "Hazrat Shahjalal International Airport", terminal: "" },
        to: { code: to, city: to === "CXB" ? "Cox's Bazar" : "Dubai", airport: "", terminal: "" },
        departureAt: "2026-08-28T07:15:00+06:00",
        arrivalAt: "2026-08-28T08:20:00+06:00",
        cabin: "Economy",
        duration: "1h 5m",
        bookingClass: "O",
        baggage: "20KG",
        handBaggage: "7KG",
        aircraft: "ATR 72",
      },
    ],
  };
}

const manualDomestic = manualNormalizer.normalizeManualBooking(
  manualPayload("CXB", true),
);
assert.equal(
  manualDomestic.passportRequired,
  false,
  "Manual DAC to CXB imports must ignore a stale true document flag",
);

const manualInternational = manualNormalizer.normalizeManualBooking(
  manualPayload("DXB", false),
);
assert.equal(
  manualInternational.passportRequired,
  true,
  "Manual DAC to DXB imports must ignore a stale false document flag",
);

console.log("IMP/EXP trip-scope verification passed.");
