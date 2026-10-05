import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertCircle,
  CalendarDays,
  CheckCircle2,
  FileDown,
  FolderOpen,
  RefreshCcw,
  Upload,
} from 'lucide-react';
import {
  ArchivedPayout,
  CombinedEOMPacket,
  EOMCalendarDay,
  EOMDayGroup,
  EOMException,
  EOMSummary,
  EomSource,
} from '../types';
import { ArchiveRecord, getIpcRenderer } from '../services/electronIpc';
import {
  applyOriginalCsvNames,
  buildCombinedPacket,
  formatUsd,
  isDepositCsvName,
  parsePayoutCsvText,
  parsePayoutsFromCsvText,
  reconcileEom,
  sumCalendarDays,
} from '../services/eom.service';
import { formatDisplayDate } from '../services/dateUtils';
import { isPaypalActivityCsv, mergePaypalActivityFiles, reconcilePaypalEom } from '../services/paypalEom.service';
import { generateEOMPdf } from '../services/pdfGenerator';

const ipc = getIpcRenderer();

const getStatusColor = (type: string) => {
  const value = type.toLowerCase();
  if (value.includes('refund') || value.includes('chargeback')) {
    return 'text-pink-500 border-pink-500/50';
  }
  if (value.includes('charge') || value.includes('paid')) {
    return 'text-cyan-400 border-cyan-500/50';
  }
  return 'text-zinc-400 border-zinc-600';
};

const getCardTypeColor = (brand: string) => {
  const value = brand.toLowerCase();
  if (value.includes('visa')) return 'text-blue-400 border-blue-500/30';
  if (value.includes('master')) return 'text-orange-400 border-orange-500/30';
  if (value.includes('amex') || value.includes('american express')) return 'text-cyan-300 border-cyan-500/30';
  return 'text-zinc-500 border-zinc-700';
};

const MONTHS = [
  { value: 1, label: 'January' },
  { value: 2, label: 'February' },
  { value: 3, label: 'March' },
  { value: 4, label: 'April' },
  { value: 5, label: 'May' },
  { value: 6, label: 'June' },
  { value: 7, label: 'July' },
  { value: 8, label: 'August' },
  { value: 9, label: 'September' },
  { value: 10, label: 'October' },
  { value: 11, label: 'November' },
  { value: 12, label: 'December' },
];

const pad2 = (value: number): string => String(value).padStart(2, '0');

const lastDayOfMonth = (year: number, month: number): number => new Date(year, month, 0).getDate();

const monthWindow = (year: number, month: number): { fromDate: string; toDate: string; lastDay: number } => {
  const lastDay = lastDayOfMonth(year, month);
  return {
    fromDate: `${year}-${pad2(month)}-01`,
    toDate: `${year}-${pad2(month)}-${pad2(lastDay)}`,
    lastDay,
  };
};

const parseMoney = (value: string): number => parseFloat(value.replace(/[^0-9.-]+/g, ''));

const SourceChip: React.FC<{
  label: string;
  active: boolean;
  onClick: () => void;
}> = ({ label, active, onClick }) => (
  <button
    type="button"
    onClick={onClick}
    className={`px-5 py-2 text-[11px] font-mono font-bold uppercase tracking-widest border ${
      active ? 'bg-cyan-500 text-black border-cyan-500' : 'bg-zinc-950 text-zinc-400 border-zinc-700 hover:text-white'
    }`}
  >
    {label}
  </button>
);

const MatchCard: React.FC<{ label: string; summary: EOMSummary }> = ({ label, summary }) => (
  <div className="bg-zinc-900 border border-zinc-800 p-5 space-y-4">
    <h3 className="font-bold text-lg tracking-tight flex items-center gap-2">
      <span className="w-2 h-5 bg-cyan-500 block"></span>
      {label}
    </h3>
    <div className="grid grid-cols-3 gap-3 pl-6">
      <div>
        <p className="text-[10px] font-mono text-zinc-600 uppercase tracking-widest mb-1">Wells Fargo</p>
        <p className="text-lg font-bold font-mono">{formatUsd(summary.wellsFargoTotal)}</p>
      </div>
      <div>
        <p className="text-[10px] font-mono text-zinc-600 uppercase tracking-widest mb-1">Calculated</p>
        <p className="text-lg font-bold font-mono">{formatUsd(summary.calculatedTotal)}</p>
      </div>
      <div>
        <p className="text-[10px] font-mono text-zinc-600 uppercase tracking-widest mb-1">Status</p>
        <p className={`text-lg font-bold font-mono flex items-center gap-2 ${summary.matched ? 'text-cyan-400' : 'text-pink-400'}`}>
          {summary.matched ? <CheckCircle2 className="w-5 h-5" /> : <AlertCircle className="w-5 h-5" />}
          {summary.matched ? 'Matched' : formatUsd(summary.variance)}
        </p>
      </div>
    </div>
  </div>
);

