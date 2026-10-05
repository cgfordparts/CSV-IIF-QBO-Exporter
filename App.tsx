import React, { useEffect, useState } from 'react';
import { 
  FileText, 
  Upload, 
  FileDown,
  BarChart3, 
  Clock,
  Activity,
  RefreshCcw,
  CalendarDays,
  Database,
  Settings
} from 'lucide-react';
import { parseShopifyCSV, parsePaypalCSV } from './services/csvProcessor';
import { formatClockTime, formatDisplayDate, formatMoney } from './services/dateUtils';
import {
  generateTransactionPDF,
  generateDayEndPDFDataUri,
  generateRollingPDF,
  getImportRollingMonths
} from './services/pdfGenerator';
import { ReportSummary, ReportStatus } from './types';
import { IIFConverter } from './components/IIFConverter';
import { EOMReconciler } from './components/EOMReconciler';
import { SettingsPanel } from './components/SettingsPanel';
import { assignBankDates, payoutsFromShopifyHistory } from './services/eom.service';
import { getIpcRenderer } from './services/electronIpc';

const ipc = getIpcRenderer();

type ViewMode = 'DAILY' | 'EOM' | 'IIF' | 'SETTINGS';

const monthLabel = (yearMonth: string) => {
  const [year, month] = yearMonth.split('-');
  return new Date(Number(year), Number(month) - 1).toLocaleString('en-US', {
    month: 'long',
    year: 'numeric'
  });
};

