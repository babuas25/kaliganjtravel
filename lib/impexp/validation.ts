import { z } from "zod";

import { IMPORT_PROVIDERS } from "@/lib/impexp/types";

const optionalDate = z.union([
  z.literal(""),
  z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use a valid date."),
]);

export const importLookupSchema = z.object({
  provider: z.enum(IMPORT_PROVIDERS),
  orderReference: z.string().trim().min(2).max(100),
  originalReference: z.string().trim().max(100).optional().or(z.literal("")),
  lastName: z.string().trim().min(1).max(100),
  sourceUrl: z.string().trim().url().max(2_000).optional().or(z.literal("")),
});
export const importBookingSchema = importLookupSchema.extend({
  assignedToUserId: z.string().trim().min(1, "Assign a user.").max(255),
  userPayableAmount: z
    .string()
    .trim()
    .regex(
      /^\d{1,12}(?:\.\d{1,2})?$/,
      "User Payable Amount must be a positive amount with no more than two decimals.",
    ),
  passengerInfo: z
    .array(
      z.object({
        paxType: z.enum(["ADT", "CHD", "INF"]),
        gender: z.enum(["", "Male", "Female"]),
        birthdate: optionalDate,
        nationality: z
          .string()
          .trim()
          .max(3)
          .regex(/^[A-Za-z]*$/, "Nationality must be a country code."),
        identityDocID: z.string().trim().max(100),
        identityDocExpiry: optionalDate,
      }),
    )
    .max(20)
    .optional(),
});

export const importChargeAuthorizationSchema = importBookingSchema.extend({
  requestId: z.string().uuid("Use a valid charge authorization request ID."),
});

export const importBookingDecisionSchema = importBookingSchema
  .extend({
    requestId: z.string().uuid("Use a valid import request ID."),
    importDecision: z.enum(["import_only", "import_and_charge"]),
    chargeAuthorizationId: z.string().uuid().nullable().optional(),
  })
  .superRefine((value, context) => {
    if (
      value.importDecision === "import_and_charge" &&
      !value.chargeAuthorizationId
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["chargeAuthorizationId"],
        message: "Import & Charge requires a prior charge authorization.",
      });
    }
    if (
      value.importDecision === "import_only" &&
      value.chargeAuthorizationId
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["chargeAuthorizationId"],
        message: "Import Only cannot include a charge authorization.",
      });
    }
  });
