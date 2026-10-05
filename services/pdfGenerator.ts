
import { jsPDF } from 'jspdf';
import autoTable from 'jspdf-autotable';
import { ReportSummary, DailyGroup, ShopifyTransaction, CombinedEOMPacket, EOMDayGroup, EOMSummary } from '../types';
import {
  getCalendarDateString,
  getYearMonth,
  formatMoney,
  formatDisplayDate,
  formatDisplayDateRange,
  compareOrderNumberNewestFirst
} from './dateUtils';
import { sumCalendarDays } from './eom.service';

export const generateTransactionPDF = (
  summary: ReportSummary,
  reportType: 'SHOPIFY' | 'PAYPAL' = 'SHOPIFY',
  selectedDates?: string[]
) => {
  const allowed = selectedDates && selectedDates.length > 0 ? new Set(selectedDates) : null;
  const pdfGroups: DailyGroup[] = summary.dailyGroups
    .filter((g) => !allowed || allowed.has(g.date))
    .slice()
    .sort((a, b) => a.date.localeCompare(b.date));

  if (pdfGroups.length === 0) {
    return;
  }

  const reportTitle = reportType === 'SHOPIFY' ? 'Shopify Transaction Report' : 'PayPal Transaction Report';
  const filePrefix = reportType === 'SHOPIFY' ? 'Shopify-Report' : 'PayPal-Report';

  const doc = new jsPDF();
  const pageWidth = doc.internal.pageSize.getWidth();
  const pageHeight = doc.internal.pageSize.getHeight();

  pdfGroups.forEach((group, groupIndex) => {
    if (groupIndex > 0) {
      doc.addPage();
    }

    // Header - Centered
    doc.setFontSize(22);
    doc.setTextColor(40);
    doc.text(reportTitle, pageWidth / 2, 22, { align: 'center' });

    doc.setFontSize(12);
    doc.setTextColor(100);
    doc.text(`Calendar Date: ${formatDisplayDate(group.date)}`, pageWidth / 2, 30, { align: 'center' });

    const tableBody: any[] = [];

    const transactionsByFile: Record<string, ShopifyTransaction[]> = {};
    group.transactions.forEach((t) => {
      const key = t.sourceFile || 'Unknown Source';
      if (!transactionsByFile[key]) {
        transactionsByFile[key] = [];
      }
      transactionsByFile[key].push(t);
    });

    Object.entries(transactionsByFile).forEach(([fileName, txns]) => {
      txns.sort(compareOrderNumberNewestFirst);

      const fileSubtotal = txns.reduce((sum, t) => sum + Math.round(t.amount * 100), 0) / 100;
      const fileFees = txns.reduce((sum, t) => sum + Math.round(t.fee * 100), 0) / 100;
      const fileNet = txns.reduce((sum, t) => sum + Math.round(t.net * 100), 0) / 100;

      tableBody.push([
        {
          content: `CSV batch: ${fileName}`,
          colSpan: 9,
          styles: {
            fillColor: [226, 232, 240],
            textColor: [30, 41, 59],
            fontStyle: 'bold'
          }
        }
      ]);

      txns.forEach((t) => {
        tableBody.push([
          new Date(t.dateTime).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
          t.orderNumber,
          t.customerName,
          t.type,
          t.cardBrand,
          `$${t.amount.toFixed(2)}`,
          formatMoney(t.fee),
          `$${t.net.toFixed(2)}`,
          '[  ]'
        ]);
      });

      tableBody.push([
        {
          content: `Batch Subtotal — ${fileName} (${txns.length} txns)`,
          colSpan: 5,
          styles: {
            fillColor: [248, 250, 252],
            textColor: [30, 41, 59],
            fontStyle: 'bold',
            halign: 'right'
          }
        },
        {
          content: `$${fileSubtotal.toFixed(2)}`,
          styles: {
            fillColor: [248, 250, 252],
            textColor: [30, 41, 59],
            fontStyle: 'bold',
            halign: 'right'
          }
        },
        {
          content: formatMoney(fileFees),
          styles: {
            fillColor: [248, 250, 252],
            textColor: [100, 116, 139],
            fontStyle: 'bold',
            halign: 'right'
          }
        },
        {
          content: `$${fileNet.toFixed(2)}`,
          styles: {
            fillColor: [248, 250, 252],
            textColor: [30, 41, 59],
            fontStyle: 'bold',
            halign: 'right'
          }
        },
        {
          content: '',
          styles: {
            fillColor: [248, 250, 252]
          }
        }
      ]);
    });

    autoTable(doc, {
      startY: 45,
      head: [['Time', 'Order #', 'Customer', 'Type', 'Card Type', 'Amount', 'Fee', 'Net', 'Verify']],
      body: tableBody,
      theme: 'striped',
      headStyles: { fillColor: [51, 65, 85], halign: 'left' },
      columnStyles: {
        5: { halign: 'right' },
        6: { halign: 'right' },
        7: { halign: 'right' },
        8: { halign: 'center', cellWidth: 20 }
      },
      alternateRowStyles: { fillColor: [255, 255, 255] },
      margin: { top: 45 },
      styles: { fontSize: 7 },
      didDrawPage: (data) => {
        doc.setFontSize(8);
        doc.setTextColor(150);
        doc.text(`Page ${data.pageNumber}`, pageWidth / 2, pageHeight - 10, { align: 'center' });
      }
    });

    const finalY = (doc as any).lastAutoTable.finalY || 45;
    const summaryBoxHeight = 40;

    let summaryY = finalY + 15;
    if (summaryY + summaryBoxHeight > pageHeight - 20) {
      doc.addPage();
      summaryY = 20;
    }

    doc.setFillColor(245, 247, 250);
    doc.rect(14, summaryY, pageWidth - 28, summaryBoxHeight, 'F');

    doc.setFontSize(12);
    doc.setTextColor(40);
    doc.text('Daily Summary', 20, summaryY + 8);

    doc.setFontSize(10);
    doc.setTextColor(100);
    doc.text(`Total Transactions: ${group.count}`, 20, summaryY + 18);
    doc.text(
      `Total Fees: ${formatMoney(group.subtotalFees)}`,
      20,
      summaryY + 26
    );
    doc.text(
      `Total Net: $${group.subtotalNet.toLocaleString(undefined, { minimumFractionDigits: 2 })}`,
      20,
      summaryY + 34
    );

    doc.setFontSize(14);
    doc.setTextColor(40);
    doc.text(
      `Gross Balance: $${group.subtotal.toLocaleString(undefined, { minimumFractionDigits: 2 })}`,
      pageWidth - 100,
      summaryY + 18
    );
  });

  const dateLabel =
    pdfGroups.length === 1
      ? formatDisplayDate(pdfGroups[0].date)
      : `${formatDisplayDate(pdfGroups[0].date)}_to_${formatDisplayDate(pdfGroups[pdfGroups.length - 1].date)}`;
  doc.save(`${filePrefix}-${dateLabel}.pdf`);
};

