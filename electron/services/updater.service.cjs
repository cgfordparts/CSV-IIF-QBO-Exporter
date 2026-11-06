const { app, BrowserWindow, ipcMain } = require('electron');
const fsp = require('fs').promises;
const https = require('https');
const path = require('path');
const { autoUpdater } = require('electron-updater');

const GITHUB_OWNER = 'cgfordparts';
const GITHUB_REPO = 'CSV-IIF-QBO-Exporter';

const settingsPath = () => path.join(app.getPath('userData'), 'app-settings.json');

let activeToken = '';
let downloadInProgress = false;
let status = {
  state: 'idle',
  currentVersion: '',
  version: null,
  percent: null,
  message: null,
  tokenSaved: false,
  updatesSupported: false,
  announce: false,
};
let wired = false;

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

const readToken = async () => {
  const settings = await readAppSettings();
  const token = typeof settings.githubToken === 'string' ? settings.githubToken.trim() : '';
  activeToken = token;
  return token;
};

const redact = (value) => {
  let text = String(value || '');
  if (activeToken) text = text.split(activeToken).join('***');
  return text
    .replace(/github_pat_[A-Za-z0-9_]+/g, '***')
    .replace(/\bgh[pousr]_[A-Za-z0-9]+\b/g, '***');
};

const friendlyUpdateError = (error) => {
  const raw = redact(error?.message || error || 'Update check failed.');
  if (/401|Bad credentials/i.test(raw)) return 'GitHub did not accept the key in Settings.';
  if (/403|Resource not accessible/i.test(raw)) {
    return 'That key cannot read releases for cgfordparts/CSV-IIF-QBO-Exporter.';
  }
  if (/404|latest version|No published versions|ERR_UPDATER_LATEST_VERSION_NOT_FOUND/i.test(raw)) {
    return 'No release is published yet. Raise the version in package.json and push to main. GitHub publishes the installer, and this app can download it.';
  }
  if (/CHANNEL_FILE_NOT_FOUND|latest\.yml/i.test(raw)) {
    return 'The latest GitHub release is missing the updater files. Push a new version so the release includes latest.yml and the setup file.';
  }
  if (/ENOTFOUND|ETIMEDOUT|ECONN|network/i.test(raw)) return 'Could not reach GitHub.';
  const line = raw.split('\n')[0];
  return line.length > 280 ? `${line.slice(0, 280)}…` : line;
};

const publicStatus = () => ({
  state: status.state,
  currentVersion: app.getVersion(),
  version: status.version,
  percent: status.percent,
  message: status.message,
  tokenSaved: status.tokenSaved,
  updatesSupported: app.isPackaged,
  announce: status.announce === true,
});

const broadcast = (patch) => {
  status = {
    ...status,
    ...patch,
    currentVersion: app.getVersion(),
    updatesSupported: app.isPackaged,
  };
  const payload = publicStatus();
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue;
    try {
      win.webContents.send('updates:status', payload);
    } catch {
      // The window is closing.
    }
  }
  return payload;
};

const normalizeToken = (value) => {
  let token = String(value || '').trim();
  if (
    (token.startsWith('"') && token.endsWith('"')) ||
    (token.startsWith("'") && token.endsWith("'"))
  ) {
    token = token.slice(1, -1).trim();
  }
  return token.replace(/^(Bearer|token)\s+/i, '').trim();
};

const verifyGithubToken = (token) => new Promise((resolve) => {
  const req = https.request(
    {
      hostname: 'api.github.com',
      path: `/repos/${GITHUB_OWNER}/${GITHUB_REPO}`,
      method: 'GET',
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
        'User-Agent': 'Shopify-and-PayPal-Reporter',
      },
    },
    (res) => {
      res.resume();
      if (res.statusCode === 200) {
        resolve({ ok: true });
        return;
      }
      if (res.statusCode === 401) {
        resolve({ ok: false, error: 'GitHub did not accept that key.' });
        return;
      }
      if (res.statusCode === 403 || res.statusCode === 404) {
        resolve({
          ok: false,
          error: 'That key cannot read cgfordparts/CSV-IIF-QBO-Exporter. Give it Contents access to that repository.',
        });
        return;
      }
      resolve({ ok: false, error: `GitHub returned ${res.statusCode} while checking the key.` });
    },
  );
  req.on('error', () => resolve({ ok: false, error: 'Could not reach GitHub to check the key.' }));
  req.setTimeout(15000, () => {
    req.destroy();
    resolve({ ok: false, error: 'GitHub did not respond while checking the key.' });
  });
  req.end();
});

const wireUpdater = () => {
  if (wired) return;
  wired = true;
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = false;
  autoUpdater.disableWebInstaller = true;
  autoUpdater.logger = {
    info: (message) => console.log(redact(message)),
    warn: (message) => console.warn(redact(message)),
    error: (message) => console.error(redact(message)),
    debug: (message) => console.log(redact(message)),
  };

  autoUpdater.on('checking-for-update', () => {
    broadcast({
      state: 'checking',
      version: null,
      percent: null,
      message: 'Checking GitHub for a newer release.',
    });
  });

  autoUpdater.on('update-available', (info) => {
    const version = info?.version || null;
    broadcast({
      state: 'available',
      version,
      percent: null,
      message: version ? `Version ${version} is on GitHub.` : 'A newer release is on GitHub.',
    });
  });

  autoUpdater.on('update-not-available', () => {
    broadcast({
      state: 'not-available',
      version: null,
      percent: null,
      message: `Version ${app.getVersion()} is the newest release.`,
    });
  });

  autoUpdater.on('download-progress', (progress) => {
    const percent = Math.max(0, Math.min(100, Math.round(Number(progress?.percent) || 0)));
    const version = status.version ? ` ${status.version}` : '';
    broadcast({
      state: 'downloading',
      percent,
      message: `Downloading${version}… ${percent}%`,
    });
  });

  autoUpdater.on('update-downloaded', (info) => {
    downloadInProgress = false;
    const version = info?.version || status.version;
    broadcast({
      state: 'downloaded',
      version,
      percent: 100,
      message: version
        ? `Version ${version} is downloaded. Restart to install it.`
        : 'The update is downloaded. Restart to install it.',
    });
  });

  autoUpdater.on('error', (error) => {
    downloadInProgress = false;
    const message = friendlyUpdateError(error);
    broadcast({
      state: 'error',
      percent: null,
      message,
      announce: !message.startsWith('No release is published yet'),
    });
  });
};

