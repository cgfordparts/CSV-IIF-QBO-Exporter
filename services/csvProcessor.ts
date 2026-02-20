
import Papa from 'papaparse';
import { ShopifyTransaction, ReportSummary, DailyGroup } from '../types';

/**
 * Enhanced processor that treats the CSV as a ledger.
 * Supports multiple files and groups transactions by date.
 */
export const parseShopifyCSV = (files: FileList | File[]): Promise<ReportSummary> => {
  return new Promise(async (resolve, reject) => {
    try {
      // Convert FileList to Array
      const fileArray = Array.from(files);
      const allTransactions: ShopifyTransaction[] = [];
      
      // Use a global counter to ensure unique IDs across multiple files if order IDs clash
      let globalEntryCounter = 0;

      const parseFile = (file: File) => new Promise<void>((resolveFile, rejectFile) => {
        Papa.parse(file, {
          header: true,
          skipEmptyLines: true,
          complete: (results) => {
            try {
              const rawData = results.data as any[];

              rawData.forEach((row) => {
                const keys = Object.keys(row);
                
                // Date extraction logic
                const dateValue = 
                  row['Created at'] || 
                  row['Date'] || 
                  row['Processed at'] || 
                  row['Occurred at'] || 
                  row['Day'] || 
                  (keys.length > 0 ? row[keys[0]] : null);
                
                const dateTime = dateValue || new Date().toISOString();

                const orderId = row['Name'] || row['Order'] || row['Order ID'] || row['ID'] || `Line-${globalEntryCounter}`;
                const rawAmount = row['Amount'] || row['Total'] || '0';
                const amount = parseFloat(rawAmount.toString().replace(/[^0-9.-]+/g, ""));
                
                const rawFee = row['Fee'] || row['Fees'] || row['Transaction Fee'] || '0';
                const fee = parseFloat(rawFee.toString().replace(/[^0-9.-]+/g, ""));

                const rawNet = row['Net'] || row['Net Amount'] || '0';
                let net = parseFloat(rawNet.toString().replace(/[^0-9.-]+/g, ""));
                
                // If Net is 0 but we have Amount and Fee, calculate it.
                // Assuming Fee is often negative in exports. If Fee is positive, we might need logic, 
                // but usually Net = Amount + Fee (algebraic sum)
                if (net === 0 && (amount !== 0 || fee !== 0)) {
                    net = (Math.round(amount * 100) + Math.round(fee * 100)) / 100;
                }

                const status = row['Status'] || row['Financial Status'] || row['Type'] || 'Unknown';
                const customer = row['Billing Name'] || row['Customer'] || row['Source'] || 'Internal/Guest';
                const currency = row['Currency'] || 'USD';
                
                const cardBrand = row['Card Brand'] || row['Brand'] || row['Payment Method'] || row['Card'] || 'N/A';

                if (!isNaN(amount)) {
                  allTransactions.push({
                    id: `${orderId}-${globalEntryCounter}`,
                    orderNumber: orderId,
                    dateTime: dateTime,
                    customerName: customer,
                    amount: amount,
                    fee: fee,
                    net: net,
                    type: status,
                    cardBrand: cardBrand,
                    currency: currency,
                    sourceFile: file.name
                  });
                  globalEntryCounter++;
                }
              });
              resolveFile();
            } catch (err) {
              rejectFile(err);
            }
          },
          error: (error) => rejectFile(error)
        });
      });

      // Process all files
      await Promise.all(fileArray.map(parseFile));

      // Sort all transactions chronologically (newest to oldest)
      allTransactions.sort((a, b) => new Date(b.dateTime).getTime() - new Date(a.dateTime).getTime());

      // Group by Date using the 4:00 PM Reporting Rule
      const dailyGroups = groupTransactionsByDate(allTransactions);

      const totalAmount = allTransactions.reduce((sum, t) => sum + Math.round(t.amount * 100), 0) / 100;
      const totalFees = allTransactions.reduce((sum, t) => sum + Math.round(t.fee * 100), 0) / 100;
      const totalNet = allTransactions.reduce((sum, t) => sum + Math.round(t.net * 100), 0) / 100;
      
      // Calculate Date Range based on Reporting Dates
      let dateRange = new Date().toLocaleDateString();
      if (dailyGroups.length > 0) {
        const newest = dailyGroups[0].date;
        const oldest = dailyGroups[dailyGroups.length - 1].date;
        
        dateRange = oldest === newest ? oldest : `${oldest} - ${newest}`;
      }

      resolve({
        dateRange,
        totalAmount,
        totalFees,
        totalNet,
        transactionCount: allTransactions.length,
        dailyGroups,
        allTransactions
      });

    } catch (error) {
      reject(error);
    }
  });
};