/** Single reporting-day PDF as data URI (for Day End archive). */
export const generateDayEndPDFDataUri = (
  summary: ReportSummary,
  reportType: 'SHOPIFY' | 'PAYPAL',
  date: string
): string | null => {
  const group = summary.dailyGroups.find((g) => g.date === date);
  if (!group) return null;

  const reportTitle = reportType === 'SHOPIFY' ? 'Shopify Transaction Report' : 'PayPal Transaction Report';
  const doc = new jsPDF();
  const pageWidth = doc.internal.pageSize.getWidth();
  const pageHeight = doc.internal.pageSize.getHeight();

  doc.setFontSize(22);
  doc.setTextColor(40);
  doc.text(reportTitle, pageWidth / 2, 22, { align: 'center' });
  doc.setFontSize(12);
  doc.setTextColor(100);
  doc.text(`Calendar Date: ${formatDisplayDate(group.date)}`, pageWidth / 2, 30, { align: 'center' });

  const tableBody: any[] = [];
  const transactionsByFile: Record<string, ShopifyTransaction[]> = {};
  group.transactions.forEach((t) => {
    const key = t.sourceFile || 'Unknown Source';
    if (!transactionsByFile[key]) transactionsByFile[key] = [];
    transactionsByFile[key].push(t);
  });

  Object.entries(transactionsByFile).forEach(([fileName, txns]) => {
    txns.sort(compareOrderNumberNewestFirst);
    const fileSubtotal = txns.reduce((sum, t) => sum + Math.round(t.amount * 100), 0) / 100;
    const fileFees = txns.reduce((sum, t) => sum + Math.round(t.fee * 100), 0) / 100;
    const fileNet = txns.reduce((sum, t) => sum + Math.round(t.net * 100), 0) / 100;

    tableBody.push([
      {
        content: `CSV batch: ${fileName}`,
        colSpan: 9,
        styles: { fillColor: [226, 232, 240], textColor: [30, 41, 59], fontStyle: 'bold' }
      }
    ]);
    txns.forEach((t) => {
      tableBody.push([
        new Date(t.dateTime).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        t.orderNumber,
        t.customerName,
        t.type,
        t.cardBrand,
        `$${t.amount.toFixed(2)}`,
        formatMoney(t.fee),
        `$${t.net.toFixed(2)}`,
        '[  ]'
      ]);
    });
    tableBody.push([
      {
        content: `Batch Subtotal — ${fileName} (${txns.length} txns)`,
        colSpan: 5,
        styles: {
          fillColor: [248, 250, 252],
          textColor: [30, 41, 59],
          fontStyle: 'bold',
          halign: 'right'
        }
      },
      {
        content: `$${fileSubtotal.toFixed(2)}`,
        styles: { fillColor: [248, 250, 252], textColor: [30, 41, 59], fontStyle: 'bold', halign: 'right' }
      },
      {
        content: formatMoney(fileFees),
        styles: { fillColor: [248, 250, 252], textColor: [100, 116, 139], fontStyle: 'bold', halign: 'right' }
      },
      {
        content: `$${fileNet.toFixed(2)}`,
        styles: { fillColor: [248, 250, 252], textColor: [30, 41, 59], fontStyle: 'bold', halign: 'right' }
      },
      { content: '', styles: { fillColor: [248, 250, 252] } }
    ]);
  });

  autoTable(doc, {
    startY: 45,
    head: [['Time', 'Order #', 'Customer', 'Type', 'Card Type', 'Amount', 'Fee', 'Net', 'Verify']],
    body: tableBody,
    theme: 'striped',
    headStyles: { fillColor: [51, 65, 85], halign: 'left' },
    columnStyles: {
      5: {halign: 'right' },
      6: {halign: 'right' },
      7: {halign: 'right' },
      8: {halign: 'center', cellWidth: 20 }
    },
    alternateRowStyles: { fillColor: [255, 255, 255] },
    margin: { top: 45 },
    styles: { fontSize: 7 },
    didDrawPage: (data) => {
      doc.setFontSize(8);
      doc.setTextColor(150);
      doc.text(`Page ${data.pageNumber}`, pageWidth / 2, pageHeight - 10, { align: 'center' });
    }
  });

  const finalY = (doc as any).lastAutoTable.finalY || 45;
  let summaryY = finalY + 15;
  if (summaryY + 40 > pageHeight - 20) {
    doc.addPage();
    summaryY = 20;
  }
  doc.setFillColor(245, 247, 250);
  doc.rect(14, summaryY, pageWidth - 28, 40, 'F');
  doc.setFontSize(12);
  doc.setTextColor(40);
  doc.text('Daily Summary', 20, summaryY + 8);
  doc.setFontSize(10);
  doc.setTextColor(100);
  doc.text(`Total Transactions: ${group.count}`, 20, summaryY + 18);
  doc.text(
    `Total Fees: ${formatMoney(group.subtotalFees)}`,
    20,
    summaryY + 26
  );
  doc.text(
    `Total Net: $${group.subtotalNet.toLocaleString(undefined, { minimumFractionDigits: 2 })}`,
    20,
    summaryY + 34
  );
  doc.setFontSize(14);
  doc.setTextColor(40);
  doc.text(
    `Gross Balance: $${group.subtotal.toLocaleString(undefined, { minimumFractionDigits: 2 })}`,
    pageWidth - 100,
    summaryY + 18
  );

  return doc.output('datauristring');
};

