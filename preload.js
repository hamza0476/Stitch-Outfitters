/**
 * preload.js — Stitch Outfitters
 *
 * Bridges the renderer (index.html) to main.js via IPC.
 * contextIsolation: true — renderer has NO access to Node.js or Electron internals.
 */

const { contextBridge, ipcRenderer } = require('electron')

const ALLOWED_CHANNELS = [
  // Core data
  'LOAD',
  'SAVE',
  'SAVE_CLIENT',
  'SAVE_ORDER',
  'SAVE_COUNTERS',
  'READY',
  // Targeted blob-table saves (Step 9 — fast single-row saves)
  'SAVE_EXPENSE',
  'SAVE_WORKER',
  'SAVE_ASSIGNMENT',
  'SAVE_SALARY_PAYMENT',
  'SAVE_COMM_LOG',
  // Images
  'SAVE_IMAGES',
  'LOAD_IMAGE',
  'LOAD_IMAGES',
  'DELETE_IMAGES',
  // Paths
  'GET_PATH',
  'GET_IMAGES_DIR',
  // Cloud storage info (new)
  'GET_STORAGE_INFO',
  'OPEN_DATA_FOLDER',
  'OPEN_BACKUP_FOLDER',
  // Backup / Restore
  'BACKUP',
  'RESTORE',
  'DO_BACKUP',
  // Print
  'PRINT_HTML',
  'PRINT_TO_PDF',
  // Auto-update
  'CHECK_FOR_UPDATE',
  'DOWNLOAD_UPDATE',
  'RESTART_APP',
]

contextBridge.exposeInMainWorld('electronAPI', {
  invoke: (channel, ...args) => {
    if (!ALLOWED_CHANNELS.includes(channel)) {
      return Promise.reject(new Error(`IPC channel "${channel}" is not permitted`))
    }
    return ipcRenderer.invoke(channel, ...args)
  },
  onUpdateStatus: (callback) => {
    ipcRenderer.on('UPDATE_STATUS', (_e, status) => callback(status))
  }
})
