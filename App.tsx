import React, { useState } from 'react';
import { 
  FileText, 
  Upload, 
  Download, 
  FileDown,
  BarChart3, 
  AlertCircle,
  Clock,
  Activity,
  RefreshCcw,
  CalendarDays,
  ArrowLeftRight,
  Database
} from 'lucide-react';
import { parseShopifyCSV, parsePaypalCSV } from './services/csvProcessor';
import { generateTransactionPDF } from './services/pdfGenerator';
import { ReportSummary, ReportStatus } from './types';
import { IIFConverter } from './components/IIFConverter';

type ViewMode = 'SHOPIFY' | 'IIF';

const App: React.FC = () => {
  const [viewMode, setViewMode] = useState<ViewMode>('SHOPIFY');
  
  // Shopify/PayPal State
  const [reportSource, setReportSource] = useState<'SHOPIFY' | 'PAYPAL'>('SHOPIFY');
  const [status, setStatus] = useState<ReportStatus>(ReportStatus.IDLE);
  const [summary, setSummary] = useState<ReportSummary | null>(null);
  const [error, setError] = useState<string | null>(null);

  const handleFileUpload = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const files = event.target.files;
    if (!files || files.length === 0) return;

    setStatus(ReportStatus.PROCESSING);
    setError(null);

    try {
      let parsedSummary: ReportSummary;
      if (reportSource === 'PAYPAL') {
        parsedSummary = await parsePaypalCSV(files);
      } else {
        parsedSummary = await parseShopifyCSV(files);
      }
      setSummary(parsedSummary);
      setStatus(ReportStatus.READY);
    } catch (err) {
      console.error(err);
      setError(`Failed to parse ${reportSource} CSV files. Please ensure they are valid.`);
      setStatus(ReportStatus.ERROR);
    }
  };

  const handleDownloadPDF = () => {
    if (summary) {
      generateTransactionPDF(summary, reportSource);
    }
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
    if (b.includes('mastercard')) return 'text-orange-400 border-orange-500/30';
    if (b.includes('amex') || b.includes('american express')) return 'text-cyan-300 border-cyan-500/30';
    return 'text-zinc-500 border-zinc-700';
  };

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-50 flex flex-col font-sans selection:bg-pink-500 selection:text-white">
      {/* Unified Header */}
      <header className="bg-zinc-900/80 backdrop-blur-md border-b border-cyan-500/20 px-6 py-4 sticky top-0 z-50 shadow-[0_4px_20px_-5px_rgba(34,211,238,0.1)]">
        <div className="max-w-7xl mx-auto flex items-center justify-between">
          <div className="flex items-center gap-4">
             {/* Dynamic Logo Icon */}
            <div className="relative h-10 w-10 group">
              <div className={`absolute -inset-1 bg-gradient-to-r ${viewMode === 'SHOPIFY' ? 'from-cyan-500 to-pink-500' : 'from-pink-500 to-cyan-500'} rounded-lg blur opacity-40 group-hover:opacity-100 transition duration-500`}></div>
              <div className="relative h-full w-full bg-zinc-900 rounded-lg border border-cyan-500/50 flex items-center justify-center text-cyan-400 group-hover:text-white transition-colors">
                {viewMode === 'SHOPIFY' ? <FileText className="w-5 h-5" /> : <Database className="w-5 h-5" />}
              </div>
            </div>
            <div>
              <h1 className="text-xl font-bold text-transparent bg-clip-text bg-gradient-to-r from-cyan-400 to-white tracking-tight">
                {viewMode === 'SHOPIFY' ? `${reportSource === 'SHOPIFY' ? 'Shopify' : 'PayPal'} Reporter` : 'IIF//QBO Converter'}
              </h1>
            </div>
          </div>
          
          <button
            onClick={() => setViewMode(viewMode === 'SHOPIFY' ? 'IIF' : 'SHOPIFY')}
            className={`group relative px-6 py-2 bg-zinc-900 border ${viewMode === 'SHOPIFY' ? 'border-pink-500/50 hover:border-pink-500 text-pink-400' : 'border-cyan-500/50 hover:border-cyan-500 text-cyan-400'} hover:text-white rounded flex items-center gap-3 text-xs font-bold font-mono uppercase tracking-wider transition-all shadow-lg overflow-hidden`}
           >
            {/* Gloss effect */}
            <div className="absolute inset-0 bg-white/5 translate-x-[-100%] group-hover:translate-x-[100%] transition-transform duration-700 skew-x-12"></div>
            
            <ArrowLeftRight className="w-4 h-4" />
            <span>SWITCH TO {viewMode === 'SHOPIFY' ? 'IIF CONVERTER' : 'SHOPIFY REPORT'}</span>
          </button>
        </div>
      </header>

      <main className="flex-1 w-full relative">
        {viewMode === 'IIF' ? (
          <div className="absolute inset-0">
             <IIFConverter />
          </div>
        ) : (
          <div className="max-w-7xl mx-auto p-6 space-y-8">
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
                  </div>

                  {error && (
                    <div className="mt-4 p-3 bg-pink-950/50 border border-pink-500/50 text-pink-400 rounded-sm text-sm text-center max-w-sm font-mono">
                      <span className="font-bold text-pink-500">[ERROR]</span> {error}
                    </div>
                  )}
                </label>

                {/* Report Source Toggle */}
                <div className="mt-8 flex p-1 bg-zinc-900 rounded-lg border border-zinc-800 w-full max-w-sm mx-auto shadow-xl relative">
                    <button 
                      onClick={() => setReportSource('SHOPIFY')} 
                      className={`flex-1 py-2 text-sm font-bold font-mono rounded-md transition-all duration-300 relative z-10 ${reportSource === 'SHOPIFY' ? 'text-black' : 'text-zinc-400'}`}
                    >
                      SHOPIFY
                    </button>
                    <button 
                      onClick={() => setReportSource('PAYPAL')} 
                      className={`flex-1 py-2 text-sm font-bold font-mono rounded-md transition-all duration-300 relative z-10 ${reportSource === 'PAYPAL' ? 'text-black' : 'text-zinc-400'}`}
                    >
                      PAYPAL
                    </button>
                    
                    {/* Sliding Background */}
                    <div 
                      className={`absolute top-1 bottom-1 rounded-md transition-all duration-300 shadow-lg w-[calc(50%-4px)] ${
                        reportSource === 'SHOPIFY' 
                          ? 'left-1 bg-cyan-500' 
                          : 'translate-x-full bg-blue-500'
                      }`}
                    ></div>
                </div>

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
                    <div className="px-6 py-6 border-b border-zinc-800 flex items-center justify-between bg-zinc-900">
                      <div>
                        <h3 className="font-bold text-white text-xl tracking-tight flex items-center gap-2">
                            <span className="w-2 h-6 bg-cyan-500 block"></span>
                            LEDGER BREAKDOWN
                        </h3>
                      </div>
                      <button 
                        onClick={() => { setSummary(null); setStatus(ReportStatus.IDLE); }}
                        className="text-xs font-mono font-bold px-4 py-2 bg-zinc-800 hover:bg-zinc-700 hover:text-white text-zinc-400 border border-zinc-700 hover:border-zinc-500 uppercase tracking-widest transition-all flex items-center gap-2"
                      >
                        <RefreshCcw className="w-3 h-3" /> UPLOAD NEW
                      </button>
                    </div>
                    
                    {summary?.dailyGroups.map((group) => (
                      <div key={group.date} className="border-b border-zinc-800/50 last:border-b-0">
                        {/* Group Header */}
                        <div className="px-6 py-3 bg-zinc-900/80 border-b border-zinc-800 flex items-center justify-between sticky top-0 backdrop-blur-md z-10">
                          <div className="flex items-center gap-3">
                            <CalendarDays className="w-4 h-4 text-cyan-500" />
                            <span className="text-zinc-200 font-bold font-mono">{group.date}</span>
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
                                <th className="px-6 py-3 text-center">Verify</th>
                              </tr>
                            </thead>
                            <tbody className="divide-y divide-zinc-800/50">
                              {group.transactions.map((t) => (
                                <tr key={t.id} className="hover:bg-cyan-500/5 transition-all group">
                                  <td className="px-6 py-3">
                                    <div className="text-xs font-mono text-zinc-500 group-hover:text-zinc-300">
                                      {new Date(t.dateTime).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
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
                                      ${t.amount.toLocaleString(undefined, { minimumFractionDigits: 2 })}
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