import { randomUUID } from 'node:crypto';
import { z } from 'zod';

import { FOLDERS } from '@/lib/cloudinary';
import { getDashboardSession } from '@/lib/dashboard/session';
import { discardDocuments, signDocuments, storeDocuments } from '@/lib/db/document-uploads';
import { sendDepositRequestEmails } from '@/lib/email/notifications';
import { dispatchDepositRequestAdminSms } from '@/lib/sms/deposit-request-admin-delivery';
import {
  createDepositRequest,
  ensureSessionWallet,
  listDepositRequests,
  type DepositRequestRow,
  type WalletAccountSummary,
} from '@/lib/db/wallet';
import { findWalletOwnerBankAccount } from '@/lib/db/wallet-owner-bank-accounts';
import { checkActionLimit } from '@/lib/rate-limit';
import { supabaseAdmin } from '@/lib/supabase/server';
import { walletFail, walletOk } from '@/lib/wallet/http';
import { majorToMinor } from '@/lib/wallet/money';
import type {
  CompanyMfsAccountOption,
  UserBankAccountSnapshot,
} from '@/lib/wallet/payment-options';
import {
  findCompanyBankAccount,
  findCompanyMfsAccount,
  findDepositBranch,
  findDepositReceiver,
} from '@/lib/wallet/payment-options.server';
import { canReadWallet } from '@/lib/wallet/permissions';

export const dynamic = 'force-dynamic';

const amount = z.coerce.number().positive().max(100_000_000);
const date = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Choose a valid date.')
  .refine((value) => {
    const [year, month, day] = value.split('-').map(Number);
    const parsed = new Date(Date.UTC(year, month - 1, day));
    return parsed.getUTCFullYear() === year
      && parsed.getUTCMonth() === month - 1
      && parsed.getUTCDate() === day;
  }, 'Choose a valid calendar date.');
const common = {
  amount,
  remarks: z.string().trim().max(1000).optional(),
};

const cashSchema = z.object({
  method: z.literal('cash'),
  branchId: z.string().uuid(),
  receivedByUserId: z.string().min(1).max(255),
  ...common,
});

const bankSchema = z.object({
  method: z.literal('bank'),
  companyBankAccountId: z.string().uuid(),
  depositDate: date,
  referenceNumber: z.string().trim().min(1).max(255),
  ...common,
});

const bankTransferSchema = z.object({
  method: z.literal('bank_transfer'),
  companyBankAccountId: z.string().uuid(),
  sourceBankAccountId: z.string().uuid(),
  depositDate: date,
  referenceNumber: z.string().trim().min(1).max(255),
  ...common,
});

const mobileSchema = z.object({
  method: z.literal('mobile'),
  mfsAccountId: z.string().uuid(),
  transactionId: z.string().trim().min(1).max(255),
  depositDate: date,
  ...common,
});

const chequeSchema = z.object({
  method: z.literal('cheque'),
  chequeNo: z.string().trim().min(1).max(255),
  chequeIssuedDate: date,
  chequeIssuedBank: z.string().trim().min(1).max(255),
  paymentDate: date,
  companyBankAccountId: z.string().uuid(),
  ...common,
});

const schema = z.discriminatedUnion('method', [
  cashSchema,
  bankSchema,
  bankTransferSchema,
  mobileSchema,
  chequeSchema,
]).superRefine((value, context) => {
  if (
    value.method === 'cheque' &&
    value.paymentDate < value.chequeIssuedDate
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Payment date cannot be before the cheque issued date.',
      path: ['paymentDate'],
    });
  }
});

function serializeRequest(request: DepositRequestRow) {
  const { attachment, ...row } = request;
  const [link] = attachment
    ? signDocuments([attachment], () => 'View attachment')
    : [];

  return { ...row, attachment_url: link?.url ?? null };
}

function depositMethodLabel(method: DepositRequestRow['method']): string {
  switch (method) {
    case 'cash':
      return 'Cash deposit';
    case 'bank':
      return 'Bank deposit';
    case 'bank_transfer':
      return 'Bank transfer';
    case 'mobile':
      return 'Mobile financial service';
    case 'cheque':
      return 'Cheque deposit';
  }
}

function formatDepositAmount(amountMinor: number, currency: string): string {
  return `${currency} ${new Intl.NumberFormat('en-BD', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(amountMinor / 100)}`;
}

type RequesterRow = {
  clerk_id: string;
  email: string | null;
  first_name: string | null;
  last_name: string | null;
  agency_code: string | null;
};

type AgencyRow = {
  agency_code: string;
  owner_user_id: string | null;
};

type AgencyProfileRow = {
  clerk_id: string;
  agency_name: string | null;
};

