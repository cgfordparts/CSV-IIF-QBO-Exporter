const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { app } = require('electron');

const dbDir = path.join(app.getPath('userData'), 'database');
const historyPath = path.join(dbDir, 'history.json');

function ensureDbDir() {
  if (!fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir, { recursive: true });
  }
}

function normalizeFileContent(content) {
  return String(content || '')
    .replace(/^\uFEFF/, '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .trimEnd();
}

function calculateHash(content) {
  return crypto.createHash('sha256').update(normalizeFileContent(content)).digest('hex');
}

function sameSource(a, b) {
  return String(a || '').toUpperCase() === String(b || '').toUpperCase();
}

function isPaypalSource(source) {
  return String(source || '').toUpperCase() === 'PAYPAL';
}

function isPaypalWithdrawalType(type) {
  const t = String(type || '').trim();
  return t === 'General Withdrawal' || t === 'User Initiated Withdrawal';
}

/**
 * Status-insensitive transaction signature.
 * Same Order + Transaction Date + Amount + Type + Net = same ledger row
 * even when Payout Status changes (in_transit → paid).
 */
function transactionSignature(tx) {
  const order = String(tx.orderNumber ?? '').trim();
  const dateTime = String(tx.dateTime ?? '').trim().replace(/\s+/g, ' ');
  const amount = Number(tx.amount || 0).toFixed(2);
  const net = Number(tx.net || 0).toFixed(2);
  const type = String(tx.type ?? '').trim();
  return `${order}|${dateTime}|${amount}|${net}|${type}`;
}

/** PayPal Transaction IDs are stable across re-exports even when other columns change. */
function paypalIdSet(transactions) {
  const set = new Set();
  (transactions || []).forEach((tx) => {
    const id = String(tx.orderNumber ?? '').trim();
    if (id) set.add(id);
  });
  return set;
}

function importSignatureSet(imp) {
  const set = new Set();
  if (imp.transactions) {
    imp.transactions.forEach((tx) => set.add(transactionSignature(tx)));
  }
  return set;
}

function setsEqual(a, b) {
  if (a.size !== b.size) return false;
  for (const v of a) {
    if (!b.has(v)) return false;
  }
  return true;
}

function setKey(set) {
  return [...set].sort().join('\n');
}

/**
 * Drop later imports that are the same deposit ledger as an earlier one
 * (repairs history that already accumulated PayPal/Shopify duplicates).
 */
function consolidateDuplicateImports(history) {
  const kept = [];
  const seenHashes = new Set();
  const seenLedgerKeys = new Set();
  const seenPaypalIdKeys = new Set();
  let removed = 0;

  for (const imp of history.imports || []) {
    if (imp.fileHash && seenHashes.has(imp.fileHash)) {
      removed++;
      continue;
    }

    const ledgerKey = `${String(imp.source || '').toUpperCase()}::${setKey(importSignatureSet(imp))}`;
    if (ledgerKey.endsWith('::')) {
      // empty txn set — keep only if hash is new
    } else if (seenLedgerKeys.has(ledgerKey)) {
      removed++;
      continue;
    }

    if (isPaypalSource(imp.source)) {
      const ids = paypalIdSet(imp.transactions);
      if (ids.size > 0) {
        const idKey = setKey(ids);
        if (seenPaypalIdKeys.has(idKey)) {
          removed++;
          continue;
        }
        seenPaypalIdKeys.add(idKey);
      }
    }

    if (imp.fileHash) seenHashes.add(imp.fileHash);
    if (!ledgerKey.endsWith('::')) seenLedgerKeys.add(ledgerKey);
    kept.push(imp);
  }

  return { imports: kept, removed };
}

function getHistory() {
  ensureDbDir();
  if (!fs.existsSync(historyPath)) {
    const defaultHistory = { imports: [] };
    fs.writeFileSync(historyPath, JSON.stringify(defaultHistory, null, 2), 'utf-8');
    return defaultHistory;
  }
  try {
    const raw = fs.readFileSync(historyPath, 'utf-8');
    const history = JSON.parse(raw);
    if (!Array.isArray(history.imports)) {
      return { imports: [] };
    }

    const consolidated = consolidateDuplicateImports(history);
    if (consolidated.removed > 0) {
      const cleaned = { imports: consolidated.imports };
      saveHistory(cleaned);
      console.log(
        `[history] Removed ${consolidated.removed} duplicate import(s) from history cache`
      );
      return cleaned;
    }

    return history;
  } catch (err) {
    console.error('Failed to read history.json:', err);
    return { imports: [] };
  }
}

function saveHistory(historyData) {
  ensureDbDir();
  try {
    fs.writeFileSync(historyPath, JSON.stringify(historyData, null, 2), 'utf-8');
  } catch (err) {
    console.error('Failed to write history.json:', err);
    throw err;
  }
}

function clearHistory() {
  ensureDbDir();
  const defaultHistory = { imports: [] };
  saveHistory(defaultHistory);
  return defaultHistory;
}

function duplicateResult(imp, reason) {
  return {
    isDuplicate: true,
    reason,
    importId: imp.importId,
    importDate: imp.importDate,
    filename: imp.filename
  };
}

function checkDuplicate(fileContent, filename, transactions = [], source = '') {
  const hash = calculateHash(fileContent);
  const history = getHistory();

  // 1. Exact file content (normalized BOM / line endings)
  const existingByHash = history.imports.find((imp) => imp.fileHash === hash);
  if (existingByHash) {
    return duplicateResult(existingByHash, 'hash');
  }

  if (!transactions || transactions.length === 0 || !source) {
    return { isDuplicate: false, importId: null };
  }

  // 2. PayPal: same Transaction ID set = same export (even if Balance / formatting changed)
  if (isPaypalSource(source)) {
    const incomingIds = paypalIdSet(transactions);
    if (incomingIds.size > 0) {
      for (const imp of history.imports) {
        if (!sameSource(imp.source, source) || !imp.transactions?.length) continue;
        const priorIds = paypalIdSet(imp.transactions);
        if (setsEqual(incomingIds, priorIds)) {
          return duplicateResult(imp, 'paypal-transaction-ids');
        }
      }

      // All incoming PayPal IDs already present in history (re-export / subset redo)
      const allPriorIds = new Set();
      history.imports
        .filter((imp) => sameSource(imp.source, source))
        .forEach((imp) => {
          paypalIdSet(imp.transactions).forEach((id) => allPriorIds.add(id));
        });

      if ([...incomingIds].every((id) => allPriorIds.has(id))) {
        const matchingImport = history.imports.find(
          (imp) =>
            sameSource(imp.source, source) &&
            imp.transactions &&
            paypalIdSet(imp.transactions).has([...incomingIds][0])
        );
        return {
          isDuplicate: true,
          reason: 'paypal-subset',
          importId: matchingImport ? matchingImport.importId : 'UNKNOWN',
          importDate: matchingImport ? matchingImport.importDate : new Date().toISOString(),
          filename: matchingImport ? matchingImport.filename : 'Previous Import'
        };
      }
    }
  }

  const incomingSet = new Set(transactions.map(transactionSignature));

  // 3. Same deposit / same ledger under a different filename or payout status
  for (const imp of history.imports) {
    if (!sameSource(imp.source, source) || !imp.transactions || imp.transactions.length === 0) {
      continue;
    }
    const priorSet = importSignatureSet(imp);
    if (setsEqual(incomingSet, priorSet)) {
      return duplicateResult(imp, 'transaction-set');
    }
  }

  // 4. Every incoming row already exists somewhere in history (subset redo)
  const allPrior = new Set();
  history.imports
    .filter((imp) => sameSource(imp.source, source))
    .forEach((imp) => {
      importSignatureSet(imp).forEach((sig) => allPrior.add(sig));
    });

  if (incomingSet.size > 0 && [...incomingSet].every((sig) => allPrior.has(sig))) {
    const matchingImport = history.imports.find(
      (imp) =>
        sameSource(imp.source, source) &&
        imp.transactions &&
        imp.transactions.some((tx) => transactionSignature(tx) === [...incomingSet][0])
    );

    return {
      isDuplicate: true,
      reason: 'subset',
      importId: matchingImport ? matchingImport.importId : 'UNKNOWN',
      importDate: matchingImport ? matchingImport.importDate : new Date().toISOString(),
      filename: matchingImport ? matchingImport.filename : 'Previous Import'
    };
  }

  return { isDuplicate: false, importId: null };
}

function addImport(source, filename, fileContent, transactions) {
  const hash = calculateHash(fileContent);
  const duplicateStatus = checkDuplicate(fileContent, filename, transactions, source);
  if (duplicateStatus.isDuplicate) {
    throw new Error(`File is a duplicate of Import ${duplicateStatus.importId}`);
  }

  const history = getHistory();

  // PayPal bracket exports overlap on purpose — store only NEW Transaction IDs
  // (and never persist General Withdrawals)
  let storedTransactions = transactions || [];
  if (isPaypalSource(source)) {
    storedTransactions = storedTransactions.filter((tx) => !isPaypalWithdrawalType(tx.type));

    const priorIds = new Set();
    history.imports
      .filter((imp) => sameSource(imp.source, source))
      .forEach((imp) => {
        paypalIdSet(imp.transactions).forEach((id) => priorIds.add(id));
      });

    storedTransactions = storedTransactions.filter((tx) => {
      const id = String(tx.orderNumber || '').trim();
      return id && !priorIds.has(id);
    });

    if (storedTransactions.length === 0) {
      throw new Error('File is a duplicate of prior PayPal Transaction IDs');
    }
  }

  const now = new Date();
  const yyyy = now.getFullYear();
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const dd = String(now.getDate()).padStart(2, '0');
  const hh = String(now.getHours()).padStart(2, '0');
  const min = String(now.getMinutes()).padStart(2, '0');
  const ss = String(now.getSeconds()).padStart(2, '0');
  const ms = String(now.getMilliseconds()).padStart(3, '0');
  const rand = crypto.randomBytes(2).toString('hex');
  const importId = `IMP-${source}-${yyyy}${mm}${dd}-${hh}${min}${ss}-${ms}-${rand}`;

  const salesRows = isPaypalSource(source)
    ? storedTransactions.filter((tx) => !isPaypalWithdrawalType(tx.type))
    : storedTransactions;

  const csvGross = salesRows.reduce((sum, tx) => sum + Math.round((tx.amount || 0) * 100), 0) / 100;
  const csvFees = salesRows.reduce((sum, tx) => sum + Math.round((tx.fee || 0) * 100), 0) / 100;
  const csvNet = salesRows.reduce((sum, tx) => sum + Math.round((tx.net || 0) * 100), 0) / 100;

  // Deposit identity from Shopify payout columns (one CSV = one Wells deposit)
  const payoutTx = storedTransactions.find((tx) => tx.payoutId) || null;
  const payoutId = payoutTx?.payoutId || null;
  const payoutDate = payoutTx?.payoutDate || null;
  const payoutStatus = payoutTx?.payoutStatus || null;

  const newImport = {
    importId,
    source,
    filename,
    fileHash: hash,
    importDate: now.toISOString(),
    grandTotal: csvGross,
    csvGross,
    csvFees,
    csvNet,
    payoutId,
    payoutDate,
    payoutStatus,
    transactions: storedTransactions
  };

  history.imports.push(newImport);
  saveHistory(history);

  return newImport;
}

module.exports = {
  getHistory,
  checkDuplicate,
  addImport,
  clearHistory
};
