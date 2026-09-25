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
  // Blob-table load + targeted saves
  'LOAD_BLOB_TABLES',
  'CHECK_DATA_INTEGRITY',
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
  'SAVE_SYNC',
  'GET_BACKUP_STATUS',
  'VERIFY_BACKUPS',
  'CLEAR_BACKUP_HISTORY',
  // Print
  'PRINT_HTML',
  'PRINT_TO_PDF',
  // WhatsApp automation
  'WA_INIT',
  'SEND_INVOICE_WHATSAPP',
  'WA_GET_STATUS',
  'WA_RECONNECT',
  'WA_CONNECT',
  'WA_DISCONNECT',
  'WA_LOGOUT',
  'WA_GET_QR',
  'WA_SEND_MESSAGE',
  'WA_QUEUE_MESSAGE',
  'WA_GET_QUEUE_STATUS',
]

// Events pushed one-way from main -> renderer (no renderer-side arguments cross this bridge).
const ALLOWED_EVENTS = ['WA_QR', 'WA_STATUS', 'WA_QUEUE_UPDATED', 'BACKUP_FAILED']

contextBridge.exposeInMainWorld('electronAPI', {
  invoke: (channel, ...args) => {
    if (!ALLOWED_CHANNELS.includes(channel)) {
      return Promise.reject(new Error(`IPC channel "${channel}" is not permitted`))
    }
    return ipcRenderer.invoke(channel, ...args)
  },
  sendSync: (channel, ...args) => {
    if (!ALLOWED_CHANNELS.includes(channel)) {
      throw new Error(`IPC channel "${channel}" is not permitted`)
    }
    return ipcRenderer.sendSync(channel, ...args)
  },
  on: (channel, callback) => {
    if (!ALLOWED_EVENTS.includes(channel)) {
      console.error(`IPC event "${channel}" is not permitted`)
      return
    }
    ipcRenderer.on(channel, (_event, data) => callback(data))
  }
})
