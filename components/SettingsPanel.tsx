import React, { useCallback, useEffect, useState } from 'react';
import { FolderOpen, RotateCcw, Settings as SettingsIcon, Undo2 } from 'lucide-react';
import { formatDisplayDate, formatMoney } from '../services/dateUtils';
import { assignBankDates, payoutsFromShopifyHistory } from '../services/eom.service';
import { generateRollingPDF, getImportRollingMonths } from '../services/pdfGenerator';
import { getIpcRenderer } from '../services/electronIpc';

const ipc = getIpcRenderer();

type DataSettings = {
  dataDirectory: string;
  isDefault: boolean;
  csvCount: number;
};

type ImportRow = {
  importId: string;
  source: string;
  filename: string;
  importDate: string;
  payoutId?: string | null;
  payoutDate?: string | null;
  csvNet?: number;
  transactionCount: number;
  payoutCount: number;
};

const monthLabel = (yearMonth: string) => {
  const [year, month] = yearMonth.split('-');
  return new Date(Number(year), Number(month) - 1).toLocaleString('en-US', {
    month: 'long',
    year: 'numeric',
  });
};

const monthsForImports = (source: string, imports: any[]) => {
  const months = new Set<string>();
  const sameSource = imports.filter((imp) => String(imp?.source || '').toUpperCase() === source);
  if (source === 'SHOPIFY') {
    assignBankDates(payoutsFromShopifyHistory(sameSource)).forEach((payout) => {
      if (payout.bankDate?.length >= 7) months.add(payout.bankDate.slice(0, 7));
    });
  }
  sameSource.forEach((imp) => {
    getImportRollingMonths(imp).forEach((yearMonth) => months.add(yearMonth));
  });
  return [...months].filter(Boolean).sort();
};