const recapNumHead = 'pl-3 pr-6 py-3 text-right whitespace-nowrap tracking-normal';
const recapNumCell = 'pl-3 pr-6 py-2 font-mono text-right tabular-nums whitespace-nowrap';
const recapVerifyHead = 'px-3 py-3 text-center whitespace-nowrap tracking-normal';
const recapVerifyCell = 'px-3 py-2 text-center';
const RecapVerifyBox: React.FC = () => (
  <div className="w-4 h-4 border border-zinc-700 rounded-sm mx-auto bg-zinc-900" />
);

const RecapColGroup: React.FC = () => (
  <colgroup>
    <col />
    <col className="w-[5.5rem]" />
    <col className="w-[9.5rem]" />
    <col className="w-[9.5rem]" />
    <col className="w-[9.5rem]" />
    <col className="w-[4.5rem]" />
  </colgroup>
);

const RecapHead: React.FC<{ dateLabel: string }> = ({ dateLabel }) => (
  <thead className="bg-zinc-950/80 text-[10px] font-mono font-bold uppercase tracking-wider text-cyan-500/70 border-b border-zinc-800">
    <tr>
      <th className="pl-6 pr-3 py-3 text-left">{dateLabel}</th>
      <th className={recapNumHead}>Txns</th>
      <th className={recapNumHead}>Gross</th>
      <th className={recapNumHead}>Fees</th>
      <th className={recapNumHead}>Net</th>
      <th className={recapVerifyHead}>Verify</th>
    </tr>
  </thead>
);

const RecapRow: React.FC<{
  label: string;
  day: EOMCalendarDay;
  emphasis?: boolean;
  muted?: boolean;
  verify?: boolean;
}> = ({ label, day, emphasis, muted, verify = true }) => (
  <tr className={emphasis ? 'bg-zinc-950/80' : muted && day.transactionCount === 0 ? 'text-zinc-600' : ''}>
    <td className="pl-6 pr-3 py-2 font-mono text-xs uppercase tracking-widest text-zinc-500">{label}</td>
    <td className={`${recapNumCell} ${emphasis ? 'font-bold' : ''}`}>{day.transactionCount}</td>
    <td className={`${recapNumCell} ${emphasis ? 'font-bold text-cyan-400' : ''}`}>{formatUsd(day.gross)}</td>
    <td className={`${recapNumCell} ${emphasis ? 'font-bold' : ''} ${day.fees < 0 ? 'text-pink-500' : ''}`}>{formatUsd(day.fees)}</td>
    <td className={`${recapNumCell} ${emphasis ? 'font-bold' : ''}`}>{formatUsd(day.net)}</td>
    <td className={recapVerifyCell}>{verify ? <RecapVerifyBox /> : null}</td>
  </tr>
);