/**
 * Months a CSV can appear on a rolling report:
 * - calendar months of its transaction dates (sales / reporting days)
 * - plus payout month when present (Wells deposit date)
 */
export const getImportRollingMonths = (imp: any): string[] => {
  const months = new Set<string>();

  const payoutDate =
    imp.payoutDate ||
    (imp.transactions || []).find((tx: ShopifyTransaction) => tx.payoutDate)?.payoutDate;
  if (payoutDate) {
    const ym = getYearMonth(payoutDate);
    if (ym) months.add(ym);
  }

  if (imp.transactions) {
    imp.transactions.forEach((tx: ShopifyTransaction) => {
      const ym = getYearMonth(tx.dateTime);
      if (ym) months.add(ym);
    });
  }

  return Array.from(months);
};

const importBelongsToMonth = (imp: any, yearMonth: string): boolean => {
  return getImportRollingMonths(imp).includes(yearMonth);
};

const sumTxns = (txns: ShopifyTransaction[]) => {
  const gross = txns.reduce((s, t) => s + Math.round((t.amount || 0) * 100), 0) / 100;
  const fees = txns.reduce((s, t) => s + Math.round((t.fee || 0) * 100), 0) / 100;
  const net = txns.reduce((s, t) => s + Math.round((t.net || 0) * 100), 0) / 100;
  return { gross, fees, net };
};

const csvDocumentTotals = (imp: any, allTxns: ShopifyTransaction[]) => {
  if (imp.csvGross !== undefined) {
    return {
      gross: imp.csvGross,
      fees: imp.csvFees !== undefined ? imp.csvFees : 0,
      net: imp.csvNet !== undefined ? imp.csvNet : imp.csvGross
    };
  }
  return sumTxns(allTxns);
};

/** Flatten PayPal history to unique Transaction IDs (bracket overlaps). Skip withdrawals. */
const collectUniquePaypalLedger = (imports: any[]) => {
  const byId = new Map<string, ShopifyTransaction>();
  (imports || []).forEach((imp) => {
    (imp.transactions || []).forEach((tx: ShopifyTransaction) => {
      const type = String(tx.type || '').trim();
      if (type === 'General Withdrawal' || type === 'User Initiated Withdrawal') return;
      const id = String(tx.orderNumber || '').trim();
      if (!id || byId.has(id)) return;
      byId.set(id, tx);
    });
  });
  return Array.from(byId.values());
};

/**
 * PayPal rolling PDF:
 * Unique sales/refunds by Transaction ID (bracket overlaps collapsed).
 * Grouped by reporting day. General Withdrawals are excluded app-wide.
 */
const generatePaypalRollingPDF = (
  imports: any[],
  yearMonth: string,
  monthName: string
): string => {
  const doc = new jsPDF();
  const pageWidth = doc.internal.pageSize.getWidth();
  const pageHeight = doc.internal.pageSize.getHeight();

  doc.setFontSize(16);
  doc.setTextColor(30, 41, 59);
  doc.text(`PayPal Monthly Rolling Report - ${monthName}`, 14, 18);

  doc.setFontSize(8);
  doc.setTextColor(100, 116, 139);
  doc.text(`Generated on ${new Date().toLocaleString()}`, 14, 24);
  doc.text('Overlapping exports deduped by Transaction ID · General Withdrawals excluded', 14, 28);

  doc.setDrawColor(226, 232, 240);
  doc.line(14, 30, pageWidth - 14, 30);

  let currentY = 35;

  const monthSales = collectUniquePaypalLedger(imports)
    .filter((p) => getYearMonth(p.dateTime) === yearMonth)
    .sort((a, b) => a.dateTime.localeCompare(b.dateTime));

  if (monthSales.length === 0) {
    doc.setFontSize(12);
    doc.setTextColor(100);
    doc.text('No PayPal sales recorded for this month.', 14, currentY);
    return doc.output('datauristring');
  }

  const monthly = sumTxns(monthSales);

  const dailyGroups: Record<string, ShopifyTransaction[]> = {};
  monthSales.forEach((tx) => {
    const day = getCalendarDateString(tx.dateTime);
    if (!day) return;
    if (!dailyGroups[day]) dailyGroups[day] = [];
    dailyGroups[day].push(tx);
  });
  const sortedDates = Object.keys(dailyGroups).sort();

  const tableBody: any[] = [];
  sortedDates.forEach((dateStr) => {
    const dayTxns = dailyGroups[dateStr].sort(compareOrderNumberNewestFirst);
    const day = sumTxns(dayTxns);

    tableBody.push([
      {
        content: `Reporting Day: ${formatDisplayDate(dateStr)}`,
        colSpan: 5,
        styles: {
          fillColor: [224, 242, 254],
          textColor: [3, 105, 161],
          fontStyle: 'bold'
        }
      },
      {
        content: `$${day.gross.toFixed(2)}`,
        styles: {
          fillColor: [224, 242, 254],
          textColor: [3, 105, 161],
          fontStyle: 'bold',
          halign: 'right'
        }
      },
      {
        content: formatMoney(day.fees),
        styles: {
          fillColor: [224, 242, 254],
          textColor: [100, 116, 139],
          fontStyle: 'bold',
          halign: 'right'
        }
      },
      {
        content: `$${day.net.toFixed(2)}`,
        styles: {
          fillColor: [224, 242, 254],
          textColor: [3, 105, 161],
          fontStyle: 'bold',
          halign: 'right'
        }
      },
      { content: '', styles: { fillColor: [224, 242, 254] } }
    ]);

    dayTxns.forEach((t) => {
      let timeLabel = '';
      try {
        timeLabel = new Date(t.dateTime).toLocaleTimeString([], {
          hour: '2-digit',
          minute: '2-digit'
        });
      } catch {
        timeLabel = '';
      }
      tableBody.push([
        timeLabel,
        t.orderNumber,
        t.customerName,
        t.type,
        t.cardBrand,
        `$${(t.amount || 0).toFixed(2)}`,
        formatMoney(t.fee || 0),
        `$${(t.net || 0).toFixed(2)}`,
        '[  ]'
      ]);
    });
  });

  autoTable(doc, {
    startY: currentY,
    head: [['Time', 'Txn ID', 'Customer', 'Type', 'Card Type', 'Amount', 'Fee', 'Net', 'Verify']],
    body: tableBody,
    theme: 'plain',
    headStyles: { fillColor: [71, 85, 105], textColor: [255, 255, 255], fontStyle: 'bold' },
    columnStyles: {
      5: { halign: 'right' },
      6: { halign: 'right' },
      7: { halign: 'right' },
      8: { halign: 'center', cellWidth: 20 }
    },
    margin: { left: 14, right: 14 },
    styles: { fontSize: 7 },
    didDrawPage: (data) => {
      doc.setFontSize(8);
      doc.setTextColor(150);
      doc.text(`Page ${data.pageNumber}`, pageWidth / 2, pageHeight - 10, { align: 'center' });
    }
  });

  currentY = (doc as any).lastAutoTable.finalY + 12;

  const summaryBoxHeight = 40;
  if (currentY + summaryBoxHeight > pageHeight - 20) {
    doc.addPage();
    currentY = 20;
  }

  doc.setFillColor(30, 41, 59);
  doc.rect(14, currentY, pageWidth - 28, summaryBoxHeight, 'F');

  doc.setFontSize(11);
  doc.setFont('helvetica', 'bold');
  doc.setTextColor(255, 255, 255);
  doc.text(`Monthly Summary - ${monthName}`, 20, currentY + 8);

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(7.5);
  doc.setTextColor(148, 163, 184);
  doc.text('Unique sales/refunds by Transaction ID (General Withdrawals excluded)', 20, currentY + 14);

  doc.setFontSize(9);
  doc.setTextColor(203, 213, 225);
  doc.text(`Total Sales Txns: ${monthSales.length}`, 20, currentY + 22);
  doc.text(`Total Fees: ${formatMoney(monthly.fees)}`, 20, currentY + 31);

  const balanceRightX = pageWidth - 28;
  doc.setFontSize(13);
  doc.setFont('helvetica', 'bold');
  doc.setTextColor(56, 189, 248);
  doc.text(`Gross Balance: ${formatMoney(monthly.gross)}`, balanceRightX, currentY + 20, {
    align: 'right'
  });
  doc.text(`Net Balance: ${formatMoney(monthly.net)}`, balanceRightX, currentY + 32, {
    align: 'right'
  });

  return doc.output('datauristring');
};