type CompanyBankAccountRow = {
  id: string;
  bank_name: string;
  account_name: string;
  account_number: string;
  branch_name: string | null;
  branch_code: string | null;
  routing_number: string | null;
  swift_code: string | null;
};

function personName(user: RequesterRow | undefined): string | null {
  if (!user) return null;
  const name = [user.first_name, user.last_name].filter(Boolean).join(' ').trim();
  return name || user.email || null;
}

/**
 * Financial reviewers need identities and the destination account alongside a
 * request. Keep this enrichment in the privileged branch: a requester should
 * continue to receive only their own request data.
 */
async function serializeFinancialRequests(requests: DepositRequestRow[]) {
  const supabase = supabaseAdmin();
  if (!supabase || !requests.length) return requests.map(serializeRequest);

  const participantIds = Array.from(
    new Set(
      requests.flatMap((request) =>
        [request.requested_by_user_id, request.reviewed_by_user_id].filter(
          (id): id is string => Boolean(id)
        )
      )
    )
  );
  const companyBankAccountIds = Array.from(
    new Set(
      requests
        .map((request) => request.company_bank_account_id)
        .filter((id): id is string => Boolean(id))
    )
  );

  const [requestersResult, bankAccountsResult] = await Promise.all([
    supabase
      .from('app_users')
      .select('clerk_id, email, first_name, last_name, agency_code')
      .in('clerk_id', participantIds),
    companyBankAccountIds.length
      ? supabase
          .from('wallet_company_bank_accounts')
          .select(
            'id, bank_name, account_name, account_number, branch_name, branch_code, routing_number, swift_code'
          )
          .in('id', companyBankAccountIds)
      : Promise.resolve({ data: [] as CompanyBankAccountRow[], error: null }),
  ]);

  if (requestersResult.error || bankAccountsResult.error) {
    throw new Error('Deposit request details could not be loaded.');
  }

  const requesters = new Map(
    ((requestersResult.data ?? []) as RequesterRow[]).map((requester) => [
      requester.clerk_id,
      requester,
    ])
  );
  const companyBankAccounts = new Map(
    ((bankAccountsResult.data ?? []) as CompanyBankAccountRow[]).map((account) => [
      account.id,
      account,
    ])
  );
  const agencyCodes = Array.from(
    new Set(
      Array.from(requesters.values())
        .map((requester) => requester.agency_code)
        .filter((code): code is string => Boolean(code))
    )
  );
  const agenciesResult = agencyCodes.length
    ? await supabase
        .from('agencies')
        .select('agency_code, owner_user_id')
        .in('agency_code', agencyCodes)
    : { data: [] as AgencyRow[], error: null };

  if (agenciesResult.error) {
    throw new Error('Agency details could not be loaded.');
  }

  const agencies = new Map(
    ((agenciesResult.data ?? []) as AgencyRow[]).map((agency) => [
      agency.agency_code,
      agency,
    ])
  );
  const agencyOwnerIds = Array.from(
    new Set(
      Array.from(agencies.values())
        .map((agency) => agency.owner_user_id)
        .filter((id): id is string => Boolean(id))
    )
  );
  const profilesResult = agencyOwnerIds.length
    ? await supabase
        .from('user_profiles')
        .select('clerk_id, agency_name')
        .in('clerk_id', agencyOwnerIds)
    : { data: [] as AgencyProfileRow[], error: null };

  if (profilesResult.error) {
    throw new Error('Agency details could not be loaded.');
  }

  const agencyNames = new Map<string, string>();
  for (const profile of (profilesResult.data ?? []) as AgencyProfileRow[]) {
    const name = profile.agency_name?.trim();
    if (name) agencyNames.set(profile.clerk_id, name);
  }

  return requests.map((request) => {
    const requester = requesters.get(request.requested_by_user_id);
    const agencyCode = requester?.agency_code ?? null;
    const agencyOwnerId = agencyCode
      ? agencies.get(agencyCode)?.owner_user_id ?? null
      : null;
    const companyBankAccount = request.company_bank_account_id
      ? companyBankAccounts.get(request.company_bank_account_id)
      : undefined;

    return {
      ...serializeRequest(request),
      requester: {
        name: personName(requester),
        agencyCode,
        agencyName: agencyOwnerId ? agencyNames.get(agencyOwnerId) ?? null : null,
      },
      reviewer: request.reviewed_by_user_id
        ? { name: personName(requesters.get(request.reviewed_by_user_id)) }
        : null,
      company_bank_account: companyBankAccount
        ? {
            bankName: companyBankAccount.bank_name,
            accountName: companyBankAccount.account_name,
            accountNumber: companyBankAccount.account_number,
            branchName: companyBankAccount.branch_name,
            branchCode: companyBankAccount.branch_code,
            routingNumber: companyBankAccount.routing_number,
            swiftCode: companyBankAccount.swift_code,
          }
        : null,
    };
  });
}

