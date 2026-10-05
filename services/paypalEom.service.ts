import Papa from 'papaparse';
import { ArchivedPayout, EOMSummary, PayoutLine } from '../types';
import { depositCsvName, reconcileEom, rollIfClosed } from './eom.service';
import { asExpenseFee, getCalendarDateString } from './dateUtils';

const money = (value: unknown): number => {
  if (value === null || value === undefined || value === '') return 0;
  const parsed = parseFloat(String(value).replace(/[^0-9.-]+/g, ''));
  return Number.isNaN(parsed) ? 0 : parsed;
};

const cents = (value: number): number => Math.round(value * 100);
const fromCents = (value: number): number => value / 100;

const WITHDRAWAL_TYPES = new Set(['General Withdrawal', 'User Initiated Withdrawal']);
const SKIPPED_ACTIVITY_TYPES = new Set(['Bank Deposit to PP Account']);

const paypalDate = (row: Record<string, unknown>): string | null =>
  getCalendarDateString(String(row['Date'] || '').trim());

const rowSortKey = (row: Record<string, unknown>): string =>
  `${paypalDate(row) || ''} ${String(row['Time'] || '').trim()}`;

const isPaypalActivityRow = (row: Record<string, unknown>): boolean =>
  Boolean(row['Date'] && row['Time'] && (row['Type'] || row['Transaction ID']));

const parseActivityRows = (content: string): Record<string, unknown>[] => {
  const parsed = Papa.parse(content, { header: true, skipEmptyLines: true });
  return ((parsed.data as Record<string, unknown>[]) || []).filter(isPaypalActivityRow);
};

export const isPaypalActivityCsv = (content: string): boolean => {
  const parsed = Papa.parse(content, { header: true, skipEmptyLines: true, preview: 5 });
  const fields = ((parsed.meta.fields || []) as string[]).map((field) => String(field).trim());
  return (
    fields.includes('Date') &&
    fields.includes('Time') &&
    fields.includes('Type') &&
    fields.includes('Transaction ID')
  );
};

const toSaleLine = (row: Record<string, unknown>, index: number): PayoutLine | null => {
  const type = String(row['Type'] || '').trim();
  if (!type || WITHDRAWAL_TYPES.has(type) || SKIPPED_ACTIVITY_TYPES.has(type)) return null;
  const date = String(row['Date'] || '').trim();
  const time = String(row['Time'] || '').trim();
  if (!date || !time) return null;

  const amount = money(row['Gross']);
  const fee = asExpenseFee(money(row['Fee']));
  const net = money(row['Net']);
  if (amount === 0 && fee === 0 && net === 0) return null;

  const orderId = String(row['Transaction ID'] || `PP-${index}`).trim();
  return {
    id: `${orderId}-${index}`,
    orderNumber: orderId,
    dateTime: `${date} ${time}`,
    customerName: String(row['Name'] || 'PayPal').trim() || 'PayPal',
    amount,
    fee,
    net,
    type,
    cardBrand: String(row['Payment Source'] || row['Card Type'] || 'PayPal').trim() || 'PayPal',
    currency: String(row['Currency'] || 'USD').trim() || 'USD',
    availableOn: paypalDate(row) || '',
  };
};

