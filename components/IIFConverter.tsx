import React, { useState, useRef, useMemo, useEffect } from 'react';
import { ConverterService, QBOJournalEntry, ConversionMode } from '../services/converter.service';

const converter = new ConverterService();

// Safely get IPC Renderer
const getIpcRenderer = () => {
  if (typeof window !== 'undefined' && (window as any).require) {
    return (window as any).require('electron').ipcRenderer;
  }
  // Mock for browser dev environment
  return {
    on: () => {},
    removeListener: () => {},
    invoke: () => {
        console.warn("Electron IPC not available. Are you running in the browser?");
        return Promise.resolve();
    }
  };
};

const ipcRenderer = getIpcRenderer();

export const IIFConverter: React.FC = () => {
  // State
  const [isDragging, setIsDragging] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [convertedData, setConvertedData] = useState<QBOJournalEntry[]>([]);
  const [fileName, setFileName] = useState<string | null>(null);
  const [conversionMode, setConversionMode] = useState<ConversionMode>('GL');

  // Auth State
  const [isConnected, setIsConnected] = useState(false);
  const [authStatus, setAuthStatus] = useState<'idle' | 'connecting' | 'connected' | 'error'>('idle');
  const [mappingStats, setMappingStats] = useState<{accounts: number, vendors: number} | null>(null);
  const [isSyncing, setIsSyncing] = useState(false);
  const [syncResult, setSyncResult] = useState<{success: number, failed: number, errors: string[]} | null>(null);

  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    // Check initial status
    ipcRenderer.invoke('qb:get-status').then((res: any) => {
        if (res.isConnected) {
            setIsConnected(true);
            setAuthStatus('connected');
            refreshMappings();
        }
    });

    // Listen for Auth Success
    const handleAuthSuccess = (_event: any, token: any) => {
      console.log('QBO Token received:', token);
      setIsConnected(true);
      setAuthStatus('connected');
      refreshMappings();
    };

    const handleAuthFailure = (_event: any, error: string) => {
      console.error('QBO Auth Error:', error);
      setAuthStatus('error');
      setErrorMessage(`QuickBooks Login Failed: ${error}`);
    };

    ipcRenderer.on('qb:auth-success', handleAuthSuccess);
    ipcRenderer.on('qb:auth-failure', handleAuthFailure);

    return () => {
      ipcRenderer.removeListener('qb:auth-success', handleAuthSuccess);
      ipcRenderer.removeListener('qb:auth-failure', handleAuthFailure);
    };
  }, []);

  const refreshMappings = async () => {
    const res = await ipcRenderer.invoke('qb:refresh-mappings');
    if (res.success) {
        setMappingStats(res.counts);
    }
  };

  const handleConnectQBO = () => {
    setAuthStatus('connecting');
    ipcRenderer.invoke('qb:login');
  };

  const handlePushToQBO = async () => {
    if (convertedData.length === 0) return;
    
    setIsSyncing(true);
    setSyncResult(null);
    setErrorMessage(null);

    try {
        const res = await ipcRenderer.invoke('qb:sync', {
            mode: conversionMode,
            data: convertedData
        });

        if (res.success) {
            setSyncResult(res.results);
        } else {
            setErrorMessage(`Sync Failed: ${res.error}`);
        }
    } catch (err: any) {
        setErrorMessage(`Sync Error: ${err.message}`);
    } finally {
        setIsSyncing(false);
    }
  };

  // Derived state for styles
  const dropzoneClasses = useMemo(() => {
    const base = 'w-full max-w-xl p-10 border border-dashed rounded-none transition-all duration-300 cursor-pointer flex flex-col items-center justify-center gap-4 group relative overflow-hidden backdrop-blur-sm';
    
    if (isDragging) {
      return `${base} border-cyan-500 bg-cyan-950/20 shadow-[0_0_30px_-5px_rgba(34,211,238,0.3)]`;
    }
    
    if (errorMessage) {
      return `${base} border-pink-500 bg-pink-950/20`;
    }
    
    return `${base} border-zinc-700 bg-zinc-900/30`;
  }, [isDragging, errorMessage]);

  // Handlers
  const handleSetMode = (mode: ConversionMode) => {
    setConversionMode(mode);
    setErrorMessage(null);
  };

  const onDragOver = (event: React.DragEvent) => {
    event.preventDefault();
    setIsDragging(true);
  };

  const onDragLeave = (event: React.DragEvent) => {
    event.preventDefault();
    setIsDragging(false);
  };

  const onDrop = (event: React.DragEvent) => {
    event.preventDefault();
    setIsDragging(false);
    
    if (event.dataTransfer?.files?.length) {
      processFile(event.dataTransfer.files[0]);
    }
  };

  const onFileSelected = (event: React.ChangeEvent<HTMLInputElement>) => {
    if (event.target.files?.length) {
      processFile(event.target.files[0]);
    }
  };

  const processFile = async (file: File) => {
    setErrorMessage(null);
    setConvertedData([]);
    setFileName(file.name);
    setIsProcessing(true);

    try {
      const text = await file.text();
      const data = converter.convert(text, conversionMode);
      
      if (data.length === 0) {
        throw new Error("No valid transactions found in file.");
      }
      setConvertedData(data);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Unknown error occurred during parsing';
      setErrorMessage(msg);
    } finally {
      setIsProcessing(false);
    }
  };

  const triggerFileInput = () => {
    fileInputRef.current?.click();
  };

  const downloadCsv = () => {
    if (convertedData.length === 0) return;

    const csvContent = converter.toCSV(convertedData);
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    
    const link = document.createElement('a');
    link.setAttribute('href', url);
    const originalName = fileName || 'export.iif';
    const newName = originalName.replace(/\.[^/.]+$/, "") + "_qbo.csv";
    link.setAttribute('download', newName);
    link.style.visibility = 'hidden';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  const reset = () => {
    setConvertedData([]);
    setErrorMessage(null);
    setFileName(null);
    if (fileInputRef.current) {
        fileInputRef.current.value = '';
    }
  };

  return (
    <div className="h-full w-full flex flex-col bg-zinc-950 selection:bg-pink-500 selection:text-white relative"> 
      
      {/* Auth Status Indicator (Top Right) */}
      <div className="absolute top-6 right-8 z-[100]">
        {!isConnected ? (
           <button 
             onClick={handleConnectQBO}
             disabled={authStatus === 'connecting'}
             className="flex items-center gap-2 px-4 py-2 bg-green-600/20 text-green-400 border border-green-600/50 hover:bg-green-600 hover:text-white rounded text-xs font-bold font-mono uppercase tracking-widest transition-all shadow-lg"
           >
             {authStatus === 'connecting' ? (
                <>
                  <div className="w-2 h-2 rounded-full bg-green-400 animate-pulse"></div>
                  CONNECTING...
                </>
             ) : (
                <>
                  <div className="w-2 h-2 rounded-full bg-green-500"></div>
                  CONNECT QUICKBOOKS
                </>
             )}
           </button>
        ) : (
           <div className="flex items-center gap-2 px-4 py-2 bg-green-900/20 text-green-400 border border-green-500/20 rounded text-xs font-bold font-mono uppercase tracking-widest shadow-lg backdrop-blur-md">
             <div className="w-2 h-2 rounded-full bg-green-400 animate-pulse"></div>
             QB CONNECTED
           </div>
        )}
      </div>

      {/* Main Content */}
      <div className="flex-1 flex flex-col w-full max-w-7xl mx-auto p-4 sm:p-6 lg:p-8 gap-6">
        
        {convertedData.length === 0 ? (
          /* Upload State */
          <div className="flex-1 flex flex-col items-center justify-center min-h-[400px]">
            
            <div className="relative w-full max-w-xl">
                <div 
                  className={dropzoneClasses}
                  onDragOver={onDragOver}
                  onDragLeave={onDragLeave}
                  onDrop={onDrop}
                  onClick={triggerFileInput}
                >
                  {/* Cyberpunk corner markers */}
                  <div className="absolute top-0 left-0 w-2 h-2 border-t border-l border-zinc-500 group-hover:border-cyan-400 transition-colors"></div>
                  <div className="absolute top-0 right-0 w-2 h-2 border-t border-r border-zinc-500 group-hover:border-cyan-400 transition-colors"></div>
                  <div className="absolute bottom-0 left-0 w-2 h-2 border-b border-l border-zinc-500 group-hover:border-cyan-400 transition-colors"></div>
                  <div className="absolute bottom-0 right-0 w-2 h-2 border-b border-r border-zinc-500 group-hover:border-cyan-400 transition-colors"></div>

                  <input 
                    ref={fileInputRef}
                    type="file" 
                    accept=".iif" 
                    className="hidden" 
                    onChange={onFileSelected}
                  />

                  {isProcessing ? (
                    <>
                        <div className="relative">
                            <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-cyan-500"></div>
                            <div className="absolute inset-0 rounded-full h-12 w-12 border-t-2 border-pink-500 opacity-50 animate-pulse"></div>
                        </div>
                        <p className="text-cyan-400 font-mono animate-pulse">PARSING DATA...</p>
                    </>
                  ) : (
                    <>
                        <div className="h-16 w-16 bg-zinc-800/50 rounded-full flex items-center justify-center group-hover:bg-zinc-800 transition-colors group-hover:scale-110 duration-200 border border-zinc-700 group-hover:border-cyan-500/50">
                          <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth="1.5" stroke="currentColor" className="w-8 h-8 text-zinc-400 group-hover:text-cyan-400 transition-colors">
                            <path strokeLinecap="round" strokeLinejoin="round" d="M3 16.5v2.25A2.25 2.25 0 0 0 5.25 21h13.5A2.25 2.25 0 0 0 21 18.75V16.5m-13.5-9L12 3m0 0 4.5 4.5M12 3v13.5" />
                          </svg>
                        </div>
                        
                        <div className="text-center">
                          <p className="text-lg font-bold text-zinc-200 group-hover:text-white transition-colors tracking-wide">DROP COUNTERPOINT .IIF</p>
                          <p className="text-zinc-500 font-mono text-sm mt-1 group-hover:text-cyan-500/70">or click to browse files</p>
                        </div>
                        
                        {errorMessage && (
                          <div className="mt-4 p-3 bg-pink-950/50 border border-pink-500/50 text-pink-400 rounded-sm text-sm text-center max-w-sm font-mono">
                            <span className="font-bold text-pink-500">[ERROR]</span> {errorMessage}
                          </div>
                        )}
                    </>
                  )}
                </div>

                {/* Mode Toggle - Absolute Positioned */}
                <div className="absolute -bottom-20 left-0 right-0 flex p-1 bg-zinc-900 rounded-lg border border-zinc-800 w-full max-w-sm mx-auto shadow-xl">
                    <button 
                      onClick={(e) => { e.stopPropagation(); handleSetMode('GL'); }} 
                      className={`flex-1 py-2 text-sm font-bold font-mono rounded-md transition-all duration-300 relative z-10 ${conversionMode === 'GL' ? 'text-black' : 'text-zinc-400'}`}
                    >
                      General Ledger
                    </button>
                    <button 
                      onClick={(e) => { e.stopPropagation(); handleSetMode('AP'); }} 
                      className={`flex-1 py-2 text-sm font-bold font-mono rounded-md transition-all duration-300 relative z-10 ${conversionMode === 'AP' ? 'text-black' : 'text-zinc-400'}`}
                    >
                      Accounts Payable
                    </button>
                    
                    {/* Sliding Background */}
                    <div 
                      className={`absolute top-1 bottom-1 rounded-md transition-all duration-300 shadow-lg w-[calc(50%-4px)] ${
                        conversionMode === 'GL' 
                          ? 'left-1 bg-cyan-500' 
                          : 'translate-x-full bg-pink-500'
                      }`}
                    ></div>
                </div>
            </div>

          </div>
        ) : (
          /* Results State */
          <div className="flex flex-col h-full bg-zinc-900/50 rounded-lg shadow-2xl border border-zinc-800 overflow-hidden backdrop-blur-sm">
            
            {/* Toolbar */}
            <div className="p-4 border-b border-zinc-800 flex flex-wrap items-center justify-between gap-4 bg-zinc-900 shrink-0">
              <div>
                <h2 className="font-bold text-white flex items-center gap-2">
                  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-5 h-5 text-cyan-500 animate-pulse">
                    <path fillRule="evenodd" d="M10 18a8 8 0 1 0 0-16 8 8 0 0 0 0 16Zm3.857-9.809a.75.75 0 0 0-1.214-.882l-3.483 4.79-1.88-1.88a.75.75 0 1 0-1.06 1.061l2.5 2.5a.75.75 0 0 0 1.137-.089l4-5.5Z" clipRule="evenodd" />
                  </svg>
                  <span className="tracking-wide">CONVERSION COMPLETE</span>
                  <span className={`ml-2 text-xs font-mono px-2 py-0.5 rounded border ${
                    conversionMode === 'GL' 
                        ? 'border-cyan-500 text-cyan-400' 
                        : 'border-pink-500 text-pink-400'
                  }`}>
                    {conversionMode} MODE
                  </span>
                </h2>
                <p className="text-xs font-mono text-zinc-500 mt-1 pl-7">
                    <span className="text-cyan-500/50">{convertedData.length}</span> ENTRIES DETECTED IN <span className="text-zinc-400">{fileName}</span>
                </p>
              </div>
              
              <div className="flex items-center gap-3">
                <button 
                  onClick={reset}
                  className="px-4 py-2 text-sm font-mono text-zinc-400 hover:text-white hover:bg-zinc-800 border border-transparent hover:border-zinc-700 rounded transition-all"
                >
                  RESET
                </button>
                <button 
                  onClick={downloadCsv}
                  className="group relative flex items-center gap-2 px-6 py-2 text-sm font-bold text-black bg-cyan-500 hover:bg-cyan-400 rounded-none overflow-hidden transition-all active:scale-95"
                >
                  <div className="absolute inset-0 bg-white/20 translate-x-[-100%] group-hover:translate-x-[100%] transition-transform duration-500 skew-x-12"></div>
                  <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth="2" stroke="currentColor" className="w-4 h-4">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M3 16.5v2.25A2.25 2.25 0 0 0 5.25 21h13.5A2.25 2.25 0 0 0 21 18.75V16.5M7.5 12 12 16.5m0 0 4.5-4.5M12 16.5v-13.5" />
                  </svg>
                  DOWNLOAD CSV
                </button>

                {/* PUSH TO QBO BUTTON */}
                {isConnected && (
                  <button 
                    onClick={handlePushToQBO}
                    disabled={isSyncing}
                    className="group relative flex items-center gap-2 px-6 py-2 text-sm font-bold text-white bg-green-600 hover:bg-green-500 disabled:bg-zinc-700 disabled:text-zinc-500 rounded-none overflow-hidden transition-all active:scale-95 border-l border-green-700 shadow-lg"
                  >
                     <div className="absolute inset-0 bg-white/20 translate-x-[-100%] group-hover:translate-x-[100%] transition-transform duration-500 skew-x-12"></div>
                     {isSyncing ? (
                        <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin"></div>
                     ) : (
                        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" className="w-4 h-4">
                            <path fillRule="evenodd" d="M12 2.25c-5.385 0-9.75 4.365-9.75 9.75s4.365 9.75 9.75 9.75 9.75-4.365 9.75-9.75S17.385 2.25 12 2.25Zm0 8.625a1.125 1.125 0 1 0 0 2.25 1.125 1.125 0 0 0 0-2.25ZM15.375 12a1.125 1.125 0 1 1 2.25 0 1.125 1.125 0 0 1-2.25 0ZM7.5 10.875a1.125 1.125 0 1 0 0 2.25 1.125 1.125 0 0 0 0-2.25Z" clipRule="evenodd" />
                        </svg>
                     )}
                     {isSyncing ? 'SYNCING...' : 'PUSH TO QBO'}
                  </button>
                )}
              </div>
            </div>

            {/* Sync Results Banner */}
            {syncResult && (
              <div className={`p-4 font-mono text-sm flex items-center justify-between ${syncResult.failed > 0 ? 'bg-pink-950/30 border-b border-pink-500/50 text-pink-400' : 'bg-green-950/30 border-b border-green-500/50 text-green-400'}`}>
                <div className="flex items-center gap-4">
                  <span className="font-bold tracking-widest">[{syncResult.failed > 0 ? 'SYNC COMPLETE WITH ERRORS' : 'SYNC SUCCESSFUL'}]</span>
                  <span>SUCCESS: {syncResult.success}</span>
                  <span>FAILED: {syncResult.failed}</span>
                </div>
                {syncResult.errors.length > 0 && (
                  <button 
                    onClick={() => alert(syncResult.errors.join('\n'))}
                    className="text-xs underline hover:text-white"
                  >
                    VIEW ERROR LOG
                  </button>
                )}
              </div>
            )}

            {/* Table Preview */}
            <div className="flex-1 overflow-auto bg-zinc-950/50 relative">
              <table className="min-w-full divide-y divide-zinc-800">
                <thead className="bg-zinc-900 sticky top-0 z-10 shadow-lg shadow-black/50">
                  <tr>
                    {conversionMode === 'AP' ? (
                        <>
                            <th scope="col" className="px-6 py-3 text-left text-xs font-bold text-cyan-500/70 font-mono uppercase tracking-wider bg-zinc-900 border-b border-cyan-500/20">Bill no</th>
                            <th scope="col" className="px-6 py-3 text-left text-xs font-bold text-cyan-500/70 font-mono uppercase tracking-wider bg-zinc-900 border-b border-cyan-500/20">Supplier</th>
                            <th scope="col" className="px-6 py-3 text-left text-xs font-bold text-cyan-500/70 font-mono uppercase tracking-wider bg-zinc-900 border-b border-cyan-500/20">Bill Date</th>
                            <th scope="col" className="px-6 py-3 text-left text-xs font-bold text-cyan-500/70 font-mono uppercase tracking-wider bg-zinc-900 border-b border-cyan-500/20">Due Date</th>
                            <th scope="col" className="px-6 py-3 text-left text-xs font-bold text-cyan-500/70 font-mono uppercase tracking-wider bg-zinc-900 border-b border-cyan-500/20">Account</th>
                            <th scope="col" className="px-6 py-3 text-right text-xs font-bold text-cyan-500/70 font-mono uppercase tracking-wider bg-zinc-900 border-b border-cyan-500/20">Line Amount</th>
                            <th scope="col" className="px-6 py-3 text-left text-xs font-bold text-cyan-500/70 font-mono uppercase tracking-wider bg-zinc-900 border-b border-cyan-500/20">Line Description</th>
                        </>
                    ) : (
                        <>
                            <th scope="col" className="px-6 py-3 text-left text-xs font-bold text-cyan-500/70 font-mono uppercase tracking-wider bg-zinc-900 border-b border-cyan-500/20">Journal No</th>
                            <th scope="col" className="px-6 py-3 text-left text-xs font-bold text-cyan-500/70 font-mono uppercase tracking-wider bg-zinc-900 border-b border-cyan-500/20">Date</th>
                            <th scope="col" className="px-6 py-3 text-left text-xs font-bold text-cyan-500/70 font-mono uppercase tracking-wider bg-zinc-900 border-b border-cyan-500/20">Due Date</th>
                            <th scope="col" className="px-6 py-3 text-left text-xs font-bold text-cyan-500/70 font-mono uppercase tracking-wider bg-zinc-900 border-b border-cyan-500/20">Account</th>
                            <th scope="col" className="px-6 py-3 text-right text-xs font-bold text-cyan-500/70 font-mono uppercase tracking-wider bg-zinc-900 border-b border-cyan-500/20">Debit</th>
                            <th scope="col" className="px-6 py-3 text-right text-xs font-bold text-cyan-500/70 font-mono uppercase tracking-wider bg-zinc-900 border-b border-cyan-500/20">Credit</th>
                            <th scope="col" className="px-6 py-3 text-left text-xs font-bold text-cyan-500/70 font-mono uppercase tracking-wider bg-zinc-900 border-b border-cyan-500/20">Description</th>
                            <th scope="col" className="px-6 py-3 text-left text-xs font-bold text-cyan-500/70 font-mono uppercase tracking-wider bg-zinc-900 border-b border-cyan-500/20">Name</th>
                        </>
                    )}
                  </tr>
                </thead>
                <tbody className="divide-y divide-zinc-800/50">
                  {convertedData.map((row, index) => (
                    <tr key={index} className="group hover:bg-cyan-500/5 transition-colors">
                      {conversionMode === 'AP' ? (
                          <>
                            <td className="px-6 py-3 text-sm text-pink-500 font-mono whitespace-nowrap border-l-2 border-transparent group-hover:border-pink-500/50 transition-colors">{row.BillNo}</td>
                            <td className="px-6 py-3 text-sm text-zinc-400 whitespace-nowrap">{row.Supplier}</td>
                            <td className="px-6 py-3 text-sm text-zinc-500 whitespace-nowrap font-mono">{row.JournalDate}</td>
                            <td className="px-6 py-3 text-sm text-zinc-500 whitespace-nowrap font-mono">{row.DueDate || '-'}</td>
                            <td className="px-6 py-3 text-sm text-zinc-200 font-medium whitespace-nowrap font-mono tracking-tight">{row.Account}</td>
                            <td className="px-6 py-3 text-sm text-cyan-300 text-right font-mono whitespace-nowrap">{row.LineAmount}</td>
                            <td className="px-6 py-3 text-sm text-zinc-500 truncate max-w-[200px]" title={row.Description}>{row.Description}</td>
                          </>
                      ) : (
                          <>
                            <td className="px-6 py-3 text-sm text-pink-500 font-mono whitespace-nowrap border-l-2 border-transparent group-hover:border-pink-500/50 transition-colors">{row.JournalNo}</td>
                            <td className="px-6 py-3 text-sm text-zinc-400 whitespace-nowrap">{row.JournalDate}</td>
                            <td className="px-6 py-3 text-sm text-zinc-500 whitespace-nowrap font-mono">{row.DueDate || '-'}</td>
                            <td className="px-6 py-3 text-sm text-zinc-200 font-medium whitespace-nowrap font-mono tracking-tight">{row.Account}</td>
                            <td className="px-6 py-3 text-sm text-cyan-300 text-right font-mono whitespace-nowrap">{row.Debit}</td>
                            <td className="px-6 py-3 text-sm text-cyan-300 text-right font-mono whitespace-nowrap">{row.Credit}</td>
                            <td className="px-6 py-3 text-sm text-zinc-500 truncate max-w-[200px]" title={row.Description}>{row.Description}</td>
                            <td className="px-6 py-3 text-sm text-zinc-500 truncate max-w-[150px]" title={row.Name}>{row.Name}</td>
                          </>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

      </div>
    </div>
  );
}
