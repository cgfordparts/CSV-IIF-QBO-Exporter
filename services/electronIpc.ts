export type ArchiveRecord = {
  payoutId: string;
  filename: string;
  content: string;
  relativePath?: string;
  payoutDate?: string;
};

type IpcBridge = {
  invoke: (channel: string, ...args: unknown[]) => Promise<any>;
  on: (channel: string, listener: (...args: any[]) => void) => (() => void) | void;
};

declare global {
  interface Window {
    electronAPI?: IpcBridge;
  }
}

const BROWSER_ARCHIVE_KEY = 'eom-payout-archive-v1';

const readBrowserArchive = (): ArchiveRecord[] => {
  try {
    const raw = localStorage.getItem(BROWSER_ARCHIVE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
};

const writeBrowserArchive = (records: ArchiveRecord[]) => {
  localStorage.setItem(BROWSER_ARCHIVE_KEY, JSON.stringify(records));
};

const createBrowserIpcMock = (): IpcBridge => ({
  on: () => () => {},
  invoke: async (channel: string, ...args: unknown[]) => {
    switch (channel) {
      case 'eom:list-archive': {
        return { records: readBrowserArchive(), dataDirectory: 'Browser local storage' };
      }
      case 'eom:import-payouts': {
        const incoming = (args[0] as ArchiveRecord[]) || [];
        const current = readBrowserArchive();
        const seen = new Set(current.map((record) => record.payoutId));
        let added = 0;
        let skipped = 0;
        incoming.forEach((record) => {
          if (!record?.payoutId || seen.has(record.payoutId)) {
            skipped += 1;
            return;
          }
          current.push(record);
          seen.add(record.payoutId);
          added += 1;
        });
        writeBrowserArchive(current);
        return { added, skipped, total: current.length };
      }
      case 'eom:clear-archive': {
        writeBrowserArchive([]);
        return { success: true };
      }
      case 'paypal:list-archive': {
        return { records: readBrowserArchive(), dataDirectory: 'Browser local storage/Paypal' };
      }
      case 'paypal:import': {
        const incoming = (args[0] as ArchiveRecord[]) || [];
        const current = readBrowserArchive();
        const seen = new Set(current.map((record) => record.filename));
        let added = 0;
        let skipped = 0;
        incoming.forEach((record) => {
          if (!record?.filename || seen.has(record.filename)) {
            skipped += 1;
            return;
          }
          current.push(record);
          seen.add(record.filename);
          added += 1;
        });
        writeBrowserArchive(current);
        return { added, skipped, total: current.length };
      }
      case 'settings:get': {
        return {
          dataDirectory: 'Browser local storage',
          isDefault: true,
          csvCount: readBrowserArchive().length,
        };
      }
      case 'settings:choose-data-directory': {
        return {
          cancelled: true,
          error: 'Choose a folder in the desktop app.',
        };
      }
      case 'settings:reset-data-directory': {
        return {
          dataDirectory: 'Browser local storage',
          isDefault: true,
          csvCount: readBrowserArchive().length,
        };
      }
      case 'settings:open-data-directory': {
        return { success: false, error: 'Open folder is only available in the desktop app.' };
      }
      case 'history:get': {
        return { imports: [] };
      }
      case 'history:check-duplicate': {
        return { isDuplicate: false, importId: null };
      }
      case 'history:add': {
        return { success: false, error: 'Import history is only available in the desktop app.' };
      }
      case 'history:clear': {
        return { success: false, error: 'Import history is only available in the desktop app.' };
      }
      case 'archive:raw-csv':
      case 'archive:day-end-pdf':
      case 'pdf:save-rolling': {
        return { success: false, error: 'Choose a data folder in the desktop app.' };
      }
      default:
        return {};
    }
  },
});

export const getIpcRenderer = (): IpcBridge => {
  if (typeof window === 'undefined') {
    return createBrowserIpcMock();
  }

  if (window.electronAPI) {
    return window.electronAPI;
  }

  return createBrowserIpcMock();
};