export async function GET() {
  const session = await getDashboardSession();
  if (!session) return walletFail(401, 'SIGN_IN_REQUIRED', 'Please sign in.');
  try {
    if (canReadWallet(session.role)) {
      const requests = await listDepositRequests();
      return walletOk({ requests: await serializeFinancialRequests(requests) });
    }

    const summary = await ensureSessionWallet(session);
    if (!summary) return walletOk({ requests: [] });
    const requests = await listDepositRequests(summary.accountId);
    return walletOk({ requests: requests.map(serializeRequest) });
  } catch {
    return walletFail(503, 'STORAGE_ERROR', 'Wallet storage is unavailable.');
  }
}

export async function POST(request: Request) {
  const session = await getDashboardSession();
  if (!session) return walletFail(401, 'SIGN_IN_REQUIRED', 'Please sign in.');

  let summary: WalletAccountSummary | null;
  try {
    summary = await ensureSessionWallet(session);
  } catch {
    return walletFail(503, 'STORAGE_ERROR', 'Wallet storage is unavailable.');
  }
  if (!summary) {
    return walletFail(403, 'NO_PERSONAL_WALLET', 'This account has no wallet.');
  }

  const limit = await checkActionLimit('walletDeposit', `user:${session.clerkId}`);
  if (!limit.ok) {
    return walletFail(
      429,
      'RATE_LIMITED',
      'Too many deposit requests. Try again later.'
    );
  }

  const contentLength = Number(request.headers.get('content-length')) || 0;
  if (contentLength > 6 * 1024 * 1024) {
    return walletFail(413, 'ATTACHMENT_TOO_LARGE', 'The attachment is over the 5 MB limit.');
  }

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return walletFail(400, 'INVALID_BODY', 'Expected a payment request form.');
  }

  const raw = Object.fromEntries(
    Array.from(form.entries()).filter(([, value]) => typeof value === 'string')
  );
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    return walletFail(
      400,
      'INVALID_DEPOSIT',
      parsed.error.issues[0]?.message ?? 'Check the payment request.'
    );
  }

  const input = parsed.data;
  let mfsAccount: CompanyMfsAccountOption | null = null;
  let userBankAccount: UserBankAccountSnapshot | null = null;
  if (input.method === 'cash') {
    const [branch, receiver] = await Promise.all([
      findDepositBranch(input.branchId),
      findDepositReceiver(input.receivedByUserId),
    ]);
    if (!branch) {
      return walletFail(400, 'INVALID_BRANCH', 'Choose a valid Kaliganj Travels branch.');
    }
    if (!receiver) {
      return walletFail(400, 'INVALID_RECEIVER', 'Choose an eligible cash receiver.');
    }
  } else if (
    input.method === 'bank' ||
    input.method === 'bank_transfer' ||
    input.method === 'cheque'
  ) {
    const account = await findCompanyBankAccount(input.companyBankAccountId);
    if (!account) {
      return walletFail(
        400,
        'INVALID_COMPANY_ACCOUNT',
        'Choose a valid Kaliganj Travels bank account.'
      );
    }
    if (input.method === 'bank_transfer') {
      let sourceBankAccount;
      try {
        sourceBankAccount = await findWalletOwnerBankAccount(
          { ownerType: summary.ownerType, ownerKey: summary.ownerKey },
          input.sourceBankAccountId
        );
      } catch {
        return walletFail(
          503,
          'SOURCE_BANK_ACCOUNT_UNAVAILABLE',
          'Your saved bank accounts could not be verified. Please try again.'
        );
      }
      if (!sourceBankAccount) {
        return walletFail(
          400,
          'SOURCE_BANK_ACCOUNT_REQUIRED',
          'Please add a bank account in My Bank Accounts before submitting a bank transfer deposit request.'
        );
      }
      // This is a request-time copy, not a pointer to the editable saved
      // account. It remains accurate after the source account changes.
      userBankAccount = {
        bankName: sourceBankAccount.bankName,
        accountName: sourceBankAccount.accountName,
        accountNumber: sourceBankAccount.accountNumber,
        routingNumber: sourceBankAccount.routingNumber,
        swiftCode: sourceBankAccount.swiftCode,
        branchCode: sourceBankAccount.branchCode,
      };
    }
  } else if (input.method === 'mobile') {
    mfsAccount = await findCompanyMfsAccount(input.mfsAccountId);
    if (!mfsAccount) {
      return walletFail(
        400,
        'INVALID_MFS_ACCOUNT',
        'Choose an active Kaliganj Travels MFS payment account.'
      );
    }
  }

  const attachmentValue = form.get('attachment');
  const attachment =
    attachmentValue instanceof File && attachmentValue.size > 0
      ? attachmentValue
      : null;
  const attachmentRequired = input.method !== 'cash';
  if (attachmentRequired && !attachment) {
    return walletFail(400, 'ATTACHMENT_REQUIRED', 'Attach the payment receipt or cheque.');
  }

  const requestId = randomUUID();
  const upload = attachment
    ? await storeDocuments(
        [attachment],
        `${FOLDERS.walletDeposits}/${requestId}`
      )
    : { ok: true as const, docs: [] };

  if (!upload.ok) {
    return walletFail(400, 'ATTACHMENT_REJECTED', upload.message);
  }

  const grossAmount = majorToMinor(input.amount);
  const gatewayFeeBps =
    input.method === 'mobile' ? mfsAccount?.chargeBps : undefined;
  const depositableAmount =
    gatewayFeeBps === undefined
      ? grossAmount
      : grossAmount - Math.round((grossAmount * gatewayFeeBps) / 10_000);

  if (depositableAmount <= 0) {
    await discardDocuments(upload.docs);
    return walletFail(
      400,
      'INVALID_DEPOSITABLE_AMOUNT',
      'Gateway fee must leave a positive depositable amount.'
    );
  }

  const created = await createDepositRequest({
    id: requestId,
    accountId: summary.accountId,
    amount: depositableAmount,
    grossAmount,
    currency: summary.currency,
    method: input.method,
    referenceNumber:
      input.method === 'bank' || input.method === 'bank_transfer'
        ? input.referenceNumber
        : input.method === 'mobile'
          ? input.transactionId
          : input.method === 'cheque'
            ? input.chequeNo
            : undefined,
    branchId: input.method === 'cash' ? input.branchId : undefined,
    receivedByUserId:
      input.method === 'cash' ? input.receivedByUserId : undefined,
    companyBankAccountId:
      input.method === 'bank' ||
      input.method === 'bank_transfer' ||
      input.method === 'cheque'
        ? input.companyBankAccountId
        : undefined,
    depositDate:
      input.method === 'bank' ||
      input.method === 'bank_transfer' ||
      input.method === 'mobile'
        ? input.depositDate
        : undefined,
    chequeIssuedDate:
      input.method === 'cheque' ? input.chequeIssuedDate : undefined,
    chequeIssuedBank:
      input.method === 'cheque' ? input.chequeIssuedBank : undefined,
    paymentDate: input.method === 'cheque' ? input.paymentDate : undefined,
    mfsProvider: input.method === 'mobile' ? mfsAccount?.mfsName : undefined,
    mfsAccountId: input.method === 'mobile' ? mfsAccount?.id : undefined,
    mfsPaymentType:
      input.method === 'mobile' ? mfsAccount?.paymentType : undefined,
    sourceBankAccountId:
      input.method === 'bank_transfer'
        ? input.sourceBankAccountId
        : undefined,
    userBankAccount:
      input.method === 'bank_transfer' ? userBankAccount ?? undefined : undefined,
    gatewayFeeBps,
    attachment: upload.docs[0],
    remarks: input.remarks,
    requestedBy: session.clerkId,
  });

  if (!created) {
    await discardDocuments(upload.docs);
    return walletFail(
      503,
      'STORAGE_ERROR',
      'The deposit request could not be saved.'
    );
  }

  // The request is committed before sending. An SMTP/identity-provider outage
  // must never turn a valid stored payment request into a failed submission.
  const [emailDelivery, adminSmsDelivery] = await Promise.allSettled([
    sendDepositRequestEmails({
      requesterEmail: session.email,
      requesterName: session.name,
      agency: session.agencyCode,
      requestReference: created.public_ref,
      amount: formatDepositAmount(created.amount, created.currency),
      paymentMethod: depositMethodLabel(created.method),
      transactionReference: created.reference_number,
      depositDate: created.deposit_date,
    }),
    dispatchDepositRequestAdminSms(created.id),
  ]);
  if (emailDelivery.status === 'fulfilled') {
    if (emailDelivery.value.failed) {
      console.error(
        `[wallet] deposit request email delivery incomplete for ${created.public_ref}: ${emailDelivery.value.failed} failed`
      );
    }
  } else {
    console.error(
      `[wallet] deposit request email delivery failed for ${created.public_ref}:`,
      emailDelivery.reason
    );
  }
  if (adminSmsDelivery.status === 'rejected') {
    console.error(
      `[wallet] deposit request admin SMS delivery failed for ${created.public_ref}:`,
      adminSmsDelivery.reason
    );
  }

  return walletOk({ request: serializeRequest(created) }, 201);
}