export const SettingsPanel: React.FC = () => {
  const [settings, setSettings] = useState<DataSettings | null>(null);
  const [imports, setImports] = useState<ImportRow[]>([]);
  const [pendingRemoveId, setPendingRemoveId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const loadSettings = useCallback(async () => {
    const [result, history] = await Promise.all([
      ipc.invoke('settings:get'),
      ipc.invoke('history:list'),
    ]);
    setSettings({
      dataDirectory: result?.dataDirectory || '',
      isDefault: Boolean(result?.isDefault),
      csvCount: Number(result?.csvCount || 0),
    });
    setImports(Array.isArray(history?.imports) ? history.imports : []);
  }, []);

  useEffect(() => {
    loadSettings().catch((err) => {
      setError(err instanceof Error ? err.message : 'Failed to load settings.');
    });
  }, [loadSettings]);

  const chooseFolder = async () => {
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const result = await ipc.invoke('settings:choose-data-directory');
      if (result?.error) {
        setError(result.error);
        return;
      }
      if (result?.cancelled) return;
      await loadSettings();
      setMessage(`Data folder set. Found ${result.csvCount || 0} CSV files.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not choose a folder.');
    } finally {
      setBusy(false);
    }
  };

  const resetFolder = async () => {
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      await ipc.invoke('settings:reset-data-directory');
      await loadSettings();
      setMessage('Data folder reset to the application default.');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not reset the data folder.');
    } finally {
      setBusy(false);
    }
  };

  const removeImport = async (importId: string) => {
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const result = await ipc.invoke('history:remove', { importId });
      if (!result?.success) {
        setError(result?.error || 'Could not remove that import.');
        return;
      }

      const removed = result.removed;
      const source = String(removed?.source || '').toUpperCase() === 'PAYPAL' ? 'PAYPAL' : 'SHOPIFY';
      const remaining = (result.imports || []).filter((imp: { source?: string }) => String(imp.source || '').toUpperCase() === source);
      const months = monthsForImports(source, [removed, ...remaining]);
      const folder = await ipc.invoke('settings:get');
      const canSave = Boolean(folder?.dataDirectory) && !folder?.isDefault;
      const saveErrors: string[] = [];

      if (canSave) {
        for (const yearMonth of months) {
          const base64Data = generateRollingPDF(remaining, yearMonth, monthLabel(yearMonth), source);
          const saved = await ipc.invoke('pdf:save-rolling', {
            yearMonth,
            monthName: monthLabel(yearMonth),
            source,
            base64Data,
          });
          if (!saved?.success) saveErrors.push(`${yearMonth}: ${saved?.error || 'save failed'}`);
        }
      }

      setPendingRemoveId(null);
      await loadSettings();
      const fileLabel = removed?.filename || 'Import';
      if (!canSave) {
        setMessage(`${fileLabel} was removed from import history. Choose a data folder so the monthly PDFs can be rewritten.`);
      } else if (saveErrors.length > 0) {
        setError(`${fileLabel} was removed, but the monthly PDF update had issues: ${saveErrors.join('; ')}`);
      } else {
        setMessage(`${fileLabel} was removed. Monthly reports were rewritten without it.`);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not remove that import.');
    } finally {
      setBusy(false);
    }
  };

  const openFolder = async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await ipc.invoke('settings:open-data-directory');
      if (result?.error) setError(result.error);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not open the data folder.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="max-w-3xl mx-auto p-6 space-y-8">
      <div>
        <h2 className="text-lg font-bold tracking-tight flex items-center gap-2">
          <SettingsIcon className="w-5 h-5 text-cyan-400" />
          Settings
        </h2>
        <p className="text-sm text-zinc-400 mt-2">
          Choose where this app keeps Shopify payout CSVs, PayPal activity CSVs, rolling monthly PDFs, RAW CSV copies, and Day End PDFs. Shopify End of Month reads payout files named like 07-13-2026.csv from the Shopify subfolder (Daily Report RAW files are ignored). PayPal End of Month reads the Paypal subfolder.
        </p>
      </div>

      <section className="bg-zinc-900 border border-zinc-800 p-6 space-y-5">
        <div>
          <p className="text-[10px] font-mono font-bold uppercase tracking-widest text-zinc-500 mb-2">Data folder</p>
          <div className="bg-zinc-950 border border-zinc-700 px-4 py-3 font-mono text-sm text-cyan-300 break-all">
            {settings?.dataDirectory || 'Loading…'}
          </div>
          <p className="text-xs text-zinc-500 mt-3">
            {settings?.isDefault
              ? 'Using the application default location. Import will create month folders here.'
              : 'Using a custom folder. Shopify End of Month reads payout CSVs from the Shopify subfolder. PayPal End of Month reads activity CSVs from the Paypal subfolder. Daily Report imports update the rolling monthly PDF here. RAW sale-date copies are not used for Wells Fargo matching.'}
            {settings ? ` ${settings.csvCount} CSV file${settings.csvCount === 1 ? '' : 's'} found.` : ''}
          </p>
        </div>

        <div className="flex flex-wrap gap-3">
          <button
            type="button"
            onClick={chooseFolder}
            disabled={busy}
            className="px-4 py-2 bg-cyan-500 hover:bg-cyan-400 text-black text-xs font-mono font-bold uppercase tracking-widest"
          >
            Choose folder
          </button>
          <button
            type="button"
            onClick={openFolder}
            disabled={busy}
            className="px-4 py-2 bg-zinc-800 hover:bg-zinc-700 border border-zinc-700 text-xs font-mono font-bold uppercase tracking-widest flex items-center gap-2"
          >
            <FolderOpen className="w-3.5 h-3.5" />
            Open folder
          </button>
          {!settings?.isDefault && (
            <button
              type="button"
              onClick={resetFolder}
              disabled={busy}
              className="px-4 py-2 text-zinc-400 hover:text-white text-xs font-mono font-bold uppercase tracking-widest flex items-center gap-2"
            >
              <RotateCcw className="w-3.5 h-3.5" />
              Use default
            </button>
          )}
        </div>

        {error && <p className="text-sm font-mono text-pink-400">{error}</p>}
        {message && !error && <p className="text-sm font-mono text-cyan-300">{message}</p>}
      </section>

      <section className="bg-zinc-900 border border-zinc-800 p-6 space-y-4">
        <div>
          <h3 className="font-bold tracking-tight flex items-center gap-2">
            <Undo2 className="w-4 h-4 text-cyan-400" />
            Import history
          </h3>
          <p className="text-sm text-zinc-400 mt-2">
            Remove an import that should not be in the monthly reports. An Export All file shows up here as one row with many payouts and a net that is far too large. Removing it rewrites the monthly PDFs from the imports that remain. CSV files already saved in the data folder are left in place.
          </p>
        </div>

        {imports.length === 0 ? (
          <p className="text-xs font-mono text-zinc-500">No imports in history yet.</p>
        ) : (
          <div className="max-h-96 overflow-y-auto border border-zinc-800">
            {imports.map((row) => {
              const confirming = pendingRemoveId === row.importId;
              const manyPayouts = row.payoutCount > 1;
              return (
                <div key={row.importId} className="px-4 py-3 border-b border-zinc-800 last:border-b-0 flex flex-wrap items-center gap-3">
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-mono text-zinc-100 truncate">{row.filename || 'Untitled import'}</p>
                    <p className="text-[10px] font-mono text-zinc-500 mt-1 uppercase tracking-wider">
                      {row.source} · {row.transactionCount} txns
                      {row.payoutDate ? ` · payout ${formatDisplayDate(row.payoutDate)}` : ''}
                      {manyPayouts ? ` · ${row.payoutCount} payouts` : ''}
                      {row.importDate ? ` · imported ${new Date(row.importDate).toLocaleString()}` : ''}
                    </p>
                  </div>
                  <p className={`font-mono text-sm ${manyPayouts ? 'text-pink-400' : 'text-cyan-300'}`}>
                    {formatMoney(Number(row.csvNet) || 0)}
                  </p>
                  {confirming ? (
                    <div className="flex gap-2">
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => removeImport(row.importId)}
                        className="px-3 py-2 bg-pink-500 hover:bg-pink-400 text-black text-[10px] font-mono font-bold uppercase tracking-widest"
                      >
                        Remove
                      </button>
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => setPendingRemoveId(null)}
                        className="px-3 py-2 bg-zinc-800 text-zinc-300 text-[10px] font-mono font-bold uppercase tracking-widest"
                      >
                        Cancel
                      </button>
                    </div>
                  ) : (
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => {
                        setPendingRemoveId(row.importId);
                        setError(null);
                        setMessage(null);
                      }}
                      className="px-3 py-2 bg-zinc-800 hover:bg-zinc-700 border border-zinc-700 text-[10px] font-mono font-bold uppercase tracking-widest"
                    >
                      Undo import
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
};
