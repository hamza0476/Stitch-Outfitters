'use strict'

/**
 * main.js — Stitch Outfitters
 *
 * Thin entry point. All database/backup/path logic lives in src/main/.
 */

const { app, BrowserWindow, ipcMain, shell, dialog } = require('electron')
const path = require('path')
const fs   = require('fs')

const { state: paths, initPaths, ensureDirs, migrateDataFromDocuments } = require('./src/main/paths')
const db = require('./src/main/database')
const wa = require('./src/main/whatsapp')

let win = null

// ══════════════════════════════════════════════════════════════════════════════
// SINGLE-INSTANCE LOCK — prevent multiple instances from running simultaneously.
// Two instances could overwrite each other's data via the orphan-deletion logic
// in writeData(), causing silent data loss.
// ══════════════════════════════════════════════════════════════════════════════
const gotTheLock = app.requestSingleInstanceLock()
if (!gotTheLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (win) {
      if (win.isMinimized()) win.restore()
      win.focus()
    }
  })

// ══════════════════════════════════════════════════════════════════════════════
// APP WINDOW
// ══════════════════════════════════════════════════════════════════════════════
app.whenReady().then(() => {
  try {
    initPaths()
    ensureDirs()
    migrateDataFromDocuments()
    db.openDB()
  } catch (e) {
    console.error('[SO] Startup error:', e.message)
  }

  win = new BrowserWindow({
    width: 1300, height: 820, minWidth: 1024, minHeight: 680,
    title: 'Stitch Outfitters',
    show: false,
    backgroundColor: '#1A1916',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js')
    }
  })

  win.loadFile('index.html')
  win.setMenu(null)
  win.once('ready-to-show', () => win.show())

  db.setWinRef(win)
  db.registerHandlers(ipcMain)

  // ── WhatsApp automation ────────────────────────────────────────────
  wa.setWinRef(win)
  wa.setDatabase(db.getDb())
  wa.registerHandlers(ipcMain)

  // Warm-start at boot (approved): begin connect in the background BEFORE
  // the renderer asks, so first-time QR / restore is ready when user opens
  // WhatsApp UI. Fire-and-forget — connect() is internally serialized.
  setTimeout(() => {
    wa.connect().then(r => console.log('[WA] warm-start result:', r)).catch(e => console.error('[WA] warm-start error:', e.message))
  }, 500)

  // ── Path / storage info handlers ────────────────────────────────────
  ipcMain.handle('GET_PATH',         () => paths.dbFile   || '')
  ipcMain.handle('GET_IMAGES_DIR',   () => paths.imagesDir || '')

  ipcMain.handle('GET_STORAGE_INFO', () => {
    try {
      let dbSize = '0 KB', imgCount = 0, bakCount = 0
      if (paths.dbFile && fs.existsSync(paths.dbFile))
        dbSize = (fs.statSync(paths.dbFile).size / 1024).toFixed(1) + ' KB'
      if (paths.imagesDir && fs.existsSync(paths.imagesDir))
        try { imgCount = fs.readdirSync(paths.imagesDir).length } catch (_) {}
      if (paths.backupDir && fs.existsSync(paths.backupDir))
        try { bakCount = fs.readdirSync(paths.backupDir).filter(f => f.endsWith('.db')).length } catch (_) {}
      let cloudBakCount = 0
      if (paths.cloudBackupDir && fs.existsSync(paths.cloudBackupDir))
        try { cloudBakCount = fs.readdirSync(paths.cloudBackupDir).filter(f => f.endsWith('.db')).length } catch (_) {}
      return {
        provider: paths.cloudInfo?.provider || 'Local',
        dataDir:  paths.dataDir  || '', dbFile: paths.dbFile || '',
        imagesDir: paths.imagesDir || '', backupDir: paths.backupDir || '',
        cloudBackupDir: paths.cloudBackupDir || '',
        dbSize, imgCount, bakCount, cloudBakCount, syncing: !!paths.cloudBackupDir
      }
    } catch (e) {
      return { provider: 'Local', syncing: false, dbSize: '?', imgCount: 0, bakCount: 0 }
    }
  })

  ipcMain.handle('OPEN_DATA_FOLDER',   () => { shell.openPath(paths.dataDir || '');  return { ok: true } })
  ipcMain.handle('OPEN_BACKUP_FOLDER', () => { shell.openPath(paths.backupDir || ''); return { ok: true } })

  // ── Print handlers ─────────────────────────────────────────────────
  ipcMain.handle('PRINT_HTML', async (e, { html, title, landscape, paperSize }) => {
    try {
      const printWin = new BrowserWindow({
        show: false, width: 1024, height: 768,
        webPreferences: { nodeIntegration: false, contextIsolation: true }
      })
      const meta = '<!DOCTYPE html><html><head><meta charset="UTF-8"><title>' +
        (title || 'Print') + '</title><style>' +
        '*{margin:0;padding:0;box-sizing:border-box}' +
        'body{font-family:\'Segoe UI\',Arial,sans-serif;background:#fff;padding:20px;color:#000;-webkit-print-color-adjust:exact;print-color-adjust:exact}' +
        'table{border-collapse:collapse;width:100%}@page{margin:10mm}' +
        '</style></head><body>' + html + '</body></html>'
      await printWin.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(meta))
      printWin.webContents.print({
        printBackground: true, landscape: !!landscape, pageSize: paperSize || 'A4', silent: false
      }, (success, failureReason) => {
        if (!success) console.error('[MAIN] Print failed:', failureReason)
        if (!printWin.isDestroyed()) printWin.close()
      })
      return { ok: true }
    } catch (err) {
      console.error('[MAIN] PRINT_HTML error:', err.message)
      return { ok: false, error: err.message }
    }
  })

  ipcMain.handle('PRINT_TO_PDF', async (e, { html, title, landscape, paperSize }) => {
    try {
      const printWin = new BrowserWindow({
        show: false, width: 1024, height: 768,
        webPreferences: { nodeIntegration: false, contextIsolation: true }
      })
      const meta = '<!DOCTYPE html><html><head><meta charset="UTF-8"><title>' +
        (title || 'Print') + '</title><style>' +
        '*{margin:0;padding:0;box-sizing:border-box}' +
        'body{font-family:\'Segoe UI\',Arial,sans-serif;background:#fff;padding:20px;color:#000;-webkit-print-color-adjust:exact;print-color-adjust:exact}' +
        'table{border-collapse:collapse;width:100%}@page{margin:10mm}' +
        '</style></head><body>' + html + '</body></html>'
      await printWin.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(meta))
      const pdfData = await printWin.webContents.printToPDF({
        printBackground: true, landscape: !!landscape, pageSize: paperSize || 'A4'
      })
      if (!printWin.isDestroyed()) printWin.close()
      const r = await dialog.showSaveDialog({
        title: 'Save PDF',
        defaultPath: (title || 'document').replace(/[^a-zA-Z0-9_-]/g, '_') + '.pdf',
        filters: [{ name: 'PDF', extensions: ['pdf'] }]
      })
      if (!r.canceled && r.filePath) { fs.writeFileSync(r.filePath, pdfData); return { ok: true, filePath: r.filePath } }
      return { ok: false, canceled: true }
    } catch (err) {
      console.error('[MAIN] PRINT_TO_PDF error:', err.message)
      return { ok: false, error: err.message }
    }
  })
})

// ══════════════════════════════════════════════════════════════════════════════
// APP LIFECYCLE
// ══════════════════════════════════════════════════════════════════════════════
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', (e) => {
  // Destroy WA browser first — otherwise Chromium orphans + SingletonLock
  // brick the next launch (wwebjs issue #3976). Fire-and-forget so quit isn't blocked.
  try { wa.disconnect().catch(() => {}) } catch (_) {}

  if (!db.isOpen() || db.backupDone()) return
  e.preventDefault()
  console.log('[SO] before-quit: backing up...')
  db.triggerBackup().then(() => {
    console.log('[SO] before-quit: backup done')
    db.setBackupDone(true)
    app.quit()
  }).catch((err) => {
    console.error('[SO] before-quit: backup failed:', err.message || err)
    db.setBackupDone(true)
    app.quit()
  })
})

app.on('will-quit', () => {
  if (!db.isOpen()) return
  if (!db.backupDone()) {
    console.log('[SO] will-quit: backup not yet done — skipping')
  }
  db.closeDB()
})

} // end single-instance lock
