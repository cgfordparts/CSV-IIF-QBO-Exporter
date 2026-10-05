/**
 * Calendar-day helpers (midnight → midnight).
 * No time-of-day cutovers (no 4 PM / 5 PM rules).
 *
 * Prefer the date embedded in Shopify/PayPal strings so the store's
 * local calendar day is used, not a UTC shift from toISOString().
 */

export function getCalendarDateString(dateTime: string): string | null {
  if (!dateTime || typeof dateTime !== 'string') return null;

  const trimmed = dateTime.trim();

  // Shopify payment exports: "2026-05-24 16:03:02 -0700"
  const shopify = trimmed.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (shopify) {
    return `${shopify[1]}-${shopify[2]}-${shopify[3]}`;
  }

  // PayPal-style: "MM/DD/YYYY HH:mm:ss" or "MM/DD/YYYY"
  const paypal = trimmed.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (paypal) {
    const month = paypal[1].padStart(2, '0');
    const day = paypal[2].padStart(2, '0');
    return `${paypal[3]}-${month}-${day}`;
  }

  // ISO-ish fallback
  const iso = trimmed.match(/^(\d{4}-\d{2}-\d{2})T/);
  if (iso) return iso[1];

  const date = new Date(trimmed);
  if (Number.isNaN(date.getTime())) return null;

  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export function getYearMonth(dateTimeOrDate: string): string | null {
  const day = getCalendarDateString(dateTimeOrDate);
  return day ? day.substring(0, 7) : null;
}

/** Display calendar dates as month-day-year. Internal storage stays YYYY-MM-DD. */
export function formatDisplayDate(value: string | null | undefined): string {
  if (!value) return '';
  const trimmed = String(value).trim();
  if (!trimmed) return '';

  const iso = trimmed.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return `${iso[2]}-${iso[3]}-${iso[1]}`;

  const paypal = trimmed.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (paypal) {
    const month = paypal[1].padStart(2, '0');
    const day = paypal[2].padStart(2, '0');
    return `${month}-${day}-${paypal[3]}`;
  }

  const day = getCalendarDateString(trimmed);
  if (day) {
    const [year, month, date] = day.split('-');
    return `${month}-${date}-${year}`;
  }

  return trimmed;
}

export function formatDisplayDateRange(fromDate: string, toDate: string): string {
  return `${formatDisplayDate(fromDate)} to ${formatDisplayDate(toDate)}`;
}

export function formatMoney(n: number): string {
  const formatted = Math.abs(n).toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return n < 0 ? `-$${formatted}` : `$${formatted}`;
}

/** Processing fees are a subtraction from gross. Shopify exports them positive; PayPal already negative. */
export function asExpenseFee(value: number): number {
  if (!value || Number.isNaN(value)) return 0;
  return value > 0 ? -value : value;
}

/** Order #: newest (highest) first, oldest last. */
export function compareOrderNumberNewestFirst(
  a: { orderNumber?: string },
  b: { orderNumber?: string }
): number {
  return (b.orderNumber || '').localeCompare(a.orderNumber || '', undefined, {
    numeric: true,
    sensitivity: 'base'
  });
}
