import Papa from 'papaparse';
import {
  ArchivedPayout,
  CombinedEOMPacket,
  EOMCalendarDay,
  EOMDayGroup,
  EOMException,
  EOMSummary,
  EomSource,
  PayoutLine,
} from '../types';
import { asExpenseFee, formatDisplayDate, formatMoney, getCalendarDateString } from './dateUtils';

const money = (value: unknown): number => {
  if (value === null || value === undefined || value === '') return 0;
  const parsed = parseFloat(String(value).replace(/[^0-9.-]+/g, ''));
  return Number.isNaN(parsed) ? 0 : parsed;
};

const cents = (value: number): number => Math.round(value * 100);

const fromCents = (value: number): number => value / 100;

const fileBaseName = (filename: string): string => filename.replace(/^.*[\\/]/, '');

export const formatUsd = formatMoney;

export const parseYmd = (value: string): Date => {
  const [year, month, day] = value.split('-').map(Number);
  return new Date(year, (month || 1) - 1, day || 1);
};

export const formatYmd = (date: Date): string => {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
};

const addDays = (value: string, days: number): string => {
  const date = parseYmd(value);
  date.setDate(date.getDate() + days);
  return formatYmd(date);
};

const nthWeekdayOfMonth = (year: number, month: number, weekday: number, n: number): Date => {
  const first = new Date(year, month, 1);
  const offset = (weekday - first.getDay() + 7) % 7;
  return new Date(year, month, 1 + offset + (n - 1) * 7);
};

const lastWeekdayOfMonth = (year: number, month: number, weekday: number): Date => {
  const last = new Date(year, month + 1, 0);
  const delta = (last.getDay() - weekday + 7) % 7;
  return new Date(year, month, last.getDate() - delta);
};

const observedDate = (date: Date): Date => {
  const shifted = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const weekday = shifted.getDay();
  if (weekday === 6) shifted.setDate(shifted.getDate() - 1);
  if (weekday === 0) shifted.setDate(shifted.getDate() + 1);
  return shifted;
};

const holidayCache = new Map<number, Set<string>>();

const federalHolidays = (year: number): Set<string> => {
  const cached = holidayCache.get(year);
  if (cached) return cached;

  const dates = new Set<string>();
  const add = (date: Date) => dates.add(formatYmd(observedDate(date)));

  add(new Date(year, 0, 1));
  add(nthWeekdayOfMonth(year, 0, 1, 3));
  add(nthWeekdayOfMonth(year, 1, 1, 3));
  add(lastWeekdayOfMonth(year, 4, 1));
  add(new Date(year, 5, 19));
  add(new Date(year, 6, 4));
  add(nthWeekdayOfMonth(year, 8, 1, 1));
  add(nthWeekdayOfMonth(year, 9, 1, 2));
  add(new Date(year, 10, 11));
  add(nthWeekdayOfMonth(year, 10, 4, 4));
  add(new Date(year, 11, 25));

  holidayCache.set(year, dates);
  return dates;
};

const isBankClosed = (value: string): boolean => {
  const date = parseYmd(value);
  const weekday = date.getDay();
  if (weekday === 0 || weekday === 6) return true;
  const year = date.getFullYear();
  return federalHolidays(year).has(value) || federalHolidays(year - 1).has(value) || federalHolidays(year + 1).has(value);
};

export const rollIfClosed = (value: string): string => {
  let current = value;
  while (isBankClosed(current)) {
    current = addDays(current, 1);
  }
  return current;
};

export const nextBusinessDay = (value: string): string => rollIfClosed(addDays(value, 1));

const filenameSuffix = (filename: string): number => {
  const match = fileBaseName(filename).match(/\((\d+)\)\s*\.csv$/i);
  return match ? Number(match[1]) : 0;
};

/** Original payout exports: 12-31-2025.csv or 12-31-2025(1).csv */
export const isDepositCsvName = (filename: string): boolean =>
  /^\d{2}-\d{2}-\d{4}(?:\(\d+\))?\.csv$/i.test(fileBaseName(filename));

