
export interface ShopifyTransaction {
  id: string;
  orderNumber: string;
  dateTime: string;
  customerName: string;
  amount: number;
  fee: number;
  net: number;
  type: string;
  cardBrand: string;
  currency: string;
  sourceFile: string;
  payoutDate?: string;
  payoutId?: string;
  payoutStatus?: string;
}

export interface DailyGroup {
  date: string;
  subtotal: number;
  subtotalFees: number;
  subtotalNet: number;
  count: number;
  transactions: ShopifyTransaction[];
}

export interface ReportSummary {
  dateRange: string;
  totalAmount: number;
  totalFees: number;
  totalNet: number;
  transactionCount: number;
  dailyGroups: DailyGroup[];
  allTransactions: ShopifyTransaction[];
  aiAnalysis?: string;
}

export enum ReportStatus {
  IDLE = 'IDLE',
  PROCESSING = 'PROCESSING',
  READY = 'READY',
  ERROR = 'ERROR'
}

export interface PayoutLine {
  id: string;
  orderNumber: string;
  dateTime: string;
  customerName: string;
  amount: number;
  fee: number;
  net: number;
  type: string;
  cardBrand: string;
  currency: string;
  availableOn: string;
}

export interface ArchivedPayout {
  payoutId: string;
  payoutDate: string;
  payoutStatus: string;
  filename: string;
  suffix: number;
  isPrimary: boolean;
  bankDate: string;
  refundOnly: boolean;
  amount: number;
  fee: number;
  net: number;
  types: string[];
  transactions: PayoutLine[];
}

export interface EOMDayGroup {
  bankDate: string;
  payouts: ArchivedPayout[];
  depositNet: number;
  depositAmount: number;
  depositFees: number;
  achCount: number;
  transactionCount: number;
}

export interface EOMCalendarDay {
  date: string;
  transactionCount: number;
  gross: number;
  fees: number;
  net: number;
}

export type EOMExceptionKind = 'refund_only' | 'outside_window' | 'in_transit' | 'scheduled';

export interface EOMException {
  kind: EOMExceptionKind;
  payout: ArchivedPayout;
  note: string;
}

export interface EOMSummary {
  fromDate: string;
  toDate: string;
  wellsFargoTotal: number;
  calculatedTotal: number;
  variance: number;
  matched: boolean;
  days: EOMDayGroup[];
  calendarDays: EOMCalendarDay[];
  calendarGross: number;
  calendarMonthLabel: string;
  exceptions: EOMException[];
  includedPayoutCount: number;
  archiveCount: number;
  brand?: 'SHOPIFY' | 'PAYPAL';
}

export type EomSource = 'SHOPIFY' | 'PAYPAL';

export interface CombinedCalendarDay {
  date: string;
  shopify: EOMCalendarDay;
  paypal: EOMCalendarDay;
  combined: EOMCalendarDay;
}

export interface CombinedEOMPacket {
  fromDate: string;
  toDate: string;
  sources: EomSource[];
  shopify?: EOMSummary;
  paypal?: EOMSummary;
  calendarMonthLabel: string;
  combinedDays: CombinedCalendarDay[];
}
