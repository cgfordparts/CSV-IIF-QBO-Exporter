const qbAuth = require('./qbAuth.service.cjs');

class QBSyncService {
    constructor() {
        this.accountMap = {}; // Name -> Id
        this.vendorMap = {};  // Name -> Id
    }

    async refreshMappings() {
        const realmId = qbAuth.getRealmId();
        const baseUrl = qbAuth.getClient().environment === 'sandbox' 
            ? 'https://sandbox-quickbooks.api.intuit.com' 
            : 'https://quickbooks.api.intuit.com';

        // 1. Fetch Accounts
        const accQuery = "SELECT * FROM Account MAXRESULTS 1000";
        const accUrl = `${baseUrl}/v3/company/${realmId}/query?query=${encodeURIComponent(accQuery)}`;
        const accData = await qbAuth.makeRequest(accUrl);
        
        if (accData.QueryResponse && accData.QueryResponse.Account) {
            accData.QueryResponse.Account.forEach(acc => {
                this.accountMap[acc.Name.trim()] = acc.Id;
            });
        }

        // 2. Fetch Vendors
        const venQuery = "SELECT * FROM Vendor MAXRESULTS 1000";
        const venUrl = `${baseUrl}/v3/company/${realmId}/query?query=${encodeURIComponent(venQuery)}`;
        const venData = await qbAuth.makeRequest(venUrl);
        
        if (venData.QueryResponse && venData.QueryResponse.Vendor) {
            venData.QueryResponse.Vendor.forEach(ven => {
                this.vendorMap[ven.DisplayName.trim()] = ven.Id;
            });
        }

        return { 
            accounts: Object.keys(this.accountMap).length, 
            vendors: Object.keys(this.vendorMap).length 
        };
    }

    async syncJournalEntries(entries) {
        const realmId = qbAuth.getRealmId();
        const baseUrl = this.getBaseUrl();
        const url = `${baseUrl}/v3/company/${realmId}/journalentry`;

        // Group by JournalNo
        const groups = {};
        entries.forEach(e => {
            if (!groups[e.JournalNo]) groups[e.JournalNo] = [];
            groups[e.JournalNo].push(e);
        });

        const results = { success: 0, failed: 0, errors: [] };

        for (const [journalNo, rows] of Object.entries(groups)) {
            try {
                const payload = {
                    DocNumber: journalNo,
                    TxnDate: this.formatDate(rows[0].JournalDate),
                    Line: rows.map(row => {
                        const amount = parseFloat(row.Debit || row.Credit);
                        const accountId = this.findAccountId(row.Account);
                        
                        if (!accountId) throw new Error(`Account "${row.Account}" not found in QuickBooks.`);

                        return {
                            Description: row.Description,
                            Amount: amount,
                            DetailType: "JournalEntryLineDetail",
                            JournalEntryLineDetail: {
                                PostingType: row.Debit !== "0" && row.Debit !== "" ? "Debit" : "Credit",
                                AccountRef: { value: accountId }
                            }
                        };
                    })
                };

                await qbAuth.makeRequest(url, 'POST', payload);
                results.success++;
            } catch (err) {
                results.failed++;
                results.errors.push(`Journal ${journalNo}: ${err.message}`);
            }
        }

        return results;
    }

    async syncBills(entries) {
        const realmId = qbAuth.getRealmId();
        const baseUrl = this.getBaseUrl();
        const url = `${baseUrl}/v3/company/${realmId}/bill`;

        // Group by BillNo
        const groups = {};
        entries.forEach(e => {
            if (!groups[e.BillNo]) groups[e.BillNo] = [];
            groups[e.BillNo].push(e);
        });

        const results = { success: 0, failed: 0, errors: [] };

        for (const [billNo, rows] of Object.entries(groups)) {
            try {
                const supplierName = rows[0].Supplier;
                const vendorId = this.vendorMap[supplierName.trim()];
                
                if (!vendorId) throw new Error(`Vendor "${supplierName}" not found in QuickBooks.`);

                const payload = {
                    DocNumber: billNo,
                    TxnDate: this.formatDate(rows[0].JournalDate),
                    DueDate: this.formatDate(rows[0].DueDate),
                    VendorRef: { value: vendorId },
                    Line: rows.map(row => {
                        const accountId = this.findAccountId(row.Account);
                        if (!accountId) throw new Error(`Account "${row.Account}" not found in QuickBooks.`);

                        return {
                            Description: row.Description,
                            Amount: parseFloat(row.LineAmount),
                            DetailType: "AccountBasedExpenseLineDetail",
                            AccountBasedExpenseLineDetail: {
                                AccountRef: { value: accountId }
                            }
                        };
                    })
                };

                await qbAuth.makeRequest(url, 'POST', payload);
                results.success++;
            } catch (err) {
                results.failed++;
                results.errors.push(`Bill ${billNo}: ${err.message}`);
            }
        }

        return results;
    }

    // Helper to find account ID, handling the "0-115-0 INVENTORY" style matching
    findAccountId(name) {
        const cleanName = name.trim();
        // Exact match
        if (this.accountMap[cleanName]) return this.accountMap[cleanName];
        
        // Partial match (e.g. if IIF has "0-115-0" and QBO has "0-115-0 Inventory")
        const found = Object.keys(this.accountMap).find(k => k.startsWith(cleanName) || cleanName.startsWith(k));
        return found ? this.accountMap[found] : null;
    }

    formatDate(dateStr) {
        if (!dateStr) return new Date().toISOString().split('T')[0];
        // Handle MM/DD/YY or MM/DD/YYYY
        const parts = dateStr.split('/');
        if (parts.length === 3) {
            let [m, d, y] = parts;
            if (y.length === 2) y = '20' + y;
            return `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
        }
        return dateStr;
    }
}

module.exports = new QBSyncService();
