type Row = Record<string, unknown>;
const PASSENGER_TYPES = ['ADT', 'CHD', 'CNN', 'INF', 'INS'];
const MAX_MINOR = BigInt(Number.MAX_SAFE_INTEGER);
const ZERO = BigInt(0);
const FIELDS = ['baseFare', 'taxes', 'ait', 'serviceCharge', 'discount', 'gross', 'payable'] as const;
type Amounts = Record<typeof FIELDS[number], bigint>;

export type ShapontravelsSavedPayable = {
  supplierPayableMinor: string;
  specialDiscountMinor: string;
};

function object(value: unknown): Row | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Row : null;
}

function money(value: unknown): bigint | null {
  if (typeof value !== 'string' || value.length > 20 || !/^(?:0|[1-9]\d*)\.\d{2}$/.test(value)) {
    return null;
  }
  const minor = BigInt(value.replace('.', ''));
  return minor <= MAX_MINOR ? minor : null;
}

function discount(value: unknown): bigint | null {
  if (value === undefined || value === '0.00') return ZERO;
  if (typeof value !== 'string' || !value.startsWith('-')) return null;
  const magnitude = money(value.slice(1));
  return magnitude !== null && magnitude > ZERO ? -magnitude : null;
}

function amounts(row: Row, adjustment = ZERO): Amounts | null {
  const charge = money(row.serviceCharge ?? row.charge);
  if (charge === null || (row.charge != null && money(row.charge) !== charge)) return null;
  const values = {} as Amounts;
  for (const field of FIELDS) {
    const minor = field === 'serviceCharge' ? charge : money(row[field]);
    if (minor === null) return null;
    values[field] = minor;
  }
  return values.baseFare + values.taxes + values.ait + values.serviceCharge -
    values.discount + adjustment === values.payable ? values : null;
}

function passengerIdentity(row: Row, count: number) {
  const { passengerIndex: index, passengerType: type, passengerId: id } = row;
  if (typeof index !== 'number' || !Number.isSafeInteger(index) || index < 0 || index >= count ||
      typeof type !== 'string' || !PASSENGER_TYPES.includes(type) ||
      (id != null && (typeof id !== 'string' || !id.trim() || id.length > 200))) return null;
  return { index, type, id: typeof id === 'string' ? id : null };
}

/** Display evidence from an identity-checked saved booking envelope. */
export function readShapontravelsSavedPayable(
  saved: Row | null | undefined,
  envelope: Row,
  purpose: 'standard' | 'display-observation' = 'standard',
): ShapontravelsSavedPayable | null {
  if (!saved || saved.schemaVersion !== 1 || saved.status !== 'confirmed' ||
      saved.paymentState !== 'paid' || (purpose === 'standard' &&
        (saved.reviewRequired !== false || saved.requiresReconciliation !== false))) return null;
  const fare = object(saved.fareBreakdown);
  const count = saved.passengerCount;
  if (!fare || fare.currency !== 'BDT' || typeof count !== 'number' ||
      !Number.isSafeInteger(count) || count < 1 || fare.passengerCount !== count ||
      !Array.isArray(saved.passengerInfoes) || saved.passengerInfoes.length !== count ||
      !Array.isArray(fare.passengers) || fare.passengers.length !== count) return null;

  const adjustment = discount(fare.specialDiscount);
  if (adjustment === null || adjustment >= ZERO) return null;
  const totals = amounts(fare, adjustment);
  if (!totals || totals.payable <= ZERO ||
      totals.baseFare + totals.taxes + totals.ait + totals.serviceCharge > MAX_MINOR) return null;

  const legacy = object(envelope.item1);
  for (const candidate of [legacy?.fareBreakdown, object(legacy?.flightInfo)?.fareBreakdown]) {
    if (candidate == null) continue;
    const alias = object(candidate);
    if (!alias ||
        ['currency', 'gross', 'payable'].some(key => alias[key] != null && alias[key] !== fare[key]) ||
        (Object.hasOwn(alias, 'specialDiscount') && alias.specialDiscount !== fare.specialDiscount)) {
      return null;
    }
  }

  const passengers = new Map<number, { type: string; id: string | null }>();
  for (const value of saved.passengerInfoes) {
    const row = object(value);
    const identity = row && passengerIdentity(row, count);
    if (!identity || passengers.has(identity.index)) return null;
    passengers.set(identity.index, identity);
  }
  const seen = new Set<number>();
  const sum = Object.fromEntries(FIELDS.map(field => [field, ZERO])) as Amounts;
  for (const value of fare.passengers) {
    const row = object(value);
    if (!row || row.currency !== 'BDT' || discount(row.specialDiscount) !== ZERO) return null;
    const identity = passengerIdentity(row, count);
    if (!identity || seen.has(identity.index)) return null;
    const passenger = passengers.get(identity.index);
    if (!passenger || passenger.type !== identity.type ||
        (passenger.id !== null && identity.id !== null && passenger.id !== identity.id)) return null;
    const passengerAmounts = amounts(row);
    if (!passengerAmounts) return null;
    seen.add(identity.index);
    for (const field of FIELDS) {
      sum[field] += passengerAmounts[field];
      if (sum[field] > MAX_MINOR) return null;
    }
  }
  if (FIELDS.some(field => sum[field] + (field === 'payable' ? adjustment : ZERO) !== totals[field])) return null;
  return { supplierPayableMinor: totals.payable.toString(), specialDiscountMinor: adjustment.toString() };
}
