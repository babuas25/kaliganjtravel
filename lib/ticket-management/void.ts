export type VoidCustomerSettlement = {
  direction: 'credit' | 'debit' | 'none';
  customerAmountMinor: bigint;
};

export function calculateVoidCustomerSettlement(input: {
  userPayableEntitlementAmountMinor: bigint;
  airlineVoidFeeAmountMinor: bigint;
  serviceFeeAmountMinor: bigint;
}): VoidCustomerSettlement {
  if (
    input.userPayableEntitlementAmountMinor <= BigInt(0) ||
    input.airlineVoidFeeAmountMinor < BigInt(0) ||
    input.serviceFeeAmountMinor < BigInt(0)
  ) {
    throw new Error('VOID amounts must use positive entitlement and non-negative fees.');
  }

  const feeTotal =
    input.airlineVoidFeeAmountMinor + input.serviceFeeAmountMinor;
  if (input.userPayableEntitlementAmountMinor > feeTotal) {
    return {
      direction: 'credit',
      customerAmountMinor:
        input.userPayableEntitlementAmountMinor - feeTotal,
    };
  }
  if (input.userPayableEntitlementAmountMinor < feeTotal) {
    return {
      direction: 'debit',
      customerAmountMinor:
        feeTotal - input.userPayableEntitlementAmountMinor,
    };
  }
  return { direction: 'none', customerAmountMinor: BigInt(0) };
}
