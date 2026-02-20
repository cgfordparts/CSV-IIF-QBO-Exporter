// Load environment variables immediately
const dotenv = require('dotenv');
const result = dotenv.config();
if (result.error) {
  console.error('Dotenv Error:', result.error);
} else {
  console.log('.env loaded successfully');
}

const { app, BrowserWindow, shell, ipcMain } = require('electron');
const path = require('path');
const http = require('http');
const url = require('url');

const qbAuth = require('./services/qbAuth.service.cjs');
const qbSync = require('./services/qbSync.service.cjs');

const isDev = process.env.NODE_ENV === 'development';

let callbackServer = null;
let mainWindow = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false, 
    },
    title: "Shopify Transaction Reporter",
    autoHideMenuBar: true
  });

  if (isDev) {
    mainWindow.loadURL('http://localhost:3000');
    mainWindow.webContents.openDevTools();
  } else {
    mainWindow.loadFile(path.join(__dirname, '../dist/index.html'));
  }

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  return mainWindow;
}

// --- OAuth Callback Server ---
function startCallbackServer(win) {
  if (callbackServer) return; // Already running

  callbackServer = http.createServer(async (req, res) => {
    const parsedUrl = url.parse(req.url, true);
    
    // Check if it's our callback
    if (parsedUrl.pathname === '/callback') {
      // Use localhost to match .env and portal
      const fullUrl = `http://localhost:8080${req.url}`;
      console.log('--- OAUTH HANDSHAKE ---');
      console.log('Exchanging code from:', fullUrl);

      try {
        const token = await qbAuth.exchangeAuthCode(fullUrl);
        
        // Notify Frontend
        win.webContents.send('qb:auth-success', token);
        
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(`
          <div style="font-family: sans-serif; text-align: center; padding: 50px;">
            <h1 style="color: #06b6d4;">Authentication Successful!</h1>
            <p>You have successfully connected to QuickBooks Online.</p>
            <p>You can close this tab and return to the application.</p>
            <script>setTimeout(() => window.close(), 3000);</script>
          </div>
        `);
      } catch (err) {
        console.error('Auth Error:', err);
        win.webContents.send('qb:auth-failure', err.message);
        
        res.writeHead(500, { 'Content-Type': 'text/html' });
        res.end('<h1>Authentication Failed</h1><p>Please check the application logs.</p>');
      }
    }
  });

  callbackServer.listen(8080, () => {
    console.log('QuickBooks Auth Server listening on http://localhost:8080');
  });
  
  callbackServer.on('error', (e) => {
    console.error('Callback Server Error:', e);
  });
}

app.whenReady().then(() => {
  const win = createWindow();
  startCallbackServer(win);

  // IPC Handlers for QB
  ipcMain.handle('qb:login', () => {
    const authUri = qbAuth.getAuthUri();
    shell.openExternal(authUri);
    return { status: 'initiated', url: authUri };
  });

  ipcMain.handle('qb:get-status', () => {
    return {
        isConnected: qbAuth.isTokenValid(),
        realmId: qbAuth.getRealmId()
    };
  });

  ipcMain.handle('qb:refresh-mappings', async () => {
    try {
        const counts = await qbSync.refreshMappings();
        return { success: true, counts };
    } catch (err) {
        return { success: false, error: err.message };
    }
  });

  ipcMain.handle('qb:sync', async (event, { mode, data }) => {
    try {
        let results;
        if (mode === 'GL') {
            results = await qbSync.syncJournalEntries(data);
        } else {
            results = await qbSync.syncBills(data);
        }
        return { success: true, results };
    } catch (err) {
        return { success: false, error: err.message };
    }
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (callbackServer) {
    callbackServer.close();
  }
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