const buildFromRows = (
  rows: Record<string, unknown>[],
  filename: string
): { withdrawals: ArchivedPayout[]; sales: PayoutLine[] } => {
  const sorted = rows.slice().sort((a, b) => rowSortKey(a).localeCompare(rowSortKey(b)));
  const sales: PayoutLine[] = [];
  const withdrawals: ArchivedPayout[] = [];
  let buffer: PayoutLine[] = [];
  const sameDayCount = new Map<string, number>();

  sorted.forEach((row, index) => {
    const type = String(row['Type'] || '').trim();
    const sale = toSaleLine(row, index);
    if (sale) {
      sales.push(sale);
      buffer.push(sale);
      return;
    }

    if (SKIPPED_ACTIVITY_TYPES.has(type)) {
      const payoutDate = paypalDate(row);
      const payoutId = String(row['Transaction ID'] || `${filename}-bank-${index}`).trim();
      if (!payoutDate || !payoutId) return;
      const pulled = Math.abs(money(row['Net'] || row['Gross']));
      if (!pulled) return;
      withdrawals.push({
        payoutId,
        payoutDate,
        payoutStatus: String(row['Status'] || 'Completed').trim(),
        filename: depositCsvName(payoutDate, 0) || `${payoutDate}.csv`,
        suffix: 0,
        isPrimary: true,
        bankDate: rollIfClosed(payoutDate),
        refundOnly: false,
        amount: -pulled,
        fee: 0,
        net: -pulled,
        types: [type],
        transactions: [],
      });
      return;
    }

    if (!WITHDRAWAL_TYPES.has(type)) return;

    const payoutDate = paypalDate(row);
    const payoutId = String(row['Transaction ID'] || `${filename}-${index}`).trim();
    if (!payoutDate || !payoutId) return;

    const deposit = Math.abs(money(row['Net']));
    const suffix = sameDayCount.get(payoutDate) || 0;
    sameDayCount.set(payoutDate, suffix + 1);

    withdrawals.push({
      payoutId,
      payoutDate,
      payoutStatus: String(row['Status'] || 'Completed').trim(),
      filename: depositCsvName(payoutDate, suffix) || `${payoutDate}.csv`,
      suffix,
      isPrimary: suffix === 0,
      bankDate: rollIfClosed(payoutDate),
      refundOnly: false,
      amount: deposit,
      fee: 0,
      net: deposit,
      types: [type],
      transactions: buffer,
    });
    buffer = [];
  });

  if (buffer.length > 0) {
    const last = buffer[buffer.length - 1];
    const leftoverDate = getCalendarDateString(last.dateTime) || '';
    withdrawals.push({
      payoutId: `PENDING-${filename}`,
      payoutDate: leftoverDate,
      payoutStatus: 'in_transit',
      filename: leftoverDate ? depositCsvName(leftoverDate, 0) : 'pending.csv',
      suffix: 0,
      isPrimary: true,
      bankDate: leftoverDate ? rollIfClosed(leftoverDate) : leftoverDate,
      refundOnly: false,
      amount: fromCents(buffer.reduce((sum, line) => sum + cents(line.amount), 0)),
      fee: fromCents(buffer.reduce((sum, line) => sum + cents(line.fee), 0)),
      net: fromCents(buffer.reduce((sum, line) => sum + cents(line.net), 0)),
      types: ['pending'],
      transactions: buffer,
    });
  }

  return { withdrawals, sales };
};

export const parsePaypalActivityText = (
  content: string,
  filename: string
): { withdrawals: ArchivedPayout[]; sales: PayoutLine[] } =>
  buildFromRows(parseActivityRows(content), filename);

export const mergePaypalActivityFiles = (
  files: { filename: string; content: string }[]
): { withdrawals: ArchivedPayout[]; sales: PayoutLine[] } => {
  const seen = new Set<string>();
  const rows: Record<string, unknown>[] = [];

  files.forEach((file) => {
    parseActivityRows(file.content).forEach((row) => {
      const id = String(row['Transaction ID'] || '').trim();
      if (id) {
        if (seen.has(id)) return;
        seen.add(id);
      }
      rows.push(row);
    });
  });

  return buildFromRows(rows, files[0]?.filename || 'paypal.csv');
};

export const reconcilePaypalEom = (
  files: { filename: string; content: string }[],
  fromDate: string,
  toDate: string,
  wellsFargoTotal: number
): EOMSummary => {
  const { withdrawals, sales } = mergePaypalActivityFiles(files);
  return reconcileEom(withdrawals, fromDate, toDate, wellsFargoTotal, {
    assignBankDates: false,
    calendarTransactions: sales,
    brand: 'PAYPAL',
  });
};
