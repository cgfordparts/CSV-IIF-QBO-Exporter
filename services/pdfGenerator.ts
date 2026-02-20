
import { jsPDF } from 'jspdf';
import autoTable from 'jspdf-autotable';
import { ReportSummary, DailyGroup } from '../types';

export const generateTransactionPDF = (summary: ReportSummary, reportType: 'SHOPIFY' | 'PAYPAL' = 'SHOPIFY') => {
  // Use the pre-calculated daily groups from the processor (which follow the 4 PM rule)
  const pdfGroups: DailyGroup[] = summary.dailyGroups;
  const reportTitle = reportType === 'SHOPIFY' ? 'Web Order Transaction Report' : 'PayPal Transaction Report';
  const filePrefix = reportType === 'SHOPIFY' ? 'Shopify-Report' : 'PayPal-Report';

  // Generate a separate PDF for EACH Reporting Day Group
  pdfGroups.forEach(group => {
      const doc = new jsPDF();
      const pageWidth = doc.internal.pageSize.getWidth();
      const pageHeight = doc.internal.pageSize.getHeight();

      // Header - Centered
      doc.setFontSize(22);
      doc.setTextColor(40);
      doc.text(reportTitle, pageWidth / 2, 22, { align: 'center' });
      
      doc.setFontSize(12);
      doc.setTextColor(100);
      doc.text(`Reporting Date: ${group.date}`, pageWidth / 2, 30, { align: 'center' });

      // Construct Table Body for this specific group
      const tableBody: any[] = [];

      // Group transactions by sourceFile
      const transactionsByFile: Record<string, import('../types').ShopifyTransaction[]> = {};
      group.transactions.forEach(t => {
        const key = t.sourceFile || 'Unknown Source';
        if (!transactionsByFile[key]) {
          transactionsByFile[key] = [];
        }
        transactionsByFile[key].push(t);
      });

      // Iterate through each file group
      Object.entries(transactionsByFile).forEach(([fileName, txns]) => {
        
        // Calculate Subtotals for this file using cent-based math to avoid float errors
        const fileSubtotal = txns.reduce((sum, t) => sum + Math.round(t.amount * 100), 0) / 100;
        const fileFees = txns.reduce((sum, t) => sum + Math.round(t.fee * 100), 0) / 100;
        const fileNet = txns.reduce((sum, t) => sum + Math.round(t.net * 100), 0) / 100;

        // Transaction Rows
        txns.forEach(t => {
          tableBody.push([
            new Date(t.dateTime).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
            t.orderNumber,
            t.customerName,
            t.type,
            t.cardBrand,
            `$${t.amount.toFixed(2)}`,
            `$${t.fee.toFixed(2)}`,
            `$${t.net.toFixed(2)}`,
            '[  ]'
          ]);
        });

        // Batch Subtotal Row (Generic, no filename)
        tableBody.push([
          {
            content: `Batch Subtotal (${txns.length} txns)`,
            colSpan: 5,
            styles: {
              fillColor: [248, 250, 252], // Slate-50
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
            content: `$${fileFees.toFixed(2)}`,
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

      // Summary Box for THIS GROUP ONLY
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
      doc.text(`Total Fees: $${Math.abs(group.subtotalFees).toLocaleString(undefined, { minimumFractionDigits: 2 })}`, 20, summaryY + 26);
      doc.text(`Total Net: $${group.subtotalNet.toLocaleString(undefined, { minimumFractionDigits: 2 })}`, 20, summaryY + 34);
      
      doc.setFontSize(14);
      doc.setTextColor(40);
      doc.text(`Gross Balance: $${group.subtotal.toLocaleString(undefined, { minimumFractionDigits: 2 })}`, pageWidth - 100, summaryY + 18);

      const safeFilename = group.date.replace(/[^a-z0-9]/gi, '-').substring(0, 50);
      doc.save(`${filePrefix}-${safeFilename}.pdf`);
  });
};
