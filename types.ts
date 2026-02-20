
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