export const depositCsvName = (payoutDate: string, suffix = 0): string => {
  const [year, month, day] = String(payoutDate || '').split('-');
  if (!year || !month || !day) return '';
  const base = `${month}-${day}-${year}`;
  return suffix > 0 ? `${base}(${suffix}).csv` : `${base}.csv`;
};

const cleanPayoutId = (value: unknown): string => String(value || '').trim();

type PayoutDraft = {
  payoutId: string;
  payoutDate: string;
  payoutStatus: string;
  types: Set<string>;
  transactions: PayoutLine[];
};

const payoutFromDraft = (draft: PayoutDraft, filename: string): ArchivedPayout => {
  const typeList = Array.from(draft.types).sort();
  const amount = fromCents(draft.transactions.reduce((sum, line) => sum + cents(line.amount), 0));
  const fee = fromCents(draft.transactions.reduce((sum, line) => sum + cents(line.fee), 0));
  const net = fromCents(draft.transactions.reduce((sum, line) => sum + cents(line.net), 0));
  return {
    payoutId: draft.payoutId,
    payoutDate: draft.payoutDate,
    payoutStatus: draft.payoutStatus,
    filename: fileBaseName(filename),
    suffix: filenameSuffix(filename),
    isPrimary: false,
    bankDate: draft.payoutDate,
    refundOnly: typeList.length === 1 && typeList[0] === 'refund',
    amount,
    fee,
    net,
    types: typeList,
    transactions: draft.transactions,
  };
};

/** One Shopify payout export can contain several Payout IDs; keep each ACH separate. */
export const parsePayoutsFromCsvText = (content: string, filename: string): ArchivedPayout[] => {
  const parsed = Papa.parse(content, {
    header: true,
    skipEmptyLines: true,
  });
  const rows = (parsed.data as Record<string, unknown>[]) || [];
  if (rows.length === 0) return [];

  const byId = new Map<string, PayoutDraft>();

  rows.forEach((row, index) => {
    const payoutId = cleanPayoutId(row['Payout ID']);
    if (!payoutId) return;

    const amount = money(row['Amount']);
    const fee = asExpenseFee(money(row['Fee']));
    let net = money(row['Net']);
    if (net === 0 && (amount !== 0 || fee !== 0)) {
      net = fromCents(cents(amount) + cents(fee));
    }

    const draft = byId.get(payoutId) || {
      payoutId,
      payoutDate: '',
      payoutStatus: '',
      types: new Set<string>(),
      transactions: [],
    };
    if (!draft.payoutDate) draft.payoutDate = String(row['Payout Date'] || '').trim().slice(0, 10);
    if (!draft.payoutStatus) draft.payoutStatus = String(row['Payout Status'] || '').trim();
    draft.types.add(String(row['Type'] || 'Unknown').trim());
    draft.transactions.push({
      id: `${payoutId}-${index}`,
      orderNumber: String(row['Order'] || row['Name'] || `Line-${index}`),
      dateTime: String(row['Transaction Date'] || row['Created at'] || ''),
      customerName: String(row['Payment Method Name'] || row['Card Source'] || 'card'),
      amount,
      fee,
      net,
      type: String(row['Type'] || 'Unknown').trim(),
      cardBrand: String(row['Card Brand'] || 'N/A'),
      currency: String(row['Currency'] || 'USD'),
      availableOn: String(row['Available On'] || '').trim().slice(0, 10),
    });
    byId.set(payoutId, draft);
  });

  return Array.from(byId.values())
    .filter((draft) => draft.payoutDate && draft.transactions.length > 0)
    .map((draft) => payoutFromDraft(draft, filename));
};

export const parsePayoutCsvText = (content: string, filename: string): ArchivedPayout | null =>
  parsePayoutsFromCsvText(content, filename)[0] || null;