export const parsePaypalCSV = (files: FileList | File[]): Promise<ReportSummary> => {
  return new Promise(async (resolve, reject) => {
    try {
      const fileArray = Array.from(files);
      const allTransactions: ShopifyTransaction[] = [];
      let globalEntryCounter = 0;

      const parseFile = (file: File) => new Promise<void>((resolveFile, rejectFile) => {
        Papa.parse(file, {
          header: true,
          skipEmptyLines: true,
          complete: (results) => {
            try {
              const rawData = results.data as any[];

              rawData.forEach((row) => {
                // PayPal Format: "Date", "Time", "Name", "Gross", "Fee", "Net", "Transaction ID", "Type"
                const dateStr = row['Date'];
                const timeStr = row['Time'];
                
                if (!dateStr || !timeStr) return; // Skip invalid rows

                const type = row['Type'] || 'Unknown';

                // EXCLUSIONS: Skip specific withdrawal types to ensure end-of-day balancing
                if (type === 'General Withdrawal' || type === 'User Initiated Withdrawal') return;

                const dateTime = `${dateStr} ${timeStr}`; // "MM/DD/YYYY HH:mm:ss"

                const orderId = row['Transaction ID'] || `PP-${globalEntryCounter}`;
                
                // Helper to clean currency strings
                const cleanFloat = (val: any) => {
                    if (!val) return 0;
                    return parseFloat(val.toString().replace(/[^0-9.-]+/g, ""));
                }

                const amount = cleanFloat(row['Gross']);
                const fee = cleanFloat(row['Fee']);
                const net = cleanFloat(row['Net']);
                
                const customer = row['Name'] || 'Unknown';
                const currency = row['Currency'] || 'USD';
                
                // Filter out empty entries if any (sometimes PayPal exports summary rows)
                if (amount === 0 && fee === 0 && net === 0) return;

                allTransactions.push({
                    id: `${orderId}-${globalEntryCounter}`,
                    orderNumber: orderId,
                    dateTime: dateTime,
                    customerName: customer,
                    amount: amount,
                    fee: fee,
                    net: net,
                    type: type,
                    cardBrand: 'PayPal', // PayPal doesn't expose card brand in this CSV
                    currency: currency,
                    sourceFile: file.name
                });
                globalEntryCounter++;
              });
              resolveFile();
            } catch (err) {
              rejectFile(err);
            }
          },
          error: (error) => rejectFile(error)
        });
      });

      await Promise.all(fileArray.map(parseFile));

      // Sort
      allTransactions.sort((a, b) => new Date(b.dateTime).getTime() - new Date(a.dateTime).getTime());

      // Group
      const dailyGroups = groupTransactionsByDate(allTransactions);

      // Totals
      const totalAmount = allTransactions.reduce((sum, t) => sum + Math.round(t.amount * 100), 0) / 100;
      const totalFees = allTransactions.reduce((sum, t) => sum + Math.round(t.fee * 100), 0) / 100;
      const totalNet = allTransactions.reduce((sum, t) => sum + Math.round(t.net * 100), 0) / 100;
      
      let dateRange = new Date().toLocaleDateString();
      if (dailyGroups.length > 0) {
        const newest = dailyGroups[0].date;
        const oldest = dailyGroups[dailyGroups.length - 1].date;
        dateRange = oldest === newest ? oldest : `${oldest} - ${newest}`;
      }

      resolve({
        dateRange,
        totalAmount,
        totalFees,
        totalNet,
        transactionCount: allTransactions.length,
        dailyGroups,
        allTransactions
      });

    } catch (error) {
        reject(error);
    }
  });
};

const groupTransactionsByDate = (transactions: ShopifyTransaction[]): DailyGroup[] => {
    const dailyGroups: DailyGroup[] = [];
    
    const getReportingDateString = (isoString: string): string => {
      const date = new Date(isoString);
      // Rule: 4:00 PM (16:00) and later belongs to the next reporting day
      if (date.getHours() >= 16) {
        date.setDate(date.getDate() + 1);
      }
      return date.toLocaleDateString();
    };

    if (transactions.length > 0) {
      let currentGroup: DailyGroup | null = null;

      transactions.forEach(t => {
        const tDate = getReportingDateString(t.dateTime);
        
        if (!currentGroup || currentGroup.date !== tDate) {
          if (currentGroup) {
            dailyGroups.push(currentGroup);
          }
          currentGroup = {
            date: tDate,
            transactions: [],
            subtotal: 0,
            subtotalFees: 0,
            subtotalNet: 0,
            count: 0
          };
        }
        
        currentGroup.transactions.push(t);
        
        currentGroup.subtotal = (Math.round(currentGroup.subtotal * 100) + Math.round(t.amount * 100)) / 100;
        currentGroup.subtotalFees = (Math.round(currentGroup.subtotalFees * 100) + Math.round(t.fee * 100)) / 100;
        currentGroup.subtotalNet = (Math.round(currentGroup.subtotalNet * 100) + Math.round(t.net * 100)) / 100;
        currentGroup.count += 1;
      });
      
      if (currentGroup) {
        dailyGroups.push(currentGroup);
      }
    }
    return dailyGroups;
};
