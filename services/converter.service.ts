export interface QBOJournalEntry {
  JournalNo: string;
  JournalDate: string;
  DueDate?: string;
  Description: string;
  Account: string;
  Debit: string;
  Credit: string;
  Name: string;
  // Bill Specific Fields
  LineAmount?: string;
  BillNo?: string;
  Supplier?: string;
}

export type ConversionMode = 'GL' | 'AP';

export class ConverterService {
  
  // --- CONFIGURATION: GL ACCOUNT MAPPING ---
  private glAccountOverrides: Record<string, string> = {
    "0-115-0": "0-115-0 INVENTORY - PARTS",
    "0-119-0": "0-119-0 OTHER CC CLEARING",
    "0-121-0": "0-121-0 UNDEPOSITED FUNDS",
    "WEB CC":  "0-122-0 WEB CC",
    "0-131-0": "0-131-0 TRANSFER CLEARING",
    "0-202-0": "0-202-0 ACCOUNTS PAYABLE CLEARING",
    "0-203-0": "0-203-0 SALES TAX PAYABLE",
    "0-251-0": "0-251-0 CUSTOMER DEPOSITS",
    "0-310-0": "0-310-0 INTERFACE CORRECTION ACCT",
    "0-401-0": "0-401-0 SALES",
    "0-405-0": "0-405-0 SHIPPING & HANDLING FEES",
    "0-490-0": "0-490-0 SALES RETURNS AND ALLOWANCES",
    "0-501-0": "0-501-0 COST OF GOODS SOLD",
  };

  // --- CONFIGURATION: AP ACCOUNT MAPPING ---
  private apAccountOverrides: Record<string, string> = {
    // AP Accounts
    "0-201-0": "0-201-0 ACCOUNTS PAYABLE",
    "0-202-0": "0-202-0 ACCOUNTS PAYABLE CLEARING",
    "0-682-0": "0-682-0 SHIPPING EXPENSE",
  };
  
  convert(iifString: string, mode: ConversionMode): QBOJournalEntry[] {
    if (mode === 'AP') {
      return this.convertBills(iifString);
    }
    return this.convertGL(iifString);
  }

  // --- GL LOGIC (Original) ---
  private convertGL(iifString: string): QBOJournalEntry[] {
    const lines = iifString.split(/\r?\n/);
    let headerMap: Record<string, number> = {};
    const processedRows: QBOJournalEntry[] = [];

    // Header Discovery
    for (const line of lines) {
      if (line.trim().startsWith('!SPL')) {
        const headers = line.trim().split('\t');
        headers.forEach((h, i) => headerMap[h] = i);
        break;
      }
    }

    if (Object.keys(headerMap).length === 0) {
      throw new Error("Invalid IIF File: Could not find '!SPL' header row definition.");
    }

    // Process Data Rows
    for (const line of lines) {
      if (!line.startsWith('SPL')) {
        continue;
      }

      const parts = line.trim().split('\t');
      const getVal = (colName: string) => this.getVal(parts, headerMap, colName);

      const rawDocNum = getVal('DOCNUM');
      const rawDate = getVal('DATE');
      const rawMemo = getVal('MEMO');
      const rawAccnt = getVal('ACCNT');
      const rawAmount = getVal('AMOUNT');
      
      // LOGIC 1: CREATE JOURNAL ID (CPIIF-MMDDYY)
      let finalJournalNo = rawDocNum;
      try {
        const dateParts = rawDate.split('/');
        if (dateParts.length === 3) {
            const [mm, dd, yyyy] = dateParts;
            const yy = yyyy.slice(-2);
            finalJournalNo = `CPIIF-${mm}${dd}${yy}`;
        } else {
             finalJournalNo = `CPIIF-${rawDate.replace(/\//g, '')}`;
        }
      } catch (e) {
        finalJournalNo = rawDocNum;
      }

      const finalDescription = rawMemo ? `${rawMemo} (Ref: ${rawDocNum})` : `(Ref: ${rawDocNum})`;
      const finalAccount = this.glAccountOverrides[rawAccnt] ?? rawAccnt;
      const { debitStr, creditStr } = this.parseAmount(rawAmount);

      processedRows.push({
        JournalNo: finalJournalNo,
        JournalDate: rawDate,
        Description: finalDescription,
        Account: finalAccount,
        Debit: debitStr,
        Credit: creditStr,
        Name: getVal('NAME')
      });
    }

    // Sort by JournalNo
    processedRows.sort((a, b) => {
      if (a.JournalNo < b.JournalNo) return -1;
      if (a.JournalNo > b.JournalNo) return 1;
      return 0;
    });

    return processedRows;
  }