const applyFeed = (token) => {
  autoUpdater.setFeedURL({
    provider: 'github',
    owner: GITHUB_OWNER,
    repo: GITHUB_REPO,
    token,
  });
};

const checkForUpdates = async () => {
  wireUpdater();
  const token = await readToken();
  status.tokenSaved = Boolean(token);

  if (!app.isPackaged) {
    return broadcast({
      state: 'unsupported',
      version: null,
      percent: null,
      message: 'Updates run in the installed app. Install the setup once, paste the GitHub key there, and later releases download from Settings.',
    });
  }

  if (!token) {
    return broadcast({
      state: 'idle',
      version: null,
      percent: null,
      message: 'Paste the GitHub key, then check for a release.',
    });
  }

  applyFeed(token);
  broadcast({
    state: 'checking',
    percent: null,
    message: 'Checking GitHub for a newer release.',
  });

  try {
    const result = await autoUpdater.checkForUpdates();
    if (!result && status.state === 'checking') {
      return broadcast({
        state: 'unsupported',
        message: 'Updates run in the installed app. Install the setup once, paste the GitHub key there, and later releases download from Settings.',
      });
    }
  } catch {
    // The error event records the message.
  }
  return publicStatus();
};

const downloadUpdate = async () => {
  wireUpdater();
  if (downloadInProgress || status.state === 'downloading') return publicStatus();
  if (status.state !== 'available') {
    return broadcast({
      message: status.message || 'Check for an update first.',
    });
  }
  downloadInProgress = true;

  const token = await readToken();
  if (!token) {
    downloadInProgress = false;
    return broadcast({
      state: 'idle',
      tokenSaved: false,
      message: 'Paste the GitHub key, then check for a release.',
    });
  }
  applyFeed(token);
  broadcast({
    state: 'downloading',
    percent: 0,
    tokenSaved: true,
    message: status.version ? `Downloading ${status.version}…` : 'Downloading the update…',
  });
  try {
    await autoUpdater.downloadUpdate();
  } catch {
    downloadInProgress = false;
  }
  if (status.state !== 'downloading') downloadInProgress = false;
  return publicStatus();
};

const installUpdate = () => {
  wireUpdater();
  if (status.state !== 'downloaded') {
    return broadcast({
      message: 'Download the update first.',
    });
  }
  setImmediate(() => {
    autoUpdater.quitAndInstall(true, true);
  });
  return publicStatus();
};

const saveToken = async (rawToken) => {
  const token = normalizeToken(rawToken);
  const settings = await readAppSettings();

  if (!token) {
    delete settings.githubToken;
    await writeAppSettings(settings);
    activeToken = '';
    const payload = broadcast({
      state: 'idle',
      version: null,
      percent: null,
      tokenSaved: false,
      message: 'GitHub key removed from this computer.',
    });
    return { success: true, ...payload };
  }

  if (/\s/.test(token) || token.length < 20 || token.length > 400) {
    return { success: false, error: 'That key does not look like a GitHub token.' };
  }

  const check = await verifyGithubToken(token);
  if (!check.ok) return { success: false, error: check.error };

  settings.githubToken = token;
  await writeAppSettings(settings);
  activeToken = token;
  const nextState = status.state === 'error' || status.state === 'unsupported' ? 'idle' : status.state;
  const payload = broadcast({
    state: nextState,
    tokenSaved: true,
    message: 'GitHub key saved on this computer.',
  });
  return { success: true, ...payload };
};

const safeHandle = (channel, handler) => {
  try {
    ipcMain.removeHandler(channel);
  } catch {
    // Channel was not registered yet.
  }
  ipcMain.handle(channel, handler);
};

const registerUpdateIpc = () => {
  safeHandle('updates:get-status', async () => {
    const token = await readToken();
    status.tokenSaved = Boolean(token);
    status.updatesSupported = app.isPackaged;
    status.currentVersion = app.getVersion();
    return publicStatus();
  });

  safeHandle('updates:save-token', async (_event, payload = {}) => {
    try {
      return await saveToken(payload.token);
    } catch (err) {
      return { success: false, error: friendlyUpdateError(err) };
    }
  });

  safeHandle('updates:check', async () => checkForUpdates());
  safeHandle('updates:download', async () => downloadUpdate());
  safeHandle('updates:install', async () => installUpdate());
};

const scheduleStartupCheck = () => {
  if (!app.isPackaged) return;
  setTimeout(() => {
    readToken()
      .then((token) => {
        if (token) return checkForUpdates();
        return null;
      })
      .catch(() => {});
  }, 4000);
};

module.exports = {
  registerUpdateIpc,
  scheduleStartupCheck,
};
