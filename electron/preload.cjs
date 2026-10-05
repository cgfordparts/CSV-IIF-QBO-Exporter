const { contextBridge, ipcRenderer } = require('electron');

const invokeChannels = new Set([
  'qb:get-status',
  'qb:refresh-mappings',
  'qb:login',
  'qb:sync',
  'eom:list-archive',
  'eom:import-payouts',
  'eom:clear-archive',
  'paypal:list-archive',
  'paypal:import',
  'settings:get',
  'settings:choose-data-directory',
  'settings:reset-data-directory',
  'settings:open-data-directory',
  'history:get',
  'history:check-duplicate',
  'history:add',
  'history:clear',
  'archive:raw-csv',
  'archive:day-end-pdf',
  'pdf:save-rolling',
]);

const listenChannels = new Set([
  'qb:auth-success',
  'qb:auth-failure',
]);

contextBridge.exposeInMainWorld('electronAPI', {
  platform: process.platform,

  invoke: (channel, ...args) => {
    if (!invokeChannels.has(channel)) {
      return Promise.reject(new Error(`Unsupported IPC channel: ${channel}`));
    }

    return ipcRenderer.invoke(channel, ...args);
  },

  on: (channel, listener) => {
    if (!listenChannels.has(channel)) {
      return () => {};
    }

    const wrappedListener = (_event, ...args) => listener(...args);
    ipcRenderer.on(channel, wrappedListener);

    return () => {
      ipcRenderer.removeListener(channel, wrappedListener);
    };
  },
});