/**
 * Rolling monthly PDF matching the Wells deposit print layout:
 * CSV batch → Reporting Day subtotals → Import/CSV subtotal (month portion) →
 * Monthly summary = sum of each listed CSV’s full deposit (Net / Gross), so
 * month-boundary splits reconcile to the Wells deposit amount for that CSV.
 * Within each day, Order # newest (top) → oldest (bottom).
 *
 * PayPal uses a separate path: unique sales by Transaction ID (withdrawals excluded).
 */
export const generateRollingPDF = (
  imports: any[],
  yearMonth: string,
  monthName: string,
  reportType: 'SHOPIFY' | 'PAYPAL' = 'SHOPIFY'
): string => {
  if (reportType === 'PAYPAL') {
    return generatePaypalRollingPDF(imports, yearMonth, monthName);
  }

  const doc = new jsPDF();
  const pageWidth = doc.internal.pageSize.getWidth();
  const pageHeight = doc.internal.pageSize.getHeight();

  const reportTitle = `Shopify Monthly Rolling Report - ${monthName}`;

  doc.setFontSize(16);
  doc.setTextColor(30, 41, 59);
  doc.text(reportTitle, 14, 18);

  doc.setFontSize(8);
  doc.setTextColor(100, 116, 139);
  doc.text(`Generated on ${new Date().toLocaleString()}`, 14, 24);

  doc.setDrawColor(226, 232, 240);
  doc.line(14, 27, pageWidth - 14, 27);

  let currentY = 32;

  // Include CSVs that touch this month via sales day or payout date
  const candidateImports = (imports || [])
    .filter((imp) => imp && Array.isArray(imp.transactions) && imp.transactions.length > 0)
    .filter((imp) => importBelongsToMonth(imp, yearMonth))
    .map((imp) => {
      const allTxns: ShopifyTransaction[] = imp.transactions || [];
      const monthTxns = allTxns.filter((tx) => getYearMonth(tx.dateTime) === yearMonth);
      return { imp, allTxns, monthTxns };
    })
    // Only list a CSV if it has sales lines in this calendar month (matches sample layout)
    .filter((row) => row.monthTxns.length > 0)
    .sort((a, b) => {
      const aKey = a.imp.importDate || a.imp.payoutDate || '';
      const bKey = b.imp.importDate || b.imp.payoutDate || '';
      if (aKey !== bKey) return aKey.localeCompare(bKey);
      return (a.imp.filename || '').localeCompare(b.imp.filename || '');
    });

  if (candidateImports.length === 0) {
    doc.setFontSize(12);
    doc.setTextColor(100);
    doc.text('No transactions recorded for this month.', 14, currentY);
    return doc.output('datauristring');
  }

  // Wells month total = full deposit for every CSV printed on this report
  // (not calendar-month portion; not “payout date month” only).
  let monthlyGrossCents = 0;
  let monthlyFeesCents = 0;
  let monthlyNetCents = 0;
  let monthlyTotalTxns = 0;

  candidateImports.forEach(({ allTxns, imp }) => {
    const full = csvDocumentTotals(imp, allTxns);
    monthlyGrossCents += Math.round(full.gross * 100);
    monthlyFeesCents += Math.round(full.fees * 100);
    monthlyNetCents += Math.round(full.net * 100);
    monthlyTotalTxns += allTxns.length;
  });

  candidateImports.forEach(({ imp, allTxns, monthTxns }) => {
    const portion = sumTxns(monthTxns);
    const full = csvDocumentTotals(imp, allTxns);

    const isSplit = monthTxns.length !== allTxns.length;

    if (currentY > pageHeight - 50) {
      doc.addPage();
      currentY = 20;
    }

    // --- CSV / deposit header ---
    const depositDate =
      imp.payoutDate ||
      monthTxns.find((t) => t.payoutDate)?.payoutDate ||
      'Unknown deposit date';
    // Height fits right-side totals (through currentY + 21) and optional payout ID line
    const headerH = isSplit ? 28 : 26;
    doc.setFillColor(248, 250, 252);
    doc.rect(14, currentY, pageWidth - 28, headerH, 'F');
    doc.setDrawColor(203, 213, 225);
    doc.rect(14, currentY, pageWidth - 28, headerH, 'D');

    doc.setFont('helvetica', 'bold');
    doc.setFontSize(9);
    doc.setTextColor(30, 41, 59);
    doc.text(`Deposit / Payout Date: ${formatDisplayDate(depositDate)}`, 18, currentY + 7);

    doc.setFont('helvetica', 'normal');
    doc.setFontSize(7.5);
    doc.setTextColor(71, 85, 105);
    doc.text(`File Name: ${imp.filename || 'Unknown'}`, 18, currentY + 13);
    if (imp.payoutId) {
      doc.text(`Payout ID: ${imp.payoutId}`, 18, currentY + 18);
    }

    if (isSplit) {
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(8);
      doc.setTextColor(15, 23, 42);
      doc.text("This Month's Portion", pageWidth - 92, currentY + 6);
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(7.5);
      doc.setTextColor(71, 85, 105);
      doc.text(`Gross: $${portion.gross.toFixed(2)}`, pageWidth - 92, currentY + 11);
      doc.text(`Fees: ${formatMoney(portion.fees)}`, pageWidth - 92, currentY + 16);
      doc.setFont('helvetica', 'bold');
      doc.text(`Net: $${portion.net.toFixed(2)}`, pageWidth - 92, currentY + 21);

      doc.setFont('helvetica', 'bold');
      doc.setTextColor(15, 23, 42);
      doc.text('Full CSV Document', pageWidth - 48, currentY + 6);
      doc.setFont('helvetica', 'normal');
      doc.setTextColor(71, 85, 105);
      doc.text(`Gross: $${full.gross.toFixed(2)}`, pageWidth - 48, currentY + 11);
      doc.text(`Fees: ${formatMoney(full.fees)}`, pageWidth - 48, currentY + 16);
      doc.setFont('helvetica', 'bold');
      doc.text(`Net: $${full.net.toFixed(2)}`, pageWidth - 48, currentY + 21);
    } else {
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(8);
      doc.setTextColor(15, 23, 42);
      doc.text('CSV Document Totals', pageWidth - 48, currentY + 6);
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(7.5);
      doc.setTextColor(71, 85, 105);
      doc.text(`Gross: $${full.gross.toFixed(2)}`, pageWidth - 48, currentY + 11);
      doc.text(`Fees: ${formatMoney(full.fees)}`, pageWidth - 48, currentY + 16);
      doc.setFont('helvetica', 'bold');
      doc.text(`Net: $${full.net.toFixed(2)}`, pageWidth - 48, currentY + 21);
    }

    currentY += headerH + 4;

    // Group this month's lines by Reporting Day; Order # newest → oldest within day
    const dailyGroups: Record<string, ShopifyTransaction[]> = {};
    monthTxns.forEach((tx) => {
      const day = getCalendarDateString(tx.dateTime);
      if (!day) return;
      if (!dailyGroups[day]) dailyGroups[day] = [];
      dailyGroups[day].push(tx);
    });
    const sortedDates = Object.keys(dailyGroups).sort(); // chronological days

    const tableBody: any[] = [];

    sortedDates.forEach((dateStr) => {
      const dayTxns = dailyGroups[dateStr].sort(compareOrderNumberNewestFirst);
      const day = sumTxns(dayTxns);

      tableBody.push([
        {
          content: `Reporting Day: ${formatDisplayDate(dateStr)}`,
          colSpan: 5,
          styles: {
            fillColor: [224, 242, 254],
            textColor: [3, 105, 161],
            fontStyle: 'bold'
          }
        },
        {
          content: `$${day.gross.toFixed(2)}`,
          styles: {
            fillColor: [224, 242, 254],
            textColor: [3, 105, 161],
            fontStyle: 'bold',
            halign: 'right'
          }
        },
        {
          content: formatMoney(day.fees),
          styles: {
            fillColor: [224, 242, 254],
            textColor: [100, 116, 139],
            fontStyle: 'bold',
            halign: 'right'
          }
        },
        {
          content: `$${day.net.toFixed(2)}`,
          styles: {
            fillColor: [224, 242, 254],
            textColor: [3, 105, 161],
            fontStyle: 'bold',
            halign: 'right'
          }
        },
        { content: '', styles: { fillColor: [224, 242, 254] } }
      ]);

      dayTxns.forEach((t) => {
        let timeLabel = '';
        try {
          timeLabel = new Date(t.dateTime).toLocaleTimeString([], {
            hour: '2-digit',
            minute: '2-digit'
          });
        } catch {
          timeLabel = '';
        }
        tableBody.push([
          timeLabel,
          t.orderNumber,
          t.customerName,
          t.type,
          t.cardBrand,
          `$${(t.amount || 0).toFixed(2)}`,
          formatMoney(t.fee || 0),
          `$${(t.net || 0).toFixed(2)}`,
          '[  ]'
        ]);
      });
    });

    tableBody.push([
      {
        content: `Import Subtotals (${monthTxns.length} txns)`,
        colSpan: 5,
        styles: {
          fillColor: [241, 245, 249],
          textColor: [15, 23, 42],
          fontStyle: 'bold',
          halign: 'right'
        }
      },
      {
        content: `$${portion.gross.toFixed(2)}`,
        styles: {
          fillColor: [241, 245, 249],
          textColor: [15, 23, 42],
          fontStyle: 'bold',
          halign: 'right'
        }
      },
      {
        content: formatMoney(portion.fees),
        styles: {
          fillColor: [241, 245, 249],
          textColor: [100, 116, 139],
          fontStyle: 'bold',
          halign: 'right'
        }
      },
      {
        content: `$${portion.net.toFixed(2)}`,
        styles: {
          fillColor: [241, 245, 249],
          textColor: [15, 23, 42],
          fontStyle: 'bold',
          halign: 'right'
        }
      },
      { content: '', styles: { fillColor: [241, 245, 249] } }
    ]);

    autoTable(doc, {
      startY: currentY,
      head: [['Time', 'Order #', 'Customer', 'Type', 'Card Type', 'Amount', 'Fee', 'Net', 'Verify']],
      body: tableBody,
      theme: 'plain',
      headStyles: { fillColor: [71, 85, 105], textColor: [255, 255, 255], fontStyle: 'bold' },
      columnStyles: {
        5: { halign: 'right' },
        6: { halign: 'right' },
        7: { halign: 'right' },
        8: { halign: 'center', cellWidth: 20 }
      },
      margin: { left: 14, right: 14 },
      styles: { fontSize: 7 },
      didDrawPage: (data) => {
        doc.setFontSize(8);
        doc.setTextColor(150);
        doc.text(`Page ${data.pageNumber}`, pageWidth / 2, pageHeight - 10, { align: 'center' });
      }
    });

    currentY = (doc as any).lastAutoTable.finalY + 12;
  });

  const summaryBoxHeight = 40;
  if (currentY + summaryBoxHeight > pageHeight - 20) {
    doc.addPage();
    currentY = 20;
  }

  const monthlyGross = monthlyGrossCents / 100;
  const monthlyFees = monthlyFeesCents / 100;
  const monthlyNet = monthlyNetCents / 100;

  doc.setFillColor(30, 41, 59);
  doc.rect(14, currentY, pageWidth - 28, summaryBoxHeight, 'F');

  doc.setFontSize(11);
  doc.setFont('helvetica', 'bold');
  doc.setTextColor(255, 255, 255);
  doc.text(`Monthly Summary - ${monthName}`, 20, currentY + 8);

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(7.5);
  doc.setTextColor(148, 163, 184);
  doc.text('Wells deposit totals (full CSV for each deposit listed above)', 20, currentY + 14);

  doc.setFontSize(9);
  doc.setTextColor(203, 213, 225);
  doc.text(`Total Transactions: ${monthlyTotalTxns}`, 20, currentY + 22);
  doc.text(`Total Fees: ${formatMoney(monthlyFees)}`, 20, currentY + 31);

  doc.setFontSize(13);
  doc.setFont('helvetica', 'bold');
  doc.setTextColor(56, 189, 248);
  // Keep inside the summary box (box right edge is pageWidth - 14)
  const balanceRightX = pageWidth - 28;
  doc.text(`Gross Balance: ${formatMoney(monthlyGross)}`, balanceRightX, currentY + 20, {
    align: 'right'
  });
  doc.text(`Net Balance: ${formatMoney(monthlyNet)}`, balanceRightX, currentY + 32, {
    align: 'right'
  });

  return doc.output('datauristring');
};