const App: React.FC = () => {
  const [viewMode, setViewMode] = useState<ViewMode>('DAILY');
  
  // Shopify/PayPal State
  const [reportSource, setReportSource] = useState<'SHOPIFY' | 'PAYPAL'>('SHOPIFY');
  const [status, setStatus] = useState<ReportStatus>(ReportStatus.IDLE);
  const [summary, setSummary] = useState<ReportSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [hasCustomDataFolder, setHasCustomDataFolder] = useState(false);
  const [showExportDayPicker, setShowExportDayPicker] = useState(false);
  const [selectedExportDays, setSelectedExportDays] = useState<string[]>([]);
  const [importNotice, setImportNotice] = useState<string | null>(null);

  useEffect(() => {
    ipc.invoke('settings:get').then((res) => {
      setHasCustomDataFolder(Boolean(res?.dataDirectory) && !res?.isDefault);
    }).catch(() => {
      setHasCustomDataFolder(false);
    });
  }, [viewMode]);

  const handleFileUpload = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const files = event.target.files;
    if (!files || files.length === 0) return;

    setStatus(ReportStatus.PROCESSING);
    setError(null);
    setImportNotice(null);

    try {
      const fileList: File[] = Array.from(files);
      let newImportsCount = 0;
      let updatedImportsCount = 0;
      let duplicateFilesCount = 0;
      const failedFiles: string[] = [];
      const affectedMonths = new Set<string>();
      const saveErrors: string[] = [];
      const settings = await ipc.invoke('settings:get');
      const canSaveToFolder = Boolean(settings?.dataDirectory) && !settings?.isDefault;

      for (const file of fileList) {
        const text = await file.text();

        let parsedSummary: ReportSummary;
        try {
          parsedSummary = reportSource === 'PAYPAL'
            ? await parsePaypalCSV([file])
            : await parseShopifyCSV([file]);
        } catch (parseErr) {
          console.error(`Failed to parse file ${file.name}:`, parseErr);
          failedFiles.push(file.name);
          continue;
        }

        if (!parsedSummary.allTransactions.length) {
          failedFiles.push(file.name);
          continue;
        }

        if (reportSource === 'SHOPIFY') {
          const headerLine = text.split(/\r?\n/, 1)[0] || '';
          const isPayoutSummary = /Charges/i.test(headerLine) && /Bank Reference/i.test(headerLine) && !/Payout ID/i.test(headerLine);
          if (isPayoutSummary) {
            saveErrors.push(
              `${file.name}: this is a payout summary (one row per payout, with a Total column), not the transaction export. It was not added. Use the individual payout CSVs.`
            );
            continue;
          }
          const payoutIds = new Set(
            parsedSummary.allTransactions.map((tx) => tx.payoutId).filter(Boolean)
          );
          if (payoutIds.size > 1) {
            saveErrors.push(
              `${file.name}: contains ${payoutIds.size} payouts, so it was not added. Import the individual payout CSVs (like 09-11-2026.csv). If this Export All file is already in the monthly report, remove it under Settings.`
            );
            continue;
          }
        }

        const dupCheck = await ipc.invoke('history:check-duplicate', {
          content: text,
          filename: file.name,
          transactions: parsedSummary.allTransactions,
          source: reportSource
        });

        if (dupCheck?.isDuplicate) {
          duplicateFilesCount += 1;
          continue;
        }

        const addResult = await ipc.invoke('history:add', {
          source: reportSource,
          filename: file.name,
          fileContent: text,
          transactions: parsedSummary.allTransactions
        });

        if (addResult?.success) {
          if (addResult.data?.replaced) {
            updatedImportsCount += 1;
          } else {
            newImportsCount += 1;
          }
          if (reportSource === 'SHOPIFY' && !addResult.data?.payoutId) {
            saveErrors.push(`${file.name}: no Payout ID, so it was left out of the monthly deposit total`);
          }
          getImportRollingMonths(addResult.data || {
            transactions: parsedSummary.allTransactions,
            payoutDate: parsedSummary.allTransactions.find((t) => t.payoutDate)?.payoutDate
          }).forEach((ym) => affectedMonths.add(ym));

          if (canSaveToFolder) {
            const arch = await ipc.invoke('archive:raw-csv', {
              source: reportSource,
              filename: file.name,
              fileContent: text,
              transactions: parsedSummary.allTransactions
            });
            if (!arch?.success) {
              saveErrors.push(`RAW ${file.name}: ${arch?.error || 'archive failed'}`);
            }
          }
        } else if (addResult?.error) {
          if (String(addResult.error).toLowerCase().includes('duplicate')) {
            duplicateFilesCount += 1;
          } else {
            saveErrors.push(`${file.name}: ${addResult.error}`);
          }
        }
      }

      const updatedHistory = await ipc.invoke('history:get');
      const sourceImports = (updatedHistory?.imports || []).filter((imp: any) => imp.source === reportSource);
      if (reportSource === 'SHOPIFY' && (newImportsCount > 0 || updatedImportsCount > 0)) {
        affectedMonths.clear();
        assignBankDates(payoutsFromShopifyHistory(sourceImports)).forEach((payout) => {
          if (payout.bankDate?.length >= 7) affectedMonths.add(payout.bankDate.slice(0, 7));
        });
      }
      if ((newImportsCount > 0 || updatedImportsCount > 0) && canSaveToFolder && affectedMonths.size > 0) {
        for (const ym of affectedMonths) {
          try {
            const base64Data = generateRollingPDF(sourceImports, ym, monthLabel(ym), reportSource);
            const res = await ipc.invoke('pdf:save-rolling', {
              yearMonth: ym,
              monthName: monthLabel(ym),
              source: reportSource,
              base64Data
            });
            if (!res?.success) {
              saveErrors.push(`${ym}: ${res?.error || 'Unknown save error'}`);
            }
          } catch (pdfErr: any) {
            saveErrors.push(`${ym}: ${pdfErr.message || 'PDF generation failed'}`);
          }
        }
      }

      const displaySummary = reportSource === 'PAYPAL'
        ? await parsePaypalCSV(fileList)
        : await parseShopifyCSV(fileList);
      setSummary(displaySummary);
      setStatus(ReportStatus.READY);

      let msg = '';
      if (newImportsCount > 0) {
        msg += `Imported ${newImportsCount} CSV file${newImportsCount === 1 ? '' : 's'}. `;
      }
      if (updatedImportsCount > 0) {
        msg += `Updated ${updatedImportsCount} payout file${updatedImportsCount === 1 ? '' : 's'} already on file. `;
      }
      if (newImportsCount > 0 || updatedImportsCount > 0) {
        if (!canSaveToFolder) {
          msg += 'Choose a data folder in Settings to automatically update the rolling monthly report. ';
        } else if (saveErrors.length === 0) {
          msg += 'Rolling monthly report updated in the data folder. ';
        } else {
          msg += `Rolling PDF save had issues: ${saveErrors.join('; ')}. `;
        }
      } else if (saveErrors.length > 0) {
        msg += saveErrors.join('; ') + '. ';
      }
      if (duplicateFilesCount > 0) {
        msg += `${duplicateFilesCount} file${duplicateFilesCount === 1 ? ' is' : 's are'} already in the monthly report. Day-end export still uses this upload. `;
      }
      if (failedFiles.length > 0) {
        msg += `Could not read ${failedFiles.join(', ')}. `;
      }
      setImportNotice(msg.trim() || null);
    } catch (err: any) {
      console.error(err);
      setError(`Failed to parse ${reportSource} CSV files. ${err?.message || 'Please ensure they are valid.'}`);
      setStatus(ReportStatus.ERROR);
    } finally {
      event.target.value = '';
    }
  };

  const handleDownloadPDF = () => {
    if (!summary || summary.dailyGroups.length === 0) return;
    setSelectedExportDays(summary.dailyGroups.map((group) => group.date));
    setShowExportDayPicker(true);
  };

  const toggleExportDay = (date: string) => {
    setSelectedExportDays((prev) =>
      prev.includes(date) ? prev.filter((day) => day !== date) : [...prev, date]
    );
  };

  const handleConfirmExportDays = async () => {
    if (!summary || selectedExportDays.length === 0) return;

    generateTransactionPDF(summary, reportSource, selectedExportDays);

    if (hasCustomDataFolder) {
      const archiveErrors: string[] = [];
      for (const day of [...selectedExportDays].sort()) {
        try {
          const dataUri = generateDayEndPDFDataUri(summary, reportSource, day);
          if (!dataUri) {
            archiveErrors.push(`${day}: could not build PDF`);
            continue;
          }
          const res = await ipc.invoke('archive:day-end-pdf', {
            source: reportSource,
            isoDate: day,
            base64Data: dataUri
          });
          if (!res?.success) {
            archiveErrors.push(`${day}: ${res?.error || 'save failed'}`);
          }
        } catch (err: any) {
          archiveErrors.push(`${day}: ${err.message || 'save failed'}`);
        }
      }
      if (archiveErrors.length > 0) {
        setImportNotice(`PDF downloaded. Day End archive had issues: ${archiveErrors.join('; ')}`);
      }
    }

    setShowExportDayPicker(false);
  };

  const getStatusColor = (type: string) => {
    const t = type.toLowerCase();
    if (t.includes('pending')) return 'text-amber-400 border-amber-500/50';
    if (t.includes('paid') || t.includes('success') || t.includes('captured') || t.includes('authorized')) 
      return 'text-cyan-400 border-cyan-500/50 shadow-[0_0_10px_-4px_rgba(34,211,238,0.5)]';
    if (t.includes('refund') || t.includes('voided') || t.includes('failed'))
      return 'text-pink-500 border-pink-500/50 shadow-[0_0_10px_-4px_rgba(236,72,153,0.5)]';
    return 'text-zinc-400 border-zinc-600';
  };

  const getCardTypeColor = (brand: string) => {
    const b = brand.toLowerCase();
    if (b.includes('visa')) return 'text-blue-400 border-blue-500/30';
    if (b.includes('master')) return 'text-orange-400 border-orange-500/30';
    if (b.includes('amex') || b.includes('american')) return 'text-cyan-300 border-cyan-500/30';
    return 'text-zinc-500 border-zinc-700';
  };

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-50 flex flex-col font-sans selection:bg-pink-500 selection:text-white">
      {/* Unified Header */}
      <header className="bg-zinc-900/80 backdrop-blur-md border-b border-cyan-500/20 px-6 py-4 sticky top-0 z-50 shadow-[0_4px_20px_-5px_rgba(34,211,238,0.1)]">
        <div className="max-w-7xl mx-auto flex items-center justify-between gap-4 flex-wrap">
          <div className="flex items-center gap-4">
             {/* Dynamic Logo Icon */}
            <div className="relative h-10 w-10 group">
              <div className={`absolute -inset-1 bg-gradient-to-r ${viewMode === 'IIF' ? 'from-pink-500 to-cyan-500' : 'from-cyan-500 to-pink-500'} rounded-lg blur opacity-40 group-hover:opacity-100 transition duration-500`}></div>
              <div className="relative h-full w-full bg-zinc-900 rounded-lg border border-cyan-500/50 flex items-center justify-center text-cyan-400 group-hover:text-white transition-colors">
                {viewMode === 'IIF' ? <Database className="w-5 h-5" /> : viewMode === 'SETTINGS' ? <Settings className="w-5 h-5" /> : viewMode === 'EOM' ? <CalendarDays className="w-5 h-5" /> : <FileText className="w-5 h-5" />}
              </div>
            </div>
            <div>
              <h1 className="text-xl font-bold text-transparent bg-clip-text bg-gradient-to-r from-cyan-400 to-white tracking-tight">
                Shopify and PayPal Reporter
              </h1>
            </div>
          </div>

          <div className="flex items-center gap-2">
            {status === ReportStatus.READY && (
              <button
                type="button"
                onClick={() => {
                  setSummary(null);
                  setStatus(ReportStatus.IDLE);
                  setImportNotice(null);
                  setViewMode('DAILY');
                }}
                className="text-xs font-mono font-bold px-4 py-2 bg-zinc-800 hover:bg-zinc-700 hover:text-white text-zinc-400 border border-zinc-700 hover:border-zinc-500 uppercase tracking-widest transition-all flex items-center gap-2"
              >
                <RefreshCcw className="w-3 h-3" /> Upload New
              </button>
            )}
            <div className="flex p-1 bg-zinc-900 rounded-lg border border-zinc-800 shadow-xl">
              {([
                { id: 'DAILY' as const, label: 'Daily Report' },
                { id: 'EOM' as const, label: 'End of Month' },
                { id: 'IIF' as const, label: 'IIF Converter' },
              ]).map((item) => (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => setViewMode(item.id)}
                  className={`px-4 py-2 text-[11px] font-bold font-mono uppercase tracking-wider rounded-md transition-all ${
                    viewMode === item.id ? 'bg-cyan-500 text-black' : 'text-zinc-400 hover:text-white'
                  }`}
                >
                  {item.label}
                </button>
              ))}
            </div>
            <button
              type="button"
              onClick={() => setViewMode('SETTINGS')}
              title="Settings"
              className={`h-10 w-10 rounded-lg border flex items-center justify-center transition-colors ${
                viewMode === 'SETTINGS'
                  ? 'bg-cyan-500 text-black border-cyan-500'
                  : 'bg-zinc-900 text-zinc-400 border-zinc-800 hover:text-white hover:border-cyan-500/50'
              }`}
            >
              <Settings className="w-4 h-4" />
            </button>
          </div>
        </div>
      </header>

      <main className="flex-1 w-full relative">
        {viewMode === 'SETTINGS' ? (
          <SettingsPanel />
        ) : viewMode === 'IIF' ? (
          <div className="absolute inset-0">
             <IIFConverter />
          </div>
        ) : viewMode === 'EOM' ? (
          <div className="max-w-7xl mx-auto p-6">
            <EOMReconciler />
          </div>
        ) : (
          <div className="max-w-7xl mx-auto p-6 space-y-8">
            <div className="flex flex-col items-center">
              <div className="flex p-1 bg-zinc-900 rounded-lg border border-zinc-800 w-full max-w-sm mx-auto shadow-xl relative">
                  <button 
                    onClick={() => {
                      if (reportSource === 'SHOPIFY') return;
                      setReportSource('SHOPIFY');
                      setSummary(null);
                      setStatus(ReportStatus.IDLE);
                      setError(null);
                      setImportNotice(null);
                      setShowExportDayPicker(false);
                    }} 
                    className={`flex-1 py-2 text-sm font-bold font-mono rounded-md transition-all duration-300 relative z-10 ${reportSource === 'SHOPIFY' ? 'text-black' : 'text-zinc-400'}`}
                  >
                    SHOPIFY
                  </button>
                  <button 
                    onClick={() => {
                      if (reportSource === 'PAYPAL') return;
                      setReportSource('PAYPAL');
                      setSummary(null);
                      setStatus(ReportStatus.IDLE);
                      setError(null);
                      setImportNotice(null);
                      setShowExportDayPicker(false);
                    }} 
                    className={`flex-1 py-2 text-sm font-bold font-mono rounded-md transition-all duration-300 relative z-10 ${reportSource === 'PAYPAL' ? 'text-black' : 'text-zinc-400'}`}
                  >
                    PAYPAL
                  </button>
                  
                  <div 
                    className={`absolute top-1 bottom-1 rounded-md transition-all duration-300 shadow-lg w-[calc(50%-4px)] ${
                      reportSource === 'SHOPIFY' 
                        ? 'left-1 bg-cyan-500' 
                        : 'translate-x-full bg-blue-500'
                    }`}
                  ></div>
              </div>
            </div>

            {status === ReportStatus.IDLE || status === ReportStatus.ERROR ? (
              <div className="flex-1 flex flex-col items-center justify-center min-h-[400px]">
                <label className="w-full max-w-xl p-10 border border-dashed rounded-none transition-all duration-300 cursor-pointer flex flex-col items-center justify-center gap-4 group relative overflow-hidden backdrop-blur-sm border-zinc-700 bg-zinc-900/30 hover:border-cyan-500 hover:bg-cyan-950/20 hover:shadow-[0_0_30px_-5px_rgba(34,211,238,0.3)]">
                  {/* Corner Markers */}
                  <div className="absolute top-0 left-0 w-2 h-2 border-t border-l border-zinc-500 group-hover:border-cyan-400 transition-colors"></div>
                  <div className="absolute top-0 right-0 w-2 h-2 border-t border-r border-zinc-500 group-hover:border-cyan-400 transition-colors"></div>
                  <div className="absolute bottom-0 left-0 w-2 h-2 border-b border-l border-zinc-500 group-hover:border-cyan-400 transition-colors"></div>
                  <div className="absolute bottom-0 right-0 w-2 h-2 border-b border-r border-zinc-500 group-hover:border-cyan-400 transition-colors"></div>

                  <input 
                      type="file" 
                      accept=".csv" 
                      multiple
                      className="hidden" 
                      onChange={handleFileUpload} 
                  />

                  <div className="h-16 w-16 bg-zinc-800/50 rounded-full flex items-center justify-center group-hover:bg-zinc-800 transition-colors group-hover:scale-110 duration-200 border border-zinc-700 group-hover:border-cyan-500/50">
                    <Upload className="w-8 h-8 text-zinc-400 group-hover:text-cyan-400 transition-colors" />
                  </div>
                  
                  <div className="text-center">
                    <p className="text-lg font-bold text-zinc-200 group-hover:text-white transition-colors tracking-wide">
                        DROP {reportSource} .CSV(s)
                    </p>
                    <p className="text-zinc-500 font-mono text-sm mt-1 group-hover:text-cyan-500/70">or click to browse files</p>
                    <p className="text-[10px] font-mono text-zinc-600 mt-3 uppercase tracking-wider">
                      Export to PDF opens a day picker. Rolling monthly PDFs save to the Settings data folder.
                    </p>
                  </div>

                  {error && (
                    <div className="mt-4 p-3 bg-pink-950/50 border border-pink-500/50 text-pink-400 rounded-sm text-sm text-center max-w-sm font-mono">
                      <span className="font-bold text-pink-500">[ERROR]</span> {error}
                    </div>
                  )}
                </label>
              </div>
            ) : status === ReportStatus.PROCESSING ? (
              <div className="flex flex-col items-center justify-center min-h-[70vh]">
                <div className="relative">
                  <div className="w-24 h-24 border-4 border-zinc-800 border-t-cyan-500 rounded-full animate-spin"></div>
                  <RefreshCcw className="absolute inset-0 m-auto w-10 h-10 text-cyan-500 animate-pulse" />
                </div>
                <p className="mt-8 text-cyan-400 font-mono font-bold text-xl animate-pulse tracking-widest uppercase">
                    PROCESSING {reportSource} FILES...
                </p>
              </div>
            ) : (
              <div className="animate-in fade-in slide-in-from-bottom-8 duration-700">
                {importNotice && (
                  <div className="mb-6 px-4 py-3 border border-cyan-500/30 bg-cyan-950/30 text-cyan-200 font-mono text-xs">
                    {importNotice}
                  </div>
                )}
                {/* Stats Overview */}
                <div className="grid grid-cols-1 md:grid-cols-4 gap-6 mb-8">
                  <StatCard 
                    label="Total Balance" 
                    value={`$${summary?.totalAmount.toLocaleString(undefined, { minimumFractionDigits: 2 })}`} 
                    icon={<BarChart3 className="text-cyan-400" />}
                    trend="LEDGER SUM"
                  />
                  <StatCard 
                    label="Total Entries" 
                    value={summary?.transactionCount.toString() || '0'} 
                    icon={<Activity className="text-pink-400" />}
                    trend="ALL FILES"
                  />
                  <StatCard 
                    label="Period" 
                    value={summary?.dateRange || ''} 
                    icon={<Clock className="text-white" />}
                    trend="DATE RANGE"
                  />
                  
                  <div 
                    onClick={handleDownloadPDF}
                    className="bg-zinc-900 border border-cyan-500/30 p-7 text-white shadow-[0_0_20px_-10px_rgba(34,211,238,0.15)] flex flex-col items-center justify-center relative overflow-hidden group cursor-pointer hover:border-cyan-500 transition-all active:scale-95"
                  >
                    <div className="absolute inset-0 bg-gradient-to-br from-cyan-900/10 to-transparent opacity-0 group-hover:opacity-100 transition-opacity"></div>
                    <div className="relative z-10 flex flex-col items-center gap-4">
                      <div className="bg-cyan-500/10 p-3 rounded-none border border-cyan-500/20 group-hover:bg-cyan-500 group-hover:text-black group-hover:scale-110 transition-all duration-300">
                        <FileDown className="w-10 h-10" />
                      </div>
                      <h3 className="text-sm font-bold font-mono uppercase tracking-widest text-cyan-400 group-hover:text-white transition-colors">Export to PDF</h3>
                    </div>
                  </div>
                </div>

                <div className="w-full">
                  <div className="bg-zinc-900/50 border border-zinc-800 backdrop-blur-sm shadow-2xl">
                    <div className="px-6 py-6 border-b border-zinc-800 bg-zinc-900">
                      <h3 className="font-bold text-white text-xl tracking-tight flex items-center gap-2">
                          <span className="w-2 h-6 bg-cyan-500 block"></span>
                          LEDGER BREAKDOWN
                      </h3>
                    </div>
                    
                    {summary?.dailyGroups.map((group) => (
                      <div key={group.date} className="border-b border-zinc-800/50 last:border-b-0">
                        {/* Group Header */}
                        <div className="px-6 py-3 bg-zinc-900/80 border-b border-zinc-800 flex items-center justify-between sticky top-0 backdrop-blur-md z-10">
                          <div className="flex items-center gap-3">
                            <CalendarDays className="w-4 h-4 text-cyan-500" />
                            <span className="text-zinc-200 font-bold font-mono">{formatDisplayDate(group.date)}</span>
                          </div>
                          <div className="flex items-center gap-6">
                            <span className="text-[10px] font-bold font-mono text-zinc-500 uppercase tracking-widest">
                               {group.count} Txns
                            </span>
                            <span className="text-cyan-400 font-mono font-bold">
                               ${group.subtotal.toLocaleString(undefined, { minimumFractionDigits: 2 })}
                            </span>
                          </div>
                        </div>

                        <div className="overflow-x-auto">
                          <table className="w-full text-left">
                            <thead className="bg-zinc-950/50 text-cyan-500/70 text-[10px] font-bold font-mono uppercase tracking-wider border-b border-zinc-800">
                              <tr>
                                <th className="px-6 py-3">Time</th>
                                <th className="px-6 py-3">Reference</th>
                                <th className="px-6 py-3">Status</th>
                                <th className="px-6 py-3">Card Type</th>
                                <th className="px-6 py-3 text-right">Amount</th>
                                <th className="px-6 py-3 text-right">Fee</th>
                                <th className="px-6 py-3 text-center">Verify</th>
                              </tr>
                            </thead>
                            <tbody className="divide-y divide-zinc-800/50">
                              {group.transactions.map((t) => (
                                <tr key={t.id} className="hover:bg-cyan-500/5 transition-all group">
                                  <td className="px-6 py-3">
                                    <div className="text-xs font-mono text-zinc-500 group-hover:text-zinc-300">
                                      {formatClockTime(t.dateTime)}
                                    </div>
                                  </td>
                                  <td className="px-6 py-3">
                                    <div className="flex flex-col">
                                      <span className="text-sm font-bold text-zinc-200 group-hover:text-cyan-400 transition-colors">
                                        {t.orderNumber}
                                      </span>
                                      <span className="text-[10px] text-zinc-600 font-mono uppercase tracking-wider mt-0.5">
                                        {t.customerName}
                                      </span>
                                    </div>
                                  </td>
                                  <td className="px-6 py-3">
                                    <span className={`text-[9px] font-bold px-2 py-1 rounded border ${getStatusColor(t.type)} uppercase tracking-wider`}>
                                      {t.type}
                                    </span>
                                  </td>
                                  <td className="px-6 py-3">
                                    <span className={`text-[9px] font-bold px-2 py-1 rounded border ${getCardTypeColor(t.cardBrand)} uppercase tracking-wider`}>
                                      {t.cardBrand}
                                    </span>
                                  </td>
                                  <td className="px-6 py-3 text-right">
                                    <span className={`font-mono font-bold tracking-tight ${t.amount < 0 ? 'text-pink-500' : 'text-zinc-200'}`}>
                                      {formatMoney(t.amount)}
                                    </span>
                                  </td>
                                  <td className="px-6 py-3 text-right">
                                    <span className={`font-mono tracking-tight ${t.fee < 0 ? 'text-pink-500' : 'text-zinc-400'}`}>
                                      {formatMoney(t.fee)}
                                    </span>
                                  </td>
                                  <td className="px-6 py-3 text-center">
                                    <div className="w-4 h-4 border border-zinc-700 rounded-sm mx-auto flex items-center justify-center bg-zinc-900 group-hover:border-cyan-500/50 transition-colors"></div>
                                  </td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            )}
          </div>
        )}
      </main>

      {showExportDayPicker && summary && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/70 backdrop-blur-sm p-4">
          <div className="w-full max-w-lg bg-zinc-900 border border-cyan-500/30 shadow-2xl">
            <div className="px-6 py-4 border-b border-zinc-800 flex items-center justify-between">
              <div>
                <h3 className="text-sm font-bold font-mono uppercase tracking-widest text-cyan-400">
                  Select Days to Export
                </h3>
                <p className="text-[11px] font-mono text-zinc-500 mt-1">
                  Choose reporting days for this PDF. One file is created.
                </p>
              </div>
              <button
                type="button"
                onClick={() => setShowExportDayPicker(false)}
                className="text-zinc-500 hover:text-white text-xs font-mono font-bold uppercase"
              >
                Close
              </button>
            </div>

            <div className="px-6 py-3 border-b border-zinc-800 flex gap-3">
              <button
                type="button"
                onClick={() => setSelectedExportDays(summary.dailyGroups.map((group) => group.date))}
                className="text-[10px] font-mono font-bold uppercase tracking-wider px-3 py-1.5 bg-zinc-950 border border-zinc-700 text-zinc-300 hover:border-cyan-500 hover:text-cyan-400"
              >
                Select All
              </button>
              <button
                type="button"
                onClick={() => setSelectedExportDays([])}
                className="text-[10px] font-mono font-bold uppercase tracking-wider px-3 py-1.5 bg-zinc-950 border border-zinc-700 text-zinc-300 hover:border-cyan-500 hover:text-cyan-400"
              >
                Clear All
              </button>
              <span className="ml-auto text-[10px] font-mono text-zinc-500 self-center">
                {selectedExportDays.length} of {summary.dailyGroups.length} selected
              </span>
            </div>

            <div className="max-h-80 overflow-y-auto px-6 py-4 space-y-2">
              {summary.dailyGroups.map((group) => {
                const checked = selectedExportDays.includes(group.date);
                return (
                  <label
                    key={group.date}
                    className={`flex items-center gap-3 px-3 py-2.5 border cursor-pointer transition-colors ${
                      checked
                        ? 'border-cyan-500/40 bg-cyan-950/20'
                        : 'border-zinc-800 bg-zinc-950/40 hover:border-zinc-700'
                    }`}
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => toggleExportDay(group.date)}
                      className="w-4 h-4 border-zinc-700 bg-zinc-950 text-cyan-500 focus:ring-cyan-500/40 cursor-pointer"
                    />
                    <CalendarDays className="w-3.5 h-3.5 text-cyan-500 shrink-0" />
                    <span className="flex-1 text-sm font-mono font-bold text-zinc-200">{formatDisplayDate(group.date)}</span>
                    <span className="text-[10px] font-mono text-zinc-500 uppercase tracking-wider">
                      {group.count} txns
                    </span>
                    <span className="text-xs font-mono text-cyan-400">
                      ${group.subtotal.toLocaleString(undefined, { minimumFractionDigits: 2 })}
                    </span>
                  </label>
                );
              })}
            </div>

            <div className="px-6 py-4 border-t border-zinc-800 flex gap-3 justify-end">
              <button
                type="button"
                onClick={() => setShowExportDayPicker(false)}
                className="px-5 py-2 bg-zinc-950 border border-zinc-700 text-zinc-400 hover:text-white font-mono font-bold text-xs uppercase tracking-wider"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleConfirmExportDays}
                disabled={selectedExportDays.length === 0}
                className="px-5 py-2 bg-cyan-600 hover:bg-cyan-500 disabled:bg-zinc-800 disabled:text-zinc-600 text-black font-mono font-bold text-xs uppercase tracking-wider"
              >
                Export {selectedExportDays.length} Day{selectedExportDays.length === 1 ? '' : 's'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

const StatCard: React.FC<{ label: string, value: string, icon: React.ReactNode, trend: string }> = ({ label, value, icon, trend }) => (
  <div className="bg-zinc-900 p-6 border border-zinc-800 shadow-lg flex items-start gap-5 hover:border-zinc-700 transition-all hover:-translate-y-1 duration-300 group">
    <div className="bg-zinc-950 p-3 rounded border border-zinc-800 group-hover:border-cyan-500/30 transition-colors">
      {icon}
    </div>
    <div>
      <p className="text-[10px] font-bold font-mono text-zinc-500 uppercase tracking-widest leading-none mb-2">{label}</p>
      <h4 className="text-2xl font-bold text-white tracking-tight">{value}</h4>
      <div className="mt-2">
        <span className="text-[9px] font-bold text-zinc-600 flex items-center gap-2 uppercase tracking-widest">
          <div className="w-1 h-1 rounded-full bg-cyan-500 animate-pulse" />
          {trend}
        </span>
      </div>
    </div>
  </div>
);

export default App;