export const parsePayoutFiles = async (
  files: File[]
): Promise<{ payouts: ArchivedPayout[]; errors: string[] }> => {
  const payouts: ArchivedPayout[] = [];
  const errors: string[] = [];

  for (const file of files) {
    try {
      const content = await file.text();
      const parsed = parsePayoutCsvText(content, file.name);
      if (!parsed) {
        errors.push(`${file.name}: not a Shopify payout export (missing Payout ID).`);
        continue;
      }
      payouts.push(parsed);
    } catch (error) {
      errors.push(`${file.name}: ${error instanceof Error ? error.message : 'failed to read file'}`);
    }
  }

  return { payouts, errors };
};

export const assignBankDates = (payouts: ArchivedPayout[]): ArchivedPayout[] => {
  const byDay = new Map<string, ArchivedPayout[]>();
  payouts.forEach((payout) => {
    const list = byDay.get(payout.payoutDate) || [];
    list.push(payout);
    byDay.set(payout.payoutDate, list);
  });

  return payouts.map((payout) => {
    const day = byDay.get(payout.payoutDate) || [payout];
    const unsuffixed = day.filter((item) => item.suffix === 0);
    const candidates = unsuffixed.length > 0 ? unsuffixed : day;
    const primary = candidates.reduce((best, item) => (item.net >= best.net ? item : best));
    const isPrimary = payout.payoutId === primary.payoutId;
    return {
      ...payout,
      isPrimary,
      bankDate: isPrimary ? rollIfClosed(payout.payoutDate) : nextBusinessDay(payout.payoutDate),
    };
  });
};

/**
 * Label each payout with the deposit-date CSV name (12-31-2025(1).csv),
 * preferring import-history / original filenames over RAW sale-date copies.
 */
export const applyOriginalCsvNames = (
  payouts: ArchivedPayout[],
  historyFilenameByPayoutId: Map<string, string> | Record<string, string> = new Map()
): ArchivedPayout[] => {
  const lookup =
    historyFilenameByPayoutId instanceof Map
      ? historyFilenameByPayoutId
      : new Map(Object.entries(historyFilenameByPayoutId));

  const named = payouts.map((payout) => {
    const historyName = lookup.get(payout.payoutId);
    const preferred = [historyName, payout.filename].find((name) => name && isDepositCsvName(name));
    if (!preferred) return payout;
    const filename = fileBaseName(preferred);
    return { ...payout, filename, suffix: filenameSuffix(filename) };
  });

  const dated = assignBankDates(named);

  return dated.map((payout) => {
    if (isDepositCsvName(payout.filename)) return payout;
    const secondaries = dated
      .filter((item) => item.payoutDate === payout.payoutDate && !item.isPrimary)
      .sort((a, b) => a.payoutId.localeCompare(b.payoutId));
    const suffix = payout.isPrimary
      ? 0
      : secondaries.findIndex((item) => item.payoutId === payout.payoutId) + 1;
    return {
      ...payout,
      suffix,
      filename: depositCsvName(payout.payoutDate, suffix) || payout.filename,
    };
  });
};

const inRange = (value: string, fromDate: string, toDate: string): boolean =>
  value >= fromDate && value <= toDate;

const monthsFromWindow = (fromDate: string, toDate: string): string[] => {
  const months: string[] = [];
  let [year, month] = fromDate.split('-').map(Number);
  const [endYear, endMonth] = toDate.split('-').map(Number);
  if (!year || !month || !endYear || !endMonth) return months;

  while (year < endYear || (year === endYear && month <= endMonth)) {
    months.push(`${year}-${String(month).padStart(2, '0')}`);
    month += 1;
    if (month > 12) {
      month = 1;
      year += 1;
    }
  }
  return months;
};

const daysInYearMonth = (yearMonth: string): string[] => {
  const [year, month] = yearMonth.split('-').map(Number);
  if (!year || !month) return [];
  const lastDay = new Date(year, month, 0).getDate();
  const days: string[] = [];
  for (let day = 1; day <= lastDay; day += 1) {
    days.push(`${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`);
  }
  return days;
};