const usd = (value: number) => formatMoney(value);

const matchStatus = (summary: EOMSummary) =>
  summary.matched ? 'MATCHED' : `VARIANCE ${usd(summary.variance)}`;

const brandHeadColor = (brand: 'SHOPIFY' | 'PAYPAL'): [number, number, number] =>
  brand === 'PAYPAL' ? [30, 64, 175] : [51, 65, 85];

const appendDepositDay = (
  doc: jsPDF,
  pageWidth: number,
  pageHeight: number,
  bankDate: string,
  shopifyDay?: EOMDayGroup,
  paypalDay?: EOMDayGroup
) => {
  doc.addPage();
  doc.setFontSize(16);
  doc.setTextColor(40);
  doc.text('Deposit Detail', pageWidth / 2, 20, { align: 'center' });
  doc.setFontSize(11);
  doc.setTextColor(100);
  const shopifyNet = shopifyDay ? `Shopify ${usd(shopifyDay.depositNet)}` : '';
  const paypalNet = paypalDay ? `PayPal ${usd(paypalDay.depositNet)}` : '';
  doc.text(`Bank date: ${formatDisplayDate(bankDate)}    ${[shopifyNet, paypalNet].filter(Boolean).join('    ')}`, pageWidth / 2, 28, {
    align: 'center',
  });

  const tableBody: any[] = [];
  const appendBrand = (label: string, day: EOMDayGroup, brand: 'SHOPIFY' | 'PAYPAL') => {
    tableBody.push([
      {
        content: label,
        colSpan: 9,
        styles: { fillColor: brandHeadColor(brand), textColor: [255, 255, 255], fontStyle: 'bold' },
      },
    ]);
    day.payouts.forEach((payout) => {
      const csvLabel = payout.filename || payout.payoutId;
      tableBody.push([
        {
          content: `CSV: ${csvLabel}`,
          colSpan: 9,
          styles: { fillColor: [226, 232, 240], textColor: [30, 41, 59], fontStyle: 'bold' },
        },
      ]);
      payout.transactions.forEach((transaction) => {
        const time = transaction.dateTime
          ? new Date(transaction.dateTime).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
          : '';
        tableBody.push([
          time,
          transaction.orderNumber,
          transaction.customerName,
          transaction.type,
          transaction.cardBrand,
          usd(transaction.amount),
          usd(transaction.fee),
          usd(transaction.net),
          '[  ]',
        ]);
      });
      tableBody.push([
        {
          content: `${csvLabel} (${payout.transactions.length} txns)`,
          colSpan: 5,
          styles: { fillColor: [248, 250, 252], textColor: [30, 41, 59], fontStyle: 'bold', halign: 'right' },
        },
        { content: usd(payout.amount), styles: { fillColor: [248, 250, 252], fontStyle: 'bold', halign: 'right' } },
        { content: usd(payout.fee), styles: { fillColor: [248, 250, 252], fontStyle: 'bold', halign: 'right' } },
        { content: usd(payout.net), styles: { fillColor: [248, 250, 252], fontStyle: 'bold', halign: 'right' } },
        { content: '', styles: { fillColor: [248, 250, 252] } },
      ]);
    });
  };

  if (shopifyDay) appendBrand('SHOPIFY', shopifyDay, 'SHOPIFY');
  if (paypalDay) appendBrand('PAYPAL', paypalDay, 'PAYPAL');

  autoTable(doc, {
    startY: 36,
    head: [['Time', 'Order #', 'Customer', 'Type', 'Card Type', 'Amount', 'Fee', 'Net', 'Verify']],
    body: tableBody,
    theme: 'striped',
    headStyles: { fillColor: [51, 65, 85] },
    columnStyles: {
      5: { halign: 'right' },
      6: { halign: 'right' },
      7: { halign: 'right' },
      8: { halign: 'center', cellWidth: 18 },
    },
    styles: { fontSize: 7 },
  });

  const finalY = (doc as any).lastAutoTable.finalY || 45;
  let summaryY = finalY + 12;
  if (summaryY + 32 > pageHeight - 16) {
    doc.addPage();
    summaryY = 20;
  }

  doc.setFillColor(245, 247, 250);
  doc.rect(14, summaryY, pageWidth - 28, 28, 'F');
  doc.setFontSize(11);
  doc.setTextColor(40);
  doc.text('Day deposit', 20, summaryY + 10);
  doc.setFontSize(10);
  doc.setTextColor(100);
  const parts = [
    shopifyDay ? `Shopify ${shopifyDay.achCount} ACH ${usd(shopifyDay.depositNet)}` : '',
    paypalDay ? `PayPal ${paypalDay.achCount} ACH ${usd(paypalDay.depositNet)}` : '',
  ].filter(Boolean);
  doc.text(parts.join('   '), 20, summaryY + 20);
};

