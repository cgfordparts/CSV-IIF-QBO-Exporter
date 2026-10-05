const { app, BrowserWindow, ipcMain, shell, dialog } = require('electron');
const fsp = require('fs').promises;
const path = require('path');

// Keep settings and import history in the original AppData folder after the display-name change.
app.setPath('userData', path.join(app.getPath('appData'), 'Shopify Transaction Reporter'));

const historyService = require('./services/history.service.cjs');
const archiveService = require('./services/archive.service.cjs');

const APP_URL = process.env.VITE_DEV_SERVER_URL || 'http://localhost:3000';
const isDevelopment = process.env.NODE_ENV === 'development';

app.setAppUserModelId('com.shopify.reporter');

const createMainWindow = () => {
  const mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1100,
    minHeight: 720,
    backgroundColor: '#09090b',
    title: 'Shopify and PayPal Reporter',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (isDevelopment && url.startsWith(APP_URL)) {
      return;
    }

    if (!isDevelopment && url.startsWith('file://')) {
      return;
    }

    event.preventDefault();
    shell.openExternal(url);
  });

  if (isDevelopment) {
    mainWindow.loadURL(APP_URL);
    mainWindow.webContents.openDevTools({ mode: 'detach' });
    return;
  }

  mainWindow.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
};

const settingsPath = () => path.join(app.getPath('userData'), 'app-settings.json');
const defaultDataDirectory = () => path.join(app.getPath('userData'), 'payout-archive');

const readAppSettings = async () => {
  try {
    const parsed = JSON.parse(await fsp.readFile(settingsPath(), 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
};

const writeAppSettings = async (settings) => {
  await fsp.mkdir(app.getPath('userData'), { recursive: true });
  await fsp.writeFile(settingsPath(), JSON.stringify(settings, null, 2), 'utf8');
};

const getDataDirectory = async () => {
  const settings = await readAppSettings();
  if (typeof settings.dataDirectory === 'string' && settings.dataDirectory.trim()) {
    return settings.dataDirectory.trim();
  }
  return defaultDataDirectory();
};

const importedArchiveDir = async () => {
  const dataDirectory = await getDataDirectory();
  if (dataDirectory === defaultDataDirectory()) {
    return dataDirectory;
  }
  return path.join(dataDirectory, 'payout-archive');
};
const archiveIndexPath = async () => path.join(await importedArchiveDir(), 'index.json');
const archiveFilesDir = async () => path.join(await importedArchiveDir(), 'files');

const isSafePayoutId = (payoutId) => typeof payoutId === 'string' && /^\d+$/.test(payoutId);

const walkCsvFiles = async (dir, acc = []) => {
  let entries = [];
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return acc;
  }

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await walkCsvFiles(fullPath, acc);
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.csv')) {
      acc.push(fullPath);
    }
  }

  return acc;
};

const isDailyReportMonthDir = (name) => /^\d{4}-\d{2} \(/i.test(String(name || ''));
const isSkippedShopifyDir = (name) => {
  const lower = String(name || '').toLowerCase();
  return lower === 'raw' || lower === 'day end' || lower === 'paypal' || lower === 'errors';
};
const isShopifyPayoutCsvName = (name) => /^\d{2}-\d{2}-\d{4}(?:\(\d+\))?\.csv$/i.test(String(name || ''));

const walkShopifyPayoutCsvs = async (dir, acc = []) => {
  let entries = [];
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return acc;
  }

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (isSkippedShopifyDir(entry.name) || isDailyReportMonthDir(entry.name)) continue;
      await walkShopifyPayoutCsvs(fullPath, acc);
    } else if (entry.isFile() && isShopifyPayoutCsvName(entry.name)) {
      acc.push(fullPath);
    }
  }

  return acc;
};