  // --- AP LOGIC (Bills) ---
  private convertBills(iifString: string): QBOJournalEntry[] {
    const lines = iifString.split(/\r?\n/);
    let headerMapTrns: Record<string, number> = {};
    let headerMapSpl: Record<string, number> = {};
    
    // Context Memory for Vendor info from TRNS line
    const currentContext = {
      docNum: "",
      date: "",
      dueDate: "",
      name: "",
      terms: ""
    };

    const processedRows: QBOJournalEntry[] = [];

    // SINGLE PASS PROCESSING
    for (const line of lines) {
      // Handle Headers
      if (line.startsWith('!TRNS')) {
        headerMapTrns = {};
        const headers = line.trim().split('\t');
        headers.forEach((h, i) => headerMapTrns[h] = i);
        continue;
      } 
      
      if (line.startsWith('!SPL')) {
        headerMapSpl = {};
        const headers = line.trim().split('\t');
        headers.forEach((h, i) => headerMapSpl[h] = i);
        continue;
      }

      // Skip invalid or non-data lines
      if (!line.startsWith('TRNS') && !line.startsWith('SPL')) {
        continue;
      }

      let rowType = "";
      let currentMap: Record<string, number> = {};

      if (line.startsWith('TRNS')) {
        rowType = 'TRNS';
        currentMap = headerMapTrns;
      } else if (line.startsWith('SPL')) {
        rowType = 'SPL';
        currentMap = headerMapSpl;
      }

      // Safety check
      if (Object.keys(currentMap).length === 0) {
        continue; 
      }

      const parts = line.trim().split('\t');
      const getVal = (colName: string) => this.getVal(parts, currentMap, colName);

      // Capture Context (TRNS Line Only)
      if (rowType === 'TRNS') {
        currentContext.docNum = getVal('DOCNUM');
        currentContext.date = getVal('DATE');
        currentContext.dueDate = getVal('DUEDATE') || getVal('DUE DATE');
        currentContext.name = getVal('NAME');
        currentContext.terms = getVal('TERMS');
        
        // In BILL Mode, the TRNS line is typically the AP credit (Negative Amount).
        // We DO NOT create a row for this in the CSV for Bills, 
        // because QBO automatically creates the AP Credit side based on the Total.
        continue; 
      }

      // Process SPL Lines (Expenses)
      if (rowType === 'SPL') {
          const rawAccnt = getVal('ACCNT');
          
          // SKIPPING THE AP ACCOUNT IF IT APPEARS IN SPLIT (Rare, but safety first)
          // Also skip if it matches the main AP account 0-201-0
          if (rawAccnt === '0-201-0') {
              continue;
          }

          const rawAmount = getVal('AMOUNT');
          const amountVal = parseFloat(rawAmount);

          // For Bills, expense lines should be POSITIVE. 
          // If for some reason they are negative (e.g. a credit memo), we preserve the sign.
          const lineAmount = amountVal.toFixed(2);

          const rawMemo = getVal('MEMO');
          const finalDescription = rawMemo; // Description is per line

          const finalAccount = this.apAccountOverrides[rawAccnt] ?? rawAccnt;

          processedRows.push({
            // Bill Fields
            BillNo: currentContext.docNum,
            Supplier: currentContext.name,
            JournalDate: currentContext.date, // BillDate
            DueDate: currentContext.dueDate,
            Account: finalAccount,
            Description: finalDescription,
            LineAmount: lineAmount,
            
            // Legacy Fields (kept for Type safety/compatibility)
            JournalNo: currentContext.docNum,
            Name: currentContext.name,
            Debit: amountVal > 0 ? lineAmount : '0',
            Credit: amountVal < 0 ? Math.abs(amountVal).toFixed(2) : '0'
          });
      }
    }

    // STEP 3: SORTING (Date, then BillNo)
    processedRows.sort((a, b) => {
      if (a.JournalDate < b.JournalDate) return -1;
      if (a.JournalDate > b.JournalDate) return 1;
      if (a.JournalNo < b.JournalNo) return -1;
      if (a.JournalNo > b.JournalNo) return 1;
      return 0;
    });

    return processedRows;
  }

  // --- HELPERS ---

  private getVal(parts: string[], map: Record<string, number>, colName: string): string {
    const idx = map[colName];
    if (idx !== undefined && idx < parts.length) {
      return parts[idx];
    }
    return "";
  }

  private parseAmount(amountStr: string): { debitStr: string, creditStr: string } {
    let amountFloat = parseFloat(amountStr);
    if (isNaN(amountFloat)) {
      amountFloat = 0.0;
    }

    let debitStr = "";
    let creditStr = "";

    if (amountFloat > 0) {
      debitStr = amountFloat.toFixed(2);
    } else if (amountFloat < 0) {
      creditStr = Math.abs(amountFloat).toFixed(2);
    }
    return { debitStr, creditStr };
  }

  toCSV(data: QBOJournalEntry[], mode: ConversionMode = 'GL'): string {
    
    let fieldNames: string[] = [];
    let headers: string[] = [];

    if (mode === 'AP') {
        // BILL IMPORT FORMAT
        // Headers must match QBO expectations exactly for easiest mapping
        headers = ["Bill no", "Supplier", "Bill Date", "Due Date", "Account", "Line Amount", "Line Description"];
        fieldNames = ["BillNo", "Supplier", "JournalDate", "DueDate", "Account", "LineAmount", "Description"];
    } else {
        // JOURNAL ENTRY FORMAT
        headers = ["JournalNo", "JournalDate", "DueDate", "Description", "Account", "Debit", "Credit", "Name"];
        fieldNames = ["JournalNo", "JournalDate", "DueDate", "Description", "Account", "Debit", "Credit", "Name"];
    }

    const headerRow = headers.join(',');
    
    const rows = data.map(row => {
      return fieldNames.map(field => {
        // @ts-ignore - Dynamic access
        let val = row[field] || '';
        // Escape quotes
        val = val.replace(/"/g, '""');
        // Wrap in quotes if it contains comma, quote, or newline
        if (val.search(/("|,|\n)/g) >= 0) {
          val = `"${val}"`;
        }
        return val;
      }).join(',');
    });

    return [headerRow, ...rows].join('\n');
  }
}
