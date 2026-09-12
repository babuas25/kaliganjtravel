import 'server-only';

import type {
  SupplierReferenceBooking,
  SupplierReferenceImportDecision,
  SupplierReferenceImportResult,
} from '@/lib/supplier-reference-import/types';
import { supabaseAdmin } from '@/lib/supabase/server';

export type SupplierReferenceChargeAuthorizationResult = {
  ok: boolean;
  code?: string;
  authorizationId?: string;
  expiresAt?: string;
  consumed?: boolean;
  replay?: boolean;
  amount?: number;
  currency?: string;
  walletAvailable?: number;
  available?: number;
  required?: number;
};

export async function authorizeSupplierReferenceCharge(input: {
  actorUserId: string;
  assignedUserId: string;
  userPayableAmount: number;
  supplierGrossAmount: number;
  booking: SupplierReferenceBooking;
  requestId: string;
}): Promise<SupplierReferenceChargeAuthorizationResult> {
  const supabase = supabaseAdmin();
  if (!supabase) return { ok: false, code: 'STORAGE_UNAVAILABLE' };
  const { data, error } = await supabase.rpc(
    'authorize_supplier_reference_charge_v1',
    {
      p_actor_user_id: input.actorUserId,
      p_assigned_user_id: input.assignedUserId,
      p_user_payable_amount: input.userPayableAmount,
      p_supplier_gross_amount: input.supplierGrossAmount,
      p_data: input.booking,
      p_request_key: `supplier-reference-charge:v1:${input.requestId}`,
    },
  );
  if (error) {
    console.error('[db] supplier-reference charge authorization failed:', error.message);
    return {
      ok: false,
      code: error.code === '22023'
        ? 'CHARGE_AUTHORIZATION_IDENTITY_MISMATCH'
        : 'STORAGE_ERROR',
    };
  }
  return data && typeof data === 'object' && !Array.isArray(data)
    ? (data as SupplierReferenceChargeAuthorizationResult)
    : { ok: false, code: 'INVALID_DATABASE_RESPONSE' };
}
export async function createSupplierReferenceBooking(input: {
  actorUserId: string;
  assignedUserId: string;
  userPayableAmount: number;
  supplierGrossAmount: number;
  booking: SupplierReferenceBooking;
  importDecision: SupplierReferenceImportDecision;
  chargeAuthorizationId?: string | null;
  requestId: string;
}): Promise<SupplierReferenceImportResult> {
  const supabase = supabaseAdmin();
  if (!supabase) return { ok: false, code: 'STORAGE_UNAVAILABLE' };
  const { data, error } = await supabase.rpc(
    'create_supplier_reference_booking_v1',
    {
      p_actor_user_id: input.actorUserId,
      p_assigned_user_id: input.assignedUserId,
      p_user_payable_amount: input.userPayableAmount,
      p_supplier_gross_amount: input.supplierGrossAmount,
      p_data: input.booking,
      p_import_decision: input.importDecision,
      p_charge_authorization_id: input.chargeAuthorizationId ?? null,
      p_request_key: `supplier-reference-import:v1:${input.requestId}`,
    },
  );
  if (error) {
    console.error('[db] supplier-reference booking import failed:', error.message);
    return {
      ok: false,
      code: error.code === '22023' ? 'IMPORT_REQUEST_IDENTITY_MISMATCH' : 'STORAGE_ERROR',
    };
  }
  return data && typeof data === 'object' && !Array.isArray(data)
    ? (data as SupplierReferenceImportResult)
    : { ok: false, code: 'INVALID_DATABASE_RESPONSE' };
}