const PayoutTable: React.FC<{
  payouts: ArchivedPayout[];
  brand: EomSource;
}> = ({ payouts, brand }) => (
  <>
    {payouts.map((payout) => (
      <div key={payout.payoutId} className="border-t border-zinc-800/80">
        <div className="px-6 py-2 text-[10px] font-mono uppercase tracking-widest text-zinc-500 flex justify-between">
          <span>
            {brand === 'PAYPAL' ? 'PayPal' : 'Shopify'} · {payout.filename} ·{' '}
            {brand === 'PAYPAL'
              ? payout.types[0] || 'withdrawal'
              : payout.isPrimary
                ? 'primary'
                : 'secondary'}{' '}
            · {brand === 'PAYPAL' ? 'PayPal' : 'payout'} {formatDisplayDate(payout.payoutDate)}
          </span>
          <span>batch {formatUsd(payout.net)}</span>
        </div>
        <table className="w-full text-left">
          <thead className="bg-zinc-950/50 text-cyan-500/70 text-[10px] font-bold font-mono uppercase tracking-wider">
            <tr>
              <th className="px-6 py-3">Time</th>
              <th className="px-6 py-3">Reference</th>
              <th className="px-6 py-3">Status</th>
              <th className="px-6 py-3">Card Type</th>
              <th className="px-6 py-3 text-right">Amount</th>
              <th className="px-6 py-3 text-right">Fee</th>
              <th className="px-6 py-3 text-right">Net</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-800/50">
            {payout.transactions.map((transaction) => (
              <tr key={transaction.id} className="hover:bg-cyan-500/5">
                <td className="px-6 py-3 text-xs font-mono text-zinc-500">
                  {transaction.dateTime
                    ? new Date(transaction.dateTime).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
                    : '—'}
                </td>
                <td className="px-6 py-3">
                  <div className="text-sm font-bold text-zinc-200">{transaction.orderNumber}</div>
                  <div className="text-[10px] text-zinc-600 font-mono uppercase">{transaction.customerName}</div>
                </td>
                <td className="px-6 py-3">
                  <span className={`text-[9px] font-bold px-2 py-1 rounded border uppercase tracking-wider ${getStatusColor(transaction.type)}`}>
                    {transaction.type}
                  </span>
                </td>
                <td className="px-6 py-3">
                  <span className={`text-[9px] font-bold px-2 py-1 rounded border uppercase tracking-wider ${getCardTypeColor(transaction.cardBrand)}`}>
                    {transaction.cardBrand}
                  </span>
                </td>
                <td className={`px-6 py-3 text-right font-mono ${transaction.amount < 0 ? 'text-pink-500' : 'text-zinc-200'}`}>
                  {formatUsd(transaction.amount)}
                </td>
                <td className={`px-6 py-3 text-right font-mono ${transaction.fee < 0 ? 'text-pink-500' : 'text-zinc-400'}`}>{formatUsd(transaction.fee)}</td>
                <td className="px-6 py-3 text-right font-mono text-cyan-400">{formatUsd(transaction.net)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    ))}
  </>
);

const ExceptionTable: React.FC<{ title: string; exceptions: EOMException[] }> = ({ title, exceptions }) => {
  if (exceptions.length === 0) return null;
  return (
    <div className="bg-zinc-900 border border-amber-500/30">
      <div className="px-6 py-4 border-b border-zinc-800">
        <h3 className="font-bold">{title}</h3>
        <p className="text-xs text-zinc-500 font-mono mt-1">
          Refund-only ACH is excluded from the deposit total. Other rows appear when the totals do not match or a payout is still in transit.
        </p>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-left text-sm">
          <thead className="text-[10px] font-mono uppercase tracking-wider text-amber-500/80">
            <tr>
              <th className="px-6 py-3">Kind</th>
              <th className="px-6 py-3">File</th>
              <th className="px-6 py-3">Payout</th>
              <th className="px-6 py-3">Bank</th>
              <th className="px-6 py-3 text-right">Net</th>
              <th className="px-6 py-3">Note</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-800">
            {exceptions.map((item) => (
              <tr key={`${title}-${item.kind}-${item.payout.payoutId}`}>
                <td className="px-6 py-3 font-mono text-xs uppercase text-amber-400">{item.kind.replace(/_/g, ' ')}</td>
                <td className="px-6 py-3 font-mono text-xs text-zinc-300">{item.payout.filename}</td>
                <td className="px-6 py-3 font-mono text-xs">{formatDisplayDate(item.payout.payoutDate)}</td>
                <td className="px-6 py-3 font-mono text-xs">{formatDisplayDate(item.payout.bankDate)}</td>
                <td className="px-6 py-3 font-mono text-right">{formatUsd(item.payout.net)}</td>
                <td className="px-6 py-3 text-xs text-zinc-400">{item.note}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
};

export const EOMReconciler: React.FC = () => {
  const [includeShopify, setIncludeShopify] = useState(true);
  const [includePaypal, setIncludePaypal] = useState(true);
  const [archive, setArchive] = useState<ArchivedPayout[]>([]);
  const [paypalFiles, setPaypalFiles] = useState<{ filename: string; content: string }[]>([]);
  const [shopifyDirectory, setShopifyDirectory] = useState('');
  const [paypalDirectory, setPaypalDirectory] = useState('');
  const now = new Date();
  const [statementMonth, setStatementMonth] = useState(now.getMonth() + 1);
  const [statementYear, setStatementYear] = useState(now.getFullYear());
  const [shopifyWellsFargo, setShopifyWellsFargo] = useState('');
  const [paypalWellsFargo, setPaypalWellsFargo] = useState('');
  const [packet, setPacket] = useState<CombinedEOMPacket | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expandedDays, setExpandedDays] = useState<Record<string, boolean>>({});
  const [packetMode, setPacketMode] = useState<'brief' | 'full'>('brief');

  const loadArchive = useCallback(async () => {
    const [shopifyResult, historyResult, paypalResult] = await Promise.all([
      ipc.invoke('eom:list-archive'),
      ipc.invoke('history:get'),
      ipc.invoke('paypal:list-archive'),
    ]);

    const historyFilenameByPayoutId = new Map<string, string>();
    (historyResult?.imports || []).forEach((imp: { payoutId?: string; filename?: string }) => {
      if (imp?.payoutId && imp?.filename) {
        historyFilenameByPayoutId.set(String(imp.payoutId), String(imp.filename));
      }
    });

    const byId = new Map<string, ArchivedPayout>();
    ((shopifyResult?.records || []) as ArchiveRecord[]).forEach((record) => {
      parsePayoutsFromCsvText(record.content, record.filename).forEach((parsed) => {
        const existing = byId.get(parsed.payoutId);
        const preferDeposit = isDepositCsvName(parsed.filename) && !isDepositCsvName(existing?.filename || '');
        const preferComplete =
          existing &&
          isDepositCsvName(parsed.filename) === isDepositCsvName(existing.filename) &&
          parsed.transactions.length > existing.transactions.length;
        if (!existing || preferDeposit || preferComplete) {
          byId.set(parsed.payoutId, parsed);
        }
      });
    });
    setArchive(applyOriginalCsvNames(Array.from(byId.values()), historyFilenameByPayoutId));
    setShopifyDirectory(shopifyResult?.dataDirectory || '');

    const paypalRecords = (paypalResult?.records || []) as ArchiveRecord[];
    setPaypalFiles(paypalRecords.map((record) => ({ filename: record.filename, content: record.content })));
    setPaypalDirectory(paypalResult?.dataDirectory || '');
  }, []);

  useEffect(() => {
    loadArchive().catch((err) => {
      setError(err instanceof Error ? err.message : 'Failed to load payout archive.');
    });
  }, [loadArchive]);

  const paypalParsed = useMemo(() => mergePaypalActivityFiles(paypalFiles), [paypalFiles]);
  const { fromDate, toDate, lastDay } = useMemo(
    () => monthWindow(statementYear, statementMonth),
    [statementYear, statementMonth]
  );
  const yearOptions = useMemo(() => {
    const currentYear = new Date().getFullYear();
    const years = new Set<number>([statementYear, currentYear, currentYear - 1]);
    archive.forEach((payout) => {
      const year = Number(String(payout.payoutDate || '').slice(0, 4));
      if (year) years.add(year);
    });
    paypalParsed.withdrawals.forEach((payout) => {
      const year = Number(String(payout.payoutDate || '').slice(0, 4));
      if (year) years.add(year);
    });
    return Array.from(years).sort((left, right) => right - left);
  }, [archive, paypalParsed.withdrawals, statementYear]);
  const isCombined = Boolean(packet?.shopify && packet?.paypal);
  const singleSummary = packet?.shopify || packet?.paypal || null;

  const toggleSource = (source: EomSource) => {
    if (source === 'SHOPIFY') {
      if (includeShopify && !includePaypal) return;
      setIncludeShopify((current) => !current);
    } else {
      if (includePaypal && !includeShopify) return;
      setIncludePaypal((current) => !current);
    }
    setPacket(null);
    setMessage(null);
  };

  const importFiles = async (fileList: FileList | null) => {
    if (!fileList || fileList.length === 0) return;
    setBusy(true);
    setError(null);
    setMessage(null);

    try {
      const csvFiles = Array.from(fileList).filter((file) => file.name.toLowerCase().endsWith('.csv'));
      if (csvFiles.length === 0) {
        setError('No CSV files found.');
        return;
      }

      const shopifyPayload: ArchiveRecord[] = [];
      const paypalPayload: ArchiveRecord[] = [];
      const parseErrors: string[] = [];
      const seenShopify = new Set<string>();
      const seenPaypal = new Set<string>();

      for (const file of csvFiles) {
        const content = await file.text();
        if (isPaypalActivityCsv(content)) {
          if (seenPaypal.has(file.name)) continue;
          seenPaypal.add(file.name);
          paypalPayload.push({
            payoutId: file.name,
            filename: file.name,
            content,
            relativePath: file.name,
          });
          continue;
        }

        const parsed = parsePayoutCsvText(content, file.name);
        if (!parsed) {
          parseErrors.push(`${file.name}: not a Shopify payout or PayPal activity export.`);
          continue;
        }
        if (seenShopify.has(parsed.payoutId)) continue;
        seenShopify.add(parsed.payoutId);
        shopifyPayload.push({
          payoutId: parsed.payoutId,
          filename: parsed.filename,
          content,
          relativePath: file.webkitRelativePath || file.name,
          payoutDate: parsed.payoutDate,
        });
      }

      let added = 0;
      let skipped = 0;
      if (shopifyPayload.length > 0) {
        const result = await ipc.invoke('eom:import-payouts', shopifyPayload);
        added += result.added || 0;
        skipped += result.skipped || 0;
      }
      if (paypalPayload.length > 0) {
        const result = await ipc.invoke('paypal:import', paypalPayload);
        added += result.added || 0;
        skipped += result.skipped || 0;
      }

      await loadArchive();
      setPacket(null);

      const parts = [
        `Imported ${added} new file${added === 1 ? '' : 's'}`,
        skipped ? `${skipped} already archived` : null,
        parseErrors.length ? `${parseErrors.length} skipped as invalid` : null,
      ].filter(Boolean);
      setMessage(parts.join('. ') + '.');
      if (parseErrors.length > 0 && shopifyPayload.length === 0 && paypalPayload.length === 0) {
        setError(parseErrors.slice(0, 5).join(' '));
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to import payout files.');
    } finally {
      setBusy(false);
    }
  };

  const handleReconcile = () => {
    setError(null);
    if (!includeShopify && !includePaypal) {
      setError('Select Shopify, PayPal, or both.');
      return;
    }

    const sources: EomSource[] = [];
    let shopifySummary: EOMSummary | undefined;
    let paypalSummary: EOMSummary | undefined;

    if (includeShopify) {
      const wellsFargoTotal = parseMoney(shopifyWellsFargo);
      if (Number.isNaN(wellsFargoTotal)) {
        setError('Enter the Wells Fargo Shopify deposit total for this statement.');
        return;
      }
      if (archive.length === 0) {
        setError('No Shopify payout CSVs were found. Set the data folder in Settings, or import Shopify payout exports.');
        return;
      }
      sources.push('SHOPIFY');
      shopifySummary = reconcileEom(archive, fromDate, toDate, wellsFargoTotal);
    }

    if (includePaypal) {
      const wellsFargoTotal = parseMoney(paypalWellsFargo);
      if (Number.isNaN(wellsFargoTotal)) {
        setError('Enter the Wells Fargo PayPal deposit total for this statement.');
        return;
      }
      if (paypalFiles.length === 0) {
        setError('No PayPal activity CSVs were found. Import the full PayPal activity export into the Paypal folder.');
        return;
      }
      sources.push('PAYPAL');
      paypalSummary = reconcilePaypalEom(paypalFiles, fromDate, toDate, wellsFargoTotal);
    }

    const next = buildCombinedPacket(fromDate, toDate, sources, shopifySummary, paypalSummary);
    setPacket(next);
    setExpandedDays({});

    const statuses = [
      shopifySummary ? `Shopify ${shopifySummary.matched ? 'matched' : 'has a variance'}` : null,
      paypalSummary ? `PayPal ${paypalSummary.matched ? 'matched' : 'has a variance'}` : null,
    ].filter(Boolean);
    setMessage(statuses.join('. ') + '.');
  };

  const depositDays = useMemo(() => {
    const byDate = new Map<string, { shopify?: EOMDayGroup; paypal?: EOMDayGroup }>();
    packet?.shopify?.days.forEach((day) => {
      byDate.set(day.bankDate, { ...(byDate.get(day.bankDate) || {}), shopify: day });
    });
    packet?.paypal?.days.forEach((day) => {
      byDate.set(day.bankDate, { ...(byDate.get(day.bankDate) || {}), paypal: day });
    });
    return Array.from(byDate.entries()).sort(([left], [right]) => left.localeCompare(right));
  }, [packet]);

  const shopifyMonth = packet?.shopify ? sumCalendarDays(packet.shopify.calendarDays) : null;
  const paypalMonth = packet?.paypal ? sumCalendarDays(packet.paypal.calendarDays) : null;
  const combinedMonth = packet ? sumCalendarDays(packet.combinedDays.map((day) => day.combined)) : null;

  return (
    <div className="space-y-8">
      <section className="bg-zinc-900 border border-zinc-800 p-6">
        <h2 className="text-lg font-bold tracking-tight flex items-center gap-2 mb-6">
          <span className="w-2 h-6 bg-cyan-500 block"></span>
          Wells Fargo Statement
        </h2>
        <div className="flex flex-wrap gap-2 mb-5">
          <SourceChip label="Shopify" active={includeShopify} onClick={() => toggleSource('SHOPIFY')} />
          <SourceChip label="PayPal" active={includePaypal} onClick={() => toggleSource('PAYPAL')} />
        </div>
        <p className="text-xs text-zinc-500 font-mono mb-5">
          {archive.length} Shopify payouts loaded
          {paypalFiles.length > 0
            ? ` · ${paypalFiles.length} PayPal activity file${paypalFiles.length === 1 ? '' : 's'} · ${paypalParsed.withdrawals.filter((item) => item.payoutStatus !== 'in_transit').length} withdrawals`
            : ' · no PayPal activity files'}
          . Import Shopify payout CSVs named like 07-13-2026.csv, or the full PayPal activity export. Daily Report RAW files are not used for Wells Fargo matching.
          {shopifyDirectory ? ` Shopify folder: ${shopifyDirectory}.` : ''}
          {paypalDirectory ? ` PayPal folder: ${paypalDirectory}.` : ''}
        </p>
        <div className={`grid grid-cols-1 gap-4 ${includeShopify && includePaypal ? 'md:grid-cols-5' : 'md:grid-cols-4'}`}>
          <label className="flex flex-col gap-2 text-[10px] font-mono font-bold uppercase tracking-widest text-zinc-500">
            Month
            <select
              value={statementMonth}
              onChange={(event) => {
                setStatementMonth(Number(event.target.value));
                setPacket(null);
                setMessage(null);
              }}
              className="w-full bg-zinc-950 border border-zinc-700 px-3 py-2 text-sm text-white font-mono"
            >
              {MONTHS.map((month) => (
                <option key={month.value} value={month.value}>
                  {month.label}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-2 text-[10px] font-mono font-bold uppercase tracking-widest text-zinc-500">
            Year
            <select
              value={statementYear}
              onChange={(event) => {
                setStatementYear(Number(event.target.value));
                setPacket(null);
                setMessage(null);
              }}
              className="w-full bg-zinc-950 border border-zinc-700 px-3 py-2 text-sm text-white font-mono"
            >
              {yearOptions.map((year) => (
                <option key={year} value={year}>
                  {year}
                </option>
              ))}
            </select>
          </label>
          {includeShopify && (
            <label className="flex flex-col gap-2 text-[10px] font-mono font-bold uppercase tracking-widest text-zinc-500">
              Shopify deposits on statement
              <input
                type="text"
                inputMode="decimal"
                value={shopifyWellsFargo}
                onChange={(event) => setShopifyWellsFargo(event.target.value)}
                className="bg-zinc-950 border border-zinc-700 px-3 py-2 text-sm text-white font-mono"
              />
            </label>
          )}
          {includePaypal && (
            <label className="flex flex-col gap-2 text-[10px] font-mono font-bold uppercase tracking-widest text-zinc-500">
              PayPal deposits on statement
              <input
                type="text"
                inputMode="decimal"
                value={paypalWellsFargo}
                onChange={(event) => setPaypalWellsFargo(event.target.value)}
                className="bg-zinc-950 border border-zinc-700 px-3 py-2 text-sm text-white font-mono"
              />
            </label>
          )}
          <div className="flex items-end">
            <button
              type="button"
              onClick={handleReconcile}
              disabled={busy}
              className="w-full py-2 bg-cyan-500 hover:bg-cyan-400 text-black font-mono font-bold text-xs uppercase tracking-widest"
            >
              Reconcile
            </button>
          </div>
        </div>
        <p className="text-[10px] font-mono text-zinc-500 mt-3">
          Statement window: {formatDisplayDate(fromDate)} to {formatDisplayDate(toDate)} ({lastDay} days)
        </p>
        {error && (
          <div className="mt-4 p-3 bg-pink-950/50 border border-pink-500/50 text-pink-400 text-sm font-mono flex items-start gap-2">
            <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
            {error}
          </div>
        )}
        {message && !error && (
          <div className="mt-4 p-3 bg-cyan-950/30 border border-cyan-500/30 text-cyan-300 text-sm font-mono">
            {message}
          </div>
        )}
        <div className="mt-5 flex flex-wrap gap-3">
          <label className="cursor-pointer px-3 py-2 bg-zinc-800 hover:bg-zinc-700 border border-zinc-700 text-[10px] font-mono font-bold uppercase tracking-widest flex items-center gap-2">
            <Upload className="w-3.5 h-3.5" />
            Import CSVs
            <input
              type="file"
              accept=".csv"
              multiple
              className="hidden"
              disabled={busy}
              onChange={(event) => {
                importFiles(event.target.files);
                event.target.value = '';
              }}
            />
          </label>
          <label className="cursor-pointer px-3 py-2 bg-zinc-800 hover:bg-zinc-700 border border-zinc-700 text-[10px] font-mono font-bold uppercase tracking-widest flex items-center gap-2">
            <FolderOpen className="w-3.5 h-3.5" />
            Import Folder
            <input
              type="file"
              accept=".csv"
              multiple
              className="hidden"
              disabled={busy}
              {...({ webkitdirectory: '', directory: '' } as React.InputHTMLAttributes<HTMLInputElement>)}
              onChange={(event) => {
                importFiles(event.target.files);
                event.target.value = '';
              }}
            />
          </label>
        </div>
      </section>

      {packet && (
        <section className="space-y-6">
          <div className={`grid grid-cols-1 gap-4 ${isCombined ? 'lg:grid-cols-3' : 'md:grid-cols-2'}`}>
            {packet.shopify && <MatchCard label="Shopify" summary={packet.shopify} />}
            {packet.paypal && <MatchCard label="PayPal" summary={packet.paypal} />}
            <div className="bg-zinc-900 border border-cyan-500/30 p-5 flex flex-col items-center justify-center gap-3">
              <div className="flex p-1 bg-zinc-950 rounded-lg border border-zinc-800 w-full">
                <button
                  type="button"
                  onClick={() => setPacketMode('brief')}
                  className={`flex-1 py-1.5 text-[10px] font-mono font-bold uppercase tracking-widest rounded-md ${
                    packetMode === 'brief' ? 'bg-cyan-500 text-black' : 'text-zinc-400 hover:text-white'
                  }`}
                >
                  Brief
                </button>
                <button
                  type="button"
                  onClick={() => setPacketMode('full')}
                  className={`flex-1 py-1.5 text-[10px] font-mono font-bold uppercase tracking-widest rounded-md ${
                    packetMode === 'full' ? 'bg-cyan-500 text-black' : 'text-zinc-400 hover:text-white'
                  }`}
                >
                  Full
                </button>
              </div>
              <button
                type="button"
                onClick={() => generateEOMPdf(packet, packetMode)}
                className="w-full flex flex-col items-center justify-center gap-2 text-cyan-400 hover:text-white"
              >
                <FileDown className="w-8 h-8" />
                <span className="text-xs font-mono font-bold uppercase tracking-widest">
                  Print {packetMode === 'brief' ? 'brief' : 'full'} packet
                </span>
              </button>
            </div>
          </div>

          {isCombined && packet.combinedDays.length > 0 && (
            <div className="bg-zinc-900/50 border border-zinc-800">
              <div className="px-6 py-5 border-b border-zinc-800 bg-zinc-900">
                <h3 className="font-bold text-xl tracking-tight flex items-center gap-2">
                  <span className="w-2 h-6 bg-cyan-500 block"></span>
                  {packet.calendarMonthLabel} calendar days
                </h3>
                <p className="text-xs text-zinc-500 font-mono mt-2">
                  Each day lists Shopify, then PayPal, then a combined sales total. Combined is in-house EOD, not a Wells Fargo match.
                </p>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full table-fixed text-sm">
                  <RecapColGroup />
                  <RecapHead dateLabel="Calendar date / source" />
                  <tbody>
                    {packet.combinedDays.map((day) => (
                      <React.Fragment key={day.date}>
                        <tr className="border-t border-zinc-700">
                          <td className="pl-6 pr-3 py-2 font-mono font-bold" colSpan={6}>
                            {formatDisplayDate(day.date)}
                          </td>
                        </tr>
                        <RecapRow label="Shopify" day={day.shopify} muted />
                        <RecapRow label="PayPal" day={day.paypal} muted />
                        <RecapRow label="Combined" day={day.combined} emphasis />
                      </React.Fragment>
                    ))}
                  </tbody>
                  <tfoot>
                    {shopifyMonth && <RecapRow label="Shopify month" day={{ ...shopifyMonth, date: '' }} verify={false} />}
                    {paypalMonth && <RecapRow label="PayPal month" day={{ ...paypalMonth, date: '' }} verify={false} />}
                    {combinedMonth && <RecapRow label="Combined month" day={{ ...combinedMonth, date: '' }} emphasis verify={false} />}
                  </tfoot>
                </table>
              </div>
            </div>
          )}

          {!isCombined && singleSummary?.calendarDays && singleSummary.calendarDays.length > 0 && (
            <div className="bg-zinc-900/50 border border-zinc-800">
              <div className="px-6 py-5 border-b border-zinc-800 bg-zinc-900">
                <h3 className="font-bold text-xl tracking-tight flex items-center gap-2">
                  <span className="w-2 h-6 bg-cyan-500 block"></span>
                  {singleSummary.calendarMonthLabel} calendar days
                </h3>
                <p className="text-xs text-zinc-500 font-mono mt-2">
                  Gross by sale date, midnight to midnight. Use this column against in-house end-of-day totals.
                </p>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full table-fixed text-sm">
                  <RecapColGroup />
                  <RecapHead dateLabel="Calendar date" />
                  <tbody className="divide-y divide-zinc-800">
                    {singleSummary.calendarDays.map((day) => (
                      <tr key={day.date} className={day.transactionCount === 0 ? 'text-zinc-600' : ''}>
                        <td className="pl-6 pr-3 py-2 font-mono">{formatDisplayDate(day.date)}</td>
                        <td className={recapNumCell}>{day.transactionCount}</td>
                        <td className={recapNumCell}>{formatUsd(day.gross)}</td>
                        <td className={`${recapNumCell} ${day.fees < 0 ? 'text-pink-500' : ''}`}>{formatUsd(day.fees)}</td>
                        <td className={recapNumCell}>{formatUsd(day.net)}</td>
                        <td className={recapVerifyCell}><RecapVerifyBox /></td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr className="border-t border-zinc-700">
                      <td className="pl-6 pr-3 py-3 font-mono font-bold">Month total</td>
                      <td className={`${recapNumCell} py-3 font-bold`}>
                        {singleSummary.calendarDays.reduce((sum, day) => sum + day.transactionCount, 0)}
                      </td>
                      <td className={`${recapNumCell} py-3 font-bold text-cyan-400`}>
                        {formatUsd(singleSummary.calendarGross)}
                      </td>
                      <td className={`${recapNumCell} py-3 font-bold`}>
                        {formatUsd(singleSummary.calendarDays.reduce((sum, day) => sum + day.fees, 0))}
                      </td>
                      <td className={`${recapNumCell} py-3 font-bold`}>
                        {formatUsd(singleSummary.calendarDays.reduce((sum, day) => sum + day.net, 0))}
                      </td>
                      <td className={recapVerifyCell}></td>
                    </tr>
                  </tfoot>
                </table>
              </div>
            </div>
          )}

          {packet.shopify && <ExceptionTable title="Shopify exceptions" exceptions={packet.shopify.exceptions} />}
          {packet.paypal && <ExceptionTable title="PayPal exceptions" exceptions={packet.paypal.exceptions} />}

          <div className="bg-zinc-900/50 border border-zinc-800">
            <div className="px-6 py-5 border-b border-zinc-800 bg-zinc-900 flex items-center justify-between">
              <h3 className="font-bold text-xl tracking-tight flex items-center gap-2">
                <span className="w-2 h-6 bg-cyan-500 block"></span>
                Daily deposits (Wells Fargo ACH)
              </h3>
              <button
                type="button"
                onClick={() => setPacket(null)}
                className="text-xs font-mono font-bold px-4 py-2 bg-zinc-800 hover:bg-zinc-700 text-zinc-400 border border-zinc-700 uppercase tracking-widest flex items-center gap-2"
              >
                <RefreshCcw className="w-3 h-3" /> New statement
              </button>
            </div>

            {depositDays.map(([bankDate, groups]) => {
              const shopifyNet = groups.shopify?.depositNet || 0;
              const paypalNet = groups.paypal?.depositNet || 0;
              const achCount = (groups.shopify?.achCount || 0) + (groups.paypal?.achCount || 0);
              const txnCount = (groups.shopify?.transactionCount || 0) + (groups.paypal?.transactionCount || 0);
              return (
                <div key={bankDate} className="border-b border-zinc-800/50 last:border-b-0">
                  <button
                    type="button"
                    onClick={() => setExpandedDays((current) => ({ ...current, [bankDate]: !current[bankDate] }))}
                    className="w-full px-6 py-3 bg-zinc-900/80 flex items-center justify-between"
                  >
                    <div className="flex items-center gap-3">
                      <CalendarDays className="w-4 h-4 text-cyan-500" />
                      <span className="font-mono font-bold">{formatDisplayDate(bankDate)}</span>
                      <span className="text-[10px] font-mono text-zinc-500 uppercase tracking-widest">
                        {achCount} ACH · {txnCount} txns
                        {groups.shopify ? ' · Shopify' : ''}
                        {groups.paypal ? ' · PayPal' : ''}
                      </span>
                    </div>
                    <span className="text-cyan-400 font-mono font-bold text-right">
                      {groups.shopify && groups.paypal ? (
                        <span className="flex flex-col items-end text-xs gap-0.5">
                          <span>Shopify {formatUsd(shopifyNet)}</span>
                          <span>PayPal {formatUsd(paypalNet)}</span>
                        </span>
                      ) : (
                        formatUsd(shopifyNet || paypalNet)
                      )}
                    </span>
                  </button>

                  {expandedDays[bankDate] && (
                    <div className="overflow-x-auto">
                      {groups.shopify && <PayoutTable payouts={groups.shopify.payouts} brand="SHOPIFY" />}
                      {groups.paypal && <PayoutTable payouts={groups.paypal.payouts} brand="PAYPAL" />}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </section>
      )}
    </div>
  );
};
