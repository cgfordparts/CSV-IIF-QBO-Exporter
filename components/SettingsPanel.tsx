import React, { useCallback, useEffect, useState } from 'react';
import { FolderOpen, RotateCcw, Settings as SettingsIcon } from 'lucide-react';
import { getIpcRenderer } from '../services/electronIpc';

const ipc = getIpcRenderer();

type DataSettings = {
  dataDirectory: string;
  isDefault: boolean;
  csvCount: number;
};

export const SettingsPanel: React.FC = () => {
  const [settings, setSettings] = useState<DataSettings | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const loadSettings = useCallback(async () => {
    const result = await ipc.invoke('settings:get');
    setSettings({
      dataDirectory: result?.dataDirectory || '',
      isDefault: Boolean(result?.isDefault),
      csvCount: Number(result?.csvCount || 0),
    });
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
    </div>
  );
};