export const generateEOMPdf = (
  packet: CombinedEOMPacket,
  mode: 'brief' | 'full' = 'full'
) => {
  const doc = new jsPDF();
  const pageWidth = doc.internal.pageSize.getWidth();
  const pageHeight = doc.internal.pageSize.getHeight();
  const combined = Boolean(packet.shopify && packet.paypal);
  const single = packet.shopify || packet.paypal;
  const brandLabel = combined ? '' : packet.shopify ? 'Shopify' : 'PayPal';

  const drawFooter = (pageNumber: number) => {
    doc.setFontSize(8);
    doc.setTextColor(150);
    doc.text(`Page ${pageNumber}`, pageWidth / 2, pageHeight - 10, { align: 'center' });
  };

  doc.setFontSize(20);
  doc.setTextColor(40);
  doc.text(combined ? 'Monthly Recap' : `${brandLabel} Monthly Recap`, pageWidth / 2, 22, { align: 'center' });

  doc.setFontSize(11);
  doc.setTextColor(100);
  doc.text(packet.calendarMonthLabel || formatDisplayDateRange(packet.fromDate, packet.toDate), pageWidth / 2, 30, { align: 'center' });
  doc.setFontSize(9);
  doc.text(`Wells Fargo deposits: ${formatDisplayDateRange(packet.fromDate, packet.toDate)}`, pageWidth / 2, 36, { align: 'center' });

  const coverBody: any[] = [];
  if (packet.shopify) {
    coverBody.push(
      [{ content: 'Shopify', colSpan: 2, styles: { fontStyle: 'bold', fillColor: [241, 245, 249] } }],
      ['Wells Fargo total', usd(packet.shopify.wellsFargoTotal)],
      ['Calculated deposits', usd(packet.shopify.calculatedTotal)],
      ['Status', matchStatus(packet.shopify)],
      ['ACH payouts included', String(packet.shopify.includedPayoutCount)],
      ['Calendar month gross', usd(packet.shopify.calendarGross)]
    );
  }
  if (packet.paypal) {
    coverBody.push(
      [{ content: 'PayPal', colSpan: 2, styles: { fontStyle: 'bold', fillColor: [239, 246, 255] } }],
      ['Wells Fargo total', usd(packet.paypal.wellsFargoTotal)],
      ['Calculated deposits', usd(packet.paypal.calculatedTotal)],
      ['Status', matchStatus(packet.paypal)],
      ['Withdrawals included', String(packet.paypal.includedPayoutCount)],
      ['Calendar month gross', usd(packet.paypal.calendarGross)]
    );
  }

  autoTable(doc, {
    startY: 42,
    theme: 'plain',
    styles: { fontSize: 10, cellPadding: 3 },
    body: coverBody,
    columnStyles: {
      0: { fontStyle: 'bold', cellWidth: 55 },
      1: { halign: 'right' },
    },
  });

  if (combined) {
    const recapBody: any[] = [];
    packet.combinedDays.forEach((day) => {
      recapBody.push([
        { content: formatDisplayDate(day.date), colSpan: 6, styles: { fontStyle: 'bold', fillColor: [241, 245, 249] } },
      ]);
      recapBody.push(['  Shopify', String(day.shopify.transactionCount), usd(day.shopify.gross), usd(day.shopify.fees), usd(day.shopify.net), '[  ]']);
      recapBody.push(['  PayPal', String(day.paypal.transactionCount), usd(day.paypal.gross), usd(day.paypal.fees), usd(day.paypal.net), '[  ]']);
      recapBody.push([
        { content: '  Combined', styles: { fontStyle: 'bold' } },
        { content: String(day.combined.transactionCount), styles: { fontStyle: 'bold', halign: 'right' } },
        { content: usd(day.combined.gross), styles: { fontStyle: 'bold', halign: 'right' } },
        { content: usd(day.combined.fees), styles: { fontStyle: 'bold', halign: 'right' } },
        { content: usd(day.combined.net), styles: { fontStyle: 'bold', halign: 'right' } },
        { content: '[  ]', styles: { fontStyle: 'bold', halign: 'center' } },
      ]);
    });

    const shopifyMonth = packet.shopify ? sumCalendarDays(packet.shopify.calendarDays) : null;
    const paypalMonth = packet.paypal ? sumCalendarDays(packet.paypal.calendarDays) : null;
    const combinedMonth = sumCalendarDays(packet.combinedDays.map((day) => day.combined));
    if (shopifyMonth) {
      recapBody.push(['Shopify month total', String(shopifyMonth.transactionCount), usd(shopifyMonth.gross), usd(shopifyMonth.fees), usd(shopifyMonth.net), '']);
    }
    if (paypalMonth) {
      recapBody.push(['PayPal month total', String(paypalMonth.transactionCount), usd(paypalMonth.gross), usd(paypalMonth.fees), usd(paypalMonth.net), '']);
    }
    recapBody.push([
      { content: 'Combined month total', styles: { fontStyle: 'bold' } },
      { content: String(combinedMonth.transactionCount), styles: { fontStyle: 'bold', halign: 'right' } },
      { content: usd(combinedMonth.gross), styles: { fontStyle: 'bold', halign: 'right' } },
      { content: usd(combinedMonth.fees), styles: { fontStyle: 'bold', halign: 'right' } },
      { content: usd(combinedMonth.net), styles: { fontStyle: 'bold', halign: 'right' } },
      { content: '', styles: { fontStyle: 'bold' } },
    ]);

    autoTable(doc, {
      startY: ((doc as any).lastAutoTable.finalY || 70) + 8,
      head: [[
        { content: 'Calendar date / source', styles: { halign: 'left' } },
        { content: 'Txns', styles: { halign: 'right' } },
        { content: 'Gross', styles: { halign: 'right' } },
        { content: 'Fees', styles: { halign: 'right' } },
        { content: 'Net', styles: { halign: 'right' } },
        { content: 'Verify', styles: { halign: 'center' } },
      ]],
      body: recapBody,
      theme: 'striped',
      headStyles: { fillColor: [51, 65, 85] },
      columnStyles: {
        1: { halign: 'right', cellWidth: 18 },
        2: { halign: 'right', cellWidth: 28 },
        3: { halign: 'right', cellWidth: 28 },
        4: { halign: 'right', cellWidth: 28 },
        5: { halign: 'center', cellWidth: 16 },
      },
      styles: { fontSize: 8 },
    });
  } else if (single) {
    const recapBody = (single.calendarDays || []).map((day) => [
      formatDisplayDate(day.date),
      String(day.transactionCount),
      usd(day.gross),
      usd(day.fees),
      usd(day.net),
      '[  ]',
    ]);
    recapBody.push([
      { content: 'Calendar month total', colSpan: 2, styles: { fontStyle: 'bold', halign: 'right' } },
      { content: usd(single.calendarGross), styles: { fontStyle: 'bold', halign: 'right' } },
      { content: usd((single.calendarDays || []).reduce((sum, day) => sum + day.fees, 0)), styles: { fontStyle: 'bold', halign: 'right' } },
      { content: usd((single.calendarDays || []).reduce((sum, day) => sum + day.net, 0)), styles: { fontStyle: 'bold', halign: 'right' } },
      { content: '', styles: { fontStyle: 'bold' } },
    ] as any);

    autoTable(doc, {
      startY: ((doc as any).lastAutoTable.finalY || 70) + 8,
      head: [[
        { content: 'Calendar date', styles: { halign: 'left' } },
        { content: 'Txns', styles: { halign: 'right' } },
        { content: 'Gross', styles: { halign: 'right' } },
        { content: 'Fees', styles: { halign: 'right' } },
        { content: 'Net', styles: { halign: 'right' } },
        { content: 'Verify', styles: { halign: 'center' } },
      ]],
      body: recapBody,
      theme: 'striped',
      headStyles: { fillColor: [51, 65, 85] },
      columnStyles: {
        1: { halign: 'right', cellWidth: 18 },
        2: { halign: 'right', cellWidth: 28 },
        3: { halign: 'right', cellWidth: 28 },
        4: { halign: 'right', cellWidth: 28 },
        5: { halign: 'center', cellWidth: 16 },
      },
      styles: { fontSize: 8 },
    });
  }

  const exceptionRows = [
    ...(packet.shopify?.exceptions || []).map((item) => [
      'Shopify',
      item.kind.replace(/_/g, ' '),
      formatDisplayDate(item.payout.payoutDate),
      formatDisplayDate(item.payout.bankDate),
      usd(item.payout.net),
      item.note,
    ]),
    ...(packet.paypal?.exceptions || []).map((item) => [
      'PayPal',
      item.kind.replace(/_/g, ' '),
      formatDisplayDate(item.payout.payoutDate),
      formatDisplayDate(item.payout.bankDate),
      usd(item.payout.net),
      item.note,
    ]),
  ];

  if (exceptionRows.length > 0) {
    autoTable(doc, {
      startY: ((doc as any).lastAutoTable.finalY || 90) + 10,
      head: [['Source', 'Exceptions', 'Payout date', 'Bank date', 'Net', 'Note']],
      body: exceptionRows,
      theme: 'striped',
      headStyles: { fillColor: [120, 53, 15] },
      styles: { fontSize: 7 },
      columnStyles: {
        4: { halign: 'right' },
        5: { cellWidth: 70 },
      },
    });
  }

  if (mode === 'full') {
    const byDate = new Map<string, { shopify?: EOMDayGroup; paypal?: EOMDayGroup }>();
    packet.shopify?.days.forEach((day) => {
      byDate.set(day.bankDate, { ...(byDate.get(day.bankDate) || {}), shopify: day });
    });
    packet.paypal?.days.forEach((day) => {
      byDate.set(day.bankDate, { ...(byDate.get(day.bankDate) || {}), paypal: day });
    });
    Array.from(byDate.entries())
      .sort(([left], [right]) => left.localeCompare(right))
      .forEach(([bankDate, groups]) => {
        appendDepositDay(doc, pageWidth, pageHeight, bankDate, groups.shopify, groups.paypal);
      });
  }

  const pageCount = doc.getNumberOfPages();
  for (let page = 1; page <= pageCount; page += 1) {
    doc.setPage(page);
    drawFooter(page);
  }

  const prefix = combined ? 'EOM' : `${brandLabel}-EOM`;
  doc.save(`${prefix}-${mode === 'brief' ? 'Brief' : 'Full'}-${formatDisplayDate(packet.fromDate)}-to-${formatDisplayDate(packet.toDate)}.pdf`);
};

