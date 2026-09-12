import { z } from 'zod';

import { TRIPLOVER_REFERENCE_IMPORT_SUPPLIERS } from '@/lib/triplover/config';

const supplierReference = z
  .string()
  .trim()
  .toUpperCase()
  .regex(
    /^(?:FST|TOT|TLL)\d{18}$/,
    'Enter a valid FST, TOT, or TLL supplier reference.',
  );

const supplierReferenceIdentitySchema = z.object({
  supplierAccount: z.enum(TRIPLOVER_REFERENCE_IMPORT_SUPPLIERS),
  supplierReference,
});

export const supplierReferenceLookupSchema = supplierReferenceIdentitySchema.extend({
  assignedToUserId: z.string().trim().min(1, 'Assign a booking owner.').max(255),
});

export const supplierReferenceImportSchema = supplierReferenceIdentitySchema
  .extend({
    assignedToUserId: z.string().trim().min(1, 'Assign a booking owner.').max(255),
    pricingConfirmation: z.string().trim().min(80, 'Retrieve and confirm the current price.'),
    requestId: z.string().uuid('Use a valid import request ID.'),
    importDecision: z.enum(['import_only', 'import_and_charge']),
    chargeAuthorizationId: z.string().uuid().nullable().optional(),
  })
  .superRefine((value, context) => {
    if (value.importDecision === 'import_and_charge' && !value.chargeAuthorizationId) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['chargeAuthorizationId'],
        message: 'Import & Charge requires a prior charge authorization.',
      });
    }
    if (value.importDecision === 'import_only' && value.chargeAuthorizationId) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['chargeAuthorizationId'],
        message: 'Import Only cannot include a charge authorization.',
      });
    }
  });

export const supplierReferenceChargeAuthorizationSchema =
  supplierReferenceIdentitySchema.extend({
    assignedToUserId: z.string().trim().min(1, 'Assign a booking owner.').max(255),
    pricingConfirmation: z.string().trim().min(80, 'Retrieve and confirm the current price.'),
    requestId: z.string().uuid('Use a valid authorization request ID.'),
  });

export type SupplierReferenceLookupInput = z.infer<
  typeof supplierReferenceLookupSchema
>;