const readArchiveIndex = async () => {
  await fsp.mkdir(await archiveFilesDir(), { recursive: true });
  try {
    const raw = await fsp.readFile(await archiveIndexPath(), 'utf8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
};

const writeArchiveIndex = async (index) => {
  await fsp.mkdir(await archiveFilesDir(), { recursive: true });
  await fsp.writeFile(await archiveIndexPath(), JSON.stringify(index, null, 2), 'utf8');
};

const safeHandle = (channel, handler) => {
  try {
    ipcMain.removeHandler(channel);
  } catch {
    // Channel was not registered yet.
  }
  ipcMain.handle(channel, handler);
};

const registerSettingsIpc = () => {
  safeHandle('settings:get', async () => {
    const dataDirectory = await getDataDirectory();
    const csvFiles = await walkCsvFiles(dataDirectory);
    return {
      dataDirectory,
      isDefault: dataDirectory === defaultDataDirectory(),
      csvCount: csvFiles.length,
    };
  });

  safeHandle('settings:choose-data-directory', async (event) => {
    const window = BrowserWindow.fromWebContents(event.sender);
    const result = await dialog.showOpenDialog(window || undefined, {
      title: 'Choose data folder',
      properties: ['openDirectory', 'createDirectory'],
    });

    if (result.canceled || !result.filePaths[0]) {
      return { cancelled: true };
    }

    const dataDirectory = result.filePaths[0];
    const settings = await readAppSettings();
    settings.dataDirectory = dataDirectory;
    await writeAppSettings(settings);
    const csvFiles = await walkCsvFiles(dataDirectory);
    return {
      cancelled: false,
      dataDirectory,
      isDefault: false,
      csvCount: csvFiles.length,
    };
  });

  safeHandle('settings:reset-data-directory', async () => {
    const settings = await readAppSettings();
    delete settings.dataDirectory;
    await writeAppSettings(settings);
    const dataDirectory = defaultDataDirectory();
    const csvFiles = await walkCsvFiles(dataDirectory);
    return {
      dataDirectory,
      isDefault: true,
      csvCount: csvFiles.length,
    };
  });

  safeHandle('settings:open-data-directory', async () => {
    const dataDirectory = await getDataDirectory();
    await fsp.mkdir(dataDirectory, { recursive: true });
    const error = await shell.openPath(dataDirectory);
    return { success: !error, error: error || null, dataDirectory };
  });
};

const isInsideDirectory = (root, target) => {
  const resolvedRoot = path.resolve(root);
  const resolvedTarget = path.resolve(target);
  return resolvedTarget === resolvedRoot || resolvedTarget.startsWith(resolvedRoot + path.sep);
};

const monthFolderFromDate = (payoutDate) => {
  const match = String(payoutDate || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;
  return `${match[2]}-${match[1]}`;
};

const safeRelativePath = (relativePath, filename, payoutDate) => {
  const normalized = String(relativePath || '').replace(/\\/g, '/');
  const parts = normalized.split('/').filter((part) => part && part !== '.' && part !== '..');
  const baseName = path.basename(String(filename || parts[parts.length - 1] || 'payout.csv'));

  if (parts.length > 1) {
    parts[parts.length - 1] = baseName;
    return parts.join(path.sep);
  }

  const monthFolder = monthFolderFromDate(payoutDate);
  if (monthFolder) {
    return path.join(monthFolder, baseName);
  }

  return baseName;
};

const registerEomIpc = () => {
  safeHandle('eom:list-archive', async () => {
    const dataDirectory = await getDataDirectory();
    const csvPaths = await walkShopifyPayoutCsvs(dataDirectory);
    const records = [];

    for (const filePath of csvPaths) {
      try {
        records.push({
          payoutId: path.basename(filePath, '.csv'),
          filename: path.basename(filePath),
          content: await fsp.readFile(filePath, 'utf8'),
        });
      } catch {
        // Skip unreadable files.
      }
    }

    return { records, dataDirectory };
  });

  safeHandle('eom:import-payouts', async (_event, incoming = []) => {
    const dataDirectory = await getDataDirectory();
    await fsp.mkdir(dataDirectory, { recursive: true });
    let added = 0;
    let skipped = 0;

    for (const record of incoming) {
      const content = String(record?.content || '');
      const filename = path.basename(String(record?.filename || 'payout.csv'));
      if (!content || !filename.toLowerCase().endsWith('.csv')) {
        skipped += 1;
        continue;
      }

      let destRel = safeRelativePath(record?.relativePath, filename, record?.payoutDate);
      const firstFolder = String(destRel).split(/[\\/]/)[0];
      if (firstFolder.toLowerCase() !== 'shopify') {
        destRel = path.join('Shopify', destRel);
      }
      const dest = path.resolve(dataDirectory, destRel);
      if (!isInsideDirectory(dataDirectory, dest)) {
        skipped += 1;
        continue;
      }

      try {
        await fsp.access(dest);
        skipped += 1;
        continue;
      } catch {
        // File does not exist yet.
      }

      await fsp.mkdir(path.dirname(dest), { recursive: true });
      await fsp.writeFile(dest, content, 'utf8');
      added += 1;
    }

    const csvFiles = await walkCsvFiles(dataDirectory);
    return {
      added,
      skipped,
      total: csvFiles.length,
      dataDirectory,
    };
  });

  safeHandle('eom:clear-archive', async () => {
    return { success: false, error: 'The data folder is not cleared automatically.' };
  });

  const paypalDirectory = async () => path.join(await getDataDirectory(), 'Paypal');

  safeHandle('paypal:list-archive', async () => {
    const dataDirectory = await getDataDirectory();
    const paypalDir = path.join(dataDirectory, 'Paypal');
    const csvPaths = await walkCsvFiles(paypalDir);
    const records = [];

    for (const filePath of csvPaths) {
      try {
        records.push({
          payoutId: path.basename(filePath, '.csv'),
          filename: path.basename(filePath),
          content: await fsp.readFile(filePath, 'utf8'),
        });
      } catch {
        // Skip unreadable files.
      }
    }

    return { records, dataDirectory: paypalDir };
  });

  safeHandle('paypal:import', async (_event, incoming = []) => {
    const paypalDir = await paypalDirectory();
    await fsp.mkdir(paypalDir, { recursive: true });
    let added = 0;
    let skipped = 0;

    for (const record of incoming) {
      const content = String(record?.content || '');
      const filename = path.basename(String(record?.filename || 'paypal.csv'));
      if (!content || !filename.toLowerCase().endsWith('.csv')) {
        skipped += 1;
        continue;
      }

      const dest = path.resolve(paypalDir, filename);
      if (!isInsideDirectory(paypalDir, dest)) {
        skipped += 1;
        continue;
      }

      try {
        await fsp.access(dest);
        skipped += 1;
        continue;
      } catch {
        // File does not exist yet.
      }

      await fsp.writeFile(dest, content, 'utf8');
      added += 1;
    }

    const csvFiles = await walkCsvFiles(paypalDir);
    return {
      added,
      skipped,
      total: csvFiles.length,
      dataDirectory: paypalDir,
    };
  });
};

const registerQuickBooksIpc = () => {
  const notConfiguredMessage = 'QuickBooks integration is not configured in this new Electron app yet.';

  ipcMain.handle('qb:get-status', () => ({
    isConnected: false,
    message: notConfiguredMessage,
  }));

  ipcMain.handle('qb:refresh-mappings', () => ({
    success: false,
    counts: {
      accounts: 0,
      vendors: 0,
    },
    error: notConfiguredMessage,
  }));

  ipcMain.handle('qb:login', (event) => {
    event.sender.send('qb:auth-failure', notConfiguredMessage);

    return {
      success: false,
      error: notConfiguredMessage,
    };
  });

  ipcMain.handle('qb:sync', () => ({
    success: false,
    error: 'QuickBooks sync is not implemented yet.',
    results: {
      success: 0,
      failed: 0,
      errors: ['QuickBooks sync is not implemented yet.'],
    },
  }));
};

const registerHistoryIpc = () => {
  safeHandle('history:get', () => historyService.getHistory());

  safeHandle('history:check-duplicate', (_event, { content, filename, transactions, source } = {}) => {
    return historyService.checkDuplicate(content, filename, transactions, source);
  });

  safeHandle('history:add', (_event, { source, filename, fileContent, transactions } = {}) => {
    try {
      const result = historyService.addImport(source, filename, fileContent, transactions);
      return { success: true, data: result };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  safeHandle('history:clear', () => {
    try {
      return { success: true, data: historyService.clearHistory() };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });
};

const registerArchiveIpc = () => {
  safeHandle('archive:raw-csv', (_event, payload = {}) => archiveService.archiveRawCsv(payload));
  safeHandle('archive:day-end-pdf', (_event, payload = {}) => archiveService.archiveDayEndPdf(payload));
  safeHandle('pdf:save-rolling', (_event, payload = {}) => archiveService.saveRollingPdf(payload));
};

registerQuickBooksIpc();
registerSettingsIpc();
registerEomIpc();
registerHistoryIpc();
registerArchiveIpc();

app.whenReady().then(() => {
  createMainWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
