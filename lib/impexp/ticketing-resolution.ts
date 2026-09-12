import { z } from 'zod';

const dateTime = z.string().datetime({ offset: true });

export const importedTicketingResolutionSchema = z
  .object({
    requestId: z.string().uuid(),
    decision: z.enum(['confirm_ticketed', 'cancel']),
    moneyEffectConfirmed: z.literal(true),
    ticketing: z
      .object({
        ticketNumbers: z
          .array(z.string().trim().min(3).max(100))
          .min(1)
          .max(20),
        issuedAt: dateTime,
      })
      .optional(),
    cancellation: z
      .object({
        cancellationAt: dateTime,
        reason: z.string().trim().min(2).max(1_000),
        refundDisposition: z
          .enum([
            'full_refund',
            'partial_refund',
            'no_refund_due',
            'externally_settled',
          ])
          .optional(),
        refundAmount: z.number().positive().finite().optional(),
        externalSettlementReference: z
          .string()
          .trim()
          .min(2)
          .max(200)
          .optional(),
      })
      .optional(),
  })
  .superRefine((value, context) => {
    if (value.decision === 'confirm_ticketed') {
      if (!value.ticketing) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['ticketing'],
          message: 'Ticket numbers and Issued Date & Time are required.',
        });
      }
      if (value.cancellation) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['cancellation'],
          message: 'Cancellation details are not allowed when confirming.',
        });
      }
      return;
    }
    if (!value.cancellation) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['cancellation'],
        message: 'Cancellation Date & Time and reason are required.',
      });
      return;
    }
    if (value.ticketing) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['ticketing'],
        message: 'Ticket details are not allowed when cancelling.',
      });
    }
    if (
      value.cancellation.refundDisposition === 'partial_refund' &&
      !value.cancellation.refundAmount
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['cancellation', 'refundAmount'],
        message: 'Enter the partial refund amount.',
      });
    }
    if (
      value.cancellation.refundDisposition === 'externally_settled' &&
      !value.cancellation.externalSettlementReference
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['cancellation', 'externalSettlementReference'],
        message: 'Enter the external settlement reference.',
      });
    }
  });

export type ImportedTicketingResolutionInput = z.infer<
  typeof importedTicketingResolutionSchema
>;

export type ImportedTicketingResolutionContext = {
  ok: true;
  bookingId: string;
  bookingReference: string;
  importSource: 'IMP_EXP' | 'MANUAL';
  status: 'in-progress';
  paymentState: string;
  accountingMode: 'active_hold' | 'legacy_captured';
  operationId: string;
  operationState: string;
  reconciliationCaseId: string;
  caseState: string;
  reservationId: string;
  reservationState: string;
  walletId: string;
  walletAccountId: string;
  walletStatus: 'active' | 'frozen';
  walletOwnerType: 'user' | 'agency';
  walletOwnerKey: string;
  currency: string;
  userPayableAmount: number;
  capturedAmount: number;
  refundedAmount: number;
  outstandingAmount: number;
  availableBefore: number;
  holdBefore: number;
  confirmEffect: 'capture_hold' | 'none';
  confirmAmount: number;
  confirmAvailableAfter: number;
  confirmHoldAfter: number;
  cancelEffect: 'release_hold' | 'refund_decision_required';
  cancelAmount: number;
  cancelAvailableAfter: number | null;
  cancelHoldAfter: number;
};

export type ImportedTicketingResolutionResult = {
  ok: boolean;
  code?: string;
  replay?: boolean;
  resolutionId?: string;
  bookingId?: string;
  bookingReference?: string;
  status?: 'confirmed' | 'cancelled';
  decision?: 'confirm_ticketed' | 'cancel';
  accountingMode?: 'active_hold' | 'legacy_captured';
  walletEffect?: 'capture_hold' | 'release_hold' | 'refund' | 'none';
  walletAmount?: number;
  currency?: string;
  availableBefore?: number;
  availableAfter?: number;
  holdBefore?: number;
  holdAfter?: number;
  ledgerEntryId?: string | null;
};

export type ImportedTicketingResolutionBlocked = {
  ok: false;
  code: string;
};

export type ImportedTicketingResolutionAssessment =
  | ImportedTicketingResolutionContext
  | ImportedTicketingResolutionBlocked;