const calendarMonthLabel = (yearMonths: string[]): string =>
  yearMonths
    .map((yearMonth) => {
      const [year, month] = yearMonth.split('-').map(Number);
      return new Date(year, (month || 1) - 1, 1).toLocaleString('en-US', {
        month: 'long',
        year: 'numeric',
      });
    })
    .join(' – ');

const buildCalendarDays = (payouts: ArchivedPayout[], fromDate: string, toDate: string): EOMCalendarDay[] => {
  const months = monthsFromWindow(fromDate, toDate);
  const allowed = new Set(months.flatMap(daysInYearMonth));
  const byDay = new Map<string, { gross: number; fees: number; net: number; count: number }>();

  payouts.forEach((payout) => {
    payout.transactions.forEach((transaction) => {
      const day = getCalendarDateString(transaction.dateTime);
      if (!day || !allowed.has(day)) return;
      const current = byDay.get(day) || { gross: 0, fees: 0, net: 0, count: 0 };
      current.gross += cents(transaction.amount);
      current.fees += cents(transaction.fee);
      current.net += cents(transaction.net);
      current.count += 1;
      byDay.set(day, current);
    });
  });

  return months.flatMap(daysInYearMonth).map((date) => {
    const current = byDay.get(date) || { gross: 0, fees: 0, net: 0, count: 0 };
    return {
      date,
      transactionCount: current.count,
      gross: fromCents(current.gross),
      fees: fromCents(current.fees),
      net: fromCents(current.net),
    };
  });
};

export type EomBrand = 'SHOPIFY' | 'PAYPAL';

export const reconcileEom = (
  archive: ArchivedPayout[],
  fromDate: string,
  toDate: string,
  wellsFargoTotal: number,
  options?: {
    assignBankDates?: boolean;
    calendarTransactions?: PayoutLine[];
    brand?: EomBrand;
  }
): EOMSummary => {
  const dated = options?.assignBankDates === false ? archive : assignBankDates(archive);
  const exceptions: EOMException[] = [];
  const included: ArchivedPayout[] = [];
  const today = formatYmd(new Date());

  dated.forEach((payout) => {
    const inWindow = inRange(payout.bankDate, fromDate, toDate);

    const status = payout.payoutStatus.toLowerCase();
    const stillPending = (status === 'in_transit' || status === 'scheduled') && payout.bankDate > today;
    if (stillPending) {
      if (inWindow || inRange(payout.payoutDate, fromDate, toDate)) {
        exceptions.push({
          kind: status === 'scheduled' ? 'scheduled' : 'in_transit',
          payout,
          note: `Payout status is ${payout.payoutStatus}. This transfer has not posted to Wells Fargo yet.`,
        });
      }
      return;
    }

    if (inWindow && payout.refundOnly) {
      exceptions.push({
        kind: 'refund_only',
        payout,
        note: `Refund-only ACH excluded from the Wells Fargo deposit total (${formatUsd(payout.net)}).`,
      });
      return;
    }

    if (inWindow) {
      included.push(payout);
    }
  });

  const calculatedTotal = fromCents(included.reduce((sum, payout) => sum + cents(payout.net), 0));
  const variance = fromCents(cents(calculatedTotal) - cents(wellsFargoTotal));
  const matched = cents(calculatedTotal) === cents(wellsFargoTotal);

  if (!matched) {
    const nearFrom = addDays(fromDate, -3);
    const nearTo = addDays(toDate, 3);
    dated.forEach((payout) => {
      if (payout.refundOnly) return;
      const bank = payout.bankDate;
      const inWindow = inRange(bank, fromDate, toDate);
      const justOutside =
        (bank >= nearFrom && bank < fromDate) || (bank > toDate && bank <= nearTo);
      const payoutInBankOut = inRange(payout.payoutDate, fromDate, toDate) && !inWindow;
      if (justOutside || payoutInBankOut) {
        exceptions.push({
          kind: 'outside_window',
          payout,
          note: `Bank date ${formatDisplayDate(bank)} is outside ${formatDisplayDate(fromDate)} to ${formatDisplayDate(toDate)} (payout date ${formatDisplayDate(payout.payoutDate)}, ${formatUsd(payout.net)}).`,
        });
      }

    });
  }

  const byBankDate = new Map<string, ArchivedPayout[]>();
  included
    .slice()
    .sort((a, b) => a.bankDate.localeCompare(b.bankDate) || a.filename.localeCompare(b.filename))
    .forEach((payout) => {
      const list = byBankDate.get(payout.bankDate) || [];
      list.push(payout);
      byBankDate.set(payout.bankDate, list);
    });

  const days: EOMDayGroup[] = Array.from(byBankDate.entries()).map(([bankDate, payouts]) => ({
    bankDate,
    payouts,
    depositNet: fromCents(payouts.reduce((sum, payout) => sum + cents(payout.net), 0)),
    depositAmount: fromCents(payouts.reduce((sum, payout) => sum + cents(payout.amount), 0)),
    depositFees: fromCents(payouts.reduce((sum, payout) => sum + cents(payout.fee), 0)),
    achCount: payouts.length,
    transactionCount: payouts.reduce((sum, payout) => sum + payout.transactions.length, 0),
  }));

  const calendarSource =
    options?.calendarTransactions && options.calendarTransactions.length > 0
      ? [{ transactions: options.calendarTransactions } as ArchivedPayout]
      : dated;
  const calendarDays = buildCalendarDays(calendarSource, fromDate, toDate);
  const calendarGross = fromCents(calendarDays.reduce((sum, day) => sum + cents(day.gross), 0));

  return {
    fromDate,
    toDate,
    wellsFargoTotal,
    calculatedTotal,
    variance,
    matched,
    days,
    calendarDays,
    calendarGross,
    calendarMonthLabel: calendarMonthLabel(monthsFromWindow(fromDate, toDate)),
    exceptions,
    includedPayoutCount: included.length,
    archiveCount: dated.length,
    brand: options?.brand || 'SHOPIFY',
  };
};

