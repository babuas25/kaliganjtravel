// OrderCreate / OrderRetrieve / OrderReshopPrice / OrderChange response types

export interface OrderDeparture {
  iatA_LocationCode: string;
  terminalName?: string;
  aircraftScheduledDateTime: string;
}

export interface OrderArrival {
  iatA_LocationCode: string;
  terminalName?: string;
  aircraftScheduledDateTime: string;
}

export interface MarketingCarrierInfo {
  carrierDesigCode: string;
  marketingCarrierFlightNumber?: string;
  carrierName: string;
}

export interface OperatingCarrierInfo {
  carrierDesigCode: string;
  carrierName: string;
}

export interface OrderAircraftType {
  iatA_AircraftTypeCode: string;
}

export interface OrderTechnicalStopOver {
  iatA_LocationCode: string;
  aircraftScheduledArrivalDateTime: string;
  aircraftScheduledDepartureDateTime: string;
  arrivalTerminalName?: string;
  departureTerminalName?: string;
}

export interface PaxSegment {
  departure: OrderDeparture;
  arrival: OrderArrival;
  marketingCarrierInfo: MarketingCarrierInfo;
  operatingCarrierInfo: OperatingCarrierInfo;
  iatA_AircraftType: OrderAircraftType;
  rbd: string;
  flightNumber: string;
  segmentGroup?: number;
  returnJourney?: boolean;
  airlinePNR?: string;
  technicalStopOver?: OrderTechnicalStopOver[] | null;
  duration?: string;
  cabinType?: string;
}

export interface PaxSegmentItem {
  paxSegment: PaxSegment;
}

export interface FareDetail {
  baseFare: number;
  tax: number;
  otherFee?: number;
  markup?: number;
  discount: number;
  vat: number;
  currency: string;
  paxType: string;
  paxCount: number;
  subTotal: number;
}

export interface FareDetailItem {
  fareDetail: FareDetail;
}

export interface TotalAmount {
  total: number;
  curreny: string;
  currency?: string;
}

export interface AppliedOrderFareAdjustment {
  amount: number;
  amountDisplayAs: "markup" | "discount";
  applicationMode?:
    | "base-fare-adjustment"
    | "discount-regulator"
    | "no-commission-airline-markup";
  audience: "Agent" | "User" | null;
  ruleId: string | null;
  source: "none" | "rule";
  mode: "percentage" | "fixed";
  value: number;
  commissionShare?: number;
  discountBefore?: TotalAmount;
  discountAfter?: TotalAmount;
  route: string | null;
  airline: string | null;
  apiTotalPayable: TotalAmount;
  finalTotalPayable: TotalAmount;
  markupBaseFare?: TotalAmount;
  label?: string;
}

export interface OrderPrice {
  totalPayable: TotalAmount;
  apiTotalPayable?: TotalAmount;
  officialFare?: TotalAmount;
  gross?: TotalAmount;
  discount?: TotalAmount;
  totalVAT?: TotalAmount;
  fareAdjustment?: AppliedOrderFareAdjustment;
}

export interface BaggageAllowanceItem {
  paxType: string;
  allowance: string;
}

export interface BaggageAllowance {
  departure: string;
  arrival: string;
  checkIn: BaggageAllowanceItem[];
  cabin: BaggageAllowanceItem[];
}

export interface BaggageAllowanceItemWrap {
  baggageAllowance: BaggageAllowance;
}

export interface PenaltyTextInfo {
  textInfo: {
    paxType: string;
    info: string[];
  };
}

export interface PenaltyInfo {
  penaltyInfo: {
    type: string;
    textInfoList: PenaltyTextInfo[];
  };
}

export interface RefundPenaltyItem {
  refundPenalty: {
    departure: string;
    arrival: string;
    penaltyInfoList: PenaltyInfo[];
  };
}

export interface ExchangePenaltyItem {
  exchangePenalty: {
    departure: string;
    arrival: string;
    penaltyInfoList: PenaltyInfo[];
  };
}

export interface OrderPenalty {
  refundPenaltyList?: RefundPenaltyItem[];
  exchangePenaltyList?: ExchangePenaltyItem[];
}

export interface OrderItem {
  validatingCarrier: string;
  refundable: boolean;
  fareType: string;
  /** Direction and supplier lifecycle metadata for cross-supplier Two-One-Way children. */
  twoOnewayIndex?: string;
  supplier?: string;
  supplierOrderReference?: string;
  /** Supplier-neutral PNR fallback used when live retrieval is temporarily unavailable. */
  bookingPnr?: string;
  bookingStatus?: string;
  bookingMessage?: string;
  paxSegmentList: PaxSegmentItem[];
  fareDetailList: FareDetailItem[];
  price: OrderPrice;
  baggageAllowanceList?: BaggageAllowanceItemWrap[];
  penalty?: OrderPenalty;
}

export interface IdentityDoc {
  identityDocType: string;
  identityDocID?: string;
  issuingCountryCode?: string;
  expiryDate: string;
}

/** OrderCreate may use ticketNumber; OrderRetrieve/OrderChange use array of ticketDocNbr when Confirmed. */
export interface OrderIndividual {
  title?: string;
  givenName: string;
  surname: string;
  gender: string;
  birthdate: string;
  nationality: string;
  identityDoc?: IdentityDoc;
  ticketDocument?:
    | { ticketNumber?: string; ticketDocNbr?: string }
    | Array<{ ticketDocNbr?: string }>
    | null;
}

export interface OrderPax {
  ptc: string;
  individual: OrderIndividual;
}

export interface OrderContactDetail {
  phoneNumber: string;
  emailAddress: string;
}

export interface OrderCreateResponse {
  bookingId?: string;
  orderReference: string;
  paymentTimeLimit?: string;
  orderItem: OrderItem[];
  paxList: OrderPax[];
  contactDetail: OrderContactDetail;
  orderStatus: string;
  orderChangeInfo?: unknown;
  partialPaymentInfo?: unknown;
  exchangeDetails?: unknown;
  traceId?: string;
  supplier?: "BDFARE" | "TRIPLOVER" | "US_BANGLA" | "AIR_ASTRA" | "NOVOAIR";
  importSource?: string;
  supplierBookingUrl?: string;
  supplierOriginalReference?: string;
  supplierMissingFields?: string[];
}

export interface OrderCreateApiResponse {
  message: string | null;
  requestedOn: string;
  respondedOn: string;
  response: OrderCreateResponse;
  statusCode: string;
  success: boolean;
  error: unknown;
  info: unknown;
}