const emptyCalendarDay = (date: string): EOMCalendarDay => ({
  date,
  transactionCount: 0,
  gross: 0,
  fees: 0,
  net: 0,
});

const addCalendarDay = (left: EOMCalendarDay, right: EOMCalendarDay): EOMCalendarDay => ({
  date: left.date || right.date,
  transactionCount: left.transactionCount + right.transactionCount,
  gross: fromCents(cents(left.gross) + cents(right.gross)),
  fees: fromCents(cents(left.fees) + cents(right.fees)),
  net: fromCents(cents(left.net) + cents(right.net)),
});

export const sumCalendarDays = (days: EOMCalendarDay[]): EOMCalendarDay =>
  days.reduce(
    (total, day) => addCalendarDay(total, day),
    emptyCalendarDay(days[0]?.date || '')
  );

export const buildCombinedPacket = (
  fromDate: string,
  toDate: string,
  sources: EomSource[],
  shopify?: EOMSummary,
  paypal?: EOMSummary
): CombinedEOMPacket => {
  const dates =
    shopify?.calendarDays?.map((day) => day.date) ||
    paypal?.calendarDays?.map((day) => day.date) ||
    [];
  const shopifyByDate = new Map((shopify?.calendarDays || []).map((day) => [day.date, day]));
  const paypalByDate = new Map((paypal?.calendarDays || []).map((day) => [day.date, day]));

  return {
    fromDate,
    toDate,
    sources,
    shopify,
    paypal,
    calendarMonthLabel:
      shopify?.calendarMonthLabel ||
      paypal?.calendarMonthLabel ||
      calendarMonthLabel(monthsFromWindow(fromDate, toDate)),
    combinedDays: dates.map((date) => {
      const shopifyDay = shopifyByDate.get(date) || emptyCalendarDay(date);
      const paypalDay = paypalByDate.get(date) || emptyCalendarDay(date);
      return {
        date,
        shopify: shopifyDay,
        paypal: paypalDay,
        combined: addCalendarDay(shopifyDay, paypalDay),
      };
    }),
  };
};